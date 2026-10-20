import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { TrustDto } from "../../api/generated/TrustDto";
import { useGraph, type SortKey } from "../../graph/store";

const lc = (s: string) => s.toLowerCase();

/** The transfers of one asset in one direction between a center and a neighbour. */
export interface Flow {
  /** Lowercase; null for the native coin. */
  asset: string | null;
  /** Relative to the center: `out` is center → neighbour. */
  dir: "in" | "out";
  count: number;
  /** Raw (smallest-unit) sum. */
  sum: bigint;
  decimals: number | null;
  symbol: string | null;
}

/** One neighbour of a center in the picker's list. */
export interface NeighbourRow {
  /** Lowercase. */
  address: string;
  node: NodeSummaryDto;
  /** Transfers with the center, both directions and all assets (under the graph's filter). */
  count: number;
  /** Latest transfer with the center. */
  lastTs: string;
  /** Assets exchanged with the center, each once, in order of first appearance. */
  assets: { asset: string | null; symbol: string | null; trust: TrustDto }[];
  /** One entry per (asset, direction), in order of first appearance. */
  flows: Flow[];
  /** Visible on the canvas now. */
  onCanvas: boolean;
  /** On the canvas for another reason than this center (it cannot be unchecked here). */
  locked: boolean;
}

export interface RowContext {
  /** Visible canvas nodes, lowercase. */
  visible: ReadonlySet<string>;
  /** The neighbours the center brings into the graph now (`ownNeighbours`), lowercase. */
  own: ReadonlySet<string>;
  /** Centers (now and to be), lowercase: never rows. */
  centers: ReadonlySet<string>;
  /** The `prefer` sent with the dry run, lowercase: the server ranks these first (absent: none). */
  prefer?: ReadonlySet<string>;
  /** The graph sort; defaults to the store's. */
  sort?: SortKey;
}

/** A summary for an address the result has no node for (should not happen: the server returns every endpoint). */
const placeholder = (address: string): NodeSummaryDto => ({
  address, kind: "unknown", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: false, hot: false, identified: false, nonce: null, balance: null,
});

const big = (s: string): bigint => {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
};

const time = (s: string): number => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
};

interface Acc {
  row: NeighbourRow;
  amount: bigint;
}

/**
 * The neighbours of `center` in a (dry-run) graph result, one row each: both directions and all assets aggregated
 * (`count` summed, `lastTs` the latest, assets deduplicated, `flows` per asset and direction), other centers and self-transfers left out. Ordered like
 * the server ranks them: preferred (`ctx.prefer`) first, then by the graph sort (count / amount / recent) descending,
 * ties by address ascending — so the first k rows are exactly what a top-k request adds.
 */
export function neighbourRows(result: GraphResponseDto, center: string, ctx: RowContext): NeighbourRow[] {
  const c = lc(center);
  const sort = ctx.sort ?? useGraph.getState().sort;
  const nodes = new Map(result.nodes.map((n) => [lc(n.address), n]));
  const acc = new Map<string, Acc>();
  // Merged chunks may repeat an edge (between centers of two chunks); count each once.
  const seen = new Set<string>();
  for (const e of result.edges) {
    const f = lc(e.from);
    const t = lc(e.to);
    const other = f === c ? t : t === c ? f : null;
    if (other === null || other === c || ctx.centers.has(other)) continue;
    const key = `${f}|${t}|${e.asset === null ? "" : lc(e.asset)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let a = acc.get(other);
    if (!a) {
      const onCanvas = ctx.visible.has(other);
      a = {
        row: {
          address: other,
          node: nodes.get(other) ?? placeholder(other),
          count: 0,
          lastTs: e.last_ts,
          assets: [],
          flows: [],
          onCanvas,
          locked: onCanvas && !ctx.own.has(other),
        },
        amount: 0n,
      };
      acc.set(other, a);
    }
    a.row.count += e.count;
    a.amount += big(e.sum);
    if (time(e.last_ts) > time(a.row.lastTs)) a.row.lastTs = e.last_ts;
    const asset = e.asset === null ? null : lc(e.asset);
    if (!a.row.assets.some((x) => x.asset === asset)) a.row.assets.push({ asset, symbol: e.symbol, trust: e.trust });
    const dir = f === c ? "out" : "in";
    const flow = a.row.flows.find((x) => x.asset === asset && x.dir === dir);
    if (flow) {
      flow.count += e.count;
      flow.sum += big(e.sum);
    } else {
      a.row.flows.push({ asset, dir, count: e.count, sum: big(e.sum), decimals: e.decimals, symbol: e.symbol });
    }
  }
  const list = [...acc.values()];
  const key: (x: Acc, y: Acc) => number =
    sort === "amount"
      ? (x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0)
      : sort === "recent"
        ? (x, y) => time(y.row.lastTs) - time(x.row.lastTs)
        : (x, y) => y.row.count - x.row.count;
  const pref = ctx.prefer ?? new Set<string>();
  const preferred = (x: Acc) => (pref.has(x.row.address) ? 0 : 1);
  list.sort((x, y) => preferred(x) - preferred(y) || key(x, y) || (x.row.address < y.row.address ? -1 : x.row.address > y.row.address ? 1 : 0));
  return list.map((x) => x.row);
}

/** Whether `f` is of `asset` (`"all"`: any asset) and goes in `dir` (`"all"`: either way). */
export function flowMatches(f: Flow, asset: string | null | "all", dir: "all" | "in" | "out"): boolean {
  return (asset === "all" || f.asset === (asset === null ? null : lc(asset))) && (dir === "all" || f.dir === dir);
}

/**
 * The transfers of `row` in `asset` and `dir` (`"all"`: any), counted and summed. A sum over `asset = "all"` adds up
 * different assets: use it for counts only, never for an amount shown to the user.
 */
export function flowTotals(row: NeighbourRow, asset: string | null | "all", dir: "all" | "in" | "out"): { count: number; sum: bigint } {
  let count = 0;
  let sum = 0n;
  for (const f of row.flows) {
    if (!flowMatches(f, asset, dir)) continue;
    count += f.count;
    sum += f.sum;
  }
  return { count, sum };
}
