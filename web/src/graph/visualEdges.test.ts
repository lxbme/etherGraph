import { describe, expect, test } from "vitest";
import type { EdgeDto } from "../api/generated/EdgeDto";
import { deriveVisualEdges, edgeWidth } from "./visualEdges";
import { pairKey } from "./pairKey";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const tok = (n: number) => "0x" + n.toString(16).padStart(40, "0");

function edge(p: Partial<EdgeDto> & { count: number }): EdgeDto {
  return {
    from: A, to: B, asset: null, asset_kind: "native", sum: "1",
    first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-02T00:00:00Z",
    decimals: 18, symbol: null, trust: { level: "listed", impersonates: null, reason: null }, ...p,
  };
}
const none = new Set<string>();

describe("deriveVisualEdges", () => {
  test("collapsed pair merges per direction with dominant asset color and ×N badge", () => {
    const es = [
      edge({ count: 2 }),
      edge({ count: 7, asset: USDT, asset_kind: "erc20" }),
      edge({ count: 1, asset: tok(9), asset_kind: "erc20" }),
      edge({ from: B, to: A, count: 3 }),
    ];
    const v = deriveVisualEdges(es, none, none);
    expect(v).toHaveLength(2);
    const ab = v.find((e) => e.id === `c:${A}>${B}`)!;
    expect(ab).toMatchObject({ color: "stable", count: 10, badge: "×3", expanded: false });
    expect(ab.assets.map((x) => x.count)).toEqual([7, 2, 1]);
    const ba = v.find((e) => e.from === B)!;
    expect(ba).toMatchObject({ id: `c:${B}>${A}`, color: "eth", count: 3, badge: null });
  });

  test("ties pick smallest asset address", () => {
    const v = deriveVisualEdges(
      [edge({ count: 4, asset: USDT, asset_kind: "erc20" }), edge({ count: 4, asset: tok(1), asset_kind: "erc20" })],
      none, none,
    );
    expect(v[0]!.color).toBe("erc20");
  });

  test("collapsed badge counts distinct assets, not rows", () => {
    const v = deriveVisualEdges([edge({ count: 1 }), edge({ count: 2 })], none, none);
    expect(v[0]).toMatchObject({ badge: null, count: 3, color: "eth" });
    const w = deriveVisualEdges(
      [edge({ count: 3 }), edge({ count: 3 }), edge({ count: 5, asset: USDT, asset_kind: "erc20" })],
      none, none,
    );
    expect(w[0]).toMatchObject({ badge: "×2", color: "eth", count: 11 });
  });

  test("count tie between ETH and an ERC20: ETH wins", () => {
    const v = deriveVisualEdges(
      [edge({ count: 4, asset: tok(1), asset_kind: "erc20" }), edge({ count: 4 })],
      none, none,
    );
    expect(v[0]!.color).toBe("eth");
  });

  test("expanded pair yields per-asset parallel edges capped at 5 plus 'other N'", () => {
    const es = Array.from({ length: 8 }, (_, i) =>
      edge({ count: 100 - i, asset: tok(i + 1), asset_kind: "erc20" }),
    );
    const v = deriveVisualEdges(es, new Set([pairKey(A, B)]), none);
    expect(v).toHaveLength(6);
    expect(v.slice(0, 5).every((e) => e.expanded && e.badge === null)).toBe(true);
    expect(v[0]!.id).toBe(`e:${A}>${B}:${tok(1)}`);
    const rest = v.find((e) => e.id === `r:${A}>${B}`)!;
    expect(rest).toMatchObject({ color: "other", badge: "3 other assets", count: 95 + 94 + 93 });
    expect(rest.assets).toHaveLength(3);
  });

  test("expanded ETH edge id uses eth", () => {
    const v = deriveVisualEdges([edge({ count: 1 })], new Set([pairKey(A, B)]), none);
    expect(v[0]!.id).toBe(`e:${A}>${B}:eth`);
  });

  test("single asset pair has no badge in either mode", () => {
    const es = [edge({ count: 5 })];
    expect(deriveVisualEdges(es, none, none)[0]!.badge).toBeNull();
    expect(deriveVisualEdges(es, new Set([pairKey(A, B)]), none)[0]!.badge).toBeNull();
  });

  test("hidden node removes its edges", () => {
    const es = [edge({ count: 1 }), edge({ from: B, to: tok(5), count: 1 })];
    expect(deriveVisualEdges(es, none, new Set([A]))).toHaveLength(1);
    expect(deriveVisualEdges(es, none, new Set([B]))).toHaveLength(0);
  });

  test("self-loop is kept", () => {
    const v = deriveVisualEdges([edge({ from: A, to: A, count: 2 })], none, none);
    expect(v).toHaveLength(1);
    expect(v[0]!.id).toBe(`c:${A}>${A}`);
  });

  test("ids are stable across re-derivation", () => {
    const es = [edge({ count: 2 }), edge({ count: 7, asset: USDT, asset_kind: "erc20" })];
    const ids = (e: EdgeDto[]) => deriveVisualEdges(e, none, none).map((x) => x.id);
    expect(ids(es)).toEqual(ids([...es].reverse()));
    const ex = new Set([pairKey(A, B)]);
    const ids2 = (e: EdgeDto[]) => deriveVisualEdges(e, ex, none).map((x) => x.id).sort();
    expect(ids2(es)).toEqual(ids2([...es].reverse()));
  });

  test("edgeWidth is log scaled and capped at 8", () => {
    expect(edgeWidth(1)).toBe(1);
    expect(edgeWidth(10)).toBeCloseTo(2.5);
    expect(edgeWidth(1e12)).toBe(8);
  });
});
