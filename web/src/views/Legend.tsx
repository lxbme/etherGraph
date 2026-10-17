import { ChevronDown } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { LegendGroup, Swatch } from "../graph/legend";
import { useT } from "../i18n";

/** localStorage key of the canvas legends' collapsed state ("1" / "0"). */
export const LEGEND_COLLAPSED_KEY = "eg.legend.collapsed";

/**
 * Collapsed state per key, shared by every mounted legend (the graph and each tx tab stay mounted while
 * hidden). localStorage is the source; `fallback` keeps the choice for the session when writing it fails.
 */
const fallback = new Map<string, boolean>();
const listeners = new Set<() => void>();

function readCollapsed(key: string): boolean {
  const kept = fallback.get(key);
  if (kept !== undefined) return kept;
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(key: string, collapsed: boolean) {
  try {
    localStorage.setItem(key, collapsed ? "1" : "0");
    fallback.delete(key);
  } catch {
    fallback.set(key, collapsed);
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useCollapsed(key: string | undefined): [boolean, (next: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, () => (key ? readCollapsed(key) : false));
  const set = (next: boolean) => {
    if (key) writeCollapsed(key, next);
  };
  return [collapsed, set];
}

type Paint = { fill: string; stroke: string; strokeWidth: number; strokeDasharray?: string };

/** The node outline on the 16px grid, per Cytoscape shape, `inset` px inside the 2px margin. */
function NodeShape({ shape, inset, ...paint }: { shape: string; inset: number } & Paint) {
  const lo = 2 + inset;
  const hi = 14 - inset;
  const size = hi - lo;
  if (shape === "round-rectangle") return <rect x={lo} y={lo} width={size} height={size} rx={3} {...paint} />;
  if (shape === "hexagon") {
    const q = size / 4;
    const pts = [[lo, 8], [lo + q, lo + 1], [hi - q, lo + 1], [hi, 8], [hi - q, hi - 1], [lo + q, hi - 1]];
    return <polygon points={pts.map((xy) => xy.join(",")).join(" ")} {...paint} />;
  }
  return <ellipse cx={8} cy={8} rx={size / 2} ry={size / 2} {...paint} />;
}

/** A 16×16 sample of one encoding, drawn with the same values as the canvas stylesheet. */
function SwatchSvg({ swatch }: { swatch: Swatch }) {
  let body: React.ReactNode;
  if (swatch.kind === "node") {
    body = (
      <>
        {swatch.ring && <NodeShape shape={swatch.shape} inset={-1} fill="none" stroke={swatch.ring} strokeWidth={1.5} />}
        <NodeShape
          shape={swatch.shape}
          inset={swatch.ring ? 2 : 0}
          fill={swatch.fill}
          stroke={swatch.stroke}
          strokeWidth={1.5}
          strokeDasharray={swatch.dashed ? "2.5 1.5" : undefined}
        />
      </>
    );
  } else if (swatch.kind === "edge") {
    body = (
      <>
        <line
          x1={1}
          y1={8}
          x2={15}
          y2={8}
          stroke={swatch.color}
          strokeWidth={swatch.width ?? 2}
          strokeDasharray={swatch.dashed ? "3 2" : undefined}
        />
        {swatch.badge && (
          <text className="legend__badge" x={8} y={8} textAnchor="middle" dominantBaseline="central">
            {swatch.badge}
          </text>
        )}
      </>
    );
  } else {
    body = <image href={swatch.svg} x={1} y={1} width={14} height={14} />;
  }
  return (
    <svg className="legend__swatch" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {body}
    </svg>
  );
}

/**
 * The canvas legend. With `collapsedKey` it floats over the canvas's bottom-left corner with a
 * collapse toggle remembered under that key; without, it renders inline (e.g. inside the help).
 */
export function Legend({ groups, collapsedKey }: { groups: LegendGroup[]; collapsedKey?: string }) {
  const t = useT();
  const [collapsed, setCollapsed] = useCollapsed(collapsedKey);
  if (groups.length === 0) return null;

  const toggle = () => setCollapsed(!collapsed);

  return (
    <section className={collapsedKey ? "legend legend--floating" : "legend"} aria-label={t("legend.title")} data-testid={collapsedKey ? "legend" : "legend-full"}>
      {collapsedKey && (
        <div className="legend__head">
          <span className="legend__title">{t("legend.title")}</span>
          <button
            type="button"
            className="btn btn--icon btn--ghost btn--compact legend__toggle"
            aria-label={t(collapsed ? "legend.expand" : "legend.collapse")}
            title={t(collapsed ? "legend.expand" : "legend.collapse")}
            onClick={toggle}
          >
            <ChevronDown size={14} className={collapsed ? "legend__chevron legend__chevron--up" : "legend__chevron"} />
          </button>
        </div>
      )}
      {!collapsed &&
        groups.map((g) => (
          <div key={g.id} className="legend__group">
            <div className="legend__group-title">{t(`legend.group.${g.id}`)}</div>
            <ul className="legend__list">
              {g.items.map((it) => (
                <li key={it.id} className="legend__item">
                  <SwatchSvg swatch={it.swatch} />
                  <span>{t(it.label)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}
