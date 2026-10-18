import type { Page } from "@playwright/test";
import { expectLaidOut } from "./cy";
import graphFileJson from "./fixtures/graph.ethergraph.json" with { type: "json" };
import { A, TX, expect, fixtures, notFound, test } from "./mockApi";

const PRIVATE = "Private Whale";

/** Remembers each blob the page turns into a download URL; `lastBlobText` reads the latest. */
function catchBlobs(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __lastBlob?: Blob; __origCreate?: typeof URL.createObjectURL };
    w.__origCreate ??= URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource) => {
      w.__lastBlob = b as Blob;
      return w.__origCreate!(b);
    };
  });
}
const lastBlobText = (page: Page) => page.evaluate(() => (window as unknown as { __lastBlob: Blob }).__lastBlob.text());

/** Drops a file with this content on the window, as dragging it from the desktop does. */
function dropFile(page: Page, name: string, text: string) {
  return page.evaluate(
    ({ name, text }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type: "application/json" }));
      window.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { name, text },
  );
}

test("a tx file exported here opens on an instance that knows nothing of the tx: the flow and Token Transfers from the file, no tx request until Refresh from chain", async ({ page, mock }) => {
  // The sender's tx: its sender carries the user's own label.
  const tx = structuredClone(fixtures.tx);
  tx.flow!.nodes = tx.flow!.nodes.map((n) =>
    n.address === A ? { ...n, display_name: PRIVATE, labels: [{ id: 77, text: PRIVATE, category: "fund", source: "user" }] } : n,
  );
  mock.on("GET /api/tx/*", () => ({ json: tx }));
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expectLaidOut(page, { tx: TX }, 3);

  const txView = page.getByTestId("tx-view");
  await catchBlobs(page);
  await txView.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Export" }).click();
  await page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name: "File…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export file" });
  await expect(dialog.getByRole("checkbox", { name: "Include my labels" })).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Include node notes" })).not.toBeChecked();
  const [dl] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export" }).click()]);
  expect(dl.suggestedFilename()).toBe("ethergraph-tx-7e57000000.ethergraph.json");
  const path = (await dl.path())!;
  const text = await lastBlobText(page);
  expect(text).not.toContain(PRIVATE);
  expect(JSON.parse(text)).toMatchObject({ format: "ethergraph", version: 1, kind: "tx" });

  // A fresh page on a backend with an empty database: it has nothing for this tx.
  mock.on("GET /api/tx/*", () => notFound("unknown transaction"));
  mock.on("GET /api/tx/*/raw", () => notFound("unknown transaction"));
  mock.on("POST /api/nodes", () => ({ json: [] }));
  await page.goto("/?e2e=1");
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveCount(0);
  const txRequests = mock.count("GET /api/tx/*") + mock.count("GET /api/tx/*/raw");

  await page.getByRole("button", { name: "Workspace menu" }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("menuitem", { name: "Import file…" }).click(),
  ]);
  await chooser.setFiles(path);

  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveAttribute("aria-selected", "true");
  await expectLaidOut(page, { tx: TX }, 3);
  await expect(txView.getByTestId("snapshot-banner")).toBeVisible();
  await expect(txView.getByTestId("snapshot-banner")).toContainText("Snapshot from a file");
  await txView.getByTestId("tx-detail").getByRole("button", { name: "Token Transfers" }).click();
  await expect(txView.locator("tbody tr")).toHaveCount(1);
  await txView.getByTestId("tx-detail").getByRole("button", { name: "Raw" }).click();
  await expect(txView.getByTestId("tx-detail")).toContainText('"blockNumber"');
  // Imported into the current (unsaved) workspace; nothing about the tx was asked of the backend.
  await expect(page.getByText("Workspace: Not saved")).toBeVisible();
  expect(mock.count("GET /api/tx/*") + mock.count("GET /api/tx/*/raw")).toBe(txRequests);

  // Importing it again opens no second tab.
  await page.getByRole("tab", { name: "Graph" }).click();
  await page.getByRole("button", { name: "Workspace menu" }).click();
  const [again] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("menuitem", { name: "Import file…" }).click(),
  ]);
  await again.setFiles(path);
  await expect(page.getByText("This transaction is already open; not imported again")).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveAttribute("aria-selected", "true");

  // Refresh from chain: the tab loads the tx from this backend like any tab.
  mock.on("GET /api/tx/*", () => ({ json: fixtures.tx }));
  await txView.getByTestId("snapshot-banner").getByRole("button", { name: "Refresh from chain" }).click();
  await expect(txView.getByTestId("snapshot-banner")).toHaveCount(0);
  await expect.poll(() => mock.count("GET /api/tx/*")).toBeGreaterThan(0);
  await expectLaidOut(page, { tx: TX }, 3);

  expect(mock.unhandled).toEqual([]);
});

test("a graph file dropped on the window opens as a new unsaved workspace showing the file's graph, with no graph request", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await expect(page.getByRole("tab", { name: "Graph" })).toBeVisible();
  await dropFile(page, "graph.ethergraph.json", JSON.stringify(graphFileJson));

  await expectLaidOut(page, "main", fixtures.graph.nodes.length);
  await expect(page.getByTestId("snapshot-banner")).toBeVisible();
  await expect(page.getByText("Workspace: Not saved")).toBeVisible();
  expect(mock.count("POST /api/graph/edges")).toBe(0);

  // Refresh from chain: the graph is loaded from this backend.
  await page.getByTestId("snapshot-banner").getByRole("button", { name: "Refresh from chain" }).click();
  await expect.poll(() => mock.count("POST /api/graph/edges")).toBeGreaterThan(0);
  await expect(page.getByTestId("snapshot-banner")).toHaveCount(0);

  expect(mock.unhandled).toEqual([]);
});

test("a dropped file that is not an etherGraph file shows one error and leaves the page as it was", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await dropFile(page, "x.json", '{"format":"other"}');
  await expect(page.getByText("Cannot import the file: Not an etherGraph file")).toBeVisible();
  await expect(page.getByTestId("snapshot-banner")).toHaveCount(0);
  await expect(page.getByText("Workspace: Not saved")).toBeVisible();
  expect(mock.unhandled).toEqual([]);
});
