import { act, fireEvent, render, screen } from "@testing-library/react";
import { ResizableSide } from "./ResizableSide";

const KEY = "ethergraph.callTreeWidth";
const DEFAULT = "clamp(320px, 42%, 640px)";

/** Pretend the split container is `width` px wide and its side column `sideWidth` (jsdom has no layout); `.set(w)` changes it. */
function sized(width: number, sideWidth = 400) {
  const box = { width };
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("rside")) return { width: box.width, left: 0, right: box.width } as DOMRect;
    if (this.classList.contains("rside__side")) return { width: sideWidth } as DOMRect;
    return real.call(this);
  });
  return { set: (w: number) => (box.width = w) };
}
/** A ResizeObserver whose callbacks the test fires by hand. */
function observers() {
  const cbs: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        cbs.push(cb);
      }
      observe() {}
      disconnect() {}
    },
  );
  return { fire: () => act(() => cbs.forEach((cb) => cb())) };
}
const side = () => document.querySelector(".rside__side") as HTMLElement;
const setup = () => render(<ResizableSide main="m" side="s" storageKey={KEY} defaultWidth={DEFAULT} />);

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

test("a_container_shrink_reclamps_and_growing_back_restores_the_chosen_width", () => {
  const box = sized(1400);
  const ro = observers();
  setup();
  const handle = screen.getByRole("separator");
  fireEvent.pointerDown(handle, { pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 648, pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(side().style.width).toBe("752px");
  box.set(900);
  ro.fire();
  expect(side().style.width).toBe("580px");
  box.set(1400);
  ro.fire();
  expect(side().style.width).toBe("752px");
  expect(localStorage.getItem(KEY)).toBe("752");
});

test("a_cancelled_pointer_ends_the_drag", () => {
  sized(1000);
  setup();
  const handle = screen.getByRole("separator");
  fireEvent.pointerDown(handle, { pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 600, pointerId: 1 });
  fireEvent.pointerCancel(handle, { pointerId: 1 });
  expect(localStorage.getItem(KEY)).toBe("400");
  fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 });
  expect(side().style.width).toBe("400px");

  fireEvent.pointerDown(handle, { pointerId: 2 });
  fireEvent.pointerMove(handle, { clientX: 550, pointerId: 2 });
  fireEvent(handle, new Event("lostpointercapture", { bubbles: true }));
  expect(localStorage.getItem(KEY)).toBe("450");
  fireEvent.pointerMove(handle, { clientX: 500, pointerId: 2 });
  expect(side().style.width).toBe("450px");
});
