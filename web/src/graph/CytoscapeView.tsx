import cytoscape from "cytoscape";
import { useEffect, useRef, type JSX } from "react";
import { createRefitGuard, fitClamped, restoreViewport, setFitInset, setRefitGuard } from "./refit";
import { layoutTarget, runDagreLayout, runIncrementalLayout } from "./layout";
import { isMoreId } from "./moreId";

type Pos = { x: number; y: number };
/** How long the pointer rests on an element before its explanation shows. */
export const HOVER_DELAY_MS = 300;

/** Definition positions applied at the last sync, keyed by node id. */
export type AppliedPositions = Map<string, Pos | undefined>;

export interface CytoscapeViewProps {
  elements: cytoscape.ElementDefinition[];
  stylesheet: cytoscape.StylesheetJson;
  layout: "incremental" | "dagre-lr";
  onTapNode(id: string, e: { shift: boolean }): void;
  /** `id` is the edge element id (`call`, `flow-<seq>-<index>` in a tx graph). */
  onTapEdge(source: string, target: string, id: string): void;
  onDblTapNode(id: string): void;
  onDblTapEdge(source: string, target: string): void;
  /** `pos` is the rendered position relative to the canvas container (not page/client coordinates). */
  onCxtNode(id: string, pos: Pos): void;
  /**
   * The natively selected nodes (box, Shift+click), lowercased and deduped; fired once per tick after any
   * change. A plain tap on a node leaves nothing selected, a Shift+tap toggles that node, a background tap
   * (with or without Shift) unselects all.
   */
  onSelectionChange(ids: string[]): void;
  /** Plain drag box-selects instead of panning (Shift+drag always box-selects). */
  selectMode?: boolean;
  /** A tap on empty canvas. */
  onTapBackground?(): void;
  onDragEnd(positions: Record<string, Pos>): void;
  onReady?(cy: cytoscape.Core): void;
  /** Hover for 300 ms over a node / edge → its id and rendered position; `null` as soon as it should go away. */
  onHover?(t: { kind: "node" | "edge"; id: string; pos: Pos } | null): void;
  /**
   * Canvas width on the left that fits keep clear (the expanded floating legend). A change refits unless
   * the user has panned or zoomed since the last layout.
   */
  fitInsetLeft?: number;
  /**
   * A change starts a new canvas (new/opened workspace): positions of nodes from before it are not
   * remembered, so they are laid out afresh if they show up again.
   */
  positionsEpoch?: number;
  /**
   * A saved layout (`dagre-lr` only), used once when the canvas first gets elements: when every node has a
   * saved position they are placed there instead of laid out, then the saved viewport (if any) is applied.
   */
  initialLayout?: { positions?: Record<string, Pos>; viewport?: { zoom: number; pan: Pos } };
}

const classStr = (c: cytoscape.ElementDefinition["classes"]) =>
  (Array.isArray(c) ? c : (c ?? "").split(/\s+/)).filter(Boolean).sort().join(" ");
const samePos = (a: Pos | undefined, b: Pos | undefined) => a?.x === b?.x && a?.y === b?.y;
const FIXED_KEYS = new Set(["id", "source", "target", "parent"]);
const isNodeDef = (d: cytoscape.ElementDefinition) => d.group !== "edges" && d.data.source === undefined;

/**
 * Diff `defs` into `cy` by id without rebuilding: removes stale elements, adds new ones,
 * and updates data/classes in place. A definition's `position` is applied to an existing
 * node only when it differs from the one applied last time (`prev`), so positions the user
 * dragged or the layout produced are never reset by unrelated updates.
 *
 * `lastPos` (updated in place) remembers where removed nodes were: a node that comes back
 * without a definition position (unhidden, filter undone…) returns there and is not new.
 * "+N more" proxies are not remembered: one that comes back is placed afresh.
 *
 * A node whose `placed` flag is dropped (a dragged proxy's position forgotten) while it still sits — and no
 * glide is taking it elsewhere — where its definition last put it is reported as new, so the layout places it again.
 */
export function syncElements(
  cy: cytoscape.Core,
  defs: cytoscape.ElementDefinition[],
  prev: AppliedPositions,
  lastPos: Map<string, Pos> = new Map(),
): { newNodeIds: string[]; structureChanged: boolean; positions: AppliedPositions } {
  const byId = new Map<string, cytoscape.ElementDefinition>();
  for (const d of defs) if (d.data.id) byId.set(d.data.id, d);
  const positions: AppliedPositions = new Map();
  const newNodeIds: string[] = [];
  let structureChanged = false;

  cy.startBatch();
  try {
    const stale = cy.elements().filter((el) => {
      const d = byId.get(el.id());
      if (!d) return true;
      // An edge whose endpoints changed must be re-created.
      return el.isEdge() && (el.data("source") !== d.data.source || el.data("target") !== d.data.target);
    });
    if (stale.nonempty()) {
      structureChanged = true;
      stale.nodes().forEach((node) => {
        if (isMoreId(node.id())) return;
        const p = node.position();
        lastPos.set(node.id(), { x: p.x, y: p.y });
      });
      cy.remove(stale);
    }

    const toAdd: cytoscape.ElementDefinition[] = [];
    for (const [id, d] of byId) {
      const isNode = isNodeDef(d);
      if (isNode) positions.set(id, d.position && { ...d.position });
      const el = cy.getElementById(id);
      if (el.empty()) {
        const back = isNode && !d.position ? lastPos.get(id) : undefined;
        const pos = d.position ?? back;
        toAdd.push(pos ? { ...d, position: { ...pos } } : d);
        if (isNode && !pos) newNodeIds.push(id);
        if (isNode) lastPos.delete(id);
        continue;
      }
      const cur = el.data() as Record<string, unknown>;
      const unplaced = isNode && cur.placed === true && !d.data.placed;
      for (const k of Object.keys(cur)) if (!FIXED_KEYS.has(k) && !(k in d.data)) el.removeData(k);
      const changed = Object.entries(d.data).some(([k, v]) => !FIXED_KEYS.has(k) && cur[k] !== v);
      if (changed) el.data(d.data);
      const cls = classStr(d.classes);
      if (classStr(el.classes()) !== cls) el.classes(cls);
      if (isNode && d.position && !samePos(d.position, prev.get(id))) el.position({ ...d.position });
      const applied = prev.get(id);
      // Where it is heading, not where it is: a Re-layout glide starts from the old spot.
      if (unplaced && applied && samePos(layoutTarget(cy, id) ?? el.position(), applied)) newNodeIds.push(id);
    }
    if (toAdd.length > 0) {
      structureChanged = true;
      cy.add([...toAdd.filter(isNodeDef), ...toAdd.filter((d) => !isNodeDef(d))]);
    }
  } finally {
    cy.endBatch();
  }
  return { newNodeIds, structureChanged, positions };
}

/** Cytoscape canvas that fills its parent; diff-applies `elements` and reports interactions. */
export function CytoscapeView(props: CytoscapeViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const appliedRef = useRef<AppliedPositions>(new Map());
  const lastPosRef = useRef<Map<string, Pos>>(new Map());
  const epochRef = useRef(props.positionsEpoch ?? 0);
  /** Nodes still on the canvas from an earlier epoch. */
  const staleRef = useRef<Set<string>>(new Set());
  const refitRef = useRef<ReturnType<typeof createRefitGuard> | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Create the instance once; handlers read the latest props through propsRef.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const cy = cytoscape({
      container,
      style: propsRef.current.stylesheet,
      elements: [],
      boxSelectionEnabled: true,
      selectionType: "additive",
      userPanningEnabled: !propsRef.current.selectMode,
      minZoom: 0.05,
      maxZoom: 4,
    });
    cyRef.current = cy;
    appliedRef.current = new Map();
    lastPosRef.current = new Map();
    const p = () => propsRef.current;
    // Deferred (microtask) callbacks must not fire after this instance was torn down.
    let alive = true;

    // Only nodes take part in the selection.
    cy.on("add", "edge", (e) => {
      e.target.unselectify();
    });
    // Every select / unselect / removal in a tick is reported once, as the resulting selection.
    let selFlush = false;
    cy.on("select unselect remove", "node", () => {
      if (selFlush) return;
      selFlush = true;
      queueMicrotask(() => {
        selFlush = false;
        if (alive) p().onSelectionChange([...new Set(cy.nodes(":selected").map((n) => n.id().toLowerCase()))]);
      });
    });

    // In additive mode Cytoscape toggles a tapped node's selection right after the `tap` event (a real
    // click only; an emitted tap does not). The fix-ups below are queued before that toggle can queue a
    // selection report, so the report sees the settled state.
    cy.on("tap", "node", (e) => {
      const node = e.target as cytoscape.NodeSingular;
      const shift = !!(e.originalEvent as MouseEvent | undefined)?.shiftKey;
      if (!node.selectable()) {
        p().onTapNode(node.id(), { shift });
        return;
      }
      if (shift) {
        const was = node.selected();
        queueMicrotask(() => {
          if (alive && node.inside() && node.selected() === was) {
            if (was) node.unselect();
            else node.select();
          }
        });
        return;
      }
      queueMicrotask(() => {
        if (alive) cy.nodes(":selected").unselect();
      });
      cy.nodes(":selected").unselect();
      p().onTapNode(node.id(), { shift });
    });
    cy.on("tap", (e) => {
      if (e.target !== cy) return;
      cy.nodes(":selected").unselect();
      p().onTapBackground?.();
    });
    cy.on("tap", "edge", (e) => p().onTapEdge(e.target.data("source"), e.target.data("target"), e.target.id()));
    cy.on("dbltap", "node", (e) => p().onDblTapNode(e.target.id()));
    cy.on("dbltap", "edge", (e) => p().onDblTapEdge(e.target.data("source"), e.target.data("target")));
    cy.on("cxttap", "node", (e) => {
      const rp = e.renderedPosition ?? e.target.renderedPosition();
      p().onCxtNode(e.target.id(), { x: rp.x, y: rp.y });
    });

    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    const hideHover = () => {
      if (hoverTimer !== undefined) clearTimeout(hoverTimer);
      hoverTimer = undefined;
      p().onHover?.(null);
    };
    cy.on("mouseover", "node, edge", (e) => {
      if (hoverTimer !== undefined) clearTimeout(hoverTimer);
      const target = e.target;
      const rp = e.renderedPosition ?? (target.isNode() ? target.renderedPosition() : { x: 0, y: 0 });
      const pos = { x: rp.x, y: rp.y };
      hoverTimer = setTimeout(() => {
        hoverTimer = undefined;
        if (alive) p().onHover?.({ kind: target.isNode() ? "node" : "edge", id: target.id(), pos });
      }, HOVER_DELAY_MS);
    });
    cy.on("mouseout", "node, edge", hideHover);
    cy.on("viewport grab drag tapstart cxttapstart", hideHover);
    // A fast exit off the canvas edge may never reach Cytoscape's mouseout.
    container.addEventListener("pointerleave", hideHover);

    // A multi-node drag emits one `dragfree` per node in the same tick; report them together.
    let dragged: Record<string, Pos> | null = null;
    cy.on("dragfree", "node", (e) => {
      if (!dragged) {
        dragged = {};
        queueMicrotask(() => {
          const moved = dragged;
          dragged = null;
          if (moved && alive) p().onDragEnd(moved);
        });
      }
      const pos = e.target.position();
      dragged[e.target.id()] = { x: pos.x, y: pos.y };
    });

    const refit = createRefitGuard(
      {
        size: () => ({ width: container.clientWidth, height: container.clientHeight }),
        resize: () => cy.resize(),
        fit: () => fitClamped(cy, 30),
      },
      // The tx flow is one whole-graph layout: keep it fitted to its container until the user moves it.
      { fitOnResize: propsRef.current.layout === "dagre-lr" },
    );
    refitRef.current = refit;
    setRefitGuard(cy, refit);
    const onUserViewport = () => refit.noteUserViewport();
    // A pointer gesture is the user's viewport only if it actually panned or zoomed (a tap or node drag is not).
    let gesture: { zoom: number; x: number; y: number } | null = null;
    const onPointerDown = () => {
      const p = cy.pan();
      gesture = { zoom: cy.zoom(), x: p.x, y: p.y };
    };
    const onPointerUp = () => {
      const g = gesture;
      gesture = null;
      if (!g || !alive) return;
      const p = cy.pan();
      if (cy.zoom() !== g.zoom || p.x !== g.x || p.y !== g.y) refit.noteUserViewport();
    };
    container.addEventListener("wheel", onUserViewport, { passive: true });
    container.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => refit.onResize());
      ro.observe(container);
    }
    // Label widths are measured with whatever font is loaded; re-measure once Inter / Plex Mono arrive.
    // (`document.fonts` is missing in jsdom; headless cores have no style object.)
    void document.fonts?.ready.then(() => {
      if (alive) cy.style()?.update();
    });
    propsRef.current.onReady?.(cy);
    return () => {
      alive = false;
      if (hoverTimer !== undefined) clearTimeout(hoverTimer);
      ro?.disconnect();
      container.removeEventListener("pointerleave", hideHover);
      container.removeEventListener("wheel", onUserViewport);
      container.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      refitRef.current = null;
      setRefitGuard(cy, null);
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style(props.stylesheet);
  }, [props.stylesheet]);

  useEffect(() => {
    cyRef.current?.userPanningEnabled(!props.selectMode);
  }, [props.selectMode]);

  // Before the elements effect, so the first layout's fit already keeps the inset clear.
  const insetRef = useRef<number | null>(null);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const left = props.fitInsetLeft ?? 0;
    setFitInset(cy, { left });
    const before = insetRef.current;
    insetRef.current = left;
    if (before !== null && before !== left && cy.nodes().nonempty()) refitRef.current?.refitUnlessUserMoved();
  }, [props.fitInsetLeft]);

  /** Whether the canvas has had elements (the saved layout is then spent). */
  const filledRef = useRef(false);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const wasEmpty = cy.nodes().empty();
    const epoch = props.positionsEpoch ?? 0;
    if (epoch !== epochRef.current) {
      epochRef.current = epoch;
      lastPosRef.current = new Map();
      staleRef.current = new Set(cy.nodes().map((n) => n.id()));
    }
    const r = syncElements(cy, props.elements, appliedRef.current, lastPosRef.current);
    appliedRef.current = r.positions;
    // An earlier canvas's node leaving now must not be remembered; one positioned by the new canvas is its own.
    for (const id of staleRef.current) {
      if (cy.getElementById(id).empty()) {
        lastPosRef.current.delete(id);
        staleRef.current.delete(id);
      } else if (r.positions.get(id)) {
        staleRef.current.delete(id);
      }
    }
    const saved = filledRef.current ? undefined : props.initialLayout;
    if (cy.nodes().nonempty()) filledRef.current = true;
    if (props.layout === "dagre-lr") {
      if (r.structureChanged) {
        const pos = saved?.positions;
        if (pos && cy.nodes().map((n) => n.id()).every((id) => !!pos[id])) {
          cy.batch(() => cy.nodes().forEach((n) => void n.position({ ...pos[n.id()]! })));
          refitRef.current?.noteLayout();
          if (saved.viewport) restoreViewport(cy, saved.viewport);
          else fitClamped(cy, 30);
        } else {
          runDagreLayout(cy);
          refitRef.current?.noteLayout();
        }
      }
    } else {
      if (r.newNodeIds.length > 0) {
        runIncrementalLayout(cy, r.newNodeIds);
        refitRef.current?.noteLayout();
      }
      // A full layout fits by itself; a canvas restored from stored positions needs an explicit fit.
      const fullLayout = r.newNodeIds.length === cy.nodes().length;
      if (wasEmpty && cy.nodes().nonempty() && !fullLayout) {
        fitClamped(cy, 40);
        refitRef.current?.noteLayout();
      }
    }
  }, [props.elements, props.layout, props.positionsEpoch]);

  return <div ref={containerRef} className="cy-view" style={{ width: "100%", height: "100%" }} />;
}
