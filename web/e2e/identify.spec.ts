import type { TxResponseDto } from "../src/api/generated/TxResponseDto";
import { A, B, C, TX, expect, fixtures, test } from "./mockApi";

/** The fixture tx with B and C not yet identified. */
const unidentifiedTx = (): TxResponseDto => {
  const tx = structuredClone(fixtures.tx);
  if (tx.status !== "ready" || !tx.flow) throw new Error("fixture tx must be ready");
  tx.flow.nodes = tx.flow.nodes.map((n) => (n.address === A ? n : { ...n, kind: "unknown", identified: false }));
  return tx;
};

test("Identify all (N) in a tx tab queues exactly the unidentified addresses", async ({ page, mock }) => {
  mock.on("GET /api/tx/*", () => ({ json: unidentifiedTx() }));
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");

  const txView = page.getByTestId("tx-view");
  await txView.getByRole("button", { name: "Identify all (2)" }).click();
  await expect.poll(() => mock.count("POST /api/identify")).toBe(1);
  const body = mock.requests("POST /api/identify")[0]!.postDataJSON() as { addresses: string[]; batch: string };
  expect([...body.addresses].sort()).toEqual([B, C]);
  expect(body.batch).toBeTruthy();
  await expect(page.getByText("Queued 2 addresses for identification")).toBeVisible();
  expect(mock.unhandled).toEqual([]);
});
