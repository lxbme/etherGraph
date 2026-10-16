import cytoscape from "cytoscape";
import { describe, expect, test } from "vitest";
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
});
