import { fireEvent, render, screen } from "@testing-library/react";
import { ResizableSplit } from "./ResizableSplit";

/** Pretend elements carrying `cls` are `height` px tall (jsdom has no layout). */
function sized(cls: string, height: number) {
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains(cls) ? ({ height, top: 0, bottom: height } as DOMRect) : real.call(this);
  });
}
const bottom = () => document.querySelector(".split__bottom") as HTMLElement;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

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
