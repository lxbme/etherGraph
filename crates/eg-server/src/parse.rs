//! Parsing of request strings (addresses, hashes, assets, times, amounts).

use std::str::FromStr;

use alloy_primitives::{Address, B256, U256};
use chrono::{DateTime, Utc};
use eg_core::filter::Direction;
use eg_core::types::TransferKind;

use crate::error::{ApiError, invalid};

fn hex_body(s: &str, len: usize) -> Option<&str> {
    s.strip_prefix("0x")
        .filter(|h| h.len() == len && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Whether `s` is `0x` followed by exactly `digits` hex digits (any case).
pub fn is_hex(s: &str, digits: usize) -> bool {
    hex_body(s, digits).is_some()
}

/// `0x` + 40 hex digits; a mixed-case address must carry a valid EIP-55 checksum.
pub fn parse_address(s: &str) -> Result<Address, ApiError> {
    let body = hex_body(s, 40).ok_or_else(|| invalid(format!("invalid address {s:?}")))?;
    let mixed = body.bytes().any(|b| b.is_ascii_lowercase())
        && body.bytes().any(|b| b.is_ascii_uppercase());
    if mixed {
        Address::parse_checksummed(s, None)
            .map_err(|_| invalid(format!("invalid EIP-55 checksum in {s:?}")))
    } else {
        Address::from_str(body).map_err(|_| invalid(format!("invalid address {s:?}")))
    }
}

/// `0x` + 64 hex digits.
pub fn parse_tx_hash(s: &str) -> Result<B256, ApiError> {
    hex_body(s, 64)
        .and_then(|h| B256::from_str(h).ok())
        .ok_or_else(|| invalid(format!("invalid transaction hash {s:?}")))
}

/// `"eth"` (any case) is `None`; anything else must be a token address.
pub fn parse_asset(s: &str) -> Result<Option<Address>, ApiError> {
    if s.eq_ignore_ascii_case("eth") {
        Ok(None)
    } else {
        parse_address(s).map(Some).map_err(|_| {
            invalid(format!(
                "invalid asset {s:?}: expected \"eth\" or an address"
            ))
        })
    }
}

pub fn parse_time(s: &str, field: &str) -> Result<DateTime<Utc>, ApiError> {
    DateTime::parse_from_rfc3339(s)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|_| invalid(format!("{field} must be an RFC 3339 timestamp, got {s:?}")))
}

/// A token id: a decimal uint256 (digits only; leading zeros allowed).
pub fn parse_token_id(s: &str) -> Result<U256, ApiError> {
    let bad = || invalid(format!("token id must be a decimal uint256, got {s:?}"));
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    U256::from_str_radix(s, 10).map_err(|_| bad())
}

pub fn parse_kind(s: &str) -> Result<TransferKind, ApiError> {
    TransferKind::parse(s).ok_or_else(|| invalid(format!("unknown transfer kind {s:?}")))
}

/// `in` / `out` / `both` (absent means `both`).
pub fn parse_direction(s: Option<&str>) -> Result<Direction, ApiError> {
    match s {
        None | Some("both") => Ok(Direction::Both),
        Some("in") => Ok(Direction::In),
        Some("out") => Ok(Direction::Out),
        Some(other) => Err(invalid(format!(
            "direction must be \"in\", \"out\" or \"both\", got {other:?}"
        ))),
    }
}

/// Converts a non-negative decimal string (`"123"`, `"1000.5"`) in whole units
/// into a raw integer amount with `decimals` fractional digits. Signs,
/// exponents, more fractional digits than `decimals` and values above
/// `U256::MAX` are rejected.
pub fn parse_amount(s: &str, decimals: u8) -> Result<U256, String> {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    if !digits(int) || (s.contains('.') && !digits(frac)) {
        return Err("expected a non-negative decimal number".into());
    }
    if frac.len() > usize::from(decimals) {
        return Err(format!("more than {decimals} fractional digits"));
    }
    let too_large = || "amount too large".to_string();
    let pow10 = |n: usize| U256::from(10u8).checked_pow(U256::from(n));
    let scale = pow10(usize::from(decimals)).ok_or_else(too_large)?;
    let int = U256::from_str_radix(int, 10).map_err(|_| too_large())?;
    let frac = if frac.is_empty() {
        U256::ZERO
    } else {
        // frac < 10^len and len <= decimals, so this stays below `scale`.
        U256::from_str_radix(frac, 10).map_err(|_| too_large())?
            * pow10(usize::from(decimals) - frac.len()).ok_or_else(too_large)?
    };
    int.checked_mul(scale)
        .and_then(|v| v.checked_add(frac))
        .ok_or_else(too_large)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_scale_by_decimals() {
        let u = |v: u64| U256::from(v);
        assert_eq!(parse_amount("123", 0), Ok(u(123)));
        assert_eq!(parse_amount("1000.5", 6), Ok(u(1_000_500_000)));
        assert_eq!(parse_amount("0.000001", 6), Ok(u(1)));
        assert_eq!(parse_amount("1", 18), Ok(u(1_000_000_000_000_000_000)));
        assert_eq!(parse_amount("007.50", 2), Ok(u(750)));
        assert_eq!(parse_amount("0", 77), Ok(U256::ZERO));
        assert_eq!(parse_amount(&U256::MAX.to_string(), 0), Ok(U256::MAX));
    }

    #[test]
    fn amounts_reject_bad_input() {
        for bad in [
            "", "-1", "+1", "1e6", "1E6", "abc", "1.", ".5", "1.2.3", " 1", "1_000",
        ] {
            assert!(parse_amount(bad, 6).is_err(), "{bad:?}");
        }
        assert!(parse_amount("0.0000001", 6).is_err());
        assert!(parse_amount("1.5", 0).is_err());
        let over = format!("{}0", U256::MAX);
        assert!(parse_amount(&over, 0).is_err());
        assert!(parse_amount(&U256::MAX.to_string(), 1).is_err());
        assert!(parse_amount("1", 78).is_err());
    }

    #[test]
    fn addresses_and_hashes() {
        let lower = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
        let a = parse_address(lower).unwrap();
        assert_eq!(format!("{a:#x}"), lower);
        assert_eq!(
            parse_address("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045").unwrap(),
            a
        );
        assert_eq!(
            parse_address(&lower.to_uppercase().replacen("0X", "0x", 1)).unwrap(),
            a
        );
        for bad in [
            "0xd8Da6BF26964aF9D7eEd9e03E53415D37aA96045",
            "d8da6bf26964af9d7eed9e03e53415d37aa96045",
            "0Xd8da6bf26964af9d7eed9e03e53415d37aa96045",
            "0xd8da6bf26964af9d7eed9e03e53415d37aa9604",
            "0x12",
        ] {
            let e = parse_address(bad).unwrap_err();
            assert_eq!(e.code, "invalid_input", "{bad}");
        }
        let h = format!("0x{}", "Ab".repeat(32));
        assert_eq!(parse_tx_hash(&h).unwrap(), B256::repeat_byte(0xab));
        assert!(parse_tx_hash(lower).is_err());
        assert_eq!(parse_asset("ETH").unwrap(), None);
        assert_eq!(parse_asset(lower).unwrap(), Some(a));
        assert!(parse_asset("btc").is_err());
    }
}
