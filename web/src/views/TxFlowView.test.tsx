import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { FlowDto } from "../api/generated/FlowDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import type { TxResponseDto } from "../api/generated/TxResponseDto";
import type { CytoscapeViewProps } from "../graph/CytoscapeView";
import { openFakePopover, pressEscape } from "../graph/fakePopover.testutil";
import { useGraph } from "../graph/store";
import { useLocale } from "../i18n";
import { useInfo } from "../panels/info/infoStore";
import { useJobProgress } from "../shell/statusStore";
import { useTabs } from "../shell/tabs";
import { useUi } from "../panels/uiStore";
import { Toasts } from "../shell/Toasts";
import { getTxCy } from "../graph/cyRegistry";
import { exportImage } from "../graph/exportImage";
import { download } from "../lib/download";
import { clearExport, useFileRequest } from "../workspace/fileRequest";
import { TxFlowView, TxNodeDetail } from "./TxFlowView";

vi.mock("../graph/exportImage", async (orig) => ({ ...(await orig<typeof import("../graph/exportImage")>()), exportImage: vi.fn() }));
vi.mock("../lib/download", async (orig) => ({ ...(await orig<typeof import("../lib/download")>()), download: vi.fn() }));

const h = vi.hoisted(() => ({ props: null as CytoscapeViewProps | null }));
vi.mock("../graph/CytoscapeView", () => ({
  CytoscapeView: (p: CytoscapeViewProps) => {
    h.props = p;
    return <div data-testid="cy" />;
  },
}));
vi.mock("../panels/NodeDetail", () => ({
  NodeDetail: ({ address, onNavigate, fileLabels }: { address: string; onNavigate?: (a: string) => void; fileLabels?: { text: string }[] }) => (
    <div>
      detail:{address}
      {fileLabels && fileLabels.length > 0 && <span>file-labels:{fileLabels.map((l) => l.text).join(",")}</span>}
      <button onClick={() => onNavigate?.("0x" + "cc".repeat(20))}>impl-link</button>
    </div>
  ),
}));

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const HASH = "0x" + "11".repeat(32);
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";

const node = (address: string, over: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null, ...over,
});
const flow: FlowDto = {
  seq: 1, from: A, to: B, asset: USDT, amount: "12500000", token_id: null, kind: "erc20",
  trace_path: null, log_index: 0, decimals: 6, symbol: "USDT", trust: { level: "listed", impersonates: null, reason: null },
};
const bar = () => within(screen.getByTestId("tx-summary-bar"));
const detail = () => within(screen.getByTestId("tx-detail"));
const detailTab = (name: string) => fireEvent.click(detail().getByRole("button", { name }));

const ready = (over: Partial<TxFlowDto> = {}): TxResponseDto => ({
  status: "ready", job_id: null,
  flow: {
    tx: { hash: HASH, block_number: 19000000, ts: "2026-01-01T00:00:00Z", from: A, to: B, value: "0", success: true,
      gas_used: "21000", fee: "1500000000000000", method: "swap", selector: "0x12345678" },
    detail: {
      nonce: 0, tx_type: 2, position: 0, confirmations: null, gas_limit: "21000", gas_used: "21000",
      gas_price: null, effective_gas_price: null, max_fee: null, max_priority_fee: null, base_fee: null,
      burnt_fee: null, savings: null, blob_gas_used: null, blob_gas_price: null, blob_fee: null, access_list_len: null,
      contract_created: null, revert_reason: null, input: "0x", authorizations: [], delegations: [],
    },
    call: { signature: "swap(uint256,address)", name: "swap", args: [{ name: "amount", ty: "uint256", value: "5" }], via_delegate: null },
    nodes: [node(A), node(B, { contract_name: "Router", kind: "contract" })],
    flows: [flow],
    events: [
      { address: B, log_index: 3, name: "Swap", args: [{ name: "amount0", ty: "int256", value: "9" }], topics: ["0xabc"], data: "0x" },
      { address: B, log_index: 4, name: null, args: [], topics: ["0x" + "ee".repeat(32)], data: "0x" },
    ],
    completeness: "fund_flow", ...over,
  },
});

let qc: QueryClient;
function renderView() {
  return render(
    <QueryClientProvider client={qc}>
      <TxFlowView hash={HASH} />
      <aside data-testid="aside">
        <TxNodeDetail hash={HASH} />
      </aside>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().reset();
  useJobProgress.setState({ byId: {} });
  useTabs.setState({ tabs: [{ id: "graph" }, { id: HASH, kind: "tx", hash: HASH }], active: HASH });
  useUi.setState({ txSelection: {}, labelEditorFor: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => useLocale.getState().setLocale("en"));
});

test("pending shows loading and ready renders the summary bar, overview and banner", async () => {
  vi.spyOn(api, "tx").mockResolvedValue({ status: "pending", flow: null, job_id: 7 });
  renderView();
  expect(await screen.findByText(/Fetching transaction/)).toBeInTheDocument();
  expect(screen.queryByTestId("cy")).toBeNull();
  vi.mocked(api.tx).mockResolvedValue(ready());
  await act(() => qc.invalidateQueries({ queryKey: ["tx", HASH] }));
  await screen.findByTestId("tx-summary-bar");
  expect(bar().getByText("Success").querySelector("svg.lucide-circle-check")).not.toBeNull();
  expect(bar().getByText("swap")).toHaveAttribute("title", "swap(uint256,address)");
  expect(bar().getByText("Router")).toBeInTheDocument();
  expect(bar().getByText("0.001500 ETH")).toBeInTheDocument();
  expect(bar().getByText("2026-01-01 00:00:00")).toBeInTheDocument();
  // The detail tabs open on the overview.
  expect(detail().getByText("19000000")).toBeInTheDocument();
  expect(
    screen.getByText("This is a fund-flow graph, not a full call tree: data comes from Etherscan internal transactions and event logs, and omits zero-ETH calls and delegatecall nesting."),
  ).toBeInTheDocument();
  expect(screen.getByTestId("cy")).toBeInTheDocument();
  expect(h.props!.layout).toBe("dagre-lr");
});

test("the tx canvas has a legend with call / flow edges and the asset colours present", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(ready());
  const { container } = renderView();
  await screen.findByTestId("tx-summary-bar");
  const legend = within(container.querySelector(".txview__graph")!).getByTestId("legend");
  expect(within(legend).getByText("Call (sender → recipient)")).toBeInTheDocument();
  expect(within(legend).getByText("①②③ = order of transfers")).toBeInTheDocument();
  expect(within(legend).getByText("Stablecoin")).toBeInTheDocument();
  expect(within(legend).queryByText("NFT")).toBeNull();
});

test("the call edge's tooltip explains it and names the decoded method", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(ready());
  renderView();
  await screen.findByTestId("tx-summary-bar");
  act(() => h.props!.onHover?.({ kind: "edge", id: "call", pos: { x: 5, y: 5 } }));
  const tip = screen.getByTestId("graph-tooltip");
  expect(tip).toHaveTextContent("Call: sender → recipient. ETH value, if any, is its own flow edge");
  expect(tip).toHaveTextContent("Methodswap");
});

test("undecoded call shows the raw selector and no banner for full traces", async () => {
  const r = ready({ call: null, completeness: "full_trace" });
  r.flow!.tx.success = false;
  r.flow!.tx.method = null;
  vi.spyOn(api, "tx").mockResolvedValue(r);
  renderView();
  await screen.findByTestId("tx-summary-bar");
  expect(bar().getByText("0x12345678")).toBeInTheDocument();
  expect(bar().getByText("Undecoded")).toBeInTheDocument();
  expect(bar().getByText("Failed").querySelector("svg.lucide-circle-x")).not.toBeNull();
  expect(screen.queryByText(/This is a fund-flow graph/)).toBeNull();
});

test("the old flows/events tables live on in the Token Transfers and Logs tabs", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(ready());
  renderView();
  await screen.findByTestId("tx-detail");
  detailTab("Token Transfers");
  expect(detail().getByText("12.50")).toBeInTheDocument();
  expect(detail().getByText("USDT")).toBeInTheDocument();
  detailTab("Logs");
  expect(detail().getByText("Swap")).toBeInTheDocument();
  expect(detail().getByText("amount0")).toBeInTheDocument();
  expect(detail().getByText("0x" + "ee".repeat(32))).toBeInTheDocument();
  expect(detail().getByText("Undecoded")).toBeInTheDocument();
});

test("add to graph adds the address as a center without leaving the tab", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(ready());
  renderView();
  await screen.findByTestId("cy");
  expect(screen.getByText("Select a node to see details")).toBeInTheDocument();
  act(() => h.props!.onTapNode(B, { shift: false }));
  // The detail is rendered by the app-level panel, not inside the tx view (whose canvas keeps its width).
  expect(screen.getByTestId("aside")).toHaveTextContent(`detail:${B}`);
  expect(screen.getByTestId("tx-view")).not.toHaveTextContent(`detail:${B}`);
  expect(screen.getByTestId("tx-view").querySelector("aside")).toBeNull();
  // A node hidden on the main graph is shown again.
  act(() => useGraph.getState().setHidden([B], true));
  fireEvent.click(within(screen.getByTestId("aside")).getByRole("button", { name: "Add to graph" }));
  expect(useGraph.getState().centers).toContain(B);
  expect(useGraph.getState().ui[B]?.hidden).toBe(false);
  expect(useGraph.getState().selection).toBeNull();
  expect(useTabs.getState().active).toBe(HASH);
});

test("failed job shows the error and retry refetches", async () => {
  const spy = vi.spyOn(api, "tx").mockResolvedValue({ status: "pending", flow: null, job_id: 9 });
  renderView();
  await screen.findByText(/Fetching transaction/);
  act(() =>
    useJobProgress.getState().upsert({
      type: "JobProgress", job_id: 9, kind: "fetch_tx", fetched: 0, cursor_block: null, status: "failed", error: "boom",
    }),
  );
  expect(await screen.findByText("Transaction fetch failed: boom")).toBeInTheDocument();
  spy.mockResolvedValue(ready());
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(await screen.findByTestId("tx-summary-bar")).toHaveTextContent("Success");
});

test("NodeDetail address links select locally and leave the main graph untouched", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(ready());
  renderView();
  await screen.findByTestId("cy");
  act(() => h.props!.onTapNode(B, { shift: false }));
  fireEvent.click(screen.getByRole("button", { name: "impl-link" }));
  expect(screen.getByText(/detail:0xcccc/)).toBeInTheDocument();
  expect(useGraph.getState().centers).toEqual([]);
  expect(useGraph.getState().selection).toBeNull();
});

test("a missing recipient shows Contract creation in the summary bar", async () => {
  const r = ready({ call: null });
  r.flow!.tx.to = null;
  r.flow!.tx.method = null;
  vi.spyOn(api, "tx").mockResolvedValue(r);
  renderView();
  await screen.findByTestId("tx-summary-bar");
  expect(bar().getAllByText("Contract creation")).toHaveLength(2); // as the method and as the recipient
});

test("a contract creation's summary bar points at the created contract", async () => {
  const r = ready({ call: null });
  r.flow!.tx.to = null;
  r.flow!.tx.method = null;
  r.flow!.detail.contract_created = B;
  vi.spyOn(api, "tx").mockResolvedValue(r);
  renderView();
  await screen.findByTestId("tx-summary-bar");
  expect(bar().getAllByText("Contract creation")).toHaveLength(1);
  expect(bar().getByText("Router")).toHaveAttribute("title", B);
});

test("a failed contract creation's summary bar does not point at the undeployed address", async () => {
  const r = ready({ call: null });
  r.flow!.tx.to = null;
  r.flow!.tx.method = null;
  r.flow!.tx.success = false;
  r.flow!.detail.contract_created = B;
  vi.spyOn(api, "tx").mockResolvedValue(r);
  renderView();
  await screen.findByTestId("tx-summary-bar");
  expect(bar().getAllByText("Contract creation")).toHaveLength(2);
  expect(bar().queryByTitle(B)).toBeNull();
});

test("pending refetches every 5s and stops once ready", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const spy = vi.spyOn(api, "tx").mockResolvedValue({ status: "pending", flow: null, job_id: 7 });
    renderView();
    await screen.findByText(/Fetching transaction/);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockResolvedValue(ready());
    await act(() => vi.advanceTimersByTimeAsync(5100));
    await screen.findByTestId("tx-summary-bar");
    expect(spy).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("detail tabs use the shared table, segmented tabs and button styles with localized headers", async () => {
  const internal: FlowDto = { ...flow, seq: 2, kind: "internal", asset: null, amount: "1", decimals: 18, symbol: null, log_index: null, trace_path: "0_1" };
  vi.spyOn(api, "tx").mockResolvedValue(ready({ flows: [flow, internal] }));
  renderView();
  await screen.findByTestId("tx-detail");
  detailTab("Token Transfers");
  const amount = detail().getByText("12.50").closest("td")!;
  expect(amount.closest("table")).toHaveClass("table");
  expect(amount).toHaveClass("num", "table__num");
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["#", "From", "To", "Amount", "Token"]);
  expect(screen.getByRole("columnheader", { name: "Amount" })).toHaveClass("table__num");
  const tab = detail().getByRole("button", { name: "Token Transfers" });
  expect(tab).toHaveClass("seg__item");
  expect(tab.parentElement).toHaveClass("seg");

  act(() => useLocale.getState().setLocale("zh"));
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["#", "发送方", "接收方", "金额", "代币"]);
  detailTab("内部调用");
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["#", "发送方", "接收方", "金额", "调用路径"]);
  act(() => useLocale.getState().setLocale("en"));
  expect(screen.getAllByRole("columnheader")[4]).toHaveTextContent("Trace");

  act(() => h.props!.onTapNode(B, { shift: false }));
  expect(within(screen.getByTestId("aside")).getByRole("button", { name: "Add to graph" })).toHaveClass("btn");
});

test("detail table address names select the node in the tx graph and the right panel follows", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(ready());
  renderView();
  await screen.findByTestId("tx-detail");
  detailTab("Token Transfers");
  const row = detail().getAllByRole("row")[1]!;
  // Copy / add-to-graph buttons neither select nor highlight.
  fireEvent.click(within(row).getAllByRole("button", { name: "Add to graph" })[1]!);
  expect(useUi.getState().txSelection[HASH] ?? null).toBeNull();
  expect(row).not.toHaveClass("txdetail__row--active");
  fireEvent.click(within(row).getByRole("button", { name: "Router" }));
  expect(useUi.getState().txSelection[HASH]).toBe(B);
  expect(screen.getByTestId("aside")).toHaveTextContent(`detail:${B}`);
  expect(h.props!.elements.find((e) => e.data.id === B)!.classes).toContain("selected");
  expect(row).not.toHaveClass("txdetail__row--active");
});

test("clicking a token-transfer or internal-call row highlights its flow edge; clicking again clears it", async () => {
  const internal: FlowDto = { ...flow, seq: 2, kind: "internal", asset: null, amount: "1", decimals: 18, symbol: null, log_index: null, trace_path: "0_1" };
  vi.spyOn(api, "tx").mockResolvedValue(ready({ flows: [flow, internal] }));
  renderView();
  await screen.findByTestId("tx-detail");
  const edge = (id: string) => h.props!.elements.find((e) => e.data.id === id)!;
  detailTab("Token Transfers");
  const amount = detail().getByText("12.50");
  fireEvent.click(amount);
  expect(amount.closest("tr")).toHaveClass("txdetail__row--active");
  expect(edge("flow-1-0").classes).toContain("highlighted");
  expect(edge("flow-2-1").classes).not.toContain("highlighted");
  fireEvent.click(amount);
  expect(amount.closest("tr")).not.toHaveClass("txdetail__row--active");
  expect(edge("flow-1-0").classes).not.toContain("highlighted");

  detailTab("Internal Calls");
  fireEvent.click(detail().getByText("0_1"));
  expect(detail().getByText("0_1").closest("tr")).toHaveClass("txdetail__row--active");
  expect(edge("flow-2-1").classes).toContain("highlighted");
  expect(edge("flow-1-0").classes).not.toContain("highlighted");
  expect(useTabs.getState().tabs.find((t) => t.id === HASH)).toMatchObject({ highlightedSeq: 2 });
});

describe("box selection", () => {
  /** A stand-in for the canvas handle: records native unselects. */
  function fakeCy() {
    const unselect = vi.fn();
    const handlers: Record<string, () => void> = {};
    const on = vi.fn((ev: string, fn: () => void) => void (handlers[ev] = fn));
    const elements = () => ({ empty: () => false });
    return { cy: { $: vi.fn(() => ({ unselect })), on, elements } as unknown as import("cytoscape").Core, unselect, handlers };
  }
  async function selectBoth() {
    vi.spyOn(api, "tx").mockResolvedValue(ready());
    renderView();
    await screen.findByTestId("cy");
    const f = fakeCy();
    act(() => h.props!.onReady?.(f.cy));
    act(() => h.props!.onSelectionChange([A, B]));
    return f;
  }
  const bar = () => within(screen.getByRole("toolbar", { name: "Batch actions" }));

  test("right-click keeps the box selection when the node is in it, drops it when not", async () => {
    const f = await selectBoth();
    act(() => h.props!.onCxtNode(A, { x: 1, y: 1 }));
    expect(screen.getByRole("toolbar", { name: "Batch actions" })).toBeInTheDocument();
    expect(f.unselect).not.toHaveBeenCalled();
    act(() => h.props!.onSelectionChange([B]));
    act(() => h.props!.onCxtNode(A, { x: 1, y: 1 }));
    expect(screen.queryByRole("toolbar", { name: "Batch actions" })).toBeNull();
    expect(f.unselect).toHaveBeenCalled();
  });

  test("the box-selected row appears in the legend while nodes are box-selected", async () => {
    await selectBoth();
    expect(screen.getByText("In the box selection (dashed ring)")).toBeInTheDocument();
    act(() => h.props!.onSelectionChange([]));
    expect(screen.queryByText("In the box selection (dashed ring)")).toBeNull();
  });

  test("the tx menu closes when the viewport moves", async () => {
    const f = await selectBoth();
    act(() => h.props!.onCxtNode(A, { x: 1, y: 1 }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    act(() => f.handlers.viewport!());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("shows the tx batch bar with the count; Add to graph makes them centers in one step with one toast", async () => {
    await selectBoth();
    expect(bar().getByText("2 nodes selected")).toBeInTheDocument();
    expect(bar().queryByRole("button", { name: "Pin" })).toBeNull();
    act(() => useGraph.getState().setHidden([B], true));
    render(<Toasts />);
    act(() => bar().getByRole("button", { name: "Add to graph" }).click());
    expect(useGraph.getState().centers).toEqual([A, B]);
    expect(useGraph.getState().ui[B]?.hidden).toBe(false);
    expect(screen.getAllByText(/Added .*to the graph/)).toHaveLength(1);
    expect(screen.getByText("Added 2 addresses to the graph")).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Batch actions" })).toBeNull();
    act(() => useGraph.getState().undo());
    expect(useGraph.getState().centers).toEqual([]);
    expect(useTabs.getState().active).toBe(HASH);
  });

  test("Add label opens one editor for the selected addresses; copy puts them on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await selectBoth();
    act(() => bar().getByRole("button", { name: "Add label" }).click());
    expect(useUi.getState().labelEditorFor).toEqual([A, B]);
    expect(bar().getByLabelText("Label text")).toBeInTheDocument();
    await act(async () => bar().getByRole("button", { name: "Copy addresses" }).click());
    expect(writeText).toHaveBeenCalledWith(`${A}\n${B}`);
  });

  test("Escape (while this tab is shown) and Cancel clear it, natively too", async () => {
    const f = await selectBoth();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(screen.queryByRole("toolbar", { name: "Batch actions" })).toBeNull();
    expect(f.unselect).toHaveBeenCalled();

    act(() => h.props!.onSelectionChange([A]));
    act(() => useTabs.setState({ active: "graph" }));
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(screen.getByRole("toolbar", { name: "Batch actions" })).toBeInTheDocument();
    act(() => bar().getByRole("button", { name: "Cancel" }).click());
    expect(screen.queryByRole("toolbar", { name: "Batch actions" })).toBeNull();
  });

  test("Escape with a popover open (focus on its trigger) closes only the popover; a second Escape clears the selection", async () => {
    const f = await selectBoth();
    const pop = openFakePopover();
    try {
      act(() => pressEscape(pop.trigger));
      expect(pop.isOpen()).toBe(false);
      expect(screen.getByRole("toolbar", { name: "Batch actions" })).toBeInTheDocument();
      expect(f.unselect).not.toHaveBeenCalled();
      act(() => pressEscape(pop.trigger));
      expect(screen.queryByRole("toolbar", { name: "Batch actions" })).toBeNull();
    } finally {
      pop.dispose();
    }
  });

  test("the canvas is registered under its hash and exports as ethergraph-tx-<first 10 hex>.<ext>", async () => {
    const blob = new Blob(["x"]);
    vi.mocked(exportImage).mockReturnValue(blob);
    const f = await selectBoth();
    expect(getTxCy(HASH)).toBe(f.cy);
    act(() => within(screen.getByRole("toolbar", { name: "Canvas tools" })).getByRole("button", { name: "Export" }).click());
    act(() => within(screen.getByRole("menu", { name: "Export" })).getByRole("menuitem", { name: "PNG" }).click());
    expect(exportImage).toHaveBeenLastCalledWith(f.cy, "png");
    expect(download).toHaveBeenLastCalledWith(blob, "ethergraph-tx-1111111111.png");
    cleanup();
    expect(getTxCy(HASH)).toBeNull();
  });

  test("the canvas tools' File… asks to export this tab as a file", async () => {
    await selectBoth();
    act(() => within(screen.getByRole("toolbar", { name: "Canvas tools" })).getByRole("button", { name: "Export" }).click());
    act(() => within(screen.getByRole("menu", { name: "Export" })).getByRole("menuitem", { name: "File…" }).click());
    expect(useFileRequest.getState().exporting).toEqual({ kind: "tx", tabHash: HASH });
    act(() => clearExport());
  });

  test("the canvas tools toggle select mode for this canvas", async () => {
    await selectBoth();
    expect(h.props!.selectMode).toBe(false);
    act(() => screen.getByRole("button", { name: "Box select (Shift+drag)" }).click());
    expect(h.props!.selectMode).toBe(true);
  });
});

const withUnknown = () => {
  const r = ready();
  r.flow!.nodes = [node(A), node(B, { kind: "unknown", identified: false }), node("0x" + "dd".repeat(20), { kind: "contract", identified: false })];
  return r;
};

test("right-clicking a flow node opens the tx menu and selects it; Identify type queues that address", async () => {
  const identify = vi.spyOn(api, "identify").mockResolvedValue({ queued: 1, jobs: [1] });
  vi.spyOn(api, "tx").mockResolvedValue(withUnknown());
  renderView();
  await screen.findByTestId("cy");
  act(() => h.props!.onCxtNode(A, { x: 5, y: 5 }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Identify type" })).toBeNull(); // A is identified
  expect(useUi.getState().txSelection[HASH]).toBe(A);
  act(() => h.props!.onCxtNode(B, { x: 5, y: 5 }));
  await act(async () => screen.getByRole("menuitem", { name: "Identify type" }).click());
  expect(identify.mock.calls[0]![0].addresses).toEqual([B]);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("Identify all uses the flow nodes; it is absent when all are identified", async () => {
  const identify = vi.spyOn(api, "identify").mockResolvedValue({ queued: 2, jobs: [1] });
  const spy = vi.spyOn(api, "tx").mockResolvedValue(ready());
  renderView();
  await screen.findByTestId("cy");
  expect(screen.queryByRole("button", { name: /^Identify all/ })).toBeNull();
  spy.mockResolvedValue(withUnknown());
  await act(() => qc.invalidateQueries({ queryKey: ["tx", HASH] }));
  const btn = await screen.findByRole("button", { name: "Identify all (2)" });
  await act(async () => btn.click());
  expect(identify.mock.calls[0]![0].addresses).toEqual([B, "0x" + "dd".repeat(20)]);
});

test("the tx batch bar offers Identify type for selected nodes that need it", async () => {
  const identify = vi.spyOn(api, "identify").mockResolvedValue({ queued: 1, jobs: [1] });
  vi.spyOn(api, "tx").mockResolvedValue(withUnknown());
  renderView();
  await screen.findByTestId("cy");
  act(() => h.props!.onSelectionChange?.([A, B]));
  const bar = within(screen.getByRole("toolbar", { name: "Batch actions" }));
  await act(async () => bar.getByRole("button", { name: "Identify type" }).click());
  expect(identify.mock.calls[0]![0].addresses).toEqual([B]);
});

test("tapping a node or the call edge clears the tab's info stack; a transfer edge opens its asset; the background keeps it", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(ready());
  renderView();
  await screen.findByTestId("tx-detail");
  const key = HASH.toLowerCase();
  const doc = { kind: "doc", id: "erc-20" } as const;
  act(() => useInfo.getState().open(key, doc));
  act(() => h.props!.onTapBackground?.());
  expect(useInfo.getState().stacks[key]).toEqual([doc]);
  act(() => h.props!.onTapEdge(A, B, "flow-1-0"));
  expect(useInfo.getState().stacks[key]).toEqual([doc, { kind: "asset", tokenKind: "erc20", asset: USDT }]);
  act(() => h.props!.onTapEdge(A, B, "call"));
  expect(useInfo.getState().stacks[key]).toEqual([]);
  act(() => useInfo.getState().open(key, doc));
  act(() => h.props!.onTapNode(A, { shift: false }));
  expect(useInfo.getState().stacks[key]).toEqual([]);
});

describe("token-contract nodes and EIP-7702", () => {
  const D = "0x" + "dd".repeat(20);
  // A batch self-call: A delegated to D; USDT only emitted the Transfer log of B → A.
  const batch = () =>
    ready({
      tx: { ...ready().flow!.tx, from: A, to: A, method: "execute" },
      detail: {
        ...ready().flow!.detail,
        tx_type: 4,
        // The first entry has no recovered signer; the edges and tooltips follow the server's delegations.
        authorizations: [
          { chain_id: "5", delegate: B, nonce: "0", authority: null },
          { chain_id: "1", delegate: D, nonce: "2", authority: A },
        ],
        delegations: [{ authority: A, delegate: D }],
      },
      call: { signature: "execute(bytes)", name: "execute", args: [], via_delegate: D },
      nodes: [node(A, { display_name: "alice.eth" }), node(B), node(D, { kind: "contract" }), node(USDT, { kind: "contract", display_name: "Tether" })],
      flows: [{ ...flow, from: B, to: A }],
    });

  test("tapping a token-contract node opens its asset with the kind hint instead of the node detail", async () => {
    vi.spyOn(api, "tx").mockResolvedValue(batch());
    renderView();
    await screen.findByTestId("tx-detail");
    act(() => h.props!.onTapNode(B, { shift: false }));
    expect(useUi.getState().txSelection[HASH]).toBe(B);
    act(() => h.props!.onTapNode(USDT, { shift: false }));
    expect(useInfo.getState().stacks[HASH]).toEqual([{ kind: "asset", asset: USDT, tokenKind: "erc20" }]);
    // The node detail underneath is left as it was (Back returns to it).
    expect(useUi.getState().txSelection[HASH]).toBe(B);
  });

  test("tooltips: the token contract explains itself, the delegation edge names both ends, the call names the delegate ABI", async () => {
    vi.spyOn(api, "tx").mockResolvedValue(batch());
    renderView();
    await screen.findByTestId("tx-summary-bar");
    act(() => h.props!.onHover?.({ kind: "node", id: USDT, pos: { x: 5, y: 5 } }));
    expect(screen.getByTestId("graph-tooltip")).toHaveTextContent("it emitted the Transfer events but did not send or receive funds itself");
    act(() => h.props!.onHover?.({ kind: "node", id: B, pos: { x: 5, y: 5 } }));
    expect(screen.getByTestId("graph-tooltip")).not.toHaveTextContent("Token contract");
    act(() => h.props!.onHover?.({ kind: "edge", id: "delegation-0", pos: { x: 5, y: 5 } }));
    expect(screen.getByTestId("graph-tooltip")).toHaveTextContent("EIP-7702 delegation");
    expect(screen.getByTestId("graph-tooltip")).toHaveTextContent("alice.eth → 0xdddd…dddd");
    act(() => h.props!.onHover?.({ kind: "edge", id: "call", pos: { x: 5, y: 5 } }));
    expect(screen.getByTestId("graph-tooltip")).toHaveTextContent("Decoded with the delegate's ABI (0xdddd…dddd)");
  });

  test("the legend lists the token-contract and delegation rows only when they are drawn", async () => {
    vi.spyOn(api, "tx").mockResolvedValue(batch());
    const { container } = renderView();
    await screen.findByTestId("tx-summary-bar");
    const legend = within(container.querySelector(".txview__graph")!).getByTestId("legend");
    expect(within(legend).getByText("Token contract (dotted link)")).toBeInTheDocument();
    expect(within(legend).getByText("Delegation (EIP-7702)")).toBeInTheDocument();
    const ids = h.props!.elements.map((e) => String(e.data.id));
    expect(ids).toEqual(expect.arrayContaining(["delegation-0", `asset-link-${USDT}-${B}`]));
  });

  test("a tx without them shows neither row", async () => {
    vi.spyOn(api, "tx").mockResolvedValue(ready());
    const { container } = renderView();
    await screen.findByTestId("tx-summary-bar");
    const legend = within(container.querySelector(".txview__graph")!).getByTestId("legend");
    expect(within(legend).queryByText("Token contract (dotted link)")).toBeNull();
    expect(within(legend).queryByText("Delegation (EIP-7702)")).toBeNull();
  });
});

describe("a snapshot tab (frozen)", () => {
  const fileLabel = { id: -1, text: "sender says hi", category: "other", source: "file" };
  const snapshotFlow = (): TxFlowDto => ({
    ...ready().flow!,
    nodes: [node(A, { labels: [fileLabel] }), node(B, { kind: "unknown", contract_name: null })],
  });
  const withSnapshot = (raw: { tx: unknown; receipt: unknown } | null) =>
    useTabs.setState({
      tabs: [
        { id: "graph" },
        {
          id: HASH, kind: "tx", hash: HASH,
          snapshot: { exported_at: "2026-10-01T12:00:00Z", includes: { labels: true, notes: false }, flow: snapshotFlow(), raw: raw as never },
        },
      ],
      active: HASH,
    });

  test("shows the file's flow with no tx request, a banner and live identities", async () => {
    const tx = vi.spyOn(api, "tx").mockResolvedValue(ready());
    const nodes = vi.spyOn(api, "nodes").mockImplementation(async (addrs) =>
      addrs.map((a) => (a === B ? node(B, { kind: "contract", contract_name: "Router", display_name: "Router" }) : node(a, { kind: "unknown", synced: false }))),
    );
    withSnapshot(null);
    renderView();
    await screen.findByTestId("tx-summary-bar");
    const local = new Date("2026-10-01T12:00:00Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    const when = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
    expect(screen.getByText(`Snapshot from a file · exported ${when}`)).toBeInTheDocument();
    // B's name comes from the receiver's own data.
    expect(await bar().findByText("Router")).toBeInTheDocument();
    expect(nodes).toHaveBeenCalledWith([A, B]);
    expect(tx).not.toHaveBeenCalled();
    // The node detail shows the file's own labels for the selected node.
    act(() => useUi.getState().selectTx(HASH, A));
    expect(within(screen.getByTestId("aside")).getByText("file-labels:sender says hi")).toBeInTheDocument();
  });

  test("Refresh from chain drops the snapshot and loads the tx", async () => {
    vi.spyOn(api, "nodes").mockResolvedValue([]);
    const tx = vi.spyOn(api, "tx").mockResolvedValue(ready({ nodes: [node(A), node(B, { contract_name: "LiveRouter", kind: "contract" })] }));
    withSnapshot(null);
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh from chain" }));
    await waitFor(() => expect(tx).toHaveBeenCalledWith(HASH));
    await screen.findByTestId("tx-summary-bar");
    expect(await bar().findByText("LiveRouter")).toBeInTheDocument();
    expect(screen.queryByText(/Snapshot from a file/)).toBeNull();
    const tab = useTabs.getState().tabs.find((t) => t.id === HASH);
    expect(tab && "kind" in tab ? tab.snapshot : "missing").toBeUndefined();
  });

  test("Raw shows the file's raw data with no request; a snapshot without it says so", async () => {
    vi.spyOn(api, "nodes").mockResolvedValue([]);
    const raw = vi.spyOn(api, "txRaw").mockResolvedValue({ tx: {}, receipt: {} });
    withSnapshot({ tx: { nonce: "0xfile" }, receipt: { status: "0x1" } });
    const { unmount } = renderView();
    await screen.findByTestId("tx-summary-bar");
    detailTab("Raw");
    expect(detail().getByText(/0xfile/)).toBeInTheDocument();
    unmount();

    withSnapshot(null);
    renderView();
    await screen.findByTestId("tx-summary-bar");
    detailTab("Raw");
    expect(detail().getByText("This snapshot has no raw data")).toBeInTheDocument();
    expect(raw).not.toHaveBeenCalled();
  });
});

test("the_detail_panel_sits_in_a_resizable_split", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(ready());
  renderView();
  const sep = await screen.findByRole("separator", { name: "Resize the details panel height" });
  expect(sep.getAttribute("aria-orientation")).toBe("horizontal");
  const split = sep.closest(".split") as HTMLElement;
  expect(split.querySelector(".split__top")).toContainElement(screen.getByTestId("cy"));
  expect(split.querySelector(".split__bottom")).toContainElement(screen.getByTestId("tx-detail"));
  // Until resized, the panel keeps the 40% the fixed-height panel had.
  expect((split.querySelector(".split__bottom") as HTMLElement).style.height).toBe("40%");
});
