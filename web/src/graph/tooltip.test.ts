import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import type { FlowDto } from "../api/generated/FlowDto";
import { callTooltip, flowTooltip, edgeTooltip, moreTooltip, nodeTooltip } from "./tooltip";
import type { VisualEdge } from "./visualEdges";

const node = (o: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: "0x1111111111111111111111111111111111111111", kind: "eoa", display_name: null, ens: null,
  contract_name: null, labels: [], partial: false, syncing: false, synced: false, hot: false, nonce: null, balance: null, ...o,
});
const text = (ls: { label?: string; value: string }[]) => ls.map((l) => `${l.label ?? ""} ${l.value}`).join("\n");

describe("nodeTooltip", () => {
  test("an unsynced EOA says so", () => {
    expect(text(nodeTooltip(node(), {}))).toContain("Not synced");
  });
  test("omitted neighbours show as hidden", () => {
    expect(text(nodeTooltip(node(), { degree: 5, omitted: 12 }))).toContain("5 (+12 hidden)");
  });
  test("no balance, no Balance line; with one it is fixed ETH", () => {
    expect(text(nodeTooltip(node(), {}))).not.toContain("Balance");
    const ls = nodeTooltip(node({ balance: "1500000000000000000", nonce: 1234 }), {});
    expect(text(ls)).toContain("Balance 1.500000 ETH");
    expect(text(ls)).toContain("Nonce 1,234");
    expect(ls.find((l) => l.label === "Balance")?.sub).toBeUndefined();
    expect(nodeTooltip(node({ balance: "1500000000000000001" }), {}).find((l) => l.label === "Balance")?.sub).toBe("1.500000000000000001 ETH");
    expect(nodeTooltip(node({ balance: "1000000000000000000" }), {}).find((l) => l.label === "Balance")?.sub).toBeUndefined();
  });
  test("synced shows the newest coverage time (UTC) with a local title; partial wins", () => {
    const cov = (t: string): SyncStatusDto => ({ kind: "native", from_block: 1, to_block: 2, truncated: false, state: "ok", last_synced_at: t });
    const ls = nodeTooltip(node({ synced: true, labels: [{ id: 1, text: "x", category: "exchange", source: "user" }] }), {
      coverage: [cov("2026-01-01T00:00:00Z"), cov("2026-02-03T04:05:06Z")],
    });
    expect(text(ls)).toContain("Synced to 2026-02-03 04:05:06");
    expect(text(ls)).toContain("Category Exchange");
    expect(ls.find((l) => l.value.startsWith("Synced"))?.sub).toMatch(/^local \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(text(nodeTooltip(node({ synced: true }), {}))).toMatch(/Sync Synced$/);
    const two = nodeTooltip(node({ labels: [{ id: 1, text: "a", category: "exchange", source: "user" }, { id: 2, text: "b", category: "defi", source: "user" }] }), {});
    expect(text(two)).toContain("Category Exchange, DeFi");
    expect(text(nodeTooltip(node({ synced: true, partial: true }), {}))).toContain("Partial");
  });
});

describe("edgeTooltip", () => {
  const edge = (asset: string | null, count: number, symbol: string | null) => ({
    from: "0xa", to: "0xb", asset, asset_kind: asset ? "erc20" : "native", count, sum: "1", first_ts: "", last_ts: "", decimals: 18, symbol,
  }) as const;
  test("one line per asset plus the width note", () => {
    const v: VisualEdge = {
      id: "c", from: "0xa", to: "0xb", color: "eth", count: 8, badge: "×2", expanded: false,
      assets: [edge(null, 5, "ETH"), edge("0xdddddddddddddddddddddddddddddddddddddddd", 3, "DAI")],
    };
    const ls = edgeTooltip(v);
    expect(ls.map((l) => l.value)).toContain("5 transfers");
    expect(ls.map((l) => l.value)).toContain("3 transfers");
    expect(ls.filter((l) => l.label === "ETH" || l.label === "DAI")).toHaveLength(2);
    expect(ls.at(-1)?.value).toBe("Line width = transfers (log)");
    expect(ls[0]?.value).toContain("→");
  });
});

test("call and more tooltips", () => {
  expect(callTooltip()[0]?.value).toBe("Call (no value moved)");
  expect(text(moreTooltip(7))).toContain("7 more neighbours not shown");
});

test("flowTooltip: names, symbol, fixed amount, order, kind", () => {
  const f: FlowDto = {
    seq: 2, from: "0xaaaa", to: "0xbbbb", asset: "0xdac17f958d2ee523a2206206994597c13d831ec7", amount: "1234567", token_id: null,
    kind: "erc20", trace_path: null, log_index: 1, decimals: 6, symbol: "USDT",
  };
  const ls = flowTooltip(f, new Map([["0xaaaa", "Alice"]]));
  const s = text(ls);
  expect(s).toContain("Alice → 0xbbbb");
  expect(s).toContain("Asset USDT");
  expect(s).toContain("Amount 1.23 USDT");
  expect(ls.find((l) => l.label === "Amount")?.sub).toBe("1.234567 USDT");
  expect(s).toContain("Order ②");
  expect(s).toContain("Kind ERC-20");
});
