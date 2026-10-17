import { create } from "zustand";
import { useGraph, type Selection } from "../graph/store";

/** Below this width the detail panel is an overlay that starts closed. */
const NARROW_QUERY = "(max-width: 899px)";

export function isNarrow(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

interface UiState {
  /** The address whose label editor was requested (L / context menu); cleared when the selection changes. */
  labelEditorFor: string | null;
  /** Whether the right detail panel is shown. */
  detailOpen: boolean;
  /** Each tx tab's selected node, by tx hash. */
  txSelection: Record<string, string | null>;
  /** Whether the help drawer is open. */
  helpOpen: boolean;
  openLabelEditor(addr: string): void;
  closeLabelEditor(): void;
  setDetailOpen(v: boolean): void;
  toggleDetail(): void;
  toggleHelp(): void;
  selectTx(hash: string, addr: string | null): void;
  /** Drops a closed tx tab's selection. */
  forgetTx(hash: string): void;
}

/** Cross-panel UI state: label editor requests, the detail panel, tx-tab selections, the help drawer. */
export const useUi = create<UiState>((set, get) => ({
  labelEditorFor: null,
  detailOpen: !isNarrow(),
  txSelection: {},
  helpOpen: false,
  openLabelEditor: (addr) => set({ labelEditorFor: addr.toLowerCase(), detailOpen: true }),
  closeLabelEditor: () => set({ labelEditorFor: null }),
  setDetailOpen: (detailOpen) => set({ detailOpen }),
  toggleDetail: () => set((s) => ({ detailOpen: !s.detailOpen })),
  toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),
  selectTx: (hash, addr) => {
    const h = hash.toLowerCase();
    const a = addr?.toLowerCase() ?? null;
    if ((get().txSelection[h] ?? null) === a) return;
    set((s) => ({ txSelection: { ...s.txSelection, [h]: a } }));
    selectionChanged(a !== null);
  },
  forgetTx: (hash) =>
    set((s) => {
      const next = { ...s.txSelection };
      delete next[hash.toLowerCase()];
      return { txSelection: next };
    }),
}));

/** A new selection drops a pending label editor request; on narrow screens a selected node or tx opens the overlay. */
function selectionChanged(opens: boolean): void {
  useUi.setState(opens && isNarrow() ? { labelEditorFor: null, detailOpen: true } : { labelEditorFor: null });
}

const selKey = (s: Selection) =>
  s === null ? "" : s.kind === "tx" ? `t:${s.hash.toLowerCase()}` : s.kind === "node" ? `n:${s.address.toLowerCase()}` : `p:${s.a.toLowerCase()}|${s.b.toLowerCase()}`;

useGraph.subscribe((s, prev) => {
  if (s.selection !== prev.selection && selKey(s.selection) !== selKey(prev.selection)) {
    selectionChanged(s.selection?.kind === "node" || s.selection?.kind === "tx");
  }
});
