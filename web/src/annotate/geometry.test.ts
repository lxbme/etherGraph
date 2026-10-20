import { describe, expect, test } from "vitest";
import { arrowHead, ellipseOf, rectOf, textLines } from "./geometry";
import type { Annotation } from "./model";

const a = (over: Partial<Annotation>): Annotation => ({ id: "1", kind: "arrow", color: "red", x1: 0, y1: 0, x2: 100, y2: 0, ...over });

describe("annotation geometry", () => {
  test("arrow head points at (x2,y2) along the shaft", () => {
    const [tip, l, r] = arrowHead(a({}));
    expect(tip).toEqual([100, 0]);
    // base is 10 back along the shaft, 5 either side
    expect(l![0]).toBeCloseTo(90);
    expect(r![0]).toBeCloseTo(90);
    expect(Math.abs(l![1])).toBeCloseTo(5);
    expect(l![1] + r![1]).toBeCloseTo(0);
    const [t2, l2] = arrowHead(a({ x2: 0, y2: 50 }));
    expect(t2).toEqual([0, 50]);
    expect(l2![1]).toBeCloseTo(40);
  });

  test("a zero-length arrow has a degenerate head at the point", () => {
    const pts = arrowHead(a({ x2: 0, y2: 0 }));
    expect(pts).toHaveLength(3);
    for (const p of pts) expect(p.every(Number.isFinite)).toBe(true);
  });

  test("rect and ellipse normalise reversed corners", () => {
    const r = a({ kind: "rect", x1: 50, y1: 40, x2: 10, y2: 10 });
    expect(rectOf(r)).toEqual({ x: 10, y: 10, w: 40, h: 30 });
    expect(ellipseOf({ ...r, kind: "ellipse" })).toEqual({ cx: 30, cy: 25, rx: 20, ry: 15 });
  });

  test("textLines splits on newlines", () => {
    expect(textLines(a({ kind: "text", text: "a\nb" }))).toEqual(["a", "b"]);
    expect(textLines(a({ kind: "text" }))).toEqual([""]);
  });
});
