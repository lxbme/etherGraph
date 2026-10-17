import { expectLaidOut, nodeScreenPos } from "./cy";
import { A, B, C, D, expect, fixtures, test } from "./mockApi";
import graphFiltered from "./fixtures/graph-filtered.json" with { type: "json" };

const GRAPH = "POST /api/graph/edges";
const NFT = { from: C, to: D, asset: "0x5eed000000000000000000000000000000000009", asset_kind: "erc721", count: 1, sum: "1", first_ts: "2024-01-10T08:00:00Z", last_ts: "2024-03-02T12:30:00Z", decimals: null, symbol: "PUNK" };

async function openGraph(page: import("@playwright/test").Page) {
  await page.goto("/?e2e=1");
  const search = page.getByRole("searchbox", { name: "Search" });
  await search.fill(A);
  await search.press("Enter");
  await expectLaidOut(page, "main", 4);
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
