import { arrowHead, ellipseOf, rectOf, textLines } from "./geometry";
import { FONT_SIZE, LINE_HEIGHT, STROKE_WIDTH, type Annotation, type AnnotationColor } from "./model";

/** Paints annotations in the context's current transform (model coordinates); shared by the PNG and SVG exports. */
export function paintAnnotations(
  ctx: CanvasRenderingContext2D,
  list: Annotation[],
  colors: Record<AnnotationColor, string>,
): void {
  ctx.save();
  ctx.lineWidth = STROKE_WIDTH;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.font = `${FONT_SIZE}px sans-serif`;
  ctx.textBaseline = "top"; // (x1,y1) is the top-left of the first line
  ctx.textAlign = "left";
  for (const a of list) {
    const c = colors[a.color];
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    switch (a.kind) {
      case "rect": {
        const { x, y, w, h } = rectOf(a);
        ctx.strokeRect(x, y, w, h);
        break;
      }
      case "ellipse": {
        const { cx, cy, rx, ry } = ellipseOf(a);
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "arrow": {
        ctx.beginPath();
        ctx.moveTo(a.x1, a.y1);
        ctx.lineTo(a.x2, a.y2);
        ctx.stroke();
        ctx.beginPath();
        arrowHead(a).forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "text":
        textLines(a).forEach((line, i) => ctx.fillText(line, a.x1, a.y1 + i * FONT_SIZE * LINE_HEIGHT));
        break;
    }
  }
  ctx.restore();
}
