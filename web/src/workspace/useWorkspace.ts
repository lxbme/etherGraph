import { create } from "zustand";
import { api } from "../api/endpoints";
import { ApiError, messageFor } from "../api/errors";
import type { WorkspaceDto } from "../api/generated/WorkspaceDto";
import type { JsonValue } from "../api/generated/serde_json/JsonValue";
import { getMainCy } from "../graph/cyRegistry";
import { pairKey, useGraph, type NodeUi, type Pos } from "../graph/store";
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

// Any change to the persisted part of the graph store marks the workspace dirty (selection/highlight excluded).
useGraph.subscribe((s, prev) => {
  if (
    s.centers !== prev.centers ||
    s.filter !== prev.filter ||
    s.sort !== prev.sort ||
    s.expandedPairs !== prev.expandedPairs ||
    s.ui !== prev.ui
  ) {
    useWorkspace.getState().markDirty();
  }
});

export function saveStatusLabel(w: Pick<WorkspaceStore, "id" | "dirty">): string {
  if (w.id == null) return "未保存";
  return w.dirty ? "有未保存的修改" : "已保存";
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

export async function saveNew(name: string): Promise<void> {
  const w = await api.createWorkspace({ name, state: asJson(captureState()) });
  useWorkspace.getState().setCurrent(w);
}

/** "Save as": a new workspace from the current canvas, which becomes the current one. */
export const saveAs = saveNew;

export async function saveCurrent(): Promise<"saved" | "conflict"> {
  const { id, name, updatedAt } = useWorkspace.getState();
  if (id == null || name == null || updatedAt == null) throw new Error("no current workspace");
  try {
    const w = await api.updateWorkspace(id, { name, state: asJson(captureState()), expected_updated_at: updatedAt });
    useWorkspace.getState().setCurrent(w);
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
  const w = await api.updateWorkspace(id, {
    name,
    state: asJson(captureState()),
    expected_updated_at: latest.updated_at,
  });
  useWorkspace.getState().setCurrent(w);
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
  if (useWorkspace.getState().id === id) useWorkspace.getState().clear();
}

export function newWorkspace(): void {
  useGraph.getState().reset();
  useWorkspace.getState().clear();
}

/** Applies the saved viewport once the restored graph has produced nodes on the live canvas. */
function applyViewportLater(state: WorkspaceStateV1): void {
  let tries = 0;
  const attempt = () => {
    const cy = getMainCy();
    if (cy && (cy.nodes().nonempty() || state.centers.length === 0)) {
      cy.viewport({ zoom: state.viewport.zoom, pan: state.viewport.pan });
    } else if (++tries < 100) {
      setTimeout(attempt, 50);
    }
  };
  setTimeout(attempt, 0);
}

function applyState(state: WorkspaceStateV1): void {
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
    expandedPairs: state.expanded_pairs.map(([a, b]) => pairKey(a, b)),
    ui,
  });
  applyViewportLater(state);
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
