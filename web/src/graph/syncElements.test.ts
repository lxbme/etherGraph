import cytoscape from "cytoscape";
import { describe, expect, test } from "vitest";
import { syncElements } from "./CytoscapeView";

const n = (id: string, extra: Partial<cytoscape.ElementDefinition> = {}): cytoscape.ElementDefinition => ({
  group: "nodes", data: { id, label: id }, classes: "kind-eoa", ...extra,
});
const e = (id: string, source: string, target: string, data: Record<string, unknown> = {}): cytoscape.ElementDefinition => ({
  group: "edges", data: { id, source, target, ...data }, classes: "asset-eth",
});

describe("syncElements", () => {
  test("adds new elements and reports unpositioned new nodes", () => {
    const cy = cytoscape({ headless: true });
    const r = syncElements(cy, [n("a"), n("b", { position: { x: 1, y: 2 } }), e("ab", "a", "b")], new Map());
    expect(cy.nodes().length).toBe(2);
    expect(cy.edges().length).toBe(1);
    expect(r.newNodeIds).toEqual(["a"]);
    expect(r.structureChanged).toBe(true);
    expect(cy.getElementById("b").position()).toEqual({ x: 1, y: 2 });
  });

  test("updates data and classes in place, removes stale elements, keeps positions", () => {
    const cy = cytoscape({ headless: true });
    const r1 = syncElements(cy, [n("a"), n("b"), e("ab", "a", "b", { badge: "×2" })], new Map());
    cy.getElementById("a").position({ x: 42, y: 43 }); // user dragged
    const a = cy.getElementById("a");

    const r2 = syncElements(
      cy,
      [n("a", { data: { id: "a", label: "alice" }, classes: "kind-eoa selected" }), e("ab2", "a", "a")],
      r1.positions,
    );
    expect(cy.getElementById("a")).toBe(a); // same element, not rebuilt
    expect(a.data("label")).toBe("alice");
    expect(a.hasClass("selected")).toBe(true);
    expect(a.position()).toEqual({ x: 42, y: 43 });
    expect(cy.getElementById("b").length).toBe(0);
    expect(cy.getElementById("ab").length).toBe(0);
    expect(r2.newNodeIds).toEqual([]);
    expect(r2.structureChanged).toBe(true);
  });

  test("drops data keys that disappeared (e.g. a badge)", () => {
    const cy = cytoscape({ headless: true });
    const r1 = syncElements(cy, [n("a"), n("b"), e("ab", "a", "b", { badge: "×2" })], new Map());
    const r2 = syncElements(cy, [n("a"), n("b"), e("ab", "a", "b")], r1.positions);
    expect(cy.getElementById("ab").data("badge")).toBeUndefined();
    expect(r2.structureChanged).toBe(false);
  });

  test("applies a definition position only when it changed since the last sync", () => {
    const cy = cytoscape({ headless: true });
    const r1 = syncElements(cy, [n("a", { position: { x: 0, y: 0 } })], new Map());
    cy.getElementById("a").position({ x: 50, y: 50 }); // dragged, store not yet updated
    const r2 = syncElements(cy, [n("a", { position: { x: 0, y: 0 } })], r1.positions);
    expect(cy.getElementById("a").position()).toEqual({ x: 50, y: 50 });
    syncElements(cy, [n("a", { position: { x: 7, y: 8 } })], r2.positions); // e.g. undo
    expect(cy.getElementById("a").position()).toEqual({ x: 7, y: 8 });
  });

  test("a node that left and comes back without a definition position returns where it was, not as new", () => {
    const cy = cytoscape({ headless: true });
    const last = new Map<string, { x: number; y: number }>();
    const r1 = syncElements(cy, [n("a"), n("c"), e("ac", "a", "c")], new Map(), last);
    cy.getElementById("c").position({ x: 120, y: -40 }); // placed by the layout
    const r2 = syncElements(cy, [n("a")], r1.positions, last); // e.g. filtered out
    expect(cy.getElementById("c").empty()).toBe(true);
    const r3 = syncElements(cy, [n("a"), n("c"), e("ac", "a", "c"), n("d")], r2.positions, last); // undo
    expect(cy.getElementById("c").position()).toEqual({ x: 120, y: -40 });
    expect(r3.newNodeIds).toEqual(["d"]);
    expect(r3.structureChanged).toBe(true);
  });

  test("a +N more proxy updates its label in place and is removed with its edge when nothing is omitted", () => {
    const cy = cytoscape({ headless: true });
    const more = (label: string) => [
      { group: "nodes" as const, data: { id: "more:a", label, center: "a" }, classes: "more" },
      { group: "edges" as const, data: { id: "more-edge:a", source: "a", target: "more:a" }, classes: "more" },
    ];
    const r1 = syncElements(cy, [n("a"), ...more("+12 more")], new Map());
    expect(r1.newNodeIds).toEqual(["a", "more:a"]);
    const r2 = syncElements(cy, [n("a"), ...more("+5 more")], r1.positions);
    expect(cy.getElementById("more:a").data("label")).toBe("+5 more");
    expect(r2.newNodeIds).toEqual([]);
    syncElements(cy, [n("a")], r2.positions);
    expect(cy.getElementById("more:a").empty()).toBe(true);
    expect(cy.getElementById("more-edge:a").empty()).toBe(true);
  });

  test("a +N more proxy that leaves and comes back is new again, not put back where it was", () => {
    const cy = cytoscape({ headless: true });
    const proxy = (pos?: { x: number; y: number }) =>
      n("more:a", { data: { id: "more:a", ...(pos && { placed: true }) }, classes: "more", ...(pos && { position: pos }) });
    const lastPos = new Map<string, { x: number; y: number }>();
    const r1 = syncElements(cy, [n("a", { position: { x: 0, y: 0 } }), proxy({ x: 300, y: 200 })], new Map(), lastPos);
    const r2 = syncElements(cy, [n("a", { position: { x: 0, y: 0 } })], r1.positions, lastPos);
    const r3 = syncElements(cy, [n("a", { position: { x: 0, y: 0 } }), proxy()], r2.positions, lastPos);
    expect(r3.newNodeIds).toEqual(["more:a"]);
  });

  test("a node that loses its placed flag while still where its definition put it is laid out again", () => {
    const cy = cytoscape({ headless: true });
    const placed = n("p", { data: { id: "p", placed: true }, position: { x: 300, y: 200 } });
    const r1 = syncElements(cy, [placed], new Map());
    const r2 = syncElements(cy, [n("p")], r1.positions);
    expect(r2.newNodeIds).toEqual(["p"]);
    expect(cy.getElementById("p").data("placed")).toBeUndefined();
  });

  test("a node that loses its placed flag after a layout moved it stays where the layout put it", () => {
    const cy = cytoscape({ headless: true });
    const r1 = syncElements(cy, [n("p", { data: { id: "p", placed: true }, position: { x: 300, y: 200 } })], new Map());
    cy.getElementById("p").position({ x: 10, y: 20 }); // Re-layout
    const r2 = syncElements(cy, [n("p")], r1.positions);
    expect(r2.newNodeIds).toEqual([]);
    expect(cy.getElementById("p").position()).toEqual({ x: 10, y: 20 });
  });
});
