import cytoscape from "cytoscape";
import { useEffect, useRef, type JSX } from "react";
import { createRefitGuard } from "./refit";
import { runDagreLayout, runIncrementalLayout } from "./layout";

type Pos = { x: number; y: number };
/** Definition positions applied at the last sync, keyed by node id. */
export type AppliedPositions = Map<string, Pos | undefined>;

export interface CytoscapeViewProps {
  elements: cytoscape.ElementDefinition[];
  stylesheet: cytoscape.StylesheetJson;
  layout: "incremental" | "dagre-lr";
  onTapNode(id: string, e: { shift: boolean }): void;
  onTapEdge(source: string, target: string): void;
  onDblTapNode(id: string): void;
  onDblTapEdge(source: string, target: string): void;
  /** `pos` is the rendered position relative to the canvas container (not page/client coordinates). */
  onCxtNode(id: string, pos: Pos): void;
  onBoxSelect(ids: string[]): void;
  /** A tap on empty canvas. */
  onTapBackground?(): void;
  onDragEnd(positions: Record<string, Pos>): void;
  onReady?(cy: cytoscape.Core): void;
  /**
   * A change starts a new canvas (new/opened workspace): positions of nodes from before it are not
   * remembered, so they are laid out afresh if they show up again.
   */
  positionsEpoch?: number;
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
      for (const k of Object.keys(cur)) if (!FIXED_KEYS.has(k) && !(k in d.data)) el.removeData(k);
      const changed = Object.entries(d.data).some(([k, v]) => !FIXED_KEYS.has(k) && cur[k] !== v);
      if (changed) el.data(d.data);
      const cls = classStr(d.classes);
      if (classStr(el.classes()) !== cls) el.classes(cls);
      if (isNode && d.position && !samePos(d.position, prev.get(id))) el.position({ ...d.position });
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
      selectionType: "single",
      minZoom: 0.05,
      maxZoom: 4,
    });
    cyRef.current = cy;
    appliedRef.current = new Map();
    lastPosRef.current = new Map();
    const p = () => propsRef.current;
    // Deferred (microtask) callbacks must not fire after this instance was torn down.
    let alive = true;

    cy.on("tap", "node", (e) => {
      const ev = e.originalEvent as MouseEvent | undefined;
      p().onTapNode(e.target.id(), { shift: !!ev?.shiftKey });
    });
    cy.on("tap", (e) => {
      if (e.target === cy) p().onTapBackground?.();
    });
    cy.on("tap", "edge", (e) => p().onTapEdge(e.target.data("source"), e.target.data("target")));
    cy.on("dbltap", "node", (e) => p().onDblTapNode(e.target.id()));
    cy.on("dbltap", "edge", (e) => p().onDblTapEdge(e.target.data("source"), e.target.data("target")));
    cy.on("cxttap", "node", (e) => {
      const rp = e.renderedPosition ?? e.target.renderedPosition();
      p().onCxtNode(e.target.id(), { x: rp.x, y: rp.y });
    });

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

    // `boxend` fires before the boxed elements emit `box`; collect them and flush afterwards.
    let boxed: string[] | null = null;
    cy.on("box", "node", (e) => boxed?.push(e.target.id()));
    cy.on("boxend", () => {
      boxed = [];
      queueMicrotask(() => {
        const ids = boxed ?? [];
        boxed = null;
        if (alive) p().onBoxSelect([...new Set(ids)]);
      });
    });

    const refit = createRefitGuard(
      {
        size: () => ({ width: container.clientWidth, height: container.clientHeight }),
        resize: () => cy.resize(),
        fit: () => cy.fit(undefined, 30),
      },
      // The tx flow is one whole-graph layout: keep it fitted to its container until the user moves it.
      { fitOnResize: propsRef.current.layout === "dagre-lr" },
    );
    refitRef.current = refit;
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
    propsRef.current.onReady?.(cy);
    return () => {
      alive = false;
      ro?.disconnect();
      container.removeEventListener("wheel", onUserViewport);
      container.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      refitRef.current = null;
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
    if (props.layout === "dagre-lr") {
      if (r.structureChanged) {
        runDagreLayout(cy);
        refitRef.current?.noteLayout();
      }
    } else {
      if (r.newNodeIds.length > 0) {
        runIncrementalLayout(cy, r.newNodeIds);
        refitRef.current?.noteLayout();
      }
      // A full layout fits by itself; a canvas restored from stored positions needs an explicit fit.
      const fullLayout = r.newNodeIds.length === cy.nodes().length;
      if (wasEmpty && cy.nodes().nonempty() && !fullLayout) {
        cy.fit(undefined, 40);
        refitRef.current?.noteLayout();
      }
    }
  }, [props.elements, props.layout, props.positionsEpoch]);

  return <div ref={containerRef} className="cy-view" style={{ width: "100%", height: "100%" }} />;
}
