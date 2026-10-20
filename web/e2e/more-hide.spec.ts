import type { Page } from "@playwright/test";
import { nodeScreenPos, snapshot } from "./cy";
import { A, expect, installWorld, pickerDialog, summary, test, transfer, type World } from "./mockApi";

const PROXY = `more:${A}`;
const peer = (i: number) => "0x9e" + (i + 1).toString(16).padStart(38, "0");

/** A (synced, "Alice") with six neighbours. */
function makeWorld(): World {
  const nodes = new Map([[A, summary(A, { display_name: "Alice", synced: true })]]);
  const edges = [];
  for (let i = 0; i < 6; i++) {
    nodes.set(peer(i), summary(peer(i)));
    edges.push(transfer(A, peer(i), 100 - i));
  }
  return { nodes, edges, filtered: {} };
}

/** Node ids on the canvas, sorted. */
async function ids(page: Page): Promise<string[]> {
  return ((await snapshot(page, "main"))?.nodes ?? []).map((n) => n.id).sort();
}

/** Hovers the "+N more" with the real mouse and clicks its ×. */
async function hideByHover(page: Page) {
  const hide = page.getByRole("button", { name: 'Hide this "+N more"' });
  // From off the canvas onto the proxy (retried while a layout may still be moving it).
  await expect(async () => {
    await page.mouse.move(0, 0);
    const p = await nodeScreenPos(page, PROXY);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await expect(hide).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expect(hide).toHaveAttribute("title", 'Hide this "+N more"');
  await hide.click();
  await expect.poll(() => ids(page)).not.toContain(PROXY);
  await expect(hide).toHaveCount(0);
}

test('hovering "+N more" offers a hide button; undo brings it back', async ({ page, mock }) => {
  installWorld(mock, makeWorld());
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(A);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Expand Alice" });
  await dialog.getByRole("spinbutton").fill("2");
  await dialog.getByRole("button", { name: "Expand 2 checked" }).click();
  await expect(dialog).toBeHidden();
  const withProxy = [A, peer(0), peer(1), PROXY].sort();
  await expect.poll(() => ids(page)).toEqual(withProxy);

  await hideByHover(page);
  // The click hid the proxy; it did not open the picker.
  await expect(pickerDialog(page)).toHaveCount(0);
  expect(await ids(page)).toEqual([A, peer(0), peer(1)].sort());

  await page.keyboard.press("Control+z");
  await expect.poll(() => ids(page)).toEqual(withProxy);

  await hideByHover(page);
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("no more");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("Workspace: Saved")).toBeVisible();
  const saved = mock.requests("POST /api/workspaces")[0]!.postDataJSON() as { state: { graph: { hidden_proxies?: string[] } } };
  expect(saved.state.graph.hidden_proxies).toEqual([A]);

  // A fresh page, then the workspace: the same nodes, still without the proxy.
  await page.goto("/?e2e=1");
  await expect(page.getByRole("tab", { name: "Graph" })).toBeVisible();
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Open…" }).click();
  await page.getByRole("dialog", { name: "Open workspace" }).getByRole("button", { name: "no more", exact: true }).click();
  await expect.poll(() => ids(page)).toEqual([A, peer(0), peer(1)].sort());
  await expect(page.getByRole("button", { name: 'Show all "+N more" (1)' })).toBeVisible();
  expect(mock.unhandled).toEqual([]);
});
