import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MockInstance } from "vitest";
import { api } from "../../api/endpoints";
import type { EdgeDto } from "../../api/generated/EdgeDto";
import type { GraphRequestDto } from "../../api/generated/GraphRequestDto";
import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { useGraph } from "../../graph/store";
import { preferFor } from "../../graph/useGraphData";
import { useExpandEstimate } from "./useExpandEstimate";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const node = (n: number, o: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: addr(n), kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null, ...o,
});
const edge = (from: number, to: number) => ({
  from: addr(from), to: addr(to), asset: null, asset_kind: "native", count: 1, sum: "1", first_ts: "", last_ts: "",
  decimals: 18, symbol: "ETH", trust: "ok",
}) as unknown as EdgeDto;

const C0 = 1;
const T = 2;
const A = 3;
const H = 4;
/** The canvas: center C0 with neighbours T, A and the hidden H. */
const data: GraphResponseDto = {
  nodes: [node(C0), node(T), node(A), node(H)],
  edges: [edge(C0, T), edge(C0, A), edge(C0, H)],
  omitted: {},
  coverage: {},
};

/** Dry-run answer: every center links to A, H and one fresh neighbour (center + 1000); omitted = 7 per center. */
function answer(req: GraphRequestDto): GraphResponseDto {
  const centers = req.addresses.map((a) => parseInt(a, 16));
  return {
    nodes: centers.flatMap((c) => [node(c), node(c + 1000)]).concat([node(A), node(H)]),
    edges: centers.flatMap((c) => [edge(c, A), edge(c, H), edge(c, c + 1000)]),
    omitted: Object.fromEntries(req.addresses.map((a) => [a, 7])),
    coverage: {},
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}


let edges: MockInstance<typeof api.graphEdges>;

beforeEach(() => {
  useGraph.getState().reset();
  useGraph.getState().addCenter(addr(C0));
  useGraph.setState({ ui: { [addr(H)]: { pinned: false, hidden: true, note: "" } } });
  edges = vi.spyOn(api, "graphEdges").mockImplementation(async (req) => answer(req));
});
afterEach(() => vi.restoreAllMocks());

test("one dry run with the targets' limits, the store's filter and sort, and the real query's prefer minus the targets", async () => {
  const targets = [node(T)];
  const { result } = renderHook(() => useExpandEstimate({ targets, k: 7, data }), { wrapper });
  await waitFor(() => expect(result.current.estimate).not.toBeNull());
  expect(edges).toHaveBeenCalledTimes(1);
  const req = edges.mock.calls[0]![0];
  const prefer = preferFor(data).filter((a) => a.toLowerCase() !== addr(T));
  expect(prefer).toEqual([addr(A)]);
  expect(req).toEqual({
    addresses: [addr(T)],
    filter: useGraph.getState().filter,
    sort: useGraph.getState().sort,
    limits: { [addr(T)]: 7 },
    prefer,
    dry_run: true,
  });
  // A is on the canvas, H is hidden (neither), T+1000 is fresh; T itself is already visible.
  expect(result.current.estimate).toMatchObject({ min: 1, max: 1, pendingCount: 0, syncCount: 0 });
  expect(result.current.estimate!.targets[0]).toMatchObject({ address: addr(T), onCanvas: 1, fresh: 1, remaining: 7, total: 10 });
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBeNull();
});

test("60 targets are sent as two dry runs of 50 and 10 centers and merged", async () => {
  const targets = Array.from({ length: 60 }, (_, i) => node(100 + i));
  const { result } = renderHook(() => useExpandEstimate({ targets, k: 5, data }), { wrapper });
  await waitFor(() => expect(result.current.estimate).not.toBeNull());
  expect(edges).toHaveBeenCalledTimes(2);
  const sent = edges.mock.calls.map((c) => c[0]);
  expect(sent.map((r) => r.addresses.length).sort((x, y) => x - y)).toEqual([10, 50]);
  for (const r of sent) {
    expect(r.dry_run).toBe(true);
    expect(Object.keys(r.limits ?? {})).toEqual(r.addresses);
    expect(Object.values(r.limits ?? {}).every((k) => k === 5)).toBe(true);
  }
  const est = result.current.estimate!;
  expect(est.targets).toHaveLength(60);
  expect(est.targets.every((t) => t.fresh === 1 && t.onCanvas === 1 && t.remaining === 7)).toBe(true);
  // 60 fresh neighbours plus the 60 targets themselves, none of them on the canvas.
  expect(est.min).toBe(120);
});

test("changes of k within 250 ms send a single dry run with the last value", async () => {
  const targets = [node(T)];
  const { result, rerender } = renderHook(({ k }) => useExpandEstimate({ targets, k, data }), {
    wrapper,
    initialProps: { k: 7 },
  });
  await waitFor(() => expect(result.current.estimate).not.toBeNull());
  expect(edges).toHaveBeenCalledTimes(1);
  rerender({ k: 8 });
  expect(result.current.loading).toBe(true);
  rerender({ k: 9 });
  await new Promise((r) => setTimeout(r, 150));
  expect(edges).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(edges).toHaveBeenCalledTimes(2);
  expect(edges.mock.calls[1]![0].limits).toEqual({ [addr(T)]: 9 });
});

test("a frozen (snapshot) graph sends no dry run", async () => {
  useGraph.setState({ frozen: { data } as never });
  const { result } = renderHook(() => useExpandEstimate({ targets: [node(T)], k: 7, data }), { wrapper });
  await new Promise((r) => setTimeout(r, 300));
  expect(edges).not.toHaveBeenCalled();
  expect(result.current.estimate).toBeNull();
  expect(result.current.loading).toBe(true);
});
