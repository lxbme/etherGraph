import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { FlowDto } from "../api/generated/FlowDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import type { TxResponseDto } from "../api/generated/TxResponseDto";
import type { CytoscapeViewProps } from "../graph/CytoscapeView";
import { useGraph } from "../graph/store";
import { useJobProgress } from "../shell/statusStore";
import { useTabs } from "../shell/tabs";
import { TxFlowView } from "./TxFlowView";

const h = vi.hoisted(() => ({ props: null as CytoscapeViewProps | null }));
vi.mock("../graph/CytoscapeView", () => ({
  CytoscapeView: (p: CytoscapeViewProps) => {
    h.props = p;
    return <div data-testid="cy" />;
  },
}));
vi.mock("../panels/NodeDetail", () => ({
  NodeDetail: ({ address, onNavigate }: { address: string; onNavigate?: (a: string) => void }) => (
    <div>
      detail:{address}
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
  partial: false, syncing: false, synced: true, hot: false, ...over,
});
const flow: FlowDto = {
  seq: 1, from: A, to: B, asset: USDT, amount: "12500000", token_id: null, kind: "erc20",
  trace_path: null, log_index: 0, decimals: 6, symbol: "USDT",
};
const ready = (over: Partial<TxFlowDto> = {}): TxResponseDto => ({
  status: "ready", job_id: null,
  flow: {
    tx: { hash: HASH, block_number: 19000000, ts: "2026-01-01T00:00:00Z", from: A, to: B, value: "0", success: true,
      gas_used: "21000", fee: "1500000000000000", method: "swap", selector: "0x12345678" },
    call: { signature: "swap(uint256,address)", name: "swap", args: [{ name: "amount", ty: "uint256", value: "5" }] },
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
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().reset();
  useJobProgress.setState({ byId: {} });
  useTabs.setState({ active: HASH });
});
afterEach(() => vi.restoreAllMocks());

test("pending shows loading and ready renders header with fee and banner", async () => {
  vi.spyOn(api, "tx").mockResolvedValue({ status: "pending", flow: null, job_id: 7 });
  renderView();
  expect(await screen.findByText(/正在获取交易/)).toBeInTheDocument();
  expect(screen.queryByTestId("cy")).toBeNull();
  vi.mocked(api.tx).mockResolvedValue(ready());
  await act(() => qc.invalidateQueries({ queryKey: ["tx", HASH] }));
  expect(await screen.findByText("✓ 成功")).toBeInTheDocument();
  expect(screen.getByText(/swap\(uint256,address\)/)).toBeInTheDocument();
  expect(screen.getByText(/Router/)).toBeInTheDocument();
  expect(screen.getByText("19000000")).toBeInTheDocument();
  expect(screen.getByText("0.0015 ETH")).toBeInTheDocument();
  expect(
    screen.getByText("这是资金流图，不是完整调用树：数据来自 Etherscan 的内部交易和事件日志，不包含不带 ETH 的调用和 delegatecall 的层级。"),
  ).toBeInTheDocument();
  expect(screen.getByTestId("cy")).toBeInTheDocument();
  expect(h.props!.layout).toBe("dagre-lr");
});

test("undecoded call shows the raw selector and no banner for full traces", async () => {
  const r = ready({ call: null, completeness: "full_trace" });
  r.flow!.tx.success = false;
  vi.spyOn(api, "tx").mockResolvedValue(r);
  renderView();
  expect(await screen.findByText("0x12345678")).toBeInTheDocument();
  expect(screen.getAllByText("未解码").length).toBeGreaterThan(0);
  expect(screen.getByText("✗ 失败")).toBeInTheDocument();
  expect(screen.queryByText(/这是资金流图/)).toBeNull();
});

test("tables switch between flows and events", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(ready());
  renderView();
  expect(await screen.findByText("12.5 USDT")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "事件" }));
  expect(screen.getByText("Swap")).toBeInTheDocument();
  expect(screen.getByText("amount0=9")).toBeInTheDocument();
  expect(screen.getByText("0xeeee…eeee")).toBeInTheDocument();
  expect(screen.getByText("未解码")).toBeInTheDocument();
});

test("add to graph adds the address as a center without leaving the tab", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(ready());
  renderView();
  await screen.findByTestId("cy");
  act(() => h.props!.onTapNode(B, { shift: false }));
  expect(screen.getByText(`detail:${B}`)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "加入关系图" }));
  expect(useGraph.getState().centers).toContain(B);
  expect(useGraph.getState().selection).toBeNull();
  expect(useTabs.getState().active).toBe(HASH);
});

test("failed job shows the error and retry refetches", async () => {
  const spy = vi.spyOn(api, "tx").mockResolvedValue({ status: "pending", flow: null, job_id: 9 });
  renderView();
  await screen.findByText(/正在获取交易/);
  act(() =>
    useJobProgress.getState().upsert({
      type: "JobProgress", job_id: 9, kind: "fetch_tx", fetched: 0, cursor_block: null, status: "failed", error: "boom",
    }),
  );
  expect(await screen.findByText("交易抓取失败：boom")).toBeInTheDocument();
  spy.mockResolvedValue(ready());
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("✓ 成功")).toBeInTheDocument();
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

test("flows table is sorted by seq and a missing recipient shows 合约创建", async () => {
  const r = ready({ flows: [{ ...flow, seq: 2, amount: "2000000" }, { ...flow, seq: 1, amount: "1000000" }] });
  r.flow!.tx.to = null;
  vi.spyOn(api, "tx").mockResolvedValue(r);
  renderView();
  await screen.findByText("1 USDT");
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows[0]).toHaveTextContent("1 USDT");
  expect(rows[1]).toHaveTextContent("2 USDT");
  expect(screen.getByText(/合约创建 · swap/)).toBeInTheDocument();
});

test("pending refetches every 5s and stops once ready", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const spy = vi.spyOn(api, "tx").mockResolvedValue({ status: "pending", flow: null, job_id: 7 });
    renderView();
    await screen.findByText(/正在获取交易/);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockResolvedValue(ready());
    await act(() => vi.advanceTimersByTimeAsync(5100));
    await screen.findByText("✓ 成功");
    expect(spy).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
