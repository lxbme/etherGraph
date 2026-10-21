import { describe, expect, test } from "vitest";
import { FONT_FAMILY, FONT_MONO, FONT_SIZE, LINE_HEIGHT, STROKE_WIDTH, fontOf, type Annotation } from "./model";
import { paintAnnotations } from "./paint";

const COLORS = { red: "#r", amber: "#a", blue: "#b", ink: "#i" };
const a = (over: Partial<Annotation>): Annotation => ({ id: "1", kind: "rect", color: "red", x1: 0, y1: 0, x2: 10, y2: 10, ...over });

/** A recording ctx: every call and property write, in order. */
function fakeCtx() {
  const log: string[] = [];
  const calls: [string, unknown[]][] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) => (k in state ? state[k] : (...args: unknown[]) => void (log.push(k), calls.push([k, args]))),
    set: (_t, k: string, v) => ((state[k] = v), log.push(`${k}=${String(v)}`), true),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log, calls };
}

describe("paintAnnotations", () => {
  test("draws each kind with its colour and fixed stroke", () => {
    const { ctx, log, calls } = fakeCtx();
    paintAnnotations(
      ctx,
      [a({ kind: "rect", color: "red" }), a({ kind: "ellipse", color: "blue" }), a({ kind: "arrow", color: "amber", x2: 100, y2: 0 })],
      COLORS,
    );
    expect(log).toContain("strokeStyle=#r");
    expect(log).toContain("strokeStyle=#b");
    expect(log).toContain("strokeStyle=#a");
    expect(log).toContain("fillStyle=#a"); // arrow head
    expect(log.filter((l) => l.startsWith("lineWidth="))).toEqual([`lineWidth=${STROKE_WIDTH}`]); // set once, never per shape
    expect(calls.some(([n]) => n === "strokeRect" || n === "rect")).toBe(true);
    expect(calls.some(([n]) => n === "ellipse")).toBe(true);
    expect(calls.filter(([n]) => n === "fill").length).toBe(1);
  });

  test("text draws one fillText per line at FONT_SIZE x LINE_HEIGHT spacing", () => {
    const { ctx, log, calls } = fakeCtx();
    paintAnnotations(ctx, [a({ kind: "text", color: "ink", x1: 5, y1: 7, text: "a\nb\nc" })], COLORS);
    const t = calls.filter(([n]) => n === "fillText");
    expect(t.map(([, args]) => args[0])).toEqual(["a", "b", "c"]);
    expect(t.map(([, args]) => args[2])).toEqual([7, 7 + FONT_SIZE * LINE_HEIGHT, 7 + 2 * FONT_SIZE * LINE_HEIGHT]);
    expect(log).toContain("fillStyle=#i");
    expect(log).toContain("textBaseline=hanging"); // as the overlay's dominant-baseline; svgcanvas keeps "hanging"
  });

  test("text uses the page font stack, as the overlay does", () => {
    const { ctx, log } = fakeCtx();
    paintAnnotations(ctx, [a({ kind: "text", text: "x" })], COLORS);
    expect(log).toContain(`font=${FONT_SIZE}px ${FONT_FAMILY}`);
    expect(fontOf(FONT_SIZE)).toBe(`${FONT_SIZE}px ${FONT_FAMILY}`);
  });

  test("each text is painted in its own font and line spacing", () => {
    const { ctx, log, calls } = fakeCtx();
    paintAnnotations(
      ctx,
      [a({ kind: "text", y1: 0, text: "a\nb", size: 24, font: "mono" }), a({ id: "2", kind: "text", y1: 100, text: "c\nd" })],
      COLORS,
    );
    const fonts = log.filter((l) => l.startsWith("font="));
    expect(fonts.slice(-2)).toEqual([`font=24px ${FONT_MONO}`, `font=${FONT_SIZE}px ${FONT_FAMILY}`]);
    expect(fontOf(24, "mono")).toBe(`24px ${FONT_MONO}`);
    const ys = calls.filter(([n]) => n === "fillText").map(([, args]) => args[2]);
    expect(ys).toEqual([0, 24 * LINE_HEIGHT, 100, 100 + FONT_SIZE * LINE_HEIGHT]);
  });

  test("text keeps leading, trailing and repeated spaces (an SVG collapses plain ones); single inner spaces stay plain", () => {
    const { ctx, calls } = fakeCtx();
    paintAnnotations(ctx, [a({ kind: "text", text: "  a  b c \nx" })], COLORS);
    const t = calls.filter(([n]) => n === "fillText").map(([, args]) => args[0]);
    expect(t).toEqual(["\u00a0 a\u00a0 b c\u00a0", "x"]);
  });
});
