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
  opts: {
    url?: string;
    EventSourceImpl?: typeof EventSource;
    /**
     * Asked after the stream dropped: false (the session is gone) ends the retry loop for good.
     * A rejection counts as alive (e.g. the server is unreachable), so reconnecting goes on.
     */
    sessionAlive?: () => Promise<boolean>;
  } = {},
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
    const retry = () => {
      if (stopped) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    };
    source.onerror = () => {
      source.close();
      if (stopped || es !== source) return;
      es = null;
      onState("closed");
      if (!opts.sessionAlive) return retry();
      // EventSource cannot see the status code: a 401 (or a stream the server ended because the
      // session died) looks like any other drop, so ask before trying again.
      opts.sessionAlive().then(
        (alive) => (alive ? retry() : void (stopped = true)),
        retry,
      );
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
