import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { AddressAssetDto } from "../api/generated/AddressAssetDto";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { TransferDto } from "../api/generated/TransferDto";
import { ApiError } from "../api/errors";
import { qk } from "../api/queryClient";
import { graphQueryKey } from "../graph/useGraphData";
import { hiddenFromTransfer, transferKey } from "../graph/hiddenTransfers";
import { useGraph } from "../graph/store";
import { useTabs } from "../shell/tabs";
import { useLocale } from "../i18n";
import { useInfo } from "./info/infoStore";
import { formatLocalTime } from "../lib/format";
import { LiveConfirm } from "../views/SnapshotBanner";
import { TransferTable } from "./TransferTable";
import { groupsForPair } from "./transferGroups";
import { useTransferFilter } from "./transferFilter";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const edge = (o: Partial<EdgeDto>): EdgeDto => ({
  from: A, to: B, asset: null, asset_kind: "native", count: 1, sum: "1000000000000000000",
  first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-02T00:00:00Z", decimals: 18, symbol: null,
  trust: { level: "listed", impersonates: null, reason: null }, ...o,
});
const tr = (o: Partial<TransferDto>): TransferDto => ({
  tx_hash: "0x" + "11".repeat(32), sub_id: "0", kind: "native", block_number: 1, ts: "2024-01-01T00:00:00Z",
  from: A, to: B, asset: null, amount: "1000000000000000000", token_id: null, decimals: 18, symbol: null,
  trust: { level: "listed", impersonates: null, reason: null }, ...o,
});

/** The assets endpoint's row for an edge's asset; a pair's rows also name the direction. */
const assetRow = (e: EdgeDto, pair: boolean): AddressAssetDto => ({
  from: pair ? e.from : null, to: pair ? e.to : null, asset: e.asset, asset_kind: e.asset_kind, count: e.count,
  sum: e.sum, decimals: e.decimals, symbol: e.symbol, trust: e.trust,
});
/** Serves `GET /api/address/{a}/assets[?with=]` with the assets of `edges`. */
const serveAssets = (edges: EdgeDto[], pair = false) =>
  vi.spyOn(api, "addressAssets").mockResolvedValue(edges.map((e) => assetRow(e, pair)));

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
  qc.setQueryData(graphQueryKey(s), data);
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  useGraph.getState().reset();
  useTransferFilter.getState().reset();
  vi.spyOn(api, "addressAssets").mockResolvedValue([]);
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

test("a node whose sync was truncated shows the banner above the rows, matching the address case-insensitively", async () => {
  act(() => useGraph.getState().setCenters([A]));
  const s = useGraph.getState();
  qc.setQueryData(graphQueryKey(s), {
    nodes: [], edges: [], omitted: {},
    coverage: { [A.toUpperCase().replace("0X", "0x")]: [{ kind: "erc20", from_block: 5, to_block: 9, truncated: true, state: "ok", last_synced_at: null, oldest_ts: "2022-03-31T05:00:00Z" }] },
  } satisfies GraphResponseDto);
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null } as never);
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  expect(await screen.findByRole("status")).toHaveTextContent("ERC20 only back to 2022-03-31 · older records are missing");
});

test("shows empty hint when nothing is selected", () => {
  renderTable();
  expect(screen.getByText("Select a node or edge to see transfers")).toBeInTheDocument();
});

test("node selection lists transfers and loads more with cursor", async () => {
  const spy = vi.spyOn(api, "transfers").mockImplementation(async (p) =>
    p.cursor === undefined
      ? { items: [tr({ sub_id: "0" })], next_cursor: "c1" }
      : { items: [tr({ sub_id: "1", from: B, to: A, tx_hash: "0x" + "22".repeat(32) })], next_cursor: null },
  );
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  const table = await screen.findByRole("table");
  expect(within(table).getByText("Out")).toBeInTheDocument();
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ address: A, limit: 50, cursor: undefined }));
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await within(table).findByText("In");
  expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ address: A, cursor: "c1" }));
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("the global filter no longer narrows the node table", async () => {
  const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => {
    useGraph.getState().setCenters([A]);
    useGraph.getState().setFilter({
      kinds: ["erc20", "native"],
      direction: "in",
      time: { from: "2024-01-01T00:00:00Z", to: "2024-02-01T00:00:00Z" },
      assets: [{ asset: USDC.toUpperCase().replace("0X", "0x"), min_amount: "100" }],
    });
    useGraph.getState().select({ kind: "node", address: A });
  });
  renderTable();
  await screen.findByText("No matching transfers");
  const arg = spy.mock.calls[0]![0];
  expect(arg.address).toBe(A);
  for (const k of ["asset", "minAmount", "kinds", "timeFrom", "timeTo", "direction"] as const) expect(arg[k]).toBeUndefined();
});

test("the bar's asset and time reach the query", async () => {
  const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => {
    useGraph.getState().setCenters([A]);
    useGraph.getState().select({ kind: "node", address: A });
  });
  const assets = serveAssets([edge({}), edge({ from: B, to: A, asset: USDC, asset_kind: "erc20", decimals: 6, symbol: "USDC" })]);
  renderTable();
  await screen.findByText("No matching transfers");
  expect(assets).toHaveBeenCalledWith(A, undefined);
  const asset = screen.getByRole("combobox", { name: "Asset" });
  await within(asset).findByText("USDC · 0xa0b8…eb48");
  // All assets, then the listed group: ETH first, then the edge's token.
  expect(within(asset).getAllByRole("option").map((o) => o.textContent)).toEqual(["All assets", "ETH", "USDC · 0xa0b8…eb48"]);
  expect(asset.querySelector("optgroup")).toHaveAttribute("label", "On token lists (2)");
  expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();

  fireEvent.change(asset, { target: { value: USDC } });
  fireEvent.click(screen.getByRole("button", { name: "All time" }));
  const from = screen.getByLabelText("From (UTC)");
  const to = screen.getByLabelText("To (UTC)");
  fireEvent.change(from, { target: { value: "2022-03-23" } });
  fireEvent.change(to, { target: { value: "2022-03-31" } });
  expect(to).toHaveAttribute("min", "2022-03-23");
  expect(from).toHaveAttribute("max", "2022-03-31");
  fireEvent.change(screen.getByRole("combobox", { name: "Direction" }), { target: { value: "in" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "erc20" } });
  await waitFor(() =>
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address: A, asset: USDC, direction: "in", kinds: ["erc20"],
        timeFrom: "2022-03-23T00:00:00Z", timeTo: "2022-03-31T23:59:59Z",
      }),
    ),
  );
  expect(screen.getByRole("button", { name: "2022-03-23 – 2022-03-31" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(screen.getByRole("button", { name: "All time" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  expect(useTransferFilter.getState()).toMatchObject({ from: null, to: null, asset: undefined, direction: "all", kind: "all" });
  expect(screen.getByRole("combobox", { name: "Asset" })).toHaveValue("");
  // Back to the first, unfiltered query (cached, so no new request).
  expect(spy.mock.calls.every((c) => c[0].address === A)).toBe(true);
  expect(spy.mock.calls[0]![0]).toEqual({ address: A, limit: 50, cursor: undefined });
});

test("the filter survives selecting another node", async () => {
  const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => {
    useGraph.getState().setCenters([A]);
    useGraph.getState().select({ kind: "node", address: A });
  });
  serveAssets([edge({})]);
  renderTable();
  await screen.findByText("No matching transfers");
  fireEvent.change(screen.getByRole("combobox", { name: "Asset" }), { target: { value: "eth" } });
  await waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ address: A, asset: null })));
  act(() => useGraph.getState().select({ kind: "node", address: B }));
  await waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ address: B, asset: null })));
  expect(screen.getByRole("combobox", { name: "Asset" })).toHaveValue("eth");
});

test("pair scope hides groups of other assets and passes time to rows", async () => {
  const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => {
    useGraph.getState().addCenter(A);
    useGraph.getState().select({ kind: "pair", a: A, b: B });
  });
  // Groups come from the pair's stored transfers (any address case), not from the graph's filtered edges.
  const USDC_MIXED = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  seedGraph([edge({ count: 9 })]);
  const assets = serveAssets(
    [
      edge({ count: 9 }),
      edge({ from: B, to: A, asset: USDC_MIXED, asset_kind: "erc20", count: 7, sum: "5000000", decimals: 6, symbol: "USDC" }),
    ],
    true,
  );
  renderTable();
  expect(await screen.findAllByTestId("transfer-group")).toHaveLength(2);
  expect(assets).toHaveBeenCalledWith(A, B);
  // No direction in pair scope: each group already has one.
  expect(screen.queryByRole("combobox", { name: "Direction" })).toBeNull();
  act(() => useTransferFilter.getState().set({ asset: USDC, from: "2024-01-01", kind: "erc20" }));
  const groups = screen.getAllByTestId("transfer-group");
  expect(groups).toHaveLength(1);
  // With a time or type set, the header drops the unfiltered count and Σ.
  expect(within(groups[0]!).getByRole("button", { name: "USDC · 0xbbbb…bbbb→0xaaaa…aaaa" })).toBeInTheDocument();
  expect(groups[0]).not.toHaveTextContent(/transfers|Σ/);
  await waitFor(() =>
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: B, to: A, asset: USDC, timeFrom: "2024-01-01T00:00:00Z", kinds: ["erc20"] }),
    ),
  );
  const arg = spy.mock.lastCall![0];
  expect(arg.direction).toBeUndefined();
  expect(arg.minAmount).toBeUndefined();
});

test("pair scope with the ETH asset filter keeps the ETH group and hides token groups", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => {
    useGraph.getState().addCenter(A);
    useGraph.getState().select({ kind: "pair", a: A, b: B });
  });
  seedGraph([edge({})]);
  serveAssets([edge({}), edge({ from: B, to: A, asset: USDC, asset_kind: "erc20", decimals: 6, symbol: "USDC" })], true);
  renderTable();
  expect(await screen.findAllByTestId("transfer-group")).toHaveLength(2);
  act(() => useTransferFilter.getState().set({ asset: null }));
  const groups = screen.getAllByTestId("transfer-group");
  expect(groups).toHaveLength(1);
  expect(groups[0]).toHaveTextContent("ETH");
});

test("pair scope with a token asset filter keeps only that token's group", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => {
    useGraph.getState().addCenter(A);
    useGraph.getState().select({ kind: "pair", a: A, b: B });
  });
  seedGraph([edge({})]);
  serveAssets([edge({}), edge({ from: B, to: A, asset: USDC, asset_kind: "erc20", decimals: 6, symbol: "USDC" })], true);
  renderTable();
  expect(await screen.findAllByTestId("transfer-group")).toHaveLength(2);
  act(() => useTransferFilter.getState().set({ asset: USDC }));
  const groups = screen.getAllByTestId("transfer-group");
  expect(groups).toHaveLength(1);
  expect(groups[0]).toHaveTextContent("USDC");
});

test("the node's asset options come from its stored transfers, not the filtered graph", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => {
    useGraph.getState().setCenters([A]);
    useGraph.getState().setFilter({ assets: [{ asset: null }] });
    useGraph.getState().select({ kind: "node", address: A });
  });
  // The graph (global filter: ETH only) has no token edge; the address's own assets do.
  seedGraph([edge({})]);
  serveAssets([edge({ count: 4 }), edge({ asset: USDC, asset_kind: "erc20", decimals: 6, symbol: "USDC" })]);
  renderTable();
  const asset = screen.getByRole("combobox", { name: "Asset" });
  expect(await within(asset).findByText("USDC · 0xa0b8…eb48")).toBeInTheDocument();
});

test("pair scope: Reset follows the shown controls, ignoring the hidden direction", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  serveAssets([edge({})], true);
  act(() => {
    useTransferFilter.getState().set({ direction: "out" });
    useGraph.getState().select({ kind: "pair", a: A, b: B });
  });
  renderTable();
  await screen.findAllByTestId("transfer-group");
  expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  // The header keeps its totals: only time and type change what the rows count.
  expect(screen.getByRole("button", { name: /ETH · 0xaaaa…aaaa→0xbbbb…bbbb · 1 transfer · Σ 1/ })).toBeInTheDocument();
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  expect(await screen.findByRole("button", { name: "Reset" })).toBeInTheDocument();
});

test("the bar shows no caption text", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => useLocale.getState().setLocale("zh"));
  try {
    act(() => {
      useGraph.getState().setCenters([A]);
      useGraph.getState().setFilter({ assets: [{ asset: null }] });
      useGraph.getState().select({ kind: "node", address: A });
    });
    serveAssets([edge({})]);
    renderTable();
    const bar = screen.getByRole("toolbar");
    act(() => useTransferFilter.getState().set({ from: "2024-01-01", kind: "native" }));
    const controls = [...bar.querySelectorAll("button, select")].map((c) => c.textContent).join("");
    expect(bar.textContent).toBe(controls);
    expect(within(bar).getByRole("button", { name: "重置" })).toBeInTheDocument();
    expect(screen.queryByText(/全局/)).toBeNull();
  } finally {
    act(() => useLocale.getState().setLocale("en"));
  }
});

test("pair selection renders collapsible groups with header totals", async () => {
  const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [tr({})], next_cursor: null });
  act(() => {
    // The global filter's threshold no longer reaches the rows.
    useGraph.getState().setFilter({ assets: [{ asset: null, min_amount: "0.5" }] });
    useGraph.getState().addCenter(A);
    useGraph.getState().select({ kind: "pair", a: A, b: B });
  });
  serveAssets(
    [
      edge({ count: 3, sum: "2500000000000000000" }),
      edge({ from: B, to: A, asset: USDC, asset_kind: "erc20", count: 7, sum: "5000000", decimals: 6, symbol: "USDC" }),
    ],
    true,
  );
  renderTable();
  const usdcHead = await screen.findByRole("button", { name: /USDC · 0xbbbb…bbbb→0xaaaa…aaaa · 7 transfers · Σ 5/ });
  const ethHead = screen.getByRole("button", { name: /ETH · 0xaaaa…aaaa→0xbbbb…bbbb · 3 transfers · Σ 2.5/ });
  expect(usdcHead).toHaveAttribute("aria-expanded", "true");
  expect(ethHead).toHaveAttribute("aria-expanded", "false");
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ from: B, to: A, asset: USDC }));
  expect(spy.mock.calls[0]![0].minAmount).toBeUndefined();
  fireEvent.click(ethHead);
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ from: A, to: B, asset: null }));
  expect(spy.mock.lastCall![0].minAmount).toBeUndefined();
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
  const row = (await screen.findAllByTestId("transfer-row"))[0]!;
  fireEvent.click(row);
  expect(useGraph.getState().highlightTransfer).toEqual({ from: A, to: B, asset: USDC });
  fireEvent.click(row);
  expect(useGraph.getState().highlightTransfer).toBeNull();
});

test("a hidden transfer's row is muted with the hidden title", async () => {
  const shown = tr({ sub_id: "1" });
  const gone = tr({ sub_id: "2", tx_hash: "0x" + "22".repeat(32) });
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [shown, gone], next_cursor: null });
  act(() => {
    useGraph.getState().setTransfersHidden([hiddenFromTransfer({ ...gone, tx_hash: gone.tx_hash.toUpperCase().replace("0X", "0x") })], true);
    useGraph.getState().select({ kind: "node", address: A });
  });
  const view = renderTable();
  const check = async () => {
    const [first, second] = await screen.findAllByTestId("transfer-row");
    expect(first).not.toHaveClass("transfers__row--hidden");
    expect(first).not.toHaveAttribute("title");
    expect(second).toHaveClass("transfers__row", "transfers__row--hidden");
    expect(second).toHaveAttribute("title", "Hidden on the Data tab");
    // Still clickable.
    fireEvent.click(second!);
    expect(useGraph.getState().highlightTransfer).toEqual({ from: A, to: B, asset: null });
  };
  await check();
  view.unmount();

  // Pair scope: the group header keeps its stored totals; only the row is muted.
  act(() => useGraph.getState().select({ kind: "pair", a: A, b: B }));
  serveAssets([edge({ count: 2, sum: "2000000000000000000" })], true);
  renderTable();
  expect(await screen.findByRole("button", { name: /ETH · 0xaaaa…aaaa→0xbbbb…bbbb · 2 transfers · Σ 2/ })).toBeInTheDocument();
  await check();
});

test("the eye button hides a transfer in the shared store and shows it again", async () => {
  const row = tr({ sub_id: "1" });
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [row], next_cursor: null });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  const tableRow = (await screen.findAllByTestId("transfer-row"))[0]!;
  fireEvent.click(within(tableRow).getByRole("button", { name: "Hide" }));
  expect(Object.keys(useGraph.getState().hiddenTransfers)).toEqual([transferKey(row)]);
  expect(tableRow).toHaveClass("transfers__row--hidden");
  const show = within(tableRow).getByRole("button", { name: "Show" });
  expect(show).not.toHaveAttribute("aria-pressed");
  fireEvent.click(show);
  expect(useGraph.getState().hiddenTransfers).toEqual({});
  expect(tableRow).not.toHaveClass("transfers__row--hidden");
});

test("the eye button does not select the transfer", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [tr({})], next_cursor: null });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  const before = useGraph.getState().selection;
  fireEvent.click(await screen.findByRole("button", { name: "Hide" }));
  expect(useGraph.getState().selection).toBe(before);
  expect(useGraph.getState().highlightTransfer).toBeNull();
});

test("a transfer hidden elsewhere renders with the show button", async () => {
  const row = tr({});
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [row], next_cursor: null });
  act(() => {
    useGraph.getState().setTransfersHidden([hiddenFromTransfer(row)], true);
    useGraph.getState().select({ kind: "node", address: A });
  });
  renderTable();
  expect(await screen.findByRole("button", { name: "Show" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
});

test("unknown decimals show the raw value with a warning", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({
    items: [tr({ amount: "1234567", decimals: null, asset: USDC, kind: "erc20" })], next_cursor: null,
  });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  const w = await screen.findByRole("img", { name: "Unknown decimals" });
  expect(w.closest("td")).toHaveTextContent("1,234,567");
});

test("errors render inline with retry", async () => {
  const spy = vi.spyOn(api, "transfers")
    .mockRejectedValueOnce(new ApiError("internal", 500, "x"))
    .mockResolvedValue({ items: [], next_cursor: null });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  await screen.findByText(/Internal server error/);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No matching transfers");
  expect(spy).toHaveBeenCalledTimes(2);
});

test("amounts use fixed per-class decimals in a right-aligned num cell with the full value as title", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({
    items: [
      tr({ amount: "1234567890123456789" }),
      tr({ sub_id: "1", amount: "1239999", decimals: 6, asset: USDC, kind: "erc20", symbol: "USDC" }),
    ],
    next_cursor: null,
  });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  const eth = await screen.findByText("1.234567");
  expect(eth.tagName).toBe("TD");
  expect(eth).toHaveClass("num", "table__num");
  expect(eth).toHaveAttribute("title", "1.234567890123456789");
  const usdc = screen.getByText("1.23");
  expect(usdc).toHaveClass("num");
  expect(usdc).toHaveAttribute("title", "1.239999");
  expect(usdc.nextElementSibling).toHaveTextContent("USDC");
});

test("times render in UTC with the local time as title", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [tr({ ts: "2026-10-16T04:11:07Z" })], next_cursor: null });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  const cell = await screen.findByText("2026-10-16 04:11:07 UTC");
  expect(cell).toHaveAttribute("title", formatLocalTime("2026-10-16T04:11:07Z"));
  expect(screen.getByRole("columnheader", { name: "Time" })).toBeInTheDocument();
});

test("the type column uses the same labels as the kind filter", async () => {
  vi.spyOn(api, "transfers").mockResolvedValue({
    items: [tr({}), tr({ sub_id: "1", kind: "internal" }), tr({ sub_id: "2", asset: USDC, kind: "erc20", decimals: 6 })],
    next_cursor: null,
  });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  const table = await screen.findByRole("table");
  expect(within(table).getByText("Native transfers")).toHaveClass("transfers__muted");
  expect(within(table).getByText("Internal transactions")).toBeInTheDocument();
  expect(within(table).getByText("ERC20")).toBeInTheDocument();
  expect(within(table).queryByText("native")).toBeNull();
});

test("clicking the asset cell opens the asset in the info panel without selecting the row", async () => {
  useInfo.setState({ stacks: {} });
  vi.spyOn(api, "transfers").mockResolvedValue({
    items: [tr({ asset: USDC, kind: "erc721", token_id: "9", symbol: "NFT" })], next_cursor: null,
  });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderTable();
  fireEvent.click(await screen.findByRole("button", { name: "NFT" }));
  expect(useInfo.getState().stacks["graph"]).toEqual([{ kind: "asset", tokenKind: "erc721", asset: USDC, tokenId: "9" }]);
  expect(useGraph.getState().highlightTransfer).toBeNull();
});

test("clicking a transfer row while an asset is open shows the tx and clears the graph info stack", async () => {
  useInfo.setState({ stacks: { graph: [{ kind: "asset", asset: USDC }] } });
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [tr({})], next_cursor: null });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  useInfo.setState({ stacks: { graph: [{ kind: "asset", asset: USDC }] } });
  renderTable();
  fireEvent.click((await screen.findAllByTestId("transfer-row"))[0]!);
  expect(useGraph.getState().selection?.kind).toBe("tx");
  expect(useInfo.getState().stacks["graph"]).toEqual([]);
});

test("a flagged token's badge sits next to its symbol in rows and pair group headers", async () => {
  const FAKE = "0x" + "fa".repeat(20);
  const suspicious = { level: "suspicious", impersonates: { address: USDC, symbol: "USDC", name: "USD Coin" }, reason: null } as const;
  vi.spyOn(api, "transfers").mockResolvedValue({
    items: [
      tr({ asset: FAKE, kind: "erc20", decimals: 6, symbol: "USDC", sub_id: "1", trust: suspicious }),
      tr({ asset: USDC, kind: "erc20", decimals: 6, symbol: "USDC", sub_id: "2" }),
      tr({ asset: "0x" + "5c".repeat(20), kind: "erc20", decimals: 6, symbol: "FREE", sub_id: "3", trust: { level: "scam", impersonates: null, reason: "spam-token" } }),
    ],
    next_cursor: null,
  });
  act(() => {
    useGraph.getState().addCenter(A);
    useGraph.getState().select({ kind: "pair", a: A, b: B });
  });
  serveAssets([edge({ asset: FAKE, asset_kind: "erc20", count: 3, decimals: 6, symbol: "USDC", trust: suspicious })], true);
  renderTable();
  const head = await screen.findByRole("button", { name: /USDC · 0xaaaa…aaaa→0xbbbb…bbbb/ });
  expect(within(head).getByText("Possible impersonation")).toHaveClass("tag--warn");
  const rows = await screen.findAllByTestId("transfer-row");
  expect(within(rows[0]!).getByText("Possible impersonation")).toHaveAttribute("title", "Same name as USD Coin (0xa0b8…eb48) but not in any token list");
  expect(within(rows[1]!).queryByText("Possible impersonation")).toBeNull();
  expect(within(rows[2]!).getByText("Known scam")).toHaveClass("tag--scam");
});

describe("a frozen (snapshot) graph", () => {
  const HINT = "This snapshot does not include individual transfers. Refresh from chain to load them.";
  const freeze = () =>
    useGraph.getState().freeze({
      exported_at: "2026-10-01T12:00:00Z",
      includes: { labels: false, notes: false },
      data: { nodes: [], edges: [edge({}), edge({ asset: USDC, asset_kind: "erc20" })], omitted: {}, coverage: {} },
    });

  test.each([
    ["a node", { kind: "node" as const, address: A }],
    ["a pair", { kind: "pair" as const, a: A, b: B }],
  ])("%s: no transfers request, a hint; Refresh from chain loads them", async (_, sel) => {
    const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [tr({})], next_cursor: null });
    // A is synced here: refreshing syncs nothing, so it goes live at once.
    vi.spyOn(api, "nodes").mockResolvedValue([
      {
        address: A, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
        partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null,
      },
    ]);
    vi.spyOn(api, "graphEdges").mockResolvedValue({ nodes: [], edges: [edge({})], omitted: {}, coverage: {} });
    const assets = serveAssets([edge({})], sel.kind === "pair");
    act(() => {
      useGraph.getState().setCenters([A]);
      freeze();
      useGraph.getState().select(sel);
    });
    renderTable();
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    expect(assets).not.toHaveBeenCalled();
    // The receiver's summaries of the centers are in: the refresh is known to sync nothing.
    await waitFor(() => expect(qc.getQueryData(qk.nodes([A]))).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Refresh from chain" }));
    expect(useGraph.getState().frozen).toBeNull();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByText(HINT)).toBeNull();
  });

  test("Refresh from chain asks first (with the count and calls) when a center was never synced here", async () => {
    vi.spyOn(api, "nodes").mockResolvedValue([]);
    const sync = vi.spyOn(api, "sync");
    act(() => {
      useGraph.getState().setCenters([A]);
      freeze();
      useGraph.getState().select({ kind: "node", address: A });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <TransferTable />
        <LiveConfirm />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh from chain" }));
    const dialog = screen.getByRole("dialog", { name: "Refresh from chain" });
    expect(await within(dialog).findByText("This syncs 1 center never synced here (about 6 calls).")).toBeInTheDocument();
    expect(useGraph.getState().frozen).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(useGraph.getState().frozen).not.toBeNull();
    expect(sync).not.toHaveBeenCalled();
  });
});
