import type cytoscape from "cytoscape";
import { createRefitGuard, fitClamped, MAX_FIT_ZOOM, setFitInset } from "./refit";

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

/** A stand-in Core of `w`×`h` whose elements span `bb`, recording the viewport set. */
function boxCore(w: number, h: number, bb: { x1: number; y1: number; w: number; h: number }) {
  const set = { zoom: 1, pan: { x: 0, y: 0 } };
  const cy = {
    width: () => w,
    height: () => h,
    minZoom: () => 0.05,
    maxZoom: () => 4,
    elements: () => ({ empty: () => false, boundingBox: () => ({ ...bb, x2: bb.x1 + bb.w, y2: bb.y1 + bb.h }) }),
    fit: vi.fn(),
    center: vi.fn(),
    zoom: vi.fn(() => set.zoom),
    viewport: vi.fn((v: { zoom: number; pan: { x: number; y: number } }) => { set.zoom = v.zoom; set.pan = v.pan; }),
  };
  /** Rendered x/y of a model point under the viewport that was set. */
  const at = (x: number, y: number) => ({ x: set.pan.x + set.zoom * x, y: set.pan.y + set.zoom * y });
  return { cy, set, at, core: cy as unknown as cytoscape.Core };
}

describe("fitClamped with asymmetric padding", () => {
  test("fits the graph into the rect inside the padding", () => {
    const { set, at, core } = boxCore(1000, 600, { x1: -200, y1: 50, w: 1340, h: 200 });
    fitClamped(core, { top: 30, right: 30, bottom: 30, left: 300 });
    expect(set.zoom).toBeCloseTo(0.5);
    // The wide graph spans exactly the free width; vertically it is centred in the free height.
    expect(at(-200, 0).x).toBeCloseTo(300);
    expect(at(1140, 0).x).toBeCloseTo(970);
    expect(at(0, 150).y).toBeCloseTo(300);
  });

  test("a small graph stays at MAX_FIT_ZOOM, centred in the free rect", () => {
    const { set, at, core } = boxCore(1000, 600, { x1: 0, y1: 0, w: 100, h: 50 });
    fitClamped(core, { top: 30, right: 30, bottom: 30, left: 300 });
    expect(set.zoom).toBe(MAX_FIT_ZOOM);
    expect(at(50, 25).x).toBeCloseTo(300 + 670 / 2);
    expect(at(50, 25).y).toBeCloseTo(300);
  });

  test("a core's registered inset adds to a uniform padding; without one the plain fit is used", () => {
    const { cy, set, at, core } = boxCore(1000, 600, { x1: 0, y1: 0, w: 1340, h: 100 });
    setFitInset(core, { left: 200 });
    fitClamped(core, 30);
    expect(cy.fit).not.toHaveBeenCalled();
    expect(at(0, 0).x).toBeCloseTo(230);
    expect(at(1340, 0).x).toBeCloseTo(970);
    expect(set.zoom).toBeCloseTo(740 / 1340);
    setFitInset(core, { left: 0 });
    fitClamped(core, 30);
    expect(cy.fit).toHaveBeenCalledWith(undefined, 30);
  });

  test("no room left inside the padding: the viewport is left alone", () => {
    const { cy, core } = boxCore(200, 600, { x1: 0, y1: 0, w: 100, h: 50 });
    fitClamped(core, { top: 30, right: 30, bottom: 30, left: 300 });
    expect(cy.viewport).not.toHaveBeenCalled();
  });
});

test("refitUnlessUserMoved fits a visible canvas the user has not panned or zoomed", () => {
  const { size, deps, guard } = setup({ width: 800, height: 600 });
  guard.noteLayout();
  guard.refitUnlessUserMoved();
  expect(deps.fit).toHaveBeenCalledTimes(1);
  guard.noteUserViewport();
  guard.refitUnlessUserMoved();
  expect(deps.fit).toHaveBeenCalledTimes(1);
  guard.noteLayout();
  size.width = 0;
  guard.refitUnlessUserMoved();
  expect(deps.fit).toHaveBeenCalledTimes(1);
});
