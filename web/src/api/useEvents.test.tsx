import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { useGraph } from "../graph/store";
import { graphQueryKey } from "../graph/useGraphData";
import { Banners } from "../shell/Banners";
import { useJobProgress, useQuota, useSseState } from "../shell/statusStore";
import { Toasts } from "../shell/Toasts";
import { api } from "./endpoints";
import type { Event } from "./generated/Event";
import type { GraphResponseDto } from "./generated/GraphResponseDto";
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
  partial: false, syncing: false, synced: true, hot: false,
});
const status: StatusDto = {
  quota_used: 10, quota_limit: 100, paused: false, reset_at: "2026-10-18T00:00:00Z", queue_len: 0,
  rate: 5, jobs_active: 0, calls: 0, retries: 0, errors: {}, degraded: "invalid_key",
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

test("TxReady invalidates that tx", () => {
  mount();
  const spy = vi.spyOn(qc, "invalidateQueries");
  const h = "0x" + "AB".repeat(32);
  send({ type: "TxReady", hash: h });
  expect(spy).toHaveBeenCalledWith({ queryKey: qk.tx(h.toLowerCase()) });
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
  expect(screen.queryByText(/今日 Etherscan 额度已用完/)).toBeNull();
  send({ type: "QuotaStatus", used: 100, limit: 100, paused: true, reset_at: "2026-10-18T00:00:00Z" });
  expect(useQuota.getState().quota).toEqual({ used: 100, limit: 100, paused: true, reset_at: "2026-10-18T00:00:00Z" });
  expect(screen.getByText(/今日 Etherscan 额度已用完，将于 .+ 恢复/)).toBeInTheDocument();
});

test("JobProgress updates the job store; a failed fetch_tx job shows a toast", () => {
  mount();
  const base = { type: "JobProgress" as const, job_id: 7, fetched: 3, cursor_block: null, error: null };
  send({ ...base, kind: "sync_address", status: "running" });
  expect(useJobProgress.getState().byId[7]?.status).toBe("running");
  send({ ...base, kind: "sync_address", status: "failed", error: "x" });
  expect(screen.queryByText(/交易抓取失败/)).toBeNull();
  send({ ...base, job_id: 8, kind: "fetch_tx", status: "failed", error: "timeout" });
  expect(useJobProgress.getState().byId[8]?.status).toBe("failed");
  expect(screen.getByText("交易抓取失败：timeout")).toBeInTheDocument();
  send({ ...base, job_id: 9, kind: "fetch_tx", status: "failed", error: null });
  expect(screen.getByText("交易抓取失败：未知原因")).toBeInTheDocument();
});

test("writes SSE state, loads status on mount and unsubscribes on unmount", async () => {
  const { unmount } = mount();
  await act(async () => {});
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(useQuota.getState().quota).toEqual({ used: 10, limit: 100, paused: false, reset_at: "2026-10-18T00:00:00Z" });
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
