import type { TransferDto } from "../api/generated/TransferDto";
import { hiddenFromTransfer, transferKey } from "../graph/hiddenTransfers";
import { scaledAmount, transfersCsv } from "./csv";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const HEADER = "time_utc,block,tx_hash,sub_id,type,from,from_name,to,to_name,symbol,token,amount,amount_raw,hidden";

const tr = (over: Partial<TransferDto> = {}): TransferDto => ({
  tx_hash: "0x" + "01".repeat(32), sub_id: "top", kind: "native", block_number: 7, ts: "2024-03-02T12:30:00Z", from: A, to: B,
  asset: null, amount: "1500000000000000000", token_id: null, decimals: 18, symbol: null,
  trust: { level: "listed", impersonates: null, reason: null }, ...over,
});

/** A tiny RFC 4180 parser: rows of fields. */
function parse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; i++; }
    else cur += c;
  }
  return rows;
}

test("header row is exact", () => {
  expect(transfersCsv([], {}, new Map()).slice(1).split("\r\n")[0]).toBe(HEADER);
});

test("starts with a BOM and uses CRLF", () => {
  const csv = transfersCsv([tr()], {}, new Map());
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv.split("\r\n")).toHaveLength(3);
  expect(csv.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
});

test("quotes commas, quotes and newlines", () => {
  const name = 'Foo, "Bar"';
  const weird = 'Multi\nline, "x"';
  const csv = transfersCsv([tr()], {}, new Map([[A, name], [B, weird]]));
  expect(csv).toContain('"Foo, ""Bar"""');
  const rows = parse(csv.slice(1));
  expect(rows).toHaveLength(2);
  expect(rows[1]![6]).toBe(name);
  expect(rows[1]![8]).toBe(weird);
  expect(rows[1]).toHaveLength(14);
});

test("amount scales by decimals without separators and leaves it empty for unknown decimals", () => {
  expect(scaledAmount("1234500000000000000000", 18)).toBe("1234.5");
  expect(scaledAmount("1000000", 6)).toBe("1");
  expect(scaledAmount("1", 18)).toBe("0.000000000000000001");
  expect(scaledAmount("12345678901234567890123", 0)).toBe("12345678901234567890123");
  expect(scaledAmount("5", null)).toBe("");
  const row = parse(transfersCsv([tr({ decimals: null, amount: "42" })], {}, new Map()).slice(1))[1]!;
  expect(row[11]).toBe("");
  expect(row[12]).toBe("42");
});

test("ETH rows have an empty token column", () => {
  const rows = parse(transfersCsv([tr(), tr({ asset: USDC, kind: "erc20", symbol: "USDC", decimals: 6, amount: "5000000" })], {}, new Map()).slice(1));
  expect(rows[1]![10]).toBe("");
  expect(rows[2]![10]).toBe(USDC);
  expect(rows[2]![9]).toBe("USDC");
  expect(rows[2]![11]).toBe("5");
  expect(rows[2]![4]).toBe("erc20");
});

test("hidden column reflects the hidden set", () => {
  const r = tr();
  const csv = parse(transfersCsv([r, tr({ sub_id: "1" })], { [transferKey(r)]: hiddenFromTransfer(r) }, new Map()).slice(1));
  expect(csv.map((x) => x[13])).toEqual(["hidden", "true", "false"]);
});

test("a value a spreadsheet would run as a formula gets a leading apostrophe", () => {
  const csv = transfersCsv([tr({ symbol: '=HYPERLINK("x")' })], {}, new Map([[A, "@foo"], [B, "-1+1"]]));
  expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  const row = parse(csv.slice(1))[1]!;
  expect(row[9]).toBe(`'=HYPERLINK("x")`);
  expect(row[6]).toBe("'@foo");
  expect(row[8]).toBe("'-1+1");
  expect(row[1]).toBe("7");
});
