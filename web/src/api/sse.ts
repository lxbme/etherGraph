import type { Event } from "./generated/Event";

export type SseState = "connecting" | "open" | "closed";

const EVENT_TYPES: Event["type"][] = [
  "JobProgress", "AddressDataChanged", "TxReady", "NamesResolved", "MetaUpdated", "QuotaStatus", "Lagged",
];

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;

export function subscribeEvents(
  onEvent: (e: Event) => void,
  onState: (s: SseState) => void,
  opts: { url?: string; EventSourceImpl?: typeof EventSource } = {},
): () => void {
  const url = opts.url ?? "/api/events";
  const Impl = opts.EventSourceImpl ?? EventSource;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = BASE_DELAY;
  /** Connection attempts so far; any open after the first attempt may have missed events. */
  let attempts = 0;
  let stopped = false;

  const connect = () => {
    timer = null;
    attempts++;
    onState("connecting");
    const source = new Impl(url);
    es = source;
    source.onopen = () => {
      onState("open");
      delay = BASE_DELAY;
      if (attempts > 1) onEvent({ type: "Lagged" });
    };
    source.onerror = () => {
      source.close();
      if (stopped || es !== source) return;
      es = null;
      onState("closed");
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    };
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (ev) => {
        try {
          onEvent(JSON.parse((ev as MessageEvent).data) as Event);
        } catch (err) {
          console.warn("SSE: failed to parse event", type, err);
        }
      });
    }
  };

  connect();

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    es?.close();
    es = null;
    onState("closed");
  };
}
