import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { clearToasts } from "../shell/Toasts";
import { identifyAddresses, needsIdentify, useIdentifying } from "./identify";
import * as toasts from "../shell/Toasts";

const node = (kind: NodeSummaryDto["kind"], identified: boolean): NodeSummaryDto => ({
  address: "0x" + "aa".repeat(20), kind, display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified, nonce: null, balance: null,
});
const addr = (i: number) => "0x" + i.toString(16).padStart(40, "0");

afterEach(() => {
  vi.restoreAllMocks();
  clearToasts();
});

test("needsIdentify truth table", () => {
  expect(needsIdentify(node("unknown", false))).toBe(true);
  expect(needsIdentify(node("contract", false))).toBe(true);
  expect(needsIdentify(node("eoa", false))).toBe(false);
  expect(needsIdentify(node("unknown", true))).toBe(false);
  expect(needsIdentify(node("contract", true))).toBe(false);
});

test("1203 addresses go out as 500/500/203 sharing one batch id, with one toast of the summed count", async () => {
  const identify = vi.spyOn(api, "identify").mockImplementation(async (b) => ({ queued: b.addresses.length - 1, jobs: [] }));
  const toast = vi.spyOn(toasts, "toast");
  await identifyAddresses(Array.from({ length: 1203 }, (_, i) => addr(i + 1)));
  expect(identify.mock.calls.map((c) => c[0].addresses.length)).toEqual([500, 500, 203]);
  const batches = new Set(identify.mock.calls.map((c) => c[0].batch));
  expect(batches.size).toBe(1);
  expect([...batches][0]).toMatch(/^[A-Za-z0-9-]{1,64}$/);
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith("Queued 1,200 addresses for identification");
});

test("duplicates and case differences are removed; nothing queued says so; empty input sends nothing", async () => {
  const identify = vi.spyOn(api, "identify").mockResolvedValue({ queued: 0, jobs: [] });
  const toast = vi.spyOn(toasts, "toast");
  const a = addr(0xabc);
  await identifyAddresses([a, a.toUpperCase().replace("0X", "0x"), a]);
  expect(identify).toHaveBeenCalledTimes(1);
  expect(identify.mock.calls[0]![0].addresses).toEqual([a]);
  expect(toast).toHaveBeenCalledWith("These addresses are already identified");
  identify.mockClear();
  await identifyAddresses([]);
  expect(identify).not.toHaveBeenCalled();
});

test("a failing request toasts the mapped error", async () => {
  vi.spyOn(api, "identify").mockRejectedValue(new ApiError("internal", 500, "boom"));
  const toast = vi.spyOn(toasts, "toast");
  await identifyAddresses([addr(1)]);
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast.mock.calls[0]![1]).toBe("error");
});

test("a second call while one is in flight sends nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const identify = vi.spyOn(api, "identify").mockImplementation(async () => {
    await gate;
    return { queued: 1, jobs: [] };
  });
  const first = identifyAddresses([addr(1)]);
  expect(useIdentifying.getState().running).toBe(true);
  await identifyAddresses([addr(1)]);
  expect(identify).toHaveBeenCalledTimes(1);
  release();
  await first;
  expect(useIdentifying.getState().running).toBe(false);
  await identifyAddresses([addr(2)]);
  expect(identify).toHaveBeenCalledTimes(2);
});

test("a later chunk failing after earlier ones were queued reports both", async () => {
  vi.spyOn(api, "identify")
    .mockResolvedValueOnce({ queued: 500, jobs: [] })
    .mockRejectedValueOnce(new ApiError("internal", 500, "boom"));
  const toast = vi.spyOn(toasts, "toast");
  await identifyAddresses(Array.from({ length: 700 }, (_, i) => addr(i + 1)));
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast.mock.calls[0]![0]).toMatch(/^Queued 500 addresses; the rest failed: /);
  expect(toast.mock.calls[0]![1]).toBe("error");
  expect(useIdentifying.getState().running).toBe(false);
});
