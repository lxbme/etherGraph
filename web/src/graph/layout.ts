import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import fcose, { type FcoseLayoutOptions } from "cytoscape-fcose";

// Register layout extensions once (cytoscape(type, name) returns the registered extension).
if (!cytoscape("layout", "fcose")) cytoscape.use(fcose);
if (!cytoscape("layout", "dagre")) cytoscape.use(dagre);

/** Full layouts above this many nodes use fcose "draft" quality without animation. */
const DRAFT_THRESHOLD = 300;
/** Incremental batches above this many new nodes skip fcose and use deterministic rings. */
const FCOSE_NEW_LIMIT = 150;
const NEIGHBOR_RADIUS = 90;
/** Cap on the existing non-anchor nodes fixed (as repellers) in an incremental fcose run. */
const MAX_FIXED_NEARBY = 100;
/** Distance between ring slots (along the ring and between rings). */
const SPACING = 45;
/** A placed node keeps at least this distance to every other node's centre. */
const CLEARANCE = 30;

type Pos = { x: number; y: number };
export interface LayoutOptions {
  /** Defaults to: animate when the Core is mounted (has a container) and the layout is small. */
  animate?: boolean;
}

const ANIMATION_MS = 400;

/**
 * Layouts are computed synchronously (fcose with animate:false); when animated, the new nodes
 * then glide from their start to their final positions. These are the final positions of the
 * glide still in flight on a Core, so the next layout can finish it before snapshotting.
 */
const inFlight = new WeakMap<cytoscape.Core, Map<string, Pos>>();

/** Finish an in-flight glide: stop the animations and put the nodes at their end positions. */
function settle(cy: cytoscape.Core): void {
  const targets = inFlight.get(cy);
  if (!targets) return;
  inFlight.delete(cy);
  for (const [id, p] of targets) {
    const n = cy.getElementById(id);
    if (n.empty()) continue;
    n.stop(true);
    n.position(p);
  }
}

function shouldAnimate(cy: cytoscape.Core, nodeCount: number, opts: LayoutOptions): boolean {
  // Animations need styles; a Core without a container (tests, server-side) cannot render them.
  if (!(cy as cytoscape.Core & { styleEnabled(): boolean }).styleEnabled()) return false;
  if (opts.animate !== undefined) return opts.animate;
  return cy.container() !== null && nodeCount <= DRAFT_THRESHOLD;
}

/** `nodes` sit at their final positions; move them back to `from` and animate to the end. */
function glide(cy: cytoscape.Core, nodes: cytoscape.NodeCollection, from: Map<string, Pos>): void {
  const targets = new Map(nodes.map((n) => [n.id(), { ...n.position() }]));
  inFlight.set(cy, targets);
  const anis = nodes.map((n) => {
    n.position(from.get(n.id()) ?? targets.get(n.id())!);
    const to = targets.get(n.id())!;
    // The typings demand style/renderedPosition alongside position; cytoscape does not.
    return n.animation({ position: to, duration: ANIMATION_MS, easing: "ease-out" } as cytoscape.SingularAnimationOptionsPos);
  });
  anis.forEach((a) => a.play());
  void Promise.all(anis.map((a) => a.promise())).then(() => {
    if (inFlight.get(cy) === targets) inFlight.delete(cy);
  });
}

/** Uniform-grid spatial hash for "is any node centre within CLEARANCE of p" queries. */
class Occupancy {
  private cells = new Map<string, Pos[]>();
  private key(cx: number, cy: number) {
    return `${cx},${cy}`;
  }
  add(p: Pos): void {
    const k = this.key(Math.floor(p.x / CLEARANCE), Math.floor(p.y / CLEARANCE));
    const list = this.cells.get(k);
    if (list) list.push(p);
    else this.cells.set(k, [p]);
  }
  free(p: Pos): boolean {
    const cx = Math.floor(p.x / CLEARANCE);
    const cy = Math.floor(p.y / CLEARANCE);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
          if (Math.hypot(q.x - p.x, q.y - p.y) < CLEARANCE) return false;
        }
      }
    }
    return true;
  }
}

/**
 * Concentric rings of slots around `center`, starting at radius `r0`. Each ring is filled
 * starting from `theta0` and alternating outwards, so a partly filled ring sits on the side
 * facing `theta0` (away from the graph's centre).
 */
function* ringSlots(center: Pos, r0: number, theta0: number): Generator<Pos, never> {
  for (let r = r0; ; r += SPACING) {
    const n = Math.max(6, Math.floor((2 * Math.PI * r) / SPACING));
    const step = (2 * Math.PI) / n;
    for (let j = 0; j < n; j++) {
      const off = j === 0 ? 0 : Math.ceil(j / 2) * (j % 2 === 1 ? 1 : -1);
      const a = theta0 + off * step;
      yield { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
    }
  }
}

const centroid = (ps: Pos[]): Pos => {
  const s = ps.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / ps.length, y: s.y / ps.length };
};

/**
 * O(n) deterministic placement of `fresh` nodes. Nodes sharing the same existing neighbours
 * (anchors) go on rings around the anchors' centroid, beyond the radius the anchor's existing
 * neighbours already occupy and biased away from the graph centroid; nodes without anchors
 * go on a ring outside the current bounding box. Every slot keeps CLEARANCE from all nodes.
 * Returns a function that re-places a node into the next free slot of its group.
 */
function placeOnRings(fresh: cytoscape.NodeCollection, existing: cytoscape.NodeCollection) {
  const occ = new Occupancy();
  const existingPos = existing.map((n) => n.position());
  for (const p of existingPos) occ.add(p);
  const gc = centroid(existingPos);
  const bb = existing.boundingBox({});

  const groups = new Map<string, { slots: Generator<Pos, never> }>();
  const groupOf = new Map<string, string>();
  const slotsFor = (node: cytoscape.NodeSingular) => {
    const anchors = node.neighborhood("node").intersection(existing).nodes();
    const key = anchors.empty() ? "" : anchors.map((a) => a.id()).sort().join("|");
    groupOf.set(node.id(), key);
    let g = groups.get(key);
    if (!g) {
      let center: Pos;
      let r0: number;
      if (anchors.empty()) {
        center = { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 };
        r0 = Math.hypot(bb.w, bb.h) / 2 + 2 * SPACING;
      } else {
        center = centroid(anchors.map((a) => a.position()));
        let occupied = 0;
        if (anchors.length === 1) {
          anchors.neighborhood("node").intersection(existing).nodes().forEach((n) => {
            const p = n.position();
            occupied = Math.max(occupied, Math.hypot(p.x - center.x, p.y - center.y));
          });
        }
        r0 = anchors.length === 1 ? Math.max(NEIGHBOR_RADIUS, occupied + SPACING) : SPACING;
      }
      const dx = center.x - gc.x;
      const dy = center.y - gc.y;
      const theta0 = Math.hypot(dx, dy) < 1 ? 0 : Math.atan2(dy, dx);
      g = { slots: ringSlots(center, r0, theta0) };
      groups.set(key, g);
    }
    return g.slots;
  };

  const place = (node: cytoscape.NodeSingular, slots: Generator<Pos, never>) => {
    let p = slots.next().value;
    while (!occ.free(p)) p = slots.next().value;
    occ.add(p);
    node.position(p);
  };
  fresh.forEach((node) => place(node, slotsFor(node)));

  /** After fcose: move any new node that ended up too close to an existing node. */
  return function fixOverlaps(): void {
    const settled = new Occupancy();
    for (const p of existingPos) settled.add(p);
    fresh.forEach((node) => {
      const p = node.position();
      if (settled.free(p)) {
        settled.add(p);
        return;
      }
      const slots = groups.get(groupOf.get(node.id()) ?? "")!.slots;
      let q = slots.next().value;
      while (!settled.free(q) || !occ.free(q)) q = slots.next().value;
      occ.add(q);
      settled.add(q);
      node.position(q);
    });
  };
}

/** Up to `limit` existing nodes within NEIGHBOR_RADIUS of any seed, nearest first. */
function nearestExisting(existing: cytoscape.NodeCollection, seeds: Map<string, Pos>, limit: number) {
  const cell = (v: number) => Math.floor(v / NEIGHBOR_RADIUS);
  const buckets = new Map<string, Pos[]>();
  for (const p of seeds.values()) {
    const k = `${cell(p.x)},${cell(p.y)}`;
    const list = buckets.get(k);
    if (list) list.push(p);
    else buckets.set(k, [p]);
  }
  const hits: { n: cytoscape.NodeSingular; d: number }[] = [];
  existing.forEach((n) => {
    const p = n.position();
    let d = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of buckets.get(`${cell(p.x) + dx},${cell(p.y) + dy}`) ?? []) {
          d = Math.min(d, Math.hypot(q.x - p.x, q.y - p.y));
        }
      }
    }
    if (d <= NEIGHBOR_RADIUS) hits.push({ n, d });
  });
  hits.sort((a, b) => a.d - b.d);
  const keep = new Set(hits.slice(0, limit).map((h) => h.n.id()));
  return existing.filter((n) => keep.has(n.id()));
}

const positionsOf = (nodes: cytoscape.NodeCollection) => new Map(nodes.map((n) => [n.id(), { ...n.position() }]));

/**
 * First run (no already-placed nodes): fcose over everything ("draft" above 300 nodes). Later
 * runs only move `newIds`: they are placed on rings around their existing neighbours; batches
 * of at most 150 are then refined by a short fcose in which nearby existing nodes are fixed.
 * Existing node positions are restored afterwards, so user-dragged positions never change.
 * Layouts compute synchronously; small ones then animate (see `glide`), and an animation still
 * in flight is finished before the next layout starts.
 */
export function runIncrementalLayout(cy: cytoscape.Core, newIds: string[], opts: LayoutOptions = {}): void {
  settle(cy);
  const freshIds = new Set(newIds);
  const fresh = cy.nodes().filter((n) => freshIds.has(n.id()));
  if (fresh.length === 0) return;
  const existing = cy.nodes().difference(fresh).nodes();

  if (existing.length === 0) {
    const total = cy.nodes().length;
    const big = total > DRAFT_THRESHOLD;
    const from = positionsOf(fresh);
    cy.layout({
      name: "fcose",
      quality: big ? "draft" : "default",
      randomize: true,
      animate: false,
      fit: false,
      nodeRepulsion: 6000,
      idealEdgeLength: NEIGHBOR_RADIUS,
    } as FcoseLayoutOptions).run();
    cy.fit(undefined, 40);
    if (!big && shouldAnimate(cy, total, opts)) glide(cy, fresh, from);
    return;
  }

  const fixOverlaps = placeOnRings(fresh, existing);
  if (fresh.length > FCOSE_NEW_LIMIT) return;
  const seeds = positionsOf(fresh);

  // Fix the anchors plus the existing nodes closest to the seeds (capped, to keep fcose short),
  // so they repel the new ones; anything that still lands too close is fixed by fixOverlaps.
  const anchors = fresh.neighborhood("node").intersection(existing).nodes();
  const fixed = anchors.union(nearestExisting(existing, seeds, MAX_FIXED_NEARBY)).nodes();
  const eles = fresh.union(fresh.connectedEdges()).union(fixed);
  const saved = positionsOf(existing);

  // randomize:false (incremental cose from the seeded positions) requires a non-draft quality.
  eles.layout({
    name: "fcose",
    quality: "default",
    randomize: false,
    numIter: 500,
    animate: false,
    fit: false,
    nodeRepulsion: 6000,
    idealEdgeLength: NEIGHBOR_RADIUS,
    fixedNodeConstraint: fixed.map((n) => ({ nodeId: n.id(), position: { ...saved.get(n.id())! } })),
  } as FcoseLayoutOptions).run();
  existing.forEach((n) => {
    const p = saved.get(n.id())!;
    if (n.position("x") !== p.x || n.position("y") !== p.y) n.position(p);
  });
  fixOverlaps();
  if (shouldAnimate(cy, eles.nodes().length, opts)) glide(cy, fresh, seeds);
}

/** Left-to-right dagre layout (tx flow view); small graphs, so it simply re-runs on every change. */
export function runDagreLayout(cy: cytoscape.Core): void {
  settle(cy);
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
