import type cytoscape from "cytoscape";
import type { AssetClass } from "../lib/assets";

export type Theme = "light" | "dark";
export type NodeKind = "eoa" | "contract" | "unknown";
export type CategoryId =
  | "cex" | "dex" | "defi" | "bridge" | "mixer" | "scam" | "sanctioned" | "hacker" | "mev" | "fund" | "nft" | "staking" | "none";
export type CategoryColor = { fill: string; stroke: string };

/** Node shape per address kind. */
export const NODE_SHAPE: Record<NodeKind, string> = {
  eoa: "ellipse",
  contract: "round-rectangle",
  unknown: "hexagon",
};

/** Fallbacks for the tokens in styles/tokens.css (used when CSS variables are unavailable, e.g. jsdom). */
const THEME_HEX = {
  light: { fg: "#111827", fgMuted: "#6b7280", line: "#e3e6eb", bg: "#ffffff", canvas: "#fbfcfd", accent: "#1f5eff", warn: "#e8a317" },
  dark: { fg: "#e6e9ed", fgMuted: "#98a3b0", line: "#323a44", bg: "#14181d", canvas: "#10141a", accent: "#5b8cff", warn: "#f0b64a" },
} as const;

/** Category hues; "sanctioned" shares the scam hue. */
type CatToken = Exclude<CategoryId, "sanctioned">;
const CAT_HEX: Record<Theme, Record<CatToken, string>> = {
  light: {
    cex: "#2563c9", dex: "#4f46e5", defi: "#7c3aed", bridge: "#0f8a8a", mixer: "#c2570c", scam: "#d93025", hacker: "#9f1239",
    mev: "#0369a1", fund: "#a16207", nft: "#c026d3", staking: "#2f855a", none: "#6b7280",
  },
  dark: {
    cex: "#6ea3f0", dex: "#8b8cf5", defi: "#a98bf0", bridge: "#4cc2c2", mixer: "#f08a4b", scam: "#f0645a", hacker: "#e5577a",
    mev: "#4fb3e8", fund: "#e0b04a", nft: "#e07ae8", staking: "#5cc28a", none: "#98a3b0",
  },
};

/** Edge hue per asset class; "other" (unknown class, and tx call edges) is the one neutral grey. */
const ASSET_HEX: Record<Theme, Record<AssetClass | "other", string>> = {
  light: { eth: "#5b5bd6", stable: "#0f9d58", erc20: "#b7791f", nft: "#b8327f", other: "#868d98" },
  dark: { eth: "#9a9aff", stable: "#34c37a", erc20: "#e0a030", nft: "#e879c6", other: "#6b7280" },
};

/** The tx view's EIP-7702 "delegates to" edge: a cyan apart from the asset hues. */
const DELEGATION_HEX: Record<Theme, string> = { light: "#0e7490", dark: "#22b8cf" };

/** Share of the hue in a category tint; the rest is the node surface (white in light, the dark surface in dark). */
const TINT_WEIGHT: Record<Theme, number> = { light: 0.15, dark: 0.28 };
/** Per-character width and horizontal padding of the "+N more" pill. */
const MORE_CHAR_PX = 6.5;
const MORE_PAD_PX = 18;
/** Label length in Latin-glyph widths: CJK and other wide glyphs (above U+2E7F) take two. */
const moreLabelChars = (s: string): number => [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0x2e7f ? 2 : 1), 0);
/** The center node's ring stays white in both themes. */
const CENTER_RING = "#ffffff";

/**
 * Corner icons (lucide paths on a 24px grid) as data URIs, for node states. Each is a filled glyph with an
 * outline in the canvas colour so it reads over nodes and edges; the legend reuses them. encodeURIComponent
 * also keeps whitespace out of the URI: Cytoscape splits multi-image lists on it.
 */
const svgUri = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
      `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  )}`;

export type IconId = "tag" | "pin" | "syncing" | "partial";

/**
 * The state icons for `theme`, built from its tokens: tag (user label) and clock (syncing) in --accent,
 * pin (pinned) in --fg, and a half-filled circle (partial sync: a category hit the record cap) in --fg-muted,
 * neutral because a partial sync is not a risk.
 */
export function iconSvgs(theme: Theme): Record<IconId, string> {
  const t = THEME_HEX[theme];
  const accent = cssVar("--accent", t.accent);
  const outline = cssVar("--canvas", t.canvas);
  const pin = cssVar("--fg", t.fg);
  const muted = cssVar("--fg-muted", t.fgMuted);
  return {
    tag: svgUri(
      `<path fill="${accent}" stroke="${outline}" stroke-width="2" d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>` +
        `<circle cx="7.5" cy="7.5" r="1.5" fill="${outline}"/>`,
    ),
    pin: svgUri(
      `<path stroke="${outline}" stroke-width="5" d="M12 17v5"/>` +
        `<path fill="${pin}" stroke="${outline}" stroke-width="2" d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>` +
        `<path stroke="${pin}" stroke-width="2.5" d="M12 17v5"/>`,
    ),
    syncing: svgUri(
      `<circle cx="12" cy="12" r="10" fill="${accent}" stroke="${outline}" stroke-width="2"/>` +
        `<path stroke="${outline}" stroke-width="2" d="M12 6v6l4 2"/>`,
    ),
    // A canvas-coloured disc as the outline, a muted ring, and its lower half filled.
    partial: svgUri(
      `<circle cx="12" cy="12" r="11" fill="${outline}"/>` +
        `<circle cx="12" cy="12" r="9" fill="${outline}" stroke="${muted}" stroke-width="2"/>` +
        `<path fill="${muted}" d="M3 12a9 9 0 0 0 18 0z"/>`,
    ),
  };
}

/** Corner icon per state class, in drawing order; x/y pick the corner the icon hangs off. */
const BADGES = [
  { cls: "user-label", icon: "tag", x: "100%", y: "0%" },
  { cls: "pinned", icon: "pin", x: "0%", y: "0%" },
  { cls: "syncing", icon: "syncing", x: "100%", y: "100%" },
  { cls: "partial", icon: "partial", x: "0%", y: "100%" },
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
    cex: tinted("cex"),
    dex: tinted("dex"),
    defi: tinted("defi"),
    bridge: tinted("bridge"),
    mixer: tinted("mixer"),
    scam,
    sanctioned: scam,
    hacker: tinted("hacker"),
    mev: tinted("mev"),
    fund: tinted("fund"),
    nft: tinted("nft"),
    staking: tinted("staking"),
    none: { fill: surface, stroke: cssVar("--cat-none", CAT_HEX[theme].none) },
  };
}

/** Edge colour per asset class. */
export function assetColors(theme: Theme): Record<AssetClass | "other", string> {
  const asset = (k: AssetClass | "other") => cssVar(`--asset-${k}`, ASSET_HEX[theme][k]);
  return { eth: asset("eth"), stable: asset("stable"), erc20: asset("erc20"), nft: asset("nft"), other: asset("other") };
}

/** The canvas background (--canvas): the backdrop of an exported image. */
export function canvasColor(theme: Theme): string {
  return cssVar("--canvas", THEME_HEX[theme].canvas);
}

/** The muted foreground (--fg-muted): token-contract nodes and their dotted links in the tx view. */
export function mutedColor(theme: Theme): string {
  return cssVar("--fg-muted", THEME_HEX[theme].fgMuted);
}

/** The warning amber darkened enough to read as label text on the canvas (3:1), per theme. */
const TRUST_SUSPICIOUS_HEX: Record<Theme, string> = { light: "#a8791c", dark: "#f0b64a" };

/**
 * Label colour of an edge carrying a flagged token: the warning amber (--trust-suspicious, readable on the canvas)
 * for a possible impersonation, the scam hue for a known scam.
 */
export function trustColors(theme: Theme): { suspicious: string; scam: string } {
  return { suspicious: cssVar("--trust-suspicious", TRUST_SUSPICIOUS_HEX[theme]), scam: cssVar("--cat-scam", CAT_HEX[theme].scam) };
}

/** Colour of the tx view's delegation edges. */
export function delegationColor(theme: Theme): string {
  return cssVar("--tx-delegation", DELEGATION_HEX[theme]);
}

/** Fills and strokes of the state encodings that are not a category or an icon. */
export function stateColors(theme: Theme): { center: CategoryColor; selectedRing: string; more: CategoryColor } {
  const t = THEME_HEX[theme];
  const accent = cssVar("--accent", t.accent);
  return {
    center: { fill: accent, stroke: CENTER_RING },
    selectedRing: accent,
    // --fg-muted, not --line: the dashed outline must read on the canvas.
    more: { fill: cssVar("--canvas", t.canvas), stroke: cssVar("--fg-muted", t.fgMuted) },
  };
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
const badgeStyle = (icons: Record<IconId, string>): Block["style"] => ({
  "background-image": perBadge((b) => icons[b.icon]),
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
});

const edgeColor = (c: string) => ({ "line-color": c, "target-arrow-color": c });
const catStyle = (c: CategoryColor) => ({ "background-color": c.fill, "border-color": c.stroke });

function graphBlocks(theme: Theme): Block[] {
  const t = THEME_HEX[theme];
  const fg = cssVar("--fg", t.fg);
  const canvas = cssVar("--canvas", t.canvas);
  const accent = cssVar("--accent", t.accent);
  const line = cssVar("--line", t.line);
  const fgMuted = cssVar("--fg-muted", t.fgMuted);
  const font = cssVar("--font-sans", "Inter, system-ui, sans-serif");
  const cat = categoryColors(theme);
  const asset = assetColors(theme);
  const state = stateColors(theme);
  const badge = badgeStyle(iconSvgs(theme));
  const trust = trustColors(theme);

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
    { selector: "node.cat-cex", style: catStyle(cat.cex) },
    { selector: "node.cat-dex", style: catStyle(cat.dex) },
    { selector: "node.cat-defi", style: catStyle(cat.defi) },
    { selector: "node.cat-bridge", style: catStyle(cat.bridge) },
    { selector: "node.cat-mixer", style: catStyle(cat.mixer) },
    { selector: "node.cat-scam, node.cat-sanctioned", style: catStyle(cat.scam) },
    { selector: "node.cat-hacker", style: catStyle(cat.hacker) },
    { selector: "node.cat-mev", style: catStyle(cat.mev) },
    { selector: "node.cat-fund", style: catStyle(cat.fund) },
    { selector: "node.cat-nft", style: catStyle(cat.nft) },
    { selector: "node.cat-staking", style: catStyle(cat.staking) },
    // After the categories so the center keeps its accent fill whatever its label.
    {
      selector: "node.center",
      style: {
        width: 38,
        height: 38,
        "background-color": state.center.fill,
        "border-color": state.center.stroke,
        "border-width": 3,
        "font-weight": 600,
      },
    },
    { selector: "node.synced", style: { "border-style": "solid" } },
    { selector: "node.unsynced", style: { "border-style": "dashed" } },
    // Corner icons for user label, pinned, syncing and partial; each block composes all of them.
    ...BADGES.map((b) => ({ selector: `node.${b.cls}`, style: badge })),
    // The "+N more" pill: canvas fill, dashed outline, the label inside; after the categories and states.
    {
      selector: "node.more",
      style: {
        shape: "round-rectangle",
        // `width: "label"` is deprecated; an estimate from the text length (11px font) is close enough.
        width: (ele) => moreLabelChars(String(ele.data("label") ?? "")) * MORE_CHAR_PX + MORE_PAD_PX,
        height: 22,
        "background-color": state.more.fill,
        "border-color": state.more.stroke,
        "border-width": 1,
        "border-style": "dashed",
        label: "data(label)",
        "text-valign": "center",
        "text-margin-y": 0,
        "text-outline-width": 0,
        "font-size": 11,
        color: fgMuted,
      },
    },
    {
      // The box selection (native :selected): a thicker dashed ring, so it never reads as the detail selection.
      selector: "node:selected",
      style: { "outline-color": state.selectedRing, "outline-style": "dashed", "outline-width": 3, "outline-offset": 2, "outline-opacity": 1 },
    },
    {
      // The detail selection: a solid ring outside the border, so the node keeps its own fill and stroke (the center's white ring too). Wins over the box ring.
      selector: "node.selected",
      style: { "outline-color": state.selectedRing, "outline-style": "solid", "outline-width": 2, "outline-offset": 2, "outline-opacity": 1 },
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
        "font-size": 11,
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
    {
      selector: "edge.more",
      style: { width: 1, "line-style": "dashed", "target-arrow-shape": "none", ...edgeColor(line), opacity: 1 },
    },
    { selector: "edge.asset-eth", style: edgeColor(asset.eth) },
    { selector: "edge.asset-stable", style: edgeColor(asset.stable) },
    { selector: "edge.asset-erc20", style: edgeColor(asset.erc20) },
    { selector: "edge.asset-nft", style: edgeColor(asset.nft) },
    { selector: "edge.asset-other", style: edgeColor(asset.other) },
    // A flagged token keeps its asset hue on the line; its ⚠ label takes the warning colour.
    { selector: "edge.asset-suspicious", style: { color: trust.suspicious } },
    { selector: "edge.asset-scam", style: { color: trust.scam } },
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

/**
 * The tx fund-flow view: the graph stylesheet plus edge labels, the dashed call edge (a loop on a self-call),
 * muted token-contract nodes with their dotted links, and the EIP-7702 delegation edges.
 */
export function txFlowStylesheet(theme: Theme): cytoscape.StylesheetJson {
  const canvas = cssVar("--canvas", THEME_HEX[theme].canvas);
  const fgMuted = mutedColor(theme);
  const delegation = delegationColor(theme);
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
    {
      // The method is already in the summary bar: a smaller label near the sender keeps mid-edge flow labels clear.
      selector: "edge.call",
      style: {
        "line-style": "dashed",
        ...edgeColor(assetColors(theme).other),
        label: "",
        "source-label": "data(label)",
        "source-text-offset": 56,
        "source-text-rotation": "autorotate",
        "source-text-margin-y": -8,
        "font-size": 10,
      },
    },
    {
      // A call to the sender itself (an EIP-7702 batch): a wide, narrow loop to the left, outside a self-transfer's
      // loop (upper left, the default) and clear of the flows leaving to the right; its method a plain label at its tip.
      selector: "edge.self-call",
      style: {
        label: "data(label)",
        "source-label": "",
        "text-rotation": "none",
        // Centred on the loop's tip by default: shift the label left of it by about half its width (10px type).
        "text-margin-x": (ele) => -(String(ele.data("label") ?? "").length * 3 + 6),
        "loop-direction": "-90deg",
        "loop-sweep": "-50deg",
        "control-point-step-size": 64,
      },
    },
    {
      // A token contract that only emitted Transfer logs: muted fill, a thin dotted outline and a muted label.
      selector: "node.asset-contract",
      style: {
        "background-opacity": 0.5,
        "border-style": "dotted",
        "border-width": 1,
        "border-color": fgMuted,
        color: fgMuted,
      },
    },
    {
      selector: "edge.asset-link",
      style: {
        width: 1,
        "line-style": "dotted",
        "target-arrow-shape": "none",
        ...edgeColor(fgMuted),
        opacity: 0.6,
        // Under the flow, call and delegation edges it would otherwise cross.
        "z-index": -1,
      },
    },
    {
      selector: "edge.delegation",
      style: {
        "line-style": "dashed",
        ...edgeColor(delegation),
        color: delegation,
        "font-size": 10,
      },
    },
  ]);
}
