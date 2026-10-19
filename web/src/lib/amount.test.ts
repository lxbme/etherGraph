import { describe, expect, test } from "vitest";
import { formatAmount, formatFixed, formatFull, parseHumanAmount } from "./amount";

const MAX = (2n ** 256n - 1n).toString();

describe("formatAmount", () => {
  test("handles 2^256-1 with 18 decimals without precision loss", () => {
    const r = formatAmount(MAX, 18);
    expect(r.text.startsWith("115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457")).toBe(true);
    expect(r.text).toBe("115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.584");
    expect(r.unknownDecimals).toBe(false);
  });
  test("decimals 0 and 36", () => {
    expect(formatAmount("1234567", 0).text).toBe("1,234,567");
    expect(formatAmount("1500000000000000000000000000000000000", 36).text).toBe("1.5");
  });
  test("unknown decimals flags and shows raw integer", () => {
    expect(formatAmount("1234567", null)).toEqual({ text: "1,234,567", unknownDecimals: true });
  });
  test("truncates to 4 fraction digits and trims zeros", () => {
    expect(formatAmount("1234500000000000000", 18).text).toBe("1.2345");
    expect(formatAmount("1000000", 6).text).toBe("1");
    expect(formatAmount("1999999", 6).text).toBe("1.9999");
    expect(formatAmount("1000000", 6, { maxFrac: 2 }).text).toBe("1");
    expect(formatAmount("1239999", 6, { maxFrac: 2 }).text).toBe("1.23");
  });
  test("zero and tiny values", () => {
    expect(formatAmount("0", 18).text).toBe("0");
    expect(formatAmount("1", 18).text).toBe("<0.0001");
    expect(formatAmount("1", 18, { maxFrac: 2 }).text).toBe("<0.01");
    expect(formatAmount("00120", 3).text).toBe("0.12");
  });
  test("invalid raw", () => {
    expect(formatAmount("12a", 6)).toEqual({ text: "?", unknownDecimals: false });
    expect(formatAmount("", 6)).toEqual({ text: "?", unknownDecimals: false });
    expect(formatAmount("-5", null)).toEqual({ text: "?", unknownDecimals: false });
  });
});

describe("parseHumanAmount", () => {
  test("accepts commas and plain values", () => {
    expect(parseHumanAmount("1,000.5", 6)).toBe("1000500000");
    expect(parseHumanAmount(" 1 ", 0)).toBe("1");
    expect(parseHumanAmount("0.000001", 6)).toBe("1");
    expect(parseHumanAmount("0", 6)).toBe("0");
    expect(parseHumanAmount("000.0", 6)).toBe("0");
    expect(parseHumanAmount(".5", 1)).toBe("5");
    expect(parseHumanAmount("5.", 1)).toBe("50");
  });
  test("rejects bad input", () => {
    for (const s of ["", "  ", "-1", "+1", "1e5", "0.1234567", "1.2.3", "abc", "1,00", ",1", "1,,000", "1.0,0", ".", "1_0"]) {
      expect(parseHumanAmount(s, 6), s).toBeNull();
    }
    expect(parseHumanAmount("1.5", 0)).toBeNull();
  });
  test("comma groups: a 1-3 digit leading group without a leading zero, then groups of exactly 3", () => {
    expect(parseHumanAmount("12,345,678", 0)).toBe("12345678");
    expect(parseHumanAmount("999,000.25", 2)).toBe("99900025");
    for (const s of ["0,001", "00,001", "01,000", "1,0000", "1234,567", "1,00,000", "0,000"]) {
      expect(parseHumanAmount(s, 6), s).toBeNull();
    }
  });
});

describe("formatFixed", () => {
  test("pads to the asset class's fixed decimals", () => {
    expect(formatFixed("1000000000000000000", 18, "eth").text).toBe("1.000000");
    expect(formatFixed("0", 18, "eth").text).toBe("0.000000");
    expect(formatFixed("5", 0, "erc20").text).toBe("5.0000");
    expect(formatFixed("7", 0, "nft").text).toBe("7");
  });
  test("truncates instead of rounding", () => {
    expect(formatFixed("1234500", 6, "stable").text).toBe("1.23");
    expect(formatFixed("1999999", 6, "stable").text).toBe("1.99");
    expect(formatFixed("1999999999999999999", 18, "eth").text).toBe("1.999999");
  });
  test("a non-zero value that truncates to zero shows the smallest step", () => {
    expect(formatFixed("1", 18, "eth").text).toBe("<0.000001");
    expect(formatFixed("1", 6, "stable").text).toBe("<0.01");
    expect(formatFixed("1", 18, "erc20").text).toBe("<0.0001");
  });
  test("handles 2^256-1 and keeps the untruncated value in full", () => {
    const r = formatFixed(MAX, 18, "erc20");
    expect(r.text).toBe("115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.5840");
    expect(r.full).toBe("115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.584007913129639935");
    expect(r.unknownDecimals).toBe(false);
  });
  test("full drops trailing zeros only", () => {
    expect(formatFixed("1000000000000000000", 18, "eth").full).toBe("1");
    expect(formatFixed("1234500", 6, "stable").full).toBe("1.2345");
    expect(formatFixed("1", 18, "eth").full).toBe("0.000000000000000001");
    expect(formatFixed("5", 0, "erc20").full).toBe("5");
  });
  test("unknown decimals show the raw integer", () => {
    expect(formatFixed("42", null, "erc20")).toEqual({ text: "42", full: "42", unknownDecimals: true });
    expect(formatFixed("1234567", null, "erc20").text).toBe("1,234,567");
  });
  test("invalid raw", () => {
    expect(formatFixed("12a", 6, "stable")).toEqual({ text: "?", full: "12a", unknownDecimals: false });
  });
});

describe("formatFull", () => {
  test("keeps every fraction digit of a stablecoin and groups thousands", () => {
    expect(formatFull("4699465952", 6)).toBe("4,699.465952");
    expect(formatFull("1500000", 6)).toBe("1.5");
    expect(formatFull("5000000", 6)).toBe("5");
    expect(formatFull("1", 18)).toBe("0.000000000000000001");
    expect(formatFull(MAX, 18)).toBe("115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457.584007913129639935");
  });
  test("unknown or zero decimals show the raw integer", () => {
    expect(formatFull("1234567", null)).toBe("1,234,567");
    expect(formatFull("1234567", 0)).toBe("1,234,567");
    expect(formatFull("abc", 6)).toBe("?");
  });
});
