import type cytoscape from "cytoscape";

let mainCy: cytoscape.Core | null = null;
/** Live tx-tab canvases by lowercased hash. */
const txCys = new Map<string, cytoscape.Core>();
/** Live call-tree canvases by lowercased hash (a tx tab's second canvas). */
const callCys = new Map<string, cytoscape.Core>();

/**
 * E2E hook: when the page URL has `?e2e=1`, live Cytoscape instances are exposed on
 * `window.__etherGraphCy` (address graph), `window.__etherGraphTxCy[hash]` (tx tabs) and
 * `window.__etherGraphCallCy[hash]` (their call trees), so
 * Playwright can read sizes/positions and drive taps (`cy.$id(id).emit("tap")`). The e2e suite
 * runs the production build, hence a runtime flag instead of a build-mode check.
 */
function e2eWindow(): {
  __etherGraphCy?: cytoscape.Core | null;
  __etherGraphTxCy?: Record<string, cytoscape.Core>;
  __etherGraphCallCy?: Record<string, cytoscape.Core>;
} | null {
  if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("e2e") !== "1") return null;
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

/** Registers (or with null, drops) a tx tab's Cytoscape instance; also exposed on the e2e hook. */
export function registerTxCy(hash: string, cy: cytoscape.Core | null): void {
  if (cy) txCys.set(hash.toLowerCase(), cy);
  else txCys.delete(hash.toLowerCase());
  const w = e2eWindow();
  if (!w) return;
  const all = (w.__etherGraphTxCy ??= {});
  if (cy) all[hash] = cy;
  else delete all[hash];
}

/** The live Cytoscape instance of the tx tab for `hash` (null when not mounted). */
export function getTxCy(hash: string): cytoscape.Core | null {
  return txCys.get(hash.toLowerCase()) ?? null;
}

/** Registers (or with null, drops) a tx tab's call-tree canvas; also exposed on the e2e hook. */
export function registerCallCy(hash: string, cy: cytoscape.Core | null): void {
  if (cy) callCys.set(hash.toLowerCase(), cy);
  else callCys.delete(hash.toLowerCase());
  const w = e2eWindow();
  if (!w) return;
  const all = (w.__etherGraphCallCy ??= {});
  if (cy) all[hash] = cy;
  else delete all[hash];
}

/** The live call-tree canvas of the tx tab for `hash` (null when not shown). */
export function getCallCy(hash: string): cytoscape.Core | null {
  return callCys.get(hash.toLowerCase()) ?? null;
}
