import { create } from "zustand";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { useAssetRegistry } from "./assetRegistry";
import { nodeBudget, nodeCapacity, perCenterBatch } from "./budget";
import { useCanvasMetrics } from "./canvasMetrics";
import { transferKey, type HiddenTransfer } from "./hiddenTransfers";
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
  /**
   * Neighbours picked by hand per center (lowercase keys and values; kept after a center is removed, like `limits`).
   * A center with an entry (even `[]`) is picked: it shows exactly these neighbours. A center without one (from an
   * older workspace or file) keeps its top-k `limits`. Only centers' entries are sent.
   */
  picks: Record<string, string[]>;
  /**
   * Centers (lowercase) whose "+N more" proxy the user hid. History-tracked and saved with the workspace; a center
   * that is removed or hidden leaves it (so it comes back with its proxy).
   */
  hiddenProxies: string[];
  /**
   * Transfers hidden on the Data tab, keyed by `transferKey`: taken out of the canvas edges, muted in the transfer
   * table. History-tracked and saved with the workspace; never part of the graph query.
   */
  hiddenTransfers: Record<string, HiddenTransfer>;
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
  /**
   * Back to live data (the graph query runs again; the file's assets leave the registry); the unfreeze handler syncs
   * the centers never synced here. No-op when live.
   */
  unfreeze(): void;
  /**
   * Runs `run` at once when live; on a snapshot, keeps it for a confirm instead ("Refresh from chain first?").
   * Every action that changes centers, expanded pairs, filter, sort, limits or batches goes through this.
   */
  guardLive(run: () => void): void;
  /** Answers the confirm: true refreshes (unfreezes) and then runs the pending action; false drops it. */
  resolveLive(go: boolean): void;
  /**
   * New centers (here and in `revealCenter(s)`/`setCenters`/`expand`) with neither a limit nor picks start picked with
   * none (`picks[a] = []`); a re-added center keeps its entry.
   */
  addCenter(a: string): void;
  /** Makes `a` a shown center (adds it and/or unhides it) in one history step; no-op if it already is. */
  revealCenter(a: string): void;
  /**
   * `revealCenter` for several addresses, as one history step. `alone`: each address that was not a shown center comes
   * with no neighbour, picked with none (`picks[a] = []`), even with a limit or picks left from before (spec §5.1).
   */
  revealCenters(a: string[], opts?: { alone?: boolean }): void;
  removeCenter(a: string): void;
  setCenters(a: string[]): void;
  /**
   * Adds `addresses` as shown centers in one history step whose undo/redo runs the batch's effect. New ones start picked
   * with none; a re-added center from an older workspace (a limit, no picks) gets limit `k`; existing centers keep theirs.
   */
  expand(addresses: string[], batch: string, k: number): void;
  /**
   * Sets the picks of each key of `next` in one history step: each key becomes a shown center, every listed address is
   * unhidden, and an address that left a key's list and is then kept by no center and not a center is hidden.
   * `previous` is each center's own list before the change (`ownNeighbours` when the picker opened); it serves this
   * hiding rule only: an address in `previous[k]` but not in `next[k]` left k's list too (a legacy top-k center has no
   * picks to compare with), and a center that still has no picks keeps the addresses of its `previous` list.
   * "Kept" means: in a picked center's list, or in the `previous` list of a center without picks.
   */
  applyPicks(next: Record<string, string[]>, previous?: Record<string, string[]>): void;
  setFilter(f: EdgeFilterDto): void;
  setSort(s: SortKey): void;
  /** Sets filter and sort as ONE history step. */
  applyFilter(f: EdgeFilterDto, sort: SortKey): void;
  togglePair(a: string, b: string): void;
  setPinned(addrs: string[], v: boolean): void;
  /**
   * Hiding a center also drops it from `centers`, and hiding any address drops it from every picks list (same history
   * step), so neighbours do not linger alone and a hidden pick counts as unchecked.
   */
  setHidden(addrs: string[], v: boolean): void;
  setNote(a: string, note: string): void;
  /** Hides (or shows again) the "+N more" proxies of `centers`, as one history step; no-op when nothing changes. */
  setProxiesHidden(centers: string[], hidden: boolean): void;
  /** Hides (or shows again) `list`, as one history step however many it holds; no-op when nothing changes. */
  setTransfersHidden(list: HiddenTransfer[], hidden: boolean): void;
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
    /** Absent in older workspaces and files: their centers keep top-k. */
    picks?: Record<string, string[]>;
    /** Dragged "+N more" positions by center; entries of other addresses are dropped. */
    proxyPos?: Record<string, Pos>;
    /** Centers whose "+N more" is hidden; entries of other addresses are dropped. */
    hiddenProxies?: string[];
    /** Transfers hidden on the Data tab. Absent in older workspaces: none. */
    hiddenTransfers?: HiddenTransfer[];
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
  picks: Record<string, string[]>;
  hiddenProxies: string[];
  hiddenTransfers: Record<string, HiddenTransfer>;
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

/**
 * Called with the centers when a snapshot graph goes live (the app syncs the never-synced ones: the refresh confirm is
 * the click, and says how many). The store has no network code.
 */
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
  const samePicks = (a: Record<string, string[]>, b: Record<string, string[]>) =>
    Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, l]) => b[k]?.join(",") === l.join(","));
  return (
    snap.centers.join(",") !== s.centers.join(",") ||
    !sameSet(snap.expandedPairs, s.expandedPairs) ||
    snap.filter !== s.filter ||
    snap.sort !== s.sort ||
    !sameLimits(snap.limits, s.limits) ||
    !samePicks(snap.picks, s.picks)
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

/**
 * `picks` with an empty list for each of `addrs` (lowercase) that has neither a limit nor picks: a new center starts
 * picked with none. The same object when nothing is missing.
 */
function withNoPicks(
  limits: Record<string, number>,
  picks: Record<string, string[]>,
  addrs: string[],
): Record<string, string[]> {
  const missing = addrs.filter((a) => limits[a] === undefined && picks[a] === undefined);
  if (missing.length === 0) return picks;
  const next = { ...picks };
  for (const a of missing) next[a] = [];
  return next;
}

/** Lowercase and deduplicated, in order. */
const cleanList = (l: string[]) => [...new Set(l.map(lc))];

/** `picks` with every address of `gone` dropped from every list; the same object when no list changes. */
function withoutPicked(picks: Record<string, string[]>, gone: Set<string>): Record<string, string[]> {
  let next: Record<string, string[]> | null = null;
  for (const [k, l] of Object.entries(picks)) {
    if (!l.some((a) => gone.has(a))) continue;
    next ??= { ...picks };
    next[k] = l.filter((a) => !gone.has(a));
  }
  return next ?? picks;
}

/** `list` without the centers in `gone`; the same array when none of them is in it. */
function withoutCenters(list: string[], gone: Set<string>): string[] {
  return list.some((c) => gone.has(c)) ? list.filter((c) => !gone.has(c)) : list;
}

/**
 * The neighbours `center` brings into the graph: its picks when picked, else (a top-k center) its neighbours on the
 * edges of `data` that are not hidden.
 */
export function ownNeighbours(center: string, data: GraphResponseDto | undefined): string[] {
  const c = lc(center);
  const { picks, ui } = useGraph.getState();
  const picked = picks[c];
  if (picked) return picked;
  const out = new Set<string>();
  for (const e of data?.edges ?? []) {
    const other = e.from === c ? e.to : e.to === c ? e.from : null;
    if (other && other !== c && !ui[other]?.hidden) out.add(other);
  }
  return [...out];
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
    picks: { ...s.picks },
    hiddenProxies: [...s.hiddenProxies],
    hiddenTransfers: s.hiddenTransfers,
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
  picks: {} as Record<string, string[]>,
  hiddenProxies: [] as string[],
  hiddenTransfers: {} as Record<string, HiddenTransfer>,
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
      // Copied only when an address moves: a proxy-only step leaves `ui` (what a workspace saves) alone.
      const ui = Object.keys(entry.positions).some((k) => !k.startsWith(MORE_PREFIX)) ? { ...s.ui } : s.ui;
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
        picks: { ...snap.picks },
        hiddenProxies: [...snap.hiddenProxies],
        hiddenTransfers: snap.hiddenTransfers,
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
        tracked((s) => ({ centers: [...s.centers, addr], picks: withNoPicks(s.limits, s.picks, [addr]) }));
      }),
    revealCenter: (a) => get().revealCenters([a]),
    revealCenters: (list, opts) => live(() => {
      const s = get();
      const addrs = [...new Set(list.map(lc))];
      const added = addrs.filter((a) => !s.centers.includes(a));
      const hidden = addrs.filter((a) => !!s.ui[a]?.hidden);
      if (added.length === 0 && hidden.length === 0) return;
      const alone = opts?.alone ? [...new Set([...added, ...hidden])] : [];
      tracked((cur) => ({
        centers: added.length > 0 ? [...cur.centers, ...added] : cur.centers,
        ui: hidden.length > 0 ? applyUiPatch(cur.ui, hidden, { hidden: false }) : cur.ui,
        picks: alone.length > 0
          ? { ...withNoPicks(cur.limits, cur.picks, addrs), ...Object.fromEntries(alone.map((a) => [a, [] as string[]])) }
          : withNoPicks(cur.limits, cur.picks, addrs),
      }));
    }),
    removeCenter: (a) =>
      live(() => {
        const addr = lc(a);
        if (!get().centers.includes(addr)) return;
        tracked((s) => ({
          centers: s.centers.filter((c) => c !== addr),
          hiddenProxies: withoutCenters(s.hiddenProxies, new Set([addr])),
        }));
      }),
    setCenters: (list) =>
      live(() =>
        tracked((s) => {
          const centers = [...new Set(list.map(lc))];
          const gone = new Set(s.centers.filter((c) => !centers.includes(c)));
          return {
            centers,
            picks: withNoPicks(s.limits, s.picks, centers),
            hiddenProxies: withoutCenters(s.hiddenProxies, gone),
          };
        }),
      ),
    expand: (addresses, batch, k) => live(() => {
      const addrs = [...new Set(addresses.map(lc))];
      if (addrs.length === 0) return;
      tracked(
        (s) => {
          const fresh = addrs.filter((a) => !s.centers.includes(a));
          const hidden = addrs.filter((a) => s.ui[a]?.hidden);
          // Only a re-added top-k center (a limit, no picks) takes `k`; every other new center starts picked with none.
          const legacy = fresh.filter((a) => s.limits[a] !== undefined && s.picks[a] === undefined);
          const limits = legacy.length > 0 ? { ...s.limits } : s.limits;
          for (const a of legacy) limits[a] = k;
          return {
            centers: [...s.centers, ...fresh],
            limits,
            picks: withNoPicks(limits, s.picks, addrs),
            ui: hidden.length > 0 ? applyUiPatch(s.ui, hidden, { hidden: false }) : s.ui,
          };
        },
        { kind: "expand", batch, addresses: addrs },
      );
    }),
    applyPicks: (next, previous) => live(() => {
      const entries = Object.entries(next).map(([k, l]) => [lc(k), cleanList(l)] as const);
      if (entries.length === 0) return;
      const before: Record<string, string[]> = {};
      for (const [k, l] of Object.entries(previous ?? {})) before[lc(k)] = cleanList(l);
      tracked((s) => {
        const keys = entries.map(([k]) => k);
        const centers = [...s.centers, ...cleanList(keys).filter((k) => !s.centers.includes(k))];
        const picks = { ...s.picks };
        const dropped = new Set<string>();
        for (const [k, l] of entries) {
          const keep = new Set(l);
          for (const a of [...(s.picks[k] ?? []), ...(before[k] ?? [])]) if (!keep.has(a)) dropped.add(a);
          picks[k] = l;
        }
        const isCenter = new Set(centers);
        // A picked center keeps its list; a legacy (top-k) center keeps the neighbours it showed.
        const kept = new Set(centers.flatMap((c) => picks[c] ?? before[c] ?? []));
        const hide = [...dropped].filter((a) => !isCenter.has(a) && !kept.has(a));
        const show = [...new Set([...keys, ...entries.flatMap(([, l]) => l)])].filter((a) => !!s.ui[a]?.hidden);
        let ui = s.ui;
        if (show.length > 0) ui = applyUiPatch(ui, show, { hidden: false });
        if (hide.length > 0) ui = applyUiPatch(ui, hide, { hidden: true });
        return { centers, picks, ui };
      });
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
        const picks = withoutPicked(s.picks, gone);
        const hiddenProxies = withoutCenters(s.hiddenProxies, gone);
        return {
          ui,
          ...(centers.length === s.centers.length ? {} : { centers }),
          ...(picks === s.picks ? {} : { picks }),
          ...(hiddenProxies === s.hiddenProxies ? {} : { hiddenProxies }),
        };
      }),
    setNote: (a, note) => tracked((s) => ({ ui: applyUiPatch(s.ui, [a], { note }) })),
    setProxiesHidden: (list, hidden) => {
      const cur = get().hiddenProxies;
      const addrs = cleanList(list);
      const next = hidden ? [...cur, ...addrs.filter((a) => !cur.includes(a))] : withoutCenters(cur, new Set(addrs));
      if (next.length === cur.length) return;
      tracked(() => ({ hiddenProxies: next }));
    },
    setTransfersHidden: (list, hidden) => {
      const cur = get().hiddenTransfers;
      const keys = list.map(transferKey);
      const change = hidden ? keys.some((k) => !(k in cur)) : keys.some((k) => k in cur);
      if (!change) return;
      const next = { ...cur };
      list.forEach((h, i) => {
        if (hidden) next[keys[i]!] ??= h;
        else delete next[keys[i]!];
      });
      tracked(() => ({ hiddenTransfers: next }));
    },
    setPositions: (p) =>
      set((s) => {
        const ui = Object.keys(p).some((k) => !lc(k).startsWith(MORE_PREFIX)) ? { ...s.ui } : s.ui;
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
    clearProxyPositions: () => set((s) => (Object.keys(s.proxyPos).length === 0 ? s : { proxyPos: {} })),
    pruneProxyPositions: (shown) =>
      set((s) => {
        const keep = new Set([...shown].map(lc));
        const gone = Object.keys(s.proxyPos).filter((c) => !keep.has(c));
        // The same state: no update, no listener runs (this is called on every canvas change).
        if (gone.length === 0) return s;
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
      const picks: Record<string, string[]> = {};
      for (const [k, l] of Object.entries(v.picks ?? {})) picks[lc(k)] = cleanList(l);
      const proxyPos: Record<string, Pos> = {};
      for (const [k, p] of Object.entries(v.proxyPos ?? {})) if (centers.includes(lc(k))) proxyPos[lc(k)] = p;
      const hiddenProxies = cleanList(v.hiddenProxies ?? []).filter((c) => centers.includes(c));
      const hiddenTransfers: Record<string, HiddenTransfer> = {};
      for (const h of v.hiddenTransfers ?? []) {
        hiddenTransfers[transferKey(h)] = {
          ...h,
          tx_hash: lc(h.tx_hash),
          from: lc(h.from),
          to: lc(h.to),
          asset: h.asset === null ? null : lc(h.asset),
        };
      }
      set({
        ...initial(),
        epoch: get().epoch + 1,
        centers,
        proxyPos,
        hiddenProxies,
        hiddenTransfers,
        // Top-k centers without a limit (older states) get a first batch; picked ones need none.
        limits: withFirstBatch(limits, centers.filter((c) => picks[c] === undefined), { fresh: true }),
        picks,
        filter: v.filter,
        sort: v.sort ?? "count",
        expandedPairs: new Set(v.expandedPairs),
        ui,
      });
    },
  };
});
