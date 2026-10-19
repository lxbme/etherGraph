import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import fcose, { type FcoseLayoutOptions } from "cytoscape-fcose";
import { PER_NODE_PX } from "./budget";
import { isMoreId, MORE_PREFIX } from "./elements";
import { fitClamped } from "./refit";

// Register layout extensions once (cytoscape(type, name) returns the registered extension).
if (!cytoscape("layout", "fcose")) cytoscape.use(fcose);
if (!cytoscape("layout", "dagre")) cytoscape.use(dagre);

/** Full layouts above this many nodes use fcose "draft" quality without animation. */
const DRAFT_THRESHOLD = 300;
/** Incremental batches above this many new nodes skip fcose and use deterministic rings. */
const FCOSE_NEW_LIMIT = 150;
/**
 * Spacing follows the budget's PER_NODE_PX (the canvas area one node is granted), so the node count the
 * budget allows actually fits: ideal edge length and first ring radius, ring slot spacing, minimum clearance.
 */
const NEIGHBOR_RADIUS = PER_NODE_PX;
/** Cap on the existing non-anchor nodes fixed (as repellers) in an incremental fcose run. */
const MAX_FIXED_NEARBY = 100;
/** Distance between ring slots (along the ring and between rings, on the ring's short axis). */
const SPACING = 0.75 * PER_NODE_PX;
/** A placed node keeps at least this distance to every other node's centre. */
const CLEARANCE = 0.5 * PER_NODE_PX;
/** Most a layout is stretched along one axis relative to the other (spread and ring ellipses). */
const MAX_STRETCH = 3;
/** Padding of the fit after a full layout (the spread leaves room for it). */
const FIT_PADDING = 40;

type Pos = { x: number; y: number };
export interface Viewport {
  width: number;
  height: number;
}
export interface LayoutOptions {
  /** Defaults to: animate when the Core is mounted (has a container) and the layout is small. */
  animate?: boolean;
  /** Canvas size in CSS pixels; defaults to the Core's. An empty size disables spreading and ellipses. */
  viewport?: Viewport;
}

const hasArea = (v: Viewport) => v.width > 0 && v.height > 0;

/**
 * Axis factors (kx * ky = 1) that turn rings into ellipses of the canvas's aspect, the ratio capped at
 * MAX_STRETCH; circles without a viewport.
 */
function ellipse(v: Viewport): { kx: number; ky: number } {
  if (!hasArea(v)) return { kx: 1, ky: 1 };
  const r = Math.sqrt(Math.min(MAX_STRETCH, Math.max(1 / MAX_STRETCH, v.width / v.height)));
  return { kx: r, ky: 1 / r };
}

/**
 * Stretches a laid-out graph toward the viewport so it uses the canvas instead of a disc in its middle.
 * The target is a box of the viewport's shape (inside `padding`) whose inscribed ellipse grants each node at
 * most PER_NODE_PX^2, so a small graph stays compact. Each axis is scaled by max(1, target / extent): never compressed, and one
 * axis is stretched at most MAX_STRETCH times the other. Scales around the bounding box centre.
 */
export function spreadToViewport(positions: Map<string, Pos>, v: Viewport & { padding: number }): Map<string, Pos> {
  const w = v.width - 2 * v.padding;
  const h = v.height - 2 * v.padding;
  if (positions.size < 2 || !(w > 0 && h > 0)) return positions;
  const ps = [...positions.values()];
  const x1 = Math.min(...ps.map((p) => p.x));
  const x2 = Math.max(...ps.map((p) => p.x));
  const y1 = Math.min(...ps.map((p) => p.y));
  const y2 = Math.max(...ps.map((p) => p.y));
  // The nodes fill roughly the ellipse inscribed in the box, π/4 of its area.
  const f = Math.min(1, Math.sqrt((positions.size * PER_NODE_PX * PER_NODE_PX * 4) / Math.PI / (w * h)));
  // A flat extent (all nodes on a line) is not stretched along its zero axis.
  let sx = x2 > x1 ? Math.max(1, (w * f) / (x2 - x1)) : 1;
  let sy = y2 > y1 ? Math.max(1, (h * f) / (y2 - y1)) : 1;
  sx = Math.min(sx, MAX_STRETCH * sy);
  sy = Math.min(sy, MAX_STRETCH * sx);
  if (sx === 1 && sy === 1) return positions;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  return new Map([...positions].map(([id, p]) => [id, { x: cx + (p.x - cx) * sx, y: cy + (p.y - cy) * sy }]));
}

const ANIMATION_MS = 400;

/**
 * Layouts are computed synchronously (fcose with animate:false); when animated, the new nodes
 * then glide from their start to their final positions. These are the final positions of the
 * glide still in flight on a Core, so the next layout can finish it before snapshotting.
 */
const inFlight = new WeakMap<cytoscape.Core, Map<string, Pos>>();

/** Where an in-flight glide is taking node `id` (undefined when it is not gliding). */
export function layoutTarget(cy: cytoscape.Core, id: string): Pos | undefined {
  return inFlight.get(cy)?.get(id);
}

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

type Axes = { kx: number; ky: number };

/** Distance in ring units: the `r` of the ellipse (axes r*kx, r*ky) through `p`. */
const ringDist = (p: Pos, c: Pos, k: Axes) => Math.hypot((p.x - c.x) / k.kx, (p.y - c.y) / k.ky);

/** Ring radius step: rings are SPACING apart on the ellipse's short axis. */
const ringStep = (k: Axes) => SPACING / Math.min(k.kx, k.ky);
/** Slots on the ring of radius `r` (about SPACING apart along it). */
function ringCapacity(r: number, k: Axes): number {
  const rx = r * k.kx;
  const ry = r * k.ky;
  return Math.max(6, Math.floor((2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2)) / SPACING));
}

/** Samples per ellipse for the arc-length table. */
const ARC_SAMPLES = 256;

/**
 * Concentric elliptical rings of slots around `center` (axes r*kx, r*ky), starting at `r0`, ringStep apart.
 * Slots are spaced evenly by arc length (an even angle step would bunch them at the long axis's ends). Each
 * ring is filled starting from `theta0` and alternating outwards, so a partly filled ring sits on the side
 * facing `theta0` (away from the graph's centre). When `total` (the slots that will be taken) is known, the
 * last ring spreads the rest evenly around it instead.
 */
function* ringSlots(center: Pos, r0: number, theta0: number, k: Axes, total = Infinity): Generator<Pos, never> {
  let left = total;
  for (let r = r0; ; r += ringStep(k)) {
    const rx = r * k.kx;
    const ry = r * k.ky;
    // Cumulative arc length at ARC_SAMPLES even parameter steps.
    const cum = [0];
    for (let i = 1; i <= ARC_SAMPLES; i++) {
      const a = (2 * Math.PI * (i - 0.5)) / ARC_SAMPLES;
      cum.push(cum[i - 1]! + ((2 * Math.PI) / ARC_SAMPLES) * Math.hypot(rx * Math.sin(a), ry * Math.cos(a)));
    }
    const length = cum[ARC_SAMPLES]!;
    const paramAt = (len: number) => {
      const l = ((len % length) + length) % length;
      let lo = 0;
      let hi = ARC_SAMPLES;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! <= l) lo = mid;
        else hi = mid;
      }
      const seg = cum[lo + 1]! - cum[lo]!;
      return ((2 * Math.PI) / ARC_SAMPLES) * (lo + (seg > 0 ? (l - cum[lo]!) / seg : 0));
    };
    const t0 = Math.atan2(Math.sin(theta0) / k.ky, Math.cos(theta0) / k.kx);
    const start = cum[Math.floor(((((t0 % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * ARC_SAMPLES)]!;
    const cap = ringCapacity(r, k);
    const n = left > 0 && left < cap ? left : cap;
    left -= n;
    for (let j = 0; j < n; j++) {
      const off = j === 0 ? 0 : Math.ceil(j / 2) * (j % 2 === 1 ? 1 : -1);
      const t = paramAt(start + (off * length) / n);
      yield { x: center.x + rx * Math.cos(t), y: center.y + ry * Math.sin(t) };
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
function placeOnRings(
  fresh: cytoscape.NodeCollection,
  existing: cytoscape.NodeCollection,
  k: Axes,
  /** Nodes per group (keyed by the anchor ids), when known: the last ring of a group is spread evenly. */
  counts?: Map<string, number>,
) {
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
      let occupied = 0;
      if (anchors.empty()) {
        center = { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 };
        r0 = Math.hypot(bb.w / k.kx, bb.h / k.ky) / 2 + 2 * SPACING;
      } else {
        center = centroid(anchors.map((a) => a.position()));
        if (anchors.length === 1) {
          // A "+N more" proxy is moved outside afterwards; it does not push the new ring out.
          anchors.neighborhood("node").intersection(existing).nodes().forEach((n) => {
            if (!isMoreId(n.id())) occupied = Math.max(occupied, ringDist(n.position(), center, k));
          });
        }
        r0 = anchors.length === 1 ? Math.max(NEIGHBOR_RADIUS, occupied + SPACING) : SPACING;
      }
      const dx = center.x - gc.x;
      const dy = center.y - gc.y;
      const theta0 = Math.hypot(dx, dy) < 1 ? 0 : Math.atan2(dy, dx);
      // An anchor without placed neighbours gets an evenly filled disc; otherwise the partial ring faces outwards.
      const total = anchors.length === 1 && occupied === 0 ? counts?.get(key) : undefined;
      g = { slots: ringSlots(center, r0, theta0, k, total) };
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

/**
 * Puts the "+N more" proxy of each of `centers` just outside the farthest of the center's other neighbours,
 * on the canvas's long axis, on that neighbour's side (where the rings reach farthest). A proxy the user
 * dragged (`placed`) stays where it is, unless `replace` (Re-layout).
 */
function placeProxies(cy: cytoscape.Core, centers: Set<string>, k: Axes, replace = false): void {
  const wide = k.kx >= k.ky;
  for (const id of centers) {
    const proxy = cy.getElementById(`${MORE_PREFIX}${id}`);
    const center = cy.getElementById(id);
    if (proxy.empty() || center.empty() || (!replace && proxy.data("placed"))) continue;
    const c = center.position();
    let far = 0;
    let side = 1;
    center.neighborhood("node").forEach((n) => {
      if (isMoreId(n.id())) return;
      const dx = n.position("x") - c.x;
      const dy = n.position("y") - c.y;
      const d = Math.hypot(dx, dy);
      if (d <= far) return;
      far = d;
      side = (wide ? dx : dy) < 0 ? -1 : 1;
    });
    const d = Math.max(far, NEIGHBOR_RADIUS / 2) + SPACING;
    proxy.position(wide ? { x: c.x + side * d, y: c.y } : { x: c.x, y: c.y + side * d });
  }
}

/** Centers of the proxies among `fresh`, plus fresh nodes' neighbours that have a proxy. */
function proxyCenters(cy: cytoscape.Core, fresh: cytoscape.NodeCollection): Set<string> {
  const out = new Set<string>();
  fresh.forEach((n) => {
    const id = n.id();
    if (isMoreId(id)) {
      out.add(id.slice(MORE_PREFIX.length));
      return;
    }
    n.neighborhood("node").forEach((a) => {
      const aid = a.id();
      if (!out.has(aid) && !isMoreId(aid) && cy.getElementById(`${MORE_PREFIX}${aid}`).nonempty()) out.add(aid);
    });
  });
  return out;
}

/** Neighbours other than "+N more" proxies. */
const realNeighbours = (n: cytoscape.NodeSingular) =>
  n.neighborhood("node").nodes().filter((m) => !isMoreId(m.id())).nodes();

/**
 * The leaves among `nodes` (proxies excluded): nodes whose only neighbour has others, so they belong on that
 * anchor's rings. Returns each leaf's anchor; the leaves' collection is in `nodes` order.
 */
function splitLeaves(nodes: cytoscape.NodeCollection): { leaves: cytoscape.NodeCollection; anchorOf: Map<string, cytoscape.NodeSingular> } {
  const degree = new Map<string, number>();
  const realDegree = (n: cytoscape.NodeSingular) => {
    let d = degree.get(n.id());
    if (d === undefined) {
      d = realNeighbours(n).length;
      degree.set(n.id(), d);
    }
    return d;
  };
  const anchorOf = new Map<string, cytoscape.NodeSingular>();
  const leaves = nodes
    .filter((n) => {
      if (isMoreId(n.id())) return false;
      const a = realNeighbours(n as cytoscape.NodeSingular);
      if (a.length !== 1 || realDegree(a.first()) < 2) return false;
      anchorOf.set(n.id(), a.first());
      return true;
    })
    .nodes();
  return { leaves, anchorOf };
}

/** Leaves per anchor id (a leaf's ring group key). */
function leafCounts(anchorOf: Map<string, cytoscape.NodeSingular>): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of anchorOf.values()) out.set(a.id(), (out.get(a.id()) ?? 0) + 1);
  return out;
}

/** Outer ring radius (ring units) that `m` leaves around one anchor reach. */
function ringsRadius(m: number, k: Axes): number {
  let r = NEIGHBOR_RADIUS;
  for (let left = m - ringCapacity(r, k); left > 0; left -= ringCapacity(r, k)) r += ringStep(k);
  return r;
}
/** Most the core of a full layout is scaled up to make room for its anchors' leaf rings. */
const MAX_CORE_SCALE = 6;

/**
 * Full layout, after fcose: fcose crowds the leaves of a busy node (a center's neighbours that touch nothing
 * else) into a disc denser near its middle. Keep fcose's positions for the rest (the core), scale the core
 * up so anchors with more than one ring of leaves do not share space, and put each anchor's leaves on even
 * elliptical rings around it.
 */
function ringLeaves(cy: cytoscape.Core, k: Axes): void {
  const real = cy.nodes().filter((n) => !isMoreId(n.id())).nodes();
  const { leaves, anchorOf } = splitLeaves(real);
  if (leaves.empty()) return;
  const core = real.difference(leaves).nodes();
  const count = leafCounts(anchorOf);
  const big = [...count]
    .filter(([, m]) => m > ringCapacity(NEIGHBOR_RADIUS, k))
    .map(([id, m]) => ({ p: cy.getElementById(id).position(), r: ringsRadius(m, k) }));
  let scale = 1;
  for (let i = 0; i < big.length; i++) {
    for (let j = i + 1; j < big.length; j++) {
      const a = big[i]!;
      const b = big[j]!;
      const need = a.r + b.r + SPACING;
      scale = Math.max(scale, need / Math.max(ringDist(a.p, b.p, k), need / MAX_CORE_SCALE));
    }
  }
  if (scale > 1) {
    const c = centroid(core.map((n) => n.position()));
    core.forEach((n) => {
      const p = n.position();
      n.position({ x: c.x + (p.x - c.x) * scale, y: c.y + (p.y - c.y) * scale });
    });
  }
  placeOnRings(leaves, core, k, count);
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

/** Re-layout's fcose: nodes sized with their labels, pushed further apart and on longer edges than a first layout. */
const RELAYOUT_REPULSION = 45000;
const RELAYOUT_EDGE_LENGTH = 2 * NEIGHBOR_RADIUS;

/**
 * Lays out every node except `fixed`, which keep their positions: fcose from random positions ("draft" above
 * 300 nodes when nothing is fixed), "+N more" proxies outside their centers. Without fixed nodes the result
 * is also spread toward the viewport. Fits; small graphs then animate from where the nodes were.
 *
 * A first layout (one center, mostly) puts the leaves on even rings around their anchor. A re-layout does
 * not: with several busy anchors the rings overlap each other; fcose that counts labels in node sizes keeps
 * the groups apart instead.
 */
function layoutAll(
  cy: cytoscape.Core,
  fixed: cytoscape.NodeCollection,
  viewport: Viewport,
  opts: LayoutOptions & { relayout?: boolean },
): void {
  const k = ellipse(viewport);
  const total = cy.nodes().length;
  const big = total > DRAFT_THRESHOLD;
  const moving = cy.nodes().difference(fixed).nodes();
  const from = positionsOf(moving);
  const saved = positionsOf(fixed);
  cy.layout({
    name: "fcose",
    // With fixed nodes, the full quality so the constraint shapes the whole run.
    quality: big && fixed.empty() ? "draft" : "default",
    randomize: true,
    animate: false,
    fit: false,
    ...(opts.relayout
      ? { nodeRepulsion: RELAYOUT_REPULSION, idealEdgeLength: RELAYOUT_EDGE_LENGTH, nodeDimensionsIncludeLabels: true }
      : { nodeRepulsion: 6000, idealEdgeLength: NEIGHBOR_RADIUS }),
    ...(fixed.nonempty() && {
      fixedNodeConstraint: fixed.map((n) => ({ nodeId: n.id(), position: { ...saved.get(n.id())! } })),
    }),
  } as FcoseLayoutOptions).run();
  // fcose may shift constrained nodes by a fraction; they must not move at all.
  for (const [id, p] of saved) cy.getElementById(id).position(p);
  if (!opts.relayout) ringLeaves(cy, k);
  if (fixed.empty()) {
    // The rings still sit in the middle of a wide canvas the budget counted on: spread them out.
    const spread = spreadToViewport(positionsOf(cy.nodes().filter((n) => !isMoreId(n.id()))), {
      ...viewport,
      padding: FIT_PADDING,
    });
    for (const [id, p] of spread) cy.getElementById(id).position(p);
  }
  placeProxies(cy, proxyCenters(cy, moving), k, opts.relayout);
  fitClamped(cy, FIT_PADDING);
  if (!big && shouldAnimate(cy, total, opts)) glide(cy, moving, from);
}

/**
 * The "Re-layout" tool: lays the whole graph out again as a first layout would, except that the `fixed`
 * (pinned) nodes stay exactly where they are. Returns the final position of every other real node
 * ("+N more" proxies are moved but not returned) — for the caller to store and to make undoable.
 */
export function runRelayout(cy: cytoscape.Core, fixed: ReadonlySet<string>, opts: LayoutOptions = {}): Map<string, Pos> {
  settle(cy);
  const pinned = cy.nodes().filter((n) => fixed.has(n.id())).nodes();
  const real = cy.nodes().filter((n) => !isMoreId(n.id())).difference(pinned).nodes();
  if (real.empty()) return new Map();
  layoutAll(cy, pinned, opts.viewport ?? { width: cy.width(), height: cy.height() }, { ...opts, relayout: true });
  // A glide may be in flight: report where the nodes end up, not where they are now.
  const targets = inFlight.get(cy);
  return new Map(real.map((n) => [n.id(), { ...(targets?.get(n.id()) ?? n.position()) }]));
}

/**
 * First run (no already-placed nodes): fcose over everything ("draft" above 300 nodes), then leaves (nodes
 * with a single neighbour) go on even elliptical rings around it and the result is spread toward the
 * viewport. Later runs only move `newIds`: non-leaves are placed on rings around their existing
 * neighbours and, at most 150 of them, refined by a short fcose in which nearby existing nodes are fixed;
 * then new leaves go on rings around their anchors. Existing node positions never change (user-dragged
 * positions stay), except "+N more" proxies, which move outside their center's neighbours.
 * Layouts compute synchronously; small ones then animate (see `glide`), and an animation still
 * in flight is finished before the next layout starts.
 */
export function runIncrementalLayout(cy: cytoscape.Core, newIds: string[], opts: LayoutOptions = {}): void {
  settle(cy);
  const freshIds = new Set(newIds);
  const fresh = cy.nodes().filter((n) => freshIds.has(n.id()));
  if (fresh.length === 0) return;
  const existing = cy.nodes().difference(fresh).nodes();
  const viewport = opts.viewport ?? { width: cy.width(), height: cy.height() };
  const k = ellipse(viewport);

  if (existing.length === 0) {
    layoutAll(cy, cy.collection(), viewport, opts);
    return;
  }

  const proxies = proxyCenters(cy, fresh);
  const real = fresh.filter((n) => !isMoreId(n.id())).nodes();
  const { leaves, anchorOf } = splitLeaves(real);
  const others = real.difference(leaves).nodes();
  // Animation starts: the others glide from their ring seeds, leaves bloom out of their anchor.
  const start = new Map<string, Pos>();
  if (others.nonempty()) {
    const fixOverlaps = placeOnRings(others, existing, k);
    const seeds = positionsOf(others);
    for (const [id, p] of seeds) start.set(id, p);
    // Nodes without any neighbour stay on their ring: there is nothing to pull them toward.
    const linked = others.filter((n) => n.degree(false) > 0).nodes();
    if (linked.nonempty() && others.length <= FCOSE_NEW_LIMIT) {
      refine(linked, existing, seeds);
      fixOverlaps();
    }
  }
  // Leaves last, on rings around their anchors' final positions (fcose would crowd them back in).
  for (const [id, a] of anchorOf) start.set(id, { ...a.position() });
  placeOnRings(leaves, existing.union(others).nodes(), k, leafCounts(anchorOf));
  placeProxies(cy, proxies, k);
  if (fresh.length <= FCOSE_NEW_LIMIT && shouldAnimate(cy, fresh.length, opts)) glide(cy, fresh, start);
}

/**
 * A short fcose from the seeded positions that only moves `nodes`: their anchors plus the existing nodes
 * closest to the seeds (capped, to keep fcose short) are fixed so they repel the new ones. Existing
 * positions are restored afterwards; anything that still lands too close is for the caller's fixOverlaps.
 */
function refine(nodes: cytoscape.NodeCollection, existing: cytoscape.NodeCollection, seeds: Map<string, Pos>): void {
  const anchors = nodes.neighborhood("node").intersection(existing).nodes();
  const fixed = anchors.union(nearestExisting(existing, seeds, MAX_FIXED_NEARBY)).nodes();
  const inLayout = nodes.union(fixed);
  const edges = nodes.connectedEdges().filter((e) => inLayout.contains(e.source()) && inLayout.contains(e.target()));
  const saved = positionsOf(existing);
  // randomize:false (incremental cose from the seeded positions) requires a non-draft quality.
  inLayout.union(edges).layout({
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
    fit: false,
    animate: false,
  } as cytoscape.LayoutOptions).run();
  fitClamped(cy, 30);
}
