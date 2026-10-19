import { useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { qk } from "../api/queryClient";
import { overlayNodes, useLiveIdentities } from "../workspace/snapshot";
import { useAssetRegistry } from "./assetRegistry";
import { useGraph, type GraphState } from "./store";

/** Most `prefer` addresses the server accepts. */
const MAX_PREFER = 2000;

/** The limits of the centers only (the server rejects keys that are not centers). */
function centerLimits(s: Pick<GraphState, "centers" | "limits">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of s.centers) {
    const n = s.limits[c];
    if (n !== undefined) out[c] = n;
  }
  return out;
}

/**
 * The query key of the graph for the given store state (shared with the SSE invalidation logic).
 * Center limits are part of it (raising one refetches); `prefer` is not, or every new node would refetch.
 */
export function graphQueryKey(s: Pick<GraphState, "centers" | "filter" | "sort" | "limits">) {
  return qk.graph(s.centers, { filter: s.filter, sort: s.sort, limits: centerLimits(s) });
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

/**
 * Edges around the current centers. No request while there are no centers; keeps the previous result while a new key loads.
 * A snapshot (frozen) graph is the file's data with no graph request, its nodes carrying the receiver's live identities.
 */
export function useGraphData(): { data?: GraphResponseDto; isFetching: boolean; error: unknown } {
  const centers = useGraph((s) => s.centers);
  const filter = useGraph((s) => s.filter);
  const sort = useGraph((s) => s.sort);
  const limits = useGraph((s) => s.limits);
  const frozen = useGraph((s) => s.frozen);
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
    queryKey: graphQueryKey({ centers, filter, sort, limits }),
    // The signal aborts the HTTP request when the query is cancelled (e.g. superseded by a refetch).
    queryFn: ({ signal }) =>
      api.graphEdges(
        { addresses: centers, filter, sort, limits: centerLimits({ centers, limits }), prefer: preferFor(shown.current) },
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
  if (frozenData) return { data: frozenData, isFetching: false, error: null };
  return { data: enabled ? q.data : undefined, isFetching: q.isFetching, error: q.error };
}
