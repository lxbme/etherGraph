import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { TransferDto } from "../api/generated/TransferDto";
import { ApiError } from "../api/errors";
import { graphQueryKey } from "../graph/useGraphData";
import { useGraph } from "../graph/store";
import { useTabs } from "../shell/tabs";
import { TransferTable } from "./TransferTable";
import { groupsForPair } from "./transferGroups";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const edge = (o: Partial<EdgeDto>): EdgeDto => ({
  from: A, to: B, asset: null, asset_kind: "native", count: 1, sum: "1000000000000000000",
  first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-02T00:00:00Z", decimals: 18, symbol: null, ...o,
});
const tr = (o: Partial<TransferDto>): TransferDto => ({
  tx_hash: "0x" + "11".repeat(32), sub_id: "0", kind: "native", block_number: 1, ts: "2024-01-01T00:00:00Z",
  from: A, to: B, asset: null, amount: "1000000000000000000", token_id: null, decimals: 18, symbol: null, ...o,
});

let qc: QueryClient;
function renderTable() {
  return render(
    <QueryClientProvider client={qc}>
      <TransferTable />
    </QueryClientProvider>,
  );
}
function seedGraph(edges: EdgeDto[]) {
  const data: GraphResponseDto = { nodes: [], edges, omitted: {}, coverage: {} };
  const s = useGraph.getState();
  qc.setQueryData(graphQueryKey({ centers: s.centers, filter: s.filter, sort: s.sort }), data);
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  useGraph.getState().reset();
  useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
});
afterEach(() => vi.restoreAllMocks());

test("groupsForPair returns both directions sorted by count", () => {
  const edges = [
    edge({ count: 2 }),
    edge({ from: B, to: A, count: 9, asset: USDC }),
    edge({ from: A, to: "0x" + "cc".repeat(20), count: 100 }),
    edge({ asset: USDC, count: 5, asset_kind: "erc20" }),
  ];
  const g = groupsForPair(edges, B, A);
  expect(g.map((x) => x.count)).toEqual([9, 5, 2]);
  expect(g[0]).toMatchObject({ from: B, to: A, asset: USDC });
});

test("shows empty hint when nothing is selected", () => {
  renderTable();
  expect(screen.getByText("选择一个节点或一条边查看转账明细")).toBeInTheDocument();
});

test("node selection lists transfers and loads more with cursor", async () => {
  const spy = vi.spyOn(api, "transfers").mockImplementation(async (p) =>
    p.cursor === undefined
      ? { items: [tr({ sub_id: "0" })], next_cursor: "c1" }
      : { items: [tr({ sub_id: "1", from: B, to: A, tx_hash: "0x" + "22".repeat(32) })], next_cursor: null },
  );
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  await screen.findByText("流出");
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ address: A, limit: 50, cursor: undefined }));
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByText("流入");
  expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ address: A, cursor: "c1" }));
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
});

test("carries over kinds, time and the single asset threshold", async () => {
  const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => {
    useGraph.getState().setFilter({
      kinds: ["erc20", "native"],
      time: { from: "2024-01-01T00:00:00Z", to: "2024-02-01T00:00:00Z" },
      assets: [{ asset: USDC.toUpperCase().replace("0X", "0x"), min_amount: "100" }],
    });
    useGraph.getState().select({ kind: "node", address: A });
  });
  renderTable();
  await screen.findByText("没有符合条件的转账");
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      address: A, asset: USDC, minAmount: "100", kinds: ["erc20", "native"],
      timeFrom: "2024-01-01T00:00:00Z", timeTo: "2024-02-01T00:00:00Z",
    }),
  );
});

test("node scope passes no asset with several asset filters", async () => {
  const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => {
    useGraph.getState().setFilter({ assets: [{ asset: null, min_amount: "1" }, { asset: USDC }] });
    useGraph.getState().select({ kind: "node", address: A });
  });
  renderTable();
  await screen.findByText("没有符合条件的转账");
  const arg = spy.mock.calls[0]![0];
  expect(arg.asset).toBeUndefined();
  expect(arg.minAmount).toBeUndefined();
});

test("pair selection renders collapsible groups with header totals", async () => {
  const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [tr({})], next_cursor: null });
  act(() => {
    useGraph.getState().setFilter({ assets: [{ asset: null, min_amount: "0.5" }] });
    useGraph.getState().addCenter(A);
    useGraph.getState().select({ kind: "pair", a: A, b: B });
  });
  seedGraph([
    edge({ count: 3, sum: "2500000000000000000" }),
    edge({ from: B, to: A, asset: USDC, asset_kind: "erc20", count: 7, sum: "5000000", decimals: 6, symbol: "USDC" }),
  ]);
  renderTable();
  const usdcHead = await screen.findByRole("button", { name: /USDC · 0xbbbb…bbbb→0xaaaa…aaaa · 7 笔 · Σ 5/ });
  const ethHead = screen.getByRole("button", { name: /ETH · 0xaaaa…aaaa→0xbbbb…bbbb · 3 笔 · Σ 2.5/ });
  expect(usdcHead).toHaveAttribute("aria-expanded", "true");
  expect(ethHead).toHaveAttribute("aria-expanded", "false");
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ from: B, to: A, asset: USDC }));
  expect(spy.mock.calls[0]![0].minAmount).toBeUndefined();
  fireEvent.click(ethHead);
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ from: A, to: B, asset: null, minAmount: "0.5" }));
  fireEvent.click(usdcHead);
  expect(usdcHead).toHaveAttribute("aria-expanded", "false");
});

test("clicking a tx hash opens a tx tab without highlighting", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [tr({})], next_cursor: null });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  const hash = "0x" + "11".repeat(32);
  fireEvent.click(await screen.findByRole("button", { name: "0x1111…1111" }));
  expect(useTabs.getState().active).toBe(hash);
  expect(useGraph.getState().highlightTransfer).toBeNull();
});

test("clicking a row sets highlightTransfer and clicking again clears it", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [tr({ asset: USDC, kind: "erc20" })], next_cursor: null });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  const row = (await screen.findByText("流出")).closest("tr")!;
  fireEvent.click(row);
  expect(useGraph.getState().highlightTransfer).toEqual({ from: A, to: B, asset: USDC });
  fireEvent.click(row);
  expect(useGraph.getState().highlightTransfer).toBeNull();
});

test("unknown decimals show the raw value with a warning", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({
    items: [tr({ amount: "1234567", decimals: null, asset: USDC, kind: "erc20" })], next_cursor: null,
  });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  const w = await screen.findByTitle("未知精度");
  expect(w.closest("td")).toHaveTextContent("1,234,567");
});

test("errors render inline with retry", async () => {
  const spy = vi.spyOn(api, "transfers")
    .mockRejectedValueOnce(new ApiError("internal", 500, "x"))
    .mockResolvedValue({ items: [], next_cursor: null });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  await screen.findByText(/服务器内部错误/);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("没有符合条件的转账");
  expect(spy).toHaveBeenCalledTimes(2);
});
