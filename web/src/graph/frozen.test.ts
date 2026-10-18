import type { GraphSnapshot } from "../workspace/snapshot";
import { useAssetRegistry } from "./assetRegistry";
import { setUnfreezeHandler, useGraph, type GraphState } from "./store";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const g = () => useGraph.getState();

const SNAP: GraphSnapshot = {
  exported_at: "2026-10-01T12:00:00Z",
  includes: { labels: false, notes: false },
  data: { nodes: [], edges: [], omitted: {}, coverage: {} },
};

/** The part of the state the gated actions change. */
const graphPart = (s: GraphState) => ({
  centers: s.centers,
  expandedPairs: [...s.expandedPairs],
  filter: s.filter,
  sort: s.sort,
  limits: s.limits,
});

beforeEach(() => {
  g().reset();
  g().setCenters([A, B]);
  g().freeze(SNAP);
});
afterEach(() => setUnfreezeHandler(null));

const gated: [string, () => void][] = [
  ["addCenter", () => g().addCenter(C)],
  ["revealCenter", () => g().revealCenter(C)],
  ["revealCenters", () => g().revealCenters([C])],
  ["removeCenter", () => g().removeCenter(A)],
  ["setCenters", () => g().setCenters([C])],
  ["expand", () => g().expand([C], "batch-1", 5)],
  ["raiseLimit", () => g().raiseLimit(A, 10)],
  ["setFilter", () => g().setFilter({ kinds: ["erc20"] })],
  ["setSort", () => g().setSort("recent")],
  ["applyFilter", () => g().applyFilter({ kinds: ["erc20"] }, "amount")],
  ["togglePair", () => g().togglePair(A, B)],
];

describe.each(gated)("%s while frozen", (_, act) => {
  test("asks first and changes nothing", () => {
    const before = graphPart(g());
    act();
    expect(g().pendingLive).not.toBeNull();
    expect(graphPart(g())).toEqual(before);
    expect(g().frozen).toBe(SNAP);
  });

  test("cancel leaves the snapshot and drops the action", () => {
    const before = graphPart(g());
    act();
    g().resolveLive(false);
    expect(g().pendingLive).toBeNull();
    expect(g().frozen).toBe(SNAP);
    expect(graphPart(g())).toEqual(before);
  });

  test("confirm refreshes (unfreezes) and then runs it", () => {
    const before = graphPart(g());
    act();
    g().resolveLive(true);
    expect(g().pendingLive).toBeNull();
    expect(g().frozen).toBeNull();
    expect(graphPart(g())).not.toEqual(before);
  });
});

test("live (not frozen), the same actions run at once", () => {
  g().unfreeze();
  g().addCenter(C);
  expect(g().centers).toEqual([A, B, C]);
  expect(g().pendingLive).toBeNull();
});

test("view-state actions are not gated", () => {
  g().setPinned([A], true);
  g().setHidden([C], true);
  g().setNote(A, "n");
  g().setPositions({ [A]: { x: 1, y: 2 } });
  g().commitMove({ [A]: { x: 0, y: 0 } });
  g().focusNeighborhood(A, [B]);
  g().select({ kind: "node", address: A });
  expect(g().pendingLive).toBeNull();
  expect(g().frozen).toBe(SNAP);
  expect(g().ui[A]).toMatchObject({ pinned: true, note: "n", pos: { x: 1, y: 2 } });
  expect(g().ui[C]?.hidden).toBe(true);
});

test("undo/redo of a view-state step runs; of a graph-changing step it asks first", () => {
  g().setPinned([A], true);
  g().undo();
  expect(g().ui[A]?.pinned).toBe(false);
  g().redo();
  expect(g().ui[A]?.pinned).toBe(true);
  expect(g().pendingLive).toBeNull();

  // A graph-changing step made while live, then the view is frozen again.
  g().unfreeze();
  g().addCenter(C);
  g().freeze(SNAP);
  g().undo();
  expect(g().pendingLive).not.toBeNull();
  expect(g().centers).toEqual([A, B, C]);
  g().resolveLive(true);
  expect(g().frozen).toBeNull();
  expect(g().centers).toEqual([A, B]);
});

test("guardLive runs at once when live and asks when frozen", () => {
  const run = vi.fn();
  g().guardLive(run);
  expect(run).not.toHaveBeenCalled();
  g().resolveLive(true);
  expect(run).toHaveBeenCalledTimes(1);
  g().guardLive(run);
  expect(run).toHaveBeenCalledTimes(2);
});

test("unfreeze hands the centers to the unfreeze handler (to sync them); reset and loadSnapshot drop the snapshot without it", () => {
  const onUnfreeze = vi.fn();
  setUnfreezeHandler(onUnfreeze);
  g().unfreeze();
  expect(onUnfreeze).toHaveBeenCalledWith([A, B]);
  g().unfreeze();
  expect(onUnfreeze).toHaveBeenCalledTimes(1);

  g().freeze(SNAP);
  g().reset();
  expect(g().frozen).toBeNull();
  g().freeze(SNAP);
  g().loadSnapshot({ centers: [C], filter: {}, expandedPairs: [], ui: {} });
  expect(g().frozen).toBeNull();
  expect(onUnfreeze).toHaveBeenCalledTimes(1);
});

test("refresh from chain (unfreeze) drops the file's assets from the session registry", () => {
  const FAKE = "0x" + "fa".repeat(20);
  useAssetRegistry.getState().merge([{
    from: A, to: B, asset: FAKE, asset_kind: "erc20", count: 1, sum: "1",
    first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-01T00:00:00Z", decimals: 6, symbol: "USDT",
    trust: { level: "listed", impersonates: null, reason: null },
  }]);
  expect(useAssetRegistry.getState().assets[FAKE]).toBeDefined();
  g().unfreeze();
  expect(useAssetRegistry.getState().assets).toEqual({});
});

test("a pending action is dropped when the canvas is replaced", () => {
  g().addCenter(C);
  g().reset();
  expect(g().pendingLive).toBeNull();
});
