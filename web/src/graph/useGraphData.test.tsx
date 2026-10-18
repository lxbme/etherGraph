import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { api } from "../api/endpoints";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { qk } from "../api/queryClient";
import { useCanvasMetrics } from "./canvasMetrics";
import { useGraph } from "./store";
import { useGraphData } from "./useGraphData";

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
    { addresses: [A], filter, sort: "recent", limits: { [A]: 59 }, prefer: [] },
    { signal: expect.any(AbortSignal) },
  );
  expect(qc.getQueryData(qk.graph([A], { filter, sort: "recent", limits: { [A]: 59 } }))).toEqual(resp(A));
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

  act(() => useGraph.getState().addCenter(B));
  await waitFor(() => expect(result.current.isFetching).toBe(true));
  expect(result.current.data).toEqual(resp(A));
  act(() => release());
  await waitFor(() => expect(result.current.data).toEqual(resp(B)));

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
    useGraph.getState().addCenter(A);
    useGraph.getState().raiseLimit(C, 3); // a limit of a non-center is never sent
  });
  await waitFor(() => expect(result.current.data?.nodes).toHaveLength(4));
  expect(spy.mock.calls[0]?.[0]).toMatchObject({ limits: { [A]: 59 }, prefer: [] });

  act(() => {
    useGraph.getState().setHidden([D], true);
    useGraph.getState().addCenter(B);
  });
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(spy.mock.calls[1]?.[0]).toMatchObject({ addresses: [A, B], limits: { [A]: 59, [B]: 59 }, prefer: [C] });
});

test("raising a limit refetches; a new prefer set alone does not", async () => {
  const spy = vi.spyOn(api, "graphEdges").mockImplementation(async () => ({
    nodes: [node(A), node(B)], edges: [], omitted: {}, coverage: {},
  }));
  const { result } = renderHook(() => useGraphData(), { wrapper });
  act(() => useGraph.getState().addCenter(A));
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(spy).toHaveBeenCalledTimes(1);
  act(() => useGraph.getState().raiseLimit(A, 10));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(spy.mock.calls[1]?.[0]).toMatchObject({ limits: { [A]: 69 }, prefer: [B] });
  await waitFor(() => expect(result.current.isFetching).toBe(false));
  expect(spy).toHaveBeenCalledTimes(2);
});
