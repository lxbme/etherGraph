import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import fixture from "../../../e2e/fixtures/tx.json";
import { api } from "../../api/endpoints";
import type { DecodedEventDto } from "../../api/generated/DecodedEventDto";
import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useGraph } from "../../graph/store";
import { useLocale } from "../../i18n";
import { useUi } from "../../panels/uiStore";
import { useTabs } from "../../shell/tabs";
import { TxDetailTabs } from "./TxDetailTabs";

const ALICE = "0xa11ce00000000000000000000000000000000001";
const BOB = "0xb0b0000000000000000000000000000000000002";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const CREATED = "0xdeadbeef00000000000000000000000000000004";

/** The e2e fixture's flow with decoded call arguments and a log. */
function base(): TxFlowDto {
  const f = structuredClone(fixture.flow) as unknown as TxFlowDto;
  f.call = {
    signature: "swapExactETHForTokens(uint256,address[],address,uint256)",
    name: "swapExactETHForTokens",
    args: [
      { name: "amountOutMin", ty: "uint256", value: "6400000000" },
      { name: "path", ty: "address[]", value: `[${WETH}, 0xdac17f958d2ee523a2206206994597c13d831ec7]` },
      { name: "to", ty: "address", value: ALICE },
      { name: "deadline", ty: "uint256", value: "1709382600" },
    ],
  };
  f.detail.input = "0x7ff36ab5" + "00".repeat(128);
  f.events = [
    {
      address: "0xdac17f958d2ee523a2206206994597c13d831ec7", log_index: 12, name: "Transfer",
      args: [
        { name: "from", ty: "address", value: BOB },
        { name: "to", ty: "address", value: ALICE },
        { name: "value", ty: "uint256", value: "6400000000" },
      ],
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
      data: "0x" + "00".repeat(28) + "17d78400",
    },
  ];
  return f;
}

/** A contract-creation transaction (no recipient, initcode as input, not decoded). */
function creation(bytes = 64): TxFlowDto {
  const f = base();
  f.tx.to = null;
  f.tx.method = null;
  f.tx.selector = null;
  f.call = null;
  f.detail.contract_created = CREATED;
  f.detail.input = "0x" + "60".repeat(bytes);
  return f;
}

let qc: QueryClient;
function renderTabs(flow: TxFlowDto) {
  return render(
    <QueryClientProvider client={qc}>
      <TxDetailTabs flow={flow} />
    </QueryClientProvider>,
  );
}
/** The value cell next to a key in the overview's key/value list. */
function valueOf(label: string): HTMLElement {
  const dt = screen.getByText(label, { selector: "dt" });
  return dt.nextElementSibling as HTMLElement;
}
const tab = (name: string) => within(screen.getByRole("group", { name: /^(Transaction details|交易详情)$/ })).getByRole("button", { name });

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().reset();
  const h = fixture.flow.tx.hash;
  useTabs.setState({ tabs: [{ id: "graph" }, { id: h, kind: "tx", hash: h }], active: h });
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => useLocale.getState().setLocale("en"));
});

test("opens on Overview with the fee breakdown, gas usage and Gwei prices", () => {
  renderTabs(base());
  expect(tab("Overview")).toHaveAttribute("aria-pressed", "true");
  // Per-gas prices lead with Gwei; the exact wei and ETH values are the title.
  expect(valueOf("Base fee")).toHaveTextContent(/^19 Gwei$/);
  expect(within(valueOf("Base fee")).getByText("19 Gwei")).toHaveAttribute("title", "19,000,000,000 wei = 0.000000019 ETH");
  expect(valueOf("Burnt fees")).toHaveTextContent("0.002888 ETH");
  expect(valueOf("Savings")).toHaveTextContent("0.001520 ETH");
  expect(valueOf("Max priority fee")).toHaveTextContent(/^1 Gwei$/);
  expect(valueOf("Gas used")).toHaveTextContent("152,000 (76.0%)");
  expect(valueOf("Gas limit")).toHaveTextContent("200,000");
  expect(valueOf("Transaction type")).toHaveTextContent("EIP-1559");
  expect(valueOf("Nonce")).toHaveTextContent("12");
  expect(valueOf("Position in block")).toHaveTextContent("41");
  expect(valueOf("Block")).toHaveTextContent("19350000");
  expect(valueOf("Transaction fee")).toHaveTextContent("0.003040 ETH");
  expect(valueOf("Value")).toHaveTextContent("2.000000 ETH");
  expect(valueOf("Access list entries")).toHaveTextContent("0");
  // Confirmations are unknown while the chain head is: shown as a dash.
  expect(valueOf("Confirmations")).toHaveTextContent("—");
  // Not applicable to a type-2 transaction: no rows at all.
  expect(screen.queryByText("Blob gas used")).toBeNull();
  expect(screen.queryByText("Blob fee")).toBeNull();
  expect(screen.queryByText("Contract created")).toBeNull();
  // Only the active tab renders.
  expect(screen.queryByText("Transfer")).toBeNull();
  expect(screen.queryByText("Etherscan omits zero-value calls.")).toBeNull();
});

test("Overview groups its rows: hash and status, then identity / parties / value, then gas and fees", () => {
  renderTabs(base());
  const groups = within(screen.getByTestId("tx-overview")).getAllByRole("term").reduce<string[][]>((acc, dt) => {
    const dl = dt.parentElement!;
    const i = [...dl.parentElement!.children].indexOf(dl);
    (acc[i] ??= []).push(dt.textContent!);
    return acc;
  }, []);
  expect(groups[0]).toEqual(["Transaction hash", "Status"]);
  expect(groups[1]).toEqual(expect.arrayContaining(["Block", "From", "To", "Value", "Nonce"]));
  expect(groups[2]).toEqual(expect.arrayContaining(["Gas limit", "Gas used", "Base fee", "Burnt fees", "Transaction fee"]));
  expect(groups[1]).not.toContain("Gas used");
});

test("a legacy pre-London transaction shows a dash for base fee, burnt and savings and hides other absent fields", () => {
  const f = base();
  Object.assign(f.detail, {
    tx_type: 0, effective_gas_price: null, max_fee: null, max_priority_fee: null, base_fee: null,
    burnt_fee: null, savings: null, access_list_len: null, position: null, confirmations: 1234,
  });
  renderTabs(f);
  expect(valueOf("Transaction type")).toHaveTextContent("Legacy");
  expect(valueOf("Base fee")).toHaveTextContent(/^—$/);
  expect(valueOf("Burnt fees")).toHaveTextContent(/^—$/);
  expect(valueOf("Savings")).toHaveTextContent(/^—$/);
  expect(valueOf("Gas price")).toHaveTextContent(/^20 Gwei$/);
  expect(valueOf("Confirmations")).toHaveTextContent("1,234");
  for (const gone of ["Max fee", "Max priority fee", "Access list entries", "Position in block"]) {
    expect(screen.queryByText(gone)).toBeNull();
  }
});

test("blob fields and the revert reason appear when present; a failed creation deployed nothing", () => {
  const f = creation();
  Object.assign(f.detail, { tx_type: 3, blob_gas_used: "131072", blob_gas_price: "7", blob_fee: "917504", revert_reason: "Too little received" });
  f.tx.success = false;
  renderTabs(f);
  expect(valueOf("Transaction type")).toHaveTextContent("EIP-4844");
  expect(valueOf("Blob gas used")).toHaveTextContent("131,072");
  // Under 1 Gwei a price reads in wei.
  expect(valueOf("Blob gas price")).toHaveTextContent(/^7 wei$/);
  expect(valueOf("Blob fee")).toHaveTextContent("<0.000001 ETH");
  expect(within(valueOf("Blob fee")).getByText(/ETH/)).toHaveAttribute("title", "0.000000000000917504");
  expect(valueOf("Status")).toHaveTextContent("Failed");
  expect(valueOf("Status")).toHaveTextContent("Too little received");
  expect(valueOf("To")).toHaveTextContent("Contract creation");
  // The receipt names an address even when the creation reverted; nothing was deployed there.
  expect(screen.queryByText("Contract created")).toBeNull();
});

test("a successful creation shows the created contract", () => {
  renderTabs(creation());
  expect(valueOf("To")).toHaveTextContent("Contract creation");
  expect(within(valueOf("Contract created")).getByTitle(CREATED)).toBeInTheDocument();
});

/** The address cell (name button, copy, add) of `address` within `scope`. */
const cellOf = (address: string, scope: HTMLElement = document.body) =>
  within(within(scope).getByTitle(address).closest(".addr-cell") as HTMLElement);

test("Input lists the decoded arguments; address arguments select the tx-graph node or add it to the graph", () => {
  renderTabs(base());
  fireEvent.click(tab("Input"));
  expect(screen.getByText("swapExactETHForTokens(uint256,address[],address,uint256)")).toBeInTheDocument();
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Name", "Type", "Value"]);
  const table = screen.getByRole("table");
  // The address text selects the node in the tx graph (the right panel follows); "+" adds it to the main graph.
  fireEvent.click(cellOf(ALICE, table).getByRole("button", { name: /^0xa11c/ }));
  expect(useUi.getState().txSelection[fixture.flow.tx.hash.toLowerCase()]).toBe(ALICE);
  expect(useGraph.getState().centers).not.toContain(ALICE);
  fireEvent.click(cellOf(ALICE, table).getByRole("button", { name: "Add to graph" }));
  expect(useGraph.getState().centers).toContain(ALICE);
  // Addresses inside an address[] get the same cell; "+" also reveals a hidden node.
  useGraph.getState().setHidden([WETH], true);
  fireEvent.click(cellOf(WETH, table).getByRole("button", { name: "Add to graph" }));
  expect(useGraph.getState().centers).toContain(WETH);
  expect(useGraph.getState().ui[WETH]?.hidden).toBe(false);
  // Raw hex is behind a toggle, in 64-character lines after the selector.
  expect(screen.queryByText(/^0x7ff36ab5$/m)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Raw hex" }));
  const pre = document.querySelector("pre")!;
  const lines = pre.textContent!.split("\n");
  expect(lines[0]).toBe("0x7ff36ab5");
  expect(lines.slice(1)).toEqual(Array(4).fill("0".repeat(64)));
});

test("a long argument value is folded and can be expanded", () => {
  const f = base();
  f.call!.args = [{ name: "data", ty: "bytes", value: "0x" + "ab".repeat(100) }];
  renderTabs(f);
  fireEvent.click(tab("Input"));
  expect(screen.queryByText("0x" + "ab".repeat(100))).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(screen.getByText("0x" + "ab".repeat(100))).toBeInTheDocument();
});

test("a contract creation has no argument table, only its size and the raw initcode", () => {
  renderTabs(creation(64));
  fireEvent.click(tab("Input"));
  expect(screen.getByText("Contract creation · 64 bytes")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
  expect(document.querySelector("pre")!.textContent).toBe("0x" + "60".repeat(32) + "\n" + "60".repeat(32));
});

test("a 5000-byte input is folded by default with its size", () => {
  const f = base();
  f.call = null;
  f.detail.input = "0x7ff36ab5" + "ab".repeat(4996);
  renderTabs(f);
  fireEvent.click(tab("Input"));
  expect(screen.getByText("0x7ff36ab5")).toBeInTheDocument(); // the selector, undecoded
  expect(screen.getByText("5,000 bytes")).toBeInTheDocument();
  expect(document.querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(document.querySelector("pre")!.textContent!.split("\n")).toHaveLength(1 + Math.ceil((4996 * 2) / 64));
});

test("Token Transfers lists token movements by log index; Internal Calls lists internal ones with the zero-value note", () => {
  const f = base();
  const usdt = f.flows[2]!;
  f.flows.push({ ...usdt, seq: 3, log_index: 5, amount: "1000000", from: ALICE, to: BOB });
  renderTabs(f);
  fireEvent.click(tab("Token Transfers"));
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["#", "From", "To", "Amount", "Token"]);
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows).toHaveLength(2);
  expect(within(rows[0]!).getByText("1.00")).toBeInTheDocument();
  expect(within(rows[1]!).getByText("6,400.00")).toBeInTheDocument();
  expect(within(rows[1]!).getByText("USDT")).toHaveAttribute("title", "0xdac17f958d2ee523a2206206994597c13d831ec7");
  expect(within(rows[1]!).getByText("Binance 14")).toBeInTheDocument();

  fireEvent.click(tab("Internal Calls"));
  expect(screen.getByText("Etherscan omits zero-value calls.")).toBeInTheDocument();
  expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["#", "From", "To", "Value", "Trace"]);
  const internal = screen.getAllByRole("row").slice(1);
  expect(internal).toHaveLength(1);
  expect(internal[0]).toHaveTextContent("2.000000 ETH");
  expect(internal[0]).toHaveTextContent("UniswapV2Router02");
});

test("Logs show decoded cards that switch to raw topics and data, capped at 200 with Show all", () => {
  const f = base();
  const ev = f.events[0]!;
  const many: DecodedEventDto[] = Array.from({ length: 250 }, (_, i) => ({ ...ev, log_index: i }));
  f.events = [...many, { ...ev, log_index: 999, name: null, args: [] }];
  renderTabs(f);
  fireEvent.click(tab("Logs"));
  const cards = () => screen.getAllByTestId("tx-log");
  expect(cards()).toHaveLength(200);
  const first = cards()[0]!;
  expect(within(first).getByText("Transfer")).toBeInTheDocument();
  expect(within(first).getByTitle(BOB)).toBeInTheDocument();
  fireEvent.click(within(first).getByRole("button", { name: "Raw" }));
  expect(within(first).getByText(ev.topics[0]!)).toBeInTheDocument();
  expect(within(first).queryByTitle(BOB)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show all (251)" }));
  expect(cards()).toHaveLength(251);
  // An undecoded log starts on its raw view.
  const last = cards()[250]!;
  expect(within(last).getByText("Undecoded")).toBeInTheDocument();
  expect(within(last).getByText(ev.topics[0]!)).toBeInTheDocument();
});

test("Raw loads the tx and receipt JSON only when first opened", async () => {
  const spy = vi.spyOn(api, "txRaw").mockResolvedValue({ tx: { nonce: "0xc" }, receipt: { status: "0x1" } });
  renderTabs(base());
  fireEvent.click(tab("Input"));
  fireEvent.click(tab("Logs"));
  expect(spy).toHaveBeenCalledTimes(0);
  fireEvent.click(tab("Raw"));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  expect(spy).toHaveBeenCalledWith(fixture.flow.tx.hash);
  const pres = await screen.findAllByText(/"nonce": "0xc"|"status": "0x1"/);
  expect(pres.map((p) => p.textContent)).toEqual([
    JSON.stringify({ nonce: "0xc" }, null, 2),
    JSON.stringify({ status: "0x1" }, null, 2),
  ]);
  expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  fireEvent.click(tab("Overview"));
  fireEvent.click(tab("Raw"));
  await screen.findAllByText(/"nonce": "0xc"/);
  expect(spy).toHaveBeenCalledTimes(1);
});

test("the chosen detail tab is kept on the tx tab across tab switches", () => {
  const h = fixture.flow.tx.hash;
  const first = renderTabs(base());
  fireEvent.click(tab("Logs"));
  act(() => useTabs.getState().activate("graph"));
  first.unmount();
  act(() => useTabs.getState().activate(h));
  renderTabs(base());
  expect(tab("Logs")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getAllByTestId("tx-log")).toHaveLength(1);
});

test("tab names and overview keys are translated", () => {
  act(() => useLocale.getState().setLocale("zh"));
  renderTabs(base());
  expect(tab("概览")).toHaveAttribute("aria-pressed", "true");
  expect(valueOf("基础费")).toHaveTextContent(/^19 Gwei$/);
});
