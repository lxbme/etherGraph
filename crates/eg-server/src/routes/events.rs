//! `GET /api/events`: the viewer's events as Server-Sent Events.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use eg_ingest::Event;
use eg_store::SessionKind;
use futures::{Stream, StreamExt, stream};

use crate::auth::cookie;
use crate::auth::extract::CurrentUser;
use crate::state::AppState;

/// Only events addressed to the viewer (plus `Lagged` when this stream missed
/// events). The session is re-checked every `session_recheck`; the stream
/// ends once it is gone (logged out, revoked or expired).
pub async fn events(
    State(s): State<AppState>,
    user: CurrentUser,
    headers: HeaderMap,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let sub = s.ctx.bus.subscribe_user(user.id);
    let token = cookie(&headers, s.auth.session_cookie()).map(str::to_owned);
    let ended = session_gone(s.clone(), token);
    let stream = stream::unfold(sub, |mut sub| async move {
        let e = sub.recv().await?;
        Some((Ok(to_sse(&e)), sub))
    })
    .take_until(ended);
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

/// Resolves once the session of `token` no longer exists. A failed lookup
/// keeps the stream (the next check decides).
async fn session_gone(s: AppState, token: Option<String>) {
    // The auth gate let the request in with this cookie.
    let Some(token) = token else { return };
    let mut tick = tokio::time::interval(s.auth.session_recheck);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick fires at once; the gate has just checked the session.
    tick.tick().await;
    loop {
        tick.tick().await;
        match s.store.session_lookup(&token, SessionKind::User).await {
            Ok(Some(_)) => {}
            Ok(None) => return,
            Err(e) => tracing::warn!(error = %e, "re-checking an event stream's session failed"),
        }
    }
}

/// `event:` is the serde `type` tag, `data:` the full JSON.
fn to_sse(e: &Event) -> SseEvent {
    let v = serde_json::to_value(e).expect("Event serializes");
    let name = v["type"].as_str().unwrap_or("Unknown").to_owned();
    SseEvent::default().event(name).data(v.to_string())
}
