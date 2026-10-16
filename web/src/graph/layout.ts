import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import fcose, { type FcoseLayoutOptions } from "cytoscape-fcose";

// Register layout extensions once per module instance (HMR re-evaluation included).
const REGISTERED = Symbol.for("ethergraph.cytoscape.extensions");
const g = globalThis as { [REGISTERED]?: boolean };
if (!g[REGISTERED]) {
  cytoscape.use(fcose);
  cytoscape.use(dagre);
  g[REGISTERED] = true;
}

const DRAFT_THRESHOLD = 300;
const NEIGHBOR_RADIUS = 90;

type Pos = { x: number; y: number };

function shouldAnimate(cy: cytoscape.Core, nodeCount: number): boolean {
  // A Core without a container is headless (tests, server-side) and cannot animate.
  return cy.container() !== null && nodeCount <= DRAFT_THRESHOLD;
}

/** Puts each new node on a small ring around its already-placed neighbours (or right of the graph). */
function seedPositions(fresh: cytoscape.NodeCollection, existing: cytoscape.NodeCollection) {
  const bb = existing.boundingBox({});
  const fallback: Pos = { x: bb.x2 + 2 * NEIGHBOR_RADIUS, y: (bb.y1 + bb.y2) / 2 };
  const ringIndex = new Map<string, number>();
  fresh.forEach((node) => {
    const anchors = node.neighborhood("node").intersection(existing).nodes();
    let center = fallback;
    let key = "_fallback";
    if (anchors.length > 0) {
      const sum = anchors.reduce((acc: Pos, a) => ({ x: acc.x + a.position("x"), y: acc.y + a.position("y") }), { x: 0, y: 0 });
      center = { x: sum.x / anchors.length, y: sum.y / anchors.length };
      key = anchors.map((a) => a.id()).sort().join("|");
    }
    const k = ringIndex.get(key) ?? 0;
    ringIndex.set(key, k + 1);
    const angle = k * 2.399963; // golden angle spreads siblings evenly
    const r = NEIGHBOR_RADIUS * (1 + Math.floor(k / 8) * 0.6);
    node.position({ x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) });
  });
}

/**
 * First run (no already-placed nodes): fcose over everything. Later runs only move `newIds`:
 * existing nodes are seeded as anchors, locked during the layout and their positions restored
 * afterwards, so user-dragged positions never change. Above 300 nodes the full layout uses
 * fcose's "draft" quality without animation.
 */
export function runIncrementalLayout(cy: cytoscape.Core, newIds: string[]): void {
  const freshIds = new Set(newIds);
  const fresh = cy.nodes().filter((n) => freshIds.has(n.id()));
  if (fresh.length === 0) return;
  const existing = cy.nodes().difference(fresh).nodes();

  if (existing.length === 0) {
    const total = cy.nodes().length;
    const big = total > DRAFT_THRESHOLD;
    const opts: FcoseLayoutOptions = {
      name: "fcose",
      quality: big ? "draft" : "default",
      randomize: true,
      animate: !big && shouldAnimate(cy, total),
      fit: true,
      padding: 40,
      nodeRepulsion: 6000,
      idealEdgeLength: 90,
    };
    cy.layout(opts).run();
    return;
  }

  seedPositions(fresh, existing);
  const anchors = fresh.neighborhood("node").intersection(existing).nodes();
  const eles = fresh.union(fresh.connectedEdges()).union(anchors);
  const saved = new Map<string, Pos>(existing.map((n) => [n.id(), { ...n.position() }]));
  const wasLocked = new Set(existing.filter((n) => n.locked()).map((n) => n.id()));
  existing.lock();

  const restore = () => {
    existing.forEach((n) => {
      if (!wasLocked.has(n.id())) n.unlock();
      const p = saved.get(n.id());
      if (p && (n.position("x") !== p.x || n.position("y") !== p.y)) n.position(p);
    });
  };

  // randomize:false (incremental cose from the seeded positions) requires a non-draft quality.
  const opts: FcoseLayoutOptions = {
    name: "fcose",
    quality: "default",
    randomize: false,
    animate: shouldAnimate(cy, eles.nodes().length),
    fit: false,
    nodeRepulsion: 6000,
    idealEdgeLength: 90,
    fixedNodeConstraint: anchors.map((n) => ({ nodeId: n.id(), position: { ...saved.get(n.id())! } })),
  };
  const layout = eles.layout(opts);
  layout.one("layoutstop", restore);
  layout.run();
}

/** Left-to-right dagre layout (tx flow view); small graphs, so it simply re-runs on every change. */
export function runDagreLayout(cy: cytoscape.Core): void {
  cy.layout({
    name: "dagre",
    rankDir: "LR",
    nodeSep: 40,
    rankSep: 140,
    edgeSep: 12,
    fit: true,
    padding: 30,
    animate: false,
  } as cytoscape.LayoutOptions).run();
}
