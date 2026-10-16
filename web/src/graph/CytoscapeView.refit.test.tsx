import { render } from "@testing-library/react";
import type cytoscape from "cytoscape";
import { CytoscapeView, type CytoscapeViewProps } from "./CytoscapeView";

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
  onBoxSelect: noop, onDragEnd: noop,
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
