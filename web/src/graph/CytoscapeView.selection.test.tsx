import { render } from "@testing-library/react";
import { act } from "react";
import type cytoscape from "cytoscape";
import { CytoscapeView, type CytoscapeViewProps } from "./CytoscapeView";

vi.mock("cytoscape", async (orig) => {
  const m = (await orig()) as { default: typeof cytoscape };
  const real = m.default;
  const wrapped = Object.assign((o: cytoscape.CytoscapeOptions) => real({ ...o, container: undefined, headless: true }), real);
  return { default: wrapped };
});
vi.mock("./layout", () => ({ runDagreLayout: vi.fn(), runIncrementalLayout: vi.fn() }));

const noop = () => {};
const els: cytoscape.ElementDefinition[] = [
  { group: "nodes", data: { id: "a" }, position: { x: 10, y: 20 } },
  { group: "nodes", data: { id: "B" }, position: { x: 90, y: 20 } },
  { group: "nodes", data: { id: "c" }, position: { x: 170, y: 20 } },
  { group: "nodes", data: { id: "more:a" }, position: { x: 10, y: 90 }, selectable: false },
  { group: "edges", data: { id: "e", source: "a", target: "B" } },
];

/** Lets the view's per-tick (microtask) flushes run. */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function mount(over: Partial<CytoscapeViewProps> = {}) {
  let cy!: cytoscape.Core;
  const onSelectionChange = vi.fn<(ids: string[]) => void>();
  const onTapNode = vi.fn<CytoscapeViewProps["onTapNode"]>();
  const onTapBackground = vi.fn();
  const props: CytoscapeViewProps = {
    elements: els, stylesheet: [] as unknown as cytoscape.StylesheetJson, layout: "incremental",
    onTapNode, onTapEdge: noop, onDblTapNode: noop, onDblTapEdge: noop, onCxtNode: noop,
    onSelectionChange, onTapBackground, onDragEnd: noop, onReady: (c) => { cy = c; }, ...over,
  };
  const view = render(<CytoscapeView {...props} />);
  return { cy, view, props, onSelectionChange, onTapNode, onTapBackground };
}

const selected = (cy: cytoscape.Core) => cy.$(":selected").map((e) => e.id()).sort();

test("selection is additive: a box over nodes reports their ids once, lowercased and deduped", async () => {
  const { cy, onSelectionChange } = mount();
  expect(cy.selectionType()).toBe("additive");
  expect(cy.boxSelectionEnabled()).toBe(true);
  act(() => {
    // What a Shift+drag box over a and B does: each boxed node is selected.
    cy.emit("boxstart");
    cy.$id("a").select();
    cy.$id("B").select();
    cy.emit("boxend");
  });
  await flush();
  expect(onSelectionChange).toHaveBeenCalledTimes(1);
  expect(onSelectionChange).toHaveBeenLastCalledWith(["a", "b"]);
});

test("edges never join the selection", async () => {
  const { cy } = mount();
  act(() => { cy.$id("e").select(); });
  expect(cy.$id("e").selected()).toBe(false);
});

test("a plain tap leaves no native selection and calls onTapNode", async () => {
  const { cy, onTapNode, onSelectionChange } = mount();
  act(() => { cy.$id("a").select(); cy.$id("B").select(); });
  await flush();
  onSelectionChange.mockClear();
  act(() => {
    cy.$id("c").emit({ type: "tap", originalEvent: { shiftKey: false } } as unknown as string);
    // In a real click Cytoscape's additive mode then toggles the tapped node on.
    cy.$id("c").select();
  });
  await flush();
  expect(selected(cy)).toEqual([]);
  expect(onTapNode).toHaveBeenCalledWith("c", { shift: false });
  expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  expect(onSelectionChange.mock.calls.every(([ids]) => ids.length === 0)).toBe(true);
});

test("Shift+tap toggles that node's selection without calling onTapNode", async () => {
  const { cy, onTapNode, onSelectionChange } = mount();
  const shiftTap = (id: string) => cy.$id(id).emit({ type: "tap", originalEvent: { shiftKey: true } } as unknown as string);
  act(() => { cy.$id("a").select(); });
  await flush();
  act(() => shiftTap("c"));
  await flush();
  expect(selected(cy)).toEqual(["a", "c"]);
  expect(onSelectionChange).toHaveBeenLastCalledWith(["a", "c"]);
  // A real click: Cytoscape toggles natively right after the tap event; the view must not toggle it back.
  act(() => { shiftTap("a"); cy.$id("a").unselect(); });
  await flush();
  expect(selected(cy)).toEqual(["c"]);
  expect(onTapNode).not.toHaveBeenCalled();
});

test("a tap on an unselectable node keeps the selection and still reaches onTapNode", async () => {
  const { cy, onTapNode } = mount();
  act(() => { cy.$id("a").select(); });
  act(() => { cy.$id("more:a").emit("tap"); });
  await flush();
  expect(selected(cy)).toEqual(["a"]);
  expect(onTapNode).toHaveBeenCalledWith("more:a", { shift: false });
});

test("a background tap unselects all, with or without Shift", async () => {
  const { cy, onTapBackground, onSelectionChange } = mount();
  act(() => { cy.$id("a").select(); cy.$id("c").select(); });
  await flush();
  act(() => { cy.emit("tap"); });
  await flush();
  expect(selected(cy)).toEqual([]);
  expect(onTapBackground).toHaveBeenCalled();
  expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  act(() => { cy.$id("a").select(); });
  act(() => { cy.emit({ type: "tap", originalEvent: { shiftKey: true } } as unknown as string); });
  await flush();
  expect(selected(cy)).toEqual([]);
});

test("a removed selected node leaves the reported selection", async () => {
  const { cy, view, props, onSelectionChange } = mount();
  act(() => { cy.$id("a").select(); cy.$id("c").select(); });
  await flush();
  view.rerender(<CytoscapeView {...props} elements={els.filter((e) => e.data.id !== "c")} />);
  await flush();
  expect(onSelectionChange).toHaveBeenLastCalledWith(["a"]);
});

test("select mode turns user panning off so a plain drag box-selects; off again restores it", () => {
  const { cy, view, props } = mount();
  expect(cy.userPanningEnabled()).toBe(true);
  view.rerender(<CytoscapeView {...props} selectMode />);
  expect(cy.userPanningEnabled()).toBe(false);
  view.rerender(<CytoscapeView {...props} selectMode={false} />);
  expect(cy.userPanningEnabled()).toBe(true);
});
