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
  // Start with the right panel closed, so the flow is first laid out at the full width.
  await page.getByRole("button", { name: "详情栏" }).click();
  await page.getByRole("searchbox", { name: "搜索" }).fill(TX);
  await page.getByRole("searchbox", { name: "搜索" }).press("Enter");

  const txView = page.getByTestId("tx-view");
  await expect(page.getByRole("tab", { name: /^交易 0x7e57/ })).toHaveAttribute("aria-selected", "true");
  await expect(txView.getByText("这是资金流图，不是完整调用树", { exact: false })).toBeVisible();
  await expect(txView.getByText("swapExactETHForTokens(uint256,address[],address,uint256)", { exact: false })).toBeVisible();
  await expect(txView.locator("tbody tr")).toHaveCount(3);
  await expectLaidOut(page, { tx: TX }, 3);

  const wide = (await snapshot(page, { tx: TX }))!.containerWidth;

  // Pick the router, then open the right panel: the canvas narrows and is refit with every node in view.
  await tapNode(page, { tx: TX }, C);
  await page.getByRole("button", { name: "详情栏" }).click();
  const add = page.getByRole("button", { name: "加入关系图" });
  await expect(add).toBeVisible();
  await expect(txView.getByRole("button", { name: "加入关系图" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加标签" })).toHaveCount(1);
  await expect.poll(async () => (await snapshot(page, { tx: TX }))!.containerWidth).toBeLessThan(wide);
  await expectLaidOut(page, { tx: TX }, 3);

  // Selecting another node changes the panel's content, never the canvas width.
  const widthBefore = (await snapshot(page, { tx: TX }))!.containerWidth;
  await tapNode(page, { tx: TX }, A);
  await expect(page.getByText(A, { exact: true })).toBeVisible();
  expect((await snapshot(page, { tx: TX }))!.containerWidth).toBe(widthBefore);
  await tapNode(page, { tx: TX }, C);
  await expect(page.getByText(C, { exact: true })).toBeVisible();

  // Add it to the (hidden) address graph.
  await add.click();
  await expect.poll(() => mock.count(GRAPH)).toBe(1);
  expect(mock.requests(GRAPH)[0]!.postDataJSON()).toMatchObject({ addresses: [C] });
  await expect.poll(async () => (await snapshot(page, "main"))?.nodes.length).toBe(4);
  expect((await snapshot(page, "main"))!.containerWidth).toBe(0);

  await page.getByRole("tab", { name: "关系图" }).click();
  await expectLaidOut(page, "main", 4);
  await expect(page.getByRole("button", { name: "加入关系图" })).toHaveCount(0);
  // Back on the tx tab its own selection is shown again, and the canvas is still sized.
  await page.getByRole("tab", { name: /^交易 0x7e57/ }).click();
  await expect(page.getByRole("button", { name: "加入关系图" })).toBeVisible();
  await expectLaidOut(page, { tx: TX }, 3);

  // A tap on the background clears the tab's selection.
  await tapBackground(page, { tx: TX });
  await expect(page.getByRole("button", { name: "加入关系图" })).toHaveCount(0);
  await expect(page.getByText("选择节点查看详情")).toBeVisible();

  expect(mock.unhandled).toEqual([]);
});
