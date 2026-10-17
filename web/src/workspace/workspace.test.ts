import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { WorkspaceDto } from "../api/generated/WorkspaceDto";
import { getMainCy } from "../graph/cyRegistry";
import { useGraph } from "../graph/store";
import { useTabs } from "../shell/tabs";
import { deserialize, serialize } from "./serialize";
import { saveStatusLabel } from "./useWorkspace";
import {
  deleteWorkspace,
  loadWorkspace,
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
vi.mock("../graph/cyRegistry", () => ({ getMainCy: vi.fn(() => null), setMainCy: vi.fn() }));
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
  g().reset();
  useWorkspace.getState().clear();
});

describe("serialize", () => {
  test("serialize/deserialize round-trip", () => {
    g().setCenters([A]);
    g().togglePair(A, B);
    g().applyFilter({ direction: "in" }, "count");
    g().setPinned([B], true);
    g().setNote(B, "hi");
    g().setPositions({ [A]: { x: 1, y: 2 } });
    const s = serialize(g(), VP, { nodes: [A, B], positions: { [B]: { x: 5, y: 6 } } });
    expect(s.expanded_pairs).toEqual([[A, B]]);
    expect(s.nodes.find((n) => n.address === A)).toMatchObject({ x: 1, y: 2 });
    expect(s.nodes.find((n) => n.address === B)).toMatchObject({ x: 5, y: 6, pinned: true, note: "hi" });
    const r = deserialize(JSON.parse(JSON.stringify(s)), 1);
    expect(r).toEqual({ ok: true, state: s });
  });

  test("only canvas nodes and flagged nodes are included", () => {
    g().setCenters([A]);
    g().setPositions({ [B]: { x: 1, y: 1 } }); // dragged earlier, no longer on canvas
    const s = serialize(g(), VP, { nodes: [] });
    expect(s.nodes.map((n) => n.address)).toEqual([A]);
  });

  test("deserialize rejects unknown schema_version and malformed state", () => {
    const good = serialize(g(), VP);
    expect(deserialize(good, 2).ok).toBe(false);
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
      state: expect.objectContaining({ centers: [A] }),
    });
    expect(useWorkspace.getState()).toMatchObject({ id: 7, name: "w", updatedAt: "T1", dirty: false });

    m.updateWorkspace.mockResolvedValue(dto({ updated_at: "T2" }));
    await expect(saveCurrent()).resolves.toBe("saved");
    expect(m.updateWorkspace).toHaveBeenCalledWith(7, {
      name: "w",
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

    m.workspace.mockResolvedValue(dto({ id: 8, schema_version: 2 }));
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
  test("sort round-trips through serialize/deserialize/load", async () => {
    g().setCenters([A]);
    g().applyFilter({}, "recent");
    const s = serialize(g(), VP);
    expect(s.sort).toBe("recent");
    expect(deserialize(JSON.parse(JSON.stringify(s)), 1)).toEqual({ ok: true, state: s });
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
    expect(deserialize({}, 2)).toEqual({ ok: false, reason: "Unsupported workspace version" });
  });
});
