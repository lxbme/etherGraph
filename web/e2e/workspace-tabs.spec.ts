import type { Page } from "@playwright/test";
import { expectLaidOut } from "./cy";
import { TX, expect, test } from "./mockApi";

type Core = import("cytoscape").Core;

/** A tx-tab node's model position, its page position and the canvas viewport (null when absent). */
function probe(page: Page, id: string) {
  return page.evaluate(
    ({ tx, id }) => {
      const cy = (window as unknown as { __etherGraphTxCy?: Record<string, Core> }).__etherGraphTxCy?.[tx];
      const n = cy?.$id(id);
      if (!cy || cy.destroyed() || !n || n.empty()) return null;
      const r = cy.container()!.getBoundingClientRect();
      const rp = n.renderedPosition();
      return {
        model: { ...n.position() },
        page: { x: r.left + rp.x, y: r.top + rp.y },
        viewport: { zoom: cy.zoom(), pan: { ...cy.pan() } },
      };
    },
    { tx: TX, id },
  );
}

test("a saved workspace reopens its tx tab with the dragged node where it was left and its detail section", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  const txTab = page.getByRole("tab", { name: /^Tx 0x7e57/ });
  await expect(txTab).toHaveAttribute("aria-selected", "true");
  const laidOut = await expectLaidOut(page, { tx: TX }, 3);
  const id = laidOut.nodes[0]!.id;

  // Drag the node with the real mouse.
  const before = (await probe(page, id))!;
  await page.mouse.move(before.page.x, before.page.y);
  await page.mouse.down();
  await page.mouse.move(before.page.x + 60, before.page.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await probe(page, id))?.model.x).not.toBe(before.model.x);
  const dragged = (await probe(page, id))!;
  await expect(page.getByText("Workspace: Not saved")).toBeVisible();
  const transfersTab = page.getByTestId("tx-detail").getByRole("button", { name: "Token Transfers" });
  await transfersTab.click();

  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("with tx");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("Workspace: Saved")).toBeVisible();
  const body = mock.requests("POST /api/workspaces")[0]!.postDataJSON() as {
    schema_version: number;
    state: { tabs: { hash: string; positions: Record<string, { x: number; y: number }> }[]; active: string };
  };
  expect(body.schema_version).toBe(2);
  expect(body.state.active).toBe(TX);
  expect(body.state.tabs.map((t) => t.hash)).toEqual([TX]);
  expect(body.state.tabs[0]!.positions[id]).toEqual(dragged.model);

  // A fresh page (no tx in the URL) has no tx tab until the workspace is opened.
  await page.goto("/?e2e=1");
  await expect(page.getByRole("tab", { name: "Graph" })).toBeVisible();
  await expect(txTab).toHaveCount(0);
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Open…" }).click();
  await page.getByRole("dialog", { name: "Open workspace" }).getByRole("button", { name: "with tx", exact: true }).click();

  await expect(txTab).toHaveAttribute("aria-selected", "true");
  await expect(transfersTab).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await probe(page, id))?.model).toEqual(dragged.model);
  expect((await probe(page, id))!.viewport).toEqual(dragged.viewport);
  await expect(page.getByText("Workspace: Saved")).toBeVisible();

  expect(mock.unhandled).toEqual([]);
});
