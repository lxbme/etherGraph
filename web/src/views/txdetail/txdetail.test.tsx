import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import fixture from "../../../e2e/fixtures/tx.json";
import { api } from "../../api/endpoints";
import type { DecodedArgDto } from "../../api/generated/DecodedArgDto";
import type { DecodedEventDto } from "../../api/generated/DecodedEventDto";
import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useGraph } from "../../graph/store";
import { useLocale } from "../../i18n";
import { useInfo } from "../../panels/info/infoStore";
import { useUi } from "../../panels/uiStore";
import { useTabs } from "../../shell/tabs";
import { TxDetailTabs } from "./TxDetailTabs";
import { TxSummaryBar } from "./TxSummaryBar";

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
    via_delegate: null,
    via_delegate_current: false,
    guessed: false,
    alternatives: [],
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
      guessed: false,
      signature: null,
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
  fireEvent.click(within(screen.getByRole("group", { name: "Input view" })).getByRole("button", { name: "Raw hex" }));
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
  fireEvent.click(within(within(first).getByRole("group", { name: "Log view" })).getByRole("button", { name: "Raw" }));
  expect(within(first).getByText(ev.topics[0]!)).toBeInTheDocument();
  expect(within(first).queryByTitle(BOB)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show all (251)" }));
  expect(cards()).toHaveLength(251);
  // An undecoded log starts on its raw view.
  const last = cards()[250]!;
  expect(within(last).getByText("Undecoded")).toBeInTheDocument();
  expect(within(last).getByText(ev.topics[0]!)).toBeInTheDocument();
  // Renders 200 and then 251 log cards (~1.3 s alone); under a loaded parallel run that passed the 5 s default.
}, 20_000);

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

const FAKE = "0xfa4e000000000000000000000000000000000005";
const SUSPICIOUS = { level: "suspicious", impersonates: { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", name: "Tether USD" }, reason: null } as const;

test("Overview warns about the distinct flagged tokens and its button jumps to Token Transfers", () => {
  const f = base();
  const usdt = f.flows[2]!;
  f.flows.push(
    { ...usdt, seq: 3, asset: FAKE, trust: SUSPICIOUS },
    { ...usdt, seq: 4, asset: FAKE, trust: SUSPICIOUS },
    { ...usdt, seq: 5, asset: CREATED, symbol: "FREE", trust: { level: "scam", impersonates: null, reason: "spam-token" } },
  );
  renderTabs(f);
  const notice = screen.getByRole("alert");
  expect(notice).toHaveClass("txdetail__notice");
  expect(notice).toHaveTextContent("This transaction involves 2 possibly impersonating or scam tokens");
  fireEvent.click(within(notice).getByRole("button", { name: "Show token transfers" }));
  expect(useTabs.getState().tabs.find((x) => x.id === fixture.flow.tx.hash)).toMatchObject({ detailTab: "transfers" });
  expect(tab("Token Transfers")).toHaveAttribute("aria-pressed", "true");
  const rows = screen.getAllByRole("row").slice(1);
  expect(within(rows.find((r) => r.textContent?.includes("FREE"))!).getByText("Known scam")).toHaveClass("tag--scam");
  expect(within(rows.find((r) => r.textContent?.includes("USDT") && r.textContent.includes("Possible impersonation"))!).getByText("Possible impersonation")).toHaveClass("tag--warn");
  expect(screen.getAllByText("Possible impersonation")).toHaveLength(2);
});

test("Overview has no trust notice when every token is listed or unknown; one flagged token reads singular", () => {
  const f = base();
  f.flows[2]!.trust = { level: "unknown", impersonates: null, reason: null };
  const { unmount } = renderTabs(f);
  expect(screen.queryByRole("alert")).toBeNull();
  unmount();
  f.flows[2]!.trust = SUSPICIOUS;
  renderTabs(f);
  expect(screen.getByRole("alert")).toHaveTextContent("This transaction involves 1 possibly impersonating or scam token");
  act(() => useLocale.getState().setLocale("zh"));
  expect(screen.getByRole("alert")).toHaveTextContent("这笔交易涉及 1 个疑似仿冒或诈骗代币");
});

test("the token cell opens the asset in this tx tab's info stack", () => {
  useInfo.setState({ stacks: {} });
  renderTabs(base());
  fireEvent.click(tab("Token Transfers"));
  fireEvent.click(screen.getByRole("button", { name: "USDT" }));
  expect(useInfo.getState().stacks[fixture.flow.tx.hash]).toEqual([
    { kind: "asset", tokenKind: "erc20", asset: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
  ]);
});

test("the transaction type opens its documentation in this tx tab's info stack for types 0–4 only", () => {
  const ids = ["tx-legacy", "eip-2930", "eip-1559", "eip-4844", "eip-7702"] as const;
  const labels = ["Legacy", "EIP-2930", "EIP-1559", "EIP-4844", "EIP-7702"];
  ids.forEach((id, type) => {
    useInfo.setState({ stacks: {} });
    const f = base();
    f.detail.tx_type = type;
    const { unmount } = renderTabs(f);
    fireEvent.click(within(valueOf("Transaction type")).getByRole("button", { name: labels[type] }));
    expect(useInfo.getState().stacks[fixture.flow.tx.hash]).toEqual([{ kind: "doc", id }]);
    unmount();
  });
  const f = base();
  f.detail.tx_type = 5;
  renderTabs(f);
  expect(valueOf("Transaction type")).toHaveTextContent(/^Type 5$/);
  expect(within(valueOf("Transaction type")).queryByRole("button")).toBeNull();
});

describe("Overview authorizations (type 4)", () => {
  const DELEGATE = "0x612373d7003d694220f7800eeaf8e3924c0951d3";
  const OTHER = "0xe0e0000000000000000000000000000000000005";
  function setCode(): TxFlowDto {
    const f = base();
    f.detail.tx_type = 4;
    f.nodes.push({ ...f.nodes[0]!, address: DELEGATE, kind: "contract", display_name: "Simple7702Account" });
    f.detail.authorizations = [
      { chain_id: "1", delegate: DELEGATE, nonce: "2", authority: ALICE },
      { chain_id: "0", delegate: "0x" + "00".repeat(20), nonce: "7", authority: OTHER },
      { chain_id: "10", delegate: DELEGATE, nonce: "0", authority: null },
    ];
    return f;
  }
  const rows = () => within(screen.getByRole("region", { name: "Authorizations" })).getAllByRole("row").slice(1);
  const cells = (r: HTMLElement) => within(r).getAllByRole("cell").map((c) => c.textContent);

  test("lists each entry with signer, delegate, chain and nonce, in tx order", () => {
    renderTabs(setCode());
    const region = within(screen.getByRole("region", { name: "Authorizations" }));
    expect(region.getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Signer", "Delegate", "Chain", "Nonce"]);
    const [first, second, third] = rows();
    expect(cells(first!)).toEqual(["0xa11c…0001", "Simple7702Account", "Ethereum", "2"]);
    // A zero-address delegate clears the signer's delegation; signers other than the sender are listed as they are.
    expect(cells(second!)).toEqual(["0xe0e0…0005", "clears delegation", "any chain", "7"]);
    // A signature that does not recover: no address to show.
    expect(cells(third!)).toEqual(["unknown signer", "Simple7702Account", "10", "0"]);
  });

  test("a signer's name selects that node in the tx graph", () => {
    renderTabs(setCode());
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "0xa11c…0001" }));
    expect(useUi.getState().txSelection[fixture.flow.tx.hash]).toBe(ALICE);
  });

  test("other types have no authorizations section", () => {
    renderTabs(base());
    expect(screen.queryByRole("region", { name: "Authorizations" })).toBeNull();
  });

  test("labels are translated", () => {
    act(() => useLocale.getState().setLocale("zh"));
    renderTabs(setCode());
    const region = within(screen.getByRole("region", { name: "授权列表" }));
    expect(region.getByText("以太坊")).toBeInTheDocument();
    expect(region.getByText("任意链")).toBeInTheDocument();
    expect(region.getByText("清除委托")).toBeInTheDocument();
    expect(region.getByText("未知签名者")).toBeInTheDocument();
  });
});

describe("ERC-20 amounts in arguments", () => {
  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const SCAM = "0x5ca5000000000000000000000000000000000006";
  /** `f` calling `signature` on `token` (a node that is an ERC-20 of `decimals`, or none known with `null`). */
  function calling(signature: string, args: DecodedArgDto[], token: TxFlowDto["nodes"][number]["token"]): TxFlowDto {
    const f = base();
    f.tx.to = USDC;
    f.nodes.push({ ...f.nodes[0]!, address: USDC, kind: "contract", display_name: "USD Coin", is_proxy: true, token });
    f.call = { signature, name: signature.slice(0, signature.indexOf("(")), args, via_delegate: null, via_delegate_current: false, guessed: false, alternatives: [] };
    return f;
  }
  const usdc = { standard: "erc20" as const, symbol: "USDC", decimals: 6 };
  const valueCell = (name: string) => screen.getByRole("cell", { name }).parentElement!.lastElementChild as HTMLElement;

  test("a transfer's amount reads in the token's decimals with its symbol, the raw value beside it", () => {
    renderTabs(calling("transfer(address,uint256)", [
      { name: "to", ty: "address", value: BOB }, { name: "value", ty: "uint256", value: "4699465952" },
    ], usdc));
    fireEvent.click(tab("Input"));
    const cell = valueCell("value");
    expect(within(cell).getByText("4,699.465952")).toBeInTheDocument();
    expect(within(cell).getByText("USDC")).toBeInTheDocument();
    expect(within(cell).getByText("4699465952")).toBeInTheDocument();
    // The recipient stays an address cell.
    expect(within(valueCell("to")).getByTitle(BOB)).toBeInTheDocument();
  });

  test("an approval of the uint256 max reads Unlimited, not 78 digits", () => {
    const max = ((1n << 256n) - 1n).toString();
    renderTabs(calling("approve(address,uint256)", [
      { name: "spender", ty: "address", value: BOB }, { name: "value", ty: "uint256", value: max },
    ], usdc));
    fireEvent.click(tab("Input"));
    const cell = valueCell("value");
    expect(cell).toHaveTextContent(/^Unlimited USDC$/);
    expect(within(cell).getByText("Unlimited")).toHaveAttribute("title", max);
    act(() => useLocale.getState().setLocale("zh"));
    expect(valueCell("value")).toHaveTextContent(/^无限 USDC$/);
  });

  test("a token of unknown decimals, or none known, keeps the raw amount with no guess", () => {
    const args: DecodedArgDto[] = [{ name: "to", ty: "address", value: BOB }, { name: "value", ty: "uint256", value: "4699465952" }];
    const { unmount } = renderTabs(calling("transfer(address,uint256)", args, { standard: "erc20", symbol: "USDC", decimals: null }));
    fireEvent.click(tab("Input"));
    expect(valueCell("value")).toHaveTextContent(/^4699465952$/);
    unmount();
    renderTabs(calling("transfer(address,uint256)", args, null));
    fireEvent.click(tab("Input"));
    expect(valueCell("value")).toHaveTextContent(/^4699465952$/);
  });

  test("a uint256 of a non-standard function of a token stays raw", () => {
    renderTabs(calling("mint(address,uint256)", [
      { name: "to", ty: "address", value: BOB }, { name: "amount", ty: "uint256", value: "4699465952" },
    ], usdc));
    fireEvent.click(tab("Input"));
    expect(valueCell("amount")).toHaveTextContent(/^4699465952$/);
  });

  test("an amount of a scam token is marked as the token's own claim", () => {
    const f = base();
    f.nodes.push({ ...f.nodes[0]!, address: SCAM, kind: "contract", token: { standard: "erc20", symbol: "USDC", decimals: 6 } });
    f.flows.push({
      ...f.flows[2]!, seq: 9, asset: SCAM, symbol: "USDC", decimals: 6, amount: "1000000", log_index: 13,
      trust: { level: "scam", impersonates: null, reason: "spam-token" },
    });
    f.events = [{ ...f.events[0]!, address: SCAM, log_index: 13, args: [
      { name: "from", ty: "address", value: BOB }, { name: "to", ty: "address", value: ALICE }, { name: "value", ty: "uint256", value: "1000000" },
    ] }];
    renderTabs(f);
    fireEvent.click(tab("Logs"));
    const cell = valueCell("value");
    expect(within(cell).getByText("1")).toBeInTheDocument();
    const mark = within(cell).getByText("Known scam");
    expect(mark.getAttribute("title")).toContain("the token's own claim");
    expect(mark.getAttribute("title")).toContain("Flagged as spam by eth-labels");
  });

  test("a file saved before nodes named their token reads the amount from the token's transfers in the tx", () => {
    const f = base();
    for (const n of f.nodes) delete n.token;
    renderTabs(f);
    fireEvent.click(tab("Logs"));
    expect(valueCell("value")).toHaveTextContent(/^6,400 USDT 6400000000$/);
  });

  test("a listed token's event amount carries no mark", () => {
    const f = base();
    f.nodes.push({ ...f.nodes[0]!, address: f.events[0]!.address, kind: "contract", token: { standard: "erc20", symbol: "USDT", decimals: 6 } });
    renderTabs(f);
    fireEvent.click(tab("Logs"));
    const cell = valueCell("value");
    expect(cell).toHaveTextContent("6,400 USDT");
    expect(within(cell).queryByText("Known scam")).toBeNull();
    expect(within(cell).queryByText("Possible impersonation")).toBeNull();
  });
});

describe("a call decoded through an EIP-7702 delegate", () => {
  const D = "0x" + "7c".repeat(20);
  const CURRENT_TEXT = "Decoded with the ABI of its current EIP-7702 delegate 0x7c7c…7c7c; the delegation at this transaction may have differed";
  const TX_TEXT = "Decoded with the ABI of its EIP-7702 delegate 0x7c7c…7c7c";
  /** Shaped like a type-2 call from an account to itself, delegated by an earlier type-4 tx. */
  function delegated(current: boolean): TxFlowDto {
    const f = base();
    f.call = { signature: "execute(((address,uint256,bytes)[],bool))", name: "execute", args: [], via_delegate: D, via_delegate_current: current, guessed: false, alternatives: [] };
    f.tx = { ...f.tx, to: f.tx.from, method: "execute", selector: "0x99e1d016" };
    f.detail.input = "0x99e1d016" + "00".repeat(128);
    return f;
  }
  function renderBar(flow: TxFlowDto) {
    render(
      <QueryClientProvider client={qc}>
        <TxSummaryBar flow={flow} />
      </QueryClientProvider>,
    );
    return screen.getByTestId("tx-summary-bar");
  }

  test("the summary bar names a call decoded through the current delegate", () => {
    const bar = renderBar(delegated(true));
    expect(within(bar).getByText("execute")).toBeInTheDocument();
    expect(within(bar).getByText(CURRENT_TEXT)).toBeInTheDocument();
  });

  test("the summary bar names the tx's own delegate without the current-delegate caveat; a call decoded with to's ABI names none", () => {
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <TxSummaryBar flow={delegated(false)} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(TX_TEXT)).toBeInTheDocument();
    unmount();
    const bar = renderBar(base());
    expect(within(bar).queryByText(/EIP-7702 delegate/)).toBeNull();
  });

  test("Input names the delegate whose ABI decoded the call", () => {
    renderTabs(delegated(true));
    fireEvent.click(tab("Input"));
    expect(screen.getByText("execute(((address,uint256,bytes)[],bool))")).toBeInTheDocument();
    expect(screen.getByText(CURRENT_TEXT)).toBeInTheDocument();
  });
});

describe("names guessed from the signature database", () => {
  const ALTS = ["foo_abc(address,uint256)", "transfer_x(address,uint256)"];
  function guessedCall(): TxFlowDto {
    const f = base();
    f.call = {
      signature: "transfer(address,uint256)", name: "transfer",
      args: [{ name: "", ty: "address", value: BOB }, { name: "", ty: "uint256", value: "1000" }],
      via_delegate: null, via_delegate_current: false, guessed: true, alternatives: ALTS,
    };
    f.tx = { ...f.tx, method: null, selector: "0xa9059cbb" };
    f.detail.input = "0xa9059cbb" + "00".repeat(64);
    return f;
  }

  test("a guessed call shows the 推测 tag with alternatives in its title", () => {
    act(() => useLocale.getState().setLocale("zh"));
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <TxSummaryBar flow={guessedCall()} />
      </QueryClientProvider>,
    );
    const bar = screen.getByTestId("tx-summary-bar");
    expect(within(bar).getByText("transfer")).toBeInTheDocument();
    expect(within(bar).getByText("推测")).toHaveAttribute("title", `其他候选：${ALTS.join(", ")}`);
    unmount();

    act(() => useLocale.getState().setLocale("en"));
    renderTabs(guessedCall());
    fireEvent.click(tab("Input"));
    expect(screen.getByText("transfer(address,uint256)")).toBeInTheDocument();
    expect(screen.getByText("Guessed")).toHaveAttribute("title", `Other candidates: ${ALTS.join(", ")}`);
    // Unnamed arguments read by position, their types beside them.
    expect(screen.getByRole("cell", { name: "#0" }).nextElementSibling).toHaveTextContent("address");
  });

  test("a guessed call without alternatives has a tag without a title; an ABI-decoded one has none", () => {
    const f = guessedCall();
    f.call!.alternatives = [];
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <TxSummaryBar flow={f} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Guessed")).not.toHaveAttribute("title");
    unmount();
    render(
      <QueryClientProvider client={qc}>
        <TxSummaryBar flow={base()} />
      </QueryClientProvider>,
    );
    expect(screen.queryByText("Guessed")).toBeNull();
  });

  test("a guessed event shows its name and signature with the tag", () => {
    const f = base();
    const topic = "0x" + "4b".repeat(32);
    f.events = [
      { address: BOB, log_index: 3, name: "Ping", args: [], topics: [topic], data: "0x" + "00".repeat(31) + "09", guessed: true, signature: "Ping(uint256)" },
    ];
    renderTabs(f);
    fireEvent.click(tab("Logs"));
    const card = screen.getByTestId("tx-log");
    expect(within(card).getByText("Ping")).toBeInTheDocument();
    expect(within(card).getByText("Ping(uint256)")).toBeInTheDocument();
    expect(within(card).getByText("Guessed")).toBeInTheDocument();
    // Its arguments are not decoded: topics and data show raw.
    expect(within(card).getByText(topic)).toBeInTheDocument();
    expect(within(card).queryByText("Undecoded")).toBeNull();
  });
});
