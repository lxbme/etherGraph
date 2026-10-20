import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MockInstance } from "vitest";
import { api } from "../../api/endpoints";
import type { CounterpartyPageDto } from "../../api/generated/CounterpartyPageDto";
import type { EdgeDto } from "../../api/generated/EdgeDto";
import type { GraphRequestDto } from "../../api/generated/GraphRequestDto";
import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { SyncStatusDto } from "../../api/generated/SyncStatusDto";
import { firstBatchFor, useGraph } from "../../graph/store";
import { preferFor } from "../../graph/useGraphData";
import { usePickData } from "./usePickData";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const node = (n: number, o: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: addr(n), kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null, ...o,
});
const edge = (from: number, to: number, count = 1): EdgeDto => ({
  from: addr(from), to: addr(to), asset: null, asset_kind: "native", count, sum: "1",
  first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-01T00:00:00Z", decimals: 18, symbol: "ETH",
  trust: { level: "listed", impersonates: null, reason: null },
});
const cov = (at: string | null): SyncStatusDto => ({
  kind: "native", from_block: null, to_block: null, truncated: false, state: "ok", last_synced_at: at, oldest_ts: null,
});

const C0 = 1;
/** Another center whose own neighbour X is also a neighbour of C0. */
const C9 = 9;
const X = 50;
/** C0's neighbours in rank order (busiest first). */
const RANKED = [X, 101, 102, 103, 104];

/** The canvas: centers C0 and C9, C9's neighbour X (also linked to C0). */
let canvas: GraphResponseDto;
/** Neighbours the server omits per center in the 1000-limit run. */
let omitted: number;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/**
 * Each center's neighbours: RANKED for C0 (counts by rank), one fresh neighbour (center + 1000) for others. Like the
 * server: preferred neighbours rank first and are always shown, then the top `limit` of the rest.
 */
function dryRun(req: GraphRequestDto): GraphResponseDto {
  const edges: EdgeDto[] = [];
  const nodes: NodeSummaryDto[] = [];
  for (const a of req.addresses) {
    const c = parseInt(a, 16);
    const limit = req.limits?.[a] ?? 200;
    const all = c === C0 ? RANKED : [c + 1000];
    const pref = new Set(req.prefer ?? []);
    const ordered = [...all.filter((n) => pref.has(addr(n))), ...all.filter((n) => !pref.has(addr(n)))];
    const shown = ordered.filter((n, i) => i < limit || pref.has(addr(n)));
    nodes.push(node(c), ...shown.map((n) => node(n)));
    edges.push(...shown.map((n) => edge(c, n, 100 - all.indexOf(n))));
  }
  return {
    nodes,
    edges,
    omitted: limitsAre(req, 1000) && omitted > 0 ? Object.fromEntries(req.addresses.map((a) => [a, omitted])) : {},
    coverage: Object.fromEntries(
      req.addresses.map((a) => [a, [cov("2024-01-01T00:00:00Z"), cov("2024-03-01T00:00:00Z"), cov(null)]]),
    ),
  };
}
const limitsAre = (req: GraphRequestDto, k: number) => Object.values(req.limits ?? {}).every((v) => v === k);

let edges: MockInstance<typeof api.graphEdges>;
let counterparties: MockInstance<typeof api.counterparties>;
let total: number;
const dryRuns = () => edges.mock.calls.map((c) => c[0]).filter((r) => r.dry_run);

beforeEach(() => {
  useGraph.getState().reset();
  omitted = 0;
  total = 0;
  canvas = {
    nodes: [node(C0), node(C9), node(X)],
    edges: [edge(C9, X), edge(C0, X)],
    omitted: {},
    coverage: {},
  };
  edges = vi.spyOn(api, "graphEdges").mockImplementation(async (req) => (req.dry_run ? dryRun(req) : canvas));
  counterparties = vi
    .spyOn(api, "counterparties")
    .mockImplementation(async () => ({ items: [], total }) satisfies CounterpartyPageDto);
});
afterEach(() => vi.restoreAllMocks());

/** C0 a top-k center (limit 5), C9 picked with X. */
function topKCanvas() {
  useGraph.getState().loadSnapshot({
    centers: [addr(C0), addr(C9)],
    filter: {},
    expandedPairs: [],
    ui: {},
    limits: { [addr(C0)]: 5 },
    picks: { [addr(C9)]: [addr(X)] },
  });
}

test("the list is one 1000-limit dry run with the store's filter and sort and the canvas prefer, without picks", async () => {
  topKCanvas();
  useGraph.setState({ filter: { hide_suspicious: true }, sort: "recent" });
  const { result } = renderHook(() => usePickData([addr(C0)]), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  const list = dryRuns().filter((r) => limitsAre(r, 1000));
  expect(list).toHaveLength(1);
  expect(list[0]).toEqual({
    addresses: [addr(C0)],
    filter: { hide_suspicious: true },
    sort: "recent",
    limits: { [addr(C0)]: 1000 },
    prefer: preferFor(canvas),
    dry_run: true,
  });
  expect(preferFor(canvas)).toEqual([addr(X)]);
  const g = result.current.groups[0]!;
  expect(g).toMatchObject({ center: addr(C0), synced: true, syncing: false, listedCap: false });
  expect(g.summary?.address).toBe(addr(C0));
  // The list follows the graph sort ("recent": all equal here, so address ascending).
  expect(g.rows.map((r) => r.address)).toEqual(RANKED.map(addr));
  // X is on the canvas and C0, a top-k center, owns its canvas neighbours (X is one) → unlocked.
  expect(g.rows[0]).toMatchObject({ address: addr(X), onCanvas: true, locked: false });
  expect(result.current.error).toBeNull();
});

test("defaults_equal_the_top_k_dry_run", async () => {
  topKCanvas();
  const { result } = renderHook(() => usePickData([addr(C0)]), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  const k = firstBatchFor(1);
  expect(result.current.k).toBe(k);
  const top = dryRuns().filter((r) => limitsAre(r, k));
  expect(top).toHaveLength(1);
  expect(top[0]!.limits).toEqual({ [addr(C0)]: k });
  expect(top[0]!.picks).toBeUndefined();
  expect(top[0]!.prefer).toEqual([addr(X)]);
  expect(result.current.groups[0]!.defaults).toEqual(RANKED.slice(0, k).map(addr));

  act(() => result.current.setK(2));
  expect(result.current.k).toBe(2);
  await waitFor(() => expect(result.current.groups[0]!.defaults).toEqual([addr(X), addr(101)]));
  expect(result.current.loading).toBe(false);
  expect(dryRuns().filter((r) => limitsAre(r, 2))).toHaveLength(1);
  // The list itself is not fetched again.
  expect(dryRuns().filter((r) => limitsAre(r, 1000))).toHaveLength(1);
});

test("a preferred neighbour ranked low by count still heads the list, and the first k rows are the defaults", async () => {
  topKCanvas();
  const LOW = 104;
  // 104 is the least busy of C0's neighbours but on the canvas (C9's neighbour): prefer ranks it first.
  canvas = {
    nodes: [node(C0), node(C9), node(LOW)],
    edges: [edge(C9, LOW)],
    omitted: {},
    coverage: {},
  };
  const { result } = renderHook(() => usePickData([addr(C0)]), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(dryRuns()[0]!.prefer).toEqual([addr(LOW)]);
  act(() => result.current.setK(2));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const g = result.current.groups[0]!;
  expect(g.rows.map((r) => r.address)).toEqual([LOW, X, 101, 102, 103].map(addr));
  expect(g.rows[0]).toMatchObject({ onCanvas: true, locked: true });
  expect([...g.defaults].sort()).toEqual(g.rows.slice(0, 2).map((r) => r.address).sort());
});

test("a new center (picked with none) defaults to the top k as well", async () => {
  useGraph.getState().addCenter(addr(C0));
  expect(useGraph.getState().picks[addr(C0)]).toEqual([]);
  canvas = { nodes: [node(C0)], edges: [], omitted: {}, coverage: {} };
  const { result } = renderHook(() => usePickData([addr(C0)]), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setK(3));
  await waitFor(() => expect(result.current.groups[0]!.defaults).toEqual([addr(X), addr(101), addr(102)]));
});

test("picked_center_defaults_to_its_picks", async () => {
  useGraph.getState().loadSnapshot({
    centers: [addr(C0), addr(C9)],
    filter: {},
    expandedPairs: [],
    ui: {},
    picks: { [addr(C0)]: [addr(102)], [addr(C9)]: [addr(X)] },
  });
  canvas = {
    nodes: [node(C0), node(C9), node(X), node(102)],
    edges: [edge(C9, X), edge(C0, X), edge(C0, 102)],
    omitted: {},
    coverage: {},
  };
  const { result } = renderHook(() => usePickData([addr(C0)]), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  const g = result.current.groups[0]!;
  // X is on the canvas because of C9: locked, and checked by default with the picks.
  expect(g.rows.find((r) => r.address === addr(X))).toMatchObject({ onCanvas: true, locked: true });
  expect(g.rows.find((r) => r.address === addr(102))).toMatchObject({ onCanvas: true, locked: false });
  expect([...g.defaults].sort()).toEqual([addr(X), addr(102)].sort());
  // No top-k dry run for a picked center.
  expect(dryRuns().every((r) => limitsAre(r, 1000))).toBe(true);
});

test("hidden_by_filter_count", async () => {
  topKCanvas();
  omitted = 3;
  total = 20;
  const { result } = renderHook(() => usePickData([addr(C0)]), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(counterparties).toHaveBeenCalledWith(addr(C0), { limit: 1, kind: "all" });
  const g = result.current.groups[0]!;
  // 20 counterparties − (5 listed + 3 omitted).
  expect(g).toMatchObject({ listedCap: true, hiddenByFilter: 12, lastSynced: "2024-03-01T00:00:00Z" });
});

test("hidden by filter is never negative", async () => {
  topKCanvas();
  total = 2;
  const { result } = renderHook(() => usePickData([addr(C0)]), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.groups[0]).toMatchObject({ listedCap: false, hiddenByFilter: 0 });
});

test("unsynced_target_makes_no_requests", async () => {
  topKCanvas();
  const T = 7;
  canvas = { ...canvas, nodes: [...canvas.nodes, node(T, { synced: false, syncing: true })] };
  const { result } = renderHook(() => usePickData([addr(T)]), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.groups).toEqual([
    {
      center: addr(T),
      summary: canvas.nodes[3],
      known: true,
      synced: false,
      syncing: true,
      coverage: [],
      lastSynced: null,
      rows: [],
      defaults: [],
      listedCap: false,
      hiddenByFilter: 0,
    },
  ]);
  await new Promise((r) => setTimeout(r, 300));
  expect(dryRuns()).toHaveLength(0);
  expect(counterparties).not.toHaveBeenCalled();
});

test("60 synced targets are listed in two dry runs of 50 and 10 centers, one group each in order", async () => {
  topKCanvas();
  const many = Array.from({ length: 60 }, (_, i) => 200 + i);
  canvas = { ...canvas, nodes: [...canvas.nodes, ...many.map((n) => node(n))] };
  const { result } = renderHook(() => usePickData(many.map(addr)), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  const list = dryRuns().filter((r) => limitsAre(r, 1000));
  expect(list.map((r) => r.addresses.length).sort((a, b) => a - b)).toEqual([10, 50]);
  const groups = result.current.groups;
  expect(groups.map((g) => g.center)).toEqual(many.map(addr));
  // The other targets are centers to be: never rows of each other.
  expect(groups.every((g) => g.rows.length === 1 && g.rows[0]!.address === addr(parseInt(g.center, 16) + 1000))).toBe(true);
  expect(groups.every((g) => g.defaults.length === 1)).toBe(true);
});

test("a target the canvas does not show yet, or shows only in a previous request's result, is loading — not unsynced", async () => {
  useGraph.getState().loadSnapshot({ centers: [addr(C9)], filter: {}, expandedPairs: [], ui: {}, picks: { [addr(C9)]: [addr(X)] } });
  canvas = { nodes: [node(C9), node(X)], edges: [edge(C9, X)], omitted: {}, coverage: {} };
  const { result } = renderHook(() => usePickData([addr(C0)]), { wrapper });
  // The canvas answered without C0: nothing is known about it.
  await waitFor(() => expect(edges).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50));
  expect(result.current.loading).toBe(true);
  expect(result.current.groups[0]).toMatchObject({ center: addr(C0), known: false, synced: false, rows: [] });
  // C0 becomes a center: the canvas request with it answers only when released; the previous result stands in.
  let release!: () => void;
  edges.mockImplementation(async (req) => {
    if (req.dry_run) return dryRun(req);
    if (!req.addresses.includes(addr(C0))) return canvas;
    await new Promise<void>((r) => (release = r));
    return canvas;
  });
  act(() => useGraph.getState().revealCenter(addr(C0)));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  // The stand-in result lacks C0: still loading, and no dry run for a target not known to be synced.
  expect(result.current.loading).toBe(true);
  expect(result.current.groups[0]).toMatchObject({ known: false, synced: false });
  expect(dryRuns()).toHaveLength(0);
  canvas = { ...canvas, nodes: [...canvas.nodes, node(C0)] };
  await act(async () => release());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.groups[0]).toMatchObject({ known: true, synced: true });
  expect(result.current.groups[0]!.rows.map((r) => r.address)).toEqual(RANKED.map(addr));
});
