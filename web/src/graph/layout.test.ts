import cytoscape from "cytoscape";
import { describe, expect, test, vi } from "vitest";
import { runDagreLayout, runIncrementalLayout } from "./layout";

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
