import type { EdgeDto } from "../api/generated/EdgeDto";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import type { TransferDto } from "../api/generated/TransferDto";
import { parseHumanAmount } from "../lib/amount";

/** A transfer hidden on the Data tab: what taking it out of its edge needs (addresses lowercase). */
export interface HiddenTransfer {
  tx_hash: string;
  sub_id: string;
  from: string;
  to: string;
  /** Token address; null for ETH. */
  asset: string | null;
  /** Raw amount, decimal string. */
  amount: string;
  ts: string;
  kind: TransferDto["kind"];
}

/** A transfer's stable key: `${tx_hash.toLowerCase()}:${sub_id}`. */
export const transferKey = (t: { tx_hash: string; sub_id: string }): string => `${t.tx_hash.toLowerCase()}:${t.sub_id}`;

const lc = (s: string) => s.toLowerCase();

/** The record kept for a hidden `t`, its hash and addresses lowercased. */
export function hiddenFromTransfer(t: TransferDto): HiddenTransfer {
  return {
    tx_hash: lc(t.tx_hash),
    sub_id: t.sub_id,
    from: lc(t.from),
    to: lc(t.to),
    asset: t.asset === null ? null : lc(t.asset),
    amount: t.amount,
    ts: t.ts,
    kind: t.kind,
  };
}

/** The (from, to, asset) an edge or a hidden transfer belongs to. */
const edgeKey = (from: string, to: string, asset: string | null) => `${lc(from)}>${lc(to)}|${asset === null ? "eth" : lc(asset)}`;

/** Whether a filter entry's asset (`"eth"` in any case, null or absent for ETH, else a token address) is `asset`. */
function sameAsset(entry: string | null | undefined, asset: string | null): boolean {
  const e = entry == null || lc(entry) === "eth" ? null : lc(entry);
  return e === (asset === null ? null : lc(asset));
}

/** Whether the global filter counts `h` into its edge (time window, kinds, the asset's min_amount scaled by `decimals`). */
export function countedByFilter(h: HiddenTransfer, filter: EdgeFilterDto, decimals: number | null): boolean {
  // Both bounds are inclusive, as on the server.
  const ts = Date.parse(h.ts);
  const from = filter.time?.from ? Date.parse(filter.time.from) : NaN;
  const to = filter.time?.to ? Date.parse(filter.time.to) : NaN;
  if (ts < from || ts > to) return false;
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(h.kind)) return false;
  if (!filter.assets || filter.assets.length === 0) return true;
  const entries = filter.assets.filter((a) => sameAsset(a.asset, h.asset));
  if (entries.length === 0) return false;
  // The entries are alternatives: any one that lets the transfer through counts it.
  return entries.some((a) => {
    if (!a.min_amount) return true;
    // Unknown decimals (or an amount the server would reject): the threshold is unknown, so the transfer counts.
    const min = decimals === null ? null : parseHumanAmount(a.min_amount, decimals);
    return min === null || BigInt(h.amount) >= BigInt(min);
  });
}

/** Edges with hidden transfers taken out: count and sum (BigInt) reduced per (from,to,asset); edges reaching count 0 dropped; other fields unchanged. */
export function subtractHidden(edges: EdgeDto[], hidden: Record<string, HiddenTransfer>, filter: EdgeFilterDto): EdgeDto[] {
  const byEdge = new Map<string, HiddenTransfer[]>();
  for (const h of Object.values(hidden)) {
    const k = edgeKey(h.from, h.to, h.asset);
    const list = byEdge.get(k);
    if (list) list.push(h);
    else byEdge.set(k, [h]);
  }
  if (byEdge.size === 0) return edges;
  let changed = false;
  const out: EdgeDto[] = [];
  for (const e of edges) {
    const counted = (byEdge.get(edgeKey(e.from, e.to, e.asset)) ?? []).filter((h) => countedByFilter(h, filter, e.decimals));
    if (counted.length === 0) {
      out.push(e);
      continue;
    }
    changed = true;
    const count = e.count - counted.length;
    if (count <= 0) continue;
    const sum = counted.reduce((s, h) => s - BigInt(h.amount), BigInt(e.sum));
    out.push({ ...e, count, sum: (sum < 0n ? 0n : sum).toString() });
  }
  return changed ? out : edges;
}
