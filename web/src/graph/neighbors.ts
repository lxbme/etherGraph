import type { EdgeDto } from "../api/generated/EdgeDto";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";

export const TOP_K = 10;
const lc = (s: string) => s.toLowerCase();

/** Nodes connected to `a` by any edge (either direction), excluding `a`; lowercase, first-seen order. */
export function neighborsOf(a: string, edges: EdgeDto[]): string[] {
  const me = lc(a);
  const out = new Set<string>();
  for (const e of edges) {
    const f = lc(e.from);
    const t = lc(e.to);
    if (f === me && t !== me) out.add(t);
    else if (t === me && f !== me) out.add(f);
  }
  return [...out];
}

/** The single asset the filter restricts to (null = ETH), or undefined when it is not exactly one. */
function singleAsset(filter: EdgeFilterDto): string | null | undefined {
  const list = filter.assets;
  if (!list || list.length !== 1) return undefined;
  const raw = list[0]?.asset;
  if (raw == null || raw.toLowerCase() === "eth") return null;
  return lc(raw);
}

/**
 * The `k` best non-hot neighbours of `a`: by summed amount (BigInt) when the filter has exactly one asset,
 * otherwise by transfer count.
 */
export function topNeighbors(
  a: string,
  nodes: NodeSummaryDto[],
  edges: EdgeDto[],
  filter: EdgeFilterDto,
  k = TOP_K,
): string[] {
  const me = lc(a);
  const hot = new Set(nodes.filter((n) => n.hot).map((n) => lc(n.address)));
  const asset = singleAsset(filter);
  const score = new Map<string, bigint>();
  for (const e of edges) {
    const f = lc(e.from);
    const t = lc(e.to);
    const other = f === me ? t : t === me ? f : null;
    if (other === null || other === me || hot.has(other)) continue;
    let v: bigint;
    if (asset === undefined) v = BigInt(e.count);
    else {
      if ((e.asset == null ? null : lc(e.asset)) !== asset || !/^\d+$/.test(e.sum)) continue;
      v = BigInt(e.sum);
    }
    score.set(other, (score.get(other) ?? 0n) + v);
  }
  return [...score.entries()]
    .sort((x, y) => (x[1] === y[1] ? 0 : x[1] > y[1] ? -1 : 1))
    .slice(0, k)
    .map(([addr]) => addr);
}
