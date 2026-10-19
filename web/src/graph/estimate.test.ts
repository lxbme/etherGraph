import { describe, expect, it } from "vitest";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { estimateExpansion, mergeResults, moreNext, revealStep, shownNeighbourCounts } from "./estimate";

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
const set = (...a: string[]) => new Set(a);

describe("estimateExpansion", () => {
  it("counts fresh, on-canvas and remaining per target", () => {
    const t = node("0xt");
    const r = result(["0xt", "0xa", "0xb", "0xc"], [["0xt", "0xa"], ["0xt", "0xb"], ["0xc", "0xt"]], { "0xt": 7 });
    const e = estimateExpansion({ result: r, targets: [t], k: 3, visible: set("0xt", "0xa"), hidden: set() });
    expect(e.targets[0]).toEqual({ address: "0xt", total: 10, onCanvas: 1, fresh: 2, remaining: 7, pending: false, upper: 2 });
    expect(e.min).toBe(2);
    expect(e.max).toBe(2);
  });

  it("on-canvas neighbours use up the batch", () => {
    const r = result(["0xt", "0xa", "0xb"], [["0xt", "0xa"], ["0xt", "0xb"]], { "0xt": 5 });
    const e = estimateExpansion({ result: r, targets: [node("0xt")], k: 2, visible: set("0xt", "0xa", "0xb"), hidden: set() });
    expect(e.targets[0]!.fresh).toBe(0);
    expect(e.min).toBe(0);
  });

  it("hidden neighbours are not counted", () => {
    const r = result(["0xt", "0xh"], [["0xt", "0xh"]]);
    const e = estimateExpansion({ result: r, targets: [node("0xt")], k: 3, visible: set("0xt"), hidden: set("0xh") });
    expect(e.targets[0]!.fresh).toBe(0);
    expect(e.targets[0]!.onCanvas).toBe(0);
    expect(e.targets[0]!.total).toBe(1);
  });

  it("shared neighbours count once", () => {
    const r = result(["0xt1", "0xt2", "0xx"], [["0xt1", "0xx"], ["0xx", "0xt2"]]);
    const e = estimateExpansion({ result: r, targets: [node("0xt1"), node("0xt2")], k: 3, visible: set("0xt1", "0xt2"), hidden: set() });
    expect(e.min).toBe(1);
    expect(e.targets.map((t) => t.fresh)).toEqual([1, 1]);
  });

  it("a target that is not visible itself adds one", () => {
    const r = result(["0xt", "0xa"], [["0xt", "0xa"]]);
    const e = estimateExpansion({ result: r, targets: [node("0xt")], k: 3, visible: set(), hidden: set("0xt") });
    expect(e.min).toBe(2);
  });

  it("an unsynced target gives a range", () => {
    const edges: [string, string][] = [["0xt", "0xa"], ["0xt", "0xb"], ["0xt", "0xc"], ["0xt", "0xd"], ["0xt", "0xe"]];
    const r = result(["0xt", "0xa", "0xb", "0xc", "0xd", "0xe"], edges);
    const vis = set("0xt", "0xa", "0xb");
    const e = estimateExpansion({ result: r, targets: [node("0xt", { synced: false })], k: 10, visible: vis, hidden: set() });
    expect(e.targets[0]).toMatchObject({ onCanvas: 2, fresh: 3, pending: true, upper: 8 });
    expect([e.min, e.max, e.pendingCount, e.syncCount]).toEqual([3, 8, 1, 1]);
    const s = estimateExpansion({ result: r, targets: [node("0xt", { synced: false, syncing: true })], k: 10, visible: vis, hidden: set() });
    expect([s.targets[0]!.pending, s.syncCount]).toEqual([true, 0]);
  });

  it("lowercases checksummed addresses", () => {
    const r = result(["0xT", "0xA"], [["0xT", "0xA"]]);
    const e = estimateExpansion({ result: r, targets: [node("0xT")], k: 3, visible: set("0xt"), hidden: set() });
    expect(e.targets[0]).toMatchObject({ address: "0xt", fresh: 1 });
  });
});

describe("revealStep / moreNext", () => {
  it("revealStep", () => {
    expect(revealStep(10, 25, 12)).toBe(27);
    expect(revealStep(30, 25, 12)).toBe(12);
  });
  it("moreNext", () => {
    expect(moreNext(40, 10, 25, 12)).toBe(12);
    expect(moreNext(5, 10, 10, 12)).toBe(5);
    expect(moreNext(40, 995, 995, 12)).toBe(5);
    expect(moreNext(40, 1000, 1200, 12)).toBe(0);
  });
});

describe("shownNeighbourCounts", () => {
  it("ignores self-loops and counts repeated neighbours once", () => {
    const r = result(["0xa", "0xb"], [["0xA", "0xa"], ["0xa", "0xb"], ["0xB", "0xa"]]);
    expect(shownNeighbourCounts(r, ["0xA"])).toEqual({ "0xa": 1 });
  });
});

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
