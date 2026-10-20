import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { WorkspaceDto } from "../api/generated/WorkspaceDto";
import { useCanvasMetrics } from "../graph/canvasMetrics";
import { getMainCy } from "../graph/cyRegistry";
import { useGraph } from "../graph/store";
import { graphQueryKey } from "../graph/useGraphData";
import { useInfo } from "../panels/info/infoStore";
import { useTabs } from "../shell/tabs";
import { deserialize, serialize } from "./serialize";
import { saveStatusLabel } from "./useWorkspace";
import {
  deleteWorkspace,
  loadWorkspace,
  newWorkspace,
  overwriteCurrent,
  saveCurrent,
  saveNew,
  useUnsavedChangesPrompt,
  useWorkspace,
} from "./useWorkspace";
import { renderHook } from "@testing-library/react";

vi.mock("../api/endpoints", () => ({
  api: {
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    workspace: vi.fn(),
    workspaces: vi.fn(),
    deleteWorkspace: vi.fn(),
  },
}));
vi.mock("../graph/cyRegistry", () => ({
  getMainCy: vi.fn(() => null),
  setMainCy: vi.fn(),
  getTxCy: vi.fn(() => null),
  registerTxCy: vi.fn(),
  getCallCy: vi.fn(() => null),
}));
const m = vi.mocked(api);

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const g = () => useGraph.getState();
const VP = { zoom: 1.5, pan: { x: 10, y: -20 } };
const dto = (over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id: 7,
  name: "w",
  schema_version: 1,
  state: {},
  created_at: "2026-01-01T00:00:00.000001Z",
  updated_at: "2026-01-01T00:00:00.000001Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasMetrics.getState().set({ width: 960, height: 576, visible: 0 });
  g().reset();
  useWorkspace.getState().clear();
});

/** Top-k centers, as in a workspace saved before picks existed: they keep a limit through a save and a reopen. */
const topK = (addrs: string[]) => g().loadSnapshot({ centers: addrs, filter: {}, expandedPairs: [], ui: {} });

describe("serialize", () => {
  test("serialize/deserialize round-trip", () => {
    g().setCenters([A]);
    g().applyPicks({ [A]: [B] });
    g().togglePair(A, B);
    g().applyFilter({ direction: "in" }, "count");
    g().setPinned([B], true);
    g().setNote(B, "hi");
    g().setPositions({ [A]: { x: 1, y: 2 } });
    const s = serialize(g(), VP, { nodes: [A, B], positions: { [B]: { x: 5, y: 6 } } });
    expect(s.expanded_pairs).toEqual([[A, B]]);
    expect(s.nodes.find((n) => n.address === A)).toMatchObject({ x: 1, y: 2 });
    expect(s.nodes.find((n) => n.address === B)).toMatchObject({ x: 5, y: 6, pinned: true, note: "hi" });
    expect(s.picks).toEqual({ [A]: [B] });
    const r = deserialize(JSON.parse(JSON.stringify(s)), 1);
    expect(r).toEqual({ ok: true, state: { graph: s, tabs: [], active: "graph" } });
  });

  test("only canvas nodes and flagged nodes are included", () => {
    g().setCenters([A]);
    g().setPositions({ [B]: { x: 1, y: 1 } }); // dragged earlier, no longer on canvas
    const s = serialize(g(), VP, { nodes: [] });
    expect(s.nodes.map((n) => n.address)).toEqual([A]);
  });

  test("deserialize rejects unknown schema_version and malformed state", () => {
    const good = serialize(g(), VP);
    expect(deserialize(good, 3).ok).toBe(false);
    expect(deserialize(good, 2).ok).toBe(false); // a v1 state is not a v2 one
    expect(deserialize(null, 1).ok).toBe(false);
    expect(deserialize({ ...good, centers: [1] }, 1).ok).toBe(false);
    expect(deserialize({ ...good, viewport: { zoom: NaN, pan: { x: 0, y: 0 } } }, 1).ok).toBe(false);
    expect(deserialize({ ...good, expanded_pairs: [["x"]] }, 1).ok).toBe(false);
    expect(
      deserialize({ ...good, nodes: [{ address: A, pinned: "yes", hidden: false, note: "" }] }, 1).ok,
    ).toBe(false);
  });
});

describe("saving", () => {
  test("save without id creates, with id updates with expected_updated_at", async () => {
    g().setCenters([A]);
    m.createWorkspace.mockResolvedValue(dto({ updated_at: "T1" }));
    await saveNew("w");
    expect(m.createWorkspace).toHaveBeenCalledWith({
      name: "w",
      schema_version: 2,
      state: { graph: expect.objectContaining({ centers: [A] }), tabs: [], active: "graph" },
    });
    expect(useWorkspace.getState()).toMatchObject({ id: 7, name: "w", updatedAt: "T1", dirty: false });

    m.updateWorkspace.mockResolvedValue(dto({ updated_at: "T2" }));
    await expect(saveCurrent()).resolves.toBe("saved");
    expect(m.updateWorkspace).toHaveBeenCalledWith(7, {
      name: "w",
      schema_version: 2,
      state: expect.any(Object),
      expected_updated_at: "T1",
    });
    expect(useWorkspace.getState().updatedAt).toBe("T2");
  });

  test("409 reports conflict; overwrite refetches updated_at then saves", async () => {
    useWorkspace.getState().setCurrent(dto({ updated_at: "T1" }));
    m.updateWorkspace.mockRejectedValueOnce(new ApiError("conflict", 409, "x"));
    await expect(saveCurrent()).resolves.toBe("conflict");
    expect(useWorkspace.getState().updatedAt).toBe("T1");

    m.workspace.mockResolvedValue(dto({ updated_at: "T9" }));
    m.updateWorkspace.mockResolvedValueOnce(dto({ updated_at: "T10" }));
    await overwriteCurrent();
    expect(m.workspace).toHaveBeenCalledWith(7);
    expect(m.updateWorkspace).toHaveBeenLastCalledWith(7, expect.objectContaining({ expected_updated_at: "T9" }));
    expect(useWorkspace.getState().updatedAt).toBe("T10");
  });

  test("dirty flag set after a store change and cleared after save", async () => {
    useWorkspace.getState().setCurrent(dto());
    expect(useWorkspace.getState().dirty).toBe(false);
    g().select({ kind: "node", address: A });
    g().setHighlightTransfer({ from: A, to: B, asset: null });
    expect(useWorkspace.getState().dirty).toBe(false);
    g().addCenter(A);
    expect(useWorkspace.getState().dirty).toBe(true);
    m.updateWorkspace.mockResolvedValue(dto({ updated_at: "T2" }));
    await saveCurrent();
    expect(useWorkspace.getState().dirty).toBe(false);
  });
});

describe("loading", () => {
  test("opening or starting a workspace closes the views stacked over the graph panel", async () => {
    const state = serialize((g().setCenters([A]), g()), VP, { nodes: [A], positions: {} });
    m.workspace.mockResolvedValue(dto({ state: JSON.parse(JSON.stringify(state)) }));
    useInfo.setState({ stacks: { graph: [{ kind: "asset", asset: null }] } });
    await loadWorkspace(7);
    expect(useInfo.getState().stacks["graph"]).toEqual([]);
    useInfo.setState({ stacks: { graph: [{ kind: "asset", asset: null }] } });
    newWorkspace();
    expect(useInfo.getState().stacks["graph"]).toEqual([]);
  });

  test("restores the store without history; unknown version leaves canvas untouched", async () => {
    const state = serialize(
      (g().setCenters([A]), g().togglePair(A, B), g().setHidden([B], true), g()),
      VP,
      { nodes: [A, B], positions: { [A]: { x: 3, y: 4 } } },
    );
    g().reset();
    g().addCenter(B);
    m.workspace.mockResolvedValue(dto({ state: JSON.parse(JSON.stringify(state)), updated_at: "T5" }));
    await expect(loadWorkspace(7)).resolves.toBe(true);
    expect(g().centers).toEqual([A]);
    expect(g().ui[B]?.hidden).toBe(true);
    expect(g().ui[A]?.pos).toEqual({ x: 3, y: 4 });
    expect(g().expandedPairs.size).toBe(1);
    expect(g().canUndo()).toBe(false);
    expect(useWorkspace.getState()).toMatchObject({ id: 7, updatedAt: "T5", dirty: false });

    m.workspace.mockResolvedValue(dto({ id: 8, schema_version: 3 }));
    await expect(loadWorkspace(8)).resolves.toBe(false);
    expect(g().centers).toEqual([A]);
    expect(useWorkspace.getState().id).toBe(7);
  });
});

describe("opening from a tx tab", () => {
  test("switches to the graph tab before restoring the canvas", async () => {
    const H = "0x" + "1".repeat(64);
    useTabs.setState({ tabs: [{ id: "graph" }, { id: H, kind: "tx", hash: H }], active: H });
    let activeAtRestore: string | null = null;
    const unsub = useGraph.subscribe((s, p) => {
      if (s.centers !== p.centers) activeAtRestore = useTabs.getState().active;
    });
    const state = serialize((g().setCenters([A]), g()), VP, { nodes: [A], positions: {} });
    g().reset();
    m.workspace.mockResolvedValue(dto({ state: JSON.parse(JSON.stringify(state)) }));
    await loadWorkspace(7);
    unsub();
    expect(activeAtRestore).toBe("graph");
    expect(useTabs.getState().active).toBe("graph");
  });
});

describe("leaving the page", () => {
  test("beforeunload prompts only while the workspace is dirty", () => {
    const { unmount } = renderHook(() => useUnsavedChangesPrompt());
    const fire = () => {
      const ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(fire()).toBe(false);
    g().addCenter(A);
    expect(useWorkspace.getState().dirty).toBe(true);
    expect(fire()).toBe(true);
    unmount();
    expect(fire()).toBe(false);
  });
});

describe("sort persistence", () => {
  test("hide_suspicious round-trips through serialize/deserialize/load", async () => {
    topK([A]);
    g().applyFilter({ hide_suspicious: true, direction: "out" }, "count");
    const s = serialize(g(), VP);
    expect(s.filter).toEqual({ hide_suspicious: true, direction: "out" });
    expect(deserialize(JSON.parse(JSON.stringify(s)), 1)).toEqual({ ok: true, state: { graph: s, tabs: [], active: "graph" } });
    g().reset();
    m.workspace.mockResolvedValue(dto({ state: JSON.parse(JSON.stringify(s)) }));
    await loadWorkspace(7);
    expect(g().filter).toEqual({ hide_suspicious: true, direction: "out" });
  });

  test("a non-boolean hide_suspicious is rejected", () => {
    const s = serialize(g(), VP);
    expect(deserialize({ ...s, filter: { hide_suspicious: "yes" } }, 1).ok).toBe(false);
    expect(deserialize({ ...s, filter: { hide_suspicious: null } }, 1).ok).toBe(true);
  });

  test("sort round-trips through serialize/deserialize/load", async () => {
    topK([A]);
    g().applyFilter({}, "recent");
    const s = serialize(g(), VP);
    expect(s.sort).toBe("recent");
    expect(deserialize(JSON.parse(JSON.stringify(s)), 1)).toEqual({ ok: true, state: { graph: s, tabs: [], active: "graph" } });
    g().reset();
    m.workspace.mockResolvedValue(dto({ state: JSON.parse(JSON.stringify(s)) }));
    await loadWorkspace(7);
    expect(g().sort).toBe("recent");
  });

  test("a state without sort loads as count; an invalid sort is rejected", async () => {
    const { sort: _omit, ...legacy } = serialize(g(), VP);
    expect(deserialize(legacy, 1).ok).toBe(true);
    expect(deserialize({ ...legacy, sort: "bogus" }, 1).ok).toBe(false);
    g().applyFilter({}, "amount");
    m.workspace.mockResolvedValue(dto({ state: legacy as never }));
    await loadWorkspace(7);
    expect(g().sort).toBe("count");
  });
});

describe("viewport restore", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(getMainCy).mockReturnValue(null);
  });

  test("a superseded restore never applies its viewport", async () => {
    vi.useFakeTimers();
    const viewport = vi.fn();
    vi.mocked(getMainCy).mockReturnValue({
      getElementById: () => ({ nonempty: () => true }),
      viewport,
    } as never);
    const st = (zoom: number) => {
      g().setCenters([A]);
      const s = serialize(g(), { zoom, pan: { x: 0, y: 0 } }, { nodes: [A] });
      return JSON.parse(JSON.stringify(s));
    };
    m.workspace.mockResolvedValueOnce(dto({ state: st(2) })).mockResolvedValueOnce(dto({ state: st(3) }));
    await loadWorkspace(1);
    await loadWorkspace(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(viewport).toHaveBeenCalledTimes(1);
    expect(viewport).toHaveBeenCalledWith({ zoom: 3, pan: { x: 0, y: 0 } });
  });

  test("waits until a restored node is on the canvas", async () => {
    vi.useFakeTimers();
    const viewport = vi.fn();
    let present = false;
    vi.mocked(getMainCy).mockReturnValue({
      getElementById: () => ({ nonempty: () => present }),
      viewport,
    } as never);
    g().setCenters([A]);
    const state = JSON.parse(JSON.stringify(serialize(g(), VP, { nodes: [A] })));
    m.workspace.mockResolvedValue(dto({ state }));
    await loadWorkspace(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(viewport).not.toHaveBeenCalled();
    present = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(viewport).toHaveBeenCalledWith(VP);
  });
});

describe("dirty edge cases", () => {
  test("save keeps dirty when the graph changed while the request was in flight", async () => {
    useWorkspace.getState().setCurrent(dto());
    g().addCenter(A);
    m.updateWorkspace.mockImplementation(async () => {
      g().addCenter(B);
      return dto({ updated_at: "T2" });
    });
    await saveCurrent();
    expect(useWorkspace.getState()).toMatchObject({ updatedAt: "T2", dirty: true });
  });

  test("deleting the current workspace leaves a dirty canvas iff it is non-empty", async () => {
    m.deleteWorkspace.mockResolvedValue(undefined);
    useWorkspace.getState().setCurrent(dto());
    await deleteWorkspace(7);
    expect(useWorkspace.getState()).toMatchObject({ id: null, dirty: false });
    g().addCenter(A);
    useWorkspace.getState().setCurrent(dto());
    await deleteWorkspace(7);
    expect(useWorkspace.getState()).toMatchObject({ id: null, dirty: true });
  });
});

describe("workspace copy", () => {
  test("saveStatusLabel reads in English by default", () => {
    expect(saveStatusLabel({ id: null, dirty: false })).toBe("Not saved");
    expect(saveStatusLabel({ id: 1, dirty: true })).toBe("Unsaved changes");
    expect(saveStatusLabel({ id: 1, dirty: false })).toBe("Saved");
  });
  test("deserialize failure reasons are English", () => {
    expect(deserialize(null, 1)).toEqual({ ok: false, reason: "Invalid workspace data" });
    expect(deserialize({}, 3)).toEqual({ ok: false, reason: "Unsupported workspace version" });
  });
});

describe("limits", () => {
  test("serialize writes the limits of centers only and they load back", async () => {
    g().loadSnapshot({ centers: [A, B], filter: {}, expandedPairs: [], ui: {}, limits: { [A]: 34, [B]: 29 } });
    g().removeCenter(B);
    const s = serialize(g(), VP);
    expect(s.limits).toEqual({ [A]: 34 });
    g().reset();
    m.workspace.mockResolvedValue(dto({ state: JSON.parse(JSON.stringify(s)) }));
    await expect(loadWorkspace(7)).resolves.toBe(true);
    expect(g().limits).toEqual({ [A]: 34 });
  });

  test("an old state without limits loads and every center gets a first batch", async () => {
    topK([A, B]);
    const { limits: _omit, ...legacy } = serialize(g(), VP);
    g().reset();
    const r = deserialize(JSON.parse(JSON.stringify(legacy)), 1);
    expect(r.ok && r.state.graph.limits).toEqual({ [A]: 29, [B]: 29 });
    m.workspace.mockResolvedValue(dto({ state: legacy as never }));
    await expect(loadWorkspace(7)).resolves.toBe(true);
    expect(g().limits).toEqual({ [A]: 29, [B]: 29 });
  });

  test("legacy centers share the budget over an empty canvas, ignoring the nodes now visible (R12)", () => {
    useCanvasMetrics.getState().set({ visible: 40 });
    const r = deserialize({ ...serialize((topK([A, B]), g()), VP), limits: undefined }, 1);
    expect(r.ok && r.state.graph.limits).toEqual({ [A]: 29, [B]: 29 }); // (60 - 2) / 2, not (20 - 2) / 2
  });

  test("centers missing from limits get a first batch", () => {
    topK([A, B]);
    const s = { ...serialize(g(), VP), limits: { [A]: 12 } };
    const r = deserialize(JSON.parse(JSON.stringify(s)), 1);
    expect(r.ok && r.state.graph.limits).toEqual({ [A]: 12, [B]: 59 });
  });

  test("malformed limits are rejected with a translated reason", async () => {
    const good = serialize((g().setCenters([A]), g()), VP);
    expect(deserialize({ ...good, limits: "bad" }, 1)).toEqual({ ok: false, reason: "Invalid limits" });
    expect(deserialize({ ...good, limits: [5] }, 1).ok).toBe(false);
    expect(deserialize({ ...good, limits: { [A]: "5" } }, 1).ok).toBe(false);
    expect(deserialize({ ...good, limits: { [A]: 0 } }, 1).ok).toBe(false);
    expect(deserialize({ ...good, limits: { [A]: 2.5 } }, 1).ok).toBe(false);
    g().reset();
    m.workspace.mockResolvedValue(dto({ state: { ...good, limits: "bad" } as never }));
    await expect(loadWorkspace(7)).resolves.toBe(false);
    expect(g().centers).toEqual([]);
  });

  test("a limit change marks the workspace dirty", () => {
    g().setCenters([A]);
    useWorkspace.getState().setCurrent(dto());
    useGraph.setState({ limits: { [A]: 3 } });
    expect(useWorkspace.getState().dirty).toBe(true);
  });
});

describe("picks", () => {
  const C = "0x" + "c".repeat(40);
  const reopen = async (s: unknown) => {
    g().reset();
    m.workspace.mockResolvedValue(dto({ state: JSON.parse(JSON.stringify(s)) }));
    await expect(loadWorkspace(7)).resolves.toBe(true);
  };

  test("picks_round_trip", async () => {
    g().setCenters([A, B]);
    g().applyPicks({ [A]: [B, C] }); // B stays picked with none
    const s = serialize(g(), VP);
    expect(s.picks).toEqual({ [A]: [B, C], [B]: [] });
    expect(s.limits).toEqual({});
    await reopen(s);
    expect(g().picks).toEqual({ [A]: [B, C], [B]: [] });
    expect(g().limits).toEqual({}); // picked centers get no first batch
  });

  test("old_state_without_picks_opens_with_top_k_centers", async () => {
    topK([A, B]);
    const { picks: _omit, ...legacy } = serialize(g(), VP);
    expect(_omit).toBeUndefined();
    const r = deserialize(JSON.parse(JSON.stringify(legacy)), 1);
    expect(r.ok && r.state.graph.picks).toBeUndefined();
    await reopen(legacy);
    expect(g().picks).toEqual({});
    expect(g().limits).toEqual({ [A]: 29, [B]: 29 });
  });

  test("keys and values are lowercased on load", () => {
    g().setCenters([A]);
    const s = { ...serialize(g(), VP), picks: { ["0x" + "A".repeat(40)]: ["0x" + "B".repeat(40)] } };
    const r = deserialize(JSON.parse(JSON.stringify(s)), 1);
    expect(r.ok && r.state.graph.picks).toEqual({ [A]: [B] });
  });

  test("bad_picks_are_rejected", () => {
    const good = serialize((g().setCenters([A]), g()), VP);
    expect(deserialize({ ...good, picks: { [A]: [42] } }, 1)).toEqual({ ok: false, reason: "Invalid picks" });
    expect(deserialize({ ...good, picks: { junk: [B] } }, 1).ok).toBe(false);
    expect(deserialize({ ...good, picks: { [A]: ["junk"] } }, 1).ok).toBe(false);
    expect(deserialize({ ...good, picks: { [A]: B } }, 1).ok).toBe(false);
    expect(deserialize({ ...good, picks: [B] }, 1).ok).toBe(false);
  });

  test("picks_of_removed_centers_are_not_written", () => {
    g().setCenters([A, B]);
    g().applyPicks({ [A]: [C], [B]: [C] });
    g().removeCenter(B);
    expect(serialize(g(), VP).picks).toEqual({ [A]: [C] });
    g().removeCenter(A);
    expect("picks" in serialize(g(), VP)).toBe(false);
  });

  test("reopened_workspace_requests_the_same_picks", async () => {
    g().setCenters([A, B]);
    g().applyPicks({ [A]: [C] });
    const key = graphQueryKey(g());
    const s = serialize(g(), VP);
    await reopen(s);
    expect(graphQueryKey(g())).toEqual(key);
    expect(JSON.stringify(key)).toContain(JSON.stringify({ [A]: [C], [B]: [] }));
  });

  test("a picks-only change marks the workspace dirty", () => {
    g().setCenters([A]);
    useWorkspace.getState().setCurrent(dto());
    expect(useWorkspace.getState().dirty).toBe(false);
    useGraph.setState({ picks: { [A]: [B] } }); // nothing else changes
    expect(useWorkspace.getState().dirty).toBe(true);
  });
});

describe("proxy positions", () => {
  const P = { x: 3, y: 4 };
  const Q = { x: 1, y: 1 };
  const MIXED = "0x" + "A".repeat(40);

  test("serialize writes the proxies of centers only; none means no field; round-trips", () => {
    topK([A]);
    g().setPositions({ [`more:${A}`]: P, [`more:${B}`]: Q });
    const s = serialize(g(), VP);
    expect(s.proxies).toEqual({ [A]: P });
    expect(deserialize(JSON.parse(JSON.stringify(s)), 1)).toEqual({ ok: true, state: { graph: s, tabs: [], active: "graph" } });
    g().clearProxyPositions();
    expect("proxies" in serialize(g(), VP)).toBe(false);
  });

  test("deserialize rejects malformed proxies, accepts their absence, lowercases keys", () => {
    const good = serialize((g().setCenters([A]), g()), VP);
    const r = deserialize({ ...good, proxies: { [A]: { x: "1", y: 2 } } }, 1);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("proxies");
    expect(deserialize(good, 1).ok).toBe(true);
    const ok = deserialize({ ...good, proxies: { [MIXED]: P } }, 1);
    expect(ok.ok && ok.state.graph.proxies).toEqual({ [A]: P });
  });

  test("opening a saved state restores the proxy positions of its centers", async () => {
    const s = { ...serialize((g().setCenters([A]), g()), VP), proxies: { [MIXED]: P, [B]: Q } };
    g().reset();
    m.workspace.mockResolvedValue(dto({ state: JSON.parse(JSON.stringify(s)) }));
    await expect(loadWorkspace(7)).resolves.toBe(true);
    expect(g().proxyPos).toEqual({ [A]: P });
  });

  test("moving a proxy marks the workspace dirty", async () => {
    g().setCenters([A]);
    m.createWorkspace.mockResolvedValue(dto());
    await saveNew("w");
    expect(useWorkspace.getState().dirty).toBe(false);
    g().setPositions({ [`more:${A}`]: { x: 9, y: 9 } });
    expect(useWorkspace.getState().dirty).toBe(true);
  });
});

describe("hidden proxies", () => {
  const MIXED = "0x" + "A".repeat(40);

  test("hidden_proxies round-trips and drops non-centers", async () => {
    g().setCenters([A, B]);
    g().setProxiesHidden([A, B], true);
    g().removeCenter(B);
    // A stale entry (no longer a center) is not written.
    useGraph.setState({ hiddenProxies: [A, B] });
    const s = serialize(g(), VP);
    expect(s.hidden_proxies).toEqual([A]);
    expect(deserialize(JSON.parse(JSON.stringify(s)), 1)).toEqual({ ok: true, state: { graph: s, tabs: [], active: "graph" } });
    g().setProxiesHidden([A], false);
    expect("hidden_proxies" in serialize(g(), VP)).toBe(false);

    const bad = deserialize({ ...s, hidden_proxies: [1] }, 1);
    expect(!bad.ok && bad.reason).toContain("hidden_proxies");
    const saved = { ...s, hidden_proxies: [MIXED, B] };
    g().reset();
    m.workspace.mockResolvedValue(dto({ state: JSON.parse(JSON.stringify(saved)) }));
    await expect(loadWorkspace(7)).resolves.toBe(true);
    expect(g().hiddenProxies).toEqual([A]);
  });

  test("a workspace without hidden_proxies loads with none hidden", async () => {
    g().setCenters([A]);
    const s = serialize(g(), VP);
    expect("hidden_proxies" in s).toBe(false);
    useGraph.setState({ hiddenProxies: [A] });
    m.workspace.mockResolvedValue(dto({ state: JSON.parse(JSON.stringify(s)) }));
    await expect(loadWorkspace(7)).resolves.toBe(true);
    expect(g().hiddenProxies).toEqual([]);
  });

  test("hiding a proxy marks the workspace dirty", async () => {
    g().setCenters([A]);
    m.createWorkspace.mockResolvedValue(dto());
    await saveNew("w");
    expect(useWorkspace.getState().dirty).toBe(false);
    g().setProxiesHidden([A], true);
    expect(useWorkspace.getState().dirty).toBe(true);
  });
});
