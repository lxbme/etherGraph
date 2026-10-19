import type { Locator, Page } from "@playwright/test";
import { expectLaidOut } from "./cy";
import { TX, expect, fixtures, test } from "./mockApi";

const SEPARATOR = "Resize the details panel height";

async function openTx(page: Page) {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveAttribute("aria-selected", "true");
  await expectLaidOut(page, { tx: TX }, 3);
}

/** Whether the topmost element at the centre of `target` is `target` itself (or inside it). */
async function onTop(target: Locator): Promise<boolean> {
  const box = (await target.boundingBox())!;
  return target.evaluate(
    (el, p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      return !!hit && (hit === el || el.contains(hit));
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}

/** Nothing covers the separator or the detail tabs, and both still work with the mouse. */
async function expectSeparatorAndTabsReachable(page: Page) {
  const txView = page.getByTestId("tx-view");
  const sep = txView.getByRole("separator", { name: SEPARATOR });
  const tabs = txView.getByRole("group", { name: "Transaction details" });
  const overview = tabs.getByRole("button", { name: "Overview" });
  const input = tabs.getByRole("button", { name: "Input" });

  expect(await onTop(sep), "the separator is not covered").toBe(true);
  expect(await onTop(overview), "the Overview tab is not covered").toBe(true);
  // The view above ends at the separator.
  const stage = (await txView.locator(".split__top").boundingBox())!;
  const handle = (await sep.boundingBox())!;
  expect(stage.y + stage.height).toBeLessThanOrEqual(handle.y + 0.5);

  await input.click();
  await expect(input).toHaveAttribute("aria-pressed", "true");
  await overview.click();
  await expect(overview).toHaveAttribute("aria-pressed", "true");

  // A mouse drag on the separator still moves it: down (shorter panel), or up when already at its 120 px minimum.
  const bottom = txView.locator(".split__bottom");
  const before = (await bottom.boundingBox())!.height;
  const dy = before > 121 ? 40 : -40;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + dy, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await bottom.boundingBox())!.height).not.toBe(before);
}

/** The canvas tools' Export menu opens over the panel and its last item ("File…") can be clicked. */
async function expectExportMenuReachable(page: Page) {
  const txView = page.getByTestId("tx-view");
  const tools = txView.locator(".canvas-tools:visible");
  await tools.getByRole("button", { name: "Export" }).click();
  const file = page.getByRole("menuitem", { name: "File…" });
  await expect(file).toBeVisible();
  expect(await onTop(file), "the Export menu's File… item is not covered").toBe(true);
  await page.keyboard.press("Escape");
  await expect(file).toBeHidden();
}

test("the detail panel maximised with the keyboard never covers its separator or tabs, also after a reload", async ({ page, mock }) => {
  mock.on("GET /api/tx/*/trace", () => ({ json: fixtures.trace }));
  await openTx(page);
  const txView = page.getByTestId("tx-view");
  const sep = txView.getByRole("separator", { name: SEPARATOR });
  await sep.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
  // The view above keeps its minimum (switch, banner and some graph).
  expect((await txView.locator(".split__top").boundingBox())!.height).toBeGreaterThanOrEqual(199);
  await expectSeparatorAndTabsReachable(page);

  // Maximised again and remembered: still reachable after a reload, in both views.
  await sep.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
  expect(Number(await page.evaluate(() => localStorage.getItem("ethergraph.txDetailHeight")))).toBeGreaterThan(400);
  await openTx(page);
  await expectSeparatorAndTabsReachable(page);
  await txView.getByRole("group", { name: "Transaction view" }).getByRole("button", { name: "Call tree" }).click();
  await expect(txView.getByRole("tree", { name: "Call tree" }).getByRole("treeitem")).toHaveCount(9);
  await sep.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
  await expectSeparatorAndTabsReachable(page);

  expect(mock.unhandled).toEqual([]);
});

test("with the view above at its minimum the Export menu still opens over the panel, in both views", async ({ page, mock }) => {
  mock.on("GET /api/tx/*/trace", () => ({ json: fixtures.trace }));
  await page.addInitScript(() => localStorage.setItem("ethergraph.txDetailHeight", "5000"));
  await openTx(page);
  const txView = page.getByTestId("tx-view");
  // The remembered height squeezes the view above to its 200 px minimum, so the menu reaches below the separator.
  expect((await txView.locator(".split__top").boundingBox())!.height).toBeLessThan(210);
  await expectExportMenuReachable(page);
  await txView.getByRole("group", { name: "Transaction view" }).getByRole("button", { name: "Call tree" }).click();
  await expect(txView.getByRole("tree", { name: "Call tree" }).getByRole("treeitem")).toHaveCount(9);
  await expectExportMenuReachable(page);
  expect(mock.unhandled).toEqual([]);
});

for (const [width, height] of [
  [1000, 560],
  [700, 560],
] as const) {
  test(`at ${width}×${height} a large remembered detail height covers nothing, in both views`, async ({ page, mock }) => {
    mock.on("GET /api/tx/*/trace", () => ({ json: fixtures.trace }));
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => localStorage.setItem("ethergraph.txDetailHeight", "5000"));
    await openTx(page);
    await expectSeparatorAndTabsReachable(page);

    const txView = page.getByTestId("tx-view");
    await txView.getByRole("group", { name: "Transaction view" }).getByRole("button", { name: "Call tree" }).click();
    await expect(txView.getByRole("tree", { name: "Call tree" }).getByRole("treeitem").first()).toBeAttached();
    // The tree column (beside the graph, or under it when stacked) ends above the separator.
    const side = (await txView.locator(".rside__side").boundingBox())!;
    const sep = (await txView.getByRole("separator", { name: SEPARATOR }).boundingBox())!;
    expect(side.y + side.height).toBeLessThanOrEqual(sep.y + 0.5);
    await expectSeparatorAndTabsReachable(page);

    expect(mock.unhandled).toEqual([]);
  });
}

for (const [width, height] of [
  [1000, 560],
  [360, 740],
] as const) {
  test(`at ${width}×${height} many transfers with long amounts leave the graph area above 100 px`, async ({ page, mock }) => {
    const huge = (2n ** 256n - 1n).toString();
    const token = (n: number) => ({
      seq: 10 + n, from: "0xb0b0000000000000000000000000000000000002", to: "0xa11ce00000000000000000000000000000000001",
      asset: `0x${String(n).repeat(40)}`, amount: huge, token_id: null, kind: "erc20" as const, trace_path: null, log_index: 20 + n,
      decimals: 18, symbol: `LONGSYMBOL${n}`, trust: { level: "listed" as const, impersonates: null, reason: null },
    });
    const tx = { ...fixtures.tx, flow: { ...fixtures.tx.flow!, flows: [...fixtures.tx.flow!.flows, token(1), token(2), token(3), token(4)] } };
    mock.on("GET /api/tx/*", () => ({ json: tx }));
    mock.on("GET /api/tx/*/trace", () => ({ json: fixtures.trace }));
    await page.setViewportSize({ width, height });
    await page.goto("/?e2e=1");
    await page.getByRole("searchbox", { name: "Search" }).fill(TX);
    await page.getByRole("searchbox", { name: "Search" }).press("Enter");
    const bar = page.getByTestId("tx-summary-bar");
    await expect(bar.getByTestId("tx-summary-transfer").first()).toBeVisible();
    // The transfers add at most one line, and nothing in the bar spills sideways.
    expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const graph = (await page.getByTestId("tx-view").locator(".txview__graph").boundingBox())!;
    expect(graph.height).toBeGreaterThan(100);
    expect(mock.unhandled).toEqual([]);
  });
}
