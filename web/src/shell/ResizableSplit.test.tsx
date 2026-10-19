import { act, fireEvent, render, screen } from "@testing-library/react";
import { ResizableSplit } from "./ResizableSplit";

/** Pretend elements carrying `cls` are `height` px tall (jsdom has no layout); `.set(h)` changes it. */
function sized(cls: string, height: number) {
  const box = { height };
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains(cls) ? ({ height: box.height, top: 0, bottom: box.height } as DOMRect) : real.call(this);
  });
  return { set: (h: number) => (box.height = h) };
}
/** The 8 px separator (jsdom lays nothing out). */
function handleIs8px() {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("split__handle") ? 8 : 0;
  });
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
const bottom = () => document.querySelector(".split__bottom") as HTMLElement;

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("uses_the_given_storage_key", () => {
  sized("split", 600);
  render(<ResizableSplit top="t" bottom="b" storageKey="ethergraph.txDetailHeight" />);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
  expect(localStorage.getItem("ethergraph.txDetailHeight")).not.toBeNull();
  expect(localStorage.getItem("ethergraph.splitHeight")).toBeNull();
});

test("clamps_a_remembered_height_to_the_container", () => {
  sized("split", 600);
  localStorage.setItem("ethergraph.splitHeight", "5000");
  render(<ResizableSplit top="t" bottom="b" />);
  expect(parseFloat(bottom().style.height)).toBeLessThanOrEqual(480);
});

test("junk_or_unavailable_storage_falls_back_to_default", () => {
  localStorage.setItem("ethergraph.splitHeight", "abc");
  const { unmount } = render(<ResizableSplit top="t" bottom="b" />);
  expect(bottom().style.height).toBe("32%");
  unmount();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  render(<ResizableSplit top="t" bottom="b" />);
  expect(bottom().style.height).toBe("32%");
});

test("the_max_leaves_room_for_the_handle", () => {
  sized("split", 600);
  handleIs8px();
  localStorage.setItem("ethergraph.splitHeight", "5000");
  render(<ResizableSplit top="t" bottom="b" />);
  // top (120) + handle (8) + bottom = 600
  expect(bottom().style.height).toBe("472px");
});

test("a_container_shrink_reclamps_and_growing_back_restores_the_chosen_height", () => {
  const box = sized("split", 1000);
  const ro = observers();
  localStorage.setItem("ethergraph.splitHeight", "600");
  render(<ResizableSplit top="t" bottom="b" />);
  expect(bottom().style.height).toBe("600px");
  box.set(400);
  ro.fire();
  expect(bottom().style.height).toBe("280px");
  box.set(1000);
  ro.fire();
  expect(bottom().style.height).toBe("600px");
  expect(localStorage.getItem("ethergraph.splitHeight")).toBe("600");
});

test("a_cancelled_pointer_ends_the_drag", () => {
  sized("split", 1000);
  render(<ResizableSplit top="t" bottom="b" />);
  const handle = screen.getByRole("separator");
  fireEvent.pointerDown(handle, { pointerId: 1 });
  fireEvent.pointerMove(handle, { clientY: 700, pointerId: 1 });
  fireEvent.pointerCancel(handle, { pointerId: 1 });
  expect(bottom().style.height).toBe("300px");
  expect(localStorage.getItem("ethergraph.splitHeight")).toBe("300");
  fireEvent.pointerMove(handle, { clientY: 500, pointerId: 1 });
  expect(bottom().style.height).toBe("300px");

  fireEvent.pointerDown(handle, { pointerId: 2 });
  fireEvent.pointerMove(handle, { clientY: 600, pointerId: 2 });
  fireEvent(handle, new Event("lostpointercapture", { bubbles: true }));
  expect(localStorage.getItem("ethergraph.splitHeight")).toBe("400");
  fireEvent.pointerMove(handle, { clientY: 500, pointerId: 2 });
  expect(bottom().style.height).toBe("400px");
});

test("the_aria_label_can_be_given", () => {
  render(<ResizableSplit top="t" bottom="b" label="Resize the details panel height" />);
  expect(screen.getByRole("separator", { name: "Resize the details panel height" })).toBeInTheDocument();
});
