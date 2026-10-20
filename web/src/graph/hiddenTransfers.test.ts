import { describe, expect, test } from "vitest";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { TransferDto } from "../api/generated/TransferDto";
import { countedByFilter, hiddenFromTransfer, subtractHidden, transferKey, type HiddenTransfer } from "./hiddenTransfers";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TX = "0x" + "1".repeat(64);

function edge(p: Partial<EdgeDto>): EdgeDto {
  return {
    from: A, to: B, asset: null, asset_kind: "native", count: 1, sum: "1",
    first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-31T00:00:00Z",
    decimals: 18, symbol: null, trust: { level: "listed", impersonates: null, reason: null }, ...p,
  };
}
function hidden(p: Partial<HiddenTransfer>): HiddenTransfer {
  return { tx_hash: TX, sub_id: "0", from: A, to: B, asset: null, amount: "10", ts: "2024-01-15T00:00:00Z", kind: "native", ...p };
}
const byKey = (...list: HiddenTransfer[]) => Object.fromEntries(list.map((h) => [transferKey(h), h]));

describe("transfer keys", () => {
  test("the key is the lowercase hash and the sub id", () => {
    expect(transferKey({ tx_hash: "0xABC", sub_id: "3" })).toBe("0xabc:3");
  });

  test("hiddenFromTransfer keeps what subtraction needs, lowercased", () => {
    const t: TransferDto = {
      tx_hash: TX.toUpperCase().replace("0X", "0x"), sub_id: "log:2", kind: "erc20", block_number: 5, ts: "2024-01-15T00:00:00Z",
      from: A.toUpperCase().replace("0X", "0x"), to: B, asset: USDC.toUpperCase().replace("0X", "0x"), amount: "4000000",
      token_id: null, decimals: 6, symbol: "USDC", trust: { level: "listed", impersonates: null, reason: null },
    };
    expect(hiddenFromTransfer(t)).toEqual({
      tx_hash: TX, sub_id: "log:2", from: A, to: B, asset: USDC, amount: "4000000", ts: "2024-01-15T00:00:00Z", kind: "erc20",
    });
  });
});

describe("subtractHidden", () => {
  test("subtracts count and sum from the matching edge only", () => {
    const eth = edge({ count: 3, sum: "30" });
    const usdc = edge({ asset: USDC, asset_kind: "erc20", count: 2, sum: "7000000", decimals: 6 });
    const out = subtractHidden([eth, usdc], byKey(hidden({ amount: "10" })), {});
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ ...eth, count: 2, sum: "20" });
    expect(out[1]).toBe(usdc);
  });

  test("drops an edge whose transfers are all hidden", () => {
    const eth = edge({ count: 2, sum: "30" });
    const other = edge({ to: C, count: 1, sum: "5" });
    const out = subtractHidden([eth, other], byKey(hidden({ amount: "10" }), hidden({ sub_id: "1", amount: "20" })), {});
    expect(out).toEqual([other]);
  });

  test("a hidden transfer outside the time window is not subtracted", () => {
    const eth = edge({ count: 3, sum: "30" });
    const h = byKey(hidden({ ts: "2023-12-31T23:59:59Z" }));
    const window = { time: { from: "2024-01-01T00:00:00Z", to: "2024-01-31T23:59:59Z" } };
    expect(subtractHidden([eth], h, window)[0]).toBe(eth);
    // The bounds are inclusive.
    expect(subtractHidden([eth], byKey(hidden({ ts: "2024-01-01T00:00:00Z" })), window)[0]!.count).toBe(2);
    expect(subtractHidden([eth], byKey(hidden({ ts: "2024-02-01T00:00:00Z" })), window)[0]).toBe(eth);
  });

  test("a hidden transfer of a kind the filter leaves out is not subtracted", () => {
    const eth = edge({ count: 3, sum: "30" });
    expect(subtractHidden([eth], byKey(hidden({ kind: "internal" })), { kinds: ["native"] })[0]).toBe(eth);
    expect(subtractHidden([eth], byKey(hidden({ kind: "internal" })), { kinds: ["native", "internal"] })[0]!.count).toBe(2);
  });

  test("a raised min_amount stops subtracting a transfer below it", () => {
    const usdc = edge({ asset: USDC, asset_kind: "erc20", count: 2, sum: "9000000", decimals: 6 });
    const h = byKey(hidden({ asset: USDC, kind: "erc20", amount: "4000000" }));
    expect(subtractHidden([usdc], h, { assets: [{ asset: USDC, min_amount: "5" }] })[0]).toBe(usdc);
    expect(subtractHidden([usdc], h, { assets: [{ asset: USDC, min_amount: "4" }] })[0]).toMatchObject({ count: 1, sum: "5000000" });
  });

  test("a hidden record without an edge is ignored", () => {
    const eth = edge({ count: 3, sum: "30" });
    const edges = [eth];
    const out = subtractHidden(edges, byKey(hidden({ from: C }), hidden({ sub_id: "1", asset: USDC, kind: "erc20" })), {});
    expect(out).toBe(edges);
  });
});

describe("countedByFilter", () => {
  test("an asset list counts only its assets; ETH matches null or \"eth\"", () => {
    const eth = hidden({});
    expect(countedByFilter(eth, { assets: [{ asset: USDC }] }, 18)).toBe(false);
    expect(countedByFilter(eth, { assets: [{ asset: null }] }, 18)).toBe(true);
    expect(countedByFilter(eth, { assets: [{ asset: "ETH" }] }, 18)).toBe(true);
    expect(countedByFilter(hidden({ asset: USDC, kind: "erc20" }), { assets: [{ asset: USDC.toUpperCase().replace("0X", "0x") }] }, 6)).toBe(true);
  });

  test("a threshold with unknown decimals counts the transfer", () => {
    const h = hidden({ asset: USDC, kind: "erc20", amount: "1" });
    expect(countedByFilter(h, { assets: [{ asset: USDC, min_amount: "1000" }] }, null)).toBe(true);
  });

  test("an ETH threshold is scaled by 18 decimals", () => {
    const h = hidden({ amount: "500000000000000000" });
    expect(countedByFilter(h, { assets: [{ asset: null, min_amount: "0.5" }] }, 18)).toBe(true);
    expect(countedByFilter(h, { assets: [{ asset: null, min_amount: "0.6" }] }, 18)).toBe(false);
  });
});
