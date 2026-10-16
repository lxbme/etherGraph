import { create } from "zustand";

/** Cross-panel UI requests. Task 12's label editor consumes `labelEditorFor`. */
export const useUi = create<{
  labelEditorFor: string | null;
  openLabelEditor(addr: string): void;
  closeLabelEditor(): void;
}>((set) => ({
  labelEditorFor: null,
  openLabelEditor: (addr) => set({ labelEditorFor: addr.toLowerCase() }),
  closeLabelEditor: () => set({ labelEditorFor: null }),
}));
