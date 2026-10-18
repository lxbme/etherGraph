import { create } from "zustand";

export interface BoxSelectionState {
  /** Ids (lowercase) of the nodes natively selected on the canvas (box, Shift+click); read by the batch bar. */
  ids: string[];
  /** Plain drag box-selects instead of panning. Not persisted. */
  selectMode: boolean;
  /** Mirrors the canvas's selection (`CytoscapeView.onSelectionChange`). */
  set(ids: string[]): void;
  /** Empties the selection, on the canvas too (through the callback given to `bindCanvas`). */
  clear(): void;
  setSelectMode(v: boolean): void;
  /** How `clear` drops the canvas's native selection; null when the canvas goes away. */
  bindCanvas(unselectAll: (() => void) | null): void;
}

/** One canvas's box selection; each canvas (the address graph, every tx tab) has its own. */
export function createBoxSelection() {
  let unselectAll: (() => void) | null = null;
  return create<BoxSelectionState>((set) => ({
    ids: [],
    selectMode: false,
    set: (ids) => set({ ids: [...new Set(ids.map((i) => i.toLowerCase()))] }),
    clear: () => {
      set({ ids: [] });
      unselectAll?.();
    },
    setSelectMode: (selectMode) => set({ selectMode }),
    bindCanvas: (f) => {
      unselectAll = f;
    },
  }));
}

export type BoxSelectionStore = ReturnType<typeof createBoxSelection>;

/** The address graph's box selection. */
export const useBoxSelection = createBoxSelection();
