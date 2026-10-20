import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { api } from "../api/endpoints";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { TransferBatchRequestDto } from "../api/generated/TransferBatchRequestDto";
import type { TransferDto } from "../api/generated/TransferDto";
import type { TransferPageDto } from "../api/generated/TransferPageDto";
import { useCanvasMetrics } from "../graph/canvasMetrics";
import { hiddenFromTransfer } from "../graph/hiddenTransfers";
import { useGraph } from "../graph/store";
import { DATA_ROW_CAP, useDataTransfers } from "./useDataTransfers";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const D = "0x" + "dd".repeat(20);
const USDC = "0x" + "0c".repeat(20);

const edge = (from: string, to: string, asset: string | null = null, count = 1): EdgeDto => ({
  from, to, asset, asset_kind: asset === null ? "native" : "erc20", count, sum: `${count}`,
  first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-02T00:00:00Z", decimals: asset === null ? 18 : 6, symbol: null,
  trust: { level: "listed", impersonates: null, reason: null },
});
const transfer = (i: number, over: Partial<TransferDto> = {}): TransferDto => ({
  tx_hash: "0x" + i.toString(16).padStart(64, "0"), sub_id: "0", kind: "native", block_number: 1,
  ts: "2024-01-01T00:00:00Z", from: A, to: B, asset: null, amount: "1", token_id: null, decimals: 18, symbol: null,
  trust: { level: "listed", impersonates: null, reason: null }, ...over,
});
/** `n` transfers numbered from `start`. */
const items = (start: number, n: number) => Array.from({ length: n }, (_, i) => transfer(start + i));

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

/** The canvas shows `edges` around A. */
function graphOf(edges: EdgeDto[]) {
  vi.spyOn(api, "graphEdges").mockResolvedValue({ nodes: [], edges, omitted: {}, coverage: {} });
  act(() => useGraph.getState().addCenter(A));
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().reset();
  useCanvasMetrics.getState().set({ width: 960, height: 576, visible: 0 });
});
afterEach(() => vi.restoreAllMocks());

test("pages until done", async () => {
  const pages: Record<string, TransferPageDto> = {
    start: { items: items(0, 1000), next_cursor: "c1" },
    c1: { items: items(1000, 1000), next_cursor: "c2" },
    c2: { items: items(2000, 10), next_cursor: null },
  };
  const batch = vi.spyOn(api, "transfersBatch").mockImplementation(async (req) => pages[req.cursor ?? "start"]!);
  const { result } = renderHook(() => useDataTransfers(), { wrapper });
  graphOf([edge(A, B)]);
  await waitFor(() => expect(result.current.done).toBe(true));
  expect(result.current.rows).toHaveLength(2010);
  expect(result.current).toMatchObject({ loading: false, capped: false, error: null });
  expect(batch.mock.calls.map(([req]) => [req.cursor ?? null, req.limit])).toEqual([[null, 1000], ["c1", 1000], ["c2", 1000]]);
});

test("stops at the cap and loadMore continues", async () => {
  // 25,000 transfers in pages of 1,000: past one cap, short of two.
  const total = 25_000;
  const batch = vi.spyOn(api, "transfersBatch").mockImplementation(async (req) => {
    const from = Number(req.cursor ?? 0);
    const next = from + req.limit!;
    return { items: items(from, req.limit!), next_cursor: next < total ? String(next) : null };
  });
  const { result } = renderHook(() => useDataTransfers(), { wrapper });
  graphOf([edge(A, B)]);
  await waitFor(() => expect(result.current.capped).toBe(true));
  expect(result.current.rows).toHaveLength(DATA_ROW_CAP);
  expect(result.current).toMatchObject({ loading: false, done: false });
  // It stays stopped.
  await new Promise((r) => setTimeout(r, 20));
  expect(batch).toHaveBeenCalledTimes(20);

  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.done).toBe(true));
  expect(result.current.rows).toHaveLength(total);
  expect(result.current.capped).toBe(false);
  expect(batch).toHaveBeenCalledTimes(25);
});

test("uses raw edges of visible endpoints and the global filter", async () => {
  const batch = vi.spyOn(api, "transfersBatch").mockResolvedValue({ items: [], next_cursor: null });
  const filter = { kinds: ["native" as const, "erc20" as const] };
  act(() => {
    useGraph.getState().setFilter(filter);
    useGraph.getState().setHidden([D], true);
    // A→C's only transfer is hidden: the canvas drops the edge, the Data tab still lists it (to unhide it).
    useGraph.getState().setTransfersHidden([hiddenFromTransfer(transfer(9, { to: C }))], true);
  });
  const { result } = renderHook(() => useDataTransfers(), { wrapper });
  graphOf([edge(A, B), edge(B, A, USDC, 2), edge(A, C), edge(D, A, null, 4)]);
  await waitFor(() => expect(result.current.done).toBe(true));
  expect(batch).toHaveBeenCalledTimes(1);
  const req: TransferBatchRequestDto = batch.mock.calls[0]![0];
  expect(req.filter).toEqual(filter);
  expect(new Set(req.pairs.map((p) => `${p.from}>${p.to}|${p.asset}`))).toEqual(
    new Set([`${A}>${B}|null`, `${B}>${A}|${USDC}`, `${A}>${C}|null`]),
  );

  // A changed graph (here the filter) loads again.
  act(() => useGraph.getState().setFilter({}));
  await waitFor(() => expect(batch).toHaveBeenCalledTimes(2));
  expect(batch.mock.calls[1]![0].filter).toEqual({});
});

test("chunks the pairs into requests of at most 5000", async () => {
  const batch = vi.spyOn(api, "transfersBatch").mockImplementation(async (req) => ({ items: [transfer(req.pairs.length)], next_cursor: null }));
  const many = Array.from({ length: 6000 }, (_, i) => edge(A, "0x" + i.toString(16).padStart(40, "0")));
  const { result } = renderHook(() => useDataTransfers(), { wrapper });
  graphOf(many);
  await waitFor(() => expect(result.current.done).toBe(true));
  expect(batch.mock.calls.map(([req]) => req.pairs.length)).toEqual([5000, 1000]);
  expect(result.current.rows).toHaveLength(2);
});

test("is idle while frozen", async () => {
  const batch = vi.spyOn(api, "transfersBatch");
  vi.spyOn(api, "nodes").mockResolvedValue([]);
  act(() => {
    useGraph.getState().setCenters([A]);
    useGraph.getState().freeze({
      exported_at: "2026-10-01T12:00:00Z",
      includes: { labels: false, notes: false },
      data: { nodes: [], edges: [edge(A, B)], omitted: {}, coverage: {} },
    });
  });
  const { result } = renderHook(() => useDataTransfers(), { wrapper });
  await new Promise((r) => setTimeout(r, 20));
  expect(batch).not.toHaveBeenCalled();
  expect(result.current).toMatchObject({ rows: [], loading: false, capped: false });
});
