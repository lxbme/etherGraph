import { describe, expect, test } from "vitest";
import { formatAmount, parseHumanAmount } from "./amount";

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
});
