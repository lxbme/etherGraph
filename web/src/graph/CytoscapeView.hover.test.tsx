import type { Mock } from "vitest";
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

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const noop = () => {};
const els: cytoscape.ElementDefinition[] = [
  { group: "nodes", data: { id: "a" }, position: { x: 10, y: 20 } },
  { group: "nodes", data: { id: "b" }, position: { x: 90, y: 20 } },
  { group: "edges", data: { id: "e", source: "a", target: "b" } },
];

type HoverFn = NonNullable<CytoscapeViewProps["onHover"]>;
function mount(onHover: Mock<HoverFn>) {
  let cy!: cytoscape.Core;
  const view = render(
    <CytoscapeView
      elements={els} stylesheet={[] as unknown as cytoscape.StylesheetJson} layout="incremental"
      onTapNode={noop} onTapEdge={noop} onDblTapNode={noop} onDblTapEdge={noop} onCxtNode={noop}
      onBoxSelect={noop} onDragEnd={noop} onHover={onHover} onReady={(c) => { cy = c; }}
    />,
  );
  onHover.mockClear(); // mounting pans/fits, which hides (a no-op)
  return { cy, view };
}

test("mouseover fires after 300ms, not before", () => {
  const onHover = vi.fn<HoverFn>();
  const { cy } = mount(onHover);
  cy.getElementById("a").emit("mouseover");
  vi.advanceTimersByTime(299);
  expect(onHover).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onHover).toHaveBeenCalledTimes(1);
  expect(onHover.mock.calls[0]![0]).toMatchObject({ kind: "node", id: "a" });
});

test("edges report kind edge", () => {
  const onHover = vi.fn<HoverFn>();
  const { cy } = mount(onHover);
  cy.getElementById("e").emit("mouseover");
  vi.advanceTimersByTime(300);
  expect(onHover.mock.calls[0]![0]).toMatchObject({ kind: "edge", id: "e" });
});

test("mouseout hides at once and cancels a pending show", () => {
  const onHover = vi.fn<HoverFn>();
  const { cy } = mount(onHover);
  cy.getElementById("a").emit("mouseover");
  vi.advanceTimersByTime(100);
  cy.getElementById("a").emit("mouseout");
  expect(onHover).toHaveBeenLastCalledWith(null);
  vi.advanceTimersByTime(500);
  expect(onHover.mock.calls.filter((c) => c[0] !== null)).toHaveLength(0);
});

test.each(["viewport", "grab", "tapstart", "cxttapstart"])("%s hides a shown tooltip", (ev) => {
  const onHover = vi.fn<HoverFn>();
  const { cy } = mount(onHover);
  cy.getElementById("a").emit("mouseover");
  vi.advanceTimersByTime(300);
  act(() => { cy.emit(ev); });
  expect(onHover).toHaveBeenLastCalledWith(null);
});

test("unmount cancels a pending show", () => {
  const onHover = vi.fn<HoverFn>();
  const { cy, view } = mount(onHover);
  cy.getElementById("a").emit("mouseover");
  view.unmount();
  vi.advanceTimersByTime(500);
  expect(onHover).not.toHaveBeenCalled();
});

test("the pointer leaving the canvas hides at once and cancels a pending show", () => {
  const onHover = vi.fn<HoverFn>();
  const { cy, view } = mount(onHover);
  const container = view.container.querySelector(".cy-view")!;
  cy.getElementById("a").emit("mouseover");
  vi.advanceTimersByTime(300);
  act(() => { container.dispatchEvent(new Event("pointerleave")); });
  expect(onHover).toHaveBeenLastCalledWith(null);
  cy.getElementById("b").emit("mouseover");
  vi.advanceTimersByTime(100);
  act(() => { container.dispatchEvent(new Event("pointerleave")); });
  vi.advanceTimersByTime(500);
  expect(onHover).toHaveBeenLastCalledWith(null);
});
