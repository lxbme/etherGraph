import type { Locator, Page } from "@playwright/test";
import { expectLaidOut, nodeScreenPos } from "./cy";
import { A, B, TX, expect, searchAndPick, test } from "./mockApi";

type Core = import("cytoscape").Core;
type Box = { x: number; y: number; width: number; height: number };

/** The annotation shapes of a canvas (not the selection outline). */
const shapes = (canvas: Locator, tag: string) => canvas.locator(`svg.annotation-layer ${tag}:not(.annotation-layer__selection)`);

/** A drag with the real mouse between page points. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** The address graph's (only) rectangle: its model box (svg attributes), its page box, and the box the viewport maps the model box to. */
function rectProbe(page: Page) {
  return page.evaluate(() => {
    const cy = (window as unknown as { __etherGraphCy: Core }).__etherGraphCy;
    const el = document.querySelector<SVGRectElement>('[data-testid="address-graph"] svg.annotation-layer rect:not(.annotation-layer__selection)');
    if (!el) return null;
    const n = (k: string) => Number(el.getAttribute(k));
    const model = { x: n("x"), y: n("y"), width: n("width"), height: n("height") };
    const r = el.getBoundingClientRect();
    const c = cy.container()!.getBoundingClientRect();
    const pan = cy.pan();
    const z = cy.zoom();
    return {
      model,
      page: { x: r.left, y: r.top, width: r.width, height: r.height },
      mapped: { x: c.left + pan.x + model.x * z, y: c.top + pan.y + model.y * z, width: model.width * z, height: model.height * z },
    };
  });
}

function expectBoxClose(got: Box, want: Box) {
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(got[k] - want[k]), k).toBeLessThanOrEqual(1.5);
}

test("annotations stay put when nodes move and come back after reload", async ({ page, mock }) => {
  await searchAndPick(page, A);
  await expectLaidOut(page, "main", 4);
  await page.waitForTimeout(600); // the first layout's glide
  const graph = page.getByTestId("address-graph");
  const tools = graph.getByRole("toolbar", { name: "Canvas tools" });
  const box = (await graph.boundingBox())!;
  /** A page point at a fraction of the canvas, right of the legend and under the bars. */
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // Enter annotate mode; draw a rectangle and a text.
  await tools.getByRole("button", { name: "Annotate" }).click();
  await expect(tools.getByRole("button", { name: "Annotate" })).toHaveAttribute("aria-pressed", "true");
  const bar = graph.getByRole("toolbar", { name: "Annotate" });
  await bar.getByRole("button", { name: "Rectangle" }).click();
  await drag(page, at(0.55, 0.3), at(0.7, 0.5));
  await expect(shapes(graph, "rect")).toHaveCount(1);
  await expect(graph.locator(".annotation-layer__selection")).toHaveCount(1);
  const drawnBox = (await rectProbe(page))!.page;
  expect(drawnBox.width).toBeGreaterThanOrEqual(20);
  expect(drawnBox.height).toBeGreaterThanOrEqual(20);

  await bar.getByRole("button", { name: "Text" }).click();
  await page.mouse.click(at(0.6, 0.7).x, at(0.6, 0.7).y);
  const editor = graph.locator("textarea.annotate-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.type("hello 中文标注测试 WWWW");
  // The editor is wide enough for what was typed: nothing scrolled out of view.
  expect(await editor.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(shapes(graph, "text")).toHaveText("hello 中文标注测试 WWWW");

  // The wheel still zooms the canvas under the overlay; the annotation keeps its model box.
  const drawn = (await rectProbe(page))!;
  const zoom = () => page.evaluate(() => (window as unknown as { __etherGraphCy: Core }).__etherGraphCy.zoom());
  const z0 = await zoom();
  await page.mouse.move(at(0.5, 0.5).x, at(0.5, 0.5).y);
  await page.mouse.wheel(0, -300);
  await expect.poll(zoom).not.toBe(z0);
  await expect.poll(async () => (await rectProbe(page))!.model).toEqual(drawn.model);

  await bar.getByRole("button", { name: "Done" }).click();
  await expect(bar).toHaveCount(0);
  await expect(tools.getByRole("button", { name: "Annotate" })).toHaveAttribute("aria-pressed", "false");
  await expect(shapes(graph, "rect")).toHaveCount(1);

  // Drag a node and re-layout: the rectangle keeps its model box and follows the (possibly refitted) viewport.
  const nodePos = () =>
    page.evaluate((id) => ({ ...(window as unknown as { __etherGraphCy: Core }).__etherGraphCy.$id(id).position() }), B);
  const b0 = await nodePos();
  const b = await nodeScreenPos(page, B);
  await drag(page, b, { x: b.x + 50, y: b.y + 40 });
  await expect.poll(nodePos).not.toEqual(b0);
  await tools.getByRole("button", { name: "Re-layout" }).click();
  await page.waitForTimeout(800); // the glide
  await expect(async () => {
    const p = (await rectProbe(page))!;
    expect(p.model).toEqual(drawn.model);
    expectBoxClose(p.page, p.mapped);
  }).toPass();

  // Pan: the rectangle moves with the canvas.
  const before = (await rectProbe(page))!;
  await page.evaluate(() => (window as unknown as { __etherGraphCy: Core }).__etherGraphCy.panBy({ x: 80, y: 40 }));
  await expect(async () => {
    const p = (await rectProbe(page))!;
    expectBoxClose(p.page, { ...before.page, x: before.page.x + 80, y: before.page.y + 40 });
  }).toPass();

  // Save, reload and reopen: both annotations are back.
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("with notes");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("Workspace: Saved")).toBeVisible();

  await page.goto("/?e2e=1");
  await expect(shapes(graph, "rect")).toHaveCount(0);
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Open…" }).click();
  await page.getByRole("dialog", { name: "Open workspace" }).getByRole("button", { name: "with notes", exact: true }).click();
  await expect(shapes(graph, "rect")).toHaveCount(1);
  await expect(shapes(graph, "text")).toHaveText("hello 中文标注测试 WWWW");
  expect((await rectProbe(page))!.model).toEqual(drawn.model);

  expect(mock.unhandled).toEqual([]);
});

test("an arrow on a tx tab's flow graph persists across tab switches", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  const txTab = page.getByRole("tab", { name: /^Tx 0x7e57/ });
  await expect(txTab).toHaveAttribute("aria-selected", "true");
  await expectLaidOut(page, { tx: TX }, 3);

  const txView = page.getByTestId("tx-view");
  const canvas = txView.locator(".txview__graph").first();
  await canvas.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Annotate" }).click();
  const bar = canvas.getByRole("toolbar", { name: "Annotate" });
  await bar.getByRole("button", { name: "Arrow" }).click();
  const box = (await canvas.boundingBox())!;
  await drag(page, { x: box.x + box.width * 0.55, y: box.y + box.height * 0.4 }, { x: box.x + box.width * 0.75, y: box.y + box.height * 0.6 });
  await expect(shapes(canvas, "line")).toHaveCount(1);

  // Switching tabs leaves annotate mode; the arrow stays.
  await page.getByRole("tab", { name: "Graph" }).click();
  await txTab.click();
  await expect(bar).toHaveCount(0);
  await expect(shapes(canvas, "line")).toHaveCount(1);

  expect(mock.unhandled).toEqual([]);
});
