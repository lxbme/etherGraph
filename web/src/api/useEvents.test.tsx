import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { useGraph } from "../graph/store";
import { graphQueryKey, useGraphData } from "../graph/useGraphData";
import { Banners } from "../shell/Banners";
import { useJobProgress, useQuota, useSseState } from "../shell/statusStore";
import { Toasts } from "../shell/Toasts";
import { api } from "./endpoints";
import { ApiError } from "./errors";
import type { Event } from "./generated/Event";
import type { GraphResponseDto } from "./generated/GraphResponseDto";
import type { JobDto } from "./generated/JobDto";
import type { LocalDataDto } from "./generated/LocalDataDto";
import type { NodeSummaryDto } from "./generated/NodeSummaryDto";
import type { StatusDto } from "./generated/StatusDto";
import { qk } from "./queryClient";
import { subscribeEvents, type SseState } from "./sse";
import { useEvents } from "./useEvents";

vi.mock("./sse", () => ({ subscribeEvents: vi.fn() }));

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);

const node = (address: string): NodeSummaryDto => ({
  address, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null,
});
const status: StatusDto = {
  quota_used: 10, quota_limit: 100, paused: false, server_paused: false, reset_at: "2026-10-18T00:00:00Z", queue_len: 0,
  rate: 5, jobs_active: 0, queued_calls: 0, calls: 0, retries: 0, errors: {}, degraded: "invalid_key",
};

let qc: QueryClient;
let emit: (e: Event) => void;
let setSse: (s: SseState) => void;
let unsubscribe: ReturnType<typeof vi.fn<() => void>>;

function Harness() {
  useEvents();
  return (
    <>
      <Banners />
      <Toasts />
    </>
  );
}
const mount = () =>
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
const send = (e: Event) => act(() => emit(e));
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** Number of invalidateQueries calls whose filter targets the given key prefix. */
const callsFor = (spy: ReturnType<typeof vi.spyOn>, head: string) =>
  spy.mock.calls.filter((c: unknown[]) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] === head).length;

beforeEach(() => {
  vi.useFakeTimers();
  qc = new QueryClient();
  useGraph.getState().reset();
  useSseState.setState({ state: "connecting" });
  useQuota.setState({ quota: null, degraded: null });
  useJobProgress.setState({ byId: {} });
  unsubscribe = vi.fn<() => void>();
  vi.mocked(subscribeEvents).mockImplementation((onEvent, onState) => {
    emit = onEvent;
    setSse = onState;
    onState("connecting");
    return unsubscribe;
  });
  vi.spyOn(api, "status").mockResolvedValue(status);
  vi.spyOn(api, "jobs").mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("100 AddressDataChanged events within 500ms cause one graph invalidation", () => {
  useGraph.getState().addCenter(A);
  mount();
  const spy = vi.spyOn(qc, "invalidateQueries");
  for (let i = 0; i < 100; i++) {
    send({ type: "AddressDataChanged", address: i % 2 ? A.toUpperCase().replace("0X", "0x") : A });
    advance(4);
  }
  expect(callsFor(spy, "graph")).toBe(0);
  advance(100);
  expect(callsFor(spy, "graph")).toBe(1);
  expect(spy).toHaveBeenCalledWith({ queryKey: qk.address(A) });
  expect(callsFor(spy, "address")).toBe(1);
  advance(2000);
  expect(callsFor(spy, "graph")).toBe(1);
});

test("AddressDataChanged invalidates related transfers queries only", () => {
  useGraph.getState().addCenter(A);
  mount();
  qc.setQueryData(qk.transfers({ address: A }), 1);
  qc.setQueryData(qk.transfers({ from: B, to: A }), 1);
  qc.setQueryData(qk.transfers({ address: B }), 1);
  send({ type: "AddressDataChanged", address: A });
  advance(500);
  expect(qc.getQueryState(qk.transfers({ address: A }))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(qk.transfers({ from: B, to: A }))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(qk.transfers({ address: B }))?.isInvalidated).toBe(false);
});

test("AddressDataChanged resets the Data tab's transfers of pairs at that address only", () => {
  useGraph.getState().addCenter(A);
  mount();
  const page = { pageParams: [{ chunk: 0 }], pages: [{ items: [], next_cursor: null }] };
  const touched = qk.transfersBatch([{ from: C, to: A, asset: null }], {});
  const other = qk.transfersBatch([{ from: B, to: C, asset: null }], {});
  qc.setQueryData(touched, page);
  qc.setQueryData(other, page);
  const spy = vi.spyOn(qc, "resetQueries");
  send({ type: "AddressDataChanged", address: A.toUpperCase().replace("0X", "0x") });
  advance(500);
  expect(spy).toHaveBeenCalledTimes(1);
  // Reset, not just invalidated: the loaded pages are dropped, so it starts again from page 1.
  expect(qc.getQueryData(touched)).toBeUndefined();
  expect(qc.getQueryData(other)).toEqual(page);
});

test("AddressDataChanged invalidates that contract's counterparties lists only", () => {
  useGraph.getState().addCenter(A);
  mount();
  qc.setQueryData(["counterparties", B, { sort: "count_desc" }], 1);
  qc.setQueryData(["counterparties", C, { sort: "count_desc" }], 1);
  send({ type: "AddressDataChanged", address: B });
  advance(500);
  expect(qc.getQueryState(["counterparties", B, { sort: "count_desc" }])?.isInvalidated).toBe(true);
  expect(qc.getQueryState(["counterparties", C, { sort: "count_desc" }])?.isInvalidated).toBe(false);
});

test("AddressDataChanged invalidates the transfer table's asset lists of that address and its pairs", () => {
  useGraph.getState().addCenter(A);
  mount();
  qc.setQueryData(qk.addressAssets(A), []);
  qc.setQueryData(qk.addressAssets(B, A), []);
  qc.setQueryData(qk.addressAssets(B, C), []);
  send({ type: "AddressDataChanged", address: A });
  advance(500);
  expect(qc.getQueryState(qk.addressAssets(A))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(qk.addressAssets(B, A))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(qk.addressAssets(B, C))?.isInvalidated).toBe(false);
});

test("an off-canvas address with a cached counterparties list invalidates only that list", () => {
  useGraph.getState().addCenter(A);
  qc.setQueryData(graphQueryKey(useGraph.getState()), { nodes: [node(A)], edges: [], omitted: {}, coverage: {} });
  mount();
  qc.setQueryData(["counterparties", C, { sort: "count_desc" }], 1);
  const spy = vi.spyOn(qc, "invalidateQueries");
  send({ type: "AddressDataChanged", address: C });
  advance(1000);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith({ queryKey: ["counterparties", C] });
});

test("events for addresses not on the canvas are ignored", () => {
  useGraph.getState().addCenter(A);
  const data: GraphResponseDto = { nodes: [node(A), node(B)], edges: [], omitted: {}, coverage: {} };
  qc.setQueryData(graphQueryKey(useGraph.getState()), data);
  mount();
  const spy = vi.spyOn(qc, "invalidateQueries");
  send({ type: "AddressDataChanged", address: C });
  advance(1000);
  expect(spy).not.toHaveBeenCalled();

  // B is not a center but is a node of the current graph.
  send({ type: "AddressDataChanged", address: B });
  advance(500);
  expect(callsFor(spy, "graph")).toBe(1);
  expect(spy).toHaveBeenCalledWith({ queryKey: qk.address(B) });
});

test("the live identities of snapshot nodes refetch with the graph", () => {
  useGraph.getState().addCenter(A);
  mount();
  const spy = vi.spyOn(qc, "invalidateQueries");
  send({ type: "AddressDataChanged", address: A });
  advance(500);
  expect(callsFor(spy, "nodes")).toBe(1);
  send({ type: "MetaUpdated", addresses: [B] });
  advance(500);
  expect(callsFor(spy, "nodes")).toBe(2);
});

test("NamesResolved and MetaUpdated are coalesced into one graph + address invalidation", () => {
  mount();
  const spy = vi.spyOn(qc, "invalidateQueries");
  send({ type: "NamesResolved", items: [{ address: B, name: "b.eth", status: "ok" }] });
  send({ type: "MetaUpdated", addresses: [C.toUpperCase().replace("0X", "0x")] });
  advance(499);
  expect(spy).not.toHaveBeenCalled();
  advance(1);
  expect(callsFor(spy, "graph")).toBe(1);
  expect(spy).toHaveBeenCalledWith({ queryKey: qk.address(B) });
  expect(spy).toHaveBeenCalledWith({ queryKey: qk.address(C) });
});

test("MetaUpdated refetches the cached txs the addresses take part in, and only those", () => {
  mount();
  const flowOf = (...addrs: string[]) => ({ status: "ready", job_id: null, flow: { nodes: addrs.map(node) } });
  qc.setQueryData(qk.tx("0x1"), flowOf(A, B));
  qc.setQueryData(qk.tx("0x2"), flowOf(A));
  qc.setQueryData(qk.tx("0x3"), { status: "pending", job_id: 1, flow: null });
  send({ type: "MetaUpdated", addresses: [B.toUpperCase().replace("0X", "0x")] });
  advance(500);
  expect(qc.getQueryState(qk.tx("0x1"))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(qk.tx("0x2"))?.isInvalidated).toBe(false);
  expect(qc.getQueryState(qk.tx("0x3"))?.isInvalidated).toBe(false);
});

test("MetaUpdated for an EIP-7702 delegate refetches the tx, so the call is re-decoded with the delegate's ABI", () => {
  mount();
  // The delegate (C) is one of the tx's flow nodes even though no funds moved through it.
  qc.setQueryData(qk.tx("0x1"), {
    status: "ready",
    job_id: null,
    flow: { nodes: [A, C].map(node), detail: { authorizations: [{ chain_id: "1", delegate: C, nonce: "0", authority: A }] }, call: null },
  });
  send({ type: "MetaUpdated", addresses: [C] });
  advance(500);
  expect(qc.getQueryState(qk.tx("0x1"))?.isInvalidated).toBe(true);
});

test("MetaUpdated refetches a tx whose call is still undecoded: the ABI may be its recipient's current EIP-7702 delegate's, no node", () => {
  mount();
  const tx = (selector: string | null, call: unknown, to: string | null = B) => ({
    status: "ready", job_id: null, flow: { nodes: [node(A)], tx: { selector, to }, call },
  });
  qc.setQueryData(qk.tx("0x1"), tx("0x99e1d016", null));
  qc.setQueryData(qk.tx("0x2"), tx("0x99e1d016", { name: "execute" }));
  qc.setQueryData(qk.tx("0x3"), tx(null, null));
  qc.setQueryData(qk.tx("0x4"), tx("0x99e1d016", { name: "execute", guessed: true }));
  // A contract creation has no recipient whose delegate could decode its init code.
  qc.setQueryData(qk.tx("0x5"), tx("0x60806040", null, null));
  send({ type: "MetaUpdated", addresses: [C] });
  advance(500);
  expect(qc.getQueryState(qk.tx("0x1"))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(qk.tx("0x2"))?.isInvalidated).toBe(false);
  expect(qc.getQueryState(qk.tx("0x3"))?.isInvalidated).toBe(false);
  expect(qc.getQueryState(qk.tx("0x4"))?.isInvalidated).toBe(true);
  expect(qc.getQueryState(qk.tx("0x5"))?.isInvalidated).toBe(false);
});

test("TxReady invalidates that tx", () => {
  mount();
  const spy = vi.spyOn(qc, "invalidateQueries");
  const h = "0x" + "AB".repeat(32);
  send({ type: "TxReady", hash: h });
  expect(spy).toHaveBeenCalledWith({ queryKey: qk.tx(h.toLowerCase()) });
});

test("NftReady invalidates that NFT's metadata", () => {
  mount();
  const spy = vi.spyOn(qc, "invalidateQueries");
  send({ type: "NftReady", token: "0x" + "A7".repeat(20), token_id: "7" });
  expect(spy).toHaveBeenCalledWith({ queryKey: qk.nft("0x" + "a7".repeat(20), "7") });
});

test("Lagged invalidates all queries", () => {
  mount();
  qc.setQueryData(qk.tx("0x1"), 1);
  qc.setQueryData(qk.address(A), 1);
  qc.setQueryData(["graph", [A], {}], 1);
  send({ type: "Lagged" });
  for (const k of [qk.tx("0x1"), qk.address(A), ["graph", [A], {}]]) {
    expect(qc.getQueryState(k)?.isInvalidated).toBe(true);
  }
});

test("QuotaStatus paused shows the quota banner", () => {
  mount();
  expect(screen.queryByText(/quota is used up/)).toBeNull();
  send({ type: "QuotaStatus", used: 100, limit: 100, paused: true, server_paused: false, reset_at: "2026-10-18T00:00:00Z" });
  expect(useQuota.getState().quota).toEqual({ used: 100, limit: 100, paused: true, server_paused: false, reset_at: "2026-10-18T00:00:00Z" });
  expect(screen.getByText(/Today's quota is used up: names and metadata are filled in tomorrow/)).toBeInTheDocument();
});

test("JobProgress updates the job store; a failed fetch_tx job shows a toast", () => {
  mount();
  const base = { type: "JobProgress" as const, job_id: 7, fetched: 3, cursor_block: null, error: null };
  send({ ...base, kind: "sync_address", status: "running" });
  expect(useJobProgress.getState().byId[7]?.status).toBe("running");
  send({ ...base, kind: "sync_address", status: "failed", error: "x" });
  expect(screen.queryByText(/Transaction fetch failed/)).toBeNull();
  send({ ...base, job_id: 8, kind: "fetch_tx", status: "failed", error: "timeout" });
  expect(useJobProgress.getState().byId[8]?.status).toBe("failed");
  expect(screen.getByText("Transaction fetch failed: timeout")).toBeInTheDocument();
  send({ ...base, job_id: 9, kind: "fetch_tx", status: "failed", error: null });
  expect(screen.getByText("Transaction fetch failed: unknown reason")).toBeInTheDocument();
});

test("writes SSE state, loads status on mount and unsubscribes on unmount", async () => {
  const { unmount } = mount();
  await act(async () => {});
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(useQuota.getState().quota).toEqual({ used: 10, limit: 100, paused: false, server_paused: false, reset_at: "2026-10-18T00:00:00Z" });
  expect(useQuota.getState().degraded).toBe("invalid_key");
  expect(useSseState.getState().state).toBe("connecting");
  act(() => setSse("open"));
  expect(useSseState.getState().state).toBe("open");

  useGraph.getState().addCenter(A);
  const spy = vi.spyOn(qc, "invalidateQueries");
  send({ type: "AddressDataChanged", address: A });
  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  advance(1000);
  expect(spy).not.toHaveBeenCalled();
});

const job = (id: number): JobDto => ({
  id, key: `k${id}`, kind: "sync_address", status: "running", priority: "interactive", params: null,
  progress: null, attempts: 0, error: null, created_at: "", updated_at: "", batches: [],
});
const progress = (job_id: number) =>
  ({ type: "JobProgress" as const, job_id, kind: "sync_address" as const, fetched: 0, cursor_block: null, status: "running" as const, error: null });

test("Lagged reloads status and drops job progress for jobs that are no longer active", async () => {
  mount();
  await act(async () => {});
  send(progress(1));
  send(progress(2));
  vi.mocked(api.jobs).mockResolvedValue([job(2)]);
  // Server-wide pause: the banner then does not load the job list itself (only the resync's calls count).
  vi.mocked(api.status).mockResolvedValue({ ...status, paused: true, server_paused: true, degraded: null });
  send({ type: "Lagged" });
  await act(async () => {});
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(api.jobs).toHaveBeenCalledTimes(2);
  expect(Object.keys(useJobProgress.getState().byId)).toEqual(["2"]);
  expect(useQuota.getState().quota?.paused).toBe(true);
  expect(useQuota.getState().degraded).toBeNull();
});

test("a failed mount status load is retried with backoff until it succeeds once", async () => {
  vi.mocked(api.status).mockRejectedValue(new Error("down"));
  mount();
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await tick(0);
  expect(api.status).toHaveBeenCalledTimes(1);
  // Retries after 2s, 5s, 10s, then every 30s.
  for (const [wait, calls] of [[1999, 1], [1, 2], [5000, 3], [10000, 4], [30000, 5], [30000, 6]] as const) {
    await tick(wait);
    expect(api.status).toHaveBeenCalledTimes(calls);
  }
  expect(useQuota.getState().quota).toBeNull();
  vi.mocked(api.status).mockResolvedValue(status);
  await tick(30000);
  expect(api.status).toHaveBeenCalledTimes(7);
  expect(useQuota.getState().quota?.used).toBe(10);
  await tick(120000);
  expect(api.status).toHaveBeenCalledTimes(7);
});

test("an address in any cached graph result counts as on the canvas", () => {
  useGraph.getState().addCenter(A);
  // Older key (another filter) still cached, e.g. shown as placeholder while the new key loads.
  qc.setQueryData(qk.graph([A], { filter: { kinds: ["erc20"] }, sort: "count" }), {
    nodes: [node(A), node(B)], edges: [], omitted: {}, coverage: {},
  } satisfies GraphResponseDto);
  mount();
  const spy = vi.spyOn(qc, "invalidateQueries");
  send({ type: "AddressDataChanged", address: B });
  advance(500);
  expect(callsFor(spy, "graph")).toBe(1);
});

test("a slow graph fetch completes during an event storm and is refetched once after it", async () => {
  useGraph.getState().addCenter(A);
  const calls: { start: number; signal?: AbortSignal }[] = [];
  let completed = 0;
  vi.spyOn(api, "graphEdges").mockImplementation((_req, opts) => {
    const n = calls.length;
    calls.push({ start: Date.now(), signal: opts?.signal });
    return new Promise((resolve) =>
      setTimeout(() => {
        completed++;
        resolve({ nodes: [node(A)], edges: [], omitted: { [A]: n }, coverage: {} });
      }, 800),
    );
  });
  function GraphHarness() {
    useEvents();
    useGraphData();
    return null;
  }
  render(
    <QueryClientProvider client={qc}>
      <GraphHarness />
    </QueryClientProvider>,
  );
  // Results that actually landed in the cache (a cancelled fetch never does).
  let landed = 0;
  qc.getQueryCache().subscribe((ev) => {
    if (ev.type === "updated" && ev.action.type === "success" && ev.query.queryKey[0] === "graph") landed++;
  });
  let lastEvent = 0;
  for (let t = 0; t < 4000; t += 50) {
    lastEvent = Date.now();
    act(() => emit({ type: "AddressDataChanged", address: A }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  }
  const landedDuringStorm = landed;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

  expect(landedDuringStorm).toBeGreaterThanOrEqual(2);
  expect(calls.every((c) => !c.signal?.aborted)).toBe(true);
  expect(completed).toBe(calls.length);
  expect(landed).toBe(calls.length);
  expect(calls.filter((c) => c.start > lastEvent)).toHaveLength(1);
  const data = qc.getQueryData<GraphResponseDto>(graphQueryKey(useGraph.getState()));
  expect(data?.omitted[A]).toBe(calls.length - 1);
});

test("JobProgress for a job missing from the cached jobs list invalidates the list", async () => {
  mount();
  await act(async () => {});
  qc.setQueryData(qk.jobs(), [job(1)]);
  send(progress(1));
  expect(qc.getQueryState(qk.jobs())?.isInvalidated).toBe(false);
  send(progress(2));
  expect(qc.getQueryState(qk.jobs())?.isInvalidated).toBe(true);
});

test("JobProgress with a finished status drops the job from the cached active list at once", async () => {
  mount();
  await act(async () => {});
  qc.setQueryData(qk.jobs(), [job(1), job(2)]);
  send({ ...progress(1), status: "done" as const });
  expect(qc.getQueryData<JobDto[]>(qk.jobs())?.map((j) => j.id)).toEqual([2]);
  expect(qc.getQueryState(qk.jobs())?.isInvalidated).toBe(false);
});

test("a dropped stream checks the session: only a 401 stops reconnecting", async () => {
  mount();
  const opts = vi.mocked(subscribeEvents).mock.calls[0]![2];
  const sessionAlive = opts?.sessionAlive;
  expect(sessionAlive).toBeTypeOf("function");
  const me = vi.spyOn(api, "me");
  me.mockResolvedValueOnce({ address: A, is_admin: false, quota: { used: 0, limit: 1, reset_at: "x" } });
  await expect(sessionAlive!()).resolves.toBe(true);
  me.mockRejectedValueOnce(new ApiError("network", 0, "offline"));
  await expect(sessionAlive!()).resolves.toBe(true);
  me.mockRejectedValueOnce(new ApiError("unauthorized", 401, "no_session"));
  await expect(sessionAlive!()).resolves.toBe(false);
});

test("LocalDataProgress keeps the latest progress per source and marks that source running in the cached list", () => {
  const list: LocalDataDto = {
    checked_at: null, running: null, signatures_enabled: false,
    sources: [{
      source: "eth_labels", version: null, imported_at: null, rows: 3, state: "failed", error: "boom", error_at: "2026-10-23T09:00:00Z",
      upstream: { status: "update", version: null, files: null, bytes: null, error: null }, partial: null,
    }],
  };
  qc.setQueryData(qk.localData(), list);
  mount();
  const progress = { type: "LocalDataProgress", source: "eth_labels", phase: "download", bytes: 5, total_bytes: 10, rows: 0, files_done: null, files_total: null } as const;
  send(progress);
  expect(qc.getQueryData(qk.localDataProgress())).toEqual({ eth_labels: progress });
  const cached = qc.getQueryData<LocalDataDto>(qk.localData())!;
  expect(cached.running).toBe("eth_labels");
  expect(cached.sources[0]).toMatchObject({ state: "running", error: null, error_at: null });
});

test("LocalDataDone drops that source's progress and refetches the list", () => {
  qc.setQueryData(qk.localDataProgress(), {
    eth_labels: { type: "LocalDataProgress", source: "eth_labels", phase: "import", bytes: 1, total_bytes: 1, rows: 7, files_done: null, files_total: null },
  });
  const spy = vi.spyOn(qc, "invalidateQueries");
  mount();
  send({ type: "LocalDataDone", source: "eth_labels", outcome: "succeeded", error: null });
  expect(qc.getQueryData(qk.localDataProgress())).toEqual({});
  expect(spy).toHaveBeenCalledWith({ queryKey: qk.localData() });
});

test("LocalDataDone marks the cached list done at once: nothing running, the source idle or failed per the outcome", () => {
  const src = (source: string) => ({
    source, version: null, imported_at: null, rows: 3, state: "running" as const, error: null, error_at: null,
    upstream: { status: "update" as const, version: null, files: null, bytes: null, error: null }, partial: null,
  });
  qc.setQueryData<LocalDataDto>(qk.localData(), { checked_at: null, running: "eth_labels", signatures_enabled: false, sources: [src("eth_labels"), src("tokens_uniswap")] });
  mount();
  send({ type: "LocalDataDone", source: "eth_labels", outcome: "failed", error: "boom" });
  let cached = qc.getQueryData<LocalDataDto>(qk.localData())!;
  expect(cached.running).toBeNull();
  expect(cached.sources[0]).toMatchObject({ state: "failed", error: "boom" });
  expect(cached.sources[1]!.state).toBe("running"); // only that source

  qc.setQueryData<LocalDataDto>(qk.localData(), (d) => ({ ...d!, running: "tokens_uniswap" }));
  send({ type: "LocalDataDone", source: "tokens_uniswap", outcome: "cancelled", error: null });
  cached = qc.getQueryData<LocalDataDto>(qk.localData())!;
  expect(cached.running).toBeNull();
  expect(cached.sources[1]).toMatchObject({ state: "idle", error: null });
});
