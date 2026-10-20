import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/endpoints";
import type { CallFrameDto } from "../api/generated/CallFrameDto";
import type { CallTraceResponseDto } from "../api/generated/CallTraceResponseDto";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { LabelDto } from "../api/generated/LabelDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import type { TxResponseDto } from "../api/generated/TxResponseDto";
import { qk, queryClient } from "../api/queryClient";
import { useGraph } from "../graph/store";
import { graphQueryKey } from "../graph/useGraphData";
import { useTabs, type TxTab } from "../shell/tabs";
import { toast } from "../shell/Toasts";
import {
  buildFile,
  fileName,
  importBlob,
  MAX_FILE_BYTES,
  parseFile,
  stripPrivate,
  type EtherGraphFileV1,
} from "./file";
import type { WorkspaceStateV2 } from "./serialize";
import type { GraphSnapshot, TxSnapshot } from "./snapshot";
import { useWorkspace } from "./useWorkspace";

vi.mock("../api/endpoints", () => ({ api: { txRaw: vi.fn(), txTrace: vi.fn(), nodes: vi.fn(async () => []) } }));
vi.mock("../graph/cyRegistry", () => ({
  getMainCy: vi.fn(() => null),
  setMainCy: vi.fn(),
  getTxCy: vi.fn(() => null),
  registerTxCy: vi.fn(),
  getCallCy: vi.fn(() => null),
}));
vi.mock("../shell/Toasts", () => ({ toast: vi.fn() }));

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const C = "0x" + "c3".repeat(20);
const H1 = "0x" + "1".repeat(64);
const H2 = "0x" + "2".repeat(64);
const TRUST = { level: "listed" as const, impersonates: null, reason: null };

const SECRET_A = "Secret Whale";
const SECRET_B = "My Mule";
const SECRET_NOTE = "met him in Lisbon";
const userA: LabelDto = { id: 5, text: SECRET_A, category: "fund", source: "user" };
const userB: LabelDto = { id: 6, text: SECRET_B, category: "other", source: "user" };
const pub: LabelDto = { id: 9, text: "Binance 14", category: "cex", source: "import:eth-labels" };

const node = (address: string, over: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: 1, balance: "10", ...over,
});
/** A carries a user label and a public one (display name from the user label); B a user label over a contract name; C an ENS name and a user label. */
const nodes = (): NodeSummaryDto[] => [
  node(A, { labels: [userA, pub], display_name: SECRET_A }),
  node(B, { kind: "contract", labels: [userB], display_name: SECRET_B, contract_name: "Router" }),
  node(C, { labels: [userA], display_name: "vitalik.eth", ens: "vitalik.eth" }),
];
const edge = (from: string, to: string): EdgeDto => ({
  from, to, asset: null, asset_kind: "native", count: 2, sum: "1000", first_ts: "2024-01-01T00:00:00Z",
  last_ts: "2024-01-02T00:00:00Z", decimals: 18, symbol: "ETH", trust: TRUST,
});
const graphData = (): GraphResponseDto => ({
  nodes: nodes(),
  edges: [edge(A, B), edge(A, C)],
  omitted: { [A]: 3 },
  coverage: { [A]: [{ kind: "native", from_block: 1, to_block: 9, truncated: false, state: "ok", last_synced_at: null, oldest_ts: null }] },
});
const flow = (hash: string): TxFlowDto => ({
  tx: {
    hash, block_number: 19, ts: "2024-03-02T12:30:00Z", from: A, to: B, value: "1", success: true, gas_used: "21000",
    fee: "21", method: null, selector: null,
  },
  detail: {
    nonce: 1, tx_type: 2, position: 0, confirmations: 3, gas_limit: "21000", gas_used: "21000", gas_price: null,
    effective_gas_price: "1", max_fee: null, max_priority_fee: null, base_fee: null, burnt_fee: null, savings: null,
    blob_gas_used: null, blob_gas_price: null, blob_fee: null, access_list_len: null, contract_created: null,
    revert_reason: null, input: "0x", authorizations: [], delegations: [],
  },
  call: null,
  nodes: nodes(),
  flows: [
    { seq: 0, from: A, to: B, asset: null, amount: "1", token_id: null, kind: "native", trace_path: null, log_index: null, decimals: 18, symbol: null, trust: TRUST },
  ],
  events: [],
  completeness: "fund_flow",
});
const RAW = { tx: { nonce: "0x1" }, receipt: { status: "0x1" } };
const frame = (path: number[], over: Partial<CallFrameDto> = {}): CallFrameDto => ({
  path, kind: "call", from: A, to: B, value: "0", input: "0xa9059cbb", output: "0x", gas: 100, gas_used: 50, error: null,
  call: { signature: "transfer(address,uint256)", name: "transfer", args: [{ name: "to", ty: "address", value: C }], via_delegate: null },
  revert: null, via_delegate: null, via_delegate_current: false, ...over,
});
/** A decoded trace: the root call, a failed static call under it with its revert reason, a plain ETH transfer. */
const FRAMES: CallFrameDto[] = [
  frame([], { value: "5" }),
  frame([0], { kind: "staticcall", from: B, to: C, error: "Reverted", revert: { name: "Error", args: [{ name: "", ty: "string", value: "no" }] } }),
  frame([1], { from: B, to: A, input: "0x", call: null, value: "5" }),
];
/** The trace of `hash` as the call-tree view caches it. */
const cacheTrace = (hash: string, res: Partial<CallTraceResponseDto> = {}) =>
  queryClient.setQueryData<CallTraceResponseDto>(qk.txTrace(hash), { status: "ready", frames: FRAMES, job_id: null, undecoded: [], ...res });
const ON = { labels: true, notes: true };
const OFF = { labels: false, notes: false };
const META = { exported_at: "2026-10-01T12:00:00.000Z", includes: ON };

const g = () => useGraph.getState();
const txTabs = () => useTabs.getState().tabs.filter((t): t is TxTab => t.kind === "tx");
const toasted = () => vi.mocked(toast).mock.calls;

/** A live graph with A as center (its note set) and the graph query answered. */
function liveGraph() {
  g().setCenters([A]);
  g().setNote(A, SECRET_NOTE);
  queryClient.setQueryData(graphQueryKey(g()), graphData());
}
/** A live tx tab whose flow is loaded. */
function liveTx(hash: string) {
  useTabs.getState().openTx(hash);
  queryClient.setQueryData<TxResponseDto>(qk.tx(hash), { status: "ready", flow: flow(hash), job_id: null });
}
const blobOf = (f: unknown) => new Blob([JSON.stringify(f)], { type: "application/json" });
/** Parses a built file the way an import does (through its JSON text). */
const reparse = (f: EtherGraphFileV1) => {
  const r = parseFile(JSON.stringify(f));
  if (!r.ok) throw new Error(r.reason);
  return r.file;
};
/** Imports `f`; a graph or workspace file is opened at once (no unsaved-changes confirm). */
const importNow = (f: unknown) => importBlob(blobOf(f), (apply) => apply());

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  g().reset();
  useTabs.getState().closeAllTx();
  useWorkspace.getState().clear();
  vi.mocked(api.txRaw).mockResolvedValue(RAW);
});

describe("stripPrivate", () => {
  const state = (): WorkspaceStateV2 => ({
    graph: {
      nodes: [{ address: A, pinned: true, hidden: false, note: SECRET_NOTE }],
      centers: [A], expanded_pairs: [], filter: {}, viewport: { zoom: 1, pan: { x: 0, y: 0 } },
      snapshot: { ...META, data: graphData() },
    },
    tabs: [{ hash: H1, snapshot: { ...META, flow: flow(H1), raw: null } }],
    active: "graph",
  });

  test("labels and notes off: no user label text, no display name derived from one, no note (Review Focus 1)", () => {
    const text = JSON.stringify(stripPrivate(state(), OFF));
    expect(text).not.toContain(SECRET_A);
    expect(text).not.toContain(SECRET_B);
    expect(text).not.toContain(SECRET_NOTE);
    // Public labels and on-chain names stay.
    expect(text).toContain("Binance 14");
    expect(text).toContain("Router");
    expect(text).toContain("vitalik.eth");
  });

  test("display names are recomputed: ENS, else the first remaining label, else the contract name", () => {
    const out = stripPrivate(state(), OFF);
    for (const ns of [out.graph.snapshot!.data.nodes, out.tabs[0]!.snapshot!.flow.nodes]) {
      expect(ns.map((n) => n.display_name)).toEqual(["Binance 14", "Router", "vitalik.eth"]);
      expect(ns.map((n) => n.labels)).toEqual([[pub], [], []]);
    }
    expect(out.graph.nodes[0]).toEqual({ address: A, pinned: true, hidden: false, note: "" });
    expect(out.graph.snapshot!.includes).toEqual(OFF);
    expect(out.tabs[0]!.snapshot!.includes).toEqual(OFF);
  });

  test("labels from an earlier file count as private too", () => {
    const s = state();
    s.graph.snapshot!.data.nodes[0]!.labels = [{ ...userA, id: -1, source: "file" }];
    expect(JSON.stringify(stripPrivate(s, OFF))).not.toContain(SECRET_A);
  });

  test("labels and notes on: everything is kept as it is", () => {
    const s = state();
    expect(stripPrivate(s, ON)).toEqual(s);
  });

  test("dragged \"+N more\" positions survive for both includes settings", () => {
    const s = state();
    s.graph.proxies = { [A.toLowerCase()]: { x: 3, y: 4 } };
    expect(stripPrivate(s, OFF).graph.proxies).toEqual({ [A.toLowerCase()]: { x: 3, y: 4 } });
    expect(stripPrivate(s, ON).graph.proxies).toEqual({ [A.toLowerCase()]: { x: 3, y: 4 } });
  });

  test("a snapshot that left labels out says so even when this export includes them", () => {
    const s = state();
    s.graph.snapshot!.includes = { labels: false, notes: true };
    expect(stripPrivate(s, ON).graph.snapshot!.includes).toEqual({ labels: false, notes: true });
  });
});

describe("buildFile", () => {
  test("a graph file of the live graph: the data on screen as its snapshot, private parts stripped (Review Focus 1)", async () => {
    liveGraph();
    liveTx(H1);
    const f = await buildFile("graph", OFF);
    expect(f).toMatchObject({ format: "ethergraph", version: 1, kind: "graph", includes: OFF });
    expect(Date.parse(f.exported_at)).not.toBeNaN();
    expect(f.state.tabs).toEqual([]);
    expect(f.state.active).toBe("graph");
    expect(f.state.graph.centers).toEqual([A]);
    expect(f.state.graph.snapshot!.exported_at).toBe(f.exported_at);
    expect(f.state.graph.snapshot!.data.edges).toEqual(graphData().edges);
    const text = JSON.stringify(f);
    expect(text).not.toContain(SECRET_A);
    expect(text).not.toContain(SECRET_B);
    expect(text).not.toContain(SECRET_NOTE);
  });

  test("with labels and notes ticked the file keeps them", async () => {
    liveGraph();
    const text = JSON.stringify(await buildFile("graph", ON));
    expect(text).toContain(SECRET_A);
    expect(text).toContain(SECRET_NOTE);
  });

  test("a tx file: the empty graph and the one tab with its flow and raw data", async () => {
    liveGraph();
    liveTx(H1);
    liveTx(H2);
    useTabs.getState().setDetailTab(H1, "transfers");
    const f = await buildFile("tx", { ...OFF, tabHash: H1 });
    expect(f.kind).toBe("tx");
    expect(f.state.graph).toMatchObject({ nodes: [], centers: [], expanded_pairs: [] });
    expect(f.state.graph.snapshot).toBeUndefined();
    expect(f.state.active).toBe(H1);
    expect(f.state.tabs).toHaveLength(1);
    const tab = f.state.tabs[0]!;
    expect(tab).toMatchObject({ hash: H1, detail_tab: "transfers" });
    expect(tab.snapshot!.flow.flows).toEqual(flow(H1).flows);
    expect(tab.snapshot!.raw).toEqual(RAW);
    expect(api.txRaw).toHaveBeenCalledWith(H1);
    const text = JSON.stringify(f);
    expect(text).not.toContain(SECRET_A);
    expect(text).not.toContain(SECRET_NOTE);
    expect(fileName("tx", H1)).toBe("ethergraph-tx-1111111111.ethergraph.json");
  });

  test("raw data that cannot be fetched is left out (raw: null)", async () => {
    liveTx(H1);
    vi.mocked(api.txRaw).mockRejectedValue(new Error("boom"));
    const f = await buildFile("tx", { ...ON, tabHash: H1 });
    expect(f.state.tabs[0]!.snapshot!.raw).toBeNull();
  });

  test("a workspace file: the graph and every tab, each with its snapshot", async () => {
    liveGraph();
    liveTx(H1);
    liveTx(H2);
    const f = await buildFile("workspace", OFF);
    expect(f.kind).toBe("workspace");
    expect(f.state.active).toBe(H2);
    expect(f.state.graph.snapshot).toBeDefined();
    expect(f.state.tabs.map((t) => [t.hash, t.snapshot?.flow.tx.hash])).toEqual([[H1, H1], [H2, H2]]);
    expect(JSON.stringify(f)).not.toContain(SECRET_A);
  });

  test("a snapshot view is re-exported unchanged except for the private parts", async () => {
    const graphSnap: GraphSnapshot = { ...META, data: graphData() };
    const txSnap: TxSnapshot = { ...META, flow: flow(H1), raw: RAW };
    g().setCenters([A]);
    g().freeze(graphSnap);
    useTabs.getState().addTx({ hash: H1, snapshot: txSnap });
    const kept = await buildFile("workspace", ON);
    expect(kept.state.graph.snapshot).toEqual(graphSnap);
    expect(kept.state.tabs[0]!.snapshot).toEqual(txSnap);
    expect(api.txRaw).not.toHaveBeenCalled();
    const stripped = await buildFile("workspace", OFF);
    expect(stripped.state.graph.snapshot!.exported_at).toBe(META.exported_at);
    expect(stripped.state.graph.snapshot!.data.edges).toEqual(graphSnap.data.edges);
    expect(JSON.stringify(stripped)).not.toContain(SECRET_A);
  });

  test("export_includes_a_cached_trace", async () => {
    liveTx(H1);
    liveTx(H2);
    cacheTrace(H1);
    cacheTrace(H2, { status: "pending", frames: null, job_id: 4 });
    useTabs.getState().setTxView(H1, "calls");
    const f = await buildFile("workspace", OFF);
    const [t1, t2] = f.state.tabs;
    expect(t1).toMatchObject({ hash: H1, view: "calls" });
    // The frames hold no labels or notes: they travel as they are whatever is ticked.
    expect(t1!.snapshot!.trace).toEqual(FRAMES);
    // A trace still being fetched is not there yet.
    expect(t2!.snapshot).not.toHaveProperty("trace");
    expect(api.txTrace).not.toHaveBeenCalled();

    // Through a file: the receiver's tab opens on the call tree with the trace.
    const file = reparse(f);
    useTabs.getState().closeAllTx();
    queryClient.clear();
    await importNow(file);
    expect(txTabs()[0]).toMatchObject({ hash: H1, view: "calls", snapshot: { trace: FRAMES } });
    // Re-exporting the snapshot keeps its trace.
    const again = await buildFile("tx", { ...OFF, tabHash: H1 });
    expect(again.state.tabs[0]!.snapshot!.trace).toEqual(FRAMES);
  });

  test("export_never_fetches_a_trace", async () => {
    liveTx(H1);
    const f = await buildFile("tx", { ...ON, tabHash: H1 });
    expect(api.txTrace).not.toHaveBeenCalled();
    expect(f.state.tabs[0]!.snapshot).not.toHaveProperty("trace");
    expect(queryClient.getQueryState(qk.txTrace(H1))).toBeUndefined();
  });

  test("a view whose data has not loaded yet cannot be exported", async () => {
    g().setCenters([A]);
    await expect(buildFile("graph", OFF)).rejects.toThrow("has not loaded yet");
    useTabs.getState().openTx(H1);
    await expect(buildFile("tx", { ...OFF, tabHash: H1 })).rejects.toThrow("has not loaded yet");
    g().reset();
    await expect(buildFile("graph", OFF)).rejects.toThrow("Nothing to export");
  });
});

describe("import", () => {
  test("a graph file opens as an unsaved workspace with the graph frozen; the open tx tabs are replaced", async () => {
    liveGraph();
    const file = reparse(await buildFile("graph", OFF));
    g().reset();
    liveTx(H2);
    useWorkspace.getState().setCurrent({ id: 3, name: "mine", updated_at: "T" });
    await importNow(file);
    expect(g().centers).toEqual([A]);
    expect(g().frozen).toEqual(file.state.graph.snapshot);
    expect(txTabs()).toEqual([]);
    expect(useWorkspace.getState()).toMatchObject({ id: null, name: null, dirty: true });
    expect(toasted()).toEqual([]);
  });

  test("a workspace file round-trips: graph, tabs and their snapshots, the active tab", async () => {
    liveGraph();
    liveTx(H1);
    liveTx(H2);
    useTabs.getState().setDetailTab(H1, "logs");
    const file = reparse(await buildFile("workspace", ON));
    g().reset();
    useTabs.getState().closeAllTx();
    await importNow(file);
    expect(g().frozen!.data.edges).toEqual(graphData().edges);
    expect(g().ui[A]?.note).toBe(SECRET_NOTE);
    expect(txTabs().map((t) => [t.hash, t.detailTab, t.snapshot?.flow.tx.hash])).toEqual([
      [H1, "logs", H1],
      [H2, undefined, H2],
    ]);
    expect(useTabs.getState().active).toBe(H2);
    expect(useWorkspace.getState()).toMatchObject({ id: null, dirty: true });
  });

  test("a tx file opens a snapshot tab in the current workspace, which is otherwise untouched", async () => {
    liveTx(H1);
    const file = reparse(await buildFile("tx", { ...ON, tabHash: H1 }));
    useTabs.getState().closeAllTx();
    liveGraph();
    useWorkspace.getState().setCurrent({ id: 3, name: "mine", updated_at: "T" });
    const open = vi.fn();
    await importBlob(blobOf(file), open);
    expect(open).not.toHaveBeenCalled();
    expect(g().centers).toEqual([A]);
    expect(g().frozen).toBeNull();
    expect(txTabs().map((t) => t.hash)).toEqual([H1]);
    expect(txTabs()[0]!.snapshot).toEqual(file.state.tabs[0]!.snapshot);
    expect(useTabs.getState().active).toBe(H1);
    expect(useWorkspace.getState()).toMatchObject({ id: 3, dirty: true });
  });

  test("tx_file_carries_call_positions_and_its_snapshot_tab_restores_them", async () => {
    liveTx(H1);
    cacheTrace(H1);
    const calls = { [A]: { x: 1, y: 2 }, [B]: { x: 30, y: -4 } };
    useTabs.getState().setCallLayout(H1, calls);
    const file = reparse(await buildFile("tx", { ...OFF, tabHash: H1 }));
    expect(file.state.tabs[0]).toMatchObject({ hash: H1, call_positions: calls });
    useTabs.getState().closeAllTx();
    await importBlob(blobOf(file), vi.fn());
    expect(txTabs()[0]).toMatchObject({ hash: H1, callLayout: { positions: calls } });
    expect(txTabs()[0]!.snapshot).toEqual(file.state.tabs[0]!.snapshot);
  });

  test("R1: a tx file for a transaction already open activates that tab and opens no second one", async () => {
    liveTx(H1);
    const file = reparse(await buildFile("tx", { ...ON, tabHash: H1 }));
    useTabs.getState().activate("graph");
    await importNow(file);
    expect(txTabs()).toHaveLength(1);
    expect(txTabs()[0]!.snapshot).toBeUndefined();
    expect(useTabs.getState().active).toBe(H1);
    expect(toasted()).toEqual([["This transaction is already open; not imported again"]]);
  });

  test("a graph or workspace file goes through the caller's unsaved-changes confirm; declining applies nothing", async () => {
    liveGraph();
    const file = reparse(await buildFile("graph", OFF));
    g().reset();
    const open = vi.fn();
    await importBlob(blobOf(file), open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(g().centers).toEqual([]);
    open.mock.calls[0]![0]();
    expect(g().centers).toEqual([A]);
  });

  test("file_without_trace_still_opens", async () => {
    liveTx(H1);
    const file = JSON.parse(JSON.stringify(await buildFile("tx", { ...ON, tabHash: H1 }))) as EtherGraphFileV1;
    // As an older version wrote it: no view, no trace.
    expect(file.state.tabs[0]).not.toHaveProperty("view");
    expect(file.state.tabs[0]!.snapshot).not.toHaveProperty("trace");
    useTabs.getState().closeAllTx();
    queryClient.clear();
    await importNow(file);
    expect(toasted()).toEqual([]);
    expect(txTabs()).toHaveLength(1);
    expect(txTabs()[0]).not.toHaveProperty("view");
    expect(txTabs()[0]!.snapshot!.flow.tx.hash).toBe(H1);
    expect(txTabs()[0]!.snapshot).not.toHaveProperty("trace");
  });

  test("labels that arrive in a file become `file` labels with ids ≤ 0; public dataset labels keep their source (Review Focus 2)", async () => {
    liveGraph();
    liveTx(H1);
    const r = parseFile(JSON.stringify(await buildFile("workspace", ON)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = [...r.file.state.graph.snapshot!.data.nodes, ...r.file.state.tabs[0]!.snapshot!.flow.nodes].flatMap((n) => n.labels);
    expect(all.length).toBeGreaterThan(0);
    for (const l of all) expect(l.id).toBeLessThanOrEqual(0);
    expect(all.filter((l) => l.text === SECRET_A).every((l) => l.source === "file")).toBe(true);
    expect(all.filter((l) => l.text === "Binance 14").every((l) => l.source === "import:eth-labels")).toBe(true);
    expect(all.some((l) => l.source === "user")).toBe(false);
  });
});

describe("malformed or hostile files (Review Focus 4)", () => {
  let good: EtherGraphFileV1;
  beforeEach(async () => {
    liveGraph();
    liveTx(H1);
    cacheTrace(H1);
    good = JSON.parse(JSON.stringify(await buildFile("workspace", ON))) as EtherGraphFileV1;
    queryClient.clear();
    g().reset();
    useTabs.getState().closeAllTx();
    // The current workspace that must stay untouched.
    g().setCenters([C]);
    liveTx(H2);
    useWorkspace.getState().setCurrent({ id: 3, name: "mine", updated_at: "T" });
  });
  type Mutate = (f: Record<string, any>) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cases: [string, Mutate][] = [
    ["wrong format", (f) => ({ ...f, format: "other" })],
    ["no format", ({ format: _f, ...f }) => f],
    ["unknown version", (f) => ({ ...f, version: 2 })],
    ["unknown kind", (f) => ({ ...f, kind: "address" })],
    ["no state", ({ state: _s, ...f }) => f],
    ["includes of the wrong type", (f) => ({ ...f, includes: { labels: "yes", notes: false } })],
    ["exported_at missing", ({ exported_at: _e, ...f }) => f],
    ["an array", () => []],
    ["null", () => null],
    ["graph state of the wrong shape", (f) => ({ ...f, state: { ...f.state, graph: { ...f.state.graph, centers: "x" } } })],
    ["edge with a wrong field type", (f) => ((f.state.graph.snapshot.data.edges[0].count = "2"), f)],
    ["edge without trust", (f) => (delete f.state.graph.snapshot.data.edges[0].trust, f)],
    ["node with an address that is not one", (f) => ((f.state.graph.snapshot.data.nodes[0].address = "<img>"), f)],
    ["label without text", (f) => (delete f.state.graph.snapshot.data.nodes[0].labels[0].text, f)],
    ["label category with a space (it would add a canvas class)", (f) => ((f.state.graph.snapshot.data.nodes[0].labels[0].category = "cex hot"), f)],
    ["label category in capitals", (f) => ((f.state.graph.snapshot.data.nodes[0].labels[0].category = "CEX"), f)],
    ["label category over 32 characters", (f) => ((f.state.graph.snapshot.data.nodes[0].labels[0].category = "a".repeat(33)), f)],
    ["empty label category", (f) => ((f.state.graph.snapshot.data.nodes[0].labels[0].category = ""), f)],
    ["tx node label category with a space", (f) => ((f.state.tabs[0].snapshot.flow.nodes[0].labels = [{ id: 1, text: "x", category: "a b", source: "user" }]), f)],
    ["graph-state node with an address that is not one", (f) => ((f.state.graph.nodes[0].address = "__proto__"), f)],
    ["a center that is not an address", (f) => ((f.state.graph.centers = ["0x12"]), f)],
    ["an expanded pair with a member that is not an address", (f) => ((f.state.graph.expanded_pairs = [[A, "x"]]), f)],
    ["a limit keyed by something that is not an address", (f) => ((f.state.graph.limits = { [A]: 5, junk: 5 }), f)],
    ["a pick list keyed by something that is not an address", (f) => ((f.state.graph.picks = { [A]: [B], junk: [B] }), f)],
    ["a picked neighbour that is not an address", (f) => ((f.state.graph.picks = { [A]: ["<b>"] }), f)],
    ["a \"+N more\" position keyed by something that is not an address", (f) => ((f.state.graph.proxies = { [A]: { x: 1, y: 2 }, junk: { x: 1, y: 2 } }), f)],
    ["absurd token decimals", (f) => ((f.state.graph.snapshot.data.edges[0].decimals = 1e9), f)],
    ["a node token of an unknown standard", (f) => ((f.state.graph.snapshot.data.nodes[0].token = { standard: "erc777", symbol: null, decimals: null }), f)],
    ["a node token with absurd decimals", (f) => ((f.state.graph.snapshot.data.nodes[0].token = { standard: "erc20", symbol: "X", decimals: 1e9 }), f)],
    ["a tx node whose proxy flag is not a boolean", (f) => ((f.state.tabs[0].snapshot.flow.nodes[0].is_proxy = "yes"), f)],
    ["coverage of the wrong shape", (f) => ((f.state.graph.snapshot.data.coverage = { x: [1] }), f)],
    ["tx flow without detail", (f) => (delete f.state.tabs[0].snapshot.flow.detail, f)],
    ["raw data without its receipt", (f) => (delete f.state.tabs[0].snapshot.raw.receipt, f)],
    ["tx flow entry of the wrong type", (f) => ((f.state.tabs[0].snapshot.flow.flows[0].seq = "0"), f)],
    ["a trace that is not a list", (f) => ((f.state.tabs[0].snapshot.trace = { 0: {} }), f)],
    ["a trace frame with a caller that is not an address", (f) => ((f.state.tabs[0].snapshot.trace[1].from = "<b>"), f)],
    ["a trace frame whose value is not a wei amount (it is summed as a bigint)", (f) => ((f.state.tabs[0].snapshot.trace[0].value = "1e18"), f)],
    ["a trace frame of an unknown kind", (f) => ((f.state.tabs[0].snapshot.trace[0].kind = "jump"), f)],
    ["a trace frame with a path that is not a list of indexes", (f) => ((f.state.tabs[0].snapshot.trace[1].path = ["0"]), f)],
    ["a decoded call without its name", (f) => (delete f.state.tabs[0].snapshot.trace[0].call.name, f)],
    ["a revert reason without its arguments", (f) => (delete f.state.tabs[0].snapshot.trace[1].revert.args, f)],
    ["a trace with two frames at one path", (f) => (f.state.tabs[0].snapshot.trace.push({ ...f.state.tabs[0].snapshot.trace[1] }), f)],
    ["a tab view that is neither flow nor calls", (f) => ((f.state.tabs[0].view = "graph"), f)],
    ["call-graph positions that are not numbers", (f) => ((f.state.tabs[0].call_positions = { [A]: { x: "1", y: 2 } }), f)],
    ["tx tab without a snapshot", (f) => (delete f.state.tabs[0].snapshot, f)],
    ["tx tab whose snapshot is another transaction", (f) => ((f.state.tabs[0].snapshot.flow.tx.hash = H2), f)],
    ["tx tab with a bad hash", (f) => ((f.state.tabs[0].hash = "0x12"), f)],
    ["graph with centers but no snapshot", (f) => (delete f.state.graph.snapshot, f)],
    ["a graph file with tabs", (f) => ({ ...f, kind: "graph" })],
    ["a tx file with two tabs", (f) => ({ ...f, kind: "tx", state: { ...f.state, tabs: [f.state.tabs[0], { ...f.state.tabs[0], hash: H2 }] } })],
    ["a tx file with no tab", (f) => ({ ...f, kind: "tx", state: { ...f.state, tabs: [], active: "graph" } })],
  ];

  const before = () => ({
    centers: g().centers,
    frozen: g().frozen,
    tabs: useTabs.getState().tabs,
    active: useTabs.getState().active,
    ws: { ...useWorkspace.getState() },
  });

  test.each(cases)("%s: rejected with one error toast, nothing applied", async (_, mutate) => {
    const was = before();
    const bad = mutate(JSON.parse(JSON.stringify(good)) as Record<string, unknown>);
    expect(parseFile(JSON.stringify(bad)).ok).toBe(false);
    const open = vi.fn();
    await importBlob(blobOf(bad), open);
    expect(open).not.toHaveBeenCalled();
    expect(toasted()).toHaveLength(1);
    expect(toasted()[0]![0]).toMatch(/^Cannot import the file: /);
    expect(toasted()[0]![1]).toBe("error");
    expect(before()).toEqual(was);
  });

  test("a non-address proxies key is rejected naming proxies", () => {
    const bad = JSON.parse(JSON.stringify(good)) as { state: { graph: { proxies?: unknown } } };
    bad.state.graph.proxies = { junk: { x: 1, y: 2 } };
    const r = parseFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("proxies");
  });

  test("hostile call-graph positions are rejected naming call_positions", () => {
    const bad = JSON.parse(JSON.stringify(good)) as { state: { tabs: { call_positions?: unknown }[] } };
    bad.state.tabs[0]!.call_positions = { [A]: { x: 1, y: "<img>" } };
    const r = parseFile(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("call_positions");
  });

  test("not JSON", async () => {
    const was = before();
    expect(parseFile("{ nope")).toEqual({ ok: false, reason: "The file is not valid JSON" });
    await importBlob(new Blob(["{ nope"]), vi.fn());
    expect(toasted()).toEqual([["Cannot import the file: The file is not valid JSON", "error"]]);
    expect(before()).toEqual(was);
  });

  test("a file of the wrong format names it", () => {
    expect(parseFile(JSON.stringify({ ...good, format: "x" }))).toEqual({ ok: false, reason: "Not an etherGraph file" });
    expect(parseFile(JSON.stringify({ ...good, version: 9 }))).toEqual({ ok: false, reason: "Unsupported etherGraph file version: 9" });
  });

  test("over 32 MiB: rejected without reading it", async () => {
    const was = before();
    const text = vi.fn();
    const big = { size: MAX_FILE_BYTES + 1, text } as unknown as Blob;
    await importBlob(big, vi.fn());
    expect(text).not.toHaveBeenCalled();
    expect(toasted()).toEqual([["Cannot import the file: The file is larger than 32 MiB", "error"]]);
    expect(before()).toEqual(was);
  });

  test("a duplicate trace path is rejected naming the trace", () => {
    const bad = JSON.parse(JSON.stringify(good)) as { state: { tabs: { snapshot: { trace: CallFrameDto[] } }[] } };
    const trace = bad.state.tabs[0]!.snapshot.trace;
    trace.push({ ...trace[0]!, path: [] });
    const r = parseFile(JSON.stringify(bad));
    expect(r).toEqual({ ok: false, reason: "Invalid trace" });
  });

  test("trace frames are put in pre-order by path", () => {
    const shuffled = JSON.parse(JSON.stringify(good)) as { state: { tabs: { snapshot: { trace: CallFrameDto[] } }[] } };
    const pre = [[], [0], [0, 1], [0, 10], [2], [10]].map((path) => frame(path));
    shuffled.state.tabs[0]!.snapshot.trace = [pre[5]!, pre[3]!, pre[0]!, pre[4]!, pre[2]!, pre[1]!];
    const r = parseFile(JSON.stringify(shuffled));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.state.tabs[0]!.snapshot!.trace!.map((f) => f.path)).toEqual([[], [0], [0, 1], [0, 10], [2], [10]]);
  });

  test("the unmodified file is accepted", () => {
    expect(good.state.tabs[0]!.snapshot!.trace).toHaveLength(FRAMES.length);
    expect(parseFile(JSON.stringify(good)).ok).toBe(true);
  });

  test("nodes saying they are tokens or proxies are accepted, as are nodes from before these facts", () => {
    const f = JSON.parse(JSON.stringify(good)) as { state: { graph: { snapshot: { data: { nodes: Record<string, unknown>[] } } } } };
    const [first, second] = f.state.graph.snapshot.data.nodes;
    Object.assign(first!, { is_proxy: true, token: { standard: "erc20", symbol: "USDC", decimals: 6 } });
    Object.assign(second!, { is_proxy: false, token: null });
    expect(parseFile(JSON.stringify(f)).ok).toBe(true);
    expect(good.state.graph.snapshot!.data.nodes.some((n) => "token" in n || "is_proxy" in n)).toBe(false);
  });
});
