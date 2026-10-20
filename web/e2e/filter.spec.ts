import type { EdgeDto } from "../src/api/generated/EdgeDto";
import type { TransferDto } from "../src/api/generated/TransferDto";
import { expectLaidOut, tapNode } from "./cy";
import { A, B, expect, fixtures, test, searchAndPick, liveGraphRequests } from "./mockApi";

const GRAPH = "POST /api/graph/edges";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";

/** 40 extra tokens on the A→B edge: every fifth a USDT look-alike, so the list is long and partly flagged. */
const TOKENS: EdgeDto[] = Array.from({ length: 40 }, (_, i) => ({
  ...fixtures.graph.edges[0]!,
  from: A,
  to: B,
  asset: `0x${(i + 1).toString(16).padStart(2, "0").repeat(20)}`,
  asset_kind: "erc20",
  decimals: 18,
  symbol: i % 5 === 0 ? "USDT" : `TOK${i}`,
  trust:
    i % 5 === 0
      ? { level: "suspicious", impersonates: { address: USDT, symbol: "USDT", name: "Tether USD" }, reason: null }
      : { level: "unknown", impersonates: null, reason: null },
}));

test.use({ viewport: { width: 1366, height: 768 } });

test("with 40 assets the filter keeps Apply on screen; search, listed group and the impersonation toggle work", async ({ page, mock }) => {
  mock.on(GRAPH, () => ({ json: { ...fixtures.graph, edges: [...fixtures.graph.edges, ...TOKENS] } }));
  await searchAndPick(page, A);
  await expectLaidOut(page, "main", 4);

  // One entry: no separate asset chip.
  await expect(page.getByRole("button", { name: "All assets" })).toHaveCount(0);
  await page.getByRole("button", { name: /Filter/ }).click();
  const dialog = page.getByRole("dialog", { name: "Filter" });
  await expect(dialog).toBeVisible();

  // Apply is reachable without scrolling the popover or the page; the body scrolls instead.
  const apply = dialog.getByRole("button", { name: "Apply" });
  const box = (await apply.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(768);
  expect(box.x + box.width).toBeLessThanOrEqual(1366);
  const body = dialog.locator(".filter__body");
  expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);

  // Tokens on a token list come first; every other token sits in a collapsed group.
  const group = dialog.getByRole("button", { name: "Other tokens (40)" });
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await group.click();
  // With the long list open, Apply is still on screen and the body (not the popover) scrolls.
  const openBox = (await apply.boundingBox())!;
  expect(openBox.y).toBeGreaterThanOrEqual(0);
  expect(openBox.y + openBox.height).toBeLessThanOrEqual(768);
  expect(openBox.x + openBox.width).toBeLessThanOrEqual(1366);
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  await dialog.getByRole("searchbox", { name: "Search assets" }).fill("usdt");
  await expect(dialog.getByRole("checkbox", { name: "USDT" })).toHaveCount(9);
  await expect(dialog.getByText("On token lists (1)")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Other tokens (8)" })).toBeVisible();
  await expect(dialog.getByText("Possible impersonation", { exact: true })).toHaveCount(8);

  // The toggle reaches the request body.
  await dialog.getByLabel("Hide possibly impersonating tokens").check();
  const before = liveGraphRequests(mock).length;
  await apply.click();
  await expect.poll(() => liveGraphRequests(mock).length).toBe(before + 1);
  expect(liveGraphRequests(mock).at(-1)!.postDataJSON()).toMatchObject({ filter: { hide_suspicious: true } });
  await expect(page.getByTestId("filter-active")).toHaveText("Filter · 1");
  expect(mock.unhandled).toEqual([]);
});

test("the transfer table filters on its own", async ({ page, mock }) => {
  const usdt: TransferDto = {
    ...fixtures.transfers.items[0]!,
    tx_hash: "0x7e57000000000000000000000000000000000000000000000000000000000009",
    kind: "erc20",
    from: B,
    to: A,
    asset: USDT,
    amount: "250000000",
    decimals: 6,
    symbol: "USDT",
  };
  mock.on("GET /api/transfers", (_req, url) =>
    url.searchParams.get("asset") === USDT ? { json: { items: [usdt], next_cursor: null } } : { json: fixtures.transfers },
  );
  await searchAndPick(page, A);
  await expectLaidOut(page, "main", 4);

  // The graph filter: ETH only.
  await page.getByRole("button", { name: /Filter/ }).click();
  const dialog = page.getByRole("dialog", { name: "Filter" });
  await dialog.getByLabel("ETH", { exact: true }).check();
  const before = liveGraphRequests(mock).length;
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => liveGraphRequests(mock).length).toBe(before + 1);

  // The node's table ignores it: no asset in its request.
  await tapNode(page, "main", B);
  const rows = page.getByTestId("transfer-row");
  await expect(rows).toHaveCount(3);
  const asked = () => mock.requests("GET /api/transfers").map((r) => new URL(r.url()).searchParams);
  expect(asked().at(-1)!.get("address")).toBe(B);
  expect(asked().at(-1)!.has("asset")).toBe(false);

  // The bar's token reaches the rows; the canvas does not refetch and the graph filter is unchanged.
  const graphs = liveGraphRequests(mock).length;
  await page.getByRole("toolbar").getByRole("combobox", { name: "Asset" }).selectOption(USDT);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("USDT");
  await expect(rows.first()).toContainText("250.00");
  expect(asked().at(-1)!.get("asset")).toBe(USDT);
  expect(liveGraphRequests(mock).length).toBe(graphs);
  await expect(page.getByTestId("filter-active")).toHaveText("Filter · 1");
  expect(mock.unhandled).toEqual([]);
});
