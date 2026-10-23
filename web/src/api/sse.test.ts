import { subscribeEvents, type SseState } from "./sse";
import type { Event } from "./generated/Event";

class FakeES {
  static instances: FakeES[] = [];
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  close() { this.closed = true; }
  emit(t: string, data: string) { this.listeners.get(t)?.forEach((f) => f({ data } as MessageEvent)); }
}

const inst = (i: number): FakeES => {
  const x = FakeES.instances[i];
  if (!x) throw new Error(`no instance ${i}`);
  return x;
};

beforeEach(() => { FakeES.instances = []; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

test("subscribeEvents dispatches typed events and reconnects with backoff", () => {
  const events: Event[] = [];
  const states: SseState[] = [];
  const stop = subscribeEvents((e) => events.push(e), (s) => states.push(s), {
    EventSourceImpl: FakeES as unknown as typeof EventSource,
  });
  expect(states).toEqual(["connecting"]);
  const a = inst(0);
  expect(a.url).toBe("/api/events");
  a.onopen!();
  expect(states.at(-1)).toBe("open");
  a.emit("TxReady", JSON.stringify({ type: "TxReady", hash: "0x1" }));
  a.emit("TxReady", "not json");
  expect(events).toEqual([{ type: "TxReady", hash: "0x1" }]);

  a.onerror!();
  expect(a.closed).toBe(true);
  expect(states.at(-1)).toBe("closed");
  expect(FakeES.instances).toHaveLength(1);
  vi.advanceTimersByTime(999);
  expect(FakeES.instances).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(FakeES.instances).toHaveLength(2);
  expect(states.at(-1)).toBe("connecting");

  // second failure before open: backoff doubles to 2s
  const b = inst(1);
  b.onerror!();
  vi.advanceTimersByTime(1999);
  expect(FakeES.instances).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(FakeES.instances).toHaveLength(3);

  const c = inst(2);
  c.onopen!();
  expect(events.at(-1)).toEqual({ type: "Lagged" });

  // backoff reset after successful open
  c.onerror!();
  vi.advanceTimersByTime(1000);
  expect(FakeES.instances).toHaveLength(4);

  stop();
  const n = states.length;
  stop();
  expect(states).toHaveLength(n);
  expect(inst(3).closed).toBe(true);
  vi.advanceTimersByTime(60000);
  expect(FakeES.instances).toHaveLength(4);
});

test("first open does not emit Lagged", () => {
  const events: Event[] = [];
  subscribeEvents((e) => events.push(e), () => {}, { EventSourceImpl: FakeES as unknown as typeof EventSource });
  inst(0).onopen!();
  expect(events).toEqual([]);
});

test("the first successful open after failed attempts emits Lagged (events may have been missed)", () => {
  const events: Event[] = [];
  subscribeEvents((e) => events.push(e), () => {}, { EventSourceImpl: FakeES as unknown as typeof EventSource });
  inst(0).onerror!();
  vi.advanceTimersByTime(1000);
  inst(1).onopen!();
  expect(events).toEqual([{ type: "Lagged" }]);
});

describe("session check on a dropped stream", () => {
  const ES = FakeES as unknown as typeof EventSource;

  test("a dead session stops the retry loop for good", async () => {
    const states: SseState[] = [];
    const sessionAlive = vi.fn().mockResolvedValue(false);
    subscribeEvents(() => {}, (s) => states.push(s), { EventSourceImpl: ES, sessionAlive });
    inst(0).onopen!();
    inst(0).onerror!();
    await vi.runAllTimersAsync();
    expect(sessionAlive).toHaveBeenCalledTimes(1);
    expect(FakeES.instances).toHaveLength(1);
    expect(states.at(-1)).toBe("closed");
    vi.advanceTimersByTime(120_000);
    expect(FakeES.instances).toHaveLength(1);
  });

  test("a live session (or a failed check) reconnects with backoff", async () => {
    const sessionAlive = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("offline"));
    subscribeEvents(() => {}, () => {}, { EventSourceImpl: ES, sessionAlive });
    inst(0).onerror!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeES.instances).toHaveLength(2);
    inst(1).onerror!();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeES.instances).toHaveLength(3);
    expect(sessionAlive).toHaveBeenCalledTimes(2);
  });

  test("stopping while the check runs never reconnects", async () => {
    let answer!: (alive: boolean) => void;
    const sessionAlive = () => new Promise<boolean>((r) => (answer = r));
    const stop = subscribeEvents(() => {}, () => {}, { EventSourceImpl: ES, sessionAlive });
    inst(0).onerror!();
    stop();
    answer(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeES.instances).toHaveLength(1);
  });
});

test("the admin page's local-data events are listened for", () => {
  const events: Event[] = [];
  const stop = subscribeEvents((e) => events.push(e), () => {}, { EventSourceImpl: FakeES as unknown as typeof EventSource });
  const progress = { type: "LocalDataProgress", source: "eth_labels", phase: "download", bytes: 1, total_bytes: 2, rows: 0, files_done: null, files_total: null };
  const done = { type: "LocalDataDone", source: "eth_labels", outcome: "succeeded", error: null };
  inst(0).emit("LocalDataProgress", JSON.stringify(progress));
  inst(0).emit("LocalDataDone", JSON.stringify(done));
  expect(events).toEqual([progress, done]);
  stop();
});
