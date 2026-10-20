import { useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { qk } from "../api/queryClient";
import { overlayNodes, useLiveIdentities } from "../workspace/snapshot";
import { useAssetRegistry } from "./assetRegistry";
import { subtractHidden } from "./hiddenTransfers";
import { useGraph, type GraphState } from "./store";

/** Most `prefer` addresses the server accepts. */
const MAX_PREFER = 2000;

type Neighbours = Pick<GraphState, "centers" | "limits" | "picks">;

/** The limits of the top-k centers only (the server rejects keys that are not centers; a picked center ignores its limit). */
function centerLimits(s: Neighbours): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of s.centers) {
    const n = s.limits[c];
    if (n !== undefined && s.picks[c] === undefined) out[c] = n;
  }
  return out;
}

/** The picks of the picked centers only (the server rejects keys that are not centers). */
function centerPicks(s: Pick<GraphState, "centers" | "picks">): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of s.centers) {
    const l = s.picks[c];
    if (l !== undefined) out[c] = l;
  }
  return out;
}

/**
 * The query key of the graph for the given store state (shared with the SSE invalidation logic).
 * Center limits and picks are part of it (changing one refetches); `prefer` is not, or every new node would refetch.
 */
export function graphQueryKey(s: Pick<GraphState, "centers" | "filter" | "sort" | "limits" | "picks">) {
  return qk.graph(s.centers, { filter: s.filter, sort: s.sort, limits: centerLimits(s), picks: centerPicks(s) });
}

/** Visible non-center nodes of the shown result, ranked ahead by the server when a limit applies. */
export function preferFor(shown: GraphResponseDto | undefined): string[] {
  if (!shown) return [];
  const { centers, ui } = useGraph.getState();
  const skip = new Set(centers);
  return shown.nodes
    .map((n) => n.address)
    .filter((a) => !skip.has(a) && !ui[a]?.hidden)
    .slice(0, MAX_PREFER);
}

const NO_ADDRS: string[] = [];
const NO_EDGES: EdgeDto[] = [];

/**
 * Edges around the current centers. No request while there are no centers; keeps the previous result while a new key loads.
 * A snapshot (frozen) graph is the file's data with no graph request, its nodes carrying the receiver's live identities.
 * `isPlaceholderData`: `data` is the previous key's result standing in while the current key loads.
 * `visibleEdges`: `data`'s edges with the transfers hidden on the Data tab taken out, for the canvas and the edge
 * detail; `data.edges` stays raw (asset registry, filter panel, pick dialog, snapshot export).
 */
export function useGraphData(): {
  data?: GraphResponseDto;
  visibleEdges: EdgeDto[];
  isFetching: boolean;
  error: unknown;
  isPlaceholderData: boolean;
} {
  const centers = useGraph((s) => s.centers);
  const filter = useGraph((s) => s.filter);
  const sort = useGraph((s) => s.sort);
  const limits = useGraph((s) => s.limits);
  const picks = useGraph((s) => s.picks);
  const frozen = useGraph((s) => s.frozen);
  const hiddenTransfers = useGraph((s) => s.hiddenTransfers);
  const frozenAddrs = useMemo(() => (frozen ? frozen.data.nodes.map((n) => n.address) : NO_ADDRS), [frozen]);
  const live = useLiveIdentities(frozenAddrs);
  const frozenData = useMemo(
    () => (frozen ? { ...frozen.data, nodes: overlayNodes(frozen.data.nodes, live) } : undefined),
    [frozen, live],
  );
  const enabled = !frozen && centers.length > 0;
  // The result on screen when a request starts (the previous key's while a new one loads): read for `prefer`.
  const shown = useRef<GraphResponseDto | undefined>(undefined);
  const q = useQuery({
    queryKey: graphQueryKey({ centers, filter, sort, limits, picks }),
    // The signal aborts the HTTP request when the query is cancelled (e.g. superseded by a refetch).
    queryFn: ({ signal }) =>
      api.graphEdges(
        {
          addresses: centers,
          filter,
          sort,
          limits: centerLimits({ centers, limits, picks }),
          picks: centerPicks({ centers, picks }),
          prefer: preferFor(shown.current),
        },
        { signal },
      ),
    enabled,
    placeholderData: keepPreviousData,
  });
  shown.current = q.data;
  const merge = useAssetRegistry((r) => r.merge);
  useEffect(() => {
    if (frozen) merge(frozen.data.edges);
    else if (q.data) merge(q.data.edges);
  }, [frozen, q.data, merge]);
  const data = frozenData ?? (enabled ? q.data : undefined);
  // A snapshot's edges were drawn under the store's filter too: changing it goes live first.
  const visibleEdges = useMemo(
    () => (data ? subtractHidden(data.edges, hiddenTransfers, filter) : NO_EDGES),
    [data, hiddenTransfers, filter],
  );
  if (frozenData) return { data: frozenData, visibleEdges, isFetching: false, error: null, isPlaceholderData: false };
  return { data, visibleEdges, isFetching: q.isFetching, error: q.error, isPlaceholderData: enabled && q.isPlaceholderData };
}
