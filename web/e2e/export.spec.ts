import type { Page } from "@playwright/test";
import { expectLaidOut, tapEdge, tapNode, type Which } from "./cy";
import { A, B, D, TX, expect, fixtures, test, searchAndPick } from "./mockApi";

/**
 * Picks `item` in the Export menu of the canvas tools inside `scope`; returns the download's name, the downloaded
 * blob's type, its first bytes, its pixel size (a PNG's, from its IHDR header) and (for text) its content. The blob is
 * caught as it becomes the download URL.
 */
async function exportFrom(
  page: Page,
  scope: string,
  item: string,
): Promise<{ name: string; type: string; head: number[]; size: { w: number; h: number } | null; text: string }> {
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
    const bytes = new DataView(await b.slice(0, 24).arrayBuffer());
    const png = b.type === "image/png" && bytes.byteLength === 24;
    return {
      type: b.type,
      head: [0, 1, 2, 3].map((i) => bytes.getUint8(i)),
      size: png ? { w: bytes.getUint32(16), h: bytes.getUint32(20) } : null,
      text: b.type.startsWith("image/svg") ? await b.text() : "",
    };
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

/** Searches A and waits for the address graph's first layout to settle. */
async function openGraph(page: Page) {
  await searchAndPick(page, A);
  await expectLaidOut(page, "main", 4);
  await page.waitForTimeout(600); // the first layout's glide
}

/** Enters annotate mode on the address graph; returns helpers drawing at fractions of the canvas box. */
async function annotateGraph(page: Page) {
  const graph = page.getByTestId("address-graph");
  const box = (await graph.boundingBox())!;
  await graph.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Annotate" }).click();
  const bar = graph.getByRole("toolbar", { name: "Annotate" });
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  const write = async (fx: number, fy: number, text: string) => {
    await bar.getByRole("button", { name: "Text" }).click();
    await page.mouse.click(...at(fx, fy));
    const editor = graph.locator("textarea.annotate-editor");
    await expect(editor).toBeFocused();
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await expect(editor).toHaveCount(0);
  };
  const rectangle = async (from: [number, number], to: [number, number]) => {
    await bar.getByRole("button", { name: "Rectangle" }).click();
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
    await page.mouse.move(...at(...to));
    await page.mouse.up();
  };
  return { write, rectangle };
}

test("SVG export contains annotation text and shapes; the PNG with annotations is still a PNG", async ({ page, mock }) => {
  await openGraph(page);
  const { write, rectangle } = await annotateGraph(page);
  await write(0.6, 0.7, "look here 中文");
  await rectangle([0.1, 0.1], [0.3, 0.25]);

  const svg = await exportFrom(page, ".address-graph", "SVG");
  expect(svg.text).toContain("look here 中文");
  // The rectangle is an SVG <rect> stroked in the annotation colour (Cytoscape draws its shapes as paths).
  const red = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--note-red").trim().toLowerCase());
  const rects = [...svg.text.matchAll(/<rect\b([^>]*)>/g)].map((m) => m[1]!);
  expect(rects.filter((r) => r.includes(`stroke="${red}"`) && /fill="none"/.test(r))).toHaveLength(1);
  const png = await exportFrom(page, ".address-graph", "PNG");
  expect(png).toMatchObject({ type: "image/png", head: PNG_MAGIC });
  expect(mock.unhandled).toEqual([]);
});

test.describe("at a device pixel ratio of 2", () => {
  test.use({ deviceScaleFactor: 2 });

  test("the PNG with annotations keeps the resolution of the PNG without", async ({ page, mock }) => {
    await openGraph(page);
    const plain = await exportFrom(page, ".address-graph", "PNG");
    // A text inside the elements' box: the image grows only by the margin around it, if at all.
    const { write } = await annotateGraph(page);
    await write(0.5, 0.5, "x");
    const noted = await exportFrom(page, ".address-graph", "PNG");
    expect(noted).toMatchObject({ type: "image/png", head: PNG_MAGIC });
    expect(noted.size!.w).toBeGreaterThanOrEqual(plain.size!.w);
    expect(noted.size!.h).toBeGreaterThanOrEqual(plain.size!.h);
    expect(mock.unhandled).toEqual([]);
  });
});
