import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../api/endpoints";
import { ApiError, messageFor } from "../api/errors";
import type { WorkspaceDto } from "../api/generated/WorkspaceDto";
import type { JsonValue } from "../api/generated/serde_json/JsonValue";
import { t } from "../i18n";
import { getMainCy, getTxCy } from "../graph/cyRegistry";
import { isMoreId } from "../graph/elements";
import { restoreViewport } from "../graph/refit";
import { pairKey, useGraph, type NodeUi, type Pos } from "../graph/store";
import { useInfo } from "../panels/info/infoStore";
import { useTabs, type Tab, type TxTab, type TxTabInit } from "../shell/tabs";
import { toast } from "../shell/Toasts";
import {
  DEFAULT_VIEWPORT,
  deserialize,
  SCHEMA_VERSION,
  serialize,
  type TxTabStateV2,
  type WorkspaceStateV1,
  type WorkspaceStateV2,
} from "./serialize";

interface WorkspaceStore {
  id: number | null;
  name: string | null;
  updatedAt: string | null;
  dirty: boolean;
  setCurrent(w: Pick<WorkspaceDto, "id" | "name" | "updated_at">): void;
  markDirty(): void;
  clear(): void;
}

export const useWorkspace = create<WorkspaceStore>()((set) => ({
  id: null,
  name: null,
  updatedAt: null,
  dirty: false,
  setCurrent: (w) => set({ id: w.id, name: w.name, updatedAt: w.updated_at, dirty: false }),
  markDirty: () => set({ dirty: true }),
  clear: () => set({ id: null, name: null, updatedAt: null, dirty: false }),
}));

/** Bumped on every persisted graph change; lets a save notice edits made while it was in flight. */
let graphVersion = 0;
/** Bumped whenever the canvas is replaced; stale viewport restores bail out. */
let restoreGen = 0;

// Any change to the persisted part of the graph store marks the workspace dirty (selection/highlight excluded).
useGraph.subscribe((s, prev) => {
  if (
    s.centers !== prev.centers ||
    s.filter !== prev.filter ||
    s.sort !== prev.sort ||
    s.expandedPairs !== prev.expandedPairs ||
    s.ui !== prev.ui ||
    s.limits !== prev.limits ||
    s.proxyPos !== prev.proxyPos ||
    s.frozen !== prev.frozen
  ) {
    graphVersion++;
    useWorkspace.getState().markDirty();
  }
});

const isTx = (t: Tab): t is TxTab => "kind" in t;
const txIds = (tabs: Tab[]) => tabs.flatMap((t) => (isTx(t) ? [t.id] : [])).join(",");
/** The tx tabs showing a snapshot. */
const frozenTxIds = (tabs: Tab[]) => tabs.flatMap((t) => (isTx(t) && t.snapshot !== undefined ? [t.id] : [])).join(",");

/** Marks the workspace changed (a persisted part of it moved on). */
function noteChange(): void {
  graphVersion++;
  useWorkspace.getState().markDirty();
}

// Opening or closing a tx tab, or refreshing its snapshot, marks the workspace dirty; its detail section,
// highlight or switching tabs do not (R3).
useTabs.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return;
  if (txIds(s.tabs) !== txIds(prev.tabs) || frozenTxIds(s.tabs) !== frozenTxIds(prev.tabs)) noteChange();
});

/** A tx tab's nodes were dragged. */
export function markTxLayoutChanged(): void {
  noteChange();
}

/** Asks the browser to confirm leaving the page while the workspace has unsaved changes. */
export function useUnsavedChangesPrompt(): void {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!useWorkspace.getState().dirty) return;
      e.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}

export function saveStatusLabel(w: Pick<WorkspaceStore, "id" | "dirty">): string {
  if (w.id == null) return t("ws.status.unsaved");
  return w.dirty ? t("ws.status.dirty") : t("ws.status.saved");
}

/** The graph and every open tx tab, with layouts read from the live canvases. */
export function captureState(): WorkspaceStateV2 {
  const { tabs, active } = useTabs.getState();
  return { graph: captureGraph(), tabs: tabs.filter(isTx).map(captureTab), active };
}

/**
 * A tx tab with its canvas's node positions and viewport; a canvas not showing the flow yet keeps the
 * layout the tab was restored with, and one without a size (laid out while hidden) its saved viewport.
 */
function captureTab(tab: TxTab): TxTabStateV2 {
  let { positions, viewport } = tab.layout ?? {};
  const cy = getTxCy(tab.hash);
  if (cy && cy.nodes().nonempty()) {
    const live: Record<string, Pos> = {};
    cy.nodes().forEach((n) => {
      const p = n.position();
      live[n.id()] = { x: p.x, y: p.y };
    });
    positions = live;
    if (cy.width() > 0 && cy.height() > 0) viewport = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  }
  return {
    hash: tab.hash,
    ...(tab.detailTab ? { detail_tab: tab.detailTab } : {}),
    ...(positions ? { positions } : {}),
    ...(viewport ? { viewport } : {}),
    ...(tab.snapshot !== undefined ? { snapshot: tab.snapshot } : {}),
  };
}

/** Reads positions and viewport from the live Cytoscape instance (falls back to the store); a snapshot graph keeps its snapshot. */
function captureGraph(): WorkspaceStateV2["graph"] {
  const cy = getMainCy();
  const nodes: string[] = [];
  const positions: Record<string, Pos> = {};
  let viewport = DEFAULT_VIEWPORT;
  if (cy) {
    cy.nodes().forEach((n) => {
      if (isMoreId(n.id())) return; // "+N more" proxies are not nodes; their dragged positions are saved through `proxies`
      nodes.push(n.id());
      const p = n.position();
      positions[n.id()] = { x: p.x, y: p.y };
    });
    viewport = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  }
  const g = useGraph.getState();
  const state = serialize(g, viewport, { nodes, positions });
  return g.frozen ? { ...state, snapshot: g.frozen } : state;
}

const asJson = (s: WorkspaceStateV2) => s as unknown as JsonValue;

/** Marks saved, unless the graph changed while the request was in flight. */
function commitSaved(w: WorkspaceDto, versionAtSave: number): void {
  useWorkspace.getState().setCurrent(w);
  if (graphVersion !== versionAtSave) useWorkspace.getState().markDirty();
}

export async function saveNew(name: string): Promise<void> {
  const v = graphVersion;
  const w = await api.createWorkspace({ name, schema_version: SCHEMA_VERSION, state: asJson(captureState()) });
  commitSaved(w, v);
}

/** "Save as": a new workspace from the current canvas, which becomes the current one. */
export const saveAs = saveNew;

export async function saveCurrent(): Promise<"saved" | "conflict"> {
  const { id, name, updatedAt } = useWorkspace.getState();
  if (id == null || name == null || updatedAt == null) throw new Error("no current workspace");
  const v = graphVersion;
  try {
    const w = await api.updateWorkspace(id, {
      name,
      schema_version: SCHEMA_VERSION,
      state: asJson(captureState()),
      expected_updated_at: updatedAt,
    });
    commitSaved(w, v);
    return "saved";
  } catch (err) {
    if (err instanceof ApiError && err.code === "conflict") return "conflict";
    throw err;
  }
}

/** Resolves a conflict by taking the server's latest `updated_at` and saving over it. */
export async function overwriteCurrent(): Promise<void> {
  const { id, name } = useWorkspace.getState();
  if (id == null || name == null) throw new Error("no current workspace");
  const latest = await api.workspace(id);
  const v = graphVersion;
  const w = await api.updateWorkspace(id, {
    name,
    schema_version: SCHEMA_VERSION,
    state: asJson(captureState()),
    expected_updated_at: latest.updated_at,
  });
  commitSaved(w, v);
}

/** Renames without touching the saved state (the server's state is echoed back). */
export async function renameCurrent(name: string): Promise<"saved" | "conflict"> {
  const { id, updatedAt } = useWorkspace.getState();
  if (id == null || updatedAt == null) throw new Error("no current workspace");
  try {
    const cur = await api.workspace(id);
    const w = await api.updateWorkspace(id, {
      name,
      schema_version: cur.schema_version,
      state: cur.state,
      expected_updated_at: updatedAt,
    });
    const { dirty } = useWorkspace.getState();
    useWorkspace.getState().setCurrent(w);
    if (dirty) useWorkspace.getState().markDirty();
    return "saved";
  } catch (err) {
    if (err instanceof ApiError && err.code === "conflict") return "conflict";
    throw err;
  }
}

export async function deleteWorkspace(id: number): Promise<void> {
  await api.deleteWorkspace(id);
  if (useWorkspace.getState().id === id) {
    useWorkspace.getState().clear();
    // The canvas stays, now unsaved: dirty iff there is something on it.
    if (useGraph.getState().centers.length > 0) useWorkspace.getState().markDirty();
  }
}

export function newWorkspace(): void {
  restoreGen++;
  useInfo.getState().close("graph");
  useTabs.getState().closeAllTx();
  useGraph.getState().reset();
  useWorkspace.getState().clear();
}

/** Applies the saved viewport once the restored graph's nodes are on the live canvas (unless superseded). */
function applyViewportLater(state: WorkspaceStateV1, gen: number): void {
  const expected = state.nodes.filter((n) => !n.hidden).map((n) => n.address.toLowerCase());
  let tries = 0;
  const attempt = () => {
    if (gen !== restoreGen) return;
    const cy = getMainCy();
    if (cy && (expected.length === 0 || expected.some((a) => cy.getElementById(a).nonempty()))) {
      restoreViewport(cy, state.viewport);
    } else if (++tries < 100) {
      setTimeout(attempt, 50);
    }
  };
  setTimeout(attempt, 0);
}

/** A saved tx tab as a tab entry (absent fields stay absent). */
function txInit({ hash, detail_tab, positions, viewport, snapshot }: TxTabStateV2): TxTabInit {
  return {
    hash,
    ...(detail_tab ? { detailTab: detail_tab } : {}),
    ...(positions || viewport ? { layout: { ...(positions ? { positions } : {}), ...(viewport ? { viewport } : {}) } } : {}),
    ...(snapshot !== undefined ? { snapshot } : {}),
  };
}

function applyState({ graph: state, tabs, active }: WorkspaceStateV2): void {
  // The saved tx tabs replace the open ones; the graph is restored with its tab shown, then the saved tab is.
  useTabs.getState().restoreTx(tabs.map(txInit), "graph");
  const ui: Record<string, NodeUi> = {};
  for (const n of state.nodes) {
    ui[n.address.toLowerCase()] = {
      pinned: n.pinned,
      hidden: n.hidden,
      note: n.note,
      ...(n.x !== undefined && n.y !== undefined ? { pos: { x: n.x, y: n.y } } : {}),
    };
  }
  useInfo.getState().close("graph");
  useGraph.getState().loadSnapshot({
    centers: state.centers,
    filter: state.filter,
    sort: state.sort,
    expandedPairs: state.expanded_pairs.map(([a, b]) => pairKey(a, b)),
    ui,
    limits: state.limits,
    proxyPos: state.proxies,
  });
  // A snapshot view stays one until it is refreshed from the chain.
  if (state.snapshot) useGraph.getState().freeze(state.snapshot);
  applyViewportLater(state, ++restoreGen);
  useTabs.getState().activate(active);
}

/** Opens a state that is not saved anywhere (an imported file) as a new, unnamed workspace with unsaved changes. */
export function openUnsaved(state: WorkspaceStateV2): void {
  applyState(state);
  useWorkspace.getState().clear();
  useWorkspace.getState().markDirty();
}

/** Opens a tx tab with this state in the current workspace; false when a tab for its hash is already open (R1). */
export function openTxTab(tab: TxTabStateV2): boolean {
  return useTabs.getState().addTx(txInit(tab));
}

/** Opens a workspace; false (with a toast, canvas untouched) when it cannot be loaded. */
export async function loadWorkspace(id: number): Promise<boolean> {
  let w: WorkspaceDto;
  try {
    w = await api.workspace(id);
  } catch (err) {
    toast(messageFor(err), "error");
    return false;
  }
  const r = deserialize(w.state, w.schema_version);
  if (!r.ok) {
    toast(r.reason, "error");
    return false;
  }
  applyState(r.state);
  useWorkspace.getState().setCurrent(w);
  return true;
}
