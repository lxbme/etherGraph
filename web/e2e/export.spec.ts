import type { Page } from "@playwright/test";
import { expectLaidOut, tapEdge, tapNode, type Which } from "./cy";
import { A, B, D, TX, expect, fixtures, test, searchAndPick } from "./mockApi";

/**
 * Picks `item` in the Export menu of the canvas tools inside `scope`; returns the download's name, the downloaded
 * blob's type, its first bytes and (for text) its content. The blob is caught as it becomes the download URL.
 */
async function exportFrom(page: Page, scope: string, item: string): Promise<{ name: string; type: string; head: number[]; text: string }> {
  await page.evaluate(() => {
    const w = window as unknown as { __lastBlob?: Blob; __origCreate?: typeof URL.createObjectURL };
    w.__origCreate ??= URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource) => {
      w.__lastBlob = b as Blob;
      return w.__origCreate!(b);
    };
  });
  const tools = page.locator(scope).getByRole("toolbar", { name: "Canvas tools" });
  await tools.getByRole("button", { name: "Export" }).click();
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name: item, exact: true }).click(),
  ]);
  const blob = await page.evaluate(async () => {
    const b = (window as unknown as { __lastBlob: Blob }).__lastBlob;
    return { type: b.type, head: [...new Uint8Array(await b.slice(0, 4).arrayBuffer())], text: b.type.startsWith("image/svg") ? await b.text() : "" };
  });
  return { name: dl.suggestedFilename(), ...blob };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** The detail selection and box selection classes/state on a canvas. */
function transientState(page: Page, which: Which) {
  return page.evaluate((w) => {
    type Core = import("cytoscape").Core;
    const win = window as unknown as { __etherGraphCy?: Core | null; __etherGraphTxCy?: Record<string, Core> };
    const cy = w === "main" ? win.__etherGraphCy : win.__etherGraphTxCy?.[w.tx];
    return { selected: cy!.$(".selected").map((e) => e.id()).sort(), boxed: cy!.$(":selected").map((e) => e.id()).sort() };
  }, which);
}

/**
 * Edge lines and arrowheads in an exported SVG, told apart from node bodies (which are filled *and* stroked):
 * a line is a stroke-only path (`fill="none"`), an arrowhead a fill-only path (`stroke="none"`) in a line's colour.
 */
function svgEdgeShapes(svg: string): { lines: number; arrowheads: number } {
  const paths = [...svg.matchAll(/<path\b([^>]*)>/g)].map((m) => ({
    fill: /\bfill="([^"]*)"/.exec(m[1]!)?.[1],
    stroke: /\bstroke="([^"]*)"/.exec(m[1]!)?.[1],
  }));
  const lines = paths.filter((p) => p.fill === "none" && p.stroke && p.stroke !== "none");
  const colours = new Set(lines.map((p) => p.stroke));
  const arrowheads = paths.filter((p) => p.stroke === "none" && p.fill && colours.has(p.fill));
  return { lines: lines.length, arrowheads: arrowheads.length };
}

/** The canvas' visible edges and how many of them end in an arrow. */
function edgeCounts(page: Page, which: Which) {
  return page.evaluate((w) => {
    type Core = import("cytoscape").Core;
    const win = window as unknown as { __etherGraphCy?: Core | null; __etherGraphTxCy?: Record<string, Core> };
    const cy = w === "main" ? win.__etherGraphCy : win.__etherGraphTxCy?.[w.tx];
    const edges = cy!.edges(":visible");
    return { edges: edges.length, arrows: edges.filter((e) => e.style("target-arrow-shape") !== "none").length };
  }, which);
}

test("the address graph exports a clean PNG, transparent PNG and SVG with nodes, labels, edges, arrows and icons", async ({ page, mock }) => {
  // D syncs partially: its corner icon must come through in the SVG.
  mock.on("POST /api/graph/edges", () => ({
    json: { ...fixtures.graph, nodes: fixtures.graph.nodes.map((n) => (n.address === D ? { ...n, partial: true } : n)) },
  }));
  await searchAndPick(page, A);
  await expectLaidOut(page, "main", 4);
  const counts = await edgeCounts(page, "main");
  expect(counts).toEqual({ edges: 4, arrows: 4 });
  // A detail selection (pair A-B) and a box selection (D): both are left out of the image and kept on the canvas.
  await tapEdge(page, A, B);
  await page.evaluate((d) => (window as unknown as { __etherGraphCy: import("cytoscape").Core }).__etherGraphCy.$id(d).select(), D);
  const before = await transientState(page, "main");
  expect(before.selected.length).toBeGreaterThan(0);
  expect(before.boxed).toEqual([D]);

  const png = await exportFrom(page, ".address-graph", "PNG");
  expect(png.name).toBe("ethergraph-graph.png");
  expect(png).toMatchObject({ type: "image/png", head: PNG_MAGIC });
  const clear = await exportFrom(page, ".address-graph", "Transparent PNG");
  expect(clear.name).toBe("ethergraph-graph.png");
  expect(clear).toMatchObject({ type: "image/png", head: PNG_MAGIC });

  const svg = await exportFrom(page, ".address-graph", "SVG");
  expect(svg.name).toBe("ethergraph-graph.svg");
  const text = svg.text;
  expect(text).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  // Node labels as text, edge lines and arrowheads as paths, the partial-sync corner icon as an embedded image.
  expect(text).toContain(">Binance 14</text>");
  expect(text).toContain(">UniswapV2Router02</text>");
  const shapes = svgEdgeShapes(text);
  expect(shapes.lines).toBeGreaterThanOrEqual(counts.edges);
  expect(shapes.arrowheads).toBeGreaterThanOrEqual(counts.arrows);
  expect(text).toMatch(/<image [^>]*href="data:image\/svg\+xml/);

  expect(await transientState(page, "main")).toEqual(before);
  expect(mock.unhandled).toEqual([]);
});

test("a tx tab exports as ethergraph-tx-<10 hex> in all three formats", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expectLaidOut(page, { tx: TX }, 3);
  await tapNode(page, { tx: TX }, fixtures.tx.flow!.nodes[0]!.address.toLowerCase());
  const counts = await edgeCounts(page, { tx: TX });
  expect(counts.edges).toBeGreaterThanOrEqual(3);
  expect(counts.arrows).toBeGreaterThanOrEqual(3);

  for (const [item, ext] of [["PNG", "png"], ["Transparent PNG", "png"], ["SVG", "svg"]] as const) {
    const out = await exportFrom(page, "[data-testid=tx-view]", item);
    expect(out.name).toBe(`ethergraph-tx-7e57000000.${ext}`);
    if (ext === "svg") {
      const text = out.text;
      expect(text).toMatch(/^<svg/);
      expect(text).toContain(">UniswapV2Router02</text>");
      const shapes = svgEdgeShapes(text);
      expect(shapes.lines).toBeGreaterThanOrEqual(counts.edges);
      expect(shapes.arrowheads).toBeGreaterThanOrEqual(counts.arrows);
    } else {
      expect(out).toMatchObject({ type: "image/png", head: PNG_MAGIC });
    }
  }
  expect(mock.unhandled).toEqual([]);
});

test("SVG export contains annotation text; the PNG with annotations is still a PNG", async ({ page, mock }) => {
  await searchAndPick(page, A);
  await expectLaidOut(page, "main", 4);
  await page.waitForTimeout(600); // the first layout's glide
  const graph = page.getByTestId("address-graph");
  const box = (await graph.boundingBox())!;
  await graph.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Annotate" }).click();
  await graph.getByRole("toolbar", { name: "Annotate" }).getByRole("button", { name: "Text" }).click();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.7);
  const editor = graph.locator("textarea.annotate-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.type("look here 中文");
  await page.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);

  const svg = await exportFrom(page, ".address-graph", "SVG");
  expect(svg.text).toContain("look here 中文");
  const png = await exportFrom(page, ".address-graph", "PNG");
  expect(png).toMatchObject({ type: "image/png", head: PNG_MAGIC });
  expect(mock.unhandled).toEqual([]);
});
