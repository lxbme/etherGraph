import type cytoscape from "cytoscape";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { t } from "../i18n";
import { shortAddr } from "../lib/address";
import { flaggedLabel, worstFlag } from "../lib/trust";
import { MORE_PREFIX } from "./moreId";
import { graphSelection, type GraphSelection, type GraphState, type NodeUi, type Pos } from "./store";
import { edgeWidth, type VisualEdge } from "./visualEdges";

export { isMoreId, MORE_PREFIX } from "./moreId";

const lc = (s: string) => s.toLowerCase();

/**
 * The label is the name, with the short address on a second line when a name exists; omitted neighbours
 * are a separate "+N more" node. States (partial, syncing, pinned, user label) are classes the stylesheet draws as corner icons.
 */
function labelText(n: NodeSummaryDto, name: string, sub: string): string {
  return n.display_name ? `${name}\n${sub}` : name;
}

export function nodeElement(
  n: NodeSummaryDto,
  ui: NodeUi | undefined,
  ctx: { selected: boolean; isCenter: boolean; omitted: number },
): cytoscape.ElementDefinition {
  const id = lc(n.address);
  const sub = shortAddr(id);
  const label = n.display_name ?? sub;
  const classes = [
    `kind-${n.kind}`,
    `cat-${n.labels[0]?.category ?? "none"}`,
    n.synced ? "synced" : "",
    !n.synced && !n.syncing ? "unsynced" : "",
    n.syncing ? "syncing" : "",
    n.partial ? "partial" : "",
    ui?.pinned ? "pinned" : "",
    n.labels.some((l) => l.source === "user") ? "user-label" : "",
    ctx.selected ? "selected" : "",
    ctx.isCenter ? "center" : "",
  ].filter(Boolean);
  const el: cytoscape.ElementDefinition = {
    group: "nodes",
    data: { id, label, sub, text: labelText(n, label, sub), omitted: ctx.omitted },
    classes: classes.join(" "),
  };
  if (ui?.pos) el.position = { ...ui.pos };
  return el;
}

/**
 * The placeholder for a center's omitted neighbours; clicking it opens the neighbour picker. Not selectable, but
 * draggable: once dragged (`pos`) it is `placed`, and layouts other than Re-layout leave it there.
 */
export function moreElements(center: string, count: number, pos?: Pos): cytoscape.ElementDefinition[] {
  const id = `${MORE_PREFIX}${center}`;
  const proxy: cytoscape.ElementDefinition = {
    group: "nodes",
    data: { id, label: t("graph.more", { count }), center, ...(pos && { placed: true }) },
    classes: "more",
    selectable: false,
    grabbable: true,
  };
  if (pos) proxy.position = { ...pos };
  return [
    proxy,
    {
      group: "edges",
      data: { id: `more-edge:${center}`, source: center, target: id },
      classes: "more",
      selectable: false,
    },
  ];
}

/**
 * An edge carrying a suspicious or scam token (the worst of its assets) gets `asset-suspicious` / `asset-scam`
 * and a ⚠ in front of its badge (the ⚠ alone without one), which the stylesheet colours.
 */
export function edgeElement(v: VisualEdge, highlighted: boolean): cytoscape.ElementDefinition {
  const data: cytoscape.EdgeDataDefinition = {
    id: v.id,
    source: lc(v.from),
    target: lc(v.to),
    width: edgeWidth(v.count),
  };
  const flag = worstFlag(v.assets);
  if (flag) data.badge = flaggedLabel(v.badge);
  else if (v.badge) data.badge = v.badge;
  return {
    group: "edges",
    data,
    classes: [`asset-${v.color}`, flag ? `asset-${flag}` : "", highlighted ? "highlighted" : ""].filter(Boolean).join(" "),
  };
}

type ViewState = Pick<GraphState, "ui" | "centers" | "selection" | "highlightTransfer"> & Partial<Pick<GraphState, "proxyPos" | "hiddenProxies" | "plainCenters">>;

function isHighlighted(v: VisualEdge, h: ViewState["highlightTransfer"]): boolean {
  if (!h || lc(v.from) !== lc(h.from) || lc(v.to) !== lc(h.to)) return false;
  const want = h.asset ? lc(h.asset) : null;
  return v.assets.some((a) => (a.asset ? lc(a.asset) : null) === want);
}

function inSelectedPair(v: VisualEdge, sel: GraphSelection | null): boolean {
  if (sel?.kind !== "pair") return false;
  const [f, t, a, b] = [lc(v.from), lc(v.to), lc(sel.a), lc(sel.b)];
  return (f === a && t === b) || (f === b && t === a);
}

/**
 * Nodes first (hidden ones skipped), then edges whose endpoints are both present. Hidden "+N more" proxies are left out;
 * a plain center is drawn without the `center` class but keeps its proxy.
 */
export function toElements(
  nodes: NodeSummaryDto[],
  visual: VisualEdge[],
  state: ViewState,
  omitted: Record<string, number>,
): cytoscape.ElementDefinition[] {
  const out: cytoscape.ElementDefinition[] = [];
  const present = new Set<string>();
  const centers = new Set(state.centers.map(lc));
  const plain = new Set(state.plainCenters ?? []);
  const sel = graphSelection(state.selection);
  for (const n of nodes) {
    const id = lc(n.address);
    const ui = state.ui[id];
    if (present.has(id) || ui?.hidden) continue;
    present.add(id);
    out.push(
      nodeElement(n, ui, {
        selected: sel?.kind === "node" && lc(sel.address) === id,
        // Only the look: a plain center is still a center for its proxy, the tooltip and the menu.
        isCenter: centers.has(id) && !plain.has(id),
        omitted: omitted[id] ?? 0,
      }),
    );
  }
  const proxies: cytoscape.ElementDefinition[] = [];
  const hiddenProxies = new Set(state.hiddenProxies ?? []);
  for (const c of state.centers.map(lc)) {
    const count = omitted[c] ?? 0;
    if (count > 0 && present.has(c) && !hiddenProxies.has(c)) proxies.push(...moreElements(c, count, state.proxyPos?.[c]));
  }
  out.push(...proxies.filter((e) => e.group === "nodes"));
  for (const v of visual) {
    if (!present.has(lc(v.from)) || !present.has(lc(v.to))) continue;
    const el = edgeElement(v, isHighlighted(v, state.highlightTransfer));
    if (inSelectedPair(v, sel)) el.classes = `${el.classes} selected`;
    out.push(el);
  }
  out.push(...proxies.filter((e) => e.group === "edges"));
  return out;
}
