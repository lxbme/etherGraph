import type { EdgeDto } from "../../api/generated/EdgeDto";
import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { TrustDto } from "../../api/generated/TrustDto";
import { flowTotals, neighbourRows } from "./neighbours";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const node = (n: number): NodeSummaryDto => ({
  address: addr(n), kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null,
});
const OK: TrustDto = { level: "listed", impersonates: null, reason: null };
const SCAM: TrustDto = { level: "scam", impersonates: null, reason: "spam-token" };
const TOKEN = "0x" + "ab".repeat(20);
function edge(from: number, to: number, o: Partial<EdgeDto> = {}): EdgeDto {
  return {
    from: addr(from), to: addr(to), asset: null, asset_kind: "native", count: 1, sum: "1",
    first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-01T00:00:00Z", decimals: 18, symbol: "ETH", trust: OK, ...o,
  };
}
const result = (nodes: number[], edges: EdgeDto[]): GraphResponseDto => ({
  nodes: nodes.map(node), edges, omitted: {}, coverage: {},
});
const C = 1;
type Sort = "count" | "amount" | "recent";
const ctx = (o: { visible?: number[]; own?: number[]; centers?: number[]; prefer?: number[]; sort?: Sort } = {}) => ({
  visible: new Set((o.visible ?? []).map(addr)),
  own: new Set((o.own ?? []).map(addr)),
  centers: new Set((o.centers ?? [C]).map(addr)),
  prefer: new Set((o.prefer ?? []).map(addr)),
  sort: o.sort ?? "count",
});

test("rows_aggregate_both_directions_and_assets", () => {
  const r = result([C, 2, 3], [
    edge(C, 2, { count: 3, last_ts: "2024-02-01T00:00:00Z" }),
    edge(2, C, { count: 4, last_ts: "2024-05-01T00:00:00Z" }),
    edge(2, C, { asset: TOKEN, asset_kind: "erc20", symbol: "FAKE", trust: SCAM, count: 2, last_ts: "2024-03-01T00:00:00Z" }),
    edge(C, 3, { count: 1 }),
    // Not touching the center: ignored.
    edge(2, 3, { count: 50 }),
  ]);
  const rows = neighbourRows(r, addr(C), ctx());
  expect(rows.map((x) => x.address)).toEqual([addr(2), addr(3)]);
  expect(rows[0]).toMatchObject({ count: 9, lastTs: "2024-05-01T00:00:00Z", onCanvas: false, locked: false });
  expect(rows[0]!.node.address).toBe(addr(2));
  expect(rows[0]!.assets).toEqual([
    { asset: null, symbol: "ETH", trust: OK },
    { asset: TOKEN, symbol: "FAKE", trust: SCAM },
  ]);
  expect(rows[1]).toMatchObject({ count: 1 });
});

test("other centers and self-transfers are not rows; a neighbour is matched case-insensitively", () => {
  const r = result([C, 2, 3], [
    edge(C, 2),
    edge(C, 3),
    edge(C, C, { count: 9 }),
    { ...edge(4, C), from: addr(4).toUpperCase().replace("0X", "0x") },
  ]);
  const rows = neighbourRows(r, addr(C).toUpperCase().replace("0X", "0x"), ctx({ centers: [C, 3] }));
  expect(rows.map((x) => x.address)).toEqual([addr(2), addr(4)]);
});

test("rows_follow_the_graph_sort", () => {
  const r = result([C, 2, 3, 4, 5], [
    // count: 2 → 5, 3 → 2, 4 → 2, 5 → 1
    edge(C, 2, { count: 5, sum: "10", last_ts: "2024-01-01T00:00:00Z" }),
    edge(C, 3, { count: 2, sum: "1000000000000000000000", last_ts: "2024-06-01T00:00:00Z" }),
    edge(C, 4, { count: 2, sum: "999", last_ts: "2024-03-01T00:00:00Z" }),
    edge(5, C, { count: 1, sum: "999", last_ts: "2024-06-01T00:00:00Z" }),
  ]);
  const order = (sort: Sort, prefer: number[] = []) =>
    neighbourRows(r, addr(C), ctx({ sort, prefer })).map((x) => parseInt(x.address, 16));
  // Ties (3 and 4 on count; 4 and 5 on amount; 3 and 5 on recent) go by address ascending.
  expect(order("count")).toEqual([2, 3, 4, 5]);
  expect(order("amount")).toEqual([3, 4, 5, 2]);
  expect(order("recent")).toEqual([3, 5, 4, 2]);
  // Like the server, preferred (on-canvas) neighbours rank first, by the sort among themselves, then the others.
  expect(order("count", [5, 4])).toEqual([4, 5, 2, 3]);
  expect(order("recent", [2, 4])).toEqual([4, 2, 3, 5]);
});

test("locked_means_on_canvas_for_another_reason", () => {
  const r = result([C, 2, 3, 4], [edge(C, 2), edge(C, 3), edge(C, 4)]);
  // 2 is on the canvas because of this center (own), 3 for another reason, 4 is not on the canvas.
  const rows = neighbourRows(r, addr(C), ctx({ visible: [C, 2, 3], own: [2] }));
  expect(rows.map((x) => [parseInt(x.address, 16), x.onCanvas, x.locked])).toEqual([
    [2, true, false],
    [3, true, true],
    [4, false, false],
  ]);
});

test("an edge repeated by merged chunks counts once", () => {
  const e = edge(C, 2, { count: 3 });
  const rows = neighbourRows(result([C, 2], [e, { ...e }]), addr(C), ctx());
  expect(rows[0]!.count).toBe(3);
});

test("flows split by asset and direction", () => {
  const USDC = "0x" + "cd".repeat(20);
  const r = result([C, 2], [
    edge(C, 2, { count: 2, sum: "10" }),
    edge(2, C, { count: 1, sum: "3" }),
    edge(C, 2, { asset: USDC.toUpperCase().replace("0X", "0x"), asset_kind: "erc20", symbol: "USDC", decimals: 6, count: 4, sum: "7" }),
  ]);
  const p = neighbourRows(r, addr(C), ctx())[0]!;
  expect(p.flows).toEqual([
    { asset: null, dir: "out", count: 2, sum: 10n, decimals: 18, symbol: "ETH" },
    { asset: null, dir: "in", count: 1, sum: 3n, decimals: 18, symbol: "ETH" },
    { asset: USDC, dir: "out", count: 4, sum: 7n, decimals: 6, symbol: "USDC" },
  ]);
  expect(flowTotals(p, null, "out").sum).toBe(10n);
  expect(flowTotals(p, null, "all").sum).toBe(13n);
  expect(flowTotals(p, USDC, "in").count).toBe(0);
  expect(flowTotals(p, USDC, "out")).toEqual({ count: 4, sum: 7n });
  expect(flowTotals(p, "all", "all").count).toBe(7);
});

test("repeated chunk edges count once in flows", () => {
  const e = edge(C, 2, { count: 3, sum: "5" });
  const p = neighbourRows(result([C, 2], [e, { ...e }]), addr(C), ctx())[0]!;
  expect(p.flows).toEqual([{ asset: null, dir: "out", count: 3, sum: 5n, decimals: 18, symbol: "ETH" }]);
  expect(flowTotals(p, null, "all")).toEqual({ count: 3, sum: 5n });
});
