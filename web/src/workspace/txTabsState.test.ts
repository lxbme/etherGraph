import cytoscape from "cytoscape";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/endpoints";
import type { WorkspaceDto } from "../api/generated/WorkspaceDto";
import { useCanvasMetrics } from "../graph/canvasMetrics";
import { getTxCy } from "../graph/cyRegistry";
import { useGraph } from "../graph/store";
import { useTabs } from "../shell/tabs";
import { deserialize, serialize, type WorkspaceStateV2 } from "./serialize";
import {
  captureState,
  loadWorkspace,
  markTxLayoutChanged,
  newWorkspace,
  overwriteCurrent,
  renameCurrent,
  saveCurrent,
  saveNew,
  useWorkspace,
} from "./useWorkspace";

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
}));
const m = vi.mocked(api);

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const H1 = "0x" + "1".repeat(64);
const H2 = "0x" + "2".repeat(64);
const H3 = "0x" + "3".repeat(64);
const VP = { zoom: 1.5, pan: { x: 10, y: -20 } };
const g = () => useGraph.getState();
const dto = (over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id: 7,
  name: "w",
  schema_version: 2,
  state: {},
  created_at: "2026-01-01T00:00:00.000001Z",
  updated_at: "2026-01-01T00:00:00.000001Z",
  ...over,
});
const txTab = (hash: string, extra: object = {}) => ({ id: hash, kind: "tx" as const, hash, ...extra });
/** A headless canvas with these node positions and viewport. */
function canvas(positions: Record<string, { x: number; y: number }>, vp: { zoom: number; pan: { x: number; y: number } }) {
  const cy = cytoscape({ headless: true });
  for (const [id, position] of Object.entries(positions)) cy.add({ group: "nodes", data: { id }, position });
  cy.viewport(vp);
  return cy;
}
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const v1 = () => json(serialize((g().setCenters([A]), g()), VP, { nodes: [A] }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTxCy).mockReturnValue(null);
  useCanvasMetrics.getState().set({ width: 960, height: 576, visible: 0 });
  g().reset();
  useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
  useWorkspace.getState().clear();
});

describe("schema versions", () => {
  test("a v1 state loads as the graph with no tx tabs", async () => {
    const graph = v1();
    expect(deserialize(graph, 1)).toEqual({ ok: true, state: { graph, tabs: [], active: "graph" } });

    useTabs.setState({ tabs: [{ id: "graph" }, txTab(H1)], active: H1 });
    g().reset();
    m.workspace.mockResolvedValue(dto({ schema_version: 1, state: graph as never }));
    await expect(loadWorkspace(7)).resolves.toBe(true);
    expect(useTabs.getState()).toEqual(expect.objectContaining({ tabs: [{ id: "graph" }], active: "graph" }));
    expect(g().centers).toEqual([A]);
  });

  test("unknown versions and malformed v2 states are rejected", () => {
    const good: WorkspaceStateV2 = { graph: v1(), tabs: [{ hash: H1 }], active: H1 };
    expect(deserialize(good, 2).ok).toBe(true);
    expect(deserialize(good, 3)).toEqual({ ok: false, reason: "Unsupported workspace version" });
    const bad = (v: unknown) => deserialize(v, 2).ok;
    expect(bad(null)).toBe(false);
    expect(bad({ ...good, graph: undefined })).toBe(false);
    expect(bad({ ...good, graph: { ...good.graph, centers: [1] } })).toBe(false);
    expect(bad({ ...good, tabs: {} })).toBe(false);
    expect(bad({ ...good, tabs: [{ hash: "0x12" }], active: "graph" })).toBe(false);
    expect(bad({ ...good, tabs: [{ hash: H1 }, { hash: H1 }] })).toBe(false);
    expect(bad({ ...good, tabs: [{ hash: H1, detail_tab: "nope" }] })).toBe(false);
    expect(bad({ ...good, tabs: [{ hash: H1, positions: { [A]: { x: "1", y: 2 } } }] })).toBe(false);
    expect(bad({ ...good, tabs: [{ hash: H1, positions: [] }] })).toBe(false);
    expect(bad({ ...good, tabs: [{ hash: H1, viewport: { zoom: 0, pan: { x: 0 } } }] })).toBe(false);
    expect(bad({ ...good, active: H2 })).toBe(false);
    expect(bad({ ...good, active: 1 })).toBe(false);
  });

  test("hashes load lowercased", () => {
    const upper = "0x" + "AB".repeat(32);
    const r = deserialize({ graph: v1(), tabs: [{ hash: upper }], active: upper }, 2);
    expect(r.ok && r.state.tabs[0]!.hash).toBe(upper.toLowerCase());
    expect(r.ok && r.state.active).toBe(upper.toLowerCase());
  });
});

describe("tx tabs round-trip", () => {
  test("two tabs with positions, viewport, detail tab and the active tab save and open again", async () => {
    g().setCenters([A]);
    useTabs.setState({ tabs: [{ id: "graph" }, txTab(H1, { detailTab: "logs" }), txTab(H2)], active: H2 });
    const cys = {
      [H1]: canvas({ [A]: { x: 1, y: 2 }, [B]: { x: 3, y: 4 } }, { zoom: 2, pan: { x: 5, y: 6 } }),
      [H2]: canvas({ [B]: { x: 7, y: 8 } }, { zoom: 0.5, pan: { x: -1, y: -2 } }),
    };
    vi.mocked(getTxCy).mockImplementation((h) => cys[h] ?? null);
    m.createWorkspace.mockResolvedValue(dto());
    await saveNew("w");
    const body = m.createWorkspace.mock.calls[0]![0];
    expect(body.schema_version).toBe(2);
    const tabs = [
      { hash: H1, detail_tab: "logs", positions: { [A]: { x: 1, y: 2 }, [B]: { x: 3, y: 4 } }, viewport: { zoom: 2, pan: { x: 5, y: 6 } } },
      { hash: H2, positions: { [B]: { x: 7, y: 8 } }, viewport: { zoom: 0.5, pan: { x: -1, y: -2 } } },
    ];
    expect(body.state).toEqual({ graph: expect.objectContaining({ centers: [A] }), tabs, active: H2 });
    const saved = json(body.state) as unknown as WorkspaceStateV2;
    expect(deserialize(saved, 2)).toEqual({ ok: true, state: saved });

    // Opening replaces whatever tx tabs are open with the saved ones, each with its layout.
    g().reset();
    useTabs.setState({ tabs: [{ id: "graph" }, txTab(H3)], active: H3 });
    m.workspace.mockResolvedValue(dto({ state: saved as never, updated_at: "T5" }));
    await expect(loadWorkspace(7)).resolves.toBe(true);
    const { tabs: open, active } = useTabs.getState();
    expect(active).toBe(H2);
    expect(open.map((t) => t.id)).toEqual(["graph", H1, H2]);
    expect(open[1]).toMatchObject({ kind: "tx", hash: H1, detailTab: "logs", layout: { positions: tabs[0]!.positions, viewport: tabs[0]!.viewport } });
    expect(open[2]).toMatchObject({ kind: "tx", hash: H2, layout: { positions: tabs[1]!.positions, viewport: tabs[1]!.viewport } });
    expect(open[2]).not.toHaveProperty("detailTab");
    expect(g().centers).toEqual([A]);
    expect(useWorkspace.getState()).toMatchObject({ id: 7, updatedAt: "T5", dirty: false });
  });

  test("snapshots are carried through unchanged: the graph opens frozen, the tab keeps its snapshot", async () => {
    const meta = { exported_at: "2026-10-01T12:00:00Z", includes: { labels: true, notes: false } };
    const node = {
      address: B, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [], partial: false,
      syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null,
    };
    const snap = { ...meta, flow: { tx: { hash: H1 }, nodes: [node], flows: [], events: [] }, raw: null };
    const graphSnap = { ...meta, data: { nodes: [node], edges: [], omitted: {}, coverage: {} } };
    const state = { graph: { ...v1(), snapshot: graphSnap }, tabs: [{ hash: H1, snapshot: snap }], active: "graph" };
    expect(deserialize(json(state), 2)).toEqual({ ok: true, state });
    m.workspace.mockResolvedValue(dto({ state: json(state) as never }));
    await loadWorkspace(7);
    expect(g().frozen).toEqual(graphSnap);
    const saved = captureState();
    expect(saved.tabs).toEqual([{ hash: H1, snapshot: snap }]);
    expect(saved.graph.snapshot).toEqual(graphSnap);
    // A live graph saves no snapshot.
    g().unfreeze();
    expect(captureState().graph).not.toHaveProperty("snapshot");
  });

  test("malformed snapshots are rejected", () => {
    const state = { graph: { ...v1(), snapshot: { edges: ["e"] } }, tabs: [], active: "graph" };
    expect(deserialize(json(state), 2)).toMatchObject({ ok: false });
    const tab = { graph: v1(), tabs: [{ hash: H1, snapshot: { flow: {} } }], active: "graph" };
    expect(deserialize(json(tab), 2)).toMatchObject({ ok: false });
  });

  test("a tab whose canvas is not live keeps its saved layout; a hidden canvas keeps the saved viewport", async () => {
    const layout = { positions: { [A]: { x: 1, y: 2 } }, viewport: { zoom: 3, pan: { x: 4, y: 5 } } };
    const state = { graph: v1(), tabs: [{ hash: H1, ...layout }], active: H1 };
    m.workspace.mockResolvedValue(dto({ state: json(state) as never }));
    await loadWorkspace(7);
    expect(captureState().tabs).toEqual([{ hash: H1, ...layout }]);

    // A canvas measured while hidden has no size: its viewport means nothing, the node positions do.
    const cy = canvas({ [A]: { x: 9, y: 9 } }, { zoom: 0.05, pan: { x: 0, y: 0 } });
    vi.spyOn(cy, "width").mockReturnValue(0);
    vi.mocked(getTxCy).mockReturnValue(cy);
    expect(captureState().tabs).toEqual([{ hash: H1, positions: { [A]: { x: 9, y: 9 } }, viewport: layout.viewport }]);
  });
});

describe("saving sends the schema version", () => {
  test("save, overwrite send 2; rename keeps the stored version", async () => {
    useWorkspace.getState().setCurrent(dto({ updated_at: "T1" }));
    m.updateWorkspace.mockResolvedValue(dto({ updated_at: "T2" }));
    await saveCurrent();
    expect(m.updateWorkspace).toHaveBeenLastCalledWith(7, expect.objectContaining({ schema_version: 2 }));
    m.workspace.mockResolvedValue(dto({ updated_at: "T3" }));
    await overwriteCurrent();
    expect(m.updateWorkspace).toHaveBeenLastCalledWith(7, expect.objectContaining({ schema_version: 2 }));

    m.workspace.mockResolvedValue(dto({ schema_version: 1, state: { old: true } }));
    await renameCurrent("x");
    expect(m.updateWorkspace).toHaveBeenLastCalledWith(7, expect.objectContaining({ schema_version: 1, state: { old: true } }));
  });
});

describe("dirty (R3)", () => {
  const dirty = () => useWorkspace.getState().dirty;
  const saved = () => useWorkspace.getState().setCurrent(dto());

  test("opening and closing a tx tab and dragging a tx node mark dirty; the detail sub-tab and switching tabs do not", () => {
    saved();
    useTabs.getState().openTx(H1);
    expect(dirty()).toBe(true);

    saved();
    useTabs.getState().setDetailTab(H1, "logs");
    useTabs.getState().setHighlightedSeq(H1, 3);
    useTabs.getState().activate("graph");
    useTabs.getState().activate(H1);
    useTabs.getState().openTx(H1); // already open: only activates
    expect(dirty()).toBe(false);

    markTxLayoutChanged();
    expect(dirty()).toBe(true);

    saved();
    useTabs.getState().close(H1);
    expect(dirty()).toBe(true);
  });

  test("refreshing a snapshot (graph or tx tab) from the chain marks dirty", () => {
    const meta = { exported_at: "2026-10-01T12:00:00Z", includes: { labels: false, notes: false } };
    g().freeze({ ...meta, data: { nodes: [], edges: [], omitted: {}, coverage: {} } });
    useTabs.getState().restoreTx([{ hash: H1, snapshot: { ...meta, flow: {} as never, raw: null } }], "graph");
    saved();
    g().unfreeze();
    expect(dirty()).toBe(true);
    saved();
    useTabs.getState().refreshTx(H1);
    expect(dirty()).toBe(true);
    const tab = useTabs.getState().tabs[1];
    expect(tab && "kind" in tab ? tab.snapshot : "missing").toBeUndefined();
  });

  test("a tx tab opened while a save is in flight keeps the workspace dirty", async () => {
    saved();
    m.updateWorkspace.mockImplementation(async () => {
      useTabs.getState().openTx(H1);
      return dto({ updated_at: "T2" });
    });
    await saveCurrent();
    expect(useWorkspace.getState()).toMatchObject({ updatedAt: "T2", dirty: true });
  });
});

describe("new workspace", () => {
  test("closes every tx tab", () => {
    useTabs.setState({ tabs: [{ id: "graph" }, txTab(H1), txTab(H2)], active: H1 });
    newWorkspace();
    expect(useTabs.getState()).toEqual(expect.objectContaining({ tabs: [{ id: "graph" }], active: "graph" }));
    expect(useWorkspace.getState().dirty).toBe(false);
  });
});
