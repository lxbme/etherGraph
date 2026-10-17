import { render, screen } from "@testing-library/react";
import { GraphTooltip } from "./GraphTooltip";

afterEach(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});
function sized(w: number, h: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => w });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => h });
}
const lines = [{ label: "Type", value: "Wallet" }];
const left = () => parseFloat(screen.getByTestId("graph-tooltip").style.left);
const top = () => parseFloat(screen.getByTestId("graph-tooltip").style.top);

test("sits right of and below the anchor when there is room", () => {
  sized(800, 600);
  render(<GraphTooltip anchor={{ x: 100, y: 100 }} lines={lines} />);
  expect(left()).toBeGreaterThan(100);
  expect(top()).toBeGreaterThan(100);
});

test("flips left of the anchor at the right edge", () => {
  sized(400, 600);
  render(<GraphTooltip anchor={{ x: 395, y: 100 }} lines={lines} />);
  expect(left()).toBeLessThan(395);
});

test("flips above the anchor at the bottom edge", () => {
  sized(800, 200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(60);
  render(<GraphTooltip anchor={{ x: 100, y: 190 }} lines={lines} />);
  expect(top()).toBeLessThan(190);
  vi.restoreAllMocks();
});
