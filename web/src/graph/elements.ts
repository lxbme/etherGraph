import type cytoscape from "cytoscape";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { shortAddr } from "../lib/address";
import type { GraphState, NodeUi } from "./store";
import { edgeWidth, type VisualEdge } from "./visualEdges";

const lc = (s: string) => s.toLowerCase();

/**
 * The label is the name plus " (+N)" omitted neighbours, with the short address on a second line when a
 * name exists. States (partial, syncing, pinned, user label) are classes the stylesheet draws as corner icons.
 */
function labelText(n: NodeSummaryDto, omitted: number, name: string, sub: string): string {
  const first = omitted > 0 ? `${name} (+${omitted})` : name;
  return n.display_name ? `${first}\n${sub}` : first;
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
    data: { id, label, sub, text: labelText(n, ctx.omitted, label, sub), omitted: ctx.omitted },
    classes: classes.join(" "),
  };
  if (ui?.pos) el.position = { ...ui.pos };
  return el;
}

export function edgeElement(v: VisualEdge, highlighted: boolean): cytoscape.ElementDefinition {
  const data: cytoscape.EdgeDataDefinition = {
    id: v.id,
    source: lc(v.from),
    target: lc(v.to),
    width: edgeWidth(v.count),
  };
  if (v.badge) data.badge = v.badge;
  return {
    group: "edges",
    data,
    classes: [`asset-${v.color}`, highlighted ? "highlighted" : ""].filter(Boolean).join(" "),
  };
}

type ViewState = Pick<GraphState, "ui" | "centers" | "selection" | "highlightTransfer">;

function isHighlighted(v: VisualEdge, h: ViewState["highlightTransfer"]): boolean {
  if (!h || lc(v.from) !== lc(h.from) || lc(v.to) !== lc(h.to)) return false;
  const want = h.asset ? lc(h.asset) : null;
  return v.assets.some((a) => (a.asset ? lc(a.asset) : null) === want);
}

function inSelectedPair(v: VisualEdge, sel: ViewState["selection"]): boolean {
  if (sel?.kind !== "pair") return false;
  const [f, t, a, b] = [lc(v.from), lc(v.to), lc(sel.a), lc(sel.b)];
  return (f === a && t === b) || (f === b && t === a);
}

/** Nodes first (hidden ones skipped), then edges whose endpoints are both present. */
export function toElements(
  nodes: NodeSummaryDto[],
  visual: VisualEdge[],
  state: ViewState,
  omitted: Record<string, number>,
): cytoscape.ElementDefinition[] {
  const out: cytoscape.ElementDefinition[] = [];
  const present = new Set<string>();
  const centers = new Set(state.centers.map(lc));
  const sel = state.selection;
  for (const n of nodes) {
    const id = lc(n.address);
    const ui = state.ui[id];
    if (present.has(id) || ui?.hidden) continue;
    present.add(id);
    out.push(
      nodeElement(n, ui, {
        selected: sel?.kind === "node" && lc(sel.address) === id,
        isCenter: centers.has(id),
        omitted: omitted[id] ?? 0,
      }),
    );
  }
  for (const v of visual) {
    if (!present.has(lc(v.from)) || !present.has(lc(v.to))) continue;
    const el = edgeElement(v, isHighlighted(v, state.highlightTransfer));
    if (inSelectedPair(v, sel)) el.classes = `${el.classes} selected`;
    out.push(el);
  }
  return out;
}
