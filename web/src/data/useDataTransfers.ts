import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/endpoints";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import type { PairDto } from "../api/generated/PairDto";
import type { TransferDto } from "../api/generated/TransferDto";
import { qk } from "../api/queryClient";
import { useGraph, type NodeUi } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";

/** Rows the Data tab loads before it stops and offers more; each "load more" raises the cap by as many again. */
export const DATA_ROW_CAP = 20_000;
/** Rows per request (the server's most). */
const PAGE_LIMIT = 1000;
/** Pairs per request (the server's most). */
const MAX_PAIRS = 5000;

/** Where a page starts: a chunk of the pairs, and the cursor inside it (absent: its first page). */
type PageParam = { chunk: number; cursor?: string };

const NO_ROWS: TransferDto[] = [];
const lc = (s: string) => s.toLowerCase();
const pairId = (p: PairDto) => `${p.from}>${p.to}|${p.asset ?? "eth"}`;

/**
 * The (from, to, asset) of each raw edge whose ends are both visible (not hidden nodes), lowercased, deduplicated
 * and sorted (the query key does not change with the server's edge order). Raw edges, not the canvas's: an edge whose
 * transfers are all hidden still lists them, so they can be unhidden.
 */
export function dataPairs(edges: EdgeDto[], ui: Record<string, NodeUi>): PairDto[] {
  const out = new Map<string, PairDto>();
  for (const e of edges) {
    const p = { from: lc(e.from), to: lc(e.to), asset: e.asset === null ? null : lc(e.asset) };
    if (ui[p.from]?.hidden || ui[p.to]?.hidden) continue;
    out.set(pairId(p), p);
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, p]) => p);
}

/** `pairs` in chunks of at most MAX_PAIRS (one request each). */
function chunked(pairs: PairDto[]): PairDto[][] {
  const out: PairDto[][] = [];
  for (let i = 0; i < pairs.length; i += MAX_PAIRS) out.push(pairs.slice(i, i + MAX_PAIRS));
  return out;
}

/**
 * Every transfer behind the canvas edges, for the Data tab: the pairs of `dataPairs` under the store's global
 * filter, newest first within each chunk of pairs. Pages through `POST /api/transfers/batch` on its own until done or
 * until the rows reach the cap (`capped`); `loadMore()` raises the cap by DATA_ROW_CAP, or after a failed request
 * tries it again. A new graph (pairs) or filter loads afresh with the first cap. Idle while the graph is a snapshot.
 */
export function useDataTransfers(): {
  rows: TransferDto[];
  loading: boolean;
  done: boolean;
  capped: boolean;
  loadMore(): void;
  error: unknown;
} {
  const { data } = useGraphData();
  const ui = useGraph((s) => s.ui);
  const filter = useGraph((s) => s.filter);
  const frozen = useGraph((s) => s.frozen !== null);
  const edges = data?.edges;
  // The same pairs keep the same array (a node drag changes `ui` but not the pairs), so the cap below survives it.
  const stable = useRef<{ id: string; pairs: PairDto[] }>({ id: "", pairs: [] });
  const pairs = useMemo(() => {
    const next = dataPairs(edges ?? [], ui);
    const id = next.map(pairId).join(",");
    if (id !== stable.current.id) stable.current = { id, pairs: next };
    return stable.current.pairs;
  }, [edges, ui]);
  const chunks = useMemo(() => chunked(pairs), [pairs]);
  const enabled = !frozen && pairs.length > 0;

  const q = useInfiniteQuery({
    queryKey: qk.transfersBatch(pairs, filter),
    queryFn: ({ pageParam, signal }) =>
      api.transfersBatch(
        { pairs: chunks[pageParam.chunk]!, filter, limit: PAGE_LIMIT, ...(pageParam.cursor ? { cursor: pageParam.cursor } : {}) },
        { signal },
      ),
    initialPageParam: { chunk: 0 } as PageParam,
    // The rest of this chunk, then the next chunk from its start.
    getNextPageParam: (last, _all, param): PageParam | undefined =>
      last.next_cursor ? { chunk: param.chunk, cursor: last.next_cursor } : param.chunk + 1 < chunks.length ? { chunk: param.chunk + 1 } : undefined,
    enabled,
  });
  const rows = useMemo(() => (enabled ? (q.data?.pages.flatMap((p) => p.items) ?? NO_ROWS) : NO_ROWS), [enabled, q.data]);

  // The cap raised by "load more", for these pairs and this filter only.
  const [raised, setRaised] = useState<{ pairs: PairDto[]; filter: EdgeFilterDto; cap: number } | null>(null);
  const cap = raised && raised.pairs === pairs && raised.filter === filter ? raised.cap : DATA_ROW_CAP;

  const { hasNextPage, isFetching, isError, fetchNextPage, refetch } = q;
  const more = enabled && hasNextPage && !isError;
  useEffect(() => {
    if (more && !isFetching && rows.length < cap) void fetchNextPage();
  }, [more, isFetching, rows.length, cap, fetchNextPage]);

  const hasData = q.data !== undefined;
  const loadMore = useCallback(() => {
    if (isError) void (hasData ? fetchNextPage() : refetch());
    else setRaised({ pairs, filter, cap: cap + DATA_ROW_CAP });
  }, [isError, hasData, fetchNextPage, refetch, pairs, filter, cap]);

  // Nothing to load: done once the graph has answered with no edges; never for a snapshot.
  if (!enabled) return { rows: NO_ROWS, loading: false, done: !frozen && data !== undefined, capped: false, loadMore, error: null };
  return {
    rows,
    loading: !isError && (q.isPending || isFetching || (hasNextPage && rows.length < cap)),
    done: q.isSuccess && !hasNextPage && !isFetching,
    capped: hasNextPage && rows.length >= cap,
    loadMore,
    error: q.error ?? null,
  };
}
