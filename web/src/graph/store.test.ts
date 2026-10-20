import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useCanvasMetrics } from "./canvasMetrics";
import { setHistoryEffectHandler, type ExpandEffect } from "./historyEffects";
import { firstBatch, firstBatchFor, ownNeighbours, pairKey, useGraph } from "./store";

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

  test("a dragged +N more proxy is kept by center, outside the address ui, and its drag is undoable", () => {
    g().setPositions({ [`more:${A}`]: { x: 5, y: 5 } });
    g().commitMove({ [`more:${A}`]: { x: 0, y: 0 } });
    expect(g().proxyPos[A]).toEqual({ x: 5, y: 5 });
    expect(Object.keys(g().ui).some((k) => k.startsWith("more:"))).toBe(false);
    g().undo();
    expect(g().proxyPos[A]).toEqual({ x: 0, y: 0 });
    g().redo();
    expect(g().proxyPos[A]).toEqual({ x: 5, y: 5 });
  });

  test("undoing a step that cleared a proxy position restores it; redoing clears it again", () => {
    g().setPositions({ [`more:${A}`]: { x: 5, y: 5 } });
    g().clearProxyPositions();
    g().commitMove({ [`more:${A}`]: { x: 5, y: 5 } });
    expect(g().proxyPos[A]).toBeUndefined();
    g().undo();
    expect(g().proxyPos[A]).toEqual({ x: 5, y: 5 });
    g().redo();
    expect(g().proxyPos[A]).toBeUndefined();
  });

  test("pruning drops the positions of proxies no longer shown and leaves the state alone when nothing goes", () => {
    g().setPositions({ [`more:${A}`]: { x: 1, y: 1 }, [`more:${B}`]: { x: 2, y: 2 } });
    g().pruneProxyPositions([B]);
    expect(g().proxyPos).toEqual({ [B]: { x: 2, y: 2 } });
    const before = g();
    g().pruneProxyPositions([B, C]);
    expect(g()).toBe(before);
    g().reset();
    const empty = g();
    g().clearProxyPositions();
    expect(g()).toBe(empty);
  });

  test("moving only a proxy leaves the address ui untouched (a workspace has nothing new to save)", () => {
    g().setPositions({ [A]: { x: 1, y: 1 } });
    const ui = g().ui;
    g().setPositions({ [`more:${A}`]: { x: 5, y: 5 } });
    g().commitMove({ [`more:${A}`]: { x: 0, y: 0 } });
    expect(g().ui).toBe(ui);
    g().undo();
    expect(g().ui).toBe(ui);
  });

  test("reset and loadSnapshot forget proxy positions", () => {
    g().setPositions({ [`more:${A}`]: { x: 1, y: 1 } });
    g().reset();
    expect(g().proxyPos).toEqual({});
    g().setPositions({ [`more:${A}`]: { x: 1, y: 1 } });
    g().loadSnapshot({ centers: [A], filter: {}, expandedPairs: [], ui: {} });
    expect(g().proxyPos).toEqual({});
  });

  test("setProxiesHidden hides and undo restores", () => {
    g().setCenters([A, B]);
    g().setProxiesHidden([A.toUpperCase().replace("0X", "0x"), A, B], true);
    expect(g().hiddenProxies).toEqual([A, B]);
    g().setProxiesHidden([A], false);
    expect(g().hiddenProxies).toEqual([B]);
    g().undo();
    expect(g().hiddenProxies).toEqual([A, B]);
    g().undo();
    expect(g().hiddenProxies).toEqual([]);
    g().redo();
    expect(g().hiddenProxies).toEqual([A, B]);
    g().reset();
    expect(g().hiddenProxies).toEqual([]);
    g().loadSnapshot({ centers: [A], filter: {}, expandedPairs: [], ui: {}, hiddenProxies: [A, C] });
    expect(g().hiddenProxies).toEqual([A]);
  });

  test("removing a center drops its hidden proxy", () => {
    g().setCenters([A, B, C]);
    g().setProxiesHidden([A, B, C], true);
    g().removeCenter(A);
    expect(g().hiddenProxies).toEqual([B, C]);
    g().setHidden([B], true);
    expect(g().hiddenProxies).toEqual([C]);
    g().undo();
    expect(g().hiddenProxies).toEqual([B, C]);
    g().undo();
    expect(g().hiddenProxies).toEqual([A, B, C]);
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

  test("loadSnapshot shares the budget between top-k centers without a limit, ignoring the old canvas", () => {
    useCanvasMetrics.getState().set({ visible: 20 });
    g().loadSnapshot({ centers: [A, B, C, D], ui: {}, filter: {}, expandedPairs: [] } as never);
    expect(g().limits).toEqual({ [A]: 14, [B]: 14, [C]: 14, [D]: 14 }); // (60 - 4) / 4
    g().loadSnapshot({ centers: [A, B], ui: {}, filter: {}, expandedPairs: [] } as never);
    expect(g().limits).toEqual({ [A]: 29, [B]: 29 }); // (60 - 2) / 2
  });

  test("a single loaded top-k center without a limit gets the full single-center batch", () => {
    g().loadSnapshot({ centers: [A], ui: {}, filter: {}, expandedPairs: [] } as never);
    expect(g().limits[A]).toBe(59);
  });

  test("a removed top-k center re-added with addCenter keeps its limit", () => {
    g().loadSnapshot({ centers: ["x"], ui: {}, filter: {}, expandedPairs: [], limits: { x: 64 } });
    g().removeCenter("x");
    g().addCenter("x");
    expect(g().limits.x).toBe(64);
    expect(g().picks.x).toBeUndefined();
  });

  test("revealCenter and setCenters give new centers no first batch, whatever the canvas", () => {
    g().revealCenter(A.toUpperCase().replace("0X", "0x"));
    expect(g().limits).toEqual({});
    useCanvasMetrics.getState().set({ visible: 10 });
    g().setCenters([A, B]);
    expect(g().limits).toEqual({});
    expect(g().picks).toEqual({ [A]: [], [B]: [] });
  });

  test("expand adds centers picked with none in one step; undo/redo run the batch effects", () => {
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
    expect(g().picks).toEqual({ [C]: [], a: [], b: [] });

    g().undo();
    expect(g().centers).toEqual([C]);
    expect(g().picks).toEqual({ [C]: [] });
    expect(undone).toEqual([{ kind: "expand", batch: "b1", addresses: ["a", "b"] }]);

    g().redo();
    expect(g().centers).toEqual([C, "a", "b"]);
    expect(g().picks).toEqual({ [C]: [], a: [], b: [] });
    expect(g().limits).toEqual({});
    expect(redone).toEqual([{ kind: "expand", batch: "b1", addresses: ["a", "b"] }]);

    g().undo();
    expect(undone[1]).toEqual({ kind: "expand", batch: "b2", addresses: ["a", "b"] });
  });

  test("expand keeps the limit of an address that already is a center and unhides hidden ones", () => {
    g().loadSnapshot({ centers: [A], ui: {}, filter: {}, expandedPairs: [], limits: { [A]: 59 } });
    g().setHidden([B], true);
    g().expand([A, B.toUpperCase().replace("0X", "0x")], "b1", 7);
    expect(g().centers).toEqual([A, B]);
    expect(g().limits).toEqual({ [A]: 59 });
    expect(g().picks).toEqual({ [B]: [] });
    expect(g().ui[B]?.hidden).toBe(false);
  });

  test("expand gives a re-added top-k center limit k and keeps a re-added picked center's picks", () => {
    g().loadSnapshot({ centers: [], ui: {}, filter: {}, expandedPairs: [], limits: { [A]: 3 }, picks: { [B]: [C] } });
    g().expand([A, B], "b1", 7);
    expect(g().limits).toEqual({ [A]: 7 });
    expect(g().picks).toEqual({ [B]: [C] });
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

  test("loadSnapshot keeps given limits and gives centers without one a first batch", () => {
    g().loadSnapshot({ centers: [A, B], filter: {}, expandedPairs: [], ui: {}, limits: { [A.toUpperCase().replace("0X", "0x")]: 12 } });
    expect(g().limits).toEqual({ [A]: 12, [B]: 59 });
    g().reset();
    expect(g().limits).toEqual({});
  });
});

describe("loadSnapshot proxy positions", () => {
  test("keeps only those of the loaded centers", () => {
    const p = { x: 3, y: 4 };
    g().loadSnapshot({ centers: [A], ui: {}, filter: {}, expandedPairs: [], proxyPos: { [A]: p, [B]: { x: 1, y: 1 } } } as never);
    expect(g().proxyPos).toEqual({ [A]: p });
  });
});

describe("picked neighbours", () => {
  const edge = (from: string, to: string) => ({
    from, to, asset: null, count: 1, sum: "1", first_ts: "", last_ts: "", decimals: null, symbol: null, trust: "unknown",
  }) as never;

  test("new_centers_start_picked_with_none", () => {
    g().revealCenter(A.toUpperCase().replace("0X", "0x"));
    expect(g().picks[A]).toEqual([]);
    expect(g().limits[A]).toBeUndefined();
    g().addCenter(B);
    g().setCenters([B, C]);
    expect(g().picks).toEqual({ [A]: [], [B]: [], [C]: [] });
    expect(g().limits).toEqual({});
  });

  test("re-adding a center keeps its picks or its limit", () => {
    g().addCenter(A);
    g().applyPicks({ [A]: [B] });
    g().removeCenter(A);
    g().addCenter(A);
    expect(g().picks[A]).toEqual([B]);
    g().loadSnapshot({ centers: [C], filter: {}, expandedPairs: [], ui: {}, limits: { [C]: 12 } });
    g().removeCenter(C);
    g().revealCenter(C);
    expect(g().limits[C]).toBe(12);
    expect(g().picks[C]).toBeUndefined();
  });

  test("loaded_centers_without_picks_stay_top_k", () => {
    g().loadSnapshot({ centers: [A, B], filter: {}, expandedPairs: [], ui: {}, limits: { [A]: 12, [B]: 7 } });
    expect(g().picks).toEqual({});
    expect(g().limits).toEqual({ [A]: 12, [B]: 7 });
  });

  test("loadSnapshot keeps given picks (lowercased) and gives those centers no first batch", () => {
    const up = (x: string) => x.toUpperCase().replace("0X", "0x");
    g().loadSnapshot({ centers: [A, B], filter: {}, expandedPairs: [], ui: {}, picks: { [up(A)]: [up(C), C] } });
    expect(g().picks).toEqual({ [A]: [C] });
    expect(g().limits).toEqual({ [B]: 59 });
    g().reset();
    expect(g().picks).toEqual({});
  });

  test("applyPicks_is_one_undo_step", () => {
    g().addCenter(A);
    const steps = g()._past.length;
    g().applyPicks({ [A]: [B, C.toUpperCase().replace("0X", "0x"), B], [D]: [] });
    expect(g()._past.length).toBe(steps + 1);
    expect(g().centers).toEqual([A, D]);
    expect(g().picks).toEqual({ [A]: [B, C], [D]: [] });
    g().undo();
    expect(g().centers).toEqual([A]);
    expect(g().picks).toEqual({ [A]: [] });
    g().redo();
    expect(g().picks).toEqual({ [A]: [B, C], [D]: [] });
  });

  test("applyPicks_unhides_checked_and_hides_dropped", () => {
    g().addCenter(A);
    g().setHidden([C], true);
    g().applyPicks({ [A]: [B, C] });
    expect(g().ui[C]?.hidden).toBe(false);
    g().applyPicks({ [A]: [B] });
    expect(g().ui[C]?.hidden).toBe(true);
    expect(g().ui[B]?.hidden ?? false).toBe(false);
  });

  test("applyPicks makes a hidden key a shown center again", () => {
    g().addCenter(A);
    g().setHidden([A], true);
    g().applyPicks({ [A]: [B] });
    expect(g().centers).toEqual([A]);
    expect(g().ui[A]?.hidden).toBe(false);
  });

  test("dropping_a_neighbour_another_center_keeps_does_not_hide_it", () => {
    g().setCenters([A, B]);
    g().applyPicks({ [A]: [C], [B]: [C] });
    g().applyPicks({ [A]: [] });
    expect(g().ui[C]?.hidden ?? false).toBe(false);
  });

  test("dropping a neighbour that is itself a center does not hide it", () => {
    g().setCenters([A, B]);
    g().applyPicks({ [A]: [B] });
    g().applyPicks({ [A]: [] });
    expect(g().ui[B]?.hidden ?? false).toBe(false);
    expect(g().centers).toEqual([A, B]);
  });

  test("legacy_center_first_pick_hides_its_dropped_top_k_neighbours", () => {
    const E = "0x" + "e".repeat(40);
    // A legacy (top-k) center showing B, C, D: its first pick keeps B only.
    g().loadSnapshot({ centers: [A], filter: {}, expandedPairs: [], ui: {}, limits: { [A]: 3 } });
    g().applyPicks({ [A]: [B, E] }, { [A]: [B, C, D.toUpperCase().replace("0X", "0x")] });
    expect(g().picks).toEqual({ [A]: [B, E] });
    expect(g().ui[C]?.hidden).toBe(true);
    expect(g().ui[D]?.hidden).toBe(true);
    expect(g().ui[B]?.hidden ?? false).toBe(false);
    expect(g().ui[E]?.hidden ?? false).toBe(false);
    g().undo();
    expect(g().ui[C]?.hidden ?? false).toBe(false);
    expect(g().picks).toEqual({});
  });

  test("a_node_a_legacy_center_keeps_is_not_hidden_when_another_center_drops_it", () => {
    // B is a legacy center showing C; A (picked) showed C and D and drops both.
    g().loadSnapshot({ centers: [A, B], filter: {}, expandedPairs: [], ui: {}, limits: { [B]: 3 }, picks: { [A]: [C, D] } });
    g().applyPicks({ [A]: [] }, { [A]: [C, D], [B]: [C] });
    expect(g().ui[C]?.hidden ?? false).toBe(false);
    expect(g().ui[D]?.hidden).toBe(true);
    // A legacy target keeps nothing once it is picked itself.
    g().applyPicks({ [B]: [] }, { [B]: [C] });
    expect(g().ui[C]?.hidden).toBe(true);
  });

  test("hiding_removes_from_picks", () => {
    g().setCenters([A, B]);
    g().applyPicks({ [A]: [C, D], [B]: [C] });
    const steps = g()._past.length;
    g().setHidden([C], true);
    expect(g()._past.length).toBe(steps + 1);
    expect(g().picks).toEqual({ [A]: [D], [B]: [] });
    g().undo();
    expect(g().picks).toEqual({ [A]: [C, D], [B]: [C] });
    g().setHidden([D], false);
    expect(g().picks).toEqual({ [A]: [C, D], [B]: [C] });
  });

  test("expand_gives_new_centers_empty_picks", () => {
    g().addCenter(A);
    g().expand([A, B], "b1", 7);
    expect(g().centers).toEqual([A, B]);
    expect(g().picks).toEqual({ [A]: [], [B]: [] });
    expect(g().limits).toEqual({});
  });

  test("filter_change_keeps_picks", () => {
    g().addCenter(A);
    g().applyPicks({ [A]: [B] });
    const picks = g().picks;
    g().applyFilter({ direction: "in" }, "recent");
    expect(g().picks).toBe(picks);
  });

  test("ownNeighbours: the picks of a picked center, the shown neighbours of a legacy one", () => {
    g().loadSnapshot({ centers: [A, B], filter: {}, expandedPairs: [], ui: {}, limits: { [B]: 5 }, picks: { [A]: [C] } });
    g().setHidden([D], true);
    const data = { nodes: [], edges: [edge(A, D), edge(B, C), edge(D, B), edge(C, A), edge(B, A)], omitted: {}, coverage: {} };
    expect(ownNeighbours(A, data)).toEqual([C]);
    expect(ownNeighbours(B.toUpperCase().replace("0X", "0x"), data)).toEqual([C, A]);
    expect(ownNeighbours(B, undefined)).toEqual([]);
  });
});
