import type { EdgeDto } from "../api/generated/EdgeDto";

export interface TransferGroup {
  key: string;
  from: string;
  to: string;
  asset: string | null;
  kind: EdgeDto["asset_kind"];
  count: number;
  sum: string;
  decimals: number | null;
  symbol: string | null;
}

/** Every (direction, asset) edge between `a` and `b` as a group, by count descending. */
export function groupsForPair(edges: EdgeDto[], a: string, b: string): TransferGroup[] {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return edges
    .filter((e) => {
      const f = e.from.toLowerCase();
      const t = e.to.toLowerCase();
      return (f === x && t === y) || (f === y && t === x);
    })
    .map((e) => ({
      key: `${e.from.toLowerCase()}>${e.to.toLowerCase()}|${e.asset === null ? "eth" : e.asset.toLowerCase()}`,
      from: e.from.toLowerCase(),
      to: e.to.toLowerCase(),
      asset: e.asset === null ? null : e.asset.toLowerCase(),
      kind: e.asset_kind,
      count: e.count,
      sum: e.sum,
      decimals: e.decimals,
      symbol: e.symbol,
    }))
    .sort((p, q) => q.count - p.count);
}
