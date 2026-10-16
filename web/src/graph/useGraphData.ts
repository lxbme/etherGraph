import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { qk } from "../api/queryClient";
import { useGraph, type GraphState } from "./store";

/** The query key of the graph for the given store state (shared with the SSE invalidation logic). */
export function graphQueryKey(s: Pick<GraphState, "centers" | "filter" | "sort">) {
  return qk.graph(s.centers, { filter: s.filter, sort: s.sort });
}

/** Edges around the current centers. No request while there are no centers; keeps the previous result while a new key loads. */
export function useGraphData(): { data?: GraphResponseDto; isFetching: boolean; error: unknown } {
  const centers = useGraph((s) => s.centers);
  const filter = useGraph((s) => s.filter);
  const sort = useGraph((s) => s.sort);
  const enabled = centers.length > 0;
  const q = useQuery({
    queryKey: graphQueryKey({ centers, filter, sort }),
    // The signal aborts the HTTP request when the query is cancelled (e.g. superseded by a refetch).
    queryFn: ({ signal }) => api.graphEdges({ addresses: centers, filter, sort }, { signal }),
    enabled,
    placeholderData: keepPreviousData,
  });
  return { data: enabled ? q.data : undefined, isFetching: q.isFetching, error: q.error };
}
