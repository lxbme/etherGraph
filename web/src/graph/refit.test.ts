import type cytoscape from "cytoscape";
import { createRefitGuard, fitClamped, MAX_FIT_ZOOM } from "./refit";

function setup(initial: { width: number; height: number }, opts?: { fitOnResize?: boolean }) {
  const size = { ...initial };
  const deps = { size: () => size, resize: vi.fn(), fit: vi.fn() };
  return { size, deps, guard: createRefitGuard(deps, opts) };
}

test("a layout while hidden followed by a resize to 800x600 refits", () => {
  const { size, deps, guard } = setup({ width: 0, height: 0 });
  guard.noteLayout();
  guard.onResize(); // still hidden: nothing happens
  expect(deps.fit).not.toHaveBeenCalled();
  size.width = 800;
  size.height = 600;
  guard.onResize();
  expect(deps.resize).toHaveBeenCalledTimes(1);
  expect(deps.fit).toHaveBeenCalledTimes(1);
  guard.onResize(); // flag cleared: later resizes keep the viewport
  expect(deps.fit).toHaveBeenCalledTimes(1);
});

test("an ordinary zero to non-zero resize without a hidden layout does not fit", () => {
  const { size, deps, guard } = setup({ width: 0, height: 0 });
  size.width = 800;
  size.height = 600;
  guard.onResize();
  expect(deps.resize).toHaveBeenCalled();
  expect(deps.fit).not.toHaveBeenCalled();
});

test("a layout while visible never refits on later resizes", () => {
  const { size, deps, guard } = setup({ width: 800, height: 600 });
  guard.noteLayout();
  size.width = 900;
  guard.onResize();
  expect(deps.fit).not.toHaveBeenCalled();
});

test("user pan/zoom after a hidden layout keeps the viewport", () => {
  const { size, deps, guard } = setup({ width: 0, height: 600 });
  guard.noteLayout();
  guard.noteUserViewport();
  size.width = 800;
  guard.onResize();
  expect(deps.fit).not.toHaveBeenCalled();
});

test("fitOnResize: a visible resize refits until the user pans or zooms; a new layout re-arms it", () => {
  const { size, deps, guard } = setup({ width: 800, height: 600 }, { fitOnResize: true });
  guard.noteLayout();
  size.width = 500;
  guard.onResize();
  expect(deps.fit).toHaveBeenCalledTimes(1);
  guard.noteUserViewport();
  size.width = 900;
  guard.onResize();
  expect(deps.fit).toHaveBeenCalledTimes(1);
  guard.noteLayout();
  size.width = 700;
  guard.onResize();
  expect(deps.fit).toHaveBeenCalledTimes(2);
});

/** A stand-in Core whose fit lands at `fitZoom`. */
function fakeCore(fitZoom: number) {
  let zoom = 1;
  const cy = {
    fit: vi.fn(() => { zoom = fitZoom; }),
    zoom: vi.fn((z?: number) => { if (z !== undefined) zoom = z; return zoom; }),
    center: vi.fn(),
  };
  return cy;
}

test("fitClamped never zooms a small graph in past MAX_FIT_ZOOM, and re-centres it", () => {
  const cy = fakeCore(3);
  fitClamped(cy as unknown as cytoscape.Core, 30);
  expect(cy.fit).toHaveBeenCalledWith(undefined, 30);
  expect(cy.zoom()).toBe(MAX_FIT_ZOOM);
  expect(cy.center).toHaveBeenCalledTimes(1);
  expect(MAX_FIT_ZOOM).toBe(1.2);
});

test("fitClamped keeps a fit that already zooms out", () => {
  const cy = fakeCore(0.5);
  fitClamped(cy as unknown as cytoscape.Core, 40);
  expect(cy.zoom()).toBe(0.5);
  expect(cy.center).not.toHaveBeenCalled();
});
