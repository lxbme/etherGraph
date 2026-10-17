import { afterEach, expect, test, vi } from "vitest";
import { newBatchId } from "./batchId";

/** POST /api/sync's `batch`: 1–64 characters of [A-Za-z0-9-]. */
const VALID = /^[A-Za-z0-9-]{1,64}$/;

afterEach(() => vi.unstubAllGlobals());

test("uses crypto.randomUUID when the context offers it", () => {
  const id = newBatchId();
  expect(id).toMatch(VALID);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
});

test("falls back to random hex where randomUUID is missing (plain-http origins)", () => {
  const { getRandomValues } = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: getRandomValues.bind(globalThis.crypto) });
  const a = newBatchId();
  const b = newBatchId();
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(a).toMatch(VALID);
  expect(a).not.toBe(b);
});
