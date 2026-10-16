import { expectLaidOut, snapshot, tapBackground, tapEdge, tapNode } from "./cy";
import { A, B, C, TX, expect, test } from "./mockApi";

const GRAPH = "POST /api/graph/edges";

test("a tx tab whose data arrives while the graph tab is shown lays out when opened", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "搜索" }).fill(A);
  await page.getByRole("searchbox", { name: "搜索" }).press("Enter");
  await expectLaidOut(page, "main", 4);

  const release = mock.hold("GET /api/tx/*");
  await tapEdge(page, A, B);
  await page.getByTestId("transfer-row").first().getByRole("button", { name: /0x7e57/ }).click();
  await expect(page.getByText("正在获取交易…")).toBeVisible();

  // Back to the graph before the tx data arrives; the tx graph is then built while hidden.
  await page.getByRole("tab", { name: "关系图" }).click();
  release();
  await expect.poll(async () => (await snapshot(page, { tx: TX }))?.nodes.length).toBe(3);
  expect((await snapshot(page, { tx: TX }))!.containerWidth).toBe(0);
  await expectLaidOut(page, "main", 4);

  await page.getByRole("tab", { name: /^交易 0x7e57/ }).click();
  await expect(page.getByTestId("tx-view").getByText("这是资金流图", { exact: false })).toBeVisible();
  await expectLaidOut(page, { tx: TX }, 3);

  expect(mock.unhandled).toEqual([]);
});

test("tx search → add a node to the graph → the graph built while hidden fits when shown", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "搜索" }).fill(TX);
  await page.getByRole("searchbox", { name: "搜索" }).press("Enter");

  const txView = page.getByTestId("tx-view");
  await expect(page.getByRole("tab", { name: /^交易 0x7e57/ })).toHaveAttribute("aria-selected", "true");
  await expect(txView.getByText("这是资金流图，不是完整调用树", { exact: false })).toBeVisible();
  await expect(txView.getByText("swapExactETHForTokens(uint256,address[],address,uint256)", { exact: false })).toBeVisible();
  await expect(txView.locator("tbody tr")).toHaveCount(3);
  await expectLaidOut(page, { tx: TX }, 3);

  // Pick the router in the flow graph and add it to the (hidden) address graph.
  await tapNode(page, { tx: TX }, C);
  await txView.getByRole("button", { name: "加入关系图" }).click();
  await expect.poll(() => mock.count(GRAPH)).toBe(1);
  expect(mock.requests(GRAPH)[0]!.postDataJSON()).toMatchObject({ addresses: [C] });
  await expect.poll(async () => (await snapshot(page, "main"))?.nodes.length).toBe(4);
  expect((await snapshot(page, "main"))!.containerWidth).toBe(0);

  await page.getByRole("tab", { name: "关系图" }).click();
  await expectLaidOut(page, "main", 4);
  // The tx tab stays sized when switched back to (its node panel is still open, so it is narrower).
  await page.getByRole("tab", { name: /^交易 0x7e57/ }).click();
  await expect(txView.getByRole("button", { name: "加入关系图" })).toBeVisible();
  await expect(async () => {
    const s = (await snapshot(page, { tx: TX }))!;
    expect(s.containerWidth).toBeGreaterThan(100);
    expect(s.width).toBe(s.containerWidth);
  }).toPass();
  // Closing the panel gives the canvas its full width back with every node in view.
  await tapBackground(page, { tx: TX });
  await expect(txView.getByRole("button", { name: "加入关系图" })).toHaveCount(0);
  await expectLaidOut(page, { tx: TX }, 3);

  expect(mock.unhandled).toEqual([]);
});
