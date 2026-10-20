import { create } from "zustand";
import { pushCapped } from "../graph/undo";
import type { Annotation, AnnotationColor, AnnotationKind, ViewId } from "./model";

interface History {
  undo: Annotation[][];
  redo: Annotation[][];
}

interface AnnotationsState {
  byView: Record<string, Annotation[]>;
  /** The view in annotate mode (at most one); null when none. */
  active: ViewId | null;
  tool: "select" | AnnotationKind;
  color: AnnotationColor;
  selected: string | null;
  setMode(view: ViewId | null): void;
  setTool(t: "select" | AnnotationKind): void;
  /** Also recolours the selected annotation (one undo step). */
  setColor(c: AnnotationColor): void;
  select(id: string | null): void;
  add(view: ViewId, a: Annotation): void;
  update(view: ViewId, id: string, patch: Partial<Annotation>): void;
  remove(view: ViewId, id: string): void;
  undo(view: ViewId): void;
  redo(view: ViewId): void;
  canUndo(view: ViewId): boolean;
  canRedo(view: ViewId): boolean;
  /** Restores a view's annotations and clears its history. */
  load(view: ViewId, list: Annotation[]): void;
  /** Forgets a view (its tx tab was closed). */
  dropView(view: ViewId): void;
  /** Forgets everything (a new workspace). */
  reset(): void;
}

// Unsaved, per-view history; kept out of the store so undo/redo availability is read on demand.
const histories = new Map<string, History>();
const historyOf = (view: string): History => histories.get(view) ?? { undo: [], redo: [] };

const initial = { byView: {}, active: null, tool: "select", color: "red", selected: null } as const;

export const useAnnotations = create<AnnotationsState>()((set, get) => {
  /** Applies a change to a view's list as one undo step (no-op when the list is unchanged). */
  const commit = (view: ViewId, next: Annotation[]) => {
    const cur = get().byView[view] ?? [];
    if (next === cur) return;
    const h = historyOf(view);
    histories.set(view, { undo: pushCapped(h.undo, cur), redo: [] });
    set((s) => ({ byView: { ...s.byView, [view]: next } }));
  };
  const step = (view: ViewId, from: "undo" | "redo") => {
    const h = historyOf(view);
    const stack = h[from];
    const prev = stack[stack.length - 1];
    if (prev === undefined) return;
    const cur = get().byView[view] ?? [];
    const rest = stack.slice(0, -1);
    histories.set(
      view,
      from === "undo" ? { undo: rest, redo: pushCapped(h.redo, cur) } : { undo: pushCapped(h.undo, cur), redo: rest },
    );
    set((s) => ({
      byView: { ...s.byView, [view]: prev },
      selected: prev.some((a) => a.id === s.selected) ? s.selected : null,
    }));
  };
  /** The annotation list of the view in annotate mode that holds `id`. */
  const owner = (id: string | null): ViewId | null => {
    const { active, byView } = get();
    return id !== null && active !== null && (byView[active] ?? []).some((a) => a.id === id) ? active : null;
  };

  return {
    ...initial,
    byView: {},
    setMode: (view) => set({ active: view, selected: null, tool: "select" }),
    setTool: (tool) => set({ tool }),
    setColor: (color) => {
      const { selected } = get();
      const view = owner(selected);
      set({ color });
      if (view !== null) {
        commit(view, (get().byView[view] ?? []).map((a) => (a.id === selected && a.color !== color ? { ...a, color } : a)));
      }
    },
    select: (selected) => set({ selected }),
    add: (view, a) => commit(view, [...(get().byView[view] ?? []), a]),
    update: (view, id, patch) => {
      const cur = get().byView[view] ?? [];
      if (!cur.some((a) => a.id === id)) return;
      commit(view, cur.map((a) => (a.id === id ? { ...a, ...patch, id } : a)));
    },
    remove: (view, id) => {
      const cur = get().byView[view] ?? [];
      if (!cur.some((a) => a.id === id)) return;
      commit(view, cur.filter((a) => a.id !== id));
      if (get().selected === id) set({ selected: null });
    },
    undo: (view) => step(view, "undo"),
    redo: (view) => step(view, "redo"),
    canUndo: (view) => historyOf(view).undo.length > 0,
    canRedo: (view) => historyOf(view).redo.length > 0,
    load: (view, list) => {
      histories.delete(view);
      set((s) => ({ byView: { ...s.byView, [view]: list } }));
    },
    dropView: (view) => {
      histories.delete(view);
      set((s) => {
        const { [view]: _dropped, ...byView } = s.byView;
        return s.active === view ? { byView, active: null, selected: null, tool: "select" } : { byView };
      });
    },
    reset: () => {
      histories.clear();
      set({ ...initial, byView: {} });
    },
  };
});
