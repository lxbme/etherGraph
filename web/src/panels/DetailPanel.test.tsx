import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { AddressProfileDto } from "../api/generated/AddressProfileDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { LabelDto } from "../api/generated/LabelDto";
import { qk } from "../api/queryClient";
import { pairKey, useGraph } from "../graph/store";
import { DetailPanel } from "./DetailPanel";
import { useUi } from "./uiStore";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);

const profile = (labels: LabelDto[] = [], over: Partial<AddressProfileDto> = {}): AddressProfileDto => ({
  node: {
    address: A, kind: "contract", display_name: "Foo", ens: null, contract_name: "FooPool", labels,
    partial: true, syncing: false, synced: false, hot: false,
  },
  is_proxy: false, implementation: null, creator: null, creation_tx: null,
  coverage: [
    { kind: "native", from_block: 100, to_block: 200, truncated: true, state: "ok", last_synced_at: null },
    { kind: "erc20", from_block: null, to_block: null, truncated: false, state: "syncing", last_synced_at: null },
  ],
  first_seen: null, last_seen: null, ...over,
});

let qc: QueryClient;
function renderPanel() {
  return render(
    <QueryClientProvider client={qc}>
      <DetailPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().reset();
  useUi.setState({ labelEditorFor: null });
});
afterEach(() => vi.restoreAllMocks());

test("nothing selected shows the hint", () => {
  renderPanel();
  expect(screen.getByText("选择节点或边查看详情")).toBeInTheDocument();
});

test("node detail shows coverage per kind with truncated marker", async () => {
  const spy = vi.spyOn(api, "address").mockResolvedValue(profile());
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderPanel();
  expect(await screen.findByText("FooPool")).toBeInTheDocument();
  expect(spy).toHaveBeenCalledWith(A);
  const native = screen.getByText("普通转账").closest("li")!;
  expect(within(native).getByText("100 – 200")).toBeInTheDocument();
  expect(within(native).getByText("已截断")).toBeInTheDocument();
  expect(within(native).getByText("已同步")).toBeInTheDocument();
  const erc20 = screen.getByText("ERC20").closest("li")!;
  expect(within(erc20).getByText("同步中")).toBeInTheDocument();
  expect(within(erc20).queryByText("已截断")).toBeNull();
  expect(within(screen.getByText("ERC721").closest("li")!).getByText("未同步")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "拉更早记录" })).toBeInTheDocument();
});

test("sync buttons call api.sync", async () => {
  vi.spyOn(api, "address").mockResolvedValue(profile());
  const sync = vi.spyOn(api, "sync").mockResolvedValue({
    estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1],
  });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: "同步/刷新" }));
  await waitFor(() => expect(sync).toHaveBeenCalledWith({ addresses: [A] }));
  fireEvent.click(screen.getByRole("button", { name: "拉更早记录" }));
  await waitFor(() => expect(sync).toHaveBeenLastCalledWith({ addresses: [A], direction: "older" }));
});

test("imported labels have no delete button; user labels do", async () => {
  vi.spyOn(api, "address").mockResolvedValue(
    profile([
      { id: 1, text: "Binance 14", category: "exchange", source: "import:etherscan-labels" },
      { id: 2, text: "mine", category: "other", source: "user" },
    ]),
  );
  const del = vi.spyOn(api, "deleteLabel").mockResolvedValue(undefined as never);
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderPanel();
  const imported = (await screen.findByText("Binance 14")).closest("li")!;
  expect(within(imported).queryByRole("button")).toBeNull();
  expect(within(imported).getByText("etherscan-labels")).toBeInTheDocument();
  const user = screen.getByText("mine").closest("li")!;
  fireEvent.click(within(user).getByRole("button", { name: "删除标签" }));
  await waitFor(() => expect(del).toHaveBeenCalledWith(2));
});

test("note commits on blur only when changed", async () => {
  vi.spyOn(api, "address").mockResolvedValue(profile());
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderPanel();
  const box = await screen.findByLabelText("备注");
  fireEvent.focus(box);
  fireEvent.blur(box);
  expect(useGraph.getState().canUndo()).toBe(false);
  fireEvent.change(box, { target: { value: "hello" } });
  fireEvent.change(box, { target: { value: "hello!" } });
  expect(useGraph.getState().ui[A]?.note ?? "").toBe("");
  fireEvent.blur(box);
  expect(useGraph.getState().ui[A]?.note).toBe("hello!");
  expect(useGraph.getState()._past).toHaveLength(1);
});

test("label editor enforces 64 characters counting code points", async () => {
  vi.spyOn(api, "address").mockResolvedValue(profile());
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  act(() => useUi.getState().openLabelEditor(A));
  renderPanel();
  const input = await screen.findByLabelText("标签文本");
  const submit = screen.getByRole("button", { name: "添加" });
  expect(submit).toBeDisabled();
  fireEvent.change(input, { target: { value: "é".repeat(64) } });
  expect(screen.getByText("64/64")).toBeInTheDocument();
  expect(submit).toBeEnabled();
  fireEvent.change(input, { target: { value: "é".repeat(65) } });
  expect(screen.getByText("65/64")).toBeInTheDocument();
  expect(submit).toBeDisabled();
  fireEvent.change(input, { target: { value: "   " } });
  expect(submit).toBeDisabled();
  // Astral code points count once.
  fireEvent.change(input, { target: { value: "😀".repeat(64) } });
  expect(submit).toBeEnabled();
});

test("adding a label invalidates address and graph queries", async () => {
  vi.spyOn(api, "address").mockResolvedValue(profile());
  const add = vi.spyOn(api, "addLabel").mockResolvedValue({ id: 9, text: "x", category: "defi", source: "user" });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  act(() => useUi.getState().openLabelEditor(A));
  renderPanel();
  qc.setQueryData(qk.graph([A], {}), { nodes: [], edges: [], omitted: {}, coverage: {} });
  const inv = vi.spyOn(qc, "invalidateQueries");
  fireEvent.change(await screen.findByLabelText("标签文本"), { target: { value: " x " } });
  fireEvent.change(screen.getByLabelText("类别"), { target: { value: "defi" } });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  await waitFor(() => expect(add).toHaveBeenCalledWith({ address: A, text: "x", category: "defi" }));
  await waitFor(() => {
    const keys = inv.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(qk.address(A)));
    expect(keys).toContain(JSON.stringify(["graph"]));
  });
  await waitFor(() => expect(useUi.getState().labelEditorFor).toBeNull());
});

test("edge detail toggles the pair expansion", async () => {
  const data: GraphResponseDto = {
    nodes: [],
    edges: [
      { from: A, to: B, asset: null, asset_kind: "native", count: 3, sum: "1500000000000000000", first_ts: "", last_ts: "", decimals: 18, symbol: "ETH" },
      { from: B, to: A, asset: "0x" + "cc".repeat(20), asset_kind: "erc20", count: 1, sum: "2000000", first_ts: "", last_ts: "", decimals: 6, symbol: "USDC" },
    ],
    omitted: {}, coverage: {},
  };
  vi.spyOn(api, "graphEdges").mockResolvedValue(data);
  act(() => {
    useGraph.getState().addCenter(A);
    useGraph.getState().select({ kind: "pair", a: A, b: B });
  });
  renderPanel();
  const eth = (await screen.findByText("ETH")).closest("li")!;
  expect(within(eth).getByText("3")).toBeInTheDocument();
  expect(within(eth).getByText("1.5")).toBeInTheDocument();
  expect(screen.getByText("USDC").closest("li")).toHaveTextContent("2");
  fireEvent.click(screen.getByRole("button", { name: "展开平行边" }));
  expect(useGraph.getState().expandedPairs.has(pairKey(A, B))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "收起平行边" }));
  expect(useGraph.getState().expandedPairs.size).toBe(0);
});
