import { create } from "zustand";
import { useGraph } from "../../graph/store";

interface PickState {
  /** The addresses the picker is open for (lowercase, each once); null when closed. */
  targets: string[] | null;
  /**
   * Opens the picker for `addrs`. On a snapshot (frozen graph) it asks to go live first and opens once it is: the
   * picker lists neighbours from live data only.
   */
  open(addrs: string[]): void;
  close(): void;
}

export const usePick = create<PickState>((set) => ({
  targets: null,
  open: (addrs) => {
    const targets = [...new Set(addrs.map((a) => a.toLowerCase()))];
    if (targets.length === 0) return;
    useGraph.getState().guardLive(() => set({ targets }));
  },
  close: () => set({ targets: null }),
}));
