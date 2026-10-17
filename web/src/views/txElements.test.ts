import type { FlowDto } from "../api/generated/FlowDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import { circled, flowLabel, txElements } from "./txElements";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";

const node = (address: string): NodeSummaryDto => ({
  address, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, nonce: null, balance: null,
});
export const flow = (over: Partial<FlowDto> = {}): FlowDto => ({
  seq: 1, from: A, to: B, asset: USDT, amount: "12500000", token_id: null, kind: "erc20",
  trace_path: null, log_index: 0, decimals: 6, symbol: "USDT", ...over,
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
    contract_created: null, revert_reason: null, input: "0x",
  },
  call: { signature: "swap(uint256)", name: "swap", args: [] },
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

test("call edge is skipped without a recipient and falls back to selector or generic label", () => {
  const base = dto();
  expect(txElements({ ...base, tx: { ...base.tx, to: null } }).some((e) => e.classes === "call")).toBe(false);
  const undecoded = txElements({ ...base, call: null });
  expect(undecoded.find((e) => e.classes === "call")!.data.label).toBe("0x12345678 (undecoded)");
  const plain = txElements({ ...base, call: null, tx: { ...base.tx, selector: null } });
  expect(plain.find((e) => e.classes === "call")!.data.label).toBe("Call");
});

test("seq labels use circled digits up to 20", () => {
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
