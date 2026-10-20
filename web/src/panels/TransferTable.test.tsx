import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { TransferDto } from "../api/generated/TransferDto";
import { ApiError } from "../api/errors";
import { qk } from "../api/queryClient";
import { graphQueryKey } from "../graph/useGraphData";
import { useGraph } from "../graph/store";
import { useTabs } from "../shell/tabs";
import { useInfo } from "./info/infoStore";
import { formatLocalTime } from "../lib/format";
import { LiveConfirm } from "../views/SnapshotBanner";
import { TransferTable } from "./TransferTable";
import { groupsForPair } from "./transferGroups";

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
  await screen.findByText("Out");
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ address: A, limit: 50, cursor: undefined }));
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("In");
  expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ address: A, cursor: "c1" }));
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
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
  await screen.findByText("No matching transfers");
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      address: A, asset: USDC, minAmount: "100", kinds: ["erc20", "native"],
      timeFrom: "2024-01-01T00:00:00Z", timeTo: "2024-02-01T00:00:00Z",
    }),
  );
});

describe("node scope direction (the filter's is relative to the centers)", () => {
  const D = "0x" + "dd".repeat(20);
  async function directionFor(selected: string, centers: string[], edges: EdgeDto[]) {
    const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
    act(() => {
      useGraph.getState().setCenters(centers);
      useGraph.getState().setFilter({ direction: "in" });
      useGraph.getState().select({ kind: "node", address: selected });
    });
    seedGraph(edges);
    renderTable();
    await screen.findByText("No matching transfers");
    return spy.mock.calls[0]![0];
  }

  test("a non-center node under Inbound is the sender: direction=out", async () => {
    expect(await directionFor(D, [A], [edge({ from: D, to: A })])).toMatchObject({ address: D, direction: "out" });
  });

  test("a center keeps the filter direction", async () => {
    expect(await directionFor(A, [A], [edge({ from: D, to: A })])).toMatchObject({ address: A, direction: "in" });
  });

  test("a center adjacent to another center sends no direction", async () => {
    const arg = await directionFor(A, [A, B], [edge({ from: D, to: A }), edge({ from: A, to: B })]);
    expect(arg.address).toBe(A);
    expect(arg.direction).toBeUndefined();
  });
});

test("node scope with several filtered assets renders one section per asset", async () => {
  const spy = vi.spyOn(api, "transfers").mockResolvedValue({ items: [], next_cursor: null });
  act(() => {
    useGraph.getState().addCenter(A);
    useGraph.getState().setFilter({ direction: "out", assets: [{ asset: null, min_amount: "1" }, { asset: USDC.toUpperCase().replace("0X", "0x") }] });
    useGraph.getState().select({ kind: "node", address: A });
  });
  seedGraph([edge({})]);
  renderTable();
  const sections = await screen.findAllByTestId("transfer-group");
  expect(sections).toHaveLength(2);
  expect(sections[0]).toHaveTextContent("ETH");
  expect(sections[0]).toHaveTextContent("≥ 1");
  // The first section starts open.
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  expect(spy.mock.calls[0]![0]).toMatchObject({ address: A, direction: "out", asset: null, minAmount: "1" });
  fireEvent.click(sections[1]!.querySelector("button")!);
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  const second = spy.mock.calls[1]![0];
  expect(second).toMatchObject({ address: A, direction: "out", asset: USDC });
  expect(second.minAmount).toBeUndefined();
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
  const usdcHead = await screen.findByRole("button", { name: /USDC · 0xbbbb…bbbb→0xaaaa…aaaa · 7 transfers · Σ 5/ });
  const ethHead = screen.getByRole("button", { name: /ETH · 0xaaaa…aaaa→0xbbbb…bbbb · 3 transfers · Σ 2.5/ });
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
  const row = (await screen.findByText("Out")).closest("tr")!;
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
  expect(await screen.findByText("Native transfers")).toHaveClass("transfers__muted");
  expect(screen.getByText("Internal transactions")).toBeInTheDocument();
  expect(screen.getByText("ERC20")).toBeInTheDocument();
  expect(screen.queryByText("native")).toBeNull();
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
  seedGraph([edge({ asset: FAKE, asset_kind: "erc20", count: 3, decimals: 6, symbol: "USDC", trust: suspicious })]);
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
    act(() => {
      useGraph.getState().setCenters([A]);
      freeze();
      useGraph.getState().select(sel);
    });
    renderTable();
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
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
