/** Adaptive expansion budget: pure functions, no React or stores. Budgets are soft (callers warn, never block). */

export const PER_NODE_PX = 96;
export const HORIZON_SEC = 90;
export const PROBE_CHUNK = 20;
export const K_MIN = 5;
export const K_FLOOR = 3;
/** Calls of a shallow sync: head + 5 transfer kinds. */
export const SHALLOW_CALLS = 6;

export type Weight = { value: number; estimated: boolean };

export type Candidate = {
  address: string;
  kind: "eoa" | "contract" | "unknown";
  hot: boolean;
  onCanvas: boolean;
  calls: number;
  weight: Weight;
  /** Transfers with the expanded address (tie-break: more first); 0 when unknown. */
  withCenter?: number;
};

/** Non-finite inputs (NaN, +-Infinity) count as 0 so budgets never become NaN. */
const fin = (n: number): number => (Number.isFinite(n) ? n : 0);

export function nodeCapacity(c: { width: number; height: number }): number {
  return Math.max(0, Math.floor((fin(c.width) * fin(c.height)) / (PER_NODE_PX * PER_NODE_PX)));
}

export function nodeBudget(capacity: number, visible: number): number {
  return Math.max(0, fin(capacity) - fin(visible));
}

export function callBudget(o: { rate: number; queuedCalls: number; quotaRemaining: number | null | undefined }): number {
  // null/undefined quota = unknown (unbounded); a non-finite number is treated as 0.
  const quota = o.quotaRemaining == null ? Infinity : fin(o.quotaRemaining);
  return Math.max(0, Math.min(Math.floor(fin(o.rate) * HORIZON_SEC) - fin(o.queuedCalls), quota));
}

/**
 * log10(max(nonce, local transfers) + 1): the stored transfer count is a free lower bound of activity (a wallet
 * that only receives has nonce 0). Estimated while the nonce is unknown.
 */
export function weight(c: { nonce: number | null; localTransfers: number }): Weight {
  const nn = (n: number) => Math.max(0, fin(n));
  const value = Math.log10(Math.max(nn(c.nonce ?? 0), nn(c.localTransfers)) + 1);
  return { value, estimated: c.nonce == null };
}

/** Lightest first; equal weights: more transfers with the center first, then by address. */
export function byLightness(x: Candidate, y: Candidate): number {
  return (
    x.weight.value - y.weight.value ||
    fin(y.withCenter ?? 0) - fin(x.withCenter ?? 0) ||
    (x.address < y.address ? -1 : x.address > y.address ? 1 : 0)
  );
}

/** R type 7 quantile on a sorted array. */
function quantile(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const a = sorted[lo] ?? 0;
  const b = sorted[lo + 1] ?? a;
  return a + (h - lo) * (b - a);
}

/** Computed over all candidates passed in (contracts and hot included). Keys whose weight is a Tukey upper outlier; empty for fewer than 4 samples. */
export function heavySet(weights: Map<string, number>): Set<string> {
  if (weights.size < 4) return new Set();
  const sorted = [...weights.values()].sort((x, y) => x - y);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const fence = q3 + 1.5 * (q3 - q1);
  return new Set([...weights].filter(([, v]) => v > fence).map(([k]) => k));
}

const nodeCost = (c: Candidate) => (c.onCanvas ? 0 : 1) + K_MIN;

export function defaultSelection(
  cands: Candidate[],
  budget: { nodes: number; calls: number },
): { selected: string[]; overBudget: boolean } {
  const b = { nodes: fin(budget.nodes), calls: fin(budget.calls) };
  const heavy = heavySet(new Map(cands.map((c) => [c.address, c.weight.value])));
  const eligible = cands
    .filter((c) => c.kind !== "contract" && !c.hot && !heavy.has(c.address))
    .sort(byLightness);
  const selected: string[] = [];
  let nodes = 0;
  let calls = 0;
  for (const c of eligible) {
    if (nodes + nodeCost(c) > b.nodes || calls + c.calls > b.calls) break;
    nodes += nodeCost(c);
    calls += c.calls;
    selected.push(c.address);
  }
  const first = eligible[0];
  if (selected.length === 0 && first) return { selected: [first.address], overBudget: true };
  return { selected, overBudget: false };
}

export function perCenterBatch(nodes: number, selected: number, newSelf: number): number {
  return Math.max(K_FLOOR, Math.floor((fin(nodes) - fin(newSelf)) / Math.max(1, fin(selected))));
}

export function usage(selected: Candidate[], budget: { nodes: number; calls: number }) {
  const b = { nodes: fin(budget.nodes), calls: fin(budget.calls) };
  const nodes = selected.reduce((s, c) => s + nodeCost(c), 0);
  const calls = selected.reduce((s, c) => s + c.calls, 0);
  return { nodes, calls, overNodes: nodes > b.nodes, overCalls: calls > b.calls };
}
