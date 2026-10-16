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
});
