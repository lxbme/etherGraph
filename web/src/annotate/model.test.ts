import { describe, expect, test } from "vitest";
import { bounds, isAnnotation, translate, txCallsView, txFlowView, type Annotation } from "./model";

const a = (over: Partial<Annotation> = {}): Annotation => ({
  id: "1", kind: "rect", color: "red", x1: 0, y1: 0, x2: 10, y2: 20, ...over,
});

describe("isAnnotation", () => {
  test("accepts the four kinds and rejects missing coordinates or unknown colours", () => {
    for (const kind of ["text", "arrow", "rect", "ellipse"] as const) expect(isAnnotation(a({ kind }))).toBe(true);
    expect(isAnnotation(a({ kind: "text", text: "hi\nthere" }))).toBe(true);
    const { x2: _x2, ...missing } = a();
    expect(isAnnotation(missing)).toBe(false);
    expect(isAnnotation(a({ x1: NaN }))).toBe(false);
    expect(isAnnotation({ ...a(), color: "green" })).toBe(false);
    expect(isAnnotation({ ...a(), kind: "star" })).toBe(false);
    expect(isAnnotation({ ...a(), text: 5 })).toBe(false);
    expect(isAnnotation(null)).toBe(false);
  });
});

describe("bounds", () => {
  test("spans every annotation including estimated text size", () => {
    expect(bounds([])).toBeNull();
    const list = [a({ x1: 10, y1: 20, x2: -5, y2: 0 }), a({ id: "2", kind: "text", x1: 100, y1: 50, x2: 100, y2: 50, text: "abcd\nab" })];
    // Text: 4 chars × 14 × 0.6 wide, 2 lines × 14 × 1.3 high.
    expect(bounds(list)).toEqual({ x1: -5, y1: 0, x2: 100 + 4 * 14 * 0.6, y2: 50 + 2 * 14 * 1.3 });
    expect(bounds(list, () => ({ w: 10, h: 5 }))).toEqual({ x1: -5, y1: 0, x2: 110, y2: 55 });
  });
});

test("translate and view ids", () => {
  expect(translate(a(), 1, 2)).toEqual(a({ x1: 1, y1: 2, x2: 11, y2: 22 }));
  expect(txFlowView("0xAB")).toBe("tx:0xab:flow");
  expect(txCallsView("0xAB")).toBe("tx:0xab:calls");
});
