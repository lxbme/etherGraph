import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../api/endpoints";
import { ApiError, messageFor } from "../api/errors";
import type { WorkspaceDto } from "../api/generated/WorkspaceDto";
import type { JsonValue } from "../api/generated/serde_json/JsonValue";
import { t } from "../i18n";
import { getMainCy } from "../graph/cyRegistry";
import { pairKey, useGraph, type NodeUi, type Pos } from "../graph/store";
import { useTabs } from "../shell/tabs";
import { toast } from "../shell/Toasts";
import { DEFAULT_VIEWPORT, deserialize, serialize, type WorkspaceStateV1 } from "./serialize";

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
    s.limits !== prev.limits
  ) {
    graphVersion++;
    useWorkspace.getState().markDirty();
  }
});

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

/** Reads positions and viewport from the live Cytoscape instance (falls back to the store). */
export function captureState(): WorkspaceStateV1 {
  const cy = getMainCy();
  const nodes: string[] = [];
  const positions: Record<string, Pos> = {};
  let viewport = DEFAULT_VIEWPORT;
  if (cy) {
    cy.nodes().forEach((n) => {
      nodes.push(n.id());
      const p = n.position();
      positions[n.id()] = { x: p.x, y: p.y };
    });
    viewport = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  }
  return serialize(useGraph.getState(), viewport, { nodes, positions });
}

const asJson = (s: WorkspaceStateV1) => s as unknown as JsonValue;

/** Marks saved, unless the graph changed while the request was in flight. */
function commitSaved(w: WorkspaceDto, versionAtSave: number): void {
  useWorkspace.getState().setCurrent(w);
  if (graphVersion !== versionAtSave) useWorkspace.getState().markDirty();
}

export async function saveNew(name: string): Promise<void> {
  const v = graphVersion;
  const w = await api.createWorkspace({ name, state: asJson(captureState()) });
  commitSaved(w, v);
}

/** "Save as": a new workspace from the current canvas, which becomes the current one. */
export const saveAs = saveNew;

export async function saveCurrent(): Promise<"saved" | "conflict"> {
  const { id, name, updatedAt } = useWorkspace.getState();
  if (id == null || name == null || updatedAt == null) throw new Error("no current workspace");
  const v = graphVersion;
  try {
    const w = await api.updateWorkspace(id, { name, state: asJson(captureState()), expected_updated_at: updatedAt });
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
    const w = await api.updateWorkspace(id, { name, state: cur.state, expected_updated_at: updatedAt });
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
      cy.viewport({ zoom: state.viewport.zoom, pan: state.viewport.pan });
    } else if (++tries < 100) {
      setTimeout(attempt, 50);
    }
  };
  setTimeout(attempt, 0);
}

function applyState(state: WorkspaceStateV1): void {
  // The restored canvas (and its saved viewport) belongs to the graph tab: show it first.
  useTabs.getState().activate("graph");
  const ui: Record<string, NodeUi> = {};
  for (const n of state.nodes) {
    ui[n.address.toLowerCase()] = {
      pinned: n.pinned,
      hidden: n.hidden,
      note: n.note,
      ...(n.x !== undefined && n.y !== undefined ? { pos: { x: n.x, y: n.y } } : {}),
    };
  }
  useGraph.getState().loadSnapshot({
    centers: state.centers,
    filter: state.filter,
    sort: state.sort,
    expandedPairs: state.expanded_pairs.map(([a, b]) => pairKey(a, b)),
    ui,
    limits: state.limits,
  });
  applyViewportLater(state, ++restoreGen);
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
