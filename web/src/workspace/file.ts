import { api } from "../api/endpoints";
import type { CallFrameDto } from "../api/generated/CallFrameDto";
import type { CallTraceResponseDto } from "../api/generated/CallTraceResponseDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { LabelDto } from "../api/generated/LabelDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TxResponseDto } from "../api/generated/TxResponseDto";
import { qk, queryClient } from "../api/queryClient";
import { useGraph } from "../graph/store";
import { graphQueryKey } from "../graph/useGraphData";
import { t } from "../i18n";
import { safeFileName } from "../lib/download";
import { useTabs } from "../shell/tabs";
import { toast } from "../shell/Toasts";
import { DEFAULT_VIEWPORT, deserialize, SCHEMA_VERSION, type TxTabStateV2, type WorkspaceStateV1, type WorkspaceStateV2 } from "./serialize";
import { FILE_SOURCE, type GraphSnapshot, type SnapshotMeta, type TxSnapshot } from "./snapshot";
import { captureState, openTxTab, openUnsaved, useWorkspace } from "./useWorkspace";

/**
 * An exported view or workspace: the views' data travels with it as snapshots, so the receiver sees it without
 * syncing anything.
 */
export interface EtherGraphFileV1 {
  format: "ethergraph";
  version: 1;
  kind: FileKind;
  exported_at: string;
  includes: FileIncludes;
  /** Every included view carries its snapshot; kind "tx": the graph is the empty state and `tabs` has one entry. */
  state: WorkspaceStateV2;
}
export type FileKind = "workspace" | "graph" | "tx";
export type FileIncludes = SnapshotMeta["includes"];

const FORMAT = "ethergraph";
const VERSION = 1;
const KINDS: readonly string[] = ["workspace", "graph", "tx"];
/** Largest file accepted (a graph of several hundred nodes is far below it). */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MIB = MAX_FILE_BYTES / (1024 * 1024);

const lc = (s: string) => s.toLowerCase();

// ---- export ----

/** The graph part of a tx file. */
const emptyGraph = (): WorkspaceStateV1 => ({
  nodes: [],
  centers: [],
  expanded_pairs: [],
  filter: {},
  sort: "count",
  limits: {},
  viewport: { zoom: DEFAULT_VIEWPORT.zoom, pan: { ...DEFAULT_VIEWPORT.pan } },
});

/** The graph with its snapshot: the frozen one as it is, else the data on screen (none for an empty graph). */
function withGraphSnapshot(graph: WorkspaceStateV2["graph"], meta: SnapshotMeta): WorkspaceStateV2["graph"] {
  if (graph.snapshot || graph.centers.length === 0) return graph;
  const data = queryClient.getQueryData<GraphResponseDto>(graphQueryKey(useGraph.getState()));
  if (!data) throw new Error(t("file.err.notLoaded"));
  return { ...graph, snapshot: { ...meta, data } };
}

/**
 * The tab with its snapshot: the one it shows, else its loaded flow, the raw data (null when it cannot be had) and
 * the call trace when one is already cached. A trace is never fetched for an export: the user would be billed for
 * a view they never opened.
 */
async function withTxSnapshot(tab: TxTabStateV2, meta: SnapshotMeta): Promise<TxTabStateV2> {
  if (tab.snapshot) return tab;
  const res = queryClient.getQueryData<TxResponseDto>(qk.tx(tab.hash));
  if (res?.status !== "ready" || !res.flow) throw new Error(t("file.err.notLoaded"));
  const raw = await queryClient
    .fetchQuery({ queryKey: qk.txRaw(tab.hash), queryFn: () => api.txRaw(tab.hash), staleTime: Infinity, retry: false })
    .catch(() => null);
  const trace = queryClient.getQueryData<CallTraceResponseDto>(qk.txTrace(tab.hash));
  const frames = trace?.status === "ready" ? trace.frames : null;
  return { ...tab, snapshot: { ...meta, flow: res.flow, raw, ...(frames ? { trace: frames } : {}) } };
}

/** The file for the workspace, the address graph, or the tx tab `tabHash`; throws (with a message to show) when a view has no data yet. */
export async function buildFile(kind: FileKind, opts: FileIncludes & { tabHash?: string }): Promise<EtherGraphFileV1> {
  const includes: FileIncludes = { labels: opts.labels, notes: opts.notes };
  const meta: SnapshotMeta = { exported_at: new Date().toISOString(), includes };
  const live = captureState();
  let state: WorkspaceStateV2;
  if (kind === "tx") {
    const tab = live.tabs.find((x) => x.hash === lc(opts.tabHash ?? ""));
    if (!tab) throw new Error(t("tools.nothingToExport"));
    state = { graph: emptyGraph(), tabs: [await withTxSnapshot(tab, meta)], active: tab.hash };
  } else {
    const graph = withGraphSnapshot(live.graph, meta);
    const tabs = kind === "workspace" ? live.tabs : [];
    if (!graph.snapshot && tabs.length === 0) throw new Error(t("tools.nothingToExport"));
    state = {
      graph,
      tabs: await Promise.all(tabs.map((tab) => withTxSnapshot(tab, meta))),
      active: kind === "workspace" ? live.active : "graph",
    };
  }
  return { format: FORMAT, version: VERSION, kind, exported_at: meta.exported_at, includes, state: stripPrivate(state, includes) };
}

/** A node without the exporter's own labels (and labels from earlier files), its display name recomputed from what is left. */
function withoutPrivateLabels(n: NodeSummaryDto): NodeSummaryDto {
  const labels = n.labels.filter((l) => l.source.startsWith("import:"));
  return { ...n, labels, display_name: n.ens ?? labels[0]?.text ?? n.contract_name };
}

/**
 * Leaves out what was not ticked: labels off drops the user's labels from every snapshot node (and the display
 * names derived from them), notes off empties every node note. A snapshot's `includes` records what it still has.
 * Call-trace frames carry neither (only addresses and decoded calls), so they travel as they are.
 */
export function stripPrivate(state: WorkspaceStateV2, includes: FileIncludes): WorkspaceStateV2 {
  const meta = (s: SnapshotMeta): SnapshotMeta => ({
    exported_at: s.exported_at,
    includes: { labels: s.includes.labels && includes.labels, notes: s.includes.notes && includes.notes },
  });
  const nodes = (ns: NodeSummaryDto[]) => (includes.labels ? ns : ns.map(withoutPrivateLabels));
  const { snapshot, ...graph } = state.graph;
  return {
    graph: {
      ...graph,
      nodes: includes.notes ? graph.nodes : graph.nodes.map((n) => ({ ...n, note: "" })),
      ...(snapshot ? { snapshot: { ...snapshot, ...meta(snapshot), data: { ...snapshot.data, nodes: nodes(snapshot.data.nodes) } } } : {}),
    },
    tabs: state.tabs.map((tab) =>
      tab.snapshot
        ? { ...tab, snapshot: { ...tab.snapshot, ...meta(tab.snapshot), flow: { ...tab.snapshot.flow, nodes: nodes(tab.snapshot.flow.nodes) } } }
        : tab,
    ),
    active: state.active,
  };
}

/** The download name: `ethergraph-<workspace name>` (graph: else "graph"), or `ethergraph-tx-<first 10 hex>`. */
export function fileName(kind: FileKind, tabHash?: string): string {
  const name = useWorkspace.getState().name;
  const base =
    kind === "tx"
      ? `tx-${lc(tabHash ?? "").replace(/^0x/, "").slice(0, 10)}`
      : kind === "graph"
        ? safeFileName(name, "graph")
        : safeFileName(name);
  return `ethergraph-${base}.ethergraph.json`;
}

// ---- import ----

type Check = (v: unknown) => boolean;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str: Check = (v) => typeof v === "string";
const bool: Check = (v) => typeof v === "boolean";
const num: Check = (v) => typeof v === "number" && Number.isFinite(v);
const int: Check = (v) => Number.isInteger(v);
/** Any JSON value, but there. */
const present: Check = (v) => v !== undefined;
const re = (r: RegExp): Check => (v) => typeof v === "string" && r.test(v);
const oneOf = (...xs: string[]): Check => (v) => typeof v === "string" && xs.includes(v);
const opt = (c: Check): Check => (v) => v === null || c(v);
/** A field older files leave out. */
const optField = (c: Check): Check => (v) => v === undefined || c(v);
const arr = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const rec = (c: Check): Check => (v) => isObj(v) && Object.values(v).every(c);
/** An object with at least these fields (unknown fields are let through). */
const shape = (fields: Record<string, Check>): Check => (v) => isObj(v) && Object.entries(fields).every(([k, c]) => c(v[k]));

const address = re(/^0x[0-9a-fA-F]{40}$/);
/** Token decimals are a u8 (larger values would make amount formatting run away). */
const decimals = opt((v) => int(v) && (v as number) >= 0 && (v as number) <= 255);
const trust = shape({
  level: oneOf("listed", "unknown", "suspicious", "scam"),
  impersonates: opt(shape({ address, symbol: opt(str), name: opt(str) })),
  reason: opt(oneOf("spam-token", "scam-label")),
});
/** The category becomes a canvas class (`cat-<category>`): a plain slug only. */
const label = shape({ id: num, text: str, category: re(/^[a-z0-9-]{1,32}$/), source: str });
const nodeSummary = shape({
  address, kind: oneOf("eoa", "contract", "unknown"), display_name: opt(str), ens: opt(str), contract_name: opt(str),
  labels: arr(label), partial: bool, syncing: bool, synced: bool, hot: bool, identified: bool, nonce: opt(num), balance: opt(str),
  is_proxy: optField(bool), token: optField(opt(shape({ standard: oneOf("erc20", "erc721", "erc1155"), symbol: opt(str), decimals }))),
});
const transferKind = oneOf("native", "erc20", "erc721", "erc1155");
const edge = shape({
  from: address, to: address, asset: opt(address), asset_kind: transferKind, count: int, sum: str,
  first_ts: str, last_ts: str, decimals, symbol: opt(str), trust,
});
const syncStatus = shape({
  kind: oneOf("native", "internal", "erc20", "erc721", "erc1155"), from_block: opt(int), to_block: opt(int),
  truncated: bool, state: oneOf("syncing", "ok", "failed"), last_synced_at: opt(str),
});
const graphData = shape({ nodes: arr(nodeSummary), edges: arr(edge), omitted: rec(int), coverage: rec(arr(syncStatus)) });
const arg = shape({ name: str, ty: str, value: str });
const txFlow = shape({
  tx: shape({
    hash: str, block_number: int, ts: str, from: address, to: opt(address), value: str, success: bool,
    gas_used: str, fee: str, method: opt(str), selector: opt(str),
  }),
  detail: shape({
    nonce: num, tx_type: int, position: opt(int), confirmations: opt(int), gas_limit: str, gas_used: str,
    gas_price: opt(str), effective_gas_price: opt(str), max_fee: opt(str), max_priority_fee: opt(str), base_fee: opt(str),
    burnt_fee: opt(str), savings: opt(str), blob_gas_used: opt(str), blob_gas_price: opt(str), blob_fee: opt(str),
    access_list_len: opt(int), contract_created: opt(address), revert_reason: opt(str), input: str,
    authorizations: arr(shape({ chain_id: str, delegate: address, nonce: str, authority: opt(address) })),
    delegations: arr(shape({ authority: address, delegate: address })),
  }),
  call: opt(shape({ signature: str, name: str, args: arr(arg), via_delegate: opt(address), via_delegate_current: optField(bool) })),
  nodes: arr(nodeSummary),
  flows: arr(
    shape({
      seq: int, from: address, to: address, asset: opt(address), amount: str, token_id: opt(str),
      kind: oneOf("native", "internal", "erc20", "erc721", "erc1155"), trace_path: opt(str), log_index: opt(int),
      decimals, symbol: opt(str), trust,
    }),
  ),
  events: arr(shape({ address, log_index: int, name: opt(str), args: arr(arg), topics: arr(str), data: str })),
  completeness: oneOf("fund_flow", "full_trace"),
});
/** Decimal wei: the call graph sums frame values as bigints. */
const wei = re(/^[0-9]+$/);
const hex = re(/^0x[0-9a-fA-F]*$/);
const decodedCall = shape({ signature: str, name: str, args: arr(arg), via_delegate: opt(address), via_delegate_current: optField(bool) });
const callFrame = shape({
  path: arr((v) => int(v) && (v as number) >= 0),
  kind: oneOf("call", "staticcall", "delegatecall", "callcode", "create", "create2", "selfdestruct"),
  from: address, to: opt(address), value: wei, input: hex, output: opt(hex), gas: num, gas_used: opt(num), error: opt(str),
  call: opt(decodedCall), revert: opt(shape({ name: str, args: arr(arg) })), via_delegate: opt(address),
  via_delegate_current: optField(bool),
});
const isIncludes = shape({ labels: bool, notes: bool });
const isFullGraphSnapshot = shape({ exported_at: str, includes: isIncludes, data: graphData }) as (v: unknown) => v is GraphSnapshot;
const isFullTxSnapshot = shape({
  exported_at: str, includes: isIncludes, flow: txFlow, raw: opt(shape({ tx: present, receipt: present })), trace: optField(arr(callFrame)),
}) as (v: unknown) => v is TxSnapshot;

export type ParseResult = { ok: true; file: EtherGraphFileV1 } | { ok: false; reason: string };

/** Paths compared index by index, a parent before its children: sorted this way, frames are in pre-order. */
function comparePaths(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** The trace in pre-order (the call-tree model relies on it); `null` when two frames share a path. */
function preOrder(trace: CallFrameDto[]): CallFrameDto[] | null {
  const sorted = [...trace].sort((a, b) => comparePaths(a.path, b.path));
  return sorted.some((f, i) => i > 0 && comparePaths(sorted[i - 1]!.path, f.path) === 0) ? null : sorted;
}
const bad = (reason: string) => ({ ok: false as const, reason });
const badField = (field: string) => bad(t("ws.err.field", { field }));

/** Labels that came in a file are never the receiver's: user labels become `file` labels, and no id is a real one. */
function retag(state: WorkspaceStateV2): WorkspaceStateV2 {
  let id = 0;
  const tag = (l: LabelDto): LabelDto => ({ ...l, id: --id, source: l.source.startsWith("import:") ? l.source : FILE_SOURCE });
  const nodes = (ns: NodeSummaryDto[]) => ns.map((n) => ({ ...n, labels: n.labels.map(tag) }));
  const { snapshot } = state.graph;
  return {
    ...state,
    graph: snapshot ? { ...state.graph, snapshot: { ...snapshot, data: { ...snapshot.data, nodes: nodes(snapshot.data.nodes) } } } : state.graph,
    tabs: state.tabs.map((tab) =>
      tab.snapshot ? { ...tab, snapshot: { ...tab.snapshot, flow: { ...tab.snapshot.flow, nodes: nodes(tab.snapshot.flow.nodes) } } } : tab,
    ),
  };
}

/** Validates a file's text completely (any problem rejects the whole file); its labels come back re-tagged. */
export function parseFile(text: string): ParseResult {
  // A character is at least a byte.
  if (text.length > MAX_FILE_BYTES) return bad(t("file.err.tooLarge", { max: MAX_MIB }));
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad(t("file.err.json"));
  }
  if (!isObj(v) || v.format !== FORMAT) return bad(t("file.err.format"));
  if (v.version !== VERSION) return bad(t("file.err.version", { version: String(v.version) }));
  if (!str(v.kind) || !KINDS.includes(v.kind as string)) return badField("kind");
  if (!str(v.exported_at)) return badField("exported_at");
  if (!isIncludes(v.includes)) return badField("includes");
  const r = deserialize(v.state, SCHEMA_VERSION);
  if (!r.ok) return r;
  const { graph, tabs } = r.state;
  const kind = v.kind as FileKind;
  // `deserialize` only checks that these are strings; a file's must be addresses.
  if (!graph.nodes.every((n) => address(n.address))) return badField("nodes");
  if (!graph.centers.every(address)) return badField("centers");
  if (!graph.expanded_pairs.every((p) => p.every(address))) return badField("expanded_pairs");
  if (!Object.keys(graph.limits ?? {}).every(address)) return badField("limits");
  if (!Object.keys(graph.proxies ?? {}).every(address)) return badField("proxies");
  if (!(graph.hidden_proxies ?? []).every(address)) return badField("hidden_proxies");
  if (!(graph.plain_centers ?? []).every(address)) return badField("plain_centers");
  if (graph.snapshot !== undefined && !isFullGraphSnapshot(graph.snapshot)) return badField("snapshot");
  if (graph.centers.length > 0 && kind !== "tx" && !graph.snapshot) return badField("snapshot");
  const ordered: TxTabStateV2[] = [];
  for (const tab of tabs) {
    if (!isFullTxSnapshot(tab.snapshot) || lc(tab.snapshot.flow.tx.hash) !== tab.hash) return badField("snapshot");
    if (tab.snapshot.trace === undefined) {
      ordered.push(tab);
      continue;
    }
    const trace = preOrder(tab.snapshot.trace);
    if (!trace) return badField("trace");
    ordered.push({ ...tab, snapshot: { ...tab.snapshot, trace } });
  }
  if (kind === "tx" && tabs.length !== 1) return badField("tabs");
  if (kind === "graph" && (tabs.length > 0 || !graph.snapshot)) return badField(tabs.length > 0 ? "tabs" : "snapshot");
  return {
    ok: true,
    file: {
      format: FORMAT, version: VERSION, kind, exported_at: v.exported_at as string, includes: v.includes as FileIncludes,
      state: retag({ ...r.state, tabs: ordered }),
    },
  };
}

/**
 * Imports a file: a tx file opens its tab in the current workspace (or shows the one already open, R1); a graph
 * or workspace file is handed to `openWorkspace`, which runs `apply` (opening it as a new unsaved workspace)
 * after any unsaved-changes confirm. A bad file shows one error and changes nothing.
 */
export async function importBlob(blob: Blob, openWorkspace: (apply: () => void) => void): Promise<void> {
  let r: ParseResult;
  try {
    r = blob.size > MAX_FILE_BYTES ? bad(t("file.err.tooLarge", { max: MAX_MIB })) : parseFile(await blob.text());
  } catch (e) {
    r = bad(e instanceof Error ? e.message : String(e));
  }
  if (!r.ok) return void toast(t("file.err.import", { reason: r.reason }), "error");
  const { kind, state } = r.file;
  if (kind === "tx") {
    const tab = state.tabs[0]!;
    if (!openTxTab(tab)) {
      useTabs.getState().activate(tab.hash);
      toast(t("file.alreadyOpen"));
    }
    return;
  }
  openWorkspace(() => openUnsaved(state));
}
