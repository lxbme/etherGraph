import type cytoscape from "cytoscape";
import type { AssetClass } from "../lib/assets";

export type Theme = "light" | "dark";
export type NodeKind = "eoa" | "contract" | "unknown";
export type CategoryId = "exchange" | "defi" | "bridge" | "mixer" | "scam" | "sanctioned" | "none";
export type CategoryColor = { fill: string; stroke: string };

/** Node shape per address kind. */
export const NODE_SHAPE: Record<NodeKind, string> = {
  eoa: "ellipse",
  contract: "round-rectangle",
  unknown: "hexagon",
};

/** Fallbacks for the tokens in styles/tokens.css (used when CSS variables are unavailable, e.g. jsdom). */
const THEME_HEX = {
  light: { fg: "#111827", fgMuted: "#6b7280", bg: "#ffffff", canvas: "#fbfcfd", accent: "#1f5eff" },
  dark: { fg: "#e6e9ed", fgMuted: "#98a3b0", bg: "#14181d", canvas: "#10141a", accent: "#5b8cff" },
} as const;

/** Category hues; "sanctioned" shares the scam hue. */
type CatToken = Exclude<CategoryId, "sanctioned">;
const CAT_HEX: Record<Theme, Record<CatToken, string>> = {
  light: { exchange: "#2563c9", defi: "#7c3aed", bridge: "#0f8a8a", mixer: "#c2570c", scam: "#d93025", none: "#6b7280" },
  dark: { exchange: "#6ea3f0", defi: "#a98bf0", bridge: "#4cc2c2", mixer: "#f08a4b", scam: "#f0645a", none: "#98a3b0" },
};

const ASSET_HEX: Record<Theme, Record<AssetClass, string>> = {
  light: { eth: "#5b5bd6", stable: "#0f9d58", erc20: "#b7791f", nft: "#6b7280" },
  dark: { eth: "#9a9aff", stable: "#34c37a", erc20: "#e0a030", nft: "#98a3b0" },
};
/** Edges whose asset class is unknown (and tx call edges): a neutral grey with no token of its own. */
const OTHER_EDGE: Record<Theme, string> = { light: "#9ca3af", dark: "#6b7280" };

/** Share of the hue in a category tint; the rest is the node surface (white in light, the dark surface in dark). */
const TINT_WEIGHT: Record<Theme, number> = { light: 0.15, dark: 0.28 };
/** The center node's ring stays white in both themes. */
const CENTER_RING = "#ffffff";

/**
 * Corner icons (lucide paths on a 24px grid) as data URIs, for node states. Each is a filled glyph with a
 * white outline so it reads on either canvas and over edges; plan 4's legend reuses them.
 */
const svgUri = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
      `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  )}`;
const OUTLINE = '#ffffff';

/** User label: lucide `tag` in the accent. */
export const TAG_ICON_SVG = svgUri(
  `<path fill="#1f5eff" stroke="${OUTLINE}" stroke-width="2" d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>` +
    `<circle cx="7.5" cy="7.5" r="1.5" fill="${OUTLINE}"/>`,
);
/** Pinned: lucide `pin` in a dark neutral. */
export const PIN_ICON_SVG = svgUri(
  `<path stroke="${OUTLINE}" stroke-width="5" d="M12 17v5"/>` +
    `<path fill="#374151" stroke="${OUTLINE}" stroke-width="2" d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>` +
    `<path stroke="#374151" stroke-width="2.5" d="M12 17v5"/>`,
);
/** Syncing: lucide `clock` in the accent. */
export const SYNCING_ICON_SVG = svgUri(
  `<circle cx="12" cy="12" r="10" fill="#1f5eff" stroke="${OUTLINE}" stroke-width="2"/>` +
    `<path stroke="${OUTLINE}" stroke-width="2" d="M12 6v6l4 2"/>`,
);
/** Partial (a category hit the record cap): lucide `triangle-alert` in --warn. */
export const PARTIAL_ICON_SVG = svgUri(
  `<path fill="#e8a317" stroke="${OUTLINE}" stroke-width="2" d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>` +
    `<path stroke="#111827" stroke-width="2" d="M12 9v4"/><path stroke="#111827" stroke-width="2" d="M12 17h.01"/>`,
);

/** Corner icon per state class, in drawing order; x/y pick the corner the icon hangs off. */
const BADGES = [
  { cls: "user-label", svg: TAG_ICON_SVG, x: "100%", y: "0%" },
  { cls: "pinned", svg: PIN_ICON_SVG, x: "0%", y: "0%" },
  { cls: "syncing", svg: SYNCING_ICON_SVG, x: "100%", y: "100%" },
  { cls: "partial", svg: PARTIAL_ICON_SVG, x: "0%", y: "100%" },
] as const;
type Badge = (typeof BADGES)[number];
/** Icon size and how far it sticks out past the node's corner, in px. */
const BADGE_SIZE = 11;
const BADGE_OVERHANG = 6;
const LABEL_GAP = 4;
/** Label gap below a node with a bottom icon, so the icon does not sit on the text. */
const LABEL_GAP_BELOW_BADGE = 8;

/** Cytoscape cannot resolve `var(--x)`, so resolve the token to a concrete value now. */
function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((x) => x + x).join("") : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** `weight` of `hue` over `base` (like `color-mix(in srgb, hue weight, base)`); hex only, otherwise `base`. */
function mixHex(hue: string, base: string, weight: number): string {
  const a = parseHex(hue);
  const b = parseHex(base);
  if (!a || !b) return base;
  return `#${a.map((v, i) => Math.round(v * weight + b[i]! * (1 - weight)).toString(16).padStart(2, "0")).join("")}`;
}

/** Fill (a light tint of the hue on the node surface) and stroke (the hue) per category; "none" is plain. */
export function categoryColors(theme: Theme): Record<CategoryId, CategoryColor> {
  const surface = cssVar("--bg", THEME_HEX[theme].bg);
  const tinted = (k: CatToken): CategoryColor => {
    const stroke = cssVar(`--cat-${k}`, CAT_HEX[theme][k]);
    return { fill: mixHex(stroke, surface, TINT_WEIGHT[theme]), stroke };
  };
  const scam = tinted("scam");
  return {
    exchange: tinted("exchange"),
    defi: tinted("defi"),
    bridge: tinted("bridge"),
    mixer: tinted("mixer"),
    scam,
    sanctioned: scam,
    none: { fill: surface, stroke: cssVar("--cat-none", CAT_HEX[theme].none) },
  };
}

/** Edge colour per asset class. */
export function assetColors(theme: Theme): Record<AssetClass | "other", string> {
  const asset = (k: AssetClass) => cssVar(`--asset-${k}`, ASSET_HEX[theme][k]);
  return { eth: asset("eth"), stable: asset("stable"), erc20: asset("erc20"), nft: asset("nft"), other: OTHER_EDGE[theme] };
}

/** Plain `{selector, style}` blocks; property names/values follow the Cytoscape 3.34 docs. */
type StyleFn = (ele: cytoscape.NodeSingular) => unknown;
type Block = { selector: string; style: Record<string, string | number | StyleFn> };

const badgesOf = (ele: cytoscape.NodeSingular) => BADGES.filter((b) => ele.hasClass(b.cls));
/** One value per icon the node shows: Cytoscape's multi-image properties are parallel lists. */
const perBadge = (f: (b: Badge) => string | number): StyleFn => (ele) => badgesOf(ele).map(f);
const away = (pos: "0%" | "100%") => (pos === "0%" ? -BADGE_OVERHANG : BADGE_OVERHANG);

/**
 * The state icons, composed from the node's classes. Every list property is given in full, since
 * Cytoscape falls back to its own defaults (e.g. a clipped, centered image) for missing entries.
 */
const BADGE_STYLE: Block["style"] = {
  "background-image": perBadge((b) => b.svg),
  "background-width": perBadge(() => BADGE_SIZE),
  "background-height": perBadge(() => BADGE_SIZE),
  "background-position-x": perBadge((b) => b.x),
  "background-position-y": perBadge((b) => b.y),
  "background-offset-x": perBadge((b) => away(b.x)),
  "background-offset-y": perBadge((b) => away(b.y)),
  "background-clip": perBadge(() => "none"),
  "background-image-containment": perBadge(() => "over"),
  "bounds-expansion": BADGE_OVERHANG,
  "text-margin-y": (ele) => (badgesOf(ele).some((b) => b.y === "100%") ? LABEL_GAP_BELOW_BADGE : LABEL_GAP),
};

const edgeColor = (c: string) => ({ "line-color": c, "target-arrow-color": c });
const catStyle = (c: CategoryColor) => ({ "background-color": c.fill, "border-color": c.stroke });

function graphBlocks(theme: Theme): Block[] {
  const t = THEME_HEX[theme];
  const fg = cssVar("--fg", t.fg);
  const canvas = cssVar("--canvas", t.canvas);
  const accent = cssVar("--accent", t.accent);
  const font = cssVar("--font-sans", "Inter, system-ui, sans-serif");
  const cat = categoryColors(theme);
  const asset = assetColors(theme);

  return [
    {
      selector: "node",
      style: {
        width: 28,
        height: 28,
        shape: NODE_SHAPE.eoa,
        ...catStyle(cat.none),
        "border-width": 1.5,
        "border-style": "solid",
        label: "data(text)",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": LABEL_GAP,
        "text-wrap": "wrap",
        "text-max-width": "160px",
        "font-family": font,
        "font-size": 12,
        "line-height": 1.3,
        color: fg,
        "text-outline-color": canvas,
        "text-outline-width": 2,
      },
    },
    { selector: "node.kind-eoa", style: { shape: NODE_SHAPE.eoa } },
    { selector: "node.kind-contract", style: { shape: NODE_SHAPE.contract } },
    { selector: "node.kind-unknown", style: { shape: NODE_SHAPE.unknown, width: 32, height: 32 } },
    { selector: "node.cat-exchange", style: catStyle(cat.exchange) },
    { selector: "node.cat-defi", style: catStyle(cat.defi) },
    { selector: "node.cat-bridge", style: catStyle(cat.bridge) },
    { selector: "node.cat-mixer", style: catStyle(cat.mixer) },
    { selector: "node.cat-scam, node.cat-sanctioned", style: catStyle(cat.scam) },
    // After the categories so the center keeps its accent fill whatever its label.
    {
      selector: "node.center",
      style: {
        width: 38,
        height: 38,
        "background-color": accent,
        "border-color": CENTER_RING,
        "border-width": 3,
        "font-weight": 600,
      },
    },
    { selector: "node.synced", style: { "border-style": "solid" } },
    { selector: "node.unsynced", style: { "border-style": "dashed" } },
    // Corner icons for user label, pinned, syncing and partial; each block composes all of them.
    ...BADGES.map((b) => ({ selector: `node.${b.cls}`, style: BADGE_STYLE })),
    {
      // A ring outside the border, so the selected node keeps its own fill and stroke (the center's white ring too).
      selector: "node.selected, node:selected",
      style: { "outline-color": accent, "outline-width": 2, "outline-offset": 2, "outline-opacity": 1 },
    },

    {
      selector: "edge",
      style: {
        width: "data(width)",
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.8,
        ...edgeColor(asset.other),
        opacity: 0.85,
        "font-family": font,
        "font-size": 9,
        color: fg,
      },
    },
    {
      selector: "edge[badge]",
      style: {
        label: "data(badge)",
        "text-background-color": canvas,
        "text-background-opacity": 0.85,
        "text-background-padding": "2px",
        "text-background-shape": "round-rectangle",
      },
    },
    { selector: "edge.asset-eth", style: edgeColor(asset.eth) },
    { selector: "edge.asset-stable", style: edgeColor(asset.stable) },
    { selector: "edge.asset-erc20", style: edgeColor(asset.erc20) },
    { selector: "edge.asset-nft", style: edgeColor(asset.nft) },
    { selector: "edge.asset-other", style: edgeColor(asset.other) },
    { selector: "edge.selected, edge:selected", style: { ...edgeColor(accent), opacity: 1, "z-index": 9 } },
    {
      selector: "edge.highlighted",
      style: { ...edgeColor(accent), width: "mapData(width, 1, 8, 4, 11)", opacity: 1, "z-index": 10 },
    },
  ];
}

// The bundled typings lag behind the runtime (e.g. they lack "round-rectangle" and some background-* props).
const asStylesheet = (blocks: Block[]) => blocks as unknown as cytoscape.StylesheetJson;

export function graphStylesheet(theme: Theme): cytoscape.StylesheetJson {
  return asStylesheet(graphBlocks(theme));
}

/** The tx fund-flow view: the graph stylesheet plus edge labels and the dashed call edge. */
export function txFlowStylesheet(theme: Theme): cytoscape.StylesheetJson {
  const canvas = cssVar("--canvas", THEME_HEX[theme].canvas);
  return asStylesheet([
    ...graphBlocks(theme),
    {
      selector: "edge[label]",
      style: {
        label: "data(label)",
        "text-background-color": canvas,
        "text-background-opacity": 0.85,
        "text-background-padding": "2px",
        "text-background-shape": "round-rectangle",
        "text-rotation": "autorotate",
      },
    },
    { selector: "edge.call", style: { "line-style": "dashed", ...edgeColor(assetColors(theme).other) } },
  ]);
}
