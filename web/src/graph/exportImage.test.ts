import cytoscape from "cytoscape";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useTheme } from "../shell/theme";
import { canvasColor, graphStylesheet, txFlowStylesheet } from "./styles";
import type { Annotation } from "../annotate/model";
import { textWidth } from "../annotate/measure";
import { IMAGE_EXT, TRANSIENT_CLASSES, exportImage, withCleanCanvas } from "./exportImage";

// jsdom has no DOMMatrix (svgcanvas needs it): a recording stand-in that serialises its size, its groups (svgcanvas
// appends a <g> on every save()) and its filled texts.
vi.mock("svgcanvas", () => ({
  Context: class {
    texts: string[] = [];
    groups: string[] = []; // mutated, not assigned: the proxy drops property writes
    constructor(private size: { width: number; height: number }) {
      return new Proxy(this, { get: (t, k: string) => (k in t ? (t as never)[k] : () => {}), set: () => true });
    }
    save() {
      this.groups.push("<g/>");
    }
    fillText(t: string) {
      this.texts.push(t);
    }
    getSerializedSvg() {
      return `<svg width="${this.size.width}" height="${this.size.height}">${this.groups.join("")}${this.texts.map((t) => `<text>${t}</text>`).join("")}</svg>`;
    }
    // Every other drawing call is a no-op (the proxy above).
  },
}));

// The real measure, recorded: which font each text is measured in.
vi.mock("../annotate/measure", async (importOriginal) => {
  const m = await importOriginal<typeof import("../annotate/measure")>();
  return { ...m, textWidth: vi.fn(m.textWidth) };
});

/** A headless canvas with a box selection (a, b), a detail selection (node b, edge ab) and a highlighted edge (bc). */
function makeCy(): cytoscape.Core {
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    style: graphStylesheet("light"),
    elements: [
      { group: "nodes", data: { id: "a", text: "Alice" }, classes: "kind-eoa center" },
      { group: "nodes", data: { id: "b", text: "Bob" }, classes: "kind-eoa selected pinned" },
      { group: "nodes", data: { id: "c", text: "Carol" }, classes: "kind-contract" },
      { group: "edges", data: { id: "ab", source: "a", target: "b", width: 2 }, classes: "asset-eth selected" },
      { group: "edges", data: { id: "bc", source: "b", target: "c", width: 2 }, classes: "asset-erc20 highlighted" },
    ],
  });
  cy.$("#a, #b").select();
  return cy;
}

const classesOf = (cy: cytoscape.Core) => Object.fromEntries(cy.elements().map((e) => [e.id(), [...e.classes()].sort()]));
const selectedIds = (cy: cytoscape.Core) => cy.$(":selected").map((e) => e.id()).sort();

function expectClean(cy: cytoscape.Core) {
  expect(cy.$(":selected")).toHaveLength(0);
  for (const cls of TRANSIENT_CLASSES) expect(cy.$(`.${cls}`), cls).toHaveLength(0);
}

describe("withCleanCanvas", () => {
  test("renders with no selection and no transient class, then restores both", () => {
    const cy = makeCy();
    const before = classesOf(cy);
    const result = withCleanCanvas(cy, () => {
      expectClean(cy);
      // Persistent state classes are kept.
      expect(cy.$("#b").hasClass("pinned")).toBe(true);
      expect(cy.$("#a").hasClass("center")).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(classesOf(cy)).toEqual(before);
    expect(selectedIds(cy)).toEqual(["a", "b"]);
  });

  test("restores everything when the render throws", () => {
    const cy = makeCy();
    const before = classesOf(cy);
    expect(() =>
      withCleanCanvas(cy, () => {
        expectClean(cy);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(classesOf(cy)).toEqual(before);
    expect(selectedIds(cy)).toEqual(["a", "b"]);
  });

  test("every class the stylesheets use is either transient or a known persistent state", () => {
    // Persistent: what an element is (kind, category, asset, tx roles) and lasting node states (center, sync, icons, pills).
    const persistent = /^(kind-|cat-|asset-)|^(center|synced|unsynced|user-label|pinned|syncing|partial|more|call|self-call|delegation)$/;
    const selectors = [...graphStylesheet("light"), ...txFlowStylesheet("light")].map((b) => (b as { selector: string }).selector);
    const classes = new Set(selectors.flatMap((s) => [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!)));
    expect(classes.size).toBeGreaterThan(10);
    const unclassified = [...classes].filter((c) => !(TRANSIENT_CLASSES as readonly string[]).includes(c) && !persistent.test(c));
    expect(unclassified).toEqual([]);
  });
});

/** A renderer stand-in for the SVG pass: no elements are drawn. */
function stubRenderer(cy: cytoscape.Core) {
  (cy as unknown as { renderer: () => unknown }).renderer = () => ({
    getCachedZSortedEles: () => [],
    drawElements: vi.fn(),
    path2dEnabled: () => false,
    notify: () => {},
    recalculateRenderedStyle: () => {},
  });
}

/**
 * Stubs the PNG composite's inputs: `cy.png`, a decoded bitmap `scale` times the elements' (rounded-up) box, as
 * Cytoscape renders it (its scale times the device pixel ratio), and a recording canvas.
 */
function stubComposite(cy: cytoscape.Core, scale: number) {
  const bb = cy.elements().boundingBox();
  const png = vi.fn(() => new Blob(["png"], { type: "image/png" }));
  (cy as unknown as { png: typeof png }).png = png;
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: Math.ceil(bb.w) * scale, height: Math.ceil(bb.h) * scale, close: vi.fn() })));
  const drawImage = vi.fn();
  const ctxScale = vi.fn();
  const fakeCtx = new Proxy({ drawImage, scale: ctxScale } as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : vi.fn()),
    set: () => true,
  });
  const out = new Blob(["out"], { type: "image/png" });
  const canvas = { width: 0, height: 0, getContext: () => fakeCtx, toBlob: (cb: (b: Blob) => void) => cb(out) };
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => (tag === "canvas" ? canvas : create(tag))) as typeof document.createElement);
  return { bb, canvas, drawImage, ctxScale, out };
}

describe("exportImage", () => {
  afterEach(() => {
    useTheme.setState({ resolved: "light" });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("PNG: the full graph at scale 2 on the theme's canvas colour, rendered from a clean canvas", () => {
    useTheme.setState({ resolved: "dark" });
    const cy = makeCy();
    const blob = new Blob(["png"], { type: "image/png" });
    const png = vi.fn(() => {
      expectClean(cy);
      return blob;
    });
    (cy as unknown as { png: typeof png }).png = png;
    expect(exportImage(cy, "png")).toBe(blob);
    expect(png).toHaveBeenCalledWith({ full: true, scale: 2, bg: canvasColor("dark"), output: "blob" });
    expect(selectedIds(cy)).toEqual(["a", "b"]);
  });

  test("transparent PNG: no background", () => {
    const cy = makeCy();
    const png = vi.fn(() => new Blob(["png"], { type: "image/png" }));
    (cy as unknown as { png: typeof png }).png = png;
    exportImage(cy, "png-transparent");
    expect(png).toHaveBeenCalledWith({ full: true, scale: 2, output: "blob" });
  });

  test("no annotations keeps the cy.png options and output path", () => {
    const cy = makeCy();
    const blob = new Blob(["png"], { type: "image/png" });
    const png = vi.fn(() => blob);
    (cy as unknown as { png: typeof png }).png = png;
    expect(exportImage(cy, "png", [])).toBe(blob);
    expect(exportImage(cy, "png-transparent")).toBe(blob);
    expect(png).toHaveBeenNthCalledWith(1, { full: true, scale: 2, bg: canvasColor("light"), output: "blob" });
    expect(png).toHaveBeenNthCalledWith(2, { full: true, scale: 2, output: "blob" });
  });

  test("svg grows to include an annotation outside the elements", async () => {
    const cy = makeCy();
    const bb = cy.elements().boundingBox();
    stubRenderer(cy);
    const note: Annotation = { id: "n", kind: "text", color: "ink", x1: bb.x2 + 500, y1: bb.y1, x2: bb.x2 + 500, y2: bb.y1, text: "look here" };
    const svg = await (await exportImage(cy, "svg", [note])).text();
    const width = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)![1]);
    expect(width).toBeGreaterThanOrEqual(bb.w + 500);
    expect(svg).toContain("look here");
    const plain = await (await exportImage(cy, "svg")).text();
    expect(Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(plain)![1])).toBeLessThan(width);
  });

  test("export bounds measure a mono text with the mono font at its size", async () => {
    const cy = makeCy();
    stubRenderer(cy);
    const measured = vi.mocked(textWidth);
    measured.mockClear();
    const note: Annotation = { id: "n", kind: "text", color: "ink", x1: 0, y1: 0, x2: 0, y2: 0, text: "mono", size: 30, font: "mono" };
    await exportImage(cy, "svg", [note]);
    expect(measured).toHaveBeenCalledWith("mono", expect.stringContaining("IBM Plex Mono"), 30);
    expect(measured.mock.calls.every(([, font]) => font.startsWith("30px ") && font.includes("IBM Plex Mono"))).toBe(true);
  });

  test("svg without annotations paints none: no extra group", async () => {
    const cy = makeCy();
    stubRenderer(cy);
    const plain = await (await exportImage(cy, "svg")).text();
    expect(plain).not.toContain("<g");
    const note: Annotation = { id: "n", kind: "rect", color: "red", x1: 0, y1: 0, x2: 10, y2: 10 };
    expect(await (await exportImage(cy, "svg", [note])).text()).toContain("<g/>");
  });

  test("png composite is sized to the union box", async () => {
    const cy = makeCy();
    const { bb, canvas, drawImage, ctxScale, out } = stubComposite(cy, 2);
    // A rectangle left of and above the elements.
    const rect: Annotation = { id: "r", kind: "rect", color: "red", x1: bb.x1 - 100, y1: bb.y1 - 50, x2: bb.x1 - 20, y2: bb.y1 - 10 };
    const blob = await exportImage(cy, "png", [rect]);
    expect(blob).toBe(out);
    const u = { x1: bb.x1 - 100 - 16, y1: bb.y1 - 50 - 16, x2: bb.x1 + Math.ceil(bb.w), y2: bb.y1 + Math.ceil(bb.h) }; // the render's extent
    expect(canvas.width).toBe(Math.ceil((u.x2 - u.x1) * 2));
    expect(canvas.height).toBe(Math.ceil((u.y2 - u.y1) * 2));
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), Math.round((bb.x1 - u.x1) * 2), Math.round((bb.y1 - u.y1) * 2));
    expect(ctxScale).toHaveBeenCalledWith(2, 2);
  });

  test("png composite follows the bitmap's scale: at a device pixel ratio of 2 Cytoscape renders 4x", async () => {
    const cy = makeCy();
    const { bb, canvas, drawImage, ctxScale } = stubComposite(cy, 4);
    const rect: Annotation = { id: "r", kind: "rect", color: "red", x1: bb.x1 - 100, y1: bb.y1 - 50, x2: bb.x1 - 20, y2: bb.y1 - 10 };
    await exportImage(cy, "png", [rect]);
    const u = { x1: bb.x1 - 100 - 16, y1: bb.y1 - 50 - 16, x2: bb.x1 + Math.ceil(bb.w), y2: bb.y1 + Math.ceil(bb.h) }; // the render's extent
    // As large as the 4x render plus the annotations' margin, the render drawn at its own size on whole pixels.
    expect(canvas.width).toBe(Math.ceil((u.x2 - u.x1) * 4));
    expect(canvas.height).toBe(Math.ceil((u.y2 - u.y1) * 4));
    expect(canvas.width).toBeGreaterThanOrEqual(Math.ceil(bb.w) * 4);
    const [, dx, dy] = drawImage.mock.calls[0]!;
    expect([dx, dy]).toEqual([Math.round((bb.x1 - u.x1) * 4), Math.round((bb.y1 - u.y1) * 4)]);
    expect(Number.isInteger(dx) && Number.isInteger(dy)).toBe(true);
    expect(ctxScale).toHaveBeenCalledWith(4, 4);
  });

  test("png composite with annotations inside the elements is exactly the render's size", async () => {
    const cy = makeCy();
    const { bb, canvas, drawImage } = stubComposite(cy, 4);
    const inside: Annotation = { id: "r", kind: "rect", color: "red", x1: bb.x1 + 20, y1: bb.y1 + 20, x2: bb.x1 + 22, y2: bb.y1 + 22 };
    await exportImage(cy, "png", [inside]);
    expect([canvas.width, canvas.height]).toEqual([Math.ceil(bb.w) * 4, Math.ceil(bb.h) * 4]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0);
  });

  test("file extensions per format", () => {
    expect(IMAGE_EXT).toEqual({ png: "png", "png-transparent": "png", svg: "svg" });
  });
});
