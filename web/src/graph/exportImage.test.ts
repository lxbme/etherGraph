import cytoscape from "cytoscape";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useTheme } from "../shell/theme";
import { canvasColor, graphStylesheet, txFlowStylesheet } from "./styles";
import { IMAGE_EXT, TRANSIENT_CLASSES, exportImage, withCleanCanvas } from "./exportImage";

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

describe("exportImage", () => {
  afterEach(() => useTheme.setState({ resolved: "light" }));

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

  test("file extensions per format", () => {
    expect(IMAGE_EXT).toEqual({ png: "png", "png-transparent": "png", svg: "svg" });
  });
});
