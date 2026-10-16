import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { api } from "../api/endpoints";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { qk } from "../api/queryClient";
import { useGraph } from "./store";
import { useGraphData } from "./useGraphData";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const resp = (addr: string): GraphResponseDto => ({ nodes: [], edges: [], omitted: { [addr]: 1 }, coverage: {} });

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().reset();
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
  expect(spy).toHaveBeenCalledWith({ addresses: [A], filter, sort: "recent" });
  expect(qc.getQueryData(qk.graph([A], { filter, sort: "recent" }))).toEqual(resp(A));
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
