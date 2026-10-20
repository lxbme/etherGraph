import type { AddressAssetDto } from "../api/generated/AddressAssetDto";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { TrustDto } from "../api/generated/TrustDto";

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
  trust: TrustDto;
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
      trust: e.trust,
    }))
    .sort((p, q) => q.count - p.count);
}

/** A pair's (direction, asset) rows from `GET /api/address/{a}/assets?with={b}` as groups, by count descending. */
export function groupsFromAssets(rows: AddressAssetDto[]): TransferGroup[] {
  return rows
    .filter((r) => r.from !== null && r.to !== null)
    .map((r) => {
      const from = r.from!.toLowerCase();
      const to = r.to!.toLowerCase();
      const asset = r.asset === null ? null : r.asset.toLowerCase();
      return {
        key: `${from}>${to}|${asset ?? "eth"}`,
        from,
        to,
        asset,
        kind: r.asset_kind,
        count: r.count,
        sum: r.sum,
        decimals: r.decimals,
        symbol: r.symbol,
        trust: r.trust,
      };
    })
    .sort((p, q) => q.count - p.count);
}
