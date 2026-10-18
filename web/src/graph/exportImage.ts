import type cytoscape from "cytoscape";
import { Context as SvgContext } from "svgcanvas";
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

/** The whole graph as an image: PNG at 2x on the theme's canvas colour, PNG without a background, or SVG. */
export function exportImage(cy: cytoscape.Core, format: ImageFormat): Blob {
  const bg = canvasColor(useTheme.getState().resolved);
  return withCleanCanvas(cy, () => {
    if (format === "svg") return svgOf(cy, bg);
    return format === "png"
      ? cy.png({ full: true, scale: 2, bg, output: "blob" })
      : cy.png({ full: true, scale: 2, output: "blob" });
  });
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
 * context: nodes, edges, arrows, labels and the corner icons (as embedded images), on a `bg` backdrop.
 */
function svgOf(cy: cytoscape.Core, bg: string): Blob {
  const r = (cy as unknown as { renderer(): CanvasRenderer }).renderer();
  const bb = cy.elements().boundingBox();
  const width = Math.max(1, Math.ceil(bb.w));
  const height = Math.max(1, Math.ceil(bb.h));
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
  return new Blob([ctx.getSerializedSvg()], { type: "image/svg+xml" });
}
