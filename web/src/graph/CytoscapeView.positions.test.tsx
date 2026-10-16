import { render } from "@testing-library/react";
import type cytoscape from "cytoscape";
import { CytoscapeView } from "./CytoscapeView";
import { runIncrementalLayout } from "./layout";

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
const AC = [node("a"), node("c")];
const A = [node("a")];

function setup() {
  let cy!: cytoscape.Core;
  const view = (elements: cytoscape.ElementDefinition[], epoch: number) => (
    <CytoscapeView
      elements={elements} stylesheet={[] as unknown as cytoscape.StylesheetJson} layout="incremental" positionsEpoch={epoch}
      onTapNode={noop} onTapEdge={noop} onDblTapNode={noop} onDblTapEdge={noop} onCxtNode={noop}
      onBoxSelect={noop} onDragEnd={noop} onReady={(c) => { cy = c; }}
    />
  );
  const r = render(view(AC, 0));
  cy.getElementById("c").position({ x: 120, y: -40 });
  vi.mocked(runIncrementalLayout).mockClear();
  return { cy: () => cy, rerender: (els: cytoscape.ElementDefinition[], epoch: number) => r.rerender(view(els, epoch)) };
}

afterEach(() => vi.clearAllMocks());

test("same canvas: a node that leaves and returns gets its old position back", () => {
  const t = setup();
  t.rerender(A, 0);
  t.rerender(AC, 0);
  expect(t.cy().getElementById("c").position()).toEqual({ x: 120, y: -40 });
  expect(runIncrementalLayout).not.toHaveBeenCalled();
});

test("after a workspace reset/open (new epoch) old positions are not resurrected", () => {
  const t = setup();
  t.rerender(AC, 1); // new epoch while the old result is still shown (placeholder data)
  t.rerender(A, 1);
  t.rerender(AC, 1);
  expect(t.cy().getElementById("c").position()).not.toEqual({ x: 120, y: -40 });
  expect(runIncrementalLayout).toHaveBeenLastCalledWith(expect.anything(), ["c"]);
});

test("removed in the same render as the epoch change: not resurrected either", () => {
  const t = setup();
  t.rerender(A, 1);
  t.rerender(AC, 1);
  expect(t.cy().getElementById("c").position()).not.toEqual({ x: 120, y: -40 });
});
