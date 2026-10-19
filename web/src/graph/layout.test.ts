import cytoscape from "cytoscape";
import { describe, expect, test, vi } from "vitest";
import { PER_NODE_PX } from "./budget";
import { runDagreLayout, runIncrementalLayout, runRelayout, spreadToViewport } from "./layout";

const finite = (p: { x: number; y: number }) => Number.isFinite(p.x) && Number.isFinite(p.y);

describe("runIncrementalLayout", () => {
  test("first layout spreads all nodes", () => {
    const cy = cytoscape({ headless: true });
    cy.add([
      { data: { id: "a" } }, { data: { id: "b" } }, { data: { id: "c" } },
      { data: { id: "ab", source: "a", target: "b" } },
      { data: { id: "bc", source: "b", target: "c" } },
    ]);
    runIncrementalLayout(cy, ["a", "b", "c"]);
    const ps = cy.nodes().map((n) => n.position());
    expect(ps.every(finite)).toBe(true);
    expect(new Set(ps.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size).toBe(3);
  });

  test("incremental layout keeps existing node positions unchanged", () => {
    const cy = cytoscape({ headless: true });
    cy.add([
      { data: { id: "a" }, position: { x: 0, y: 0 } },
      { data: { id: "b" }, position: { x: 200, y: 0 } },
      { data: { id: "c" }, position: { x: 100, y: 150 } },
      { data: { id: "ab", source: "a", target: "b" } },
      { data: { id: "bc", source: "b", target: "c" } },
    ]);
    cy.getElementById("c").lock(); // a user-locked node stays locked afterwards
    const before = Object.fromEntries(cy.nodes().map((n) => [n.id(), { ...n.position() }]));

    cy.add([
      { data: { id: "d" } }, { data: { id: "e" } },
      { data: { id: "ad", source: "a", target: "d" } },
      { data: { id: "de", source: "d", target: "e" } },
    ]);
    runIncrementalLayout(cy, ["d", "e"]);

    for (const id of ["a", "b", "c"]) expect(cy.getElementById(id).position()).toEqual(before[id]);
    expect(cy.getElementById("a").locked()).toBe(false);
    expect(cy.getElementById("b").locked()).toBe(false);
    expect(cy.getElementById("c").locked()).toBe(true);
    const d = cy.getElementById("d").position();
    const e = cy.getElementById("e").position();
    expect(finite(d) && finite(e)).toBe(true);
    expect(d).not.toEqual(e);
    // new node lands near its existing neighbour, not somewhere far away
    expect(Math.hypot(d.x - 0, d.y - 0)).toBeLessThan(600);
  });

  test("layout with 400 nodes completes and leaves finite positions", () => {
    const cy = cytoscape({ headless: true });
    const els: cytoscape.ElementDefinition[] = [];
    for (let i = 0; i < 400; i++) els.push({ data: { id: `n${i}` } });
    for (let i = 1; i < 400; i++) els.push({ data: { id: `e${i}`, source: `n${Math.floor(i / 3)}`, target: `n${i}` } });
    cy.add(els);
    const t0 = performance.now();
    runIncrementalLayout(cy, cy.nodes().map((n) => n.id()));
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(cy.nodes().map((n) => n.position()).every(finite)).toBe(true);
  });

  test("no new nodes is a no-op", () => {
    const cy = cytoscape({ headless: true });
    cy.add({ data: { id: "a" }, position: { x: 5, y: 6 } });
    runIncrementalLayout(cy, []);
    expect(cy.getElementById("a").position()).toEqual({ x: 5, y: 6 });
  });
});

/** A laid-out star of `existing` nodes, then `perAnchor` new leaves on each of `anchors` spokes. */
function grown(existing: number, anchors: number, perAnchor: number, prefix = "n", styleEnabled = false) {
  const cy = cytoscape({ headless: true, styleEnabled });
  const els: cytoscape.ElementDefinition[] = [{ data: { id: "c" } }];
  for (let i = 1; i < existing; i++) els.push({ data: { id: `x${i}` } }, { data: { id: `cx${i}`, source: "c", target: `x${i}` } });
  cy.add(els);
  runIncrementalLayout(cy, cy.nodes().map((n) => n.id()));
  const before = new Map(cy.nodes().map((n) => [n.id(), { ...n.position() }]));
  const ids = addLeaves(cy, anchors, perAnchor, prefix);
  return { cy, before, ids };
}
function addLeaves(cy: cytoscape.Core, anchors: number, perAnchor: number, prefix: string): string[] {
  const ids: string[] = [];
  const add: cytoscape.ElementDefinition[] = [];
  for (let a = 1; a <= anchors; a++) {
    for (let j = 0; j < perAnchor; j++) {
      const id = `${prefix}${a}_${j}`;
      ids.push(id);
      add.push({ data: { id } }, { data: { id: `e${id}`, source: `x${a}`, target: id } });
    }
  }
  // one orphan without any existing neighbour
  add.push({ data: { id: `${prefix}orphan` } });
  ids.push(`${prefix}orphan`);
  cy.add(add);
  return ids;
}
function movedCount(cy: cytoscape.Core, before: Map<string, { x: number; y: number }>): number {
  let moved = 0;
  for (const [id, p] of before) {
    const q = cy.getElementById(id).position();
    if (q.x !== p.x || q.y !== p.y) moved++;
  }
  return moved;
}
function overlapping(cy: cytoscape.Core, before: Map<string, { x: number; y: number }>, ids: string[]): number {
  const ex = [...before.values()];
  return ids.filter((id) => {
    const p = cy.getElementById(id).position();
    return ex.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 20);
  }).length;
}

describe("incremental batches", () => {
  test("500 new nodes on a 100-node graph are placed in under 300ms without moving existing nodes", () => {
    const { cy, before, ids } = grown(100, 5, 100);
    const t0 = performance.now();
    runIncrementalLayout(cy, ids);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(300);
    expect(movedCount(cy, before)).toBe(0);
    expect(ids.every((id) => finite(cy.getElementById(id).position()))).toBe(true);
  });

  test.each([
    [10, 2, 5],
    [300, 6, 50],
  ])("%i new nodes never land within 20px of an existing node", (_n, anchors, per) => {
    const { cy, before, ids } = grown(60, anchors, per);
    runIncrementalLayout(cy, ids);
    expect(movedCount(cy, before)).toBe(0);
    expect(overlapping(cy, before, ids)).toBe(0);
  });

  test("a new layout first finishes the one still animating", () => {
    // With styles enabled a headless core animates on requestAnimationFrame, i.e. after this
    // synchronous test body has continued, so the glide started below is still in flight.
    const { cy, before, ids } = grown(30, 2, 5, "n", true);
    const proto = Object.getPrototypeOf(cy.getElementById("x1")) as { animation: (...a: unknown[]) => unknown };
    const spy = vi.spyOn(proto, "animation");
    try {
      runIncrementalLayout(cy, ids, { animate: true });
      // Animation end positions, per node, as handed to cytoscape.
      const targets = new Map<string, { x: number; y: number }>();
      spy.mock.calls.forEach((args, i) => {
        const node = spy.mock.contexts[i] as cytoscape.NodeSingular;
        targets.set(node.id(), (args[0] as { position: { x: number; y: number } }).position);
      });
      expect([...targets.keys()].sort()).toEqual([...ids].sort());
      expect(cy.nodes().toArray().some((n) => n.animated())).toBe(true);
      const mid = cy.getElementById(ids[0]!).position();
      expect(mid).not.toEqual(targets.get(ids[0]!)); // still at its start position

      const second = addLeaves(cy, 1, 3, "m");
      runIncrementalLayout(cy, second);
      expect(cy.nodes().toArray().some((n) => n.animated())).toBe(false);
      for (const id of ids) expect(cy.getElementById(id).position()).toEqual(targets.get(id));
      expect(movedCount(cy, before)).toBe(0);
    } finally {
      spy.mockRestore();
      cy.destroy();
    }
  });
});

describe("runDagreLayout", () => {
  test("lays a chain out left to right", () => {
    const cy = cytoscape({ headless: true });
    cy.add([
      { data: { id: "a" } }, { data: { id: "b" } }, { data: { id: "c" } },
      { data: { id: "ab", source: "a", target: "b" } },
      { data: { id: "bc", source: "b", target: "c" } },
    ]);
    runDagreLayout(cy);
    const x = (id: string) => cy.getElementById(id).position().x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
  });

  test("fits the result without zooming in past 1.2 (labels stay readable)", () => {
    const cy = cytoscape({ headless: true });
    cy.add([{ data: { id: "a" } }, { data: { id: "b" } }, { data: { id: "ab", source: "a", target: "b" } }]);
    // Headless cores have no viewport size; stand in a fit that zooms a tiny graph way in.
    const fit = vi.spyOn(cy, "fit").mockImplementation(() => cy.zoom(3));
    runDagreLayout(cy);
    expect(fit).toHaveBeenCalled();
    expect(cy.zoom()).toBeLessThanOrEqual(1.2);
  });
});

/** A center with `n` leaves plus its "+N more" proxy, all new. */
function star(n: number): cytoscape.Core {
  const cy = cytoscape({ headless: true });
  const els: cytoscape.ElementDefinition[] = [{ data: { id: "c" } }];
  for (let i = 0; i < n; i++) els.push({ data: { id: `l${i}` } }, { data: { id: `cl${i}`, source: "c", target: `l${i}` } });
  els.push({ data: { id: "more:c" }, classes: "more" }, { data: { id: "more-edge:c", source: "c", target: "more:c" } });
  cy.add(els);
  return cy;
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
function nearestDistances(ps: { x: number; y: number }[]): number[] {
  return ps.map((p, i) => Math.min(...ps.filter((_, j) => j !== i).map((q) => Math.hypot(q.x - p.x, q.y - p.y))));
}
function bbox(ps: { x: number; y: number }[]) {
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
/** Beyond the farthest real neighbour of `center`. */
function proxyOutside(cy: cytoscape.Core, center: string): boolean {
  const c = cy.getElementById(center).position();
  const d = (n: cytoscape.NodeSingular) => Math.hypot(n.position("x") - c.x, n.position("y") - c.y);
  const nb = cy.getElementById(center).neighborhood("node");
  const proxy = nb.filter((n) => n.id().startsWith("more:"));
  const farthest = Math.max(...nb.difference(proxy).map(d));
  return proxy.length === 1 && d(proxy[0]!) > farthest;
}

describe("spreadToViewport", () => {
  const vp = { width: 1000, height: 500, padding: 0 };
  test("stretches a small cluster per axis toward the viewport, around its centre", () => {
    const ps = new Map([["a", { x: 0, y: 0 }], ["b", { x: 100, y: 100 }]]);
    const out = spreadToViewport(ps, vp);
    const a = out.get("a")!;
    const b = out.get("b")!;
    // Two nodes claim 2 x 96^2 of the ellipse inscribed in a box of the canvas's shape, scaled by f.
    const f = Math.sqrt((2 * PER_NODE_PX ** 2 * 4) / Math.PI / (1000 * 500));
    expect(b.x - a.x).toBeCloseTo(1000 * f);
    expect(b.y - a.y).toBeCloseTo(500 * f);
    expect((a.x + b.x) / 2).toBeCloseTo(50);
    expect((a.y + b.y) / 2).toBeCloseTo(50);
  });

  test("never compresses", () => {
    const ps = new Map([["a", { x: 0, y: 0 }], ["b", { x: 3000, y: 2000 }]]);
    expect(spreadToViewport(ps, vp)).toEqual(ps);
  });

  test("caps the x:y stretch at 3", () => {
    const ps = new Map(Array.from({ length: 200 }, (_, i) => [`n${i}`, { x: (i % 20) * 10, y: Math.floor(i / 20) * 10 }]));
    const box = bbox([...spreadToViewport(ps, { width: 4000, height: 400, padding: 0 }).values()]);
    expect(box.w / 190).toBeCloseTo(3 * (box.h / 90));
  });

  test("an empty viewport or a single node is left alone", () => {
    const one = new Map([["a", { x: 5, y: 6 }]]);
    expect(spreadToViewport(one, vp)).toEqual(one);
    const two = new Map([["a", { x: 0, y: 0 }], ["b", { x: 10, y: 10 }]]);
    expect(spreadToViewport(two, { width: 0, height: 0, padding: 0 })).toEqual(two);
  });
});

describe("density at the budgeted node count", () => {
  test("150 leaves on one center use a 2233x826 canvas", () => {
    const cy = star(150);
    const viewport = { width: 2233, height: 826 };
    runIncrementalLayout(cy, cy.nodes().map((n) => n.id()), { viewport });
    const ps = cy.nodes().map((n) => n.position());
    const box = bbox(ps);
    expect(box.w).toBeGreaterThanOrEqual(0.8 * (viewport.width - 80));
    expect(box.h).toBeGreaterThanOrEqual(0.8 * (viewport.height - 80));
    expect(median(nearestDistances(ps))).toBeGreaterThanOrEqual(0.8 * PER_NODE_PX);
    expect(proxyOutside(cy, "c")).toBe(true);
  });

  test("an incremental batch of 150 leaves keeps nodes apart and its proxy outside", () => {
    const cy = cytoscape({ headless: true });
    cy.add([{ data: { id: "c" }, position: { x: 0, y: 0 } }]);
    const els: cytoscape.ElementDefinition[] = [];
    for (let i = 0; i < 150; i++) els.push({ data: { id: `l${i}` } }, { data: { id: `cl${i}`, source: "c", target: `l${i}` } });
    els.push({ data: { id: "more:c" }, classes: "more" }, { data: { id: "more-edge:c", source: "c", target: "more:c" } });
    cy.add(els);
    const ids = cy.nodes().filter((n) => n.id() !== "c").map((n) => n.id());
    runIncrementalLayout(cy, ids, { viewport: { width: 2233, height: 826 } });
    const ps = cy.nodes().map((n) => n.position());
    // Ring slots are 0.75 PER_NODE_PX apart (no spread on an incremental batch).
    expect(median(nearestDistances(ps))).toBeGreaterThanOrEqual(0.7 * PER_NODE_PX);
    const box = bbox(ps);
    expect(box.w).toBeGreaterThan(box.h); // elliptical rings follow the wide canvas
    expect(proxyOutside(cy, "c")).toBe(true);
  });
});

describe("user-placed +N more proxies", () => {
  test("a proxy the user dragged stays put when its center gains new neighbours", () => {
    const cy = cytoscape({ headless: true });
    cy.add([
      { data: { id: "c" }, position: { x: 0, y: 0 } },
      { data: { id: "l0" }, position: { x: 96, y: 0 } },
      { data: { id: "cl0", source: "c", target: "l0" } },
      { data: { id: "more:c", placed: true }, classes: "more", position: { x: -400, y: 300 } },
      { data: { id: "more-edge:c", source: "c", target: "more:c" } },
    ]);
    const els: cytoscape.ElementDefinition[] = [];
    for (let i = 1; i <= 6; i++) els.push({ data: { id: `l${i}` } }, { data: { id: `cl${i}`, source: "c", target: `l${i}` } });
    cy.add(els);
    runIncrementalLayout(cy, ["l1", "l2", "l3", "l4", "l5", "l6"], { viewport: { width: 1200, height: 700 } });
    expect(cy.getElementById("more:c").position()).toEqual({ x: -400, y: 300 });
  });

  test("re-layout places even a proxy the user dragged", () => {
    const cy = star(12);
    cy.nodes().forEach((n, i) => {
      n.position({ x: i, y: 0 });
    });
    cy.getElementById("more:c").data("placed", true).position({ x: -999, y: -999 });
    runRelayout(cy, new Set(), { viewport: { width: 1200, height: 700 } });
    expect(proxyOutside(cy, "c")).toBe(true);
  });
});

describe("runRelayout", () => {
  /** A center "c" with `n` neighbours, a chain off the first one, already laid out and then tangled onto one spot. */
  function tangled(n: number) {
    const cy = cytoscape({ headless: true });
    const els: cytoscape.ElementDefinition[] = [{ data: { id: "c" } }];
    for (let i = 1; i <= n; i++) els.push({ data: { id: `x${i}` } }, { data: { id: `cx${i}`, source: "c", target: `x${i}` } });
    els.push({ data: { id: "y" } }, { data: { id: "x1y", source: "x1", target: "y" } });
    els.push({ data: { id: "z" } }, { data: { id: "yz", source: "y", target: "z" } });
    cy.add(els);
    cy.nodes().forEach((node, i) => {
      node.position({ x: i % 3, y: 0 });
    });
    return cy;
  }
  const minGap = (cy: cytoscape.Core) => {
    const ps = cy.nodes().map((n) => n.position());
    let d = Infinity;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) d = Math.min(d, Math.hypot(ps[i]!.x - ps[j]!.x, ps[i]!.y - ps[j]!.y));
    return d;
  };

  test("untangles every node and returns their final positions", () => {
    const cy = tangled(8);
    const out = runRelayout(cy, new Set());
    expect(cy.nodes().map((n) => n.position()).every(finite)).toBe(true);
    expect(minGap(cy)).toBeGreaterThan(20);
    expect(new Set(out.keys())).toEqual(new Set(cy.nodes().map((n) => n.id())));
    for (const [id, p] of out) expect(cy.getElementById(id).position()).toEqual(p);
  });

  test("fixed nodes keep their exact positions and are not returned", () => {
    const cy = tangled(8);
    cy.getElementById("c").position({ x: 500, y: -300 });
    cy.getElementById("x3").position({ x: -400, y: 250 }); // a fixed leaf stays off its anchor's rings
    const out = runRelayout(cy, new Set(["c", "x3"]));
    expect(cy.getElementById("c").position()).toEqual({ x: 500, y: -300 });
    expect(cy.getElementById("x3").position()).toEqual({ x: -400, y: 250 });
    expect(out.has("c")).toBe(false);
    expect(out.has("x3")).toBe(false);
    expect(out.size).toBe(cy.nodes().length - 2);
    expect(minGap(cy)).toBeGreaterThan(20);
  });

  test("a '+N more' proxy is placed outside its center's neighbours but not returned", () => {
    const cy = tangled(6);
    cy.add([{ data: { id: "more:c" }, position: { x: 0, y: 0 } }, { data: { id: "cm", source: "c", target: "more:c" } }]);
    const out = runRelayout(cy, new Set());
    expect(out.has("more:c")).toBe(false);
    expect(proxyOutside(cy, "c")).toBe(true);
  });

  test("an empty graph, or one where every node is fixed, is left alone", () => {
    expect(runRelayout(cytoscape({ headless: true }), new Set()).size).toBe(0);
    const cy = tangled(2);
    const before = cy.nodes().map((n) => ({ ...n.position() }));
    expect(runRelayout(cy, new Set(cy.nodes().map((n) => n.id()))).size).toBe(0);
    expect(cy.nodes().map((n) => n.position())).toEqual(before);
  });
});
