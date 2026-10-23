import { afterEach, expect, test, vi } from "vitest";
import { formatCount, formatLocalTime, formatShortTime, formatTime } from "./format";

afterEach(() => vi.unstubAllEnvs());

test("formatTime renders UTC YYYY-MM-DD HH:mm:ss with a UTC suffix", () => {
  expect(formatTime("2026-10-16T04:11:07Z")).toBe("2026-10-16 04:11:07 UTC");
  expect(formatTime("2024-01-05T23:59:09+02:00")).toBe("2024-01-05 21:59:09 UTC");
});
test.each([
  ["Asia/Shanghai", "2026-10-16 12:11:07 UTC+8"],
  ["America/St_Johns", "2026-10-16 01:41:07 UTC-2:30"], // NDT in October
  ["Africa/Abidjan", "2026-10-16 04:11:07 UTC"],
  ["Asia/Kolkata", "2026-10-16 09:41:07 UTC+5:30"],
])("formatLocalTime in %s states the offset", (tz, want) => {
  vi.stubEnv("TZ", tz);
  expect(formatLocalTime("2026-10-16T04:11:07Z")).toBe(want);
});
test("formatLocalTime near midnight shows the local date and offset", () => {
  vi.stubEnv("TZ", "Asia/Shanghai");
  expect(formatLocalTime("2026-10-16T17:30:00Z")).toBe("2026-10-17 01:30:00 UTC+8");
  expect(formatTime("2026-10-16T17:30:00Z")).toBe("2026-10-16 17:30:00 UTC");
  vi.stubEnv("TZ", "America/Sao_Paulo");
  expect(formatLocalTime("2026-10-16T01:30:00Z")).toBe("2026-10-15 22:30:00 UTC-3");
  vi.stubEnv("TZ", "America/St_Johns");
  expect(formatLocalTime("2026-01-16T01:00:00Z")).toBe("2026-01-15 21:30:00 UTC-3:30");
});
test("formatShortTime renders UTC YYYY-MM-DD HH:mm (the same instant formatTime shows, to the minute)", () => {
  expect(formatShortTime("2026-10-16T04:11:07Z")).toBe("2026-10-16 04:11");
  expect(formatShortTime("2024-01-05T23:59:09+02:00")).toBe("2024-01-05 21:59");
  vi.stubEnv("TZ", "Asia/Shanghai");
  expect(formatShortTime("2026-10-16T17:30:00Z")).toBe("2026-10-16 17:30");
  expect(formatShortTime("nope")).toBe("nope");
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
