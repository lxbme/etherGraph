import cytoscape from "cytoscape";
import { beforeEach, expect, test } from "vitest";
import { relayoutGraph } from "./relayout";
import { useGraph } from "./store";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const D = "0x" + "d".repeat(40);
const g = () => useGraph.getState();

/** A–B–C–D chain plus A–C, every node piled near the origin. */
function canvas() {
  const cy = cytoscape({ headless: true });
  cy.add([
    { data: { id: A }, position: { x: 0, y: 0 } },
    { data: { id: B }, position: { x: 1, y: 0 } },
    { data: { id: C }, position: { x: 2, y: 0 } },
    { data: { id: D }, position: { x: 3, y: 0 } },
    { data: { id: "ab", source: A, target: B } },
    { data: { id: "bc", source: B, target: C } },
    { data: { id: "cd", source: C, target: D } },
    { data: { id: "ac", source: A, target: C } },
  ]);
  return cy;
}

beforeEach(() => g().reset());

test("re-layout stores every moved node's new position as one undoable step", () => {
  const cy = canvas();
  relayoutGraph(cy);
  for (const id of [A, B, C, D]) expect(g().ui[id]?.pos).toEqual(cy.getElementById(id).position());
  expect(g().canUndo()).toBe(true);
  g().undo();
  expect(g().ui[A]?.pos).toEqual({ x: 0, y: 0 });
  expect(g().ui[D]?.pos).toEqual({ x: 3, y: 0 });
  expect(g().canUndo()).toBe(false);
});

test("pinned nodes stay put and are not part of the step", () => {
  const cy = canvas();
  g().setPinned([B], true);
  const pastBefore = g()._past.length;
  relayoutGraph(cy);
  expect(cy.getElementById(B).position()).toEqual({ x: 1, y: 0 });
  expect(g().ui[B]?.pos).toBeUndefined();
  expect(g()._past.length).toBe(pastBefore + 1);
});

test("nothing happens when every node is pinned", () => {
  const cy = canvas();
  g().setPinned([A, B, C, D], true);
  const pastBefore = g()._past.length;
  relayoutGraph(cy);
  expect(g()._past.length).toBe(pastBefore);
});

test("re-layout also works on a snapshot (frozen) graph without asking to refresh", () => {
  const cy = canvas();
  g().freeze({ exported_at: "2026-10-18T00:00:00Z", includes: { labels: false, notes: false }, data: { nodes: [], edges: [], omitted: {}, coverage: {} } });
  relayoutGraph(cy);
  expect(g().pendingLive).toBeNull();
  expect(g().frozen).not.toBeNull();
  expect(g().ui[A]?.pos).toEqual(cy.getElementById(A).position());
});
