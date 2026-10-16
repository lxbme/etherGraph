import graphFiltered from "./fixtures/graph-filtered.json" with { type: "json" };
import graphRefreshed from "./fixtures/graph-refreshed.json" with { type: "json" };
import { expectLaidOut, snapshot, tapEdge } from "./cy";
import { A, B, C, D, E, TX, expect, test, type MockApi } from "./mockApi";
import type { Page } from "@playwright/test";

const GRAPH = "POST /api/graph/edges";
/** The app merges SSE data events over a 500ms window (src/api/useEvents.ts COALESCE_MS). */
const COALESCE_MS = 500;
/** Long enough that a second (wrongly un-merged) refetch would have fired: 3× the merge window. */
const NO_MORE_REFETCH_MS = 3 * COALESCE_MS;

async function searchAddress(page: Page, mock: MockApi, addr: string) {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "搜索" }).fill(addr);
  await page.getByRole("searchbox", { name: "搜索" }).press("Enter");
  await expect.poll(() => mock.count(GRAPH)).toBe(1);
}

test("search → edge → transfers → tx tab → back → filter → save", async ({ page, mock }) => {
  await searchAddress(page, mock, A);
  expect(mock.requests("GET /api/address/*")[0]!.url()).toContain("sync=auto");

  // (1) The canvas has a real size and shows the center with its neighbours.
  const graph = page.getByTestId("address-graph");
  const box = await graph.locator("canvas").first().boundingBox();
  expect(box!.width).toBeGreaterThan(100);
  expect(box!.height).toBeGreaterThan(100);
  const first = await expectLaidOut(page, "main", 4);
  expect(first.nodes.map((n) => n.id).sort()).toEqual([A, B, C, D].sort());

  // Click the A→B edge: the bottom table groups the pair's transfers by direction and asset.
  await tapEdge(page, A, B);
  const groups = page.getByTestId("transfer-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toContainText("3 笔");
  await expect(groups.nth(1)).toContainText("USDT");
  const rows = page.getByTestId("transfer-row");
  await expect(rows).toHaveCount(3);
  const transfers = new URL(mock.requests("GET /api/transfers").at(-1)!.url()).searchParams;
  expect([transfers.get("from"), transfers.get("to"), transfers.get("asset")]).toEqual([A, B, "eth"]);

  // Click a tx hash: a tx tab opens with the fund-flow graph and its banner.
  await rows.first().getByRole("button", { name: /0x7e57/ }).click();
  const txTab = page.getByRole("tab", { name: /^交易 0x7e57/ });
  await expect(txTab).toHaveAttribute("aria-selected", "true");
  const txView = page.getByTestId("tx-view");
  await expect(txView.getByText("这是资金流图，不是完整调用树", { exact: false })).toBeVisible();
  await expectLaidOut(page, { tx: TX }, 3);
  await expect(graph).toBeHidden();

  // (2) Back to the graph: still visible and correctly sized, not a zero-size/tiny graph.
  await page.getByRole("tab", { name: "关系图" }).click();
  await expect(graph).toBeVisible();
  const back = await expectLaidOut(page, "main", 4);
  expect(back.zoom).toBeCloseTo(first.zoom, 5);

  // Filter: ETH only, at least 1 ETH.
  await page.getByRole("button", { name: /过滤/ }).click();
  const dialog = page.getByRole("dialog", { name: "过滤" });
  await dialog.getByLabel("ETH", { exact: true }).check();
  await dialog.getByLabel("ETH 最小金额").fill("1");
  mock.on(GRAPH, () => ({ json: graphFiltered }));
  await dialog.getByRole("button", { name: "应用" }).click();
  await expect.poll(() => mock.count(GRAPH)).toBe(2);
  expect(mock.requests(GRAPH)[1]!.postDataJSON()).toMatchObject({
    addresses: [A],
    filter: { assets: [{ asset: null, min_amount: "1" }] },
  });
  await expect(page.getByTestId("filter-active")).toBeVisible();
  await expect.poll(async () => (await snapshot(page, "main"))?.edges.length).toBe(2);
  await expectLaidOut(page, "main", 3);

  // Save the canvas.
  await page.getByRole("button", { name: "画布菜单" }).click();
  await page.getByRole("menuitem", { name: "保存" }).click();
  await page.getByRole("textbox", { name: "画布名称" }).fill("e2e 画布");
  await page.getByRole("button", { name: "确定" }).click();
  await expect(page.getByText("画布: 已保存")).toBeVisible();
  const saved = mock.requests("POST /api/workspaces");
  expect(saved).toHaveLength(1);
  const body = saved[0]!.postDataJSON() as { name: string; state: { centers: string[]; filter: unknown; nodes: { address: string }[] } };
  expect(body.name).toBe("e2e 画布");
  expect(body.state.centers).toEqual([A]);
  expect(body.state.filter).toEqual({ assets: [{ asset: null, min_amount: "1" }] });
  expect(body.state.nodes.map((n) => n.address).sort()).toEqual([A, B, D].sort());

  expect(mock.unhandled).toEqual([]);
});

test("AddressDataChanged over SSE refreshes the graph exactly once", async ({ page, mock }) => {
  await searchAddress(page, mock, A);
  await expectLaidOut(page, "main", 4);
  // Let the initial load settle (no fetch in flight that the refresh would be deferred behind).
  await expect(page.getByRole("status", { name: "更新中" })).toHaveCount(0);

  mock.on(GRAPH, () => ({ json: graphRefreshed }));
  const unrelated = "0x9999999999999999999999999999999999999999";
  await mock.pushEvents([
    { type: "AddressDataChanged", address: A },
    { type: "AddressDataChanged", address: B },
    { type: "AddressDataChanged", address: A.toUpperCase().replace("0X", "0x") },
    { type: "AddressDataChanged", address: unrelated },
  ]);

  // The burst is merged into one refetch, and the new neighbour appears.
  await expect.poll(() => mock.count(GRAPH)).toBe(2);
  // (Incremental placement keeps the viewport, so the new node may land outside it: only check it is there.)
  await expect.poll(async () => (await snapshot(page, "main"))?.nodes.map((n) => n.id).sort()).toEqual([A, B, C, D, E].sort());
  // No further refetch follows (and the SSE reconnect does not trigger a Lagged resync).
  await page.waitForTimeout(NO_MORE_REFETCH_MS);
  expect(mock.count(GRAPH)).toBe(2);
  expect(mock.count("GET /api/events")).toBeGreaterThanOrEqual(2);

  expect(mock.unhandled).toEqual([]);
});

for (const query of ["", "?e2e=0"]) {
  test(`the cytoscape e2e hook is inert without ?e2e=1 (url "/${query}")`, async ({ page, mock }) => {
    await page.goto(`/${query}`);
    await page.getByRole("searchbox", { name: "搜索" }).fill(A);
    await page.getByRole("searchbox", { name: "搜索" }).press("Enter");
    await expect.poll(() => mock.count(GRAPH)).toBe(1);
    await expect(page.getByTestId("address-graph").locator("canvas").first()).toBeVisible();
    // Also mount a tx graph, the other registration point.
    await page.getByRole("searchbox", { name: "搜索" }).fill(TX);
    await page.getByRole("searchbox", { name: "搜索" }).press("Enter");
    await expect(page.getByTestId("tx-view").locator("canvas").first()).toBeVisible();
    const exposed = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return { main: typeof w.__etherGraphCy, tx: typeof w.__etherGraphTxCy };
    });
    expect(exposed).toEqual({ main: "undefined", tx: "undefined" });
    expect(mock.unhandled).toEqual([]);
  });
}
