import { create } from "zustand";

/** Node ids picked by the last box (drag) selection on the canvas; read by the batch action bar. */
export const useBoxSelection = create<{ ids: string[]; set(ids: string[]): void; clear(): void }>((set) => ({
  ids: [],
  set: (ids) => set({ ids: [...new Set(ids.map((i) => i.toLowerCase()))] }),
  clear: () => set({ ids: [] }),
}));
