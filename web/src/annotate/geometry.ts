import { bounds, type Annotation } from "./model";

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

/** The distance from `p` to the segment a→b. */
export function distToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * The topmost annotation at the model point `p` (null when none): an arrow within `tol` of its shaft, a rectangle or
 * ellipse inside its box or within `tol` of it, a text inside its (measured or estimated) bounds.
 */
export function hitTest(
  list: Annotation[],
  p: { x: number; y: number },
  tol: number,
  measure?: (a: Annotation) => { w: number; h: number },
): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i]!;
    if (a.kind === "arrow") {
      if (distToSegment(p, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) <= tol) return a.id;
      continue;
    }
    const b = bounds([a], measure)!;
    const pad = a.kind === "text" ? 0 : tol;
    if (p.x >= b.x1 - pad && p.x <= b.x2 + pad && p.y >= b.y1 - pad && p.y <= b.y2 + pad) return a.id;
  }
  return null;
}
