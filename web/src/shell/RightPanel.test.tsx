import { fireEvent, render, screen } from "@testing-library/react";
import { RightPanel } from "./RightPanel";

const KEY = "eg.rightWidth";

function setup(right = 1000) {
  const { unmount } = render(<RightPanel>body</RightPanel>);
  const handle = screen.getByRole("separator", { name: "Resize the details panel" });
  const panel = handle.closest(".main__right") as HTMLElement;
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ right } as DOMRect);
  return { handle, panel, unmount };
}
function drag(handle: HTMLElement, toX: number) {
  fireEvent.pointerDown(handle, { clientX: 700, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: toX, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientX: toX, pointerId: 1 });
}

beforeEach(() => {
  localStorage.clear();
  window.innerWidth = 1024;
});
afterEach(() => vi.restoreAllMocks());

test("defaults to 320px", () => {
  const { panel } = setup();
  expect(panel.style.width).toBe("320px");
});

test("dragging the left edge to 200px clamps the width to 280px and persists it", () => {
  const { handle, panel } = setup();
  drag(handle, 800); // right edge 1000 - pointer 800 = 200px
  expect(panel.style.width).toBe("280px");
  expect(localStorage.getItem(KEY)).toBe("280");
});

test("dragging widens up to 40% of the viewport", () => {
  const { handle, panel } = setup();
  drag(handle, 640);
  expect(panel.style.width).toBe("360px");
  drag(handle, 100);
  expect(panel.style.width).toBe("409px"); // floor(1024 * 0.4)
  expect(localStorage.getItem(KEY)).toBe("409");
});

test("pointer moves without a press do nothing", () => {
  const { handle, panel } = setup();
  fireEvent.pointerMove(handle, { clientX: 600, pointerId: 1 });
  expect(panel.style.width).toBe("320px");
});

test("restores a stored width, clamped to the current bounds", () => {
  localStorage.setItem(KEY, "350");
  const { panel } = setup();
  expect(panel.style.width).toBe("350px");
});

test("ignores an invalid stored width and an unavailable storage", () => {
  localStorage.setItem(KEY, "abc");
  const first = setup();
  expect(first.panel.style.width).toBe("320px");
  first.unmount();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  const { handle, panel } = setup();
  expect(panel.style.width).toBe("320px");
  drag(handle, 600);
  expect(panel.style.width).toBe("400px");
});

test("arrow keys resize in 16px steps", () => {
  const { handle, panel } = setup();
  handle.focus();
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(panel.style.width).toBe("336px");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(panel.style.width).toBe("304px");
  expect(localStorage.getItem(KEY)).toBe("304");
});

test("the separator exposes its range: 280px to 40% of the viewport", () => {
  const { handle } = setup();
  expect(handle).toHaveAttribute("aria-valuemin", "280");
  expect(handle).toHaveAttribute("aria-valuemax", "409");
  expect(handle).toHaveAttribute("aria-valuenow", "320");
});
