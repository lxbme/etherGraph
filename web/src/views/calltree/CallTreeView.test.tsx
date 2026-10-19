import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import type { CallFrameDto } from "../../api/generated/CallFrameDto";
import type { CallTraceResponseDto } from "../../api/generated/CallTraceResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { TxResponseDto } from "../../api/generated/TxResponseDto";
import type { CytoscapeViewProps } from "../../graph/CytoscapeView";
import { en } from "../../i18n/en";
import { useJobProgress, type JobProgressEvent } from "../../shell/statusStore";
import { useTabs } from "../../shell/tabs";
import { useUi } from "../../panels/uiStore";
import { TxFlowView } from "../TxFlowView";
import { getCallCy, getTxCy } from "../../graph/cyRegistry";
import { exportImage } from "../../graph/exportImage";
import { download } from "../../lib/download";
import { CallTreeView, useTraceFailures } from "./CallTreeView";
import { A, B, ensFrames, SENDER, synth, X } from "./fixtures.testutil";

vi.mock("../../graph/exportImage", async (orig) => ({ ...(await orig<typeof import("../../graph/exportImage")>()), exportImage: vi.fn() }));
vi.mock("../../lib/download", async (orig) => ({ ...(await orig<typeof import("../../lib/download")>()), download: vi.fn() }));

const h = vi.hoisted(() => ({ props: null as CytoscapeViewProps | null }));
vi.mock("../../graph/CytoscapeView", () => ({
  CytoscapeView: (p: CytoscapeViewProps) => {
    h.props = p;
    return <div data-testid="cy" />;
  },
}));

const HASH = "0x" + "22".repeat(32);
const USER_QUOTA = en["error.userQuota"];
const RESOLVER = "0x231b0ee14048e9dccd1d247744d114a4eb5e8e63";

const node = (address: string, over: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address, kind: "contract", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null, ...over,
});
const ready = (frames: CallFrameDto[], undecoded: string[] = []): CallTraceResponseDto => ({
  status: "ready", frames, job_id: null, undecoded,
});
const pending = (job_id = 9): CallTraceResponseDto => ({ status: "pending", frames: null, job_id, undecoded: [] });
const progress = (status: JobProgressEvent["status"], error: string | null = null): JobProgressEvent => ({
  type: "JobProgress", job_id: 9, kind: "fetch_trace", fetched: 0, cursor_block: null, status, error,
});
const txReady = (): TxResponseDto => ({
  status: "ready", job_id: null,
  flow: {
    tx: { hash: HASH, block_number: 1, ts: "2026-01-01T00:00:00Z", from: A, to: B, value: "0", success: true,
      gas_used: "21000", fee: "0", method: null, selector: null },
    detail: {
      nonce: 0, tx_type: 2, position: 0, confirmations: null, gas_limit: "21000", gas_used: "21000",
      gas_price: null, effective_gas_price: null, max_fee: null, max_priority_fee: null, base_fee: null,
      burnt_fee: null, savings: null, blob_gas_used: null, blob_gas_price: null, blob_fee: null, access_list_len: null,
      contract_created: null, revert_reason: null, input: "0x", authorizations: [], delegations: [],
    },
    call: null, nodes: [node(A, { kind: "eoa" }), node(B)], flows: [], events: [], completeness: "full_trace",
  },
});

const rowIds = () => screen.queryAllByRole("treeitem").map((r) => r.getAttribute("data-frame"));
const edges = () => h.props!.elements.filter((e) => e.data.source !== undefined);
const edgeById = (id: string) => edges().find((e) => e.data.id === id)!;

let qc: QueryClient;
function renderCalls() {
  return render(
    <QueryClientProvider client={qc}>
      <CallTreeView hash={HASH} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  h.props = null;
  useJobProgress.setState({ byId: {} });
  useTraceFailures.setState({ byHash: {} });
  useTabs.setState({ tabs: [{ id: "graph" }, { id: HASH, kind: "tx", hash: HASH }], active: HASH });
  useUi.setState({ txSelection: {} });
  vi.spyOn(api, "nodes").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

test("does_not_request_a_trace_until_the_call_view_is_opened", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(txReady());
  const trace = vi.spyOn(api, "txTrace").mockResolvedValue(ready(ensFrames));
  render(
    <QueryClientProvider client={qc}>
      <TxFlowView hash={HASH} />
    </QueryClientProvider>,
  );
  await screen.findByTestId("tx-summary-bar");
  const views = within(screen.getByRole("group", { name: "Transaction view" }));
  expect(views.getByRole("button", { name: "Asset flow" })).toHaveAttribute("aria-pressed", "true");
  expect(trace).not.toHaveBeenCalled();
  fireEvent.click(views.getByRole("button", { name: "Call tree" }));
  await screen.findByRole("tree");
  expect(trace).toHaveBeenCalledTimes(1);
  expect(trace).toHaveBeenCalledWith(HASH);
  // The choice is kept on the tab (workspaces and files save it).
  expect(useTabs.getState().tabs.find((t) => t.id === HASH)).toMatchObject({ view: "calls" });
  // The asset-flow canvas stays mounted (hidden) so its layout survives the switch; the detail tabs stay.
  expect(screen.getByTestId("tx-detail")).toBeInTheDocument();
  fireEvent.click(views.getByRole("button", { name: "Asset flow" }));
  expect(screen.queryByRole("tree")).toBeNull();
  expect(trace).toHaveBeenCalledTimes(1);
});

test("pending_then_ready_renders_tree_and_graph", async () => {
  vi.spyOn(api, "txTrace").mockResolvedValue(pending());
  vi.mocked(api.nodes).mockResolvedValue([node(SENDER, { kind: "eoa", display_name: "sender.eth" })]);
  renderCalls();
  expect(await screen.findByText("Fetching call trace…")).toBeInTheDocument();
  act(() => useJobProgress.getState().upsert(progress("pending")));
  expect(await screen.findByText("Call trace queued…")).toBeInTheDocument();
  vi.mocked(api.txTrace).mockResolvedValue(ready(ensFrames));
  await act(() => qc.invalidateQueries({ queryKey: ["txTrace", HASH] }));
  await screen.findByRole("tree");
  // Depth ≤ 3 shows; STATICCALL frames and their subtrees are hidden by default.
  expect(rowIds()).toEqual(["root", "3", "3.0", "3.0.1", "3.1", "3.2", "4", "4.0", "5"]);
  expect(screen.getAllByRole("treeitem").every((r) => Number(r.getAttribute("aria-level")) <= 4)).toBe(true);
  const root = screen.getAllByRole("treeitem")[0]!;
  expect(root).toHaveTextContent("0x74694a2b");
  expect(root).toHaveTextContent("0.0226 ETH");
  // The graph: addresses with their names, merged call edges with their order and method.
  await waitFor(() => expect(h.props!.elements.find((e) => e.data.id === SENDER)?.data.label).toBe("sender.eth"));
  expect(h.props!.layout).toBe("dagre-lr");
  expect(edges().some((e) => String(e.data.label).startsWith("①0x74694a2b"))).toBe(true);
  expect(h.props!.elements.some((e) => e.data.id?.startsWith("0x5f4ec3"))).toBe(false);

  fireEvent.click(screen.getByRole("checkbox", { name: "Show read-only calls" }));
  expect(rowIds()).toHaveLength(17);
  expect(rowIds()).toContain("1.0.0");
  expect(h.props!.elements.some((e) => e.data.id?.startsWith("0x5f4ec3"))).toBe(true);
  const staticEdge = edges().find((e) => String(e.data.target).startsWith("0x7d4e74"))!;
  expect(String(staticEdge.classes)).toContain("static");

  // Collapsing a row hides its descendants.
  fireEvent.click(within(screen.getAllByRole("treeitem").find((r) => r.getAttribute("data-frame") === "3")!).getByRole("button", { name: "Collapse" }));
  expect(rowIds()).not.toContain("3.0");
  // Clicking a row selects it: the graph highlights its edge and both ends; its details show below the tree.
  const row = screen.getAllByRole("treeitem").find((r) => r.getAttribute("data-frame") === "5")!;
  fireEvent.click(row);
  expect(row).toHaveAttribute("aria-selected", "true");
  const refund = edgeById(`0x253553366da8546fc250f225fe3d25d0c782303b>${SENDER}`);
  expect(String(refund.classes)).toContain("highlighted");
  expect(String(h.props!.elements.find((e) => e.data.id === SENDER)!.classes)).toContain("highlighted");
  const detail = within(screen.getByTestId("call-detail"));
  expect(detail.getByText("Gas used")).toBeInTheDocument();
});

test("clicking_a_merged_edge_steps_through_its_calls", async () => {
  // B calls X first and last, with 998 calls to A in between: the second call is far down the list.
  const frames = [synth([], { from: A, to: B }), synth([0], { from: B, to: X })];
  for (let i = 1; i < 999; i++) frames.push(synth([i], { from: B, to: A }));
  frames.push(synth([999], { from: B, to: X }));
  vi.spyOn(api, "txTrace").mockResolvedValue(ready(frames));
  renderCalls();
  await screen.findByRole("tree");
  expect(rowIds()).not.toContain("999");
  const id = `${B}>${X}`;
  expect(edgeById(id).data.label).toBe("② ×2");
  act(() => h.props!.onTapEdge(B, X, id));
  expect(screen.getByRole("treeitem", { selected: true })).toHaveAttribute("data-frame", "0");
  act(() => h.props!.onTapEdge(B, X, id));
  // Scrolled to: the windowed list renders it now.
  expect(screen.getByRole("treeitem", { selected: true })).toHaveAttribute("data-frame", "999");
  expect(rowIds()).not.toContain("0");
  expect(String(edgeById(id).classes)).toContain("highlighted");
  act(() => h.props!.onTapEdge(B, X, id));
  expect(screen.getByRole("treeitem", { selected: true })).toHaveAttribute("data-frame", "0");
});

test("tapping_an_edge_into_a_collapsed_subtree_expands_it", async () => {
  // A chain deeper than the default expansion: the depth-5 call is folded under the depth-3 row.
  const frames = [synth([]), synth([0]), synth([0, 0]), synth([0, 0, 0]), synth([0, 0, 0, 0]), synth([0, 0, 0, 0, 0], { from: B, to: X })];
  vi.spyOn(api, "txTrace").mockResolvedValue(ready(frames));
  renderCalls();
  await screen.findByRole("tree");
  expect(rowIds()).toEqual(["root", "0", "0.0", "0.0.0"]);
  act(() => h.props!.onTapEdge(B, X, `${B}>${X}`));
  expect(screen.getByRole("treeitem", { selected: true })).toHaveAttribute("data-frame", "0.0.0.0.0");
});

test("failed_job_shows_reason_and_retry", async () => {
  const trace = vi.spyOn(api, "txTrace").mockResolvedValue(pending());
  renderCalls();
  await screen.findByText("Fetching call trace…");
  act(() => useJobProgress.getState().upsert(progress("failed", "transaction not indexed")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't fetch the call trace: transaction not indexed");
  trace.mockResolvedValue(ready(ensFrames));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("tree");
  expect(trace).toHaveBeenCalledTimes(2);
});

test("a_failed_job_is_not_requested_again_until_retry", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const trace = vi.spyOn(api, "txTrace").mockResolvedValue(pending(9));
    renderCalls();
    await screen.findByText("Fetching call trace…");
    act(() => useJobProgress.getState().upsert(progress("failed", "trace not available from the source yet")));
    const reason = "Couldn't fetch the call trace: trace not available from the source yet";
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
    // Each request would start (and bill) a new fetch job: no polling, and an SSE invalidation does not refetch either.
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await act(() => qc.invalidateQueries({ queryKey: ["txTrace"] }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(trace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(reason);

    trace.mockResolvedValue(pending(10));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Fetching call trace…")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(trace).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("a_failed_job_stays_failed_when_a_reconnect_prunes_the_job_store", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const trace = vi.spyOn(api, "txTrace").mockResolvedValue(pending(9));
    renderCalls();
    await screen.findByText("Fetching call trace…");
    act(() => useJobProgress.getState().upsert(progress("failed", "incomplete trace")));
    const reason = "Couldn't fetch the call trace: incomplete trace";
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
    // An SSE reconnect (Lagged): the status refresh drops finished jobs and every query is invalidated.
    act(() => useJobProgress.getState().remove([9]));
    await act(() => qc.invalidateQueries());
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(trace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(reason);

    // A Retry that errors shows its error and still never polls the failed job.
    trace.mockRejectedValue(new ApiError("network", 0, "offline"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(trace).toHaveBeenCalledTimes(2));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(trace).toHaveBeenCalledTimes(2);

    trace.mockResolvedValue(pending(10));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Fetching call trace…")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(trace).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test("request_error_shows_message_and_retry", async () => {
  const trace = vi.spyOn(api, "txTrace").mockRejectedValue(new ApiError("user_quota_exhausted", 429, "quota"));
  renderCalls();
  expect(await screen.findByRole("alert")).toHaveTextContent(USER_QUOTA);
  trace.mockResolvedValue(ready(ensFrames));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("tree");
});

test("source_quota_pause_shows_specific_copy", async () => {
  vi.spyOn(api, "txTrace").mockResolvedValue(pending());
  renderCalls();
  await screen.findByText("Fetching call trace…");
  act(() => useJobProgress.getState().upsert(progress("paused_quota")));
  expect(await screen.findByText("The call-trace service's quota is used up; it will resume automatically")).toBeInTheDocument();
  expect(screen.queryByText(/Etherscan/)).toBeNull();
  act(() => useJobProgress.getState().upsert(progress("paused_user_quota")));
  expect(screen.getByText("Waiting for tomorrow's quota")).toBeInTheDocument();
});

test("snapshot_without_trace_says_the_file_has_none", () => {
  const trace = vi.spyOn(api, "txTrace");
  const snapshot = {
    exported_at: "2026-01-01T00:00:00Z", includes: { labels: false, notes: false }, flow: txReady().flow!, raw: null,
  };
  useTabs.setState({ tabs: [{ id: "graph" }, { id: HASH, kind: "tx", hash: HASH, snapshot }], active: HASH });
  renderCalls();
  expect(screen.getByText("This file has no call-tree data; refresh from the chain to fetch it")).toBeInTheDocument();
  expect(trace).not.toHaveBeenCalled();
});

test("snapshot_with_trace_renders_it_without_requesting", async () => {
  const trace = vi.spyOn(api, "txTrace");
  const identify = vi.spyOn(api, "identify");
  const flow = txReady().flow!;
  // The file's own name for the controller shows until the receiver knows better.
  const controller = "0x253553366da8546fc250f225fe3d25d0c782303b";
  const snapshot = {
    exported_at: "2026-01-01T00:00:00Z", includes: { labels: false, notes: false }, raw: null, trace: ensFrames,
    flow: { ...flow, nodes: [...flow.nodes, node(controller, { display_name: "ETHRegistrarController" })] },
  };
  useTabs.setState({ tabs: [{ id: "graph" }, { id: HASH, kind: "tx", hash: HASH, snapshot }], active: HASH });
  renderCalls();
  await screen.findByRole("tree");
  expect(rowIds()).toEqual(["root", "3", "3.0", "3.0.1", "3.1", "3.2", "4", "4.0", "5"]);
  expect(screen.getAllByRole("treeitem")[0]).toHaveTextContent("ETHRegistrarController");
  expect(edges().length).toBeGreaterThan(0);
  // A file never asks for anything to be fetched: no trace, no "decode the rest".
  expect(screen.queryByRole("button", { name: /Decode the remaining/ })).toBeNull();
  expect(trace).not.toHaveBeenCalled();
  expect(identify).not.toHaveBeenCalled();
});

test("renders_at_most_a_window_of_rows_for_2000_frames", async () => {
  const frames = [synth([])];
  for (let i = 0; i < 1999; i++) frames.push(synth([i], { from: B, to: X }));
  vi.spyOn(api, "txTrace").mockResolvedValue(ready(frames));
  renderCalls();
  const tree = await screen.findByRole("tree");
  const count = screen.getAllByRole("treeitem").length;
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(60);
  fireEvent.scroll(tree, { target: { scrollTop: 28 * 1500 } });
  expect(rowIds()).toContain("1499");
  expect(rowIds()).not.toContain("root");
  expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(60);
});

test("decode_rest_button_sends_undecoded_addresses", async () => {
  vi.spyOn(api, "txTrace").mockResolvedValue(ready(ensFrames, [X, B]));
  const identify = vi.spyOn(api, "identify").mockResolvedValue({ queued: 2, jobs: [1, 2] });
  renderCalls();
  await screen.findByRole("tree");
  fireEvent.click(screen.getByRole("button", { name: "Decode the remaining 2 contracts (about 4 API calls)" }));
  await waitFor(() => expect(identify).toHaveBeenCalledTimes(1));
  expect(identify.mock.calls[0]![0].addresses).toEqual([X, B]);
});

test("decode_rest_button_is_absent_when_everything_is_decoded", async () => {
  vi.spyOn(api, "txTrace").mockResolvedValue(ready(ensFrames));
  renderCalls();
  await screen.findByRole("tree");
  expect(screen.queryByRole("button", { name: /Decode the remaining/ })).toBeNull();
});

test("self_loop_edge_renders", async () => {
  vi.spyOn(api, "txTrace").mockResolvedValue(ready(ensFrames));
  renderCalls();
  await screen.findByRole("tree");
  const loop = edges().find((e) => e.data.source === e.data.target)!;
  expect(loop.data.source).toBe(RESOLVER);
  expect(String(loop.classes)).toContain("self-loop");
  expect(String(loop.classes)).toContain("delegate");
});

test("failed_only_keeps_the_failed_path", async () => {
  const frames = [synth([]), synth([0], { from: B, to: X, error: "Reverted" }), synth([1], { from: B, to: A })];
  vi.spyOn(api, "txTrace").mockResolvedValue(ready(frames));
  renderCalls();
  await screen.findByRole("tree");
  expect(String(edgeById(`${B}>${X}`).classes)).toContain("failed");
  fireEvent.click(screen.getByRole("checkbox", { name: "Failed call paths only" }));
  expect(rowIds()).toEqual(["root", "0"]);
  expect(screen.getAllByRole("treeitem")[1]).toHaveTextContent("Failed");
  expect(edges().some((e) => e.data.id === `${B}>${A}`)).toBe(false);
});

test("the_call_graph_registers_apart_from_the_flow_and_exports_as_ethergraph_calls", async () => {
  vi.spyOn(api, "txTrace").mockResolvedValue(ready(ensFrames));
  const blob = new Blob(["x"]);
  vi.mocked(exportImage).mockReturnValue(blob);
  const { unmount } = renderCalls();
  await screen.findByRole("tree");
  const cy = { elements: () => ({ empty: () => false }) } as unknown as import("cytoscape").Core;
  act(() => h.props!.onReady?.(cy));
  expect(getCallCy(HASH)).toBe(cy);
  expect(getTxCy(HASH)).toBeNull();
  // A clean canvas: the select-mode toggle belongs to canvases with a box selection.
  const tools = within(screen.getByRole("toolbar", { name: "Canvas tools" }));
  expect(tools.queryByRole("button", { name: "Box select (Shift+drag)" })).toBeNull();
  act(() => tools.getByRole("button", { name: "Export" }).click());
  act(() => within(screen.getByRole("menu", { name: "Export" })).getByRole("menuitem", { name: "SVG" }).click());
  expect(exportImage).toHaveBeenLastCalledWith(cy, "svg");
  expect(download).toHaveBeenLastCalledWith(blob, "ethergraph-calls-2222222222.svg");
  unmount();
  expect(getCallCy(HASH)).toBeNull();
});

test("tapping_a_node_selects_it_for_the_right_panel", async () => {
  vi.spyOn(api, "txTrace").mockResolvedValue(ready(ensFrames));
  renderCalls();
  await screen.findByRole("tree");
  act(() => h.props!.onTapNode(RESOLVER, { shift: false }));
  expect(useUi.getState().txSelection[HASH]).toBe(RESOLVER);
  expect(String(h.props!.elements.find((e) => e.data.id === RESOLVER)!.classes)).toContain("selected");
});
