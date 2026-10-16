import cytoscape from "cytoscape";
import { useEffect, useRef, type JSX } from "react";
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
  onCxtNode(id: string, pos: Pos): void;
  onBoxSelect(ids: string[]): void;
  onDragEnd(positions: Record<string, Pos>): void;
  onReady?(cy: cytoscape.Core): void;
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
 */
export function syncElements(
  cy: cytoscape.Core,
  defs: cytoscape.ElementDefinition[],
  prev: AppliedPositions,
): { newNodeIds: string[]; structureChanged: boolean; positions: AppliedPositions } {
  const byId = new Map<string, cytoscape.ElementDefinition>();
  for (const d of defs) if (d.data.id) byId.set(d.data.id, d);
  const positions: AppliedPositions = new Map();
  const newNodeIds: string[] = [];
  let structureChanged = false;

  cy.batch(() => {
    const stale = cy.elements().filter((el) => {
      const d = byId.get(el.id());
      if (!d) return true;
      // An edge whose endpoints changed must be re-created.
      return el.isEdge() && (el.data("source") !== d.data.source || el.data("target") !== d.data.target);
    });
    if (stale.nonempty()) {
      structureChanged = true;
      cy.remove(stale);
    }

    const toAdd: cytoscape.ElementDefinition[] = [];
    for (const [id, d] of byId) {
      const isNode = isNodeDef(d);
      if (isNode) positions.set(id, d.position && { ...d.position });
      const el = cy.getElementById(id);
      if (el.empty()) {
        toAdd.push(d.position ? { ...d, position: { ...d.position } } : d);
        if (isNode && !d.position) newNodeIds.push(id);
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
  });
  return { newNodeIds, structureChanged, positions };
}

/** Cytoscape canvas that fills its parent; diff-applies `elements` and reports interactions. */
export function CytoscapeView(props: CytoscapeViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const appliedRef = useRef<AppliedPositions>(new Map());
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
    const p = () => propsRef.current;

    cy.on("tap", "node", (e) => {
      const ev = e.originalEvent as MouseEvent | undefined;
      p().onTapNode(e.target.id(), { shift: !!ev?.shiftKey });
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
          if (moved) p().onDragEnd(moved);
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
        p().onBoxSelect([...new Set(ids)]);
      });
    });

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => cy.resize());
      ro.observe(container);
    }
    propsRef.current.onReady?.(cy);
    return () => {
      ro?.disconnect();
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
    const r = syncElements(cy, props.elements, appliedRef.current);
    appliedRef.current = r.positions;
    if (props.layout === "dagre-lr") {
      if (r.structureChanged) runDagreLayout(cy);
    } else {
      if (r.newNodeIds.length > 0) runIncrementalLayout(cy, r.newNodeIds);
      // A full layout fits by itself; a canvas restored from stored positions needs an explicit fit.
      const fullLayout = r.newNodeIds.length === cy.nodes().length;
      if (wasEmpty && cy.nodes().nonempty() && !fullLayout) cy.fit(undefined, 40);
    }
  }, [props.elements, props.layout]);

  return <div ref={containerRef} className="cy-view" style={{ width: "100%", height: "100%" }} />;
}
