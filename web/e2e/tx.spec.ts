import { expectLaidOut, snapshot, tapBackground, tapEdge, tapNode } from "./cy";
import { A, B, C, TX, expect, test } from "./mockApi";

const GRAPH = "POST /api/graph/edges";

test("a tx tab whose data arrives while the graph tab is shown lays out when opened", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(A);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expectLaidOut(page, "main", 4);

  const release = mock.hold("GET /api/tx/*");
  await tapEdge(page, A, B);
  await page.getByTestId("transfer-row").first().getByRole("button", { name: /0x7e57/ }).click();
  await expect(page.getByText("Fetching transaction…")).toBeVisible();

  // Back to the graph before the tx data arrives; the tx graph is then built while hidden.
  await page.getByRole("tab", { name: "Graph" }).click();
  release();
  await expect.poll(async () => (await snapshot(page, { tx: TX }))?.nodes.length).toBe(3);
  expect((await snapshot(page, { tx: TX }))!.containerWidth).toBe(0);
  await expectLaidOut(page, "main", 4);

  await page.getByRole("tab", { name: /^Tx 0x7e57/ }).click();
  await expect(page.getByTestId("tx-view").getByText("This is a fund-flow graph", { exact: false })).toBeVisible();
  await expectLaidOut(page, { tx: TX }, 3);

  expect(mock.unhandled).toEqual([]);
});

test("tx search → add a node to the graph → the graph built while hidden fits when shown", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  // Start with the right panel closed, so the flow is first laid out at the full width.
  await page.getByRole("button", { name: "Toggle details" }).click();
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");

  const txView = page.getByTestId("tx-view");
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveAttribute("aria-selected", "true");
  await expect(txView.getByText("This is a fund-flow graph, not a full call tree", { exact: false })).toBeVisible();
  await expect(txView.getByTestId("tx-summary-bar").getByText("swapExactETHForTokens", { exact: true })).toHaveAttribute(
    "title",
    "swapExactETHForTokens(uint256,address[],address,uint256)",
  );
  await txView.getByTestId("tx-detail").getByRole("button", { name: "Token Transfers" }).click();
  await expect(txView.locator("tbody tr")).toHaveCount(1);
  await expectLaidOut(page, { tx: TX }, 3);

  const wide = (await snapshot(page, { tx: TX }))!.containerWidth;

  // Pick the router, then open the right panel: the canvas narrows and is refit with every node in view.
  await tapNode(page, { tx: TX }, C);
  await page.getByRole("button", { name: "Toggle details" }).click();
  // The node detail and its "Add to graph" live in the right panel, not in the tx view.
  const panel = page.locator(".main__right");
  const add = panel.getByRole("button", { name: "Add to graph" });
  await expect(add).toBeVisible();
  await expect(txView.locator(".txview__add")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add label" })).toHaveCount(1);
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

  await page.getByRole("tab", { name: "Graph" }).click();
  await expectLaidOut(page, "main", 4);
  await expect(panel.getByRole("button", { name: "Add to graph" })).toHaveCount(0);
  // Back on the tx tab its own selection is shown again, and the canvas is still sized.
  await page.getByRole("tab", { name: /^Tx 0x7e57/ }).click();
  await expect(add).toBeVisible();
  await expectLaidOut(page, { tx: TX }, 3);

  // A tap on the background clears the tab's selection.
  await tapBackground(page, { tx: TX });
  await expect(add).toHaveCount(0);
  await expect(page.getByText("Select a node to see details")).toBeVisible();

  expect(mock.unhandled).toEqual([]);
});

test("transfer row → summary card → Open transaction → every detail tab shows its content", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(A);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expectLaidOut(page, "main", 4);
  await tapEdge(page, A, B);

  await page.getByTestId("transfer-row").first().click();
  const card = page.locator(".main__right").getByTestId("tx-summary");
  await expect(card).toContainText("swapExactETHForTokens");
  await card.getByRole("button", { name: "Open transaction" }).click();

  const txView = page.getByTestId("tx-view");
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveAttribute("aria-selected", "true");
  await expect(txView.getByTestId("tx-summary-bar")).toBeVisible();
  await expectLaidOut(page, { tx: TX }, 3);

  const tabs = txView.getByRole("group", { name: "Transaction details" });
  const body = txView.locator(".txdetail__body");
  await expect(tabs.getByRole("button")).toHaveText(["Overview", "Input", "Token Transfers", "Internal Calls", "Logs", "Raw"]);

  await expect(tabs.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-pressed", "true");
  await expect(body).toContainText("Gas limit");
  await expect(body).toContainText("Nonce");

  await tabs.getByRole("button", { name: "Input" }).click();
  await expect(body).toContainText("swapExactETHForTokens(uint256,address[],address,uint256)");

  await tabs.getByRole("button", { name: "Token Transfers" }).click();
  await expect(body.locator("tbody tr")).toHaveCount(1);

  await tabs.getByRole("button", { name: "Internal Calls" }).click();
  await expect(body.locator("tbody tr")).toHaveCount(1);

  await tabs.getByRole("button", { name: "Logs" }).click();
  await expect(body.locator(".placeholder")).toBeVisible();

  expect(mock.count("GET /api/tx/*/raw")).toBe(0); // only fetched when the Raw tab opens
  await tabs.getByRole("button", { name: "Raw" }).click();
  await expect(body).toContainText("blockNumber");
  await expect(body).toContainText("gasUsed");
  expect(mock.count("GET /api/tx/*/raw")).toBe(1);

  expect(mock.unhandled).toEqual([]);
});

test("clicking a token in the transfers table opens its details in the right panel; Back returns to the node detail", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  const txView = page.getByTestId("tx-view");
  await expect(txView.getByTestId("tx-summary-bar")).toBeVisible();
  await tapNode(page, { tx: TX }, C);
  const panel = page.locator(".main__right");
  await expect(panel.getByRole("button", { name: "Add to graph" })).toBeVisible();

  await txView.getByTestId("tx-detail").getByRole("button", { name: "Token Transfers" }).click();
  await txView.getByRole("button", { name: "USDT", exact: true }).click();
  await expect(panel.getByTestId("info-panel")).toBeVisible();
  await expect(panel.getByText("Uniswap default list")).toBeVisible();
  await expect(panel.getByText("Tether USD")).toBeVisible();

  await panel.getByRole("button", { name: "Back" }).click();
  await expect(panel.getByTestId("info-panel")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Add to graph" })).toBeVisible();
  expect(mock.unhandled).toEqual([]);
});

test("the Overview type value opens its documentation page in the right panel", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  const txView = page.getByTestId("tx-view");
  await expect(txView.getByTestId("tx-summary-bar")).toBeVisible();
  await txView.locator(".txdetail__body").getByRole("button", { name: /EIP-1559|Dynamic fee|Type 2/i }).click();

  const doc = page.locator(".main__right").getByTestId("standard-doc");
  await expect(doc.getByRole("heading", { name: "Fee market change" })).toBeVisible();
  await expect(doc.locator(".doc__math code").first()).toHaveText("effective gas price = min(maxFeePerGas, baseFee + maxPriorityFeePerGas)");
  const link = doc.getByRole("link", { name: /specification/i });
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("target", "_blank");
  expect(mock.unhandled).toEqual([]);
});
