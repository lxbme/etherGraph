//! `GET /api/events`: the event bus as Server-Sent Events.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use eg_ingest::Event;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};

use crate::state::AppState;

pub async fn events(
    State(s): State<AppState>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let stream = BroadcastStream::new(s.ctx.bus.subscribe()).map(|r| {
        // A lagging subscriber missed events; tell the client so it can refetch.
        let e = r.unwrap_or(Event::Lagged);
        Ok(to_sse(&e))
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

/// `event:` is the serde `type` tag, `data:` the full JSON.
fn to_sse(e: &Event) -> SseEvent {
    let v = serde_json::to_value(e).expect("Event serializes");
    let name = v["type"].as_str().unwrap_or("Unknown").to_owned();
    SseEvent::default().event(name).data(v.to_string())
}
