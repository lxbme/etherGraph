import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { MAX_NEIGHBOUR_LIMIT } from "./store";

const lc = (a: string) => a.toLowerCase();

/** What expanding one target adds, from a dry-run result. */
export interface TargetEstimate {
  /** Lowercase. */
  address: string;
  /** Neighbours known now: onCanvas + hidden + fresh + remaining. */
  total: number;
  /** Returned neighbours already visible. */
  onCanvas: number;
  /** Returned neighbours that will newly appear. */
  fresh: number;
  /** `omitted[address]`: neighbours the limit drops. */
  remaining: number;
  /** Not synced or syncing: more neighbours may arrive after the sync. */
  pending: boolean;
  /** `pending ? max(fresh, k - onCanvas) : fresh`. */
  upper: number;
}

export interface Estimate {
  /** Distinct fresh neighbours plus targets that are not visible themselves. */
  min: number;
  /** `min` plus, for every pending target, `upper - fresh`. */
  max: number;
  targets: TargetEstimate[];
  pendingCount: number;
  /** Targets that will be synced by the expansion (not synced and not already syncing). */
  syncCount: number;
}

/** Distinct neighbours of `center` in `edges` (self-loops ignored), lowercase. */
function neighboursOf(data: GraphResponseDto, center: string): Set<string> {
  const out = new Set<string>();
  for (const e of data.edges) {
    const f = lc(e.from);
    const t = lc(e.to);
    if (f === t) continue;
    if (f === center) out.add(t);
    else if (t === center) out.add(f);
  }
  return out;
}

/** Turns a merged dry-run result and the current canvas into the number of nodes an expansion will add. */
export function estimateExpansion(args: {
  result: GraphResponseDto;
  targets: NodeSummaryDto[];
  k: number;
  visible: ReadonlySet<string>;
  hidden: ReadonlySet<string>;
}): Estimate {
  const { result, targets, k, visible, hidden } = args;
  const omitted: Record<string, number> = {};
  for (const [a, n] of Object.entries(result.omitted)) omitted[lc(a)] = n;
  const union = new Set<string>();
  let selfNew = 0;
  let extra = 0;
  let pendingCount = 0;
  let syncCount = 0;
  const rows: TargetEstimate[] = [];
  for (const t of targets) {
    const address = lc(t.address);
    let onCanvas = 0;
    let hiddenN = 0;
    let fresh = 0;
    for (const n of neighboursOf(result, address)) {
      if (visible.has(n)) onCanvas++;
      else if (hidden.has(n)) hiddenN++;
      else {
        fresh++;
        union.add(n);
      }
    }
    const remaining = omitted[address] ?? 0;
    const pending = !t.synced || t.syncing;
    const upper = pending ? Math.max(fresh, k - onCanvas) : fresh;
    if (pending) pendingCount++;
    if (!t.synced && !t.syncing) syncCount++;
    if (!visible.has(address)) selfNew++;
    extra += upper - fresh;
    rows.push({ address, total: onCanvas + hiddenN + fresh + remaining, onCanvas, fresh, remaining, pending, upper });
  }
  const min = union.size + selfNew;
  return { min, max: min + extra, targets: rows, pendingCount, syncCount };
}

/** Distinct neighbours of each center in `data.edges` (self-loops ignored), lowercase keys. */
export function shownNeighbourCounts(data: GraphResponseDto, centers: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of centers) {
    const a = lc(c);
    out[a] = neighboursOf(data, a).size;
  }
  return out;
}

/** Amount to pass to raiseLimit so the next batch is not swallowed by neighbours shown past the limit. */
export function revealStep(limit: number, shown: number, batch: number): number {
  return Math.max(limit, shown) - limit + batch;
}

/** New nodes one click on "+N more" shows: min(batch, omitted, MAX_NEIGHBOUR_LIMIT - max(limit, shown)), floored at 0. */
export function moreNext(omitted: number, limit: number, shown: number, batch: number): number {
  return Math.max(0, Math.min(batch, omitted, MAX_NEIGHBOUR_LIMIT - Math.max(limit, shown)));
}

/** Merges dry-run results of center chunks (nodes deduped by lowercase address, edges concatenated, omitted merged). */
export function mergeResults(parts: GraphResponseDto[]): GraphResponseDto {
  const nodes = new Map<string, NodeSummaryDto>();
  const out: GraphResponseDto = { nodes: [], edges: [], omitted: {}, coverage: {} };
  for (const p of parts) {
    for (const n of p.nodes) if (!nodes.has(lc(n.address))) nodes.set(lc(n.address), n);
    out.edges.push(...p.edges);
    for (const [a, n] of Object.entries(p.omitted)) out.omitted[a] = (out.omitted[a] ?? 0) + n;
    Object.assign(out.coverage, p.coverage);
  }
  out.nodes = [...nodes.values()];
  return out;
}
