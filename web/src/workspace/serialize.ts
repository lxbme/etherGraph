import { t } from "../i18n";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import type { HiddenTransfer } from "../graph/hiddenTransfers";
import { withFirstBatch, type GraphState, type Pos, type SortKey } from "../graph/store";
import type { TxDetailTab, TxView } from "../shell/tabs";
import { isGraphSnapshot, isTxSnapshot, type GraphSnapshot, type TxSnapshot } from "./snapshot";

export interface WorkspaceStateV1 {
  nodes: { address: string; x?: number; y?: number; pinned: boolean; hidden: boolean; note: string }[];
  centers: string[];
  expanded_pairs: [string, string][];
  filter: EdgeFilterDto;
  /** Absent in older states: means "count". */
  sort?: SortKey;
  /** Neighbour limit per center. Absent in older states; centers without one get a first batch on load. */
  limits?: Record<string, number>;
  /** Dragged "+N more" node positions by center. Absent when none was dragged and in older states. */
  proxies?: Record<string, Pos>;
  /** Neighbours picked per center (a center with an entry, even an empty one, shows exactly those). Absent in older states: their centers keep top-k. */
  picks?: Record<string, string[]>;
  /** Centers whose "+N more" is hidden. Absent when none is, and in older states. */
  hidden_proxies?: string[];
  /** Transfers hidden on the Data tab. Absent when none is, and in older states. */
  hidden_transfers?: HiddenTransfer[];
  viewport: { zoom: number; pan: { x: number; y: number } };
}

export type Viewport = { zoom: number; pan: { x: number; y: number } };

/** An open transaction tab: its view, its detail section and the layouts of its flow and call graphs. */
export interface TxTabStateV2 {
  hash: string;
  /** Written only for the call tree; absent (older states too) means the asset flow. */
  view?: TxView;
  detail_tab?: TxDetailTab;
  positions?: Record<string, Pos>;
  viewport?: Viewport;
  /** Call-graph node positions. Absent when the call graph was never drawn or moved, and in older states. */
  call_positions?: Record<string, Pos>;
  snapshot?: TxSnapshot;
}

export interface WorkspaceStateV2 {
  graph: WorkspaceStateV1 & { snapshot?: GraphSnapshot };
  tabs: TxTabStateV2[];
  /** "graph", "data" or the hash of one of `tabs`. */
  active: string;
}

export const DEFAULT_VIEWPORT: WorkspaceStateV1["viewport"] = { zoom: 1, pan: { x: 0, y: 0 } };
export const SCHEMA_VERSION = 2;

export interface SerializeOpts {
  /** Addresses currently on the canvas (e.g. the live Cytoscape nodes); centers are always included. */
  nodes?: string[];
  /** Live layout positions (win over the store's dragged `ui.pos`). */
  positions?: Record<string, Pos>;
}

const lc = (s: string) => s.toLowerCase();

export function serialize(
  state: Pick<GraphState, "centers" | "filter" | "sort" | "expandedPairs" | "ui" | "limits" | "picks" | "proxyPos" | "hiddenProxies" | "hiddenTransfers">,
  viewport: WorkspaceStateV1["viewport"],
  opts: SerializeOpts = {},
): WorkspaceStateV1 {
  const flagged = Object.keys(state.ui)
    .filter((k) => {
      const u = state.ui[k]!;
      return u.pinned || u.hidden || u.note !== "";
    })
    .sort();
  const addrs = [...new Set([...state.centers, ...(opts.nodes ?? []), ...flagged].map(lc))];
  const positions: Record<string, Pos> = {};
  for (const [k, p] of Object.entries(opts.positions ?? {})) positions[lc(k)] = p;
  const proxies = Object.fromEntries(
    state.centers.flatMap((c) => {
      const p = state.proxyPos[c];
      return p === undefined ? [] : [[c, { x: p.x, y: p.y }]];
    }),
  );
  const picks = Object.fromEntries(
    state.centers.flatMap((c) => {
      const l = state.picks[c];
      return l === undefined ? [] : [[c, [...l]]];
    }),
  );
  const hiddenProxies = state.hiddenProxies.filter((c) => state.centers.includes(c));
  const hiddenTransfers = Object.values(state.hiddenTransfers).map((h) => ({ ...h }));
  return {
    nodes: addrs.map((address) => {
      const u = state.ui[address];
      const pos = positions[address] ?? u?.pos;
      return {
        address,
        ...(pos ? { x: pos.x, y: pos.y } : {}),
        pinned: u?.pinned ?? false,
        hidden: u?.hidden ?? false,
        note: u?.note ?? "",
      };
    }),
    centers: [...state.centers],
    expanded_pairs: [...state.expandedPairs].map((k) => k.split("|") as [string, string]),
    filter: state.filter,
    sort: state.sort,
    limits: Object.fromEntries(
      state.centers.flatMap((c) => {
        const n = state.limits[c];
        return n === undefined ? [] : [[c, n]];
      }),
    ),
    ...(Object.keys(picks).length > 0 ? { picks } : {}),
    ...(Object.keys(proxies).length > 0 ? { proxies } : {}),
    ...(hiddenProxies.length > 0 ? { hidden_proxies: hiddenProxies } : {}),
    ...(hiddenTransfers.length > 0 ? { hidden_transfers: hiddenTransfers } : {}),
    viewport: { zoom: viewport.zoom, pan: { ...viewport.pan } },
  };
}

const SORTS: readonly string[] = ["count", "amount", "recent"];
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isPicks = (v: unknown): v is Record<string, string[]> =>
  isObj(v) && Object.entries(v).every(([k, l]) => ADDRESS.test(k) && isStrArr(l) && l.every((a) => ADDRESS.test(a)));
const isLimit = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;

const DETAIL_TABS: readonly string[] = ["overview", "input", "transfers", "internal", "logs", "raw"];
const TX_VIEWS: readonly string[] = ["flow", "calls"];
const TX_HASH = /^0x[0-9a-f]{64}$/i;
const isViewport = (v: unknown): v is Viewport =>
  isObj(v) && isNum(v.zoom) && v.zoom > 0 && isObj(v.pan) && isNum(v.pan.x) && isNum(v.pan.y);
const isPositions = (v: unknown): v is Record<string, Pos> =>
  isObj(v) && Object.values(v).every((p) => isObj(p) && isNum(p.x) && isNum(p.y));
const TRANSFER_KINDS: readonly string[] = ["native", "internal", "erc20", "erc721", "erc1155"];
/** A saved hidden transfer: a tx hash, addresses, a raw integer amount and a known kind. */
const isHiddenTransfer = (v: unknown): v is HiddenTransfer =>
  isObj(v) &&
  isStr(v.tx_hash) && TX_HASH.test(v.tx_hash) &&
  isStr(v.sub_id) &&
  isStr(v.from) && ADDRESS.test(v.from) &&
  isStr(v.to) && ADDRESS.test(v.to) &&
  (v.asset === null || (isStr(v.asset) && ADDRESS.test(v.asset))) &&
  isStr(v.amount) && /^\d+$/.test(v.amount) &&
  isStr(v.ts) &&
  isStr(v.kind) && TRANSFER_KINDS.includes(v.kind);

type Parsed<T> = { ok: true; state: T } | { ok: false; reason: string };
const bad = (reason: string) => ({ ok: false as const, reason });

/** Validates a saved state of `schemaVersion` (1: the graph alone, which opens with no tx tabs). */
export function deserialize(v: unknown, schemaVersion: number): Parsed<WorkspaceStateV2> {
  if (schemaVersion === 1) {
    const r = deserializeGraph(v);
    return r.ok ? { ok: true, state: { graph: r.state, tabs: [], active: "graph" } } : r;
  }
  if (schemaVersion !== SCHEMA_VERSION) return bad(t("ws.err.version"));
  if (!isObj(v)) return bad(t("ws.err.data"));
  const graph = deserializeGraph(v.graph);
  if (!graph.ok) return graph;
  if (!Array.isArray(v.tabs)) return bad(t("ws.err.field", { field: "tabs" }));
  const tabs: TxTabStateV2[] = [];
  for (const tab of v.tabs as unknown[]) {
    if (!isObj(tab) || !isStr(tab.hash) || !TX_HASH.test(tab.hash)) return bad(t("ws.err.field", { field: "tabs" }));
    const hash = lc(tab.hash);
    if (tabs.some((x) => x.hash === hash)) return bad(t("ws.err.field", { field: "tabs" }));
    if (tab.view !== undefined && !(isStr(tab.view) && TX_VIEWS.includes(tab.view))) return bad(t("ws.err.field", { field: "view" }));
    if (tab.detail_tab !== undefined && !(isStr(tab.detail_tab) && DETAIL_TABS.includes(tab.detail_tab))) {
      return bad(t("ws.err.field", { field: "detail_tab" }));
    }
    if (tab.positions !== undefined && !isPositions(tab.positions)) return bad(t("ws.err.field", { field: "positions" }));
    if (tab.viewport !== undefined && !isViewport(tab.viewport)) return bad(t("ws.err.field", { field: "viewport" }));
    if (tab.call_positions !== undefined && !isPositions(tab.call_positions)) {
      return bad(t("ws.err.field", { field: "call_positions" }));
    }
    if (tab.snapshot !== undefined && !isTxSnapshot(tab.snapshot)) return bad(t("ws.err.field", { field: "snapshot" }));
    tabs.push({ ...(tab as unknown as TxTabStateV2), hash });
  }
  const active = isStr(v.active) ? lc(v.active) : null;
  if (active === null || (active !== "graph" && active !== "data" && !tabs.some((x) => x.hash === active))) {
    return bad(t("ws.err.field", { field: "active" }));
  }
  return { ok: true, state: { graph: graph.state, tabs, active } };
}

/** Validates the graph part (a v1 state, plus an optional `snapshot`); unknown fields are kept as they are. */
function deserializeGraph(v: unknown): Parsed<WorkspaceStateV1 & { snapshot?: GraphSnapshot }> {
  if (!isObj(v)) return bad(t("ws.err.data"));
  const { nodes, centers, expanded_pairs, filter, viewport } = v;
  if (!Array.isArray(nodes)) return bad(t("ws.err.field", { field: "nodes" }));
  for (const n of nodes) {
    if (!isObj(n) || !isStr(n.address)) return bad(t("ws.err.nodeAddress"));
    if (typeof n.pinned !== "boolean" || typeof n.hidden !== "boolean" || !isStr(n.note)) {
      return bad(t("ws.err.nodeProps"));
    }
    if ((n.x !== undefined && !isNum(n.x)) || (n.y !== undefined && !isNum(n.y))) return bad(t("ws.err.nodeCoords"));
  }
  if (!isStrArr(centers)) return bad(t("ws.err.field", { field: "centers" }));
  if (!Array.isArray(expanded_pairs) || !expanded_pairs.every((p) => isStrArr(p) && p.length === 2)) {
    return bad(t("ws.err.field", { field: "expanded_pairs" }));
  }
  if (!isObj(filter) || (filter.hide_suspicious != null && typeof filter.hide_suspicious !== "boolean")) {
    return bad(t("ws.err.field", { field: "filter" }));
  }
  if (v.sort !== undefined && !(isStr(v.sort) && SORTS.includes(v.sort))) return bad(t("ws.err.field", { field: "sort" }));
  if (!isObj(viewport) || !isNum(viewport.zoom) || !isObj(viewport.pan) || !isNum(viewport.pan.x) || !isNum(viewport.pan.y)) {
    return bad(t("ws.err.field", { field: "viewport" }));
  }
  if (v.limits !== undefined && !(isObj(v.limits) && Object.values(v.limits).every(isLimit))) {
    return bad(t("ws.err.field", { field: "limits" }));
  }
  if (v.picks !== undefined && !isPicks(v.picks)) return bad(t("ws.err.field", { field: "picks" }));
  if (v.proxies !== undefined && !isPositions(v.proxies)) return bad(t("ws.err.field", { field: "proxies" }));
  if (v.hidden_proxies !== undefined && !isStrArr(v.hidden_proxies)) return bad(t("ws.err.field", { field: "hidden_proxies" }));
  if (v.hidden_transfers !== undefined && !(Array.isArray(v.hidden_transfers) && v.hidden_transfers.every(isHiddenTransfer))) {
    return bad(t("ws.err.field", { field: "hidden_transfers" }));
  }
  if (v.snapshot !== undefined && !isGraphSnapshot(v.snapshot)) return bad(t("ws.err.field", { field: "snapshot" }));
  // Centers saved without a limit (older states) get the first batch of a new center.
  const stored: Record<string, number> = {};
  for (const [k, n] of Object.entries((v.limits ?? {}) as Record<string, number>)) stored[lc(k)] = n;
  // The batch is shared by all of them, over an empty canvas (ruling R12).
  // Picked centers need none: they show exactly their picks.
  const picks: Record<string, string[]> = {};
  for (const [k, l] of Object.entries((v.picks ?? {}) as Record<string, string[]>)) picks[lc(k)] = l.map(lc);
  const limits = withFirstBatch(stored, centers.map(lc).filter((c) => picks[c] === undefined), { fresh: true });
  const next = { ...(v as unknown as WorkspaceStateV1), limits };
  if (v.picks !== undefined) next.picks = picks;
  if (v.proxies !== undefined) {
    next.proxies = {};
    for (const [k, p] of Object.entries(v.proxies as Record<string, Pos>)) next.proxies[lc(k)] = p;
  }
  if (v.hidden_proxies !== undefined) next.hidden_proxies = (v.hidden_proxies as string[]).map(lc);
  return { ok: true, state: next };
}
