import type cytoscape from "cytoscape";

/** A fit never zooms in past this: a two-node graph would otherwise blow its labels up until they overlap. */
export const MAX_FIT_ZOOM = 1.2;

export type Padding = { top: number; right: number; bottom: number; left: number };

/** Extra room per core that every fit keeps clear (e.g. the floating legend's strip on the left). */
const insets = new WeakMap<cytoscape.Core, Partial<Padding>>();

/** Registers the room `cy`'s fits keep clear on each side, on top of their own padding. */
export function setFitInset(cy: cytoscape.Core, inset: Partial<Padding>): void {
  insets.set(cy, inset);
}

/**
 * Fits the whole graph inside `padding` (plus the core's registered inset), then zooms back out to
 * MAX_FIT_ZOOM (centred in the same rect) if the fit went past it.
 */
export function fitClamped(cy: cytoscape.Core, padding: number | Padding): void {
  const base = typeof padding === "number" ? { top: padding, right: padding, bottom: padding, left: padding } : padding;
  const inset = insets.get(cy) ?? {};
  const p: Padding = {
    top: base.top + (inset.top ?? 0),
    right: base.right + (inset.right ?? 0),
    bottom: base.bottom + (inset.bottom ?? 0),
    left: base.left + (inset.left ?? 0),
  };
  if (p.top === p.right && p.right === p.bottom && p.bottom === p.left) {
    cy.fit(undefined, p.top);
    if (cy.zoom() > MAX_FIT_ZOOM) {
      cy.zoom(MAX_FIT_ZOOM);
      cy.center();
    }
    return;
  }
  // Cytoscape's fit takes one padding for all sides: place the bounding box in the free rect by hand.
  const eles = cy.elements();
  if (eles.empty()) return;
  const bb = eles.boundingBox();
  const w = cy.width() - p.left - p.right;
  const h = cy.height() - p.top - p.bottom;
  if (!(w > 0 && h > 0)) return;
  const fit = Math.min(bb.w > 0 ? w / bb.w : Infinity, bb.h > 0 ? h / bb.h : Infinity);
  const zoom = Math.max(cy.minZoom(), Math.min(fit, cy.maxZoom(), MAX_FIT_ZOOM));
  cy.viewport({
    zoom,
    pan: { x: p.left + w / 2 - zoom * (bb.x1 + bb.w / 2), y: p.top + h / 2 - zoom * (bb.y1 + bb.h / 2) },
  });
}

export interface RefitDeps {
  /** Current container size in CSS pixels. */
  size(): { width: number; height: number };
  resize(): void;
  fit(): void;
}

/**
 * A layout that runs while the container is `display:none` fits to a 0x0 viewport. This remembers that
 * and refits once the container gets a size. Otherwise an ordinary resize or show keeps the viewport,
 * unless `fitOnResize` is set (whole-graph layouts such as the tx flow), in which case every resize
 * refits. Either way, once the user panned/zoomed after the last layout or fit, the viewport is theirs.
 */
export function createRefitGuard(deps: RefitDeps, opts: { fitOnResize?: boolean } = {}) {
  let laidOutWhileHidden = false;
  let userMoved = false;
  const hidden = () => {
    const { width, height } = deps.size();
    return !(width > 0 && height > 0);
  };
  return {
    /** Call after every layout (or fit) that was run. */
    noteLayout(): void {
      userMoved = false;
      if (hidden()) laidOutWhileHidden = true;
    },
    /** Call on user pan/zoom gestures. */
    noteUserViewport(): void {
      userMoved = true;
    },
    /** Fits again (the free area changed, e.g. a legend opened) unless the viewport is the user's or hidden. */
    refitUnlessUserMoved(): void {
      if (!userMoved && !hidden()) deps.fit();
    },
    /** Call from the ResizeObserver. */
    onResize(): void {
      if (hidden()) return;
      deps.resize();
      if (!laidOutWhileHidden && !opts.fitOnResize) return;
      laidOutWhileHidden = false;
      if (!userMoved) deps.fit();
    },
  };
}
