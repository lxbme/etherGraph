import { describe, expect, it } from "vitest";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { mergeResults } from "./estimate";

function node(address: string, over: Partial<NodeSummaryDto> = {}): NodeSummaryDto {
  return {
    address, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
    partial: false, syncing: false, synced: true, hot: false, identified: true, ...over,
  } as NodeSummaryDto;
}
function edge(from: string, to: string): EdgeDto {
  return {
    from, to, asset: null, asset_kind: "native", count: 1, sum: "1",
    first_ts: "2020-01-01T00:00:00Z", last_ts: "2020-01-01T00:00:00Z", decimals: 18, symbol: "ETH", trust: "ok",
  } as unknown as EdgeDto;
}
function result(addrs: string[], edges: [string, string][], omitted: Record<string, number> = {}): GraphResponseDto {
  return { nodes: addrs.map((a) => node(a)), edges: edges.map(([f, t]) => edge(f, t)), omitted, coverage: {} };
}

describe("mergeResults", () => {
  it("dedupes nodes and merges omitted", () => {
    const a = result(["0x1", "0x2"], [["0x1", "0x2"]], { "0x1": 3 });
    const b = result(["0X2", "0x3"], [["0x2", "0x3"]], { "0x2": 4 });
    const m = mergeResults([a, b]);
    expect(m.nodes.map((n) => n.address)).toEqual(["0x1", "0x2", "0x3"]);
    expect(m.edges).toHaveLength(2);
    expect(m.omitted).toEqual({ "0x1": 3, "0x2": 4 });
  });
});
