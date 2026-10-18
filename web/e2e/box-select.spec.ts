import type { Page } from "@playwright/test";
import { expectLaidOut, snapshot, type CySnapshot } from "./cy";
import { A, expect, test, type MockApi } from "./mockApi";

const GRAPH = "POST /api/graph/edges";
type Box = { x1: number; y1: number; x2: number; y2: number };
type Pt = { x: number; y: number };

/** Model positions of the address graph's nodes. */
function positions(page: Page): Promise<Record<string, Pt>> {
  return page.evaluate(() => {
    const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy!;
    return Object.fromEntries(cy.nodes().map((n) => [n.id(), { ...n.position() }]));
  });
}

/** Positions once nothing moves any more (the incremental layout animates small graphs). */
async function settled(page: Page): Promise<Record<string, Pt>> {
  let last = await positions(page);
  await expect(async () => {
    await page.waitForTimeout(250);
    const cur = await positions(page);
    const same = JSON.stringify(cur) === JSON.stringify(last);
    last = cur;
    expect(same, "layout settled").toBe(true);
  }).toPass({ timeout: 5000 });
  return last;
}

const intersects = (a: Box, b: Box) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2;
/** Distance from p to the segment ab. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Two nodes and a drag box (container coordinates) around exactly them, starting on empty canvas
 * (no node, not on an edge line).
 */
function pickPair(s: CySnapshot): { ids: [string, string]; from: Pt; to: Pt } {
  const centre = (b: Box): Pt => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const M = 24;
  for (const a of s.nodes) {
    for (const b of s.nodes) {
      if (a.id >= b.id) continue;
      const box = { x1: Math.min(a.x1, b.x1) - M, y1: Math.min(a.y1, b.y1) - M, x2: Math.max(a.x2, b.x2) + M, y2: Math.max(a.y2, b.y2) + M };
      if (s.nodes.some((n) => n !== a && n !== b && intersects(n, box))) continue;
      const corners: [Pt, Pt][] = [
        [{ x: box.x1, y: box.y1 }, { x: box.x2, y: box.y2 }],
        [{ x: box.x2, y: box.y2 }, { x: box.x1, y: box.y1 }],
        [{ x: box.x1, y: box.y2 }, { x: box.x2, y: box.y1 }],
        [{ x: box.x2, y: box.y1 }, { x: box.x1, y: box.y2 }],
      ];
      for (const [from, to] of corners) {
        const inside = from.x > 0 && from.y > 0 && from.x < s.width && from.y < s.height && to.x > 0 && to.y > 0 && to.x < s.width && to.y < s.height;
        const offEdges = s.edges.every((e) => {
          const p = byId.get(e.source);
          const q = byId.get(e.target);
          return !p || !q || segDist(from, centre(p), centre(q)) > 12;
        });
        if (inside && offEdges) return { ids: [a.id, b.id], from, to };
      }
    }
  }
  throw new Error("no pair of nodes can be boxed alone");
}

const selectedIds = (page: Page) =>
  page.evaluate(() => {
    const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy!;
    return cy.nodes(":selected").map((n) => n.id()).sort();
  });

/** Opens the mocked graph of A and waits until its layout settled. */
async function openGraph(page: Page, mock: MockApi): Promise<Record<string, Pt>> {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(A);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect.poll(() => mock.count(GRAPH)).toBeGreaterThan(0);
  await expectLaidOut(page, "main", 4);
  return settled(page);
}

/** Shift+drags a box around exactly two nodes with the real mouse; returns their ids and a page-coordinate centre lookup. */
async function boxTwo(page: Page) {
  const s = (await snapshot(page, "main"))!;
  const { ids, from, to } = pickPair(s);
  const origin = await page.getByTestId("address-graph").locator(".cy-view").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  await page.keyboard.down("Shift");
  await page.mouse.move(origin.x + from.x, origin.y + from.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + to.x, origin.y + to.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.getByRole("toolbar", { name: "Batch actions" })).toContainText("2 nodes selected");
  expect(await selectedIds(page)).toEqual([...ids].sort());
  const centre = (id: string) => {
    const n = s.nodes.find((x) => x.id === id)!;
    return { x: origin.x + (n.x1 + n.x2) / 2, y: origin.y + (n.y1 + n.y2) / 2 };
  };
  return { ids, centre };
}

test("Shift+drag boxes two nodes; dragging one moves both (one undo step); Escape clears it", async ({ page, mock }) => {
  const before = await openGraph(page, mock);
  const { ids, centre } = await boxTwo(page);
  const bar = page.getByRole("toolbar", { name: "Batch actions" });

  // Drag one of them: both move by the same amount.
  const { x: gx, y: gy } = centre(ids[0]);
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 60, gy + 40, { steps: 8 });
  await page.mouse.up();
  const moved = await positions(page);
  const d0 = { x: moved[ids[0]]!.x - before[ids[0]]!.x, y: moved[ids[0]]!.y - before[ids[0]]!.y };
  const d1 = { x: moved[ids[1]]!.x - before[ids[1]]!.x, y: moved[ids[1]]!.y - before[ids[1]]!.y };
  expect(Math.hypot(d0.x, d0.y)).toBeGreaterThan(10);
  expect(d1.x).toBeCloseTo(d0.x, 3);
  expect(d1.y).toBeCloseTo(d0.y, 3);
  for (const id of Object.keys(before).filter((id) => !ids.includes(id))) expect(moved[id]).toEqual(before[id]);
  await expect(bar).toContainText("2 nodes selected"); // a drag is not a tap: the selection stays

  // Escape clears the selection, on the canvas too.
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy!.nodes(":selected").length))
    .toBe(0);

  // The group move was one step: one undo puts both back.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => {
    const p = await positions(page);
    return ids.map((id) => [Math.round(p[id]!.x), Math.round(p[id]!.y)]);
  }).toEqual(ids.map((id) => [Math.round(before[id]!.x), Math.round(before[id]!.y)]));
  expect(mock.unhandled).toEqual([]);
});

test("a plain click on a node after a box drops the box selection and selects that node alone", async ({ page, mock }) => {
  await openGraph(page, mock);
  const { ids, centre } = await boxTwo(page);
  const p = centre(ids[1]);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByRole("toolbar", { name: "Batch actions" })).toBeHidden();
  await expect.poll(() => selectedIds(page)).toEqual([]);
  await expect(page.locator(".detail__addr")).toContainText(ids[1]);
});

test("Escape with the Filter popover open closes only the popover; a second Escape clears the selection", async ({ page, mock }) => {
  await openGraph(page, mock);
  await boxTwo(page);
  const bar = page.getByRole("toolbar", { name: "Batch actions" });
  const filter = page.getByRole("button", { name: /Filter/ });
  await filter.click();
  await expect(page.getByRole("dialog", { name: "Filter" })).toBeVisible();
  await expect(filter).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Filter" })).toBeHidden();
  await page.waitForTimeout(200);
  await expect(bar).toBeVisible();
  expect(await selectedIds(page)).toHaveLength(2);
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect.poll(() => selectedIds(page)).toEqual([]);
  expect(mock.unhandled).toEqual([]);
});
