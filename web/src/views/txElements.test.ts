import type { FlowDto } from "../api/generated/FlowDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import { assetOnlyAddresses, assetViewForEdge, assetViewForNode, callLabel, circled, flowLabel, txElements } from "./txElements";
import { ellipsize, shortTokenId } from "../lib/format";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";

const node = (address: string): NodeSummaryDto => ({
  address, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null,
});
export const flow = (over: Partial<FlowDto> = {}): FlowDto => ({
  seq: 1, from: A, to: B, asset: USDT, amount: "12500000", token_id: null, kind: "erc20",
  trace_path: null, log_index: 0, decimals: 6, symbol: "USDT", trust: { level: "listed", impersonates: null, reason: null }, ...over,
});
const dto = (over: Partial<TxFlowDto> = {}): TxFlowDto => ({
  tx: {
    hash: "0x" + "11".repeat(32), block_number: 1, ts: "2026-01-01T00:00:00Z", from: A, to: B, value: "0",
    success: true, gas_used: "21000", fee: "1000000000000000", method: "swap", selector: "0x12345678",
  },
  detail: {
    nonce: 0, tx_type: 2, position: 0, confirmations: null, gas_limit: "21000", gas_used: "21000",
    gas_price: null, effective_gas_price: null, max_fee: null, max_priority_fee: null, base_fee: null,
    burnt_fee: null, savings: null, blob_gas_used: null, blob_gas_price: null, blob_fee: null, access_list_len: null,
    contract_created: null, revert_reason: null, input: "0x", authorizations: [], delegations: [],
  },
  call: { signature: "swap(uint256)", name: "swap", args: [], via_delegate: null, via_delegate_current: false, guessed: false, alternatives: [] },
  nodes: [node(A), node(B)], flows: [flow()], events: [], completeness: "fund_flow", ...over,
});

test("txElements builds a dashed call edge and numbered flow edges", () => {
  const els = txElements(dto());
  expect(els.filter((e) => e.group === "nodes")).toHaveLength(2);
  const call = els.find((e) => e.classes === "call")!;
  expect(call.data).toMatchObject({ source: A, target: B, label: "swap" });
  const f = els.find((e) => e.data.id === "flow-1-0")!;
  expect(f.data).toMatchObject({ source: A, target: B, label: "①  12.5 USDT" });
  expect(f.classes).toBe("asset-stable");
});

test("a flow of a suspicious or scam token is flagged: class and a ⚠ label prefix", () => {
  const fake = flow({ asset: "0x" + "f".repeat(40), trust: { level: "suspicious", impersonates: { address: USDT, symbol: "USDT", name: "Tether USD" }, reason: null } });
  const f = txElements(dto({ flows: [fake] })).find((e) => e.data.id === "flow-1-0")!;
  expect(String(f.classes).split(" ").sort()).toEqual(["asset-erc20", "asset-suspicious"]);
  expect(f.data.label).toBe("⚠ ①  12.5 USDT");
  const scam = flow({ trust: { level: "scam", impersonates: null, reason: "scam-label" } });
  const s = txElements(dto({ flows: [scam] })).find((e) => e.data.id === "flow-1-0")!;
  expect(String(s.classes).split(" ")).toContain("asset-scam");
  expect(s.data.label).toBe("⚠ ①  12.5 USDT");
});

test("call edge is skipped without a recipient and falls back to selector or generic label", () => {
  const base = dto();
  expect(txElements({ ...base, tx: { ...base.tx, to: null } }).some((e) => e.classes === "call")).toBe(false);
  const undecoded = txElements({ ...base, call: null });
  expect(undecoded.find((e) => e.classes === "call")!.data.label).toBe("0x12345678 (undecoded)");
  const plain = txElements({ ...base, call: null, tx: { ...base.tx, selector: null } });
  expect(plain.find((e) => e.classes === "call")!.data.label).toBe("Call");
});

test("seq labels use circled digits up to 20", () => {
  expect(circled(0)).toBe("⓪");
  expect(circled(1)).toBe("①");
  expect(circled(10)).toBe("⑩");
  expect(circled(20)).toBe("⑳");
  expect(circled(21)).toBe("(21)");
});

test("flow labels: ETH, unknown symbol, NFT token id", () => {
  expect(flowLabel(flow({ seq: 2, asset: null, kind: "internal", amount: "1500000000000000000", decimals: 18, symbol: null })))
    .toBe("②  1.5 ETH");
  expect(flowLabel(flow({ asset: "0x" + "cc".repeat(20), symbol: null }))).toBe("①  12.5 0xcccc…cccc");
  expect(flowLabel(flow({ kind: "erc721", token_id: "77", amount: "1", decimals: null })))
    .toBe("①  #77 USDT");
  const big = "123456789012345678901234567890";
  expect(flowLabel(flow({ amount: big, decimals: 0 }))).toContain("123,456,789,012,345,678,901,234,567,890");
});

test("edges with missing endpoints are skipped", () => {
  const els = txElements(dto({ flows: [flow({ to: "0x" + "dd".repeat(20) })] }));
  expect(els.some((e) => String(e.data.id).startsWith("flow-"))).toBe(false);
});

test("selected node gets the selected class", () => {
  const n = txElements(dto(), A).find((e) => e.data.id === A)!;
  expect(n.classes).toContain("selected");
});

test("only the flow edge with the highlighted seq gets the highlighted class", () => {
  const els = txElements(dto({ flows: [flow(), flow({ seq: 2 })] }), null, 2);
  expect(els.find((e) => e.data.id === "flow-1-0")!.classes).toBe("asset-stable");
  expect(els.find((e) => e.data.id === "flow-2-1")!.classes).toBe("asset-stable highlighted");
  expect(txElements(dto(), null, null).find((e) => e.data.id === "flow-1-0")!.classes).toBe("asset-stable");
});

const ENS_ID = "90146019176740571409723734689185553745879426092891378571553900257744947220924";

test("a 77-digit NFT token id is shortened in the edge label, a short one is not", () => {
  expect(flowLabel(flow({ seq: 2, kind: "erc721", token_id: ENS_ID, amount: "1", decimals: null, symbol: "ENS" })))
    .toBe("②  #901460…0924 ENS");
  expect(flowLabel(flow({ kind: "erc721", token_id: "1234567890", amount: "1", decimals: null, symbol: "N" })))
    .toBe("①  #1234567890 N");
});

test("ellipsize and shortTokenId", () => {
  expect(ellipsize("abc", 3)).toBe("abc");
  expect(ellipsize("abcdef", 4)).toBe("abc…");
  expect(shortTokenId("123456789012")).toBe("123456789012");
  expect(shortTokenId("1234567890123")).toBe("123456…0123");
});

test("a long call label is cut to 48 characters", () => {
  const name = "x".repeat(80);
  const label = callLabel(dto({ call: { name } } as Partial<TxFlowDto>));
  expect([...label]).toHaveLength(48);
  expect(label.endsWith("…")).toBe(true);
});

test("a guessed call's label is marked as guessed", () => {
  expect(callLabel(dto({ call: { name: "transfer", guessed: true } } as Partial<TxFlowDto>))).toBe("transfer (Guessed)");
  expect(callLabel(dto({ call: { name: "transfer", guessed: false } } as Partial<TxFlowDto>))).toBe("transfer");
});

test("tapping a flow edge resolves its asset (NFTs with their token id); the call edge resolves to nothing", () => {
  const f = dto({
    flows: [
      flow({ seq: 0, asset: null, kind: "native" }),
      flow({ seq: 1, asset: USDT, kind: "erc20" }),
      flow({ seq: 2, asset: USDT, kind: "erc721", token_id: "77", amount: "1", decimals: null }),
    ],
  } as Partial<TxFlowDto>);
  expect(assetViewForEdge(f, "flow-0-0")).toEqual({ kind: "asset", asset: null });
  expect(assetViewForEdge(f, "flow-1-1")).toEqual({ kind: "asset", asset: USDT, tokenKind: "erc20" });
  expect(assetViewForEdge(f, "flow-2-2")).toEqual({ kind: "asset", asset: USDT, tokenId: "77", tokenKind: "erc721" });
  expect(assetViewForEdge(f, "call")).toBeNull();
});

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const C = "0x" + "cc".repeat(20);
const D = "0x" + "dd".repeat(20);
const E = "0x" + "ee".repeat(20);
const ZERO = "0x" + "00".repeat(20);
const ids = (els: ReturnType<typeof txElements>, prefix: string) =>
  els.filter((e) => String(e.data.id).startsWith(prefix)).map((e) => [e.data.source, e.data.target]);
const classesOf = (els: ReturnType<typeof txElements>, id: string) => String(els.find((e) => e.data.id === id)!.classes);

describe("token-contract (asset-only) nodes", () => {
  // A swaps through router C: USDT (only emitted the Transfer logs) and WETH (also receives internal ETH).
  const swap = () =>
    dto({
      tx: { ...dto().tx, from: A, to: C },
      nodes: [node(A), node(B), node(C), node(USDT), node(WETH)],
      flows: [
        flow({ seq: 1, from: B, to: C, asset: USDT }),
        flow({ seq: 2, from: C, to: A, asset: USDT }),
        flow({ seq: 3, from: B, to: C, asset: USDT }),
        flow({ seq: 4, from: B, to: C, asset: WETH, symbol: "WETH", decimals: 18 }),
        flow({ seq: 5, from: C, to: WETH, asset: null, kind: "internal", symbol: null, decimals: 18 }),
      ],
    });

  test("an asset that never sends or receives is asset-only; WETH, which receives internal ETH, is not", () => {
    expect([...assetOnlyAddresses(swap())]).toEqual([USDT]);
    const els = txElements(swap());
    expect(classesOf(els, USDT)).toContain("asset-contract");
    expect(classesOf(els, WETH)).not.toContain("asset-contract");
    expect(classesOf(els, C)).not.toContain("asset-contract");
  });

  test("one dotted link per distinct sender of that asset's flows, without label or arrow data", () => {
    const els = txElements(swap());
    // Sender → token, so the left-to-right layout ranks the token after its senders, off the sender's column.
    expect(ids(els, "asset-link")).toEqual([[B, USDT], [C, USDT]]);
    for (const e of els.filter((x) => String(x.data.id).startsWith("asset-link"))) {
      expect(e.classes).toBe("asset-link");
      expect(e.data.label).toBeUndefined();
    }
  });

  test("a token that transfers to itself, or is the tx's sender or recipient, is not asset-only", () => {
    const self = dto({ nodes: [node(A), node(B), node(USDT)], flows: [flow({ from: USDT, to: USDT })] });
    expect(assetOnlyAddresses(self).size).toBe(0);
    const called = dto({ tx: { ...dto().tx, to: USDT }, nodes: [node(A), node(B), node(USDT)], flows: [flow({ from: A, to: B })] });
    expect(assetOnlyAddresses(called).size).toBe(0);
    expect(txElements(called).some((e) => String(e.data.id).startsWith("asset-link"))).toBe(false);
  });

  test("a token the tx created (minting in its constructor) is a party, not asset-only", () => {
    const created = dto({
      tx: { ...dto().tx, to: null },
      detail: { ...dto().detail, contract_created: C.toUpperCase().replace("0X", "0x") },
      nodes: [node(A), node(C)],
      flows: [flow({ from: ZERO, to: A, asset: C })],
    });
    expect(assetOnlyAddresses(created).size).toBe(0);
    expect(classesOf(txElements(created), C)).not.toContain("asset-contract");
    expect(assetViewForNode(created, C)).toBeNull();
  });

  test("an asset without a node gets no class and no link", () => {
    const els = txElements(dto());
    expect(els.some((e) => String(e.data.id).startsWith("asset-link"))).toBe(false);
  });

  test("tapping an asset-only node resolves its asset with the kind of its flows; other nodes resolve to nothing", () => {
    expect(assetViewForNode(swap(), USDT.toUpperCase().replace("0X", "0x"))).toEqual({ kind: "asset", asset: USDT, tokenKind: "erc20" });
    expect(assetViewForNode(swap(), WETH)).toBeNull();
    expect(assetViewForNode(swap(), A)).toBeNull();
  });
});

describe("self-calls and EIP-7702 delegations", () => {
  const auth = (authority: string | null, delegate: string) => ({ chain_id: "1", delegate, nonce: "2", authority });
  const del = (authority: string, delegate: string) => ({ authority, delegate });

  test("a plain EOA sending ETH to itself: the call edge is a loop on that node, with no delegate node", () => {
    const els = txElements(
      dto({
        tx: { ...dto().tx, from: A, to: A, selector: null, method: null },
        call: null,
        nodes: [node(A)],
        flows: [flow({ from: A, to: A, asset: null, kind: "native", symbol: null, decimals: 18 })],
      }),
    );
    expect(els.filter((e) => e.group === "nodes")).toHaveLength(1);
    const call = els.find((e) => e.data.id === "call")!;
    expect(call.data).toMatchObject({ source: A, target: A, label: "Call" });
    expect(call.classes).toBe("call self-call");
    expect(els.some((e) => String(e.classes).includes("delegation"))).toBe(false);
  });

  test("an ordinary call edge keeps the plain call class", () => {
    expect(txElements(dto()).find((e) => e.data.id === "call")!.classes).toBe("call");
  });

  test("each effective delegation from the server draws a dashed delegates-to edge from signer to delegate", () => {
    const f = dto({
      tx: { ...dto().tx, from: A, to: A },
      call: { signature: "execute(bytes)", name: "execute", args: [], via_delegate: D, via_delegate_current: false, guessed: false, alternatives: [] },
      detail: {
        ...dto().detail,
        tx_type: 4,
        // The raw list is not consulted: A's later entry to E did not take effect.
        authorizations: [auth(A, D), auth(null, C), auth(A, E), auth(B, D)],
        delegations: [del(A, D), del(B.toUpperCase().replace("0X", "0x"), D)],
      },
      nodes: [node(A), node(B), node(C), node(D), node(E)],
      flows: [],
    });
    const els = txElements(f);
    const edges = els.filter((e) => String(e.classes) === "delegation");
    expect(edges.map((e) => [e.data.id, e.data.source, e.data.target, e.data.label])).toEqual([
      ["delegation-0", A, D, "delegates to"],
      ["delegation-1", B, D, "delegates to"],
    ]);
    // Via the delegate's ABI, the call edge still shows the method name.
    expect(els.find((e) => e.data.id === "call")!.data.label).toBe("execute");
  });

  test("authorizations without delegations draw no edge (also from a server older than the field)", () => {
    const base = { tx: { ...dto().tx, from: A, to: A }, nodes: [node(A), node(D)], flows: [] };
    const none = txElements(dto({ ...base, detail: { ...dto().detail, tx_type: 4, authorizations: [auth(A, D)], delegations: [] } }));
    expect(none.some((e) => String(e.classes) === "delegation")).toBe(false);
    const { delegations: _omit, ...older } = dto().detail;
    const old = txElements(dto({ ...base, detail: { ...older, tx_type: 4, authorizations: [auth(A, D)] } as TxFlowDto["detail"] }));
    expect(old.some((e) => String(e.classes) === "delegation")).toBe(false);
  });

  test("a delegate without a node gets no edge", () => {
    const f = dto({ detail: { ...dto().detail, tx_type: 4, authorizations: [auth(A, D)], delegations: [del(A, D)] } });
    expect(txElements(f).some((e) => String(e.classes) === "delegation")).toBe(false);
  });
});
