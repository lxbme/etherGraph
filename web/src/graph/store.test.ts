import { beforeEach, describe, expect, test } from "vitest";
import { pairKey, useGraph } from "./store";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const D = "0x" + "d".repeat(40);
const g = () => useGraph.getState();

beforeEach(() => g().reset());

describe("graph store", () => {
  test("any select clears the highlighted transfer", () => {
    g().setHighlightTransfer({ from: A, to: B, asset: null });
    g().select({ kind: "node", address: C });
    expect(g().highlightTransfer).toBeNull();
    g().setHighlightTransfer({ from: A, to: B, asset: null });
    g().select(null);
    expect(g().highlightTransfer).toBeNull();
  });

  test("hiding a center also removes it from centers, in one undo step", () => {
    g().setCenters([A, B]);
    g().setHidden([A, C], true);
    expect(g().centers).toEqual([B]);
    expect(g().ui[A]?.hidden).toBe(true);
    g().undo();
    expect(g().centers).toEqual([A, B]);
    expect(g().ui[A]?.hidden).toBe(false);
  });

  test("revealCenter adds a center and unhides it in one step; no-op when already shown", () => {
    g().setCenters([A]);
    g().setHidden([A], true);
    const steps = g()._past.length;
    g().revealCenter(A.toUpperCase().replace("0X", "0x"));
    expect(g().centers).toEqual([A]);
    expect(g().ui[A]?.hidden).toBe(false);
    expect(g()._past.length).toBe(steps + 1);
    g().revealCenter(A);
    expect(g()._past.length).toBe(steps + 1);
    g().undo();
    expect(g().centers).toEqual([]);
    expect(g().ui[A]?.hidden).toBe(true);
  });

  test("reset and loadSnapshot start a new canvas epoch; edits do not", () => {
    const e0 = g().epoch;
    g().addCenter(A);
    g().setHidden([B], true);
    expect(g().epoch).toBe(e0);
    g().reset();
    expect(g().epoch).toBe(e0 + 1);
    g().loadSnapshot({ centers: [A], filter: {}, expandedPairs: [], ui: {} });
    expect(g().epoch).toBe(e0 + 2);
  });

  test("addCenter lowercases and dedupes", () => {
    g().addCenter(A.toUpperCase().replace("0X", "0x"));
    g().addCenter(A);
    expect(g().centers).toEqual([A]);
  });

  test("pairKey is order independent", () => {
    expect(pairKey(B, A)).toBe(`${A}|${B}`);
  });

  test("undo/redo restores centers, expandedPairs, hidden and filter; positions are not in history", () => {
    g().addCenter(A);
    g().togglePair(A, B);
    g().setHidden([C], true);
    g().setFilter({ direction: "in" });
    g().setPositions({ [A]: { x: 1, y: 2 } });

    g().undo(); // filter
    expect(g().filter).toEqual({});
    g().undo(); // hidden
    expect(g().ui[C]?.hidden ?? false).toBe(false);
    g().undo(); // pair
    expect(g().expandedPairs.size).toBe(0);
    g().undo(); // center
    expect(g().centers).toEqual([]);
    expect(g().canUndo()).toBe(false);
    expect(g().ui[A]?.pos).toEqual({ x: 1, y: 2 }); // position untouched

    g().redo(); g().redo(); g().redo(); g().redo();
    expect(g().centers).toEqual([A]);
    expect(g().expandedPairs.has(pairKey(A, B))).toBe(true);
    expect(g().ui[C]?.hidden).toBe(true);
    expect(g().filter).toEqual({ direction: "in" });
    expect(g().canRedo()).toBe(false);
  });

  test("expandedPairs gets a new Set reference on change", () => {
    const before = g().expandedPairs;
    g().togglePair(A, B);
    expect(g().expandedPairs).not.toBe(before);
    expect(before.size).toBe(0);
  });

  test("new tracked action clears redo", () => {
    g().addCenter(A);
    g().undo();
    expect(g().canRedo()).toBe(true);
    g().addCenter(B);
    expect(g().canRedo()).toBe(false);
  });

  test("history is capped at 100", () => {
    for (let i = 0; i < 120; i++) g().setNote(A, String(i));
    let n = 0;
    while (g().canUndo()) { g().undo(); n++; }
    expect(n).toBe(100);
  });

  test("commitMove makes a drag undoable and redoable", () => {
    g().setPositions({ [A]: { x: 0, y: 0 } });
    g().setPositions({ [A]: { x: 5, y: 5 } });
    g().commitMove({ [A]: { x: 0, y: 0 } });
    g().undo();
    expect(g().ui[A]?.pos).toEqual({ x: 0, y: 0 });
    g().redo();
    expect(g().ui[A]?.pos).toEqual({ x: 5, y: 5 });
  });

  test("snapshot undo keeps current positions", () => {
    g().setPinned([A], true);
    g().setPositions({ [A]: { x: 9, y: 9 } });
    g().undo();
    expect(g().ui[A]?.pinned).toBe(false);
    expect(g().ui[A]?.pos).toEqual({ x: 9, y: 9 });
  });

  test("selection and highlight are not tracked", () => {
    g().select({ kind: "node", address: A });
    g().setHighlightTransfer({ from: A, to: B, asset: null });
    expect(g().canUndo()).toBe(false);
  });

  test("reset clears history", () => {
    g().addCenter(A);
    g().reset();
    expect(g().canUndo()).toBe(false);
    expect(g().centers).toEqual([]);
  });

  test("focusNeighborhood hides everything but the node and its neighbors", () => {
    g().setCenters([A, B, C]);
    g().setPositions({ [D]: { x: 0, y: 0 } });
    g().focusNeighborhood(A, [B]);
    const hidden = (x: string) => g().ui[x]?.hidden ?? false;
    expect([hidden(A), hidden(B), hidden(C), hidden(D)]).toEqual([false, false, true, true]);
    g().undo();
    expect(hidden(C)).toBe(false);
  });

  test("focusNeighborhood hides nodes supplied only via allNodes", () => {
    g().setCenters([A]);
    g().focusNeighborhood(A, [B], [A, B, C, D.toUpperCase().replace("0X", "0x")]);
    expect(g().ui[C]?.hidden).toBe(true);
    expect(g().ui[D]?.hidden).toBe(true);
    expect(g().ui[B]?.hidden).toBe(false);
  });
});
