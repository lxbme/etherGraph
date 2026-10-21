import type cytoscape from "cytoscape";
import { Context as SvgContext } from "svgcanvas";
import { annotationColors } from "../annotate/colors";
import { textWidth } from "../annotate/measure";
import { LINE_HEIGHT, bounds, textFontOf, textSizeOf, type Annotation } from "../annotate/model";
import { paintAnnotations } from "../annotate/paint";
import { textLines } from "../annotate/geometry";
import { useTheme } from "../shell/theme";
import { canvasColor } from "./styles";

export type ImageFormat = "png" | "png-transparent" | "svg";

export const IMAGE_EXT: Record<ImageFormat, string> = { png: "png", "png-transparent": "png", svg: "svg" };

/**
 * The classes the stylesheets use for temporary state: the detail selection (`selected`, nodes and edges) and a
 * highlighted transfer (`highlighted`). The box selection is Cytoscape's native `:selected`; nothing styles hover.
 */
export const TRANSIENT_CLASSES = ["selected", "highlighted"] as const;

/**
 * Runs `render` on a canvas without temporary state (no selection, no transient class), then puts that state
 * back exactly, also when `render` throws. Everything happens in one tick, so the canvas' selection report
 * (deferred to a microtask) only sees the restored selection.
 */
export function withCleanCanvas<T>(cy: cytoscape.Core, render: () => T): T {
  const selected = cy.$(":selected");
  const stripped = TRANSIENT_CLASSES.map((cls) => [cls, cy.elements(`.${cls}`)] as const);
  try {
    cy.batch(() => {
      selected.unselect();
      for (const [cls, eles] of stripped) eles.removeClass(cls);
    });
    return render();
  } finally {
    cy.batch(() => {
      for (const [cls, eles] of stripped) eles.addClass(cls);
      selected.select();
    });
  }
}

/** Model units of air around the annotations in the exported image. */
const NOTE_PAD = 16;
/** The PNG export's scale, which Cytoscape multiplies by the device pixel ratio. */
const PNG_SCALE = 2;

type Box = { x1: number; y1: number; x2: number; y2: number };

/** The size of a text annotation in its own font and size (the same measure the overlay uses on screen, via the canvas). */
function measureNote(a: Annotation): { w: number; h: number } {
  const lines = textLines(a);
  const size = textSizeOf(a);
  const font = textFontOf(a);
  return {
    w: Math.max(...lines.map((l) => textWidth(l, font, size)), 0),
    h: lines.length * size * LINE_HEIGHT,
  };
}

/** The elements' box grown to take in the annotations (with some padding); `bb` itself when there are none. */
function unionBox(bb: Box, annotations: Annotation[]): Box {
  const n = bounds(annotations, measureNote);
  if (!n) return bb;
  return {
    x1: Math.min(bb.x1, n.x1 - NOTE_PAD),
    y1: Math.min(bb.y1, n.y1 - NOTE_PAD),
    x2: Math.max(bb.x2, n.x2 + NOTE_PAD),
    y2: Math.max(bb.y2, n.y2 + NOTE_PAD),
  };
}

/**
 * The whole graph as an image: PNG at 2x on the theme's canvas colour, PNG without a background, or SVG. The
 * `annotations` (model coordinates) are drawn on top and widen the image to include them; the PNG with annotations is
 * composed asynchronously (the Cytoscape render has to be decoded first), everything else returns the blob directly.
 */
export function exportImage(cy: cytoscape.Core, format: ImageFormat, annotations: Annotation[] = []): Blob | Promise<Blob> {
  const theme = useTheme.getState().resolved;
  const bg = canvasColor(theme);
  return withCleanCanvas(cy, () => {
    if (format === "svg") return svgOf(cy, bg, annotations, theme);
    const transparent = format === "png-transparent";
    const png = transparent
      ? cy.png({ full: true, scale: PNG_SCALE, output: "blob" })
      : cy.png({ full: true, scale: PNG_SCALE, bg, output: "blob" });
    if (annotations.length === 0) return png;
    return compose(png, cy.elements().boundingBox(), annotations, transparent ? null : bg, theme);
  });
}

/**
 * The Cytoscape render `png` of the elements' box `bb`, placed on a canvas of the union box with the annotations on
 * top, at the render's own scale (PNG_SCALE times the device pixel ratio, read off the bitmap) and on whole pixels.
 */
async function compose(png: Blob, bb: Box, annotations: Annotation[], bg: string | null, theme: "light" | "dark"): Promise<Blob> {
  const img = await createImageBitmap(png);
  // Cytoscape renders ceil(bb.w) × ceil(bb.h) model units from the box's top-left: the image takes in all of it.
  const w = Math.max(1, Math.ceil(bb.x2 - bb.x1));
  const scale = img.width / w;
  const u = unionBox({ ...bb, x2: bb.x1 + w, y2: bb.y1 + img.height / scale }, annotations);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil((u.x2 - u.x1) * scale);
  canvas.height = Math.ceil((u.y2 - u.y1) * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, Math.round((bb.x1 - u.x1) * scale), Math.round((bb.y1 - u.y1) * scale));
  img.close?.();
  ctx.scale(scale, scale);
  ctx.translate(-u.x1, -u.y1);
  paintAnnotations(ctx, annotations, annotationColors(theme));
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
}

/** The parts of Cytoscape's canvas renderer the SVG pass uses (internal API, stable across 3.x). */
interface CanvasRenderer {
  getCachedZSortedEles(): unknown;
  drawElements(context: CanvasRenderingContext2D, eles: unknown): void;
  path2dEnabled(on?: boolean): boolean | undefined;
}
type Scratch = { _private: { rscratch: { pathCache?: unknown } } };

/**
 * Replays Cytoscape's own drawing of the full graph (what `cy.png({ full: true })` draws) onto an SVG-recording
 * context: nodes, edges, arrows, labels and the corner icons (as embedded images), on a `bg` backdrop, then the
 * annotations; the image spans the elements and the annotations.
 */
function svgOf(cy: cytoscape.Core, bg: string, annotations: Annotation[], theme: "light" | "dark"): Blob {
  const r = (cy as unknown as { renderer(): CanvasRenderer }).renderer();
  const bb = unionBox(cy.elements().boundingBox(), annotations);
  const width = Math.max(1, Math.ceil(bb.x2 - bb.x1));
  const height = Math.max(1, Math.ceil(bb.y2 - bb.y1));
  const ctx = new SvgContext({ width, height });
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.translate(-bb.x1, -bb.y1);
  // A Path2D fill is lost on the SVG context: draw plain paths for this pass. A node's cached Path2D also
  // switches its icon placement to node-relative coordinates, so it is set aside meanwhile.
  const paths = r.path2dEnabled();
  const nodes = cy.nodes().toArray() as unknown as Scratch[];
  const cached = nodes.map((n) => n._private.rscratch.pathCache);
  r.path2dEnabled(false);
  for (const n of nodes) n._private.rscratch.pathCache = undefined;
  try {
    r.drawElements(ctx, r.getCachedZSortedEles());
  } finally {
    r.path2dEnabled(paths);
    nodes.forEach((n, i) => (n._private.rscratch.pathCache = cached[i]));
  }
  // Without annotations the SVG stays as it was (painting none would still add an empty group).
  if (annotations.length > 0) paintAnnotations(ctx as unknown as CanvasRenderingContext2D, annotations, annotationColors(theme));
  return new Blob([ctx.getSerializedSvg()], { type: "image/svg+xml" });
}
