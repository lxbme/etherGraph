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
