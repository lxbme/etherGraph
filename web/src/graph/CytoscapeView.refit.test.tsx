import { render } from "@testing-library/react";
import type cytoscape from "cytoscape";
import { CytoscapeView, type CytoscapeViewProps } from "./CytoscapeView";
import { runIncrementalLayout } from "./layout";

const h = vi.hoisted(() => ({ cb: null as (() => void) | null }));
// jsdom has no canvas: the real Core runs headless (the container option is dropped).
vi.mock("cytoscape", async (orig) => {
  const m = (await orig()) as { default: typeof cytoscape };
  const real = m.default;
  const wrapped = Object.assign((o: cytoscape.CytoscapeOptions) => real({ ...o, container: undefined, headless: true }), real);
  return { default: wrapped };
});
vi.mock("./layout", () => ({ runDagreLayout: vi.fn(), runIncrementalLayout: vi.fn() }));

let size = { w: 0, h: 0 };
beforeEach(() => {
  size = { w: 0, h: 0 };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) { h.cb = cb; }
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => size.w });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => size.h });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

const noop = () => {};
const props = (elements: cytoscape.ElementDefinition[], layout: CytoscapeViewProps["layout"] = "dagre-lr"): CytoscapeViewProps => ({
  elements, stylesheet: [] as unknown as cytoscape.StylesheetJson, layout,
  onTapNode: noop, onTapEdge: noop, onDblTapNode: noop, onDblTapEdge: noop, onCxtNode: noop,
  onSelectionChange: noop, onDragEnd: noop,
});
const els: cytoscape.ElementDefinition[] = [{ group: "nodes", data: { id: "a" } }];

function mount(onReady: (cy: cytoscape.Core) => void, layout: CytoscapeViewProps["layout"] = "dagre-lr") {
  return render(<CytoscapeView {...props(els, layout)} onReady={onReady} />);
}

test("layout in a zero-size container is refit when the container gets a size", () => {
  let cy!: cytoscape.Core;
  mount((c) => { cy = c; });
  const fit = vi.spyOn(cy, "fit");
  // Re-render path ran the (mocked) dagre layout at zero size during mount.
  size = { w: 800, h: 600 };
  h.cb!();
  expect(fit).toHaveBeenCalledTimes(1);
});

test("incremental: an ordinary resize with no hidden layout does not fit", () => {
  size = { w: 800, h: 600 };
  let cy!: cytoscape.Core;
  mount((c) => { cy = c; }, "incremental");
  const fit = vi.spyOn(cy, "fit");
  size = { w: 900, h: 600 };
  h.cb!();
  expect(fit).not.toHaveBeenCalled();
});

test("dagre-lr: a resize refits while the user has not panned or zoomed since the layout", () => {
  size = { w: 800, h: 600 };
  let cy!: cytoscape.Core;
  const { container } = mount((c) => { cy = c; });
  const fit = vi.spyOn(cy, "fit");
  size = { w: 500, h: 600 };
  h.cb!();
  expect(fit).toHaveBeenCalledTimes(1);

  // A tap (pointer down/up without a viewport change) is not a pan.
  const view = container.querySelector(".cy-view")!;
  view.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  window.dispatchEvent(new Event("pointerup"));
  size = { w: 600, h: 600 };
  h.cb!();
  expect(fit).toHaveBeenCalledTimes(2);

  // A drag that pans the viewport makes it the user's.
  view.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  cy.pan({ x: 40, y: 10 });
  window.dispatchEvent(new Event("pointerup"));
  size = { w: 700, h: 600 };
  h.cb!();
  expect(fit).toHaveBeenCalledTimes(2);
});

test("styles are recomputed once the web fonts have loaded (label widths)", async () => {
  let fontsLoaded!: () => void;
  const ready = new Promise<void>((r) => (fontsLoaded = r));
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready } });
  try {
    let update!: ReturnType<typeof vi.fn>;
    mount((c) => {
      update = vi.fn();
      // Headless cores have no style object; stand one in.
      vi.spyOn(c, "style").mockReturnValue({ update } as unknown as ReturnType<cytoscape.Core["style"]>);
    });
    expect(update).not.toHaveBeenCalled();
    fontsLoaded();
    await ready;
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
  } finally {
    delete (document as unknown as Record<string, unknown>).fonts;
  }
});

test("a refit on resize is clamped to the maximum fit zoom", () => {
  size = { w: 800, h: 600 };
  let cy!: cytoscape.Core;
  mount((c) => { cy = c; });
  vi.spyOn(cy, "fit").mockImplementation(() => cy.zoom(3));
  size = { w: 500, h: 600 };
  h.cb!();
  expect(cy.zoom()).toBeLessThanOrEqual(1.2);
});

test("a new left fit inset refits until the user pans or zooms; the same inset does not", () => {
  size = { w: 800, h: 600 };
  let cy!: cytoscape.Core;
  const two: cytoscape.ElementDefinition[] = [
    { group: "nodes", data: { id: "a" }, position: { x: 0, y: 0 } },
    { group: "nodes", data: { id: "b" }, position: { x: 2000, y: 0 } },
  ];
  const view = render(<CytoscapeView {...props(two, "incremental")} onReady={(c) => { cy = c; }} />);
  vi.spyOn(cy, "width").mockReturnValue(800);
  vi.spyOn(cy, "height").mockReturnValue(600);
  const viewport = vi.spyOn(cy, "viewport");
  view.rerender(<CytoscapeView {...props(two, "incremental")} fitInsetLeft={200} />);
  expect(viewport).toHaveBeenCalledTimes(1);
  // Graph's left edge right of the inset plus the usual padding.
  expect(cy.pan().x + cy.zoom() * cy.elements().boundingBox().x1).toBeGreaterThanOrEqual(200);
  view.rerender(<CytoscapeView {...props(two, "incremental")} fitInsetLeft={200} />);
  expect(viewport).toHaveBeenCalledTimes(1);
  view.container.querySelector(".cy-view")!.dispatchEvent(new Event("wheel"));
  view.rerender(<CytoscapeView {...props(two, "incremental")} fitInsetLeft={0} />);
  expect(viewport).toHaveBeenCalledTimes(1);
});

describe("the first neighbours on a bare canvas", () => {
  const node = (id: string, classes?: string): cytoscape.ElementDefinition => ({ group: "nodes", data: { id }, ...(classes && { classes }) });
  const edge = (a: string, b: string, classes?: string): cytoscape.ElementDefinition => ({
    group: "edges", data: { id: `${a}-${b}`, source: a, target: b }, ...(classes && { classes }),
  });
  /** A searched center alone with its "+N more" placeholder (the canvas before any pick). */
  const bare = [node("a"), node("more:a", "more"), edge("a", "more:a", "more")];

  beforeEach(() => vi.mocked(runIncrementalLayout).mockClear());

  test("are placed without a glide and fitted, like a first load", () => {
    size = { w: 800, h: 600 };
    let cy!: cytoscape.Core;
    const view = render(<CytoscapeView {...props(bare, "incremental")} onReady={(c) => { cy = c; }} />);
    const fit = vi.spyOn(cy, "fit");
    view.rerender(<CytoscapeView {...props([...bare, node("b"), node("c"), edge("a", "b"), edge("c", "a")], "incremental")} />);
    expect(runIncrementalLayout).toHaveBeenLastCalledWith(cy, ["b", "c"], { animate: false });
    expect(fit).toHaveBeenCalledTimes(1);
  });

  test("are not fitted once the user moved the viewport", () => {
    size = { w: 800, h: 600 };
    let cy!: cytoscape.Core;
    const view = render(<CytoscapeView {...props(bare, "incremental")} onReady={(c) => { cy = c; }} />);
    const fit = vi.spyOn(cy, "fit");
    view.container.querySelector(".cy-view")!.dispatchEvent(new Event("wheel"));
    view.rerender(<CytoscapeView {...props([...bare, node("b"), edge("a", "b")], "incremental")} />);
    expect(fit).not.toHaveBeenCalled();
  });

  test("nodes added to a canvas that already shows a transfer keep the viewport and glide", () => {
    size = { w: 800, h: 600 };
    let cy!: cytoscape.Core;
    const shown = [node("a"), node("b"), edge("a", "b")];
    const view = render(<CytoscapeView {...props(shown, "incremental")} onReady={(c) => { cy = c; }} />);
    const fit = vi.spyOn(cy, "fit");
    view.rerender(<CytoscapeView {...props([...shown, node("c"), edge("a", "c")], "incremental")} />);
    expect(runIncrementalLayout).toHaveBeenLastCalledWith(cy, ["c"], {});
    expect(fit).not.toHaveBeenCalled();
  });
});
