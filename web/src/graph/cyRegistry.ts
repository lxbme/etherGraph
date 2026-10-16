import type cytoscape from "cytoscape";

let mainCy: cytoscape.Core | null = null;

/**
 * E2E hook: when the page URL has `?e2e=1`, live Cytoscape instances are exposed on
 * `window.__etherGraphCy` (address graph) and `window.__etherGraphTxCy[hash]` (tx tabs), so
 * Playwright can read sizes/positions and drive taps (`cy.$id(id).emit("tap")`). The e2e suite
 * runs the production build, hence a runtime flag instead of a build-mode check.
 */
function e2eWindow(): { __etherGraphCy?: cytoscape.Core | null; __etherGraphTxCy?: Record<string, cytoscape.Core> } | null {
  if (typeof window === "undefined" || !new URLSearchParams(window.location.search).has("e2e")) return null;
  return window as never;
}

/** The live Cytoscape instance of the address graph (null when unmounted). */
export function setMainCy(cy: cytoscape.Core | null): void {
  mainCy = cy;
  const w = e2eWindow();
  if (w) w.__etherGraphCy = cy;
}
export function getMainCy(): cytoscape.Core | null {
  return mainCy;
}

/** Registers (or with null, drops) a tx tab's Cytoscape instance for the e2e hook; no-op otherwise. */
export function exposeTxCy(hash: string, cy: cytoscape.Core | null): void {
  const w = e2eWindow();
  if (!w) return;
  const all = (w.__etherGraphTxCy ??= {});
  if (cy) all[hash] = cy;
  else delete all[hash];
}
