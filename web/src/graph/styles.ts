import type cytoscape from "cytoscape";
import { ASSET_HEX } from "../lib/assets";

/** Fallbacks for the tokens in styles/tokens.css (used when CSS variables are unavailable, e.g. jsdom). */
const CAT_HEX = {
  exchange: "#3b7dd8",
  defi: "#8a5cd6",
  bridge: "#2a9d9d",
  mixer: "#e06a2b",
  scam: "#c23b3b",
  none: "#9aa3ad",
} as const;

const THEME_HEX = {
  light: { fg: "#1c2229", fgMuted: "#5f6b78", bg: "#f6f7f9", accent: "#4a9eff" },
  dark: { fg: "#e6e9ed", fgMuted: "#98a3b0", bg: "#14181d", accent: "#4a9eff" },
} as const;

const OTHER_EDGE = "#999999";
const USER_RING = "#ffffff";
/** Halo behind the white ring: dark on light backgrounds; the muted fg on dark ones. */
const USER_RING_HALO = { light: "#2b323a", dark: THEME_HEX.dark.fgMuted } as const;

/** Cytoscape cannot resolve `var(--x)`, so resolve the token to a concrete value now. */
function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Plain `{selector, style}` blocks; property names/values follow the Cytoscape 3.34 docs. */
type Block = { selector: string; style: Record<string, string | number> };

export function graphStylesheet(theme: "light" | "dark"): cytoscape.StylesheetJson {
  const t = THEME_HEX[theme];
  const fg = cssVar("--fg", t.fg);
  const fgMuted = cssVar("--fg-muted", t.fgMuted);
  const bg = cssVar("--bg", t.bg);
  const accent = cssVar("--accent", t.accent);
  const cat = (k: keyof typeof CAT_HEX) => cssVar(`--cat-${k}`, CAT_HEX[k]);
  const asset = (k: keyof typeof ASSET_HEX) => cssVar(`--asset-${k}`, ASSET_HEX[k]);
  const font = cssVar("--font-sans", "system-ui, sans-serif");

  const edgeColor = (c: string) => ({ "line-color": c, "target-arrow-color": c });

  const blocks: Block[] = [
    {
      selector: "node",
      style: {
        width: 28,
        height: 28,
        shape: "ellipse",
        "background-color": cat("none"),
        "border-width": 2,
        "border-style": "solid",
        "border-color": fgMuted,
        label: "data(text)",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 4,
        "text-wrap": "wrap",
        "text-max-width": "160px",
        "font-family": font,
        "font-size": 10,
        "line-height": 1.3,
        color: fg,
        "text-outline-color": bg,
        "text-outline-width": 2,
      },
    },
    { selector: "node.kind-eoa", style: { shape: "ellipse" } },
    { selector: "node.kind-contract", style: { shape: "round-rectangle" } },
    { selector: "node.kind-unknown", style: { shape: "diamond", width: 32, height: 32 } },
    { selector: "node.center", style: { width: 38, height: 38, "font-weight": "bold" } },
    { selector: "node.cat-exchange", style: { "background-color": cat("exchange") } },
    { selector: "node.cat-defi", style: { "background-color": cat("defi") } },
    { selector: "node.cat-bridge", style: { "background-color": cat("bridge") } },
    { selector: "node.cat-mixer", style: { "background-color": cat("mixer") } },
    { selector: "node.cat-scam, node.cat-sanctioned", style: { "background-color": cat("scam") } },
    { selector: "node.synced", style: { "border-style": "solid" } },
    { selector: "node.unsynced", style: { "border-style": "dashed" } },
    {
      selector: "node.user-label",
      style: {
        "outline-color": USER_RING,
        "outline-width": 3,
        "outline-offset": 1,
        "outline-opacity": 1,
        // A dark halo just outside the ring keeps it visible on the light background.
        "underlay-color": USER_RING_HALO[theme],
        "underlay-padding": 7,
        "underlay-opacity": 0.6,
        "underlay-shape": "ellipse",
      },
    },
    { selector: "node.user-label.kind-contract", style: { "underlay-shape": "round-rectangle" } },
    { selector: "node.selected, node:selected", style: { "border-width": 4, "border-color": accent } },

    {
      selector: "edge",
      style: {
        width: "data(width)",
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.8,
        ...edgeColor(OTHER_EDGE),
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
        "text-background-color": bg,
        "text-background-opacity": 0.85,
        "text-background-padding": "2px",
        "text-background-shape": "round-rectangle",
      },
    },
    { selector: "edge.asset-eth", style: edgeColor(asset("eth")) },
    { selector: "edge.asset-stable", style: edgeColor(asset("stable")) },
    { selector: "edge.asset-erc20", style: edgeColor(asset("erc20")) },
    { selector: "edge.asset-nft", style: edgeColor(asset("nft")) },
    { selector: "edge.asset-other", style: edgeColor(OTHER_EDGE) },
    { selector: "edge.selected, edge:selected", style: { ...edgeColor(accent), opacity: 1, "z-index": 9 } },
    {
      selector: "edge.highlighted",
      style: { ...edgeColor(accent), width: "mapData(width, 1, 8, 4, 11)", opacity: 1, "z-index": 10 },
    },
  ];
  // The bundled typings lag behind the runtime (e.g. they lack "round-rectangle" and outline-*).
  return blocks as unknown as cytoscape.StylesheetJson;
}
