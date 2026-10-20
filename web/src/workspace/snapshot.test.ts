import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { LabelDto } from "../api/generated/LabelDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { fileLabelsOf, isGraphSnapshot, isTxSnapshot, neverSynced, overlayIdentity, syncNeverSyncedCenters, useLiveIdentities, type GraphSnapshot } from "./snapshot";

const A = "0x" + "aa".repeat(20);

const node = (over: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: A, kind: "unknown", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: false, hot: false, identified: false, nonce: null, balance: null, ...over,
});
const fileLabel: LabelDto = { id: -1, text: "from sender", category: "other", source: "file" };
const importedInFile: LabelDto = { id: 9, text: "Binance 14", category: "cex", source: "import:eth-labels" };
const liveLabel: LabelDto = { id: 3, text: "mine", category: "fund", source: "user" };

describe("overlayIdentity", () => {
  const file = node({
    kind: "contract", display_name: "File name", contract_name: "FilePool", labels: [importedInFile, fileLabel],
    synced: true, nonce: 4, identified: true,
  });

  test("no live node: the file node as it is", () => {
    expect(overlayIdentity(file, undefined)).toBe(file);
  });

  test("a live node without identity: the file node, but identified only if the receiver identified it", () => {
    expect(overlayIdentity(file, node({ synced: true }))).toEqual({ ...file, identified: false });
    expect(overlayIdentity(file, node({ identified: true }))).toEqual(file);
  });

  test.each([
    ["a known kind", { kind: "eoa" as const }],
    ["labels", { labels: [liveLabel] }],
    ["an ENS name", { ens: "x.eth", display_name: "x.eth" }],
    ["a contract name", { contract_name: "LivePool", display_name: "LivePool" }],
  ])("a live node with %s gives the identity, then the file's own labels", (_, over) => {
    const live = node(over);
    const out = overlayIdentity(file, live);
    expect(out.kind).toBe(live.kind);
    expect(out.display_name).toBe(live.display_name);
    expect(out.ens).toBe(live.ens);
    expect(out.contract_name).toBe(live.contract_name);
    // Only the file's `file` labels are appended (its imported one is the sender's, replaced by the live labels).
    expect(out.labels).toEqual([...live.labels, fileLabel]);
    // Identify is offered unless the receiver itself identified the node.
    expect(out.identified).toBe(false);
    // Everything that is not identity stays the file's.
    expect(out.synced).toBe(true);
    expect(out.nonce).toBe(4);
    expect(out.address).toBe(A);
  });
});

test("fileLabelsOf picks the `file` labels of one node, case-insensitively", () => {
  const nodes = [node({ labels: [importedInFile, fileLabel] })];
  expect(fileLabelsOf(nodes, A.toUpperCase().replace("0X", "0x"))).toEqual([fileLabel]);
  expect(fileLabelsOf(nodes, "0x" + "bb".repeat(20))).toEqual([]);
  expect(fileLabelsOf(undefined, A)).toEqual([]);
});

describe("shape checks", () => {
  const meta = { exported_at: "2026-10-01T12:00:00Z", includes: { labels: true, notes: false } };
  const graph: GraphSnapshot = { ...meta, data: { nodes: [node()], edges: [], omitted: {}, coverage: {} } };

  test("a graph snapshot", () => {
    expect(isGraphSnapshot(graph)).toBe(true);
    expect(isGraphSnapshot({ ...graph, exported_at: 5 })).toBe(false);
    expect(isGraphSnapshot({ ...graph, includes: { labels: true } })).toBe(false);
    expect(isGraphSnapshot({ ...graph, data: { nodes: [], edges: [] } })).toBe(false);
    expect(isGraphSnapshot({ ...graph, data: { ...graph.data, nodes: [{ address: 1 }] } })).toBe(false);
    expect(isGraphSnapshot(null)).toBe(false);
  });

  test("a tx snapshot", () => {
    const flow = { tx: { hash: "0x" + "11".repeat(32) }, nodes: [node()], flows: [], events: [] };
    expect(isTxSnapshot({ ...meta, flow, raw: null })).toBe(true);
    expect(isTxSnapshot({ ...meta, flow, raw: { tx: {}, receipt: {} } })).toBe(true);
    expect(isTxSnapshot({ ...meta, flow })).toBe(false);
    expect(isTxSnapshot({ ...meta, flow: { ...flow, nodes: "x" }, raw: null })).toBe(false);
    expect(isTxSnapshot({ ...meta, flow: { ...flow, tx: {} }, raw: null })).toBe(false);
    expect(isTxSnapshot({ ...meta, flow, raw: { tx: {} } })).toBe(false);
    // A call trace is optional (older files have none); when there it is a list of frames.
    expect(isTxSnapshot({ ...meta, flow, raw: null, trace: [] })).toBe(true);
    expect(isTxSnapshot({ ...meta, flow, raw: null, trace: {} })).toBe(false);
    expect(isTxSnapshot({ ...meta, flow, raw: null, trace: null })).toBe(false);
  });
});

describe("useLiveIdentities", () => {
  afterEach(() => vi.restoreAllMocks());
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, children);

  test("asks /api/nodes in chunks of 2000 (lowercased, unique) and keys the answers by address", async () => {
    const addrs = Array.from({ length: 2001 }, (_, i) => "0x" + i.toString(16).padStart(40, "0"));
    const spy = vi.spyOn(api, "nodes").mockImplementation(async (list) => list.map((a) => node({ address: a, kind: "eoa" })));
    const { result } = renderHook(() => useLiveIdentities([...addrs, addrs[0]!.toUpperCase().replace("0X", "0x")]), { wrapper });
    await waitFor(() => expect(result.current.size).toBe(2001));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0]).toHaveLength(2000);
    expect(spy.mock.calls[1]![0]).toHaveLength(1);
    expect(result.current.get(addrs[5]!)?.kind).toBe("eoa");
  });

  test("no request for an empty list", () => {
    const spy = vi.spyOn(api, "nodes");
    const { result } = renderHook(() => useLiveIdentities([]), { wrapper });
    expect(result.current.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("refreshing a snapshot graph syncs the never-synced centers", () => {
  const B = "0x" + "bb".repeat(20);
  const C = "0x" + "cc".repeat(20);
  const D = "0x" + "dd".repeat(20);
  afterEach(() => vi.restoreAllMocks());

  test("neverSynced: unknown or not synced and not syncing", () => {
    const live = [node({ address: A }), node({ address: C, synced: true }), node({ address: D, syncing: true })];
    expect(neverSynced([B, A.toUpperCase().replace("0X", "0x"), C, D], live)).toEqual([A, B]);
  });

  test("2 never-synced + 1 synced center: one shallow sync request for the 2, as one batch", async () => {
    vi.spyOn(api, "nodes").mockResolvedValue([node({ address: A }), node({ address: C, synced: true })]);
    const sync = vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1, 2] });
    const address = vi.spyOn(api, "address");
    await syncNeverSyncedCenters([C, B, A]);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith({ addresses: [A, B], depth: "shallow", batch: expect.any(String) });
    expect(address).not.toHaveBeenCalled();
  });

  test("every center synced: no sync request", async () => {
    vi.spyOn(api, "nodes").mockResolvedValue([node({ address: A, synced: true })]);
    const sync = vi.spyOn(api, "sync");
    await syncNeverSyncedCenters([A]);
    expect(sync).not.toHaveBeenCalled();
  });
});
