import type { Page } from "@playwright/test";
import { expectLaidOut, nodeScreenPos } from "./cy";
import { A, B, expect, test } from "./mockApi";

type Pos = { x: number; y: number };
const positions = (page: Page) =>
  page.evaluate(() => {
    const cy = (window as unknown as { __etherGraphCy: import("cytoscape").Core }).__etherGraphCy;
    return Object.fromEntries(cy.nodes().map((n) => [n.id(), { ...n.position() }])) as Record<string, Pos>;
  });

test("Re-layout untangles the address graph, keeps a pinned node in place, and Ctrl+Z undoes it", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(A);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect.poll(() => mock.count("POST /api/graph/edges")).toBeGreaterThan(0);
  await expectLaidOut(page, "main", 4);
  await page.waitForTimeout(600); // the first layout's glide

  // Pin B where the first layout put it.
  const b = await nodeScreenPos(page, B);
  await page.mouse.click(b.x, b.y, { button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();

  // Tangle every node onto one spot, then re-layout.
  const pinned = (await positions(page))[B]!;
  await page.evaluate((keep) => {
    const cy = (window as unknown as { __etherGraphCy: import("cytoscape").Core }).__etherGraphCy;
    cy.nodes().forEach((n, i) => {
      if (n.id() !== keep) n.position({ x: i, y: 0 });
    });
  }, B);
  const tangled = await positions(page);
  await page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Re-layout" }).click();
  await page.waitForTimeout(600); // the glide

  const after = await positions(page);
  expect(after[B]).toEqual(pinned);
  const ps = Object.values(after);
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) expect(Math.hypot(ps[i]!.x - ps[j]!.x, ps[i]!.y - ps[j]!.y)).toBeGreaterThan(20);
  }

  await page.locator(".address-graph canvas").first().click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect.poll(() => positions(page)).toEqual(tangled);
});
