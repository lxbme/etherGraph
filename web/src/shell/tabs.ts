import { create } from "zustand";
import type { Pos } from "../graph/store";
import type { TxSnapshot, Viewport } from "../workspace/serialize";

/** The detail section shown under a transaction's flow graph. */
export type TxDetailTab = "overview" | "input" | "transfers" | "internal" | "logs" | "raw";

/** A saved flow-graph layout, applied once when the tab's canvas first shows the flow. */
export type TxLayout = { positions?: Record<string, Pos>; viewport?: Viewport };

export type TxTab = {
  id: string;
  kind: "tx";
  hash: string;
  detailTab?: TxDetailTab;
  highlightedSeq?: number | null;
  layout?: TxLayout;
  snapshot?: TxSnapshot;
  /** Set on tabs restored from a workspace: a new value gives the tab a fresh view (so its layout applies). */
  restored?: number;
};
export type Tab = { id: "graph" } | TxTab;

/** A tx tab to restore (from a saved workspace). */
export type TxTabInit = Pick<TxTab, "hash" | "detailTab" | "layout" | "snapshot">;

interface TabsState {
  tabs: Tab[];
  active: string;
  openTx(hash: string): void;
  close(id: string): void;
  activate(id: string): void;
  /** Remembers a tx tab's detail section; no-op for unknown ids. */
  setDetailTab(id: string, detailTab: TxDetailTab): void;
  /** Highlights the flow edge with this seq in a tx tab's graph (null clears); no-op for unknown ids. */
  setHighlightedSeq(id: string, seq: number | null): void;
  /** Replaces every tx tab with these and activates `active` (the graph tab when it is not one of them). */
  restoreTx(tabs: TxTabInit[], active: string): void;
  /** Closes every tx tab. */
  closeAllTx(): void;
}

let restoreSeq = 0;

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [{ id: "graph" }],
  active: "graph",
  openTx: (hash) => {
    const h = hash.toLowerCase();
    if (!get().tabs.some((t) => t.id === h)) {
      set((s) => ({ tabs: [...s.tabs, { id: h, kind: "tx", hash: h }] }));
    }
    set({ active: h });
  },
  close: (id) => {
    if (id === "graph") return;
    const { tabs, active } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.id !== id);
    set({ tabs: next, active: active === id ? (next[idx - 1] ?? next[0])!.id : active });
  },
  activate: (id) => {
    if (get().tabs.some((t) => t.id === id)) set({ active: id });
  },
  setDetailTab: (id, detailTab) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && "kind" in t ? { ...t, detailTab } : t)) }));
  },
  setHighlightedSeq: (id, highlightedSeq) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && "kind" in t ? { ...t, highlightedSeq } : t)) }));
  },
  restoreTx: (init, active) => {
    const restored = ++restoreSeq;
    const tx: TxTab[] = init.map((t) => {
      const hash = t.hash.toLowerCase();
      return { ...t, id: hash, kind: "tx", hash, restored };
    });
    set({ tabs: [{ id: "graph" }, ...tx], active: tx.some((t) => t.id === active) ? active : "graph" });
  },
  closeAllTx: () => set({ tabs: [{ id: "graph" }], active: "graph" }),
}));
