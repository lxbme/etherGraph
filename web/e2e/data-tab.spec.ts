import type { Page } from "@playwright/test";
import type { TransferDto } from "../src/api/generated/TransferDto";
import { snapshot, tapEdge } from "./cy";
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
  await dataRow(page, T1).getByRole("checkbox").check();
  await expect(dataRow(page, T1)).toHaveClass(/data__row--hidden/);

  // 2. Back on the graph, the edge counts one.
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(abCount(page)).toHaveText("1");
  expect(await abEdges(page)).toBe(1);

  // 3. Hide the other one: the edge is gone (and still listed on the Data tab, to unhide it).
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(page.getByTestId("data-row")).toHaveCount(3);
  await dataRow(page, T2).getByRole("checkbox").check();
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect.poll(() => abEdges(page)).toBe(0);

  // 4. Ctrl+Z on the graph undoes the last hide: the edge is back, and the Data tab shows that row unhidden.
  await page.keyboard.press("Control+z");
  await expect.poll(() => abEdges(page)).toBe(1);
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(dataRow(page, T2).getByRole("checkbox")).not.toBeChecked();
  await expect(dataRow(page, T1).getByRole("checkbox")).toBeChecked();

  // One request for the pairs on the canvas, under the graph's filter.
  const req = mock.requests("POST /api/transfers/batch")[0]!.postDataJSON() as { pairs: unknown[]; limit: number };
  expect(req.pairs).toHaveLength(2);
  expect(req.limit).toBe(1000);
  expect(mock.unhandled).toEqual([]);
});
