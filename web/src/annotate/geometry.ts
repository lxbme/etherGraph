import { type Annotation } from "./model";

/** Arrow head: length along the shaft and half-width across it, in model units. */
const HEAD_LENGTH = 10;
const HEAD_HALF_WIDTH = 5;

/** The head triangle [tip, left base, right base]; the tip is (x2,y2). A zero-length arrow points right. */
export function arrowHead(a: Annotation): [number, number][] {
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const len = Math.hypot(dx, dy);
  const ux = len === 0 ? 1 : dx / len;
  const uy = len === 0 ? 0 : dy / len;
  const bx = a.x2 - ux * HEAD_LENGTH;
  const by = a.y2 - uy * HEAD_LENGTH;
  return [
    [a.x2, a.y2],
    [bx - uy * HEAD_HALF_WIDTH, by + ux * HEAD_HALF_WIDTH],
    [bx + uy * HEAD_HALF_WIDTH, by - ux * HEAD_HALF_WIDTH],
  ];
}

/** The ellipse inscribed in the box spanned by the two corners. */
export function ellipseOf(a: Annotation): { cx: number; cy: number; rx: number; ry: number } {
  return { cx: (a.x1 + a.x2) / 2, cy: (a.y1 + a.y2) / 2, rx: Math.abs(a.x2 - a.x1) / 2, ry: Math.abs(a.y2 - a.y1) / 2 };
}

/** The box spanned by the two corners, normalised so w, h >= 0. */
export function rectOf(a: Annotation): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
}

/** The lines of a text annotation (always at least one). */
export function textLines(a: Annotation): string[] {
  return (a.text ?? "").split("\n");
}
