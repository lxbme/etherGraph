import { expect, test } from "vitest";
import { formatCount, formatLocalTime, formatTime } from "./format";

test("formatTime renders UTC YYYY-MM-DD HH:mm:ss", () => {
  expect(formatTime("2026-10-16T04:11:07Z")).toBe("2026-10-16 04:11:07");
  expect(formatTime("2024-01-05T23:59:09+02:00")).toBe("2024-01-05 21:59:09");
});
test("formatLocalTime renders local YYYY-MM-DD HH:mm:ss", () => {
  const d = new Date(2024, 0, 5, 3, 7, 9);
  expect(formatLocalTime(d.toISOString())).toBe("2024-01-05 03:07:09");
});
test("formatTime and formatLocalTime return input when invalid", () => {
  expect(formatTime("nope")).toBe("nope");
  expect(formatLocalTime("nope")).toBe("nope");
});
test("formatCount thousands separators", () => {
  expect(formatCount(0)).toBe("0");
  expect(formatCount(999)).toBe("999");
  expect(formatCount(1234567)).toBe("1,234,567");
});
