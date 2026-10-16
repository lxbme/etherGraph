import type { EdgeDto } from "../api/generated/EdgeDto";
import { assetClass, type AssetClass } from "../lib/assets";
import { pairKey } from "./pairKey";

export interface VisualEdge {
  id: string;
  from: string;
  to: string;
  color: AssetClass | "other";
  count: number;
  assets: EdgeDto[];
  badge: string | null;
  expanded: boolean;
}

const MAX_EXPANDED = 5;

const assetKey = (e: EdgeDto) => e.asset?.toLowerCase() ?? "";

/** count desc, ties broken by asset address ascending (ETH = "" sorts first). */
function byCountDesc(a: EdgeDto, b: EdgeDto): number {
  if (b.count !== a.count) return b.count - a.count;
  const ka = assetKey(a);
  const kb = assetKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

const sumCount = (es: EdgeDto[]) => es.reduce((n, e) => n + e.count, 0);

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const g = m.get(k);
    if (g) g.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function deriveVisualEdges(
  edges: EdgeDto[],
  expandedPairs: Set<string>,
  hiddenNodes: Set<string>,
): VisualEdge[] {
  const out: VisualEdge[] = [];
  const visible = edges
    .map((e) => ({ ...e, from: e.from.toLowerCase(), to: e.to.toLowerCase() }))
    .filter((e) => !hiddenNodes.has(e.from) && !hiddenNodes.has(e.to));

  for (const [, dir] of groupBy(visible, (e) => `${e.from}>${e.to}`)) {
    const { from, to } = dir[0]!;
    const expanded = expandedPairs.has(pairKey(from, to));

    if (!expanded) {
      const sorted = [...dir].sort(byCountDesc);
      const dominant = sorted[0]!;
      out.push({
        id: `c:${from}>${to}`,
        from,
        to,
        color: assetClass(dominant.asset, dominant.asset_kind),
        count: sumCount(sorted),
        assets: sorted,
        badge: sorted.length > 1 ? `×${sorted.length}` : null,
        expanded: false,
      });
      continue;
    }

    // Expanded: one edge per asset (duplicates of the same asset are folded).
    const perAsset = [...groupBy(dir, assetKey).values()]
      .map((g) => {
        const sorted = [...g].sort(byCountDesc);
        return { dominant: sorted[0]!, count: sumCount(sorted), list: sorted };
      })
      .sort((a, b) => b.count - a.count || assetKey(a.dominant).localeCompare(assetKey(b.dominant)));
    for (const g of perAsset.slice(0, MAX_EXPANDED)) {
      out.push({
        id: `e:${from}>${to}:${assetKey(g.dominant) || "eth"}`,
        from,
        to,
        color: assetClass(g.dominant.asset, g.dominant.asset_kind),
        count: g.count,
        assets: g.list,
        badge: null,
        expanded: true,
      });
    }
    const rest = perAsset.slice(MAX_EXPANDED);
    if (rest.length > 0) {
      out.push({
        id: `r:${from}>${to}`,
        from,
        to,
        color: "other",
        count: rest.reduce((n, g) => n + g.count, 0),
        assets: rest.flatMap((g) => g.list).sort(byCountDesc),
        badge: `其它 ${rest.length} 种`,
        expanded: true,
      });
    }
  }
  return out;
}

/** 1 + 1.5*log10(count), capped at 8. */
export function edgeWidth(count: number): number {
  return Math.min(8, 1 + 1.5 * Math.log10(Math.max(1, count)));
}
