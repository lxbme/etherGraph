import { expect, type Page } from "@playwright/test";

/**
 * Probes of the live Cytoscape instances, through the `?e2e=1` hook in src/graph/cyRegistry.ts:
 * `window.__etherGraphCy` (address graph) and `window.__etherGraphTxCy[hash]` (tx tabs).
 */
export type Which = "main" | { tx: string };

export interface CySnapshot {
  /** Cytoscape's idea of the viewport size. */
  width: number;
  height: number;
  /** The container element's actual size. */
  containerWidth: number;
  containerHeight: number;
  zoom: number;
  /** Rendered (viewport-relative) node boxes, labels excluded. */
  nodes: { id: string; x1: number; y1: number; x2: number; y2: number }[];
  edges: { id: string; source: string; target: string }[];
}

export function snapshot(page: Page, which: Which): Promise<CySnapshot | null> {
  return page.evaluate((w) => {
    type Core = import("cytoscape").Core;
    const win = window as unknown as { __etherGraphCy?: Core | null; __etherGraphTxCy?: Record<string, Core> };
    const cy = w === "main" ? win.__etherGraphCy : win.__etherGraphTxCy?.[w.tx];
    if (!cy || cy.destroyed()) return null;
    const el = cy.container()!;
    return {
      width: cy.width(),
      height: cy.height(),
      containerWidth: el.clientWidth,
      containerHeight: el.clientHeight,
      zoom: cy.zoom(),
      nodes: cy.nodes().map((n) => {
        const b = n.renderedBoundingBox({ includeLabels: false });
        return { id: n.id(), x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
      }),
      edges: cy.edges().map((e) => ({ id: e.id(), source: e.data("source"), target: e.data("target") })),
    };
  }, which);
}

/** Waits until the canvas has a real size, matches its container, and shows every node inside the viewport. */
export async function expectLaidOut(page: Page, which: Which, nodeCount: number): Promise<CySnapshot> {
  let last: CySnapshot | null = null;
  await expect(async () => {
    const s = await snapshot(page, which);
    last = s;
    expect(s, "cytoscape instance exposed").not.toBeNull();
    expect(s!.nodes).toHaveLength(nodeCount);
    expect(s!.containerWidth).toBeGreaterThan(100);
    expect(s!.containerHeight).toBeGreaterThan(100);
    // A stale size (e.g. measured while hidden) shows up as a mismatch with the container.
    expect(Math.abs(s!.width - s!.containerWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(s!.height - s!.containerHeight)).toBeLessThanOrEqual(1);
    for (const n of s!.nodes) {
      expect(n.x1, `${n.id} left`).toBeGreaterThanOrEqual(0);
      expect(n.y1, `${n.id} top`).toBeGreaterThanOrEqual(0);
      expect(n.x2, `${n.id} right`).toBeLessThanOrEqual(s!.width);
      expect(n.y2, `${n.id} bottom`).toBeLessThanOrEqual(s!.height);
      // Not a "tiny graph": nodes are drawn at a readable size.
      expect(n.x2 - n.x1, `${n.id} width`).toBeGreaterThan(8);
    }
  }).toPass({ timeout: 10_000 });
  return last!;
}

/** Emits a Cytoscape `tap` on a node, as a click on it would. */
export async function tapNode(page: Page, which: Which, id: string): Promise<void> {
  const ok = await page.evaluate(
    ({ w, id }) => {
      type Core = import("cytoscape").Core;
      const win = window as unknown as { __etherGraphCy?: Core | null; __etherGraphTxCy?: Record<string, Core> };
      const cy = w === "main" ? win.__etherGraphCy : win.__etherGraphTxCy?.[w.tx];
      const n = cy?.$id(id);
      if (!n || n.empty()) return false;
      n.emit("tap");
      return true;
    },
    { w: which, id },
  );
  expect(ok, `node ${id} exists`).toBe(true);
}

/** Emits a `tap` on the empty canvas (the core), as a click on the background would. */
export async function tapBackground(page: Page, which: Which): Promise<void> {
  const ok = await page.evaluate((w) => {
    type Core = import("cytoscape").Core;
    const win = window as unknown as { __etherGraphCy?: Core | null; __etherGraphTxCy?: Record<string, Core> };
    const cy = w === "main" ? win.__etherGraphCy : win.__etherGraphTxCy?.[w.tx];
    cy?.emit("tap");
    return !!cy;
  }, which);
  expect(ok, "cytoscape instance exposed").toBe(true);
}

/** Emits a `tap` on the (first) visual edge from `source` to `target`. */
export async function tapEdge(page: Page, source: string, target: string): Promise<void> {
  const ok = await page.evaluate(
    ({ source, target }) => {
      type Core = import("cytoscape").Core;
      const cy = (window as unknown as { __etherGraphCy?: Core | null }).__etherGraphCy;
      const e = cy?.edges().filter((x) => x.data("source") === source && x.data("target") === target);
      if (!e || e.empty()) return false;
      e.first().emit("tap");
      return true;
    },
    { source, target },
  );
  expect(ok, `edge ${source}→${target} exists`).toBe(true);
}

/** Page (viewport) coordinates of a node's centre on the address graph. */
export async function nodeScreenPos(page: Page, id: string): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate((id) => {
    type Core = import("cytoscape").Core;
    const cy = (window as unknown as { __etherGraphCy?: Core | null }).__etherGraphCy;
    const n = cy?.$id(id);
    if (!cy || !n || n.empty()) return null;
    const r = cy.container()!.getBoundingClientRect();
    const p = n.renderedPosition();
    return { x: r.left + p.x, y: r.top + p.y };
  }, id);
  expect(pos, `node ${id} exists`).not.toBeNull();
  return pos!;
}
