import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/endpoints";
import type { GraphRequestDto } from "../../api/generated/GraphRequestDto";
import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { mergeResults } from "../../graph/estimate";
import { firstBatchFor, MAX_CENTERS, MAX_NEIGHBOUR_LIMIT, ownNeighbours, useGraph } from "../../graph/store";
import { preferFor, useGraphData } from "../../graph/useGraphData";
import { neighbourRows, type NeighbourRow } from "./neighbours";

/** Quiet time after the last change of k before a new top-k dry run. */
const DEBOUNCE_MS = 250;

const lc = (s: string) => s.toLowerCase();

/** One target of the picker: its neighbour list and default selection. */
export interface PickGroup {
  /** Lowercase. */
  center: string;
  /** From the canvas; undefined when the canvas does not show the target. */
  summary: NodeSummaryDto | undefined;
  /**
   * The canvas's current result shows the target, so `synced` and `syncing` are its own. False while the canvas does
   * not show it yet, or shows a previous request's result standing in while the current one loads: not "unsynced".
   */
  known: boolean;
  /** Known to be synced. */
  synced: boolean;
  syncing: boolean;
  /** Latest `last_synced_at` of the center's coverage; null when never synced (or unknown). */
  lastSynced: string | null;
  /** The listed neighbours (up to 1000, under the graph's filter, in the graph's order); empty while not synced. */
  rows: NeighbourRow[];
  /** Checked when the dialog opens (lowercase). */
  defaults: string[];
  /** The 1000-row list left neighbours out. */
  listedCap: boolean;
  /** Counterparties the graph's filter leaves out of the list. */
  hiddenByFilter: number;
}

export interface PickData {
  groups: PickGroup[];
  loading: boolean;
  error: unknown;
  /** The k of the top-k default. */
  k: number;
  /** Re-runs the top-k dry run with `k` (1..1000); `defaults` follow once it answers. */
  setK(k: number): void;
}

/** `value`, updated only once it has not changed for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** Dry runs of `addresses` in chunks of MAX_CENTERS centers, each center with neighbour limit `limit`, merged. */
async function dryRuns(
  addresses: string[],
  limit: number,
  base: Pick<GraphRequestDto, "filter" | "sort" | "prefer">,
  signal: AbortSignal,
): Promise<GraphResponseDto> {
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += MAX_CENTERS) chunks.push(addresses.slice(i, i + MAX_CENTERS));
  const parts = await Promise.all(
    chunks.map((chunk) =>
      api.graphEdges(
        { addresses: chunk, ...base, limits: Object.fromEntries(chunk.map((a) => [a, limit])), dry_run: true },
        { signal },
      ),
    ),
  );
  return mergeResults(parts);
}

/** Latest `last_synced_at` of `center`'s coverage in `result`, if any. */
function latestSync(result: GraphResponseDto | undefined, center: string): string | null {
  if (!result) return null;
  const list = result.coverage[center] ?? Object.entries(result.coverage).find(([a]) => lc(a) === center)?.[1] ?? [];
  let best: string | null = null;
  for (const c of list) {
    if (c.last_synced_at && (best === null || Date.parse(c.last_synced_at) > Date.parse(best))) best = c.last_synced_at;
  }
  return best;
}

/** `omitted[center]`, matched case-insensitively. */
function omittedOf(result: GraphResponseDto, center: string): number {
  let n = 0;
  for (const [a, v] of Object.entries(result.omitted)) if (lc(a) === center) n += v;
  return n;
}

/** Distinct neighbours of `center` in `result` (other centers included), lowercase. */
function neighbourCount(result: GraphResponseDto, center: string): number {
  const out = new Set<string>();
  for (const e of result.edges) {
    const f = lc(e.from);
    const t = lc(e.to);
    if (f === t) continue;
    if (f === center) out.add(t);
    else if (t === center) out.add(f);
  }
  return out.size;
}

/**
 * The picker's data for `targets` (spec §3.1–§3.4). The list of each synced target is a dry-run graph request
 * (limit 1000, the store's filter and sort, the canvas `prefer`) ranked like the graph; its default selection is
 * what "top k" would add — the neighbours in a top-`k` dry run with the same filter, sort and prefer — or, for a
 * center whose picks are not empty, those picks plus the rows on the canvas for another reason. Targets that are not
 * synced get an empty group and no requests; so does a snapshot (no dry runs while frozen). A target the canvas does
 * not show yet, or shows only in a previous request's result standing in (`isPlaceholderData`), is not known to be
 * synced or not: it is loading, never "needs a sync" (which would offer a costed sync for a synced address).
 *
 * A center picked with none (every new center) has nothing chosen yet, so it defaults to the top k like a top-k one.
 */
export function usePickData(targets: string[]): PickData {
  const { data, isPlaceholderData } = useGraphData();
  const filter = useGraph((s) => s.filter);
  const sort = useGraph((s) => s.sort);
  const ui = useGraph((s) => s.ui);
  const picks = useGraph((s) => s.picks);
  const centers = useGraph((s) => s.centers);
  const frozen = useGraph((s) => s.frozen);

  const addresses = useMemo(() => [...new Set(targets.map(lc))], [targets]);
  const [k, setRawK] = useState(() => firstBatchFor(addresses.length));
  const setK = useCallback(
    (n: number) => setRawK(Math.min(MAX_NEIGHBOUR_LIMIT, Math.max(1, Math.round(n) || 1))),
    [],
  );
  const settledK = useDebounced(k, DEBOUNCE_MS);

  const summaries = useMemo(() => new Map((data?.nodes ?? []).map((n) => [lc(n.address), n])), [data]);
  /** Whether the canvas's own result (not a stand-in) shows `a`: only then is its synced flag known. */
  const isKnown = useCallback((a: string) => !isPlaceholderData && summaries.has(a), [isPlaceholderData, summaries]);
  const synced = useMemo(
    () => addresses.filter((a) => isKnown(a) && summaries.get(a)?.synced),
    [addresses, summaries, isKnown],
  );
  /** Synced targets with no picks chosen yet: their default is the top k. */
  const topK = useMemo(() => synced.filter((a) => !(picks[a]?.length)), [synced, picks]);
  /** The synced targets' flags: a sync or refresh brings neighbours an earlier dry run did not see. */
  const syncKey = synced.map((a) => (summaries.get(a)?.syncing ? "y" : "-")).join("");

  const prefer = useMemo(() => {
    const skip = new Set(addresses);
    return preferFor(data).filter((a) => !skip.has(lc(a)));
    // preferFor reads the centers and hidden flags from the store: `ui` and `centers` re-run it when they change.
  }, [data, addresses, ui, centers]);
  const preferKey = useMemo(() => prefer.join(","), [prefer]);
  const live = !frozen && !!data;

  const list = useQuery({
    queryKey: ["pick-list", synced, filter, sort, preferKey, syncKey],
    queryFn: ({ signal }) => dryRuns(synced, MAX_NEIGHBOUR_LIMIT, { filter, sort, prefer }, signal),
    enabled: live && synced.length > 0,
    placeholderData: keepPreviousData,
  });
  const top = useQuery({
    queryKey: ["pick-top-k", topK, settledK, filter, sort, preferKey, syncKey],
    queryFn: async ({ signal }) => ({ result: await dryRuns(topK, settledK, { filter, sort, prefer }, signal), k: settledK }),
    enabled: live && topK.length > 0,
    placeholderData: keepPreviousData,
  });
  const totals = useQueries({
    queries: synced.map((a) => ({
      queryKey: ["pick-counterparties", a, summaries.get(a)?.syncing ?? false],
      queryFn: () => api.counterparties(a, { limit: 1, kind: "all" }),
      enabled: live,
    })),
    // Structurally shared: the same object while nothing changed.
    combine: (rs) => ({
      totals: rs.map((r) => r.data?.total),
      pending: rs.some((r) => r.isPending),
      error: rs.find((r) => r.error)?.error ?? null,
    }),
  });

  const groups = useMemo(() => {
    const hidden = new Set<string>();
    for (const [a, u] of Object.entries(ui)) if (u.hidden) hidden.add(lc(a));
    const visible = new Set((data?.nodes ?? []).map((n) => lc(n.address)).filter((a) => !hidden.has(a)));
    const allCenters = new Set([...centers.map(lc), ...addresses]);
    const shownCenters = new Set(centers.map(lc));
    // The same prefer the dry runs were sent with: the server ranks it first.
    const preferred = new Set(prefer.map(lc));
    const listed = list.data;
    const topResult = top.data?.result;
    return addresses.map((center): PickGroup => {
      const summary = summaries.get(center);
      const known = isKnown(center);
      const ok = known && !!summary?.synced;
      const base: PickGroup = {
        center,
        summary,
        known,
        synced: ok,
        syncing: known && !!summary?.syncing,
        lastSynced: latestSync(listed, center) ?? latestSync(data, center),
        rows: [],
        defaults: [],
        listedCap: false,
        hiddenByFilter: 0,
      };
      if (!ok || !listed) return base;
      // Only a shown center brings neighbours into the graph; a target that is not one yet owns none of them.
      const own = new Set(shownCenters.has(center) ? ownNeighbours(center, data).map(lc) : []);
      const ctx = { visible, own, centers: allCenters, prefer: preferred, sort };
      const rows = neighbourRows(listed, center, ctx);
      const omitted = omittedOf(listed, center);
      const total = totals.totals[synced.indexOf(center)];
      const chosen = picks[center] ?? [];
      const defaults =
        chosen.length > 0
          ? [...new Set([...chosen, ...rows.filter((r) => r.locked).map((r) => r.address)])]
          : topResult
            ? neighbourRows(topResult, center, ctx).map((r) => r.address)
            : [];
      return {
        ...base,
        rows,
        defaults,
        listedCap: omitted > 0,
        hiddenByFilter: total === undefined ? 0 : Math.max(0, total - (neighbourCount(listed, center) + omitted)),
      };
    });
  }, [addresses, summaries, isKnown, synced, list.data, top.data, totals.totals, ui, data, centers, picks, sort, prefer]);

  const loading =
    !!frozen ||
    !data ||
    addresses.some((a) => !isKnown(a)) ||
    (synced.length > 0 && (list.isPending || list.isPlaceholderData)) ||
    (topK.length > 0 && (settledK !== k || top.isPending || top.isPlaceholderData)) ||
    (synced.length > 0 && totals.pending);
  const error = list.error ?? top.error ?? totals.error;
  return { groups, loading, error, k, setK };
}
