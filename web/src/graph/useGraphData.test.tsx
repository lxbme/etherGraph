import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { api } from "../api/endpoints";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { qk } from "../api/queryClient";
import { useCanvasMetrics } from "./canvasMetrics";
import { useGraph } from "./store";
import { graphQueryKey, useGraphData } from "./useGraphData";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const D = "0x" + "dd".repeat(20);
const resp = (addr: string): GraphResponseDto => ({ nodes: [], edges: [], omitted: { [addr]: 1 }, coverage: {} });

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().reset();
  useCanvasMetrics.getState().set({ width: 960, height: 576, visible: 0 });
});
afterEach(() => vi.restoreAllMocks());

test("graph query uses centers, filter and sort and skips when no centers", async () => {
  const spy = vi.spyOn(api, "graphEdges").mockImplementation(async (req) => resp(req.addresses[0]!));
  const { result } = renderHook(() => useGraphData(), { wrapper });
  expect(spy).not.toHaveBeenCalled();
  expect(result.current.data).toBeUndefined();

  const filter = { kinds: ["erc20" as const] };
  act(() => {
    useGraph.getState().setFilter(filter);
    useGraph.getState().setSort("recent");
    useGraph.getState().addCenter(A);
  });
  await waitFor(() => expect(result.current.data).toEqual(resp(A)));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith(
    { addresses: [A], filter, sort: "recent", limits: {}, picks: { [A]: [] }, prefer: [] },
    { signal: expect.any(AbortSignal) },
  );
  expect(qc.getQueryData(qk.graph([A], { filter, sort: "recent", limits: {}, picks: { [A]: [] } }))).toEqual(resp(A));
});

test("keeps the previous data while a new key loads, and drops it when centers empty", async () => {
  let release!: () => void;
  vi.spyOn(api, "graphEdges").mockImplementation((req) =>
    req.addresses.length === 1
      ? Promise.resolve(resp(A))
      : new Promise((r) => { release = () => r(resp(B)); }),
  );
  const { result } = renderHook(() => useGraphData(), { wrapper });
  act(() => useGraph.getState().addCenter(A));
  await waitFor(() => expect(result.current.data).toEqual(resp(A)));
  expect(result.current.isPlaceholderData).toBe(false);

  act(() => useGraph.getState().addCenter(B));
  await waitFor(() => expect(result.current.isFetching).toBe(true));
  expect(result.current.data).toEqual(resp(A));
  // The previous key's result stands in until the new one arrives.
  expect(result.current.isPlaceholderData).toBe(true);
  act(() => release());
  await waitFor(() => expect(result.current.data).toEqual(resp(B)));
  expect(result.current.isPlaceholderData).toBe(false);

  act(() => useGraph.getState().setCenters([]));
  expect(result.current.data).toBeUndefined();
});

test("exposes the request error", async () => {
  const err = new Error("boom");
  vi.spyOn(api, "graphEdges").mockRejectedValue(err);
  const { result } = renderHook(() => useGraphData(), { wrapper });
  act(() => useGraph.getState().addCenter(A));
  await waitFor(() => expect(result.current.error).toBe(err));
});

test("a cancelled graph query aborts its HTTP request", async () => {
  let signal: AbortSignal | undefined;
  vi.spyOn(api, "graphEdges").mockImplementation((_req, opts) => {
    signal = opts?.signal;
    return new Promise(() => {});
  });
  renderHook(() => useGraphData(), { wrapper });
  act(() => useGraph.getState().addCenter(A));
  await waitFor(() => expect(signal).toBeDefined());
  await act(() => qc.cancelQueries({ queryKey: ["graph"] }));
  expect(signal!.aborted).toBe(true);
});

const node = (address: string) => ({
  address, kind: "eoa" as const, display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null,
});

test("sends center limits and prefers the visible non-center nodes of the shown result", async () => {
  const spy = vi.spyOn(api, "graphEdges").mockImplementation(async (req) =>
    req.addresses.length === 1
      ? { nodes: [node(A), node(B), node(C), node(D)], edges: [], omitted: {}, coverage: {} }
      : resp(B),
  );
  const { result } = renderHook(() => useGraphData(), { wrapper });
  act(() => {
    useGraph.getState().loadSnapshot({ centers: [A], filter: {}, expandedPairs: [], ui: {}, limits: { [A]: 59 } });
    useGraph.setState((s) => ({ limits: { ...s.limits, [C]: 3 } })); // a limit of a non-center is never sent
  });
  await waitFor(() => expect(result.current.data?.nodes).toHaveLength(4));
  expect(spy.mock.calls[0]?.[0]).toMatchObject({ limits: { [A]: 59 }, picks: {}, prefer: [] });

  act(() => {
    useGraph.getState().setHidden([D], true);
    useGraph.getState().addCenter(B);
  });
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(spy.mock.calls[1]?.[0]).toMatchObject({ addresses: [A, B], limits: { [A]: 59 }, picks: { [B]: [] }, prefer: [C] });
});

test("a changed limit refetches; a new prefer set alone does not", async () => {
  const spy = vi.spyOn(api, "graphEdges").mockImplementation(async () => ({
    nodes: [node(A), node(B)], edges: [], omitted: {}, coverage: {},
  }));
  const { result } = renderHook(() => useGraphData(), { wrapper });
  act(() => useGraph.getState().loadSnapshot({ centers: [A], filter: {}, expandedPairs: [], ui: {}, limits: { [A]: 59 } }));
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(spy).toHaveBeenCalledTimes(1);
  act(() => useGraph.setState({ limits: { [A]: 69 } }));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(spy.mock.calls[1]?.[0]).toMatchObject({ limits: { [A]: 69 }, prefer: [B] });
  await waitFor(() => expect(result.current.isFetching).toBe(false));
  expect(spy).toHaveBeenCalledTimes(2);
});

describe("a frozen (snapshot) graph", () => {
  const fileLabel = { id: -1, text: "sender's note", category: "other", source: "file" };
  const snap = {
    exported_at: "2026-10-01T12:00:00Z",
    includes: { labels: true, notes: false },
    data: {
      nodes: [node(A), { ...node(B), kind: "unknown" as const, labels: [fileLabel] }],
      edges: [],
      omitted: {},
      coverage: {},
    },
  };

  test("shows the file's data with no graph request, and live identities over it", async () => {
    const edges = vi.spyOn(api, "graphEdges").mockResolvedValue(resp(A));
    const nodes = vi.spyOn(api, "nodes").mockImplementation(async (addrs) =>
      addrs.map((a) => (a === B ? { ...node(B), kind: "contract" as const, contract_name: "Pool", display_name: "Pool" } : { ...node(a), kind: "unknown" as const, synced: false })),
    );
    act(() => {
      useGraph.getState().setCenters([A]);
      useGraph.getState().freeze(snap);
    });
    const { result } = renderHook(() => useGraphData(), { wrapper });
    expect(result.current.data?.nodes.map((n) => n.address)).toEqual([A, B]);
    await waitFor(() => expect(result.current.data?.nodes[1]?.kind).toBe("contract"));
    const b = result.current.data!.nodes[1]!;
    expect(b.display_name).toBe("Pool");
    expect(b.labels).toEqual([fileLabel]);
    // A has no live identity: the file node stays.
    expect(result.current.data!.nodes[0]).toEqual(node(A));
    expect(nodes).toHaveBeenCalledWith([A, B]);
    expect(edges).not.toHaveBeenCalled();
    expect(result.current.isFetching).toBe(false);
    expect(result.current.isPlaceholderData).toBe(false);
  });

  test("refresh (unfreeze) runs the normal graph query", async () => {
    const edges = vi.spyOn(api, "graphEdges").mockResolvedValue(resp(A));
    vi.spyOn(api, "nodes").mockResolvedValue([]);
    act(() => {
      useGraph.getState().setCenters([A]);
      useGraph.getState().freeze(snap);
    });
    const { result } = renderHook(() => useGraphData(), { wrapper });
    expect(edges).not.toHaveBeenCalled();
    act(() => useGraph.getState().unfreeze());
    await waitFor(() => expect(result.current.data).toEqual(resp(A)));
    expect(edges).toHaveBeenCalledTimes(1);
  });
});

describe("picked centers", () => {
  const load = (picks: Record<string, string[]>) =>
    useGraph.getState().loadSnapshot({
      centers: [A, B], filter: {}, expandedPairs: [], ui: {}, limits: { [A]: 5, [B]: 9 }, picks,
    });

  test("request_sends_picks_of_picked_centers_only", async () => {
    const spy = vi.spyOn(api, "graphEdges").mockResolvedValue(resp(A));
    act(() => load({ [B]: [C], [D]: [A] }));
    const { result } = renderHook(() => useGraphData(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    // A keeps its top-k limit; B's limit is moot once picked; D is not a center.
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ addresses: [A, B], limits: { [A]: 5 }, picks: { [B]: [C] } });
  });

  test("picks_change_refetches", async () => {
    const spy = vi.spyOn(api, "graphEdges").mockResolvedValue(resp(A));
    act(() => load({ [B]: [C] }));
    const before = graphQueryKey(useGraph.getState());
    const { result } = renderHook(() => useGraphData(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => useGraph.getState().applyPicks({ [B]: [C, D] }));
    expect(graphQueryKey(useGraph.getState())).not.toEqual(before);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ picks: { [B]: [C, D] } });
  });

  test("filter_change_keeps_picks", async () => {
    const spy = vi.spyOn(api, "graphEdges").mockResolvedValue(resp(A));
    act(() => load({ [B]: [C] }));
    const { result } = renderHook(() => useGraphData(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => useGraph.getState().applyFilter({ direction: "in" }, "recent"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ filter: { direction: "in" }, sort: "recent", picks: { [B]: [C] } });
  });
});
