import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/endpoints";
import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { estimateExpansion, mergeResults, type Estimate } from "../../graph/estimate";
import { useGraph } from "../../graph/store";
import { preferFor } from "../../graph/useGraphData";

/** Most centers one POST /api/graph/edges accepts. */
const CENTERS_MAX = 50;
/** Quiet time after the last change of k before a new dry run. */
const DEBOUNCE_MS = 250;

const lc = (s: string) => s.toLowerCase();

/** `value`, updated only once it has not changed for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * What making `targets` centers with neighbour limit `k` adds to the canvas (spec §4): a dry-run graph request
 * per chunk of targets, with the store's filter and sort and the real query's `prefer` (the targets are centers
 * after the expansion, so the real query no longer prefers them), compared with the canvas. No dry run for a
 * snapshot. While a new k settles or loads, `estimate` is the previous one (computed with its own k).
 */
export function useExpandEstimate(args: {
  targets: NodeSummaryDto[];
  k: number;
  data: GraphResponseDto;
}): { estimate: Estimate | null; loading: boolean; error: unknown } {
  const { targets, k, data } = args;
  const filter = useGraph((s) => s.filter);
  const sort = useGraph((s) => s.sort);
  const ui = useGraph((s) => s.ui);
  const frozen = useGraph((s) => s.frozen);
  const settledK = useDebounced(k, DEBOUNCE_MS);

  const addresses = useMemo(() => [...new Set(targets.map((t) => lc(t.address)))], [targets]);
  const prefer = useMemo(() => {
    const skip = new Set(addresses);
    return preferFor(data).filter((a) => !skip.has(lc(a)));
    // preferFor reads the hidden flags from the store: `ui` re-runs it when they change.
  }, [data, addresses, ui]);
  const preferKey = useMemo(() => prefer.join(","), [prefer]);

  const q = useQuery({
    queryKey: ["expand-estimate", addresses, settledK, filter, sort, preferKey],
    queryFn: async ({ signal }) => {
      const chunks: string[][] = [];
      for (let i = 0; i < addresses.length; i += CENTERS_MAX) chunks.push(addresses.slice(i, i + CENTERS_MAX));
      const parts = await Promise.all(
        chunks.map((chunk) =>
          api.graphEdges(
            { addresses: chunk, filter, sort, limits: Object.fromEntries(chunk.map((a) => [a, settledK])), prefer, dry_run: true },
            { signal },
          ),
        ),
      );
      return { result: mergeResults(parts), k: settledK };
    },
    enabled: !frozen && addresses.length > 0,
    placeholderData: keepPreviousData,
  });

  const answer = q.data;
  const estimate = useMemo(() => {
    if (!answer) return null;
    const hidden = new Set<string>();
    for (const [a, u] of Object.entries(ui)) if (u.hidden) hidden.add(lc(a));
    const visible = new Set(data.nodes.map((n) => lc(n.address)).filter((a) => !hidden.has(a)));
    return estimateExpansion({ result: answer.result, targets, k: answer.k, visible, hidden });
  }, [answer, data, targets, ui]);

  const loading = !!frozen || settledK !== k || q.isPending || q.isPlaceholderData;
  return { estimate, loading, error: q.error };
}
