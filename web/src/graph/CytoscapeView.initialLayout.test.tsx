import { render } from "@testing-library/react";
import type cytoscape from "cytoscape";
import { CytoscapeView, type CytoscapeViewProps } from "./CytoscapeView";
import { runDagreLayout } from "./layout";

// jsdom has no canvas: the real Core runs headless (the container option is dropped).
vi.mock("cytoscape", async (orig) => {
  const m = (await orig()) as { default: typeof cytoscape };
  const real = m.default;
  const wrapped = Object.assign((o: cytoscape.CytoscapeOptions) => real({ ...o, container: undefined, headless: true }), real);
  return { default: wrapped };
});
vi.mock("./layout", () => ({ runDagreLayout: vi.fn(), runIncrementalLayout: vi.fn() }));

const noop = () => {};
const node = (id: string): cytoscape.ElementDefinition => ({ group: "nodes", data: { id } });
const edge = (s: string, t: string): cytoscape.ElementDefinition => ({ group: "edges", data: { id: `${s}-${t}`, source: s, target: t } });
const AB = [node("a"), node("b"), edge("a", "b")];
const SAVED = {
  positions: { a: { x: 10, y: 20 }, b: { x: 300, y: -40 } },
  viewport: { zoom: 2.5, pan: { x: 7, y: -8 } },
};

function setup(initialLayout: CytoscapeViewProps["initialLayout"], elements = AB) {
  let cy!: cytoscape.Core;
  const view = (els: cytoscape.ElementDefinition[]) => (
    <CytoscapeView
      elements={els} stylesheet={[] as unknown as cytoscape.StylesheetJson} layout="dagre-lr" initialLayout={initialLayout}
      onTapNode={noop} onTapEdge={noop} onDblTapNode={noop} onDblTapEdge={noop} onCxtNode={noop}
      onSelectionChange={noop} onDragEnd={noop} onReady={(c) => { cy = c; }}
    />
  );
  const r = render(view(elements));
  return { cy: () => cy, rerender: (els: cytoscape.ElementDefinition[]) => r.rerender(view(els)) };
}

afterEach(() => vi.clearAllMocks());

test("every node has a saved position: the saved positions and viewport, no dagre layout", () => {
  const t = setup(SAVED);
  expect(runDagreLayout).not.toHaveBeenCalled();
  expect(t.cy().getElementById("a").position()).toEqual({ x: 10, y: 20 });
  expect(t.cy().getElementById("b").position()).toEqual({ x: 300, y: -40 });
  expect(t.cy().zoom()).toBe(2.5);
  expect(t.cy().pan()).toEqual({ x: 7, y: -8 });
});

test("the saved layout waits for the first elements (data still loading)", () => {
  const t = setup(SAVED, []);
  t.rerender(AB);
  expect(runDagreLayout).not.toHaveBeenCalled();
  expect(t.cy().getElementById("b").position()).toEqual({ x: 300, y: -40 });
  expect(t.cy().zoom()).toBe(2.5);
});

test("a node without a saved position: the dagre layout runs and the saved viewport is not applied", () => {
  const t = setup({ positions: { a: SAVED.positions.a }, viewport: SAVED.viewport });
  expect(runDagreLayout).toHaveBeenCalledTimes(1);
  expect(t.cy().zoom()).not.toBe(2.5);
});

test("used once: a later change to the graph lays out with dagre", () => {
  const t = setup(SAVED);
  t.rerender([...AB, node("c"), edge("b", "c")]);
  expect(runDagreLayout).toHaveBeenCalledTimes(1);
});

test("without a saved layout the dagre layout runs", () => {
  setup(undefined);
  expect(runDagreLayout).toHaveBeenCalledTimes(1);
});

describe("definition positions under dagre-lr", () => {
  // The layout moves every node, as dagre does.
  const scatter = () =>
    vi.mocked(runDagreLayout).mockImplementation((cy) => cy.nodes().forEach((n, i) => void n.position({ x: 1000 + i, y: 1000 })));
  afterEach(() => vi.mocked(runDagreLayout).mockReset());
  // Counted, not matched: a failed match would print the whole canvas.
  const dagreRuns = () => vi.mocked(runDagreLayout).mock.calls.length;
  const at = (id: string, position: { x: number; y: number }): cytoscape.ElementDefinition => ({ ...node(id), position });

  test("a later change lays out the new nodes; nodes whose definition has a position stay there", () => {
    scatter();
    const t = setup(undefined, [at("a", { x: 10, y: 20 }), at("b", { x: 300, y: -40 }), edge("a", "b")]);
    expect(dagreRuns()).toBe(0);
    expect(t.cy().getElementById("a").position()).toEqual({ x: 10, y: 20 });
    t.rerender([at("a", { x: 10, y: 20 }), at("b", { x: 300, y: -40 }), node("c"), edge("a", "b"), edge("b", "c")]);
    expect(dagreRuns()).toBe(1);
    expect(t.cy().getElementById("a").position()).toEqual({ x: 10, y: 20 });
    expect(t.cy().getElementById("b").position()).toEqual({ x: 300, y: -40 });
    expect(t.cy().getElementById("c").position().y).toBe(1000);
    // Removing a node again keeps them too.
    t.rerender([at("a", { x: 10, y: 20 }), at("b", { x: 300, y: -40 }), edge("a", "b")]);
    expect(t.cy().getElementById("b").position()).toEqual({ x: 300, y: -40 });
  });

  test("a node with a position and one without: dagre places the one without only", () => {
    scatter();
    const t = setup(undefined, [at("a", { x: 10, y: 20 }), node("b"), edge("a", "b")]);
    expect(dagreRuns()).toBe(1);
    expect(t.cy().getElementById("a").position()).toEqual({ x: 10, y: 20 });
    expect(t.cy().getElementById("b").position().y).toBe(1000);
  });
});
