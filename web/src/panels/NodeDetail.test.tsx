import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { AddressProfileDto } from "../api/generated/AddressProfileDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { useGraph } from "../graph/store";
import { graphQueryKey } from "../graph/useGraphData";
import { useLocale } from "../i18n";
import { formatLocalTime } from "../lib/format";
import { NodeDetail } from "./NodeDetail";
import { usePick } from "./pick/pickStore";

const A = "0x" + "aa".repeat(20);
const IMPL = "0x" + "AB".repeat(20);

const profile: AddressProfileDto = {
  node: {
    address: A, kind: "contract", display_name: null, ens: null, contract_name: "Proxy", labels: [],
    partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null,
  },
  is_proxy: true, implementation: IMPL, creator: null, creation_tx: null, coverage: [], first_seen: null, last_seen: null,
};

let qc: QueryClient;
function renderDetail(onNavigate?: (a: string) => void, p: AddressProfileDto = profile) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  vi.spyOn(api, "address").mockResolvedValue(p);
  render(
    <QueryClientProvider client={qc}>
      <NodeDetail address={A} onNavigate={onNavigate} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  useGraph.getState().reset();
  usePick.getState().close();
});
afterEach(() => vi.restoreAllMocks());

test("with onNavigate the implementation button navigates locally and leaves the main graph alone", async () => {
  const onNavigate = vi.fn();
  renderDetail(onNavigate);
  fireEvent.click(await screen.findByTitle(IMPL));
  expect(onNavigate).toHaveBeenCalledWith(IMPL.toLowerCase());
  expect(useGraph.getState().centers).toEqual([]);
  expect(useGraph.getState().selection).toBeNull();
});

test("without onNavigate the implementation button puts it on the graph alone, selects it and offers the picker", async () => {
  const sync = vi.spyOn(api, "sync");
  renderDetail();
  fireEvent.click(await screen.findByTitle(IMPL));
  expect(useGraph.getState().centers).toEqual([IMPL.toLowerCase()]);
  expect(useGraph.getState().picks[IMPL.toLowerCase()]).toEqual([]);
  expect(useGraph.getState().selection).toEqual({ kind: "node", address: IMPL.toLowerCase() });
  expect(usePick.getState().targets).toEqual([IMPL.toLowerCase()]);
  expect(sync).not.toHaveBeenCalled();
});

const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const wallet: AddressProfileDto = {
  node: {
    address: A, kind: "eoa", display_name: null, ens: null, contract_name: null,
    labels: [{ id: 1, text: "Hot wallet", category: "cex", source: "import:x" }],
    partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null,
  },
  is_proxy: false, implementation: null, creator: null, creation_tx: null,
  coverage: [{ kind: "native", from_block: 1, to_block: 2, truncated: false, state: "ok", last_synced_at: null, oldest_ts: null }],
  first_seen: "2024-09-12T01:02:03Z", last_seen: "2026-10-16T04:11:07Z",
};

test("follows the spec hierarchy: kind, address with copy, tags, key/value grid, primary action", async () => {
  renderDetail(undefined, wallet);
  const kind = await screen.findByText("Wallet");
  expect(kind).toHaveClass("overline");
  const addr = screen.getByText(A);
  expect(addr).toHaveClass("num");
  expect(within(addr.parentElement!).getByRole("button", { name: "Copy" })).toBeInTheDocument();

  const tags = screen.getByTestId("node-tags");
  expect(within(tags).getByText("CEX")).toBeInTheDocument();
  expect(within(tags).getByText("Synced")).toBeInTheDocument();
  expect(within(tags).getByText("Hot wallet")).toBeInTheDocument();

  const kv = screen.getByTestId("node-kv");
  expect(kv).toHaveClass("kv");
  const keys = [...kv.querySelectorAll("dt")].map((d) => d.textContent);
  expect(keys.slice(0, 5)).toEqual(["Transactions", "First seen", "Last active", "Neighbours", "Coverage"]);
  const last = within(kv).getByText("2026-10-16 04:11:07 UTC");
  expect(last).toHaveAttribute("title", formatLocalTime("2026-10-16T04:11:07Z"));
  expect(within(kv).getByText("1 / 5")).toBeInTheDocument();
  // No balance row until the node has been probed.
  expect(screen.queryByTestId("node-balance")).toBeNull();

  expect(screen.getByRole("button", { name: "Sync / refresh" })).toHaveClass("btn--primary");
  // Order on the page.
  const order = [kind, addr, tags, kv, screen.getByRole("button", { name: "Sync / refresh" })];
  for (let i = 1; i < order.length; i++) {
    expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

describe("token and proxy tags", () => {
  const other = { id: 1, text: "Centre: USD Coin", category: "other", source: "import:eth-labels" } as const;
  const usdc: AddressProfileDto = {
    ...profile,
    node: { ...profile.node, labels: [other], is_proxy: true, token: { standard: "erc20", symbol: "USDC", decimals: 6 } },
  };
  afterEach(() => useLocale.getState().setLocale("en"));

  test("sit next to the kind and leave out the Other category", async () => {
    renderDetail(undefined, usdc);
    const kind = await screen.findByText("Contract · ERC-20 token · Proxy");
    expect(kind).toHaveClass("overline");
    const tags = screen.getByTestId("node-tags");
    expect(within(tags).getByText("Centre: USD Coin")).toBeInTheDocument();
    expect(within(tags).queryByText("Other")).toBeNull();
  });

  test("are translated", async () => {
    act(() => useLocale.getState().setLocale("zh"));
    renderDetail(undefined, usdc);
    expect(await screen.findByText("合约 · ERC-20 代币 · 代理")).toHaveClass("overline");
  });

  test("a misflagged implementation has no proxy row (Etherscan flags it, the node says no)", async () => {
    renderDetail(undefined, { ...usdc, node: { ...usdc.node, is_proxy: false } });
    const kv = await screen.findByTestId("node-kv");
    expect(within(kv).queryByText("Proxy", { selector: "dt" })).toBeNull();
    expect(screen.queryByTitle(IMPL)).toBeNull();
    cleanup();
    renderDetail(undefined, usdc);
    expect(await screen.findByTitle(IMPL)).toBeInTheDocument();
  });

  test("other categories still show, and Other shows on an untagged node", async () => {
    const cex = { ...other, id: 2, category: "cex" } as const;
    renderDetail(undefined, { ...usdc, node: { ...usdc.node, labels: [other, cex] } });
    const tags = await screen.findByTestId("node-tags");
    expect(within(tags).getByText("CEX")).toBeInTheDocument();
    expect(within(tags).queryByText("Other")).toBeNull();
    cleanup();
    // The profile's own node has no tags (a file saved before they existed) and the profile no proxy flag.
    renderDetail(undefined, { ...profile, is_proxy: false, node: { ...profile.node, labels: [other] } });
    expect(await screen.findByText("Contract")).toHaveClass("overline");
    expect(within(screen.getByTestId("node-tags")).getByText("Other")).toBeInTheDocument();
  });

  test("a node saved before the proxy flag takes it from the profile, in the kind line as in the proxy row", async () => {
    // `profile.node` has no `is_proxy`; the profile itself says proxy.
    renderDetail(undefined, profile);
    expect(await screen.findByText("Contract · Proxy")).toHaveClass("overline");
    expect(within(screen.getByTestId("node-kv")).getByText("Proxy", { selector: "dt" })).toBeInTheDocument();
  });
});

test("transactions and neighbours come from the canvas edges", async () => {
  act(() => useGraph.getState().setCenters([A]));
  renderDetail(undefined, wallet);
  const e = { asset: null, asset_kind: "native", sum: "1", first_ts: "", last_ts: "", decimals: 18, symbol: null, trust: { level: "listed", impersonates: null, reason: null } } as const;
  const data: GraphResponseDto = {
    nodes: [], omitted: {}, coverage: {},
    edges: [{ ...e, from: A, to: B, count: 3 }, { ...e, from: C, to: A, count: 4 }, { ...e, from: B, to: A, count: 2 }, { ...e, from: B, to: C, count: 9 }],
  };
  const s = useGraph.getState();
  act(() => qc.setQueryData(graphQueryKey(s), data));
  const kv = await screen.findByTestId("node-kv");
  await waitFor(() => expect(within(kv).getByText("Transactions").nextElementSibling).toHaveTextContent("9"));
  expect(within(kv).getByText("Neighbours").nextElementSibling).toHaveTextContent("2");
});

test("transactions and neighbours leave out transfers hidden on the Data tab", async () => {
  act(() => useGraph.getState().setCenters([A]));
  renderDetail(undefined, wallet);
  const e = { asset: null, asset_kind: "native", sum: "1", first_ts: "", last_ts: "", decimals: 18, symbol: null, trust: { level: "listed", impersonates: null, reason: null } } as const;
  const data: GraphResponseDto = {
    nodes: [], omitted: {}, coverage: {},
    edges: [{ ...e, from: A, to: B, count: 1 }, { ...e, from: C, to: A, count: 4 }],
  };
  act(() => qc.setQueryData(graphQueryKey(useGraph.getState()), data));
  const kv = await screen.findByTestId("node-kv");
  await waitFor(() => expect(within(kv).getByText("Transactions").nextElementSibling).toHaveTextContent("5"));
  expect(within(kv).getByText("Neighbours").nextElementSibling).toHaveTextContent("2");
  // The only transfer of A → B is hidden: that edge leaves the canvas.
  act(() =>
    useGraph.getState().setTransfersHidden(
      [{ tx_hash: "0x" + "01".repeat(32), sub_id: "0", from: A, to: B, asset: null, amount: "1", ts: "", kind: "native" }],
      true,
    ),
  );
  await waitFor(() => expect(within(kv).getByText("Transactions").nextElementSibling).toHaveTextContent("4"));
  expect(within(kv).getByText("Neighbours").nextElementSibling).toHaveTextContent("1");
});

test("copy writes the full address and shows a check", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  renderDetail(undefined, wallet);
  fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith(A);
  await screen.findByRole("button", { name: "Copied" });
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

test("free-text key/value cells carry the full value as title (they ellipsize in the panel)", async () => {
  const ens = "the-quick-brown-fox-jumps-over-lazys.eth";
  renderDetail(undefined, { ...profile, node: { ...profile.node, ens, contract_name: "AVeryLongContractNameThatWillNotFit" } });
  const kv = await screen.findByTestId("node-kv");
  expect(within(kv).getByText(ens)).toHaveAttribute("title", ens);
  expect(within(kv).getByText("AVeryLongContractNameThatWillNotFit")).toHaveAttribute("title", "AVeryLongContractNameThatWillNotFit");
});

test("a probed node shows its balance above the grid and the sent-transaction count", async () => {
  act(() => useGraph.getState().setCenters([A]));
  renderDetail(undefined, { ...wallet, node: { ...wallet.node, nonce: 1234, balance: "1500000000000000000" } });
  const bal = await screen.findByTestId("node-balance");
  expect(bal).toHaveTextContent("1.500000 ETH");
  const tags = screen.getByTestId("node-tags");
  const kv = screen.getByTestId("node-kv");
  expect(tags.compareDocumentPosition(bal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(bal.compareDocumentPosition(kv) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const keys = [...kv.querySelectorAll("dt")].map((d) => d.textContent);
  expect(keys[0]).toBe("Transactions sent");
  expect(kv.querySelector("dd")).toHaveTextContent("1,234");
});

test("without a nonce the transactions row keeps the canvas count and no balance row shows", async () => {
  renderDetail(undefined, wallet);
  const kv = await screen.findByTestId("node-kv");
  expect([...kv.querySelectorAll("dt")][0]!.textContent).toBe("Transactions");
  expect(screen.queryByTestId("node-balance")).toBeNull();
});

test("an imported label shows its dataset; a cross-chain one says so and neither has a remove button", async () => {
  const p: AddressProfileDto = {
    ...wallet,
    node: {
      ...wallet.node,
      labels: [
        { id: 1, text: "Hot wallet", category: "cex", source: "import:eth-labels" },
        { id: 2, text: "Other chain name", category: "hacker", source: "import:eth-labels-xchain" },
      ],
    },
  };
  renderDetail(undefined, p);
  const main = (await screen.findByText("Hot wallet")).closest(".tag") as HTMLElement;
  expect(main).toHaveAttribute("title", "CEX · Source: eth-labels");
  const x = screen.getByText("Other chain name").closest(".tag") as HTMLElement;
  expect(x).toHaveAttribute("title", "Hacker / exploiter · eth-labels · from another EVM chain");
  expect(within(main).queryByRole("button")).toBeNull();
  expect(within(x).queryByRole("button")).toBeNull();
  expect(within(screen.getByTestId("node-tags")).getByText("Hacker / exploiter")).toHaveClass("tag--hacker");
});

describe("node_detail_offers_pick_and_highlights_when_ready", () => {
  const PICK = "Pick neighbours…";
  const READY = "Synced: you can pick neighbours now";
  const node = (synced: boolean) => ({ ...wallet.node, labels: [], synced });
  /** The graph tab's detail of A, with A on the canvas. */
  function renderGraphDetail(synced = true) {
    const p = { ...wallet, node: node(synced) };
    vi.spyOn(api, "graphEdges").mockResolvedValue({ nodes: [node(synced)], edges: [], omitted: {}, coverage: {} });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    vi.spyOn(api, "address").mockResolvedValue(p);
    render(
      <QueryClientProvider client={qc}>
        <NodeDetail address={A} graph />
      </QueryClientProvider>,
    );
  }

  test("a synced center with nothing picked yet: the primary action, with the hint; a click opens the picker", async () => {
    useGraph.getState().addCenter(A);
    renderGraphDetail();
    const pick = await screen.findByRole("button", { name: PICK });
    expect(pick).toHaveClass("btn--primary");
    expect(screen.getByRole("button", { name: "Sync / refresh" })).not.toHaveClass("btn--primary");
    expect(screen.getByText(READY)).toBeInTheDocument();
    fireEvent.click(pick);
    expect(usePick.getState().targets).toEqual([A]);
    expect(useGraph.getState().centers).toEqual([A]);
  });

  test("otherwise it is offered as a plain button, without the hint", async () => {
    // Picks made already.
    useGraph.getState().loadSnapshot({ centers: [A], filter: {}, expandedPairs: [], ui: {}, picks: { [A]: [B] } });
    renderGraphDetail();
    expect(await screen.findByRole("button", { name: PICK })).not.toHaveClass("btn--primary");
    expect(screen.getByRole("button", { name: "Sync / refresh" })).toHaveClass("btn--primary");
    expect(screen.queryByText(READY)).toBeNull();
    cleanup();
    // Not synced yet.
    useGraph.getState().reset();
    useGraph.getState().addCenter(A);
    renderGraphDetail(false);
    expect(await screen.findByRole("button", { name: PICK })).not.toHaveClass("btn--primary");
    expect(screen.queryByText(READY)).toBeNull();
    cleanup();
    // Not a center.
    useGraph.getState().reset();
    renderGraphDetail();
    expect(await screen.findByRole("button", { name: PICK })).not.toHaveClass("btn--primary");
    expect(screen.queryByText(READY)).toBeNull();
  });

  test("a tx tab's detail has no picker button (its own Add to graph offers it)", async () => {
    renderDetail(undefined, wallet);
    await screen.findByTestId("node-kv");
    expect(screen.queryByRole("button", { name: PICK })).toBeNull();
  });
});
