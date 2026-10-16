import { expect, test } from "vitest";
import { formatCount, formatTime } from "./format";

test("formatTime renders local YYYY-MM-DD HH:mm", () => {
  const d = new Date(2024, 0, 5, 3, 7);
  expect(formatTime(d.toISOString())).toBe("2024-01-05 03:07");
});
test("formatTime returns input when invalid", () => {
  expect(formatTime("nope")).toBe("nope");
});
test("formatCount thousands separators", () => {
  expect(formatCount(0)).toBe("0");
  expect(formatCount(999)).toBe("999");
  expect(formatCount(1234567)).toBe("1,234,567");
});
