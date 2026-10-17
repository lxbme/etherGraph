import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useCanvasMetrics } from "./canvasMetrics";
import { setHistoryEffectHandler, type ExpandEffect } from "./historyEffects";
import { firstBatch, firstBatchFor, MAX_NEIGHBOUR_LIMIT, pairKey, useGraph } from "./store";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const D = "0x" + "d".repeat(40);
const g = () => useGraph.getState();

beforeEach(() => {
  g().reset();
  useCanvasMetrics.getState().set({ width: 960, height: 576, visible: 0 });
});
afterEach(() => setHistoryEffectHandler(null));

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

describe("per-center limits", () => {
  test("firstBatch uses the measured canvas minus visible nodes", () => {
    expect(firstBatch()).toBe(59); // capacity(960x576) = 60, minus the new center itself
    useCanvasMetrics.getState().set({ visible: 20 });
    expect(firstBatch()).toBe(39);
  });

  test("firstBatch estimates the canvas as 60% of the window before the first measure", () => {
    useCanvasMetrics.getState().set({ width: 0, height: 0, visible: 0 });
    const w = window.innerWidth;
    const h = window.innerHeight;
    try {
      Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true, writable: true });
      Object.defineProperty(window, "innerHeight", { value: 960, configurable: true, writable: true });
      expect(firstBatch()).toBe(99); // 0.6 * 1600 * 960 / 96^2 = 100, minus 1
    } finally {
      Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true });
      Object.defineProperty(window, "innerHeight", { value: h, configurable: true, writable: true });
    }
  });

  test("firstBatchFor shares the budget between n centers; fresh ignores the visible nodes (R12)", () => {
    useCanvasMetrics.getState().set({ visible: 20 });
    expect(firstBatchFor(1)).toBe(firstBatch());
    expect(firstBatchFor(4)).toBe(9); // (40 - 4) / 4
    expect(firstBatchFor(4, { fresh: true })).toBe(14); // (60 - 4) / 4
    expect(firstBatchFor(500)).toBe(3); // floor K_FLOOR
  });

  test("setCenters with several new centers shares the budget; loadSnapshot ignores the old canvas", () => {
    useCanvasMetrics.getState().set({ visible: 20 });
    g().setCenters([A, B, C, D]);
    expect(g().limits).toEqual({ [A]: 9, [B]: 9, [C]: 9, [D]: 9 });
    g().loadSnapshot({ centers: [A, B], ui: {}, filter: {}, expandedPairs: [] } as never);
    expect(g().limits).toEqual({ [A]: 29, [B]: 29 }); // (60 - 2) / 2
  });

  test("a single revealCenter keeps the full single-center batch", () => {
    g().revealCenter(A);
    expect(g().limits[A]).toBe(59);
  });

  test("addCenter writes the first batch; an existing limit is kept", () => {
    g().addCenter("x");
    expect(g().limits.x).toBe(59);
    g().raiseLimit("x", 5);
    g().removeCenter("x");
    g().addCenter("x");
    expect(g().limits.x).toBe(64);
  });

  test("revealCenter and setCenters give new centers a first batch", () => {
    g().revealCenter(A.toUpperCase().replace("0X", "0x"));
    expect(g().limits).toEqual({ [A]: 59 });
    useCanvasMetrics.getState().set({ visible: 10 });
    g().setCenters([A, B]);
    expect(g().limits).toEqual({ [A]: 59, [B]: 49 });
  });

  test("expand adds centers with limit k in one step; undo/redo run the batch effects", () => {
    const undone: ExpandEffect[] = [];
    const redone: ExpandEffect[] = [];
    setHistoryEffectHandler({
      onUndo: (e) => { undone.push(e); },
      onRedo: (e) => {
        redone.push(e);
        return { ...e, batch: "b2" };
      },
    });
    g().addCenter(C);
    g().expand(["a", "b"], "b1", 7);
    expect(g().centers).toEqual([C, "a", "b"]);
    expect(g().limits).toEqual({ [C]: 59, a: 7, b: 7 });

    g().undo();
    expect(g().centers).toEqual([C]);
    expect(g().limits).toEqual({ [C]: 59 });
    expect(undone).toEqual([{ kind: "expand", batch: "b1", addresses: ["a", "b"] }]);

    g().redo();
    expect(g().centers).toEqual([C, "a", "b"]);
    expect(g().limits).toEqual({ [C]: 59, a: 7, b: 7 });
    expect(redone).toEqual([{ kind: "expand", batch: "b1", addresses: ["a", "b"] }]);

    g().undo();
    expect(undone[1]).toEqual({ kind: "expand", batch: "b2", addresses: ["a", "b"] });
  });

  test("expand keeps the limit of an address that already is a center and unhides hidden ones", () => {
    g().addCenter(A);
    g().setHidden([B], true);
    g().expand([A, B.toUpperCase().replace("0X", "0x")], "b1", 7);
    expect(g().centers).toEqual([A, B]);
    expect(g().limits).toEqual({ [A]: 59, [B]: 7 });
    expect(g().ui[B]?.hidden).toBe(false);
  });

  test("undo and redo of an expand work without a handler", () => {
    g().expand(["a"], "b1", 7);
    g().undo();
    expect(g().centers).toEqual([]);
    g().redo();
    expect(g().centers).toEqual(["a"]);
  });

  test("non-expand steps run no effect", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    setHistoryEffectHandler({ onUndo, onRedo });
    g().addCenter(A);
    g().undo();
    g().redo();
    expect(onUndo).not.toHaveBeenCalled();
    expect(onRedo).not.toHaveBeenCalled();
  });

  test("raiseLimit is one history step without effect", () => {
    const onUndo = vi.fn();
    setHistoryEffectHandler({ onUndo, onRedo: vi.fn() });
    g().expand(["a", "b"], "b1", 7);
    g().raiseLimit("a", 5);
    expect(g().limits.a).toBe(12);
    g().undo();
    expect(g().limits.a).toBe(7);
    expect(onUndo).not.toHaveBeenCalled();
    g().redo();
    expect(g().limits.a).toBe(12);
  });

  test("raiseLimit stops at the server's per-center maximum", () => {
    g().expand(["a"], "b1", 990);
    g().raiseLimit("a", 50);
    expect(g().limits.a).toBe(MAX_NEIGHBOUR_LIMIT);
    const steps = g()._past.length;
    g().raiseLimit("a", 50);
    expect(g().limits.a).toBe(MAX_NEIGHBOUR_LIMIT);
    expect(g()._past.length).toBe(steps); // nothing to raise: no history step
  });

  test("loadSnapshot keeps given limits and gives centers without one a first batch", () => {
    g().loadSnapshot({ centers: [A, B], filter: {}, expandedPairs: [], ui: {}, limits: { [A.toUpperCase().replace("0X", "0x")]: 12 } });
    expect(g().limits).toEqual({ [A]: 12, [B]: 59 });
    g().reset();
    expect(g().limits).toEqual({});
  });
});
