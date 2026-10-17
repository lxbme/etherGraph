import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import { callTooltip, edgeTooltip, moreTooltip, nodeTooltip } from "./tooltip";
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
  });
  test("synced shows the newest coverage time (UTC) with a local title; partial wins", () => {
    const cov = (t: string): SyncStatusDto => ({ kind: "native", from_block: 1, to_block: 2, truncated: false, state: "ok", last_synced_at: t });
    const ls = nodeTooltip(node({ synced: true, labels: [{ id: 1, text: "x", category: "exchange", source: "user" }] }), {
      coverage: [cov("2026-01-01T00:00:00Z"), cov("2026-02-03T04:05:06Z")],
    });
    expect(text(ls)).toContain("Synced to 2026-02-03 04:05:06");
    expect(text(ls)).toContain("Category Exchange");
    expect(ls.find((l) => l.value.startsWith("Synced"))?.title).toBeTruthy();
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
