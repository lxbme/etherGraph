import type { TransferDto } from "../api/generated/TransferDto";
import { hiddenFromTransfer, transferKey, type HiddenTransfer } from "../graph/hiddenTransfers";
import { useGraph } from "../graph/store";
import { DEFAULT_DATA_FILTER, amountBoundValid, filterRows, isDefaultDataFilter, useDataFilter, type DataFilter } from "./dataFilter";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ODD = "0x" + "dd".repeat(20);

const transfer = (i: number, over: Partial<TransferDto> = {}): TransferDto => ({
  tx_hash: "0x" + i.toString(16).padStart(64, "0"), sub_id: "top", kind: "native", block_number: 1,
  ts: "2024-01-01T00:00:00Z", from: A, to: B, asset: null, amount: "1000000000000000000", token_id: null, decimals: 18,
  symbol: null, trust: { level: "listed", impersonates: null, reason: null }, ...over,
});

const F = (over: Partial<DataFilter> = {}): DataFilter => ({ ...DEFAULT_DATA_FILTER, ...over });
const NO_HIDDEN: Record<string, HiddenTransfer> = {};
const NO_NAMES = new Map<string, string>();
const hashes = (rows: TransferDto[]) => rows.map((r) => r.tx_hash);

beforeEach(() => useDataFilter.getState().reset());

test("default keeps every row", () => {
  // Newest first across chunks; the same second falls back to the hash, then the sub id, both descending.
  const rows = [
    transfer(1, { ts: "2024-01-01T00:00:00Z" }),
    transfer(2, { ts: "2024-03-01T00:00:00Z" }),
    transfer(3, { ts: "2024-02-01T00:00:00Z", sub_id: "a:0" }),
    transfer(3, { ts: "2024-02-01T00:00:00Z", sub_id: "a:1" }),
    transfer(4, { ts: "2024-02-01T00:00:00Z" }),
  ];
  const out = filterRows(rows, F(), NO_HIDDEN, NO_NAMES);
  expect(out.map((r) => transferKey(r))).toEqual([
    transferKey(rows[1]!),
    transferKey(rows[4]!),
    transferKey(rows[3]!),
    transferKey(rows[2]!),
    transferKey(rows[0]!),
  ]);
  // Hidden rows are shown by default; the input is left as it was.
  expect(filterRows(rows, F(), { [transferKey(rows[0]!)]: hiddenFromTransfer(rows[0]!) }, NO_NAMES)).toHaveLength(5);
  expect(hashes(rows)[0]).toBe(transfer(1).tx_hash);
  expect(useDataFilter.getState()).toMatchObject(DEFAULT_DATA_FILTER);
  expect(DEFAULT_DATA_FILTER.showHidden).toBe(true);
  expect(isDefaultDataFilter(F())).toBe(true);
  expect(isDefaultDataFilter(F({ showHidden: false }))).toBe(false);
  expect(isDefaultDataFilter(F({ address: "0xaa" }))).toBe(false);
});

test("the filter starts over with a new canvas", () => {
  useDataFilter.getState().set({ kind: "erc20", address: "bob" });
  useGraph.getState().reset();
  expect(useDataFilter.getState()).toMatchObject(DEFAULT_DATA_FILTER);
});

test("address matches names and roles", () => {
  const ab = transfer(1, { from: A, to: B });
  const bc = transfer(2, { from: "0x" + "BB".repeat(20), to: C });
  const rows = [ab, bc];
  const names = new Map([[B, "Bob.eth"]]);
  // A substring of the address, in any case, on either side.
  expect(hashes(filterRows(rows, F({ address: "0xAAAA" }), NO_HIDDEN, names))).toEqual([ab.tx_hash]);
  expect(hashes(filterRows(rows, F({ address: " bbbb " }), NO_HIDDEN, names))).toEqual([bc.tx_hash, ab.tx_hash]);
  // A substring of the name, in any case (a checksummed address finds its name too).
  expect(filterRows(rows, F({ address: "BOB" }), NO_HIDDEN, names)).toHaveLength(2);
  // Roles: B receives ab and sends bc.
  expect(hashes(filterRows(rows, F({ address: "bob", addressRole: "to" }), NO_HIDDEN, names))).toEqual([ab.tx_hash]);
  expect(hashes(filterRows(rows, F({ address: "bob", addressRole: "from" }), NO_HIDDEN, names))).toEqual([bc.tx_hash]);
  expect(filterRows(rows, F({ address: "alice" }), NO_HIDDEN, names)).toHaveLength(0);
  // A role without an address narrows nothing.
  expect(filterRows(rows, F({ addressRole: "to" }), NO_HIDDEN, names)).toHaveLength(2);
});

test("amount bounds compare in token units and skip unknown decimals", () => {
  const eth1 = transfer(1, { amount: "1000000000000000000" });
  const eth2 = transfer(2, { amount: "2500000000000000000" });
  const usdc = transfer(3, { asset: USDC, kind: "erc20", amount: "2500000", decimals: 6, symbol: "USDC" });
  const usdcSmall = transfer(4, { asset: USDC.toUpperCase().replace("0X", "0x"), kind: "erc20", amount: "1", decimals: 6 });
  const odd = transfer(5, { asset: ODD, kind: "erc20", amount: "5", decimals: null });
  const rows = [eth1, eth2, usdc, usdcSmall, odd];

  // Bounds apply only once one asset is chosen.
  expect(filterRows(rows, F({ minAmount: "2" }), NO_HIDDEN, NO_NAMES)).toHaveLength(5);
  // ETH, both bounds inclusive.
  expect(hashes(filterRows(rows, F({ asset: null, minAmount: "2" }), NO_HIDDEN, NO_NAMES))).toEqual([eth2.tx_hash]);
  expect(hashes(filterRows(rows, F({ asset: null, maxAmount: "1" }), NO_HIDDEN, NO_NAMES))).toEqual([eth1.tx_hash]);
  expect(filterRows(rows, F({ asset: null, minAmount: "1", maxAmount: "2.5" }), NO_HIDDEN, NO_NAMES)).toHaveLength(2);
  // A token's own decimals, and more fraction digits than the token has (exact, no rounding).
  expect(hashes(filterRows(rows, F({ asset: USDC, minAmount: "2.5" }), NO_HIDDEN, NO_NAMES))).toEqual([usdc.tx_hash]);
  expect(hashes(filterRows(rows, F({ asset: USDC, minAmount: "0.0000005" }), NO_HIDDEN, NO_NAMES))).toEqual([usdcSmall.tx_hash, usdc.tx_hash]);
  expect(hashes(filterRows(rows, F({ asset: USDC, minAmount: "0.0000015" }), NO_HIDDEN, NO_NAMES))).toEqual([usdc.tx_hash]);
  expect(hashes(filterRows(rows, F({ asset: USDC, maxAmount: "1,000" }), NO_HIDDEN, NO_NAMES))).toHaveLength(2);
  // Unknown decimals: listed without bounds, dropped with one.
  expect(hashes(filterRows(rows, F({ asset: ODD }), NO_HIDDEN, NO_NAMES))).toEqual([odd.tx_hash]);
  expect(filterRows(rows, F({ asset: ODD, minAmount: "0" }), NO_HIDDEN, NO_NAMES)).toHaveLength(0);
  // An invalid bound is unset.
  expect(filterRows(rows, F({ asset: null, minAmount: "1.2.3", maxAmount: "abc" }), NO_HIDDEN, NO_NAMES)).toHaveLength(2);
  expect(filterRows(rows, F({ asset: ODD, minAmount: "x" }), NO_HIDDEN, NO_NAMES)).toHaveLength(1);
  expect(amountBoundValid("")).toBe(true);
  expect(amountBoundValid("1,000.25")).toBe(true);
  expect(amountBoundValid(".5")).toBe(true);
  expect(amountBoundValid("1.2.3")).toBe(false);
  expect(amountBoundValid("-1")).toBe(false);
  expect(amountBoundValid("1e3")).toBe(false);
});

test("showHidden false drops hidden rows", () => {
  const rows = [transfer(1), transfer(2), transfer(3)];
  // Stored keys are lowercase: a checksummed hash still matches.
  const upper = transfer(4, { tx_hash: "0x" + "AB".repeat(32) });
  const hidden = { [transferKey(rows[1]!)]: hiddenFromTransfer(rows[1]!), [transferKey(upper)]: hiddenFromTransfer(upper) };
  expect(hashes(filterRows([...rows, upper], F({ showHidden: false }), hidden, NO_NAMES))).toEqual([rows[2]!.tx_hash, rows[0]!.tx_hash]);
  expect(filterRows([...rows, upper], F({ showHidden: true }), hidden, NO_NAMES)).toHaveLength(4);
});

test("days are inclusive UTC", () => {
  const before = transfer(1, { ts: "2024-03-22T23:59:59Z" });
  const first = transfer(2, { ts: "2024-03-23T00:00:00Z" });
  const last = transfer(3, { ts: "2024-03-31T23:59:59Z" });
  const after = transfer(4, { ts: "2024-04-01T00:00:00Z" });
  const rows = [before, first, last, after];
  expect(hashes(filterRows(rows, F({ from: "2024-03-23", to: "2024-03-31" }), NO_HIDDEN, NO_NAMES))).toEqual([last.tx_hash, first.tx_hash]);
  // An inverted range is swapped; an open side is open.
  expect(filterRows(rows, F({ from: "2024-03-31", to: "2024-03-23" }), NO_HIDDEN, NO_NAMES)).toHaveLength(2);
  expect(hashes(filterRows(rows, F({ from: "2024-04-01" }), NO_HIDDEN, NO_NAMES))).toEqual([after.tx_hash]);
  expect(hashes(filterRows(rows, F({ to: "2024-03-22" }), NO_HIDDEN, NO_NAMES))).toEqual([before.tx_hash]);
  // Asset and type narrow as well.
  const tok = transfer(5, { ts: "2024-03-25T00:00:00Z", asset: USDC, kind: "erc20", decimals: 6 });
  expect(hashes(filterRows([...rows, tok], F({ asset: USDC }), NO_HIDDEN, NO_NAMES))).toEqual([tok.tx_hash]);
  expect(filterRows([...rows, tok], F({ asset: null }), NO_HIDDEN, NO_NAMES)).toHaveLength(4);
  expect(hashes(filterRows([...rows, tok], F({ kind: "erc20" }), NO_HIDDEN, NO_NAMES))).toEqual([tok.tx_hash]);
});
