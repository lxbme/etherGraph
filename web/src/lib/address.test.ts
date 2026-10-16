import { expect, test } from "vitest";
import { sameAddr, shortAddr } from "./address";

test("shortAddr", () => {
  expect(shortAddr("0x3f2aAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA91c0")).toBe("0x3f2a…91c0");
  expect(shortAddr("0x12")).toBe("0x12");
});
test("sameAddr compares case-insensitively", () => {
  expect(sameAddr("0xABC", "0xabc")).toBe(true);
  expect(sameAddr("0xabc", "0xabd")).toBe(false);
});
