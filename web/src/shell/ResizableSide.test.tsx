import { fireEvent, render, screen } from "@testing-library/react";
import { ResizableSide } from "./ResizableSide";

const KEY = "ethergraph.callTreeWidth";
const DEFAULT = "clamp(320px, 42%, 640px)";

/** Pretend the split container is `width` px wide and its side column `sideWidth` (jsdom has no layout). */
function sized(width: number, sideWidth = 400) {
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("rside")) return { width, left: 0, right: width } as DOMRect;
    if (this.classList.contains("rside__side")) return { width: sideWidth } as DOMRect;
    return real.call(this);
  });
}
const side = () => document.querySelector(".rside__side") as HTMLElement;
const setup = () => render(<ResizableSide main="m" side="s" storageKey={KEY} defaultWidth={DEFAULT} />);

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("arrow_keys_resize_and_remember_the_width", () => {
  sized(1000, 400);
  setup();
  const handle = screen.getByRole("separator", { name: "Resize column" });
  expect(handle.getAttribute("aria-orientation")).toBe("vertical");
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(side().style.width).toBe("424px");
  expect(localStorage.getItem(KEY)).toBe("424");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(side().style.width).toBe("376px");
  expect(localStorage.getItem(KEY)).toBe("376");
});

test("pointer_drag_sets_the_width_from_the_right_edge", () => {
  sized(1000);
  setup();
  const handle = screen.getByRole("separator");
  fireEvent.pointerDown(handle, { pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 600, pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(side().style.width).toBe("400px");
  expect(localStorage.getItem(KEY)).toBe("400");
});

test("clamps_to_min_side_and_min_main", () => {
  sized(1000);
  localStorage.setItem(KEY, "900");
  setup();
  expect(side().style.width).toBe("680px");
  const handle = screen.getByRole("separator");
  fireEvent.pointerDown(handle, { pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 990, pointerId: 1 });
  expect(side().style.width).toBe("280px");
});

test("junk_storage_falls_back_to_default_width", () => {
  localStorage.setItem(KEY, "abc");
  const { unmount } = setup();
  expect(side().style.width).toBe(DEFAULT);
  unmount();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  setup();
  expect(side().style.width).toBe(DEFAULT);
});
