import type cytoscape from "cytoscape";
import type { MsgKey } from "../i18n";
import type { AssetClass } from "../lib/assets";
import { NODE_SHAPE, assetColors, categoryColors, iconSvgs, stateColors, type CategoryId, type NodeKind, type Theme } from "./styles";

export type LegendGroupId = "shape" | "category" | "state" | "asset" | "edge" | "tx";
export type Swatch =
  | { kind: "node"; shape: string; fill: string; stroke: string; dashed?: boolean; ring?: string }
  | { kind: "edge"; color: string; width?: number; dashed?: boolean; badge?: string }
  /** The "+N more" placeholder: a dashed pill with `text` inside. */
  | { kind: "pill"; fill: string; stroke: string; text: string }
  | { kind: "icon"; svg: string };
export type LegendItem = { id: string; swatch: Swatch; label: MsgKey };
export type LegendGroup = { id: LegendGroupId; items: LegendItem[] };

const KINDS: NodeKind[] = ["eoa", "contract", "unknown"];
/** "sanctioned" shares the scam hue, so it is listed as scam; "none" comes last, for contrast. */
const CATEGORIES = ["cex", "defi", "bridge", "mixer", "scam", "none"] as const satisfies readonly CategoryId[];
const STATES = ["center", "unsynced", "selected", "user-label", "pinned", "syncing", "partial", "more"] as const;
const ASSETS = ["eth", "stable", "erc20", "nft", "other"] as const satisfies readonly (AssetClass | "other")[];

const STATE_LABEL: Record<(typeof STATES)[number], MsgKey> = {
  center: "legend.state.center",
  unsynced: "legend.state.unsynced",
  selected: "legend.state.selected",
  "user-label": "legend.state.userLabel",
  pinned: "legend.state.pinned",
  syncing: "legend.state.syncing",
  partial: "legend.state.partial",
  more: "legend.state.more",
};

/** Every entry, with the colours, shapes and icons the graph stylesheet uses for `theme`. */
function catalogue(theme: Theme): Record<LegendGroupId, LegendItem[]> {
  const cat = categoryColors(theme);
  const asset = assetColors(theme);
  const state = stateColors(theme);
  const icon = iconSvgs(theme);
  const plain = { kind: "node", shape: NODE_SHAPE.eoa, fill: cat.none.fill, stroke: cat.none.stroke } as const;
  const stateSwatch: Record<(typeof STATES)[number], Swatch> = {
    center: { ...plain, fill: state.center.fill, stroke: state.center.stroke },
    unsynced: { ...plain, dashed: true },
    selected: { ...plain, ring: state.selectedRing },
    "user-label": { kind: "icon", svg: icon.tag },
    pinned: { kind: "icon", svg: icon.pin },
    syncing: { kind: "icon", svg: icon.syncing },
    partial: { kind: "icon", svg: icon.partial },
    more: { kind: "pill", fill: state.more.fill, stroke: state.more.stroke, text: "+" },
  };
  return {
    shape: KINDS.map((k) => ({ id: k, swatch: { ...plain, shape: NODE_SHAPE[k] }, label: `legend.shape.${k}` })),
    category: CATEGORIES.map((k) => ({
      id: k,
      swatch: { ...plain, fill: cat[k].fill, stroke: cat[k].stroke },
      label: `legend.cat.${k}`,
    })),
    state: STATES.map((k) => ({ id: k, swatch: stateSwatch[k], label: STATE_LABEL[k] })),
    asset: ASSETS.map((k) => ({ id: k, swatch: { kind: "edge", color: asset[k] }, label: `legend.asset.${k}` })),
    edge: [
      { id: "width", swatch: { kind: "edge", color: asset.other, width: 4 }, label: "legend.edge.width" },
      { id: "badge", swatch: { kind: "edge", color: asset.other, badge: "×N" }, label: "legend.edge.badge" },
    ],
    tx: [
      { id: "call", swatch: { kind: "edge", color: asset.other, dashed: true }, label: "legend.tx.call" },
      { id: "flow", swatch: { kind: "edge", color: asset.eth }, label: "legend.tx.flow" },
      { id: "seq", swatch: { kind: "edge", color: asset.other, badge: "①" }, label: "legend.tx.seq" },
    ],
  };
}

const ORDER: LegendGroupId[] = ["shape", "category", "state", "tx", "asset", "edge"];

/** Groups in display order, without empty ones. */
function assemble(all: Record<LegendGroupId, LegendItem[]>, keep: (group: LegendGroupId, id: string) => boolean): LegendGroup[] {
  return ORDER.map((id) => ({ id, items: all[id].filter((it) => keep(id, it.id)) })).filter((g) => g.items.length > 0);
}

/** The legend row a node's category is drawn as: sanctioned shares the scam hue; untinted ones are "none". */
function legendCategory(c: string): (typeof CATEGORIES)[number] {
  if (c === "sanctioned") return "scam";
  return (CATEGORIES as readonly string[]).includes(c) ? (c as (typeof CATEGORIES)[number]) : "none";
}

/** The encodings present in `els`, as "group/id" keys. */
function present(els: cytoscape.ElementDefinition[]): Set<string> {
  const out = new Set<string>();
  const categories = new Set<string>();
  for (const el of els) {
    const cls = new Set(String(el.classes ?? "").split(/\s+/).filter(Boolean));
    if (el.group === "nodes") {
      if (cls.has("more")) {
        out.add("state/more");
        continue;
      }
      for (const c of cls) {
        if (c.startsWith("kind-")) out.add(`shape/${c.slice(5)}`);
        if (STATES.includes(c as never)) out.add(`state/${c}`);
        // The center is drawn in the accent whatever its category; one the stylesheet does not tint ("other", …) is plain.
        if (c.startsWith("cat-") && !cls.has("center")) categories.add(legendCategory(c.slice(4)));
      }
    } else if (!cls.has("more")) {
      out.add("edge/width");
      if (el.data.badge) out.add("edge/badge");
      for (const c of cls) if (c.startsWith("asset-")) out.add(`asset/${c.slice(6)}`);
    }
  }
  // "No category" is listed only next to a category, as its contrast.
  const tinted = [...categories].filter((c) => c !== "none");
  for (const c of tinted) out.add(`category/${c}`);
  if (tinted.length > 0 && categories.has("none")) out.add("category/none");
  return out;
}

/** The legend for the address graph: only the encodings that `els` actually shows. */
export function legendFor(els: cytoscape.ElementDefinition[], theme: Theme): LegendGroup[] {
  if (els.length === 0) return [];
  const has = present(els);
  return assemble(catalogue(theme), (g, id) => g !== "tx" && has.has(`${g}/${id}`));
}

/** The tx fund-flow legend: the node encodings in view, the call / flow edges and sequence numbers, and the asset colours present. */
export function txLegendFor(els: cytoscape.ElementDefinition[], theme: Theme): LegendGroup[] {
  if (els.length === 0) return [];
  const has = present(els);
  return assemble(catalogue(theme), (g, id) => g === "tx" || (g !== "edge" && has.has(`${g}/${id}`)));
}

/** Every entry (the help page's "Reading the graph"), independent of what is on a canvas. */
export function fullLegendGroups(theme: Theme): LegendGroup[] {
  return assemble(catalogue(theme), () => true);
}
