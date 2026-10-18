//! Wallet login (SIWE), sessions and the auth gate (spec §3–§4).
//!
//! Cookies: `eg_session` (the login session, `Path=/`) and `eg_admin` (admin
//! mode, `Path=/api/admin`), both `HttpOnly; SameSite=Lax`, `Secure` unless
//! the public origin is plain-http local development. Only the SHA-256 of a
//! token is stored.

pub mod extract;
pub mod ratelimit;
pub mod siwe;

use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use alloy_primitives::Address;
use axum::extract::ConnectInfo;
use axum::http::request::Parts;
use axum::http::{HeaderMap, header};
use eg_store::{SETTING_OPEN_REGISTRATION, StoreError};

use crate::config::{Config, PublicOrigin};
use crate::state::AppState;

use self::ratelimit::RateLimiter;

pub const SESSION_COOKIE: &str = "eg_session";
pub const ADMIN_COOKIE: &str = "eg_admin";
/// `eg_admin` is only sent to the admin API.
pub const ADMIN_COOKIE_PATH: &str = "/api/admin";

/// Requests per client IP and minute to `GET /api/auth/nonce` and, separately,
/// to `POST /api/auth/login`.
pub const AUTH_REQUESTS_PER_MINUTE: u32 = 10;

/// Longest `User-Agent` kept in sessions and the audit log.
const MAX_USER_AGENT: usize = 256;

/// Auth settings derived from the config once, plus the rate limiters.
pub struct AuthState {
    pub origin: PublicOrigin,
    pub admins: Vec<Address>,
    pub trust_forwarded_for: bool,
    pub nonce_limit: RateLimiter,
    pub login_limit: RateLimiter,
}

impl AuthState {
    /// Panics on an invalid `auth` section; [`Config::validate`] rejects those first.
    pub fn new(cfg: &Config) -> Self {
        let window = Duration::from_secs(60);
        Self {
            origin: cfg.auth.origin().expect("validated auth.public_origin"),
            admins: cfg.auth.admin_addresses(),
            trust_forwarded_for: cfg.auth.trust_forwarded_for,
            nonce_limit: RateLimiter::new(AUTH_REQUESTS_PER_MINUTE, window),
            login_limit: RateLimiter::new(AUTH_REQUESTS_PER_MINUTE, window),
        }
    }

    pub fn is_admin(&self, addr: Address) -> bool {
        self.admins.contains(&addr)
    }
}

/// Whitelist rule: admins always; anyone else when whitelisted or while open
/// registration is on.
pub async fn may_log_in(state: &AppState, addr: Address) -> Result<bool, StoreError> {
    Ok(state.auth.is_admin(addr)
        || state.store.whitelist_contains(addr).await?
        || open_registration(state).await?)
}

pub async fn open_registration(state: &AppState) -> Result<bool, StoreError> {
    Ok(state
        .store
        .setting_get(SETTING_OPEN_REGISTRATION)
        .await?
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// The value of cookie `name` from the request's `Cookie` headers (first
/// occurrence).
pub fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| {
            let (k, v) = pair.trim().split_once('=')?;
            (k.trim() == name).then(|| v.trim())
        })
}

/// A `Set-Cookie` value; `max_age_secs = 0` deletes the cookie.
pub fn set_cookie(name: &str, value: &str, path: &str, max_age_secs: u64, secure: bool) -> String {
    let mut c =
        format!("{name}={value}; Path={path}; Max-Age={max_age_secs}; HttpOnly; SameSite=Lax");
    if secure {
        c.push_str("; Secure");
    }
    c
}

/// Client IP (D7): the socket peer; with `trust_forwarded_for`, the
/// right-most `X-Forwarded-For` hop instead, the one the single trusted
/// proxy appended (hops to its left are client-supplied). Falls back to the
/// peer when that hop does not parse. `None` without either (in-process tests).
pub fn client_ip(parts: &Parts, trust_forwarded_for: bool) -> Option<String> {
    let forwarded = trust_forwarded_for
        .then(|| parts.headers.get_all("x-forwarded-for").iter().next_back())
        .flatten()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .and_then(parse_hop);
    let peer = || {
        parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(a)| a.ip())
    };
    forwarded
        .or_else(peer)
        .map(|ip| ip.to_canonical().to_string())
}

/// One `X-Forwarded-For` hop: `ip`, `ip:port`, `[v6]` or `[v6]:port`.
fn parse_hop(hop: &str) -> Option<IpAddr> {
    let hop = hop.trim();
    if let Ok(ip) = hop.parse::<IpAddr>() {
        return Some(ip);
    }
    if let Ok(sa) = hop.parse::<SocketAddr>() {
        return Some(sa.ip());
    }
    let v6 = hop.strip_prefix('[')?.strip_suffix(']')?;
    v6.parse::<Ipv6Addr>().ok().map(IpAddr::V6)
}

/// The rate-limit bucket of a client IP: an IPv4 address on its own, an IPv6
/// address by its /64 (one subscriber usually holds a whole /64).
pub fn rate_key(ip: Option<&str>) -> String {
    match ip
        .and_then(|i| i.parse::<IpAddr>().ok())
        .map(|i| i.to_canonical())
    {
        Some(IpAddr::V4(v4)) => v4.to_string(),
        Some(IpAddr::V6(v6)) => {
            let mut seg = v6.segments();
            seg[4..].fill(0);
            format!("{}/64", Ipv6Addr::from(seg))
        }
        None => ip.unwrap_or("unknown").to_owned(),
    }
}

/// The `User-Agent`, cut to a bounded length.
pub fn user_agent(headers: &HeaderMap) -> Option<String> {
    let ua = headers.get(header::USER_AGENT)?.to_str().ok()?;
    Some(ua.chars().take(MAX_USER_AGENT).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderValue, Request};

    fn headers(cookies: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for c in cookies {
            h.append(header::COOKIE, HeaderValue::from_str(c).unwrap());
        }
        h
    }

    #[test]
    fn cookie_parsing() {
        let h = headers(&["a=1; eg_session=abc ;b=2", "eg_admin=def"]);
        assert_eq!(cookie(&h, "eg_session"), Some("abc"));
        assert_eq!(cookie(&h, "eg_admin"), Some("def"));
        assert_eq!(cookie(&h, "a"), Some("1"));
        assert_eq!(cookie(&h, "missing"), None);
        // Names match exactly, not by prefix or suffix.
        let h = headers(&["xeg_session=1; eg_session_old=2"]);
        assert_eq!(cookie(&h, "eg_session"), None);
        // The first occurrence wins; empty values and junk are tolerated.
        let h = headers(&["junk; eg_session=; eg_session=second"]);
        assert_eq!(cookie(&h, "eg_session"), Some(""));
        assert_eq!(cookie(&HeaderMap::new(), "eg_session"), None);
    }

    #[test]
    fn set_cookie_attributes() {
        assert_eq!(
            set_cookie("eg_session", "tok", "/", 604800, false),
            "eg_session=tok; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax"
        );
        assert_eq!(
            set_cookie("eg_admin", "", "/api/admin", 0, true),
            "eg_admin=; Path=/api/admin; Max-Age=0; HttpOnly; SameSite=Lax; Secure"
        );
    }

    fn parts(xff: &[&str], peer: Option<[u8; 4]>) -> Parts {
        let mut r = Request::get("/");
        for x in xff {
            r = r.header("x-forwarded-for", *x);
        }
        if let Some(ip) = peer {
            r = r.extension(ConnectInfo(SocketAddr::from((ip, 1234))));
        }
        r.body(()).unwrap().into_parts().0
    }

    #[test]
    fn client_ip_rules() {
        let peer = Some([10, 0, 0, 9]);
        let p = parts(&["203.0.113.7"], peer);
        assert_eq!(client_ip(&p, false).as_deref(), Some("10.0.0.9"));
        assert_eq!(client_ip(&p, true).as_deref(), Some("203.0.113.7"));
        // A spoofed leading hop is ignored: the proxy appended the last one.
        let p = parts(&["6.6.6.6, 203.0.113.7"], peer);
        assert_eq!(client_ip(&p, true).as_deref(), Some("203.0.113.7"));
        let p = parts(&["6.6.6.6", "1.1.1.1, 203.0.113.7"], peer);
        assert_eq!(client_ip(&p, true).as_deref(), Some("203.0.113.7"));
        // Port and bracket forms.
        for (hop, want) in [
            ("203.0.113.7:4711", "203.0.113.7"),
            ("2001:db8::1", "2001:db8::1"),
            ("[2001:db8::1]", "2001:db8::1"),
            ("[2001:db8::1]:443", "2001:db8::1"),
            (" [::ffff:203.0.113.7]:80 ", "203.0.113.7"),
        ] {
            let p = parts(&[&format!("6.6.6.6,{hop}")], peer);
            assert_eq!(client_ip(&p, true).as_deref(), Some(want), "{hop}");
        }
        // A malformed last hop falls back to the peer, never to an earlier hop.
        for bad in ["203.0.113.7, not-an-ip", "203.0.113.7,", "[2001:db8::1"] {
            let p = parts(&[bad], peer);
            assert_eq!(client_ip(&p, true).as_deref(), Some("10.0.0.9"), "{bad}");
        }
        assert_eq!(client_ip(&parts(&[], None), true), None);
    }

    #[test]
    fn rate_keys_bucket_ipv6_by_64() {
        let k = |ip: &str| rate_key(Some(ip));
        assert_eq!(k("203.0.113.7"), "203.0.113.7");
        assert_ne!(k("203.0.113.7"), k("203.0.113.8"));
        assert_eq!(k("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
        assert_eq!(k("2001:db8:1:2:aaaa::1"), k("2001:db8:1:2:ffff:1:2:3"));
        assert_ne!(k("2001:db8:1:2::1"), k("2001:db8:1:3::1"));
        // An IPv4-mapped peer counts as its IPv4 address.
        assert_eq!(k("::ffff:203.0.113.7"), "203.0.113.7");
        assert_eq!(rate_key(None), "unknown");
    }

    #[test]
    fn user_agent_is_bounded() {
        let mut h = HeaderMap::new();
        h.insert(
            header::USER_AGENT,
            HeaderValue::from_str(&"x".repeat(1000)).unwrap(),
        );
        assert_eq!(user_agent(&h).unwrap().len(), MAX_USER_AGENT);
        assert_eq!(user_agent(&HeaderMap::new()), None);
    }
}
