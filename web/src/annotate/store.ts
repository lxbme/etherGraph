import { create } from "zustand";
import { pushCapped } from "../graph/undo";
import { clampFontSize, FONT_SIZE, textSizeOf, type Annotation, type AnnotationColor, type AnnotationFont, type AnnotationKind, type ViewId } from "./model";

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
  /** The size and font of new text. */
  fontSize: number;
  font: AnnotationFont;
  selected: string | null;
  setMode(view: ViewId | null): void;
  setTool(t: "select" | AnnotationKind): void;
  /** Also recolours the selected annotation (one undo step). */
  setColor(c: AnnotationColor): void;
  /** Also resizes the selected annotation when it is a text (one undo step); a size out of range is ignored. */
  setFontSize(n: number): void;
  /** Also changes the selected annotation's font when it is a text (one undo step). */
  setFont(f: AnnotationFont): void;
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

// The commit of each overlay's open text editor: a text being written is the overlay's own until committed.
const openEditors = new Set<() => void>();

/** Registers an open text editor's commit (see commitOpenText); returns the unregister. */
export function registerTextEditor(commit: () => void): () => void {
  openEditors.add(commit);
  return () => void openEditors.delete(commit);
}

/** Commits every text being written, so a save that captures the annotations next includes it. */
export function commitOpenText(): void {
  for (const commit of [...openEditors]) commit();
}

const initial = { byView: {}, active: null, tool: "select", color: "red", fontSize: FONT_SIZE, font: "sans", selected: null } as const;

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
  /** Patches the selected annotation as one undo step, when it is a text that `differs` from the patch. */
  const patchSelectedText = (patch: Partial<Annotation>, differs: (a: Annotation) => boolean) => {
    const { selected } = get();
    const view = owner(selected);
    if (view === null) return;
    const cur = get().byView[view] ?? [];
    if (cur.some((a) => a.id === selected && a.kind === "text" && differs(a))) {
      commit(view, cur.map((a) => (a.id === selected ? { ...a, ...patch } : a)));
    }
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
      const cur = view !== null ? (get().byView[view] ?? []) : [];
      if (view !== null && cur.some((a) => a.id === selected && a.color !== color)) {
        commit(view, cur.map((a) => (a.id === selected ? { ...a, color } : a)));
      }
    },
    setFontSize: (n) => {
      // Out of range would be saved, then dropped on load (isAnnotation): ignored.
      const fontSize = clampFontSize(n);
      if (fontSize === null) return;
      set({ fontSize });
      patchSelectedText({ size: fontSize }, (a) => textSizeOf(a) !== fontSize);
    },
    setFont: (font) => {
      set({ font });
      patchSelectedText({ font }, (a) => (a.font ?? "sans") !== font);
    },
    select: (selected) => set({ selected }),
    add: (view, a) => commit(view, [...(get().byView[view] ?? []), a]),
    update: (view, id, patch) => {
      const cur = get().byView[view] ?? [];
      const old = cur.find((a) => a.id === id);
      if (!old) return;
      const changed = (Object.keys(patch) as (keyof Annotation)[]).some((k) => k !== "id" && patch[k] !== old[k]);
      if (!changed) return;
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
