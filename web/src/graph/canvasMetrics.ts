import { create } from "zustand";

type Metrics = { width: number; height: number; visible: number };

/** Canvas size and the number of real (non "+N more") nodes currently shown; feeds the expansion budget. */
export const useCanvasMetrics = create<Metrics & { set(p: Partial<Metrics>): void }>((set) => ({
  width: 0,
  height: 0,
  visible: 0,
  set: (p) => set(p),
}));
