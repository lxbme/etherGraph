import { create } from "zustand";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import { pairKey } from "./pairKey";
import { pushCapped } from "./undo";

export { pairKey };

export interface NodeUi {
  pinned: boolean;
  hidden: boolean;
  note: string;
  pos?: { x: number; y: number };
}
export type Pos = { x: number; y: number };
export type Selection =
  | { kind: "node"; address: string }
  | { kind: "pair"; a: string; b: string }
  | null;
export type SortKey = "count" | "amount" | "recent";

export interface GraphState {
  centers: string[];
  filter: EdgeFilterDto;
  sort: SortKey;
  expandedPairs: Set<string>;
  ui: Record<string, NodeUi>;
  selection: Selection;
  highlightTransfer: { from: string; to: string; asset: string | null } | null;
  addCenter(a: string): void;
  removeCenter(a: string): void;
  setCenters(a: string[]): void;
  setFilter(f: EdgeFilterDto): void;
  setSort(s: SortKey): void;
  togglePair(a: string, b: string): void;
  setPinned(addrs: string[], v: boolean): void;
  setHidden(addrs: string[], v: boolean): void;
  setNote(a: string, note: string): void;
  /** Not history-tracked. */
  setPositions(p: Record<string, Pos>): void;
  /** Push a drag step; undo restores `prevPositions`. Call after the drag ended and positions were set. */
  commitMove(prevPositions: Record<string, Pos>): void;
  select(s: Selection): void;
  setHighlightTransfer(h: GraphState["highlightTransfer"]): void;
  /** Hides every known node except `a` and its neighbors (and unhides those). */
  focusNeighborhood(a: string, neighbors: string[]): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  reset(): void;
  /** Internal history stacks. */
  _past: HistoryEntry[];
  _future: HistoryEntry[];
}

type UiFlags = Pick<NodeUi, "pinned" | "hidden" | "note">;
interface Snapshot {
  centers: string[];
  expandedPairs: Set<string>;
  ui: Record<string, UiFlags>;
  filter: EdgeFilterDto;
  sort: SortKey;
}
/** A snapshot step, or (when `positions` is set) a position-move step. */
interface HistoryEntry {
  snap?: Snapshot;
  positions?: Record<string, Pos>;
}

const lc = (s: string) => s.toLowerCase();
const blankUi = (): NodeUi => ({ pinned: false, hidden: false, note: "" });

function snapshot(s: GraphState): Snapshot {
  const ui: Record<string, UiFlags> = {};
  for (const [k, v] of Object.entries(s.ui)) {
    ui[k] = { pinned: v.pinned, hidden: v.hidden, note: v.note };
  }
  return {
    centers: [...s.centers],
    expandedPairs: new Set(s.expandedPairs),
    ui,
    filter: s.filter,
    sort: s.sort,
  };
}

function restoreUi(cur: Record<string, NodeUi>, snap: Record<string, UiFlags>): Record<string, NodeUi> {
  const next: Record<string, NodeUi> = {};
  for (const k of new Set([...Object.keys(cur), ...Object.keys(snap)])) {
    const pos = cur[k]?.pos;
    const flags = snap[k] ?? { pinned: false, hidden: false, note: "" };
    next[k] = pos ? { ...flags, pos } : { ...flags };
  }
  return next;
}

function applyUiPatch(
  ui: Record<string, NodeUi>,
  addrs: string[],
  patch: Partial<UiFlags>,
): Record<string, NodeUi> {
  const next = { ...ui };
  for (const a of addrs.map(lc)) next[a] = { ...(next[a] ?? blankUi()), ...patch };
  return next;
}

const initial = () => ({
  centers: [] as string[],
  filter: {} as EdgeFilterDto,
  sort: "count" as SortKey,
  expandedPairs: new Set<string>(),
  ui: {} as Record<string, NodeUi>,
  selection: null as Selection,
  highlightTransfer: null as GraphState["highlightTransfer"],
  _past: [] as HistoryEntry[],
  _future: [] as HistoryEntry[],
});

export const useGraph = create<GraphState>()((set, get) => {
  /** Apply a tracked change: record a pre-change snapshot, clear redo. */
  const tracked = (change: (s: GraphState) => Partial<GraphState>) =>
    set((s) => ({
      ...change(s),
      _past: pushCapped(s._past, { snap: snapshot(s) }),
      _future: [],
    }));

  /** Swap the present with `entry`; returns [state patch, counterpart entry]. */
  const applyEntry = (s: GraphState, entry: HistoryEntry): [Partial<GraphState>, HistoryEntry] => {
    if (entry.positions) {
      const cur: Record<string, Pos> = {};
      const ui = { ...s.ui };
      for (const [k, p] of Object.entries(entry.positions)) {
        const prev = s.ui[k]?.pos;
        if (prev) cur[k] = prev;
        ui[k] = { ...(ui[k] ?? blankUi()), pos: p };
      }
      return [{ ui }, { positions: cur }];
    }
    const snap = entry.snap!;
    return [
      {
        centers: snap.centers,
        expandedPairs: new Set(snap.expandedPairs),
        ui: restoreUi(s.ui, snap.ui),
        filter: snap.filter,
        sort: snap.sort,
      },
      { snap: snapshot(s) },
    ];
  };

  return {
    ...initial(),
    addCenter: (a) => {
      const addr = lc(a);
      if (get().centers.includes(addr)) return;
      tracked((s) => ({ centers: [...s.centers, addr] }));
    },
    removeCenter: (a) => {
      const addr = lc(a);
      if (!get().centers.includes(addr)) return;
      tracked((s) => ({ centers: s.centers.filter((c) => c !== addr) }));
    },
    setCenters: (list) =>
      tracked(() => ({ centers: [...new Set(list.map(lc))] })),
    setFilter: (f) => tracked(() => ({ filter: f })),
    setSort: (sort) => tracked(() => ({ sort })),
    togglePair: (a, b) =>
      tracked((s) => {
        const key = pairKey(a, b);
        const next = new Set(s.expandedPairs);
        if (!next.delete(key)) next.add(key);
        return { expandedPairs: next };
      }),
    setPinned: (addrs, v) => tracked((s) => ({ ui: applyUiPatch(s.ui, addrs, { pinned: v }) })),
    setHidden: (addrs, v) => tracked((s) => ({ ui: applyUiPatch(s.ui, addrs, { hidden: v }) })),
    setNote: (a, note) => tracked((s) => ({ ui: applyUiPatch(s.ui, [a], { note }) })),
    setPositions: (p) =>
      set((s) => {
        const ui = { ...s.ui };
        for (const [k, pos] of Object.entries(p)) {
          const addr = lc(k);
          ui[addr] = { ...(ui[addr] ?? blankUi()), pos };
        }
        return { ui };
      }),
    commitMove: (prev) =>
      set((s) => {
        const positions: Record<string, Pos> = {};
        for (const [k, p] of Object.entries(prev)) positions[lc(k)] = p;
        return { _past: pushCapped(s._past, { positions }), _future: [] };
      }),
    select: (selection) => set({ selection }),
    setHighlightTransfer: (highlightTransfer) => set({ highlightTransfer }),
    focusNeighborhood: (a, neighbors) =>
      tracked((s) => {
        const keep = new Set([lc(a), ...neighbors.map(lc)]);
        const known = new Set([...s.centers, ...Object.keys(s.ui), ...keep]);
        const ui = { ...s.ui };
        for (const k of known) ui[k] = { ...(ui[k] ?? blankUi()), hidden: !keep.has(k) };
        return { ui };
      }),
    undo: () => {
      const s = get();
      const entry = s._past[s._past.length - 1];
      if (!entry) return;
      const [patch, counter] = applyEntry(s, entry);
      set({
        ...patch,
        _past: s._past.slice(0, -1),
        _future: pushCapped(s._future, counter),
      });
    },
    redo: () => {
      const s = get();
      const entry = s._future[s._future.length - 1];
      if (!entry) return;
      const [patch, counter] = applyEntry(s, entry);
      set({
        ...patch,
        _future: s._future.slice(0, -1),
        _past: pushCapped(s._past, counter),
      });
    },
    canUndo: () => get()._past.length > 0,
    canRedo: () => get()._future.length > 0,
    reset: () => set(initial()),
  };
});
