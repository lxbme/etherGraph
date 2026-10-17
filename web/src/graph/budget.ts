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
};

export function nodeCapacity(c: { width: number; height: number }): number {
  return Math.floor((c.width * c.height) / (PER_NODE_PX * PER_NODE_PX));
}

export function nodeBudget(capacity: number, visible: number): number {
  return Math.max(0, capacity - visible);
}

export function callBudget(o: { rate: number; queuedCalls: number; quotaRemaining: number | null | undefined }): number {
  return Math.max(0, Math.min(Math.floor(o.rate * HORIZON_SEC) - o.queuedCalls, o.quotaRemaining ?? Infinity));
}

export function weight(c: { nonce: number | null; localTransfers: number }): Weight {
  return c.nonce != null
    ? { value: Math.log10(c.nonce + 1), estimated: false }
    : { value: Math.log10(c.localTransfers + 1), estimated: true };
}

/** R type 7 quantile on a sorted array. */
function quantile(sorted: number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const a = sorted[lo] ?? 0;
  const b = sorted[lo + 1] ?? a;
  return a + (h - lo) * (b - a);
}

/** Keys whose weight is a Tukey upper outlier; empty for fewer than 4 samples. */
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
  b: { nodes: number; calls: number },
): { selected: string[]; overBudget: boolean } {
  const heavy = heavySet(new Map(cands.map((c) => [c.address, c.weight.value])));
  const eligible = cands
    .filter((c) => c.kind !== "contract" && !c.hot && !heavy.has(c.address))
    .sort((x, y) => x.weight.value - y.weight.value || (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
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
  return Math.max(K_FLOOR, Math.floor((nodes - newSelf) / Math.max(1, selected)));
}

export function usage(selected: Candidate[], b: { nodes: number; calls: number }) {
  const nodes = selected.reduce((s, c) => s + nodeCost(c), 0);
  const calls = selected.reduce((s, c) => s + c.calls, 0);
  return { nodes, calls, overNodes: nodes > b.nodes, overCalls: calls > b.calls };
}
