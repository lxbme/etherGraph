import { describe, expect, test } from "vitest";
import { arrowHead, ellipseOf, hitTest, rectOf, textLines } from "./geometry";
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

  test("hit testing: near a line, on or inside a box, inside a text; the topmost wins", () => {
    const list: Annotation[] = [
      a({ id: "r", kind: "rect", x1: 0, y1: 0, x2: 100, y2: 50 }),
      a({ id: "e", kind: "ellipse", x1: 200, y1: 0, x2: 300, y2: 50 }),
      a({ id: "l", kind: "arrow", x1: 0, y1: 200, x2: 100, y2: 200 }),
      a({ id: "t", kind: "text", x1: 0, y1: 300, x2: 0, y2: 300, text: "abc" }),
      a({ id: "top", kind: "rect", x1: 80, y1: 40, x2: 120, y2: 60 }),
    ];
    const at = (x: number, y: number, tol = 6) => hitTest(list, { x, y }, tol);
    expect(at(50, 25)).toBe("r");
    expect(at(-5, 25)).toBe("r"); // within the tolerance outside the outline
    expect(at(-7, 25)).toBeNull();
    expect(at(205, 2)).toBe("e"); // inside its box
    expect(at(50, 205)).toBe("l");
    expect(at(104, 203)).toBe("l"); // past the head, still within reach
    expect(at(50, 207)).toBeNull();
    expect(at(10, 305)).toBe("t");
    expect(at(10, 305 + 30)).toBeNull();
    expect(at(90, 45)).toBe("top");
    expect(at(150, 125)).toBeNull();
    expect(hitTest(list, { x: 10, y: 305 }, 6, () => ({ w: 5, h: 5 }))).toBeNull(); // measured narrower
  });
});
