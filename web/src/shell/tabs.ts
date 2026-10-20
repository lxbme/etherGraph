import { create } from "zustand";
import { txCallsView, txFlowView } from "../annotate/model";
import { useAnnotations } from "../annotate/store";
import type { Pos } from "../graph/store";
import type { Viewport } from "../workspace/serialize";
import type { TxSnapshot } from "../workspace/snapshot";

/** The detail section shown under a transaction's flow graph. */
export type TxDetailTab = "overview" | "input" | "transfers" | "internal" | "logs" | "raw";

/** What a transaction tab shows above its detail sections: the asset flow or the call tree. */
export type TxView = "flow" | "calls";

/** A saved flow-graph layout, applied once when the tab's canvas first shows the flow. */
export type TxLayout = { positions?: Record<string, Pos>; viewport?: Viewport };

/**
 * The call graph's node positions, stored on every drag (its canvas is unmounted while the asset flow shows):
 * nodes with one are placed there, the others are laid out.
 */
export type CallLayout = { positions?: Record<string, Pos> };

export type TxTab = {
  id: string;
  kind: "tx";
  hash: string;
  detailTab?: TxDetailTab;
  /** Absent means the asset flow. */
  view?: TxView;
  highlightedSeq?: number | null;
  layout?: TxLayout;
  callLayout?: CallLayout;
  /** File data shown instead of the tx request until the tab is refreshed from the chain. */
  snapshot?: TxSnapshot;
  /** Set on tabs restored from a workspace: a new value gives the tab a fresh view (so its layout applies). */
  restored?: number;
};
/**
 * The graph tab, the Data tab (every transfer behind the graph's edges) and the tx tabs; `kind` tells them apart
 * (absent on the graph tab). The graph and data tabs are always open, first and in that order.
 */
export type Tab = { id: "graph"; kind?: undefined } | { id: "data"; kind: "data" } | TxTab;

/** A tx tab to restore (from a saved workspace). */
export type TxTabInit = Pick<TxTab, "hash" | "detailTab" | "view" | "layout" | "callLayout" | "snapshot">;

interface TabsState {
  tabs: Tab[];
  active: string;
  openTx(hash: string): void;
  close(id: string): void;
  activate(id: string): void;
  /** Remembers a tx tab's detail section; no-op for unknown ids. */
  setDetailTab(id: string, detailTab: TxDetailTab): void;
  /** Switches a tx tab between the asset flow and the call tree; no-op for unknown ids. */
  setTxView(id: string, view: TxView): void;
  /** Highlights the flow edge with this seq in a tx tab's graph (null clears); no-op for unknown ids. */
  setHighlightedSeq(id: string, seq: number | null): void;
  /** Stores a tx tab's call-graph node positions (all of them, replacing the last); no-op for unknown ids. */
  setCallLayout(id: string, positions: Record<string, Pos>): void;
  /** Opens a tx tab with this state (an imported snapshot) and activates it; false (nothing opened) when one for the hash is open. */
  addTx(tab: TxTabInit): boolean;
  /** Replaces every tx tab with these and activates `active` (the graph tab when it is neither the data tab nor one of them). */
  restoreTx(tabs: TxTabInit[], active: string): void;
  /** "Refresh from chain": drops a tx tab's snapshot, so it loads the tx like any tab; no-op for unknown ids. */
  refreshTx(id: string): void;
  /** Closes every tx tab. */
  closeAllTx(): void;
}

let restoreSeq = 0;

/** The tabs that are always open; only tx tabs come and go. */
const fixedTabs = (): Tab[] => [{ id: "graph" }, { id: "data", kind: "data" }];

export const useTabs = create<TabsState>((set, get) => ({
  tabs: fixedTabs(),
  active: "graph",
  openTx: (hash) => {
    const h = hash.toLowerCase();
    if (!get().tabs.some((t) => t.id === h)) {
      set((s) => ({ tabs: [...s.tabs, { id: h, kind: "tx", hash: h }] }));
    }
    set({ active: h });
  },
  close: (id) => {
    const { tabs, active } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0 || tabs[idx]!.kind !== "tx") return;
    const next = tabs.filter((t) => t.id !== id);
    set({ tabs: next, active: active === id ? (next[idx - 1] ?? next[0])!.id : active });
    useAnnotations.getState().dropView(txFlowView(id));
    useAnnotations.getState().dropView(txCallsView(id));
  },
  activate: (id) => {
    if (get().tabs.some((t) => t.id === id)) set({ active: id });
  },
  setDetailTab: (id, detailTab) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && t.kind === "tx" ? { ...t, detailTab } : t)) }));
  },
  setTxView: (id, view) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && t.kind === "tx" ? { ...t, view } : t)) }));
  },
  setHighlightedSeq: (id, highlightedSeq) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && t.kind === "tx" ? { ...t, highlightedSeq } : t)) }));
  },
  setCallLayout: (id, positions) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id && t.kind === "tx" ? { ...t, callLayout: { positions } } : t)) }));
  },
  addTx: (init) => {
    const hash = init.hash.toLowerCase();
    if (get().tabs.some((t) => t.id === hash)) return false;
    set((s) => ({ tabs: [...s.tabs, { ...init, id: hash, kind: "tx", hash, restored: ++restoreSeq }], active: hash }));
    return true;
  },
  restoreTx: (init, active) => {
    const restored = ++restoreSeq;
    const tx: TxTab[] = init.map((t) => {
      const hash = t.hash.toLowerCase();
      return { ...t, id: hash, kind: "tx", hash, restored };
    });
    const keep = active === "data" || tx.some((t) => t.id === active);
    set({ tabs: [...fixedTabs(), ...tx], active: keep ? active : "graph" });
  },
  refreshTx: (id) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id || t.kind !== "tx" || t.snapshot === undefined) return t;
        const { snapshot: _dropped, ...rest } = t;
        return rest;
      }),
    }));
  },
  closeAllTx: () => {
    for (const t of get().tabs) {
      if (t.kind !== "tx") continue;
      useAnnotations.getState().dropView(txFlowView(t.hash));
      useAnnotations.getState().dropView(txCallsView(t.hash));
    }
    set({ tabs: fixedTabs(), active: "graph" });
  },
}));

/** The snapshot a tx tab shows instead of live data (undefined when live or not an open tab). */
export function useTxSnapshot(hash: string): TxSnapshot | undefined {
  const id = hash.toLowerCase();
  return useTabs((s) => s.tabs.find((x): x is TxTab => x.id === id && x.kind === "tx")?.snapshot);
}
