import type { Page } from "@playwright/test";
import type { TransferDto } from "../src/api/generated/TransferDto";
import { snapshot, tapEdge, tapNode } from "./cy";
import { A, B, C, expect, installWorld, searchAndPick, summary, test, transfer, type World } from "./mockApi";

const hash = (i: number) => "0x" + i.toString(16).padStart(64, "0");
const T1 = hash(1);
const T2 = hash(2);
const T3 = hash(3);

/** One ETH transfer of 1 ETH `from → to` at `ts`. */
function single(tx: string, from: string, to: string, ts: string): TransferDto {
  return {
    tx_hash: tx, sub_id: "0", kind: "native", block_number: 1, ts, from, to, asset: null, amount: "1000000000000000000",
    token_id: null, decimals: 18, symbol: null, trust: { level: "listed", impersonates: null, reason: null },
  };
}

/** A (synced, "Alice") sent B two transfers and C one. */
function makeWorld(): World {
  return {
    nodes: new Map([
      [A, summary(A, { display_name: "Alice", synced: true })],
      [B, summary(B)],
      [C, summary(C)],
    ]),
    edges: [transfer(A, B, 2), transfer(A, C, 1)],
    filtered: {},
    transfers: [
      single(T1, A, B, "2024-03-02T12:30:00Z"),
      single(T2, A, B, "2024-02-01T00:00:00Z"),
      single(T3, A, C, "2024-01-10T08:00:00Z"),
    ],
  };
}

/** The A → B edges on the canvas. */
async function abEdges(page: Page): Promise<number> {
  return ((await snapshot(page, "main"))?.edges ?? []).filter((e) => e.source === A && e.target === B).length;
}

/** The count the edge detail shows for A → B (the pair stays selected across tabs). */
const abCount = (page: Page) => page.locator(".main__right tbody tr").filter({ hasText: "A → B" }).locator("td").nth(2);

/** The Data tab's row of the transfer `tx`. */
const dataRow = (page: Page, tx: string) => page.getByTestId("data-row").filter({ has: page.locator(`[title="${tx}"]`) });

test("hiding a transfer on the Data tab thins its edge on the graph", async ({ page, mock }) => {
  installWorld(mock, makeWorld());
  await searchAndPick(page, A);
  await expect.poll(() => abEdges(page)).toBe(1);
  await tapEdge(page, A, B);
  await expect(abCount(page)).toHaveText("2");

  // 1. The Data tab lists every transfer behind the canvas edges; hide one of A → B's two.
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(page.getByTestId("data-row")).toHaveCount(3);
  await expect(page.getByText("3 / 3 transfers")).toBeVisible();
  await expect(page.locator(".main__right")).toHaveCount(0);
  await dataRow(page, T1).getByRole("button", { name: "Hide" }).click();
  await expect(dataRow(page, T1)).toHaveClass(/data__row--hidden/);

  // 2. Back on the graph, the edge counts one.
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(abCount(page)).toHaveText("1");
  expect(await abEdges(page)).toBe(1);

  // 3. Hide the other one: the edge is gone (and still listed on the Data tab, to unhide it).
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(page.getByTestId("data-row")).toHaveCount(3);
  await dataRow(page, T2).getByRole("button", { name: "Hide" }).click();
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect.poll(() => abEdges(page)).toBe(0);

  // 4. Ctrl+Z on the graph undoes the last hide: the edge is back, and the Data tab shows that row unhidden.
  await page.keyboard.press("Control+z");
  await expect.poll(() => abEdges(page)).toBe(1);
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(dataRow(page, T2).getByRole("button", { name: "Hide" })).toBeVisible();
  await expect(dataRow(page, T1).getByRole("button", { name: "Show" })).toBeVisible();

  // One request for the pairs on the canvas, under the graph's filter.
  const req = mock.requests("POST /api/transfers/batch")[0]!.postDataJSON() as { pairs: unknown[]; limit: number };
  expect(req.pairs).toHaveLength(2);
  expect(req.limit).toBe(1000);
  expect(mock.unhandled).toEqual([]);
});

test("Ctrl+Z on the Data tab undoes the last hide", async ({ page, mock }) => {
  installWorld(mock, makeWorld());
  await searchAndPick(page, A);
  await expect.poll(() => abEdges(page)).toBe(1);
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(page.getByTestId("data-row")).toHaveCount(3);
  await dataRow(page, T1).getByRole("button", { name: "Hide" }).click();
  await expect(dataRow(page, T1)).toHaveClass(/data__row--hidden/);

  // Still on the Data tab: the shortcut undoes the hide.
  await page.keyboard.press("Control+z");
  await expect(dataRow(page, T1)).not.toHaveClass(/data__row--hidden/);
  await expect(dataRow(page, T1).getByRole("button", { name: "Hide" })).toBeVisible();
});

test("hiding a row in the bottom table shows on the Data tab, and Ctrl+Z restores both", async ({ page, mock }) => {
  const world = makeWorld();
  installWorld(mock, world);
  // The node's table: every transfer of A.
  mock.on("GET /api/transfers", () => ({ json: { items: world.transfers, next_cursor: null } }));
  await searchAndPick(page, A);
  await expect.poll(() => abEdges(page)).toBe(1);

  // 1. Select the node and hide one transfer from the bottom table.
  await tapNode(page, "main", A);
  const rows = page.getByTestId("transfer-row");
  await expect(rows).toHaveCount(3);
  const row = rows.filter({ has: page.locator(`[title="${T1}"]`) });
  await row.getByRole("button", { name: "Hide" }).click();
  await expect(row).toHaveClass(/transfers__row--hidden/);
  await expect(row.getByRole("button", { name: "Show" })).toBeVisible();

  // 2. The Data tab shows the same transfer hidden.
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(dataRow(page, T1).getByRole("button", { name: "Show" })).toBeVisible();

  // 3. Ctrl+Z restores it in both views.
  await page.keyboard.press("Control+z");
  await expect(dataRow(page, T1).getByRole("button", { name: "Hide" })).toBeVisible();
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(row.getByRole("button", { name: "Hide" })).toBeVisible();
  await expect(row).not.toHaveClass(/transfers__row--hidden/);
});

test("Space on a row's eye button toggles it and fires no graph shortcut", async ({ page, mock }) => {
  installWorld(mock, makeWorld());
  await searchAndPick(page, A);
  await expect.poll(() => abEdges(page)).toBe(1);
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(page.getByTestId("data-row")).toHaveCount(3);

  const eye = dataRow(page, T3).getByRole("button", { name: "Hide" });
  await eye.focus();
  await page.keyboard.press("Space");
  const shown = dataRow(page, T3).getByRole("button", { name: "Show" });
  await expect(shown).toBeVisible();
  await expect(dataRow(page, T3)).toHaveClass(/data__row--hidden/);
  // A hidden row keeps its eye button fully opaque.
  expect(await shown.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await shown.focus();
  await page.keyboard.press("Enter");
  await expect(dataRow(page, T3).getByRole("button", { name: "Hide" })).toBeVisible();
  await expect(dataRow(page, T1)).not.toHaveClass(/data__row--hidden/);
});

test("exporting CSV downloads the filtered transfers", async ({ page, mock }) => {
  installWorld(mock, makeWorld());
  await searchAndPick(page, A);
  await expect.poll(() => abEdges(page)).toBe(1);
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(page.getByTestId("data-row")).toHaveCount(3);

  // Narrow to the two A → B transfers by address, then export what is listed.
  await page.getByRole("textbox", { name: "Address or name" }).fill(B);
  await expect(page.getByTestId("data-row")).toHaveCount(2);
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV (2)" }).click()]);
  expect(file.suggestedFilename()).toMatch(/-transfers-\d{8}\.csv$/);
  const stream = (await file.createReadStream())!;
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let text = "";
  for await (const c of stream) text += decoder.decode(c as Uint8Array, { stream: true });
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.slice(1).split("\r\n").filter(Boolean);
  expect(lines[0]).toBe("time_utc,block,tx_hash,sub_id,type,from,from_name,to,to_name,symbol,token,amount,amount_raw,hidden");
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain(T1);
  expect(lines[2]).toContain(T2);
});
