import type { Page } from "@playwright/test";
import { expectLaidOut, nodeScreenPos } from "./cy";
import { A, B, expect, fixtures, test, searchAndPick } from "./mockApi";

type Pos = { x: number; y: number };
const positions = (page: Page) =>
  page.evaluate(() => {
    const cy = (window as unknown as { __etherGraphCy: import("cytoscape").Core }).__etherGraphCy;
    return Object.fromEntries(cy.nodes().map((n) => [n.id(), { ...n.position() }])) as Record<string, Pos>;
  });

test("Re-layout untangles the address graph, keeps a pinned node in place, and Ctrl+Z undoes it", async ({ page, mock }) => {
  await searchAndPick(page, A);
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

/** `centers` centers (A first) with `leaves` neighbours each, plus `shared` neighbours common to all centers. */
function busyGraph(centers: number, leaves: number, shared: number) {
  const hex = (i: number) => "0x" + i.toString(16).padStart(40, "0");
  const node = fixtures.graph.nodes[0]!;
  const edge = fixtures.graph.edges[0]!;
  const cs = [A, ...Array.from({ length: centers - 1 }, (_, i) => hex(0x900000 + i))];
  const nodes = cs.map((address) => ({ ...node, address }));
  const edges = [];
  let k = 1;
  for (const c of cs) {
    for (let j = 0; j < leaves; j++) {
      const address = hex(k++);
      nodes.push({ ...node, address });
      edges.push({ ...edge, from: c, to: address });
    }
  }
  for (let s = 0; s < shared; s++) {
    const address = hex(0x800000 + s);
    nodes.push({ ...node, address });
    for (const c of cs) edges.push({ ...edge, from: c, to: address });
  }
  return { nodes, edges, omitted: {}, coverage: {} };
}

test("Re-layout keeps several busy centers' neighbours apart: labels rarely overlap", async ({ page, mock }) => {
  const graph = busyGraph(3, 60, 6);
  mock.on("POST /api/graph/edges", () => ({ json: graph }));
  await page.setViewportSize({ width: 1600, height: 950 });
  await searchAndPick(page, A);
  await expect.poll(() => mock.count("POST /api/graph/edges")).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __etherGraphCy?: import("cytoscape").Core }).__etherGraphCy?.nodes().length))
    .toBe(graph.nodes.length);
  await page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Re-layout" }).click();
  await page.waitForTimeout(900); // the glide
  // Pairs of nodes whose boxes (labels included) overlap; leaf rings around each center gave ~140 here.
  const overlaps = await page.evaluate(() => {
    const cy = (window as unknown as { __etherGraphCy: import("cytoscape").Core }).__etherGraphCy;
    const boxes = cy.nodes().map((n) => n.boundingBox({ includeLabels: true }));
    let n = 0;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) n++;
      }
    }
    return n;
  });
  expect(overlaps).toBeLessThan(50);
});
