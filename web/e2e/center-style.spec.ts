import type { Page } from "@playwright/test";
import { snapshot } from "./cy";
import { A, expect, installWorld, summary, test, transfer, type World } from "./mockApi";

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

/** Whether `id` carries the `center` class on the canvas (null when it is not there). */
function hasCenterClass(page: Page, id: string): Promise<boolean | null> {
  return page.evaluate((id) => {
    const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy;
    const n = cy?.$id(id);
    return !n || n.empty() ? null : n.hasClass("center");
  }, id);
}

/** Opens the node's context menu the way a right click does (a `cxttap`). */
async function rightClick(page: Page, id: string) {
  await page.evaluate((id) => {
    const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy!;
    const n = cy.$id(id);
    (n as unknown as { emit(e: object): void }).emit({ type: "cxttap", renderedPosition: n.renderedPosition() });
  }, id);
}

test("a center switched to plain style keeps its neighbours, stays plain after a reload, and can be styled again", async ({ page, mock }) => {
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
  await expect.poll(() => hasCenterClass(page, A)).toBe(true);

  await rightClick(page, A);
  await expect(page.getByRole("menuitem", { name: "Remove as center" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Show as plain node" }).click();
  await expect.poll(() => hasCenterClass(page, A)).toBe(false);
  // Only the look changed: every neighbour and the "+N more" are still there.
  expect(await ids(page)).toEqual(withProxy);

  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("plain");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("Workspace: Saved")).toBeVisible();
  const saved = mock.requests("POST /api/workspaces")[0]!.postDataJSON() as { state: { graph: { plain_centers?: string[] } } };
  expect(saved.state.graph.plain_centers).toEqual([A]);

  // A fresh page, then the workspace: the same nodes, A still plain.
  await page.goto("/?e2e=1");
  await expect(page.getByRole("tab", { name: "Graph" })).toBeVisible();
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Open…" }).click();
  await page.getByRole("dialog", { name: "Open workspace" }).getByRole("button", { name: "plain", exact: true }).click();
  await expect.poll(() => ids(page)).toEqual(withProxy);
  expect(await hasCenterClass(page, A)).toBe(false);

  await rightClick(page, A);
  await page.getByRole("menuitem", { name: "Show as center" }).click();
  await expect.poll(() => hasCenterClass(page, A)).toBe(true);
  expect(await ids(page)).toEqual(withProxy);
  expect(mock.unhandled).toEqual([]);
});
