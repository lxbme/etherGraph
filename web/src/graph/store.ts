import { create } from "zustand";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import { useAssetRegistry } from "./assetRegistry";
import { nodeBudget, nodeCapacity, perCenterBatch } from "./budget";
import { useCanvasMetrics } from "./canvasMetrics";
import { runRedoEffect, runUndoEffect, type ExpandEffect } from "./historyEffects";
import { MORE_PREFIX } from "./moreId";
import { pairKey } from "./pairKey";
import { pushCapped } from "./undo";
import type { GraphSnapshot } from "../workspace/snapshot";

export { pairKey };

export interface NodeUi {
  pinned: boolean;
  hidden: boolean;
  note: string;
  pos?: { x: number; y: number };
}
export type Pos = { x: number; y: number };
export type GraphSelection =
  | { kind: "node"; address: string }
  | { kind: "pair"; a: string; b: string };
/** A tx selection remembers the node/pair it was picked from (`context`), which keeps driving the canvas and table. */
export type Selection = GraphSelection | { kind: "tx"; hash: string; context: GraphSelection | null } | null;

/** The node/pair selection behind `s`: itself, or a tx selection's origin. */
export function graphSelection(s: Selection): GraphSelection | null {
  return s?.kind === "tx" ? s.context : s;
}
export type SortKey = "count" | "amount" | "recent";

export interface GraphState {
  centers: string[];
  filter: EdgeFilterDto;
  sort: SortKey;
  expandedPairs: Set<string>;
  ui: Record<string, NodeUi>;
  /**
   * Positions of the "+N more" proxies the user dragged, keyed by center. View state like `ui[].pos`, kept apart
   * so a proxy is never mistaken for an address (focus, files); never saved.
   */
  proxyPos: Record<string, Pos>;
  /** Neighbour limit per center (kept after a center is removed, so re-adding it restores it); only centers' entries are sent. */
  limits: Record<string, number>;
  selection: Selection;
  highlightTransfer: { from: string; to: string; asset: string | null } | null;
  /** Bumped by `reset` and `loadSnapshot`: a new canvas whose nodes have nothing to do with earlier ones. */
  epoch: number;
  /** Data from a file shown instead of the graph query (a snapshot view); `reset` and `loadSnapshot` drop it. */
  frozen: GraphSnapshot | null;
  /** A graph-changing action waiting for the user to confirm a refresh from the chain. */
  pendingLive: (() => void) | null;
  /** Shows `s` instead of live data. Not history-tracked. */
  freeze(s: GraphSnapshot): void;
  /** Back to live data (the graph query runs again; the file's assets leave the registry); the unfreeze handler syncs the centers. No-op when live. */
  unfreeze(): void;
  /**
   * Runs `run` at once when live; on a snapshot, keeps it for a confirm instead ("Refresh from chain first?").
   * Every action that changes centers, expanded pairs, filter, sort, limits or batches goes through this.
   */
  guardLive(run: () => void): void;
  /** Answers the confirm: true refreshes (unfreezes) and then runs the pending action; false drops it. */
  resolveLive(go: boolean): void;
  /** New centers (here and in `revealCenter`/`setCenters`/`loadSnapshot`) without a limit get `firstBatch()`. */
  addCenter(a: string): void;
  /** Makes `a` a shown center (adds it and/or unhides it) in one history step; no-op if it already is. */
  revealCenter(a: string): void;
  /** `revealCenter` for several addresses, as one history step. */
  revealCenters(a: string[]): void;
  removeCenter(a: string): void;
  setCenters(a: string[]): void;
  /** Adds `addresses` as shown centers with limit `k` (existing centers keep theirs) in one history step whose undo/redo runs the batch's effect. */
  expand(addresses: string[], batch: string, k: number): void;
  /** Raises a center's limit by `by` (> 0) in one history step. */
  raiseLimit(center: string, by: number): void;
  setFilter(f: EdgeFilterDto): void;
  setSort(s: SortKey): void;
  /** Sets filter and sort as ONE history step. */
  applyFilter(f: EdgeFilterDto, sort: SortKey): void;
  togglePair(a: string, b: string): void;
  setPinned(addrs: string[], v: boolean): void;
  /** Hiding a center also drops it from `centers` (same history step), so its neighbours do not linger alone. */
  setHidden(addrs: string[], v: boolean): void;
  setNote(a: string, note: string): void;
  /** Not history-tracked. */
  /** Keys are node ids: addresses, or "+N more" proxy ids (`more:<center>`), whose positions go to `proxyPos`. */
  setPositions(p: Record<string, Pos>): void;
  /** Push a drag step; undo restores `prevPositions` (keyed like `setPositions`). Call after the drag ended and positions were set. */
  commitMove(prevPositions: Record<string, Pos>): void;
  /** Forgets every dragged proxy position (Re-layout places the proxies again). Not history-tracked. */
  clearProxyPositions(): void;
  /** Forgets the positions of proxies whose center is not in `shown` (a proxy that left the canvas is placed afresh). Not history-tracked. */
  pruneProxyPositions(shown: Iterable<string>): void;
  /** Also clears `highlightTransfer`. */
  select(s: Selection): void;
  setHighlightTransfer(h: GraphState["highlightTransfer"]): void;
  /** Hides every known node (centers, ui keys, `allNodes`) except `a` and its neighbors (and unhides those). */
  focusNeighborhood(a: string, neighbors: string[], allNodes?: string[]): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  reset(): void;
  /** Replaces the whole canvas state (as after opening a workspace) without any history; clears selection. */
  loadSnapshot(v: {
    centers: string[];
    filter: EdgeFilterDto;
    sort?: SortKey;
    expandedPairs: string[];
    ui: Record<string, NodeUi>;
    limits?: Record<string, number>;
  }): void;
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
  limits: Record<string, number>;
}
/**
 * A snapshot step, or (when `positions` is set) a position-move step; `effect` runs after it is undone/redone.
 * Proxy keys (`more:<center>`) may be null: the proxy had no dragged position then.
 */
interface HistoryEntry {
  snap?: Snapshot;
  positions?: Record<string, Pos | null>;
  effect?: ExpandEffect;
}

/** Called with the centers when a snapshot graph goes live (the app syncs them). The store has no network code. */
let unfreezeHandler: ((centers: string[]) => void) | null = null;

/** Registers the unfreeze handler; `null` unregisters it. */
export function setUnfreezeHandler(h: ((centers: string[]) => void) | null): void {
  unfreezeHandler = h;
}

/** Whether undoing/redoing to `snap` changes what the graph query asks for (or runs a batch effect). */
function changesGraph(s: GraphState, entry: HistoryEntry): boolean {
  if (entry.effect) return true;
  const snap = entry.snap;
  if (!snap) return false;
  const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((k) => b.has(k));
  const sameLimits = (a: Record<string, number>, b: Record<string, number>) =>
    Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, n]) => b[k] === n);
  return (
    snap.centers.join(",") !== s.centers.join(",") ||
    !sameSet(snap.expandedPairs, s.expandedPairs) ||
    snap.filter !== s.filter ||
    snap.sort !== s.sort ||
    !sameLimits(snap.limits, s.limits)
  );
}

const lc = (s: string) => s.toLowerCase();
const blankUi = (): NodeUi => ({ pinned: false, hidden: false, note: "" });

type CanvasSize = { width: number; height: number; visible: number };

/** Share of the window area taken as the canvas before the canvas was first measured (ruling R4). */
const UNMEASURED_CANVAS_SHARE = 0.6;
/** Highest neighbour limit the server accepts per center (POST /api/graph/edges clamps to it). */
export const MAX_NEIGHBOUR_LIMIT = 1000;
/** Most centers one graph request accepts (the server's `MAX_ADDRESSES`). */
export const MAX_CENTERS = 50;

/**
 * Neighbour limit of each of `n` centers that receive a first batch at once: the node budget is shared
 * between them (ruling R12). `fresh` ignores the nodes now on the canvas (it is being replaced).
 */
export function firstBatchFor(n: number, opts: { fresh?: boolean } = {}): number {
  const count = Math.max(1, n);
  return perCenterBatch(currentNodeBudget(opts.fresh), count, count);
}

/** The node budget now: canvas capacity (60% of the window before the first measure, ruling R4) minus the shown nodes. */
function currentNodeBudget(fresh = false, m: CanvasSize = useCanvasMetrics.getState()): number {
  const canvas =
    m.width > 0 && m.height > 0
      ? m
      : typeof window === "undefined"
        ? { width: 0, height: 0 }
        : // Scaling one side scales the area: 60% of innerWidth x innerHeight.
          { width: window.innerWidth * UNMEASURED_CANVAS_SHARE, height: window.innerHeight };
  return nodeBudget(nodeCapacity(canvas), fresh ? 0 : m.visible);
}

/** How many more neighbours one click on a "+N more" node reveals: a single center's share of the free budget. */
export function revealBatch(): number {
  return revealBatchFor(useCanvasMetrics.getState());
}

/** `revealBatch()` as a hook: re-renders only when the batch itself changes (not on every metrics write). */
export function useRevealBatch(): number {
  return useCanvasMetrics(revealBatchFor);
}

function revealBatchFor(m: CanvasSize): number {
  return perCenterBatch(currentNodeBudget(false, m), 1, 0);
}

/** Neighbour limit of a new center: the per-center batch for one new center under the current node budget. */
export function firstBatch(): number {
  return firstBatchFor(1);
}

/** `limits` with a first batch for each of `addrs` (lowercase) that has none; the same object when nothing is missing. */
export function withFirstBatch(
  limits: Record<string, number>,
  addrs: string[],
  opts: { fresh?: boolean } = {},
): Record<string, number> {
  const missing = [...new Set(addrs.filter((a) => limits[a] === undefined))];
  if (missing.length === 0) return limits;
  const k = firstBatchFor(missing.length, opts);
  const next = { ...limits };
  for (const a of missing) next[a] = k;
  return next;
}

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
    limits: { ...s.limits },
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
  proxyPos: {} as Record<string, Pos>,
  limits: {} as Record<string, number>,
  selection: null as Selection,
  highlightTransfer: null as GraphState["highlightTransfer"],
  frozen: null as GraphSnapshot | null,
  pendingLive: null as (() => void) | null,
  _past: [] as HistoryEntry[],
  _future: [] as HistoryEntry[],
});

export const useGraph = create<GraphState>()((set, get) => {
  /** Apply a tracked change: record a pre-change snapshot (with its side effect, if any), clear redo. */
  const tracked = (change: (s: GraphState) => Partial<GraphState>, effect?: ExpandEffect) =>
    set((s) => ({
      ...change(s),
      _past: pushCapped(s._past, effect ? { snap: snapshot(s), effect } : { snap: snapshot(s) }),
      _future: [],
    }));

  /** Swap the present with `entry`; returns [state patch, counterpart entry]. */
  const applyEntry = (s: GraphState, entry: HistoryEntry): [Partial<GraphState>, HistoryEntry] => {
    if (entry.positions) {
      const cur: Record<string, Pos | null> = {};
      const ui = { ...s.ui };
      const proxyPos = { ...s.proxyPos };
      for (const [k, p] of Object.entries(entry.positions)) {
        if (k.startsWith(MORE_PREFIX)) {
          const c = k.slice(MORE_PREFIX.length);
          cur[k] = s.proxyPos[c] ?? null;
          if (p) proxyPos[c] = p;
          else delete proxyPos[c];
          continue;
        }
        const prev = s.ui[k]?.pos;
        if (prev) cur[k] = prev;
        if (p) ui[k] = { ...(ui[k] ?? blankUi()), pos: p };
      }
      return [{ ui, proxyPos }, { positions: cur }];
    }
    const snap = entry.snap!;
    return [
      {
        centers: snap.centers,
        expandedPairs: new Set(snap.expandedPairs),
        ui: restoreUi(s.ui, snap.ui),
        filter: snap.filter,
        sort: snap.sort,
        limits: { ...snap.limits },
      },
      entry.effect ? { snap: snapshot(s), effect: entry.effect } : { snap: snapshot(s) },
    ];
  };

  /** `guardLive` for the store's own graph-changing actions. */
  const live = (run: () => void) => get().guardLive(run);

  return {
    ...initial(),
    epoch: 0,
    freeze: (frozen) => set({ frozen }),
    unfreeze: () => {
      if (!get().frozen) return;
      // The file's assets (symbol, decimals, trust) must not linger in the live filter list.
      useAssetRegistry.getState().clear();
      set({ frozen: null });
      unfreezeHandler?.(get().centers);
    },
    guardLive: (run) => {
      if (get().frozen) set({ pendingLive: run });
      else run();
    },
    resolveLive: (go) => {
      const run = get().pendingLive;
      set({ pendingLive: null });
      if (!go || !run) return;
      get().unfreeze();
      run();
    },
    addCenter: (a) =>
      live(() => {
        const addr = lc(a);
        if (get().centers.includes(addr)) return;
        tracked((s) => ({ centers: [...s.centers, addr], limits: withFirstBatch(s.limits, [addr]) }));
      }),
    revealCenter: (a) => get().revealCenters([a]),
    revealCenters: (list) => live(() => {
      const s = get();
      const addrs = [...new Set(list.map(lc))];
      const added = addrs.filter((a) => !s.centers.includes(a));
      const hidden = addrs.filter((a) => !!s.ui[a]?.hidden);
      if (added.length === 0 && hidden.length === 0) return;
      tracked((cur) => ({
        centers: added.length > 0 ? [...cur.centers, ...added] : cur.centers,
        ui: hidden.length > 0 ? applyUiPatch(cur.ui, hidden, { hidden: false }) : cur.ui,
        limits: withFirstBatch(cur.limits, addrs),
      }));
    }),
    removeCenter: (a) =>
      live(() => {
        const addr = lc(a);
        if (!get().centers.includes(addr)) return;
        tracked((s) => ({ centers: s.centers.filter((c) => c !== addr) }));
      }),
    setCenters: (list) =>
      live(() =>
        tracked((s) => {
          const centers = [...new Set(list.map(lc))];
          return { centers, limits: withFirstBatch(s.limits, centers) };
        }),
      ),
    expand: (addresses, batch, k) => live(() => {
      const addrs = [...new Set(addresses.map(lc))];
      if (addrs.length === 0) return;
      tracked(
        (s) => {
          const fresh = addrs.filter((a) => !s.centers.includes(a));
          const hidden = addrs.filter((a) => s.ui[a]?.hidden);
          const limits = { ...s.limits };
          for (const a of fresh) limits[a] = k;
          return {
            centers: [...s.centers, ...fresh],
            limits: withFirstBatch(limits, addrs),
            ui: hidden.length > 0 ? applyUiPatch(s.ui, hidden, { hidden: false }) : s.ui,
          };
        },
        { kind: "expand", batch, addresses: addrs },
      );
    }),
    raiseLimit: (center, by) => live(() => {
      if (!(Number.isFinite(by) && by > 0)) return;
      const a = lc(center);
      const cur = get().limits[a] ?? firstBatch();
      if (cur >= MAX_NEIGHBOUR_LIMIT) return;
      tracked((s) => ({ limits: { ...s.limits, [a]: Math.min(MAX_NEIGHBOUR_LIMIT, (s.limits[a] ?? cur) + by) } }));
    }),
    setFilter: (f) => live(() => tracked(() => ({ filter: f }))),
    setSort: (sort) => live(() => tracked(() => ({ sort }))),
    applyFilter: (f, sort) => live(() => tracked(() => ({ filter: f, sort }))),
    togglePair: (a, b) =>
      live(() =>
        tracked((s) => {
          const key = pairKey(a, b);
          const next = new Set(s.expandedPairs);
          if (!next.delete(key)) next.add(key);
          return { expandedPairs: next };
        }),
      ),
    setPinned: (addrs, v) => tracked((s) => ({ ui: applyUiPatch(s.ui, addrs, { pinned: v }) })),
    setHidden: (addrs, v) =>
      tracked((s) => {
        const ui = applyUiPatch(s.ui, addrs, { hidden: v });
        if (!v) return { ui };
        const gone = new Set(addrs.map(lc));
        const centers = s.centers.filter((c) => !gone.has(c));
        return centers.length === s.centers.length ? { ui } : { ui, centers };
      }),
    setNote: (a, note) => tracked((s) => ({ ui: applyUiPatch(s.ui, [a], { note }) })),
    setPositions: (p) =>
      set((s) => {
        const ui = { ...s.ui };
        const proxyPos = { ...s.proxyPos };
        for (const [k, pos] of Object.entries(p)) {
          const id = lc(k);
          if (id.startsWith(MORE_PREFIX)) proxyPos[id.slice(MORE_PREFIX.length)] = pos;
          else ui[id] = { ...(ui[id] ?? blankUi()), pos };
        }
        return { ui, proxyPos };
      }),
    commitMove: (prev) =>
      set((s) => {
        const positions: Record<string, Pos> = {};
        for (const [k, p] of Object.entries(prev)) positions[lc(k)] = p;
        return { _past: pushCapped(s._past, { positions }), _future: [] };
      }),
    clearProxyPositions: () => set((s) => (Object.keys(s.proxyPos).length === 0 ? {} : { proxyPos: {} })),
    pruneProxyPositions: (shown) =>
      set((s) => {
        const keep = new Set([...shown].map(lc));
        const gone = Object.keys(s.proxyPos).filter((c) => !keep.has(c));
        if (gone.length === 0) return {};
        const proxyPos = { ...s.proxyPos };
        for (const c of gone) delete proxyPos[c];
        return { proxyPos };
      }),
    // A selection change ends any transfer-row highlight.
    select: (selection) => set({ selection, highlightTransfer: null }),
    setHighlightTransfer: (highlightTransfer) => set({ highlightTransfer }),
    focusNeighborhood: (a, neighbors, allNodes = []) =>
      tracked((s) => {
        const keep = new Set([lc(a), ...neighbors.map(lc)]);
        const known = new Set([...s.centers, ...Object.keys(s.ui), ...allNodes.map(lc), ...keep]);
        const ui = { ...s.ui };
        for (const k of known) ui[k] = { ...(ui[k] ?? blankUi()), hidden: !keep.has(k) };
        return { ui };
      }),
    undo: () => {
      const s = get();
      const entry = s._past[s._past.length - 1];
      if (!entry) return;
      if (s.frozen && changesGraph(s, entry)) return live(() => get().undo());
      const [patch, counter] = applyEntry(s, entry);
      set({
        ...patch,
        _past: s._past.slice(0, -1),
        _future: pushCapped(s._future, counter),
      });
      if (entry.effect) runUndoEffect(entry.effect);
    },
    redo: () => {
      const s = get();
      const entry = s._future[s._future.length - 1];
      if (!entry) return;
      if (s.frozen && changesGraph(s, entry)) return live(() => get().redo());
      const [patch, counter] = applyEntry(s, entry);
      set({
        ...patch,
        _future: s._future.slice(0, -1),
        _past: pushCapped(s._past, counter),
      });
      if (!entry.effect) return;
      const effect = runRedoEffect(entry.effect);
      if (effect === entry.effect) return;
      // The redone step now carries the new effect (e.g. its new batch), so a later undo cancels that one.
      set((cur) => {
        const top = cur._past[cur._past.length - 1];
        if (top !== counter) return {};
        return { _past: [...cur._past.slice(0, -1), { ...counter, effect }] };
      });
    },
    canUndo: () => get()._past.length > 0,
    canRedo: () => get()._future.length > 0,
    reset: () => {
      useAssetRegistry.getState().clear();
      set({ ...initial(), epoch: get().epoch + 1 });
    },
    loadSnapshot: (v) => {
      useAssetRegistry.getState().clear();
      const ui: Record<string, NodeUi> = {};
      for (const [k, u] of Object.entries(v.ui)) ui[lc(k)] = { ...u };
      const centers = [...new Set(v.centers.map(lc))];
      const limits: Record<string, number> = {};
      for (const [k, n] of Object.entries(v.limits ?? {})) limits[lc(k)] = n;
      set({
        ...initial(),
        epoch: get().epoch + 1,
        centers,
        limits: withFirstBatch(limits, centers, { fresh: true }),
        filter: v.filter,
        sort: v.sort ?? "count",
        expandedPairs: new Set(v.expandedPairs),
        ui,
      });
    },
  };
});
