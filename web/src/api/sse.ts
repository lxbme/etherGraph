import type { Event } from "./generated/Event";

export type SseState = "connecting" | "open" | "closed";

/** Every event type, as a record so that a type added to `Event` and missing here fails typecheck. */
const EVENT_TYPE_SET: Record<Event["type"], true> = {
  JobProgress: true,
  AddressDataChanged: true,
  TxReady: true,
  TraceReady: true,
  NftReady: true,
  NamesResolved: true,
  MetaUpdated: true,
  QuotaStatus: true,
  LocalDataProgress: true,
  LocalDataDone: true,
  Lagged: true,
};
const EVENT_TYPES = Object.keys(EVENT_TYPE_SET) as Event["type"][];

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
