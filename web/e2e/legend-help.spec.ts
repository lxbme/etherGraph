import { expectLaidOut, nodeScreenPos, snapshot } from "./cy";
import { A, B, C, D, expect, fixtures, test } from "./mockApi";
import graphFiltered from "./fixtures/graph-filtered.json" with { type: "json" };

const GRAPH = "POST /api/graph/edges";
const NFT = { from: C, to: D, asset: "0x5eed000000000000000000000000000000000009", asset_kind: "erc721", count: 1, sum: "1", first_ts: "2024-01-10T08:00:00Z", last_ts: "2024-03-02T12:30:00Z", decimals: null, symbol: "PUNK", trust: { level: "unknown", impersonates: null, reason: null } };

async function openGraph(page: import("@playwright/test").Page) {
  await page.goto("/?e2e=1");
  const search = page.getByRole("searchbox", { name: "Search" });
  await search.fill(A);
  await search.press("Enter");
  await expectLaidOut(page, "main", 4);
}

/** Waits until no node on the address graph moves between two looks 250 ms apart. */
async function settled(page: import("@playwright/test").Page) {
  const pos = async () => JSON.stringify((await snapshot(page, "main"))!.nodes);
  let last = await pos();
  await expect(async () => {
    await page.waitForTimeout(250);
    const cur = await pos();
    const same = cur === last;
    last = cur;
    expect(same, "layout settled").toBe(true);
  }).toPass({ timeout: 5000 });
}

test("legend lists what is on the canvas; excluding NFT removes its row", async ({ page, mock }) => {
  mock.on(GRAPH, () => ({ json: { ...fixtures.graph, edges: [...fixtures.graph.edges, NFT] } }));
  await openGraph(page);
  const legend = page.getByTestId("legend");
  await expect(legend).toBeVisible();
  await expect(legend.getByText("Wallet (EOA)")).toBeVisible();
  await expect(legend.getByText("ETH", { exact: true })).toBeVisible();
  await expect(legend.getByText("NFT", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Filter/ }).click();
  const dialog = page.getByRole("dialog", { name: "Filter" });
  await dialog.getByLabel("ETH", { exact: true }).check();
  mock.on(GRAPH, () => ({ json: graphFiltered }));
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => mock.count(GRAPH)).toBe(2);
  await expect(legend.getByText("NFT", { exact: true })).toHaveCount(0);
  await expect(legend.getByText("ETH", { exact: true })).toBeVisible();
  expect(mock.unhandled).toEqual([]);
});

test("the expanded legend never covers a node: fits keep its strip clear; collapsing gives it back", async ({ page, mock }) => {
  await openGraph(page);
  const legend = page.getByTestId("legend");
  const canvas = (await page.locator(".address-graph .cy-view").boundingBox())!;
  const leftmost = async () => Math.min(...(await snapshot(page, "main"))!.nodes.map((n) => canvas.x + n.x1));
  await settled(page);
  await expect(async () => {
    const l = (await legend.boundingBox())!;
    expect(await leftmost()).toBeGreaterThanOrEqual(l.x + l.width);
  }).toPass({ timeout: 5000 });
  const open = await leftmost();
  await legend.getByRole("button", { name: "Collapse legend" }).click();
  // Untouched viewport: the fit takes the strip back.
  await expect.poll(leftmost).toBeLessThan(open);
  expect(mock.unhandled).toEqual([]);
});

test("hovering a node shows its tooltip; moving away hides it", async ({ page, mock }) => {
  await openGraph(page);
  const tip = page.getByTestId("graph-tooltip");
  // The incremental layout animates small graphs: wait until B stopped moving.
  let last = await nodeScreenPos(page, B);
  await expect(async () => {
    await page.waitForTimeout(250);
    const cur = await nodeScreenPos(page, B);
    const same = cur.x === last.x && cur.y === last.y;
    last = cur;
    expect(same, "B settled").toBe(true);
  }).toPass({ timeout: 5000 });
  // The edge A→B ends at B's centre and would win there: aim at the far side of the node.
  const a = await nodeScreenPos(page, A);
  const len = Math.hypot(last.x - a.x, last.y - a.y) || 1;
  const p = { x: last.x + ((last.x - a.x) / len) * 6, y: last.y + ((last.y - a.y) / len) * 6 };
  await page.mouse.move(p.x - 80, p.y - 80);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await expect(tip).toContainText("Neighbours");
  await page.mouse.move(2, 2, { steps: 15 });
  await expect(tip).toHaveCount(0);
  expect(mock.unhandled).toEqual([]);
});

test("a tooltip at the right edge flips left: inside the canvas and clear of the pointer", async ({ page, mock }) => {
  await openGraph(page);
  const tip = page.getByTestId("graph-tooltip");
  // The right-most node, once the layout stopped moving.
  const rightmost = async () => {
    const s = (await snapshot(page, "main"))!;
    return s.nodes.reduce((a, b) => (b.x2 > a.x2 ? b : a));
  };
  let last = await rightmost();
  await expect(async () => {
    await page.waitForTimeout(250);
    const cur = await rightmost();
    const same = cur.id === last.id && cur.x2 === last.x2 && cur.y1 === last.y1;
    last = cur;
    expect(same, "layout settled").toBe(true);
  }).toPass({ timeout: 5000 });
  // Pan it to 16px from the canvas's right edge (a fit centres small graphs).
  await page.evaluate((id) => {
    type Core = import("cytoscape").Core;
    const cy = (window as unknown as { __etherGraphCy: Core }).__etherGraphCy;
    const b = cy.$id(id).renderedBoundingBox({ includeLabels: false });
    cy.panBy({ x: cy.width() - 16 - b.x2, y: 0 });
  }, last.id);
  last = (await snapshot(page, "main"))!.nodes.find((n) => n.id === last.id)!;
  const box = (await page.locator(".address-graph .cy-view").boundingBox())!;
  // Its right-hand side (edges come in from the left), entered straight from the empty space below.
  const anchor = { x: box.x + last.x2 - 3, y: box.y + (last.y1 + last.y2) / 2 };
  await page.mouse.move(anchor.x, anchor.y + 60);
  await page.mouse.move(anchor.x, anchor.y);
  await expect(tip).toBeVisible();
  const t = (await tip.boundingBox())!;
  expect(t.x + t.width, "tooltip right edge inside the canvas").toBeLessThanOrEqual(box.x + box.width + 0.5);
  expect(t.x, "tooltip left edge inside the canvas").toBeGreaterThanOrEqual(box.x - 0.5);
  // Flipped at its natural width, not squeezed into the strip right of the pointer.
  expect(t.x + t.width, "tooltip flipped left of the pointer").toBeLessThanOrEqual(anchor.x);
  expect(t.width, "tooltip keeps its natural width").toBeGreaterThan(100);
  const covers = anchor.x >= t.x && anchor.x <= t.x + t.width && anchor.y >= t.y && anchor.y <= t.y + t.height;
  expect(covers, "tooltip does not cover the pointer").toBe(false);
  expect(mock.unhandled).toEqual([]);
});

test("the help drawer lists the keyboard shortcuts", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Help" });
  await expect(drawer).toBeVisible();
  const keys = drawer.getByRole("table", { name: "Keyboard shortcuts" });
  await expect(keys).toBeVisible();
  await expect(keys.getByText("Focus search")).toBeVisible();
  await expect(keys.getByText("Undo")).toBeVisible();
  expect(mock.unhandled).toEqual([]);
});
