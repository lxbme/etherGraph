import { createRefitGuard } from "./refit";

function setup(initial: { width: number; height: number }) {
  const size = { ...initial };
  const deps = { size: () => size, resize: vi.fn(), fit: vi.fn() };
  return { size, deps, guard: createRefitGuard(deps) };
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
