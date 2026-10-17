import { create } from "zustand";

/** The detail section shown under a transaction's flow graph. */
export type TxDetailTab = "overview" | "input" | "transfers" | "internal" | "logs" | "raw";

export type Tab = { id: "graph" } | { id: string; kind: "tx"; hash: string; detailTab?: TxDetailTab };

interface TabsState {
  tabs: Tab[];
  active: string;
  openTx(hash: string): void;
  close(id: string): void;
  activate(id: string): void;
  /** Remembers a tx tab's detail section; no-op for unknown ids. */
  setDetailTab(id: string, detailTab: TxDetailTab): void;
}

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
}));
