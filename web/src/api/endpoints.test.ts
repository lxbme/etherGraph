import { api } from "./endpoints";

afterEach(() => vi.unstubAllGlobals());

test("transfers joins kinds with commas and omits undefined params", async () => {
  const f = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", f);
  await api.transfers({ address: "0xabc", kinds: ["native", "erc20"], minAmount: "1", asset: null });
  const url: string = f.mock.calls[0]![0];
  expect(url).toContain("kinds=native%2Cerc20");
  expect(url).toContain("min_amount=1");
  expect(url).toContain("asset=eth");
  expect(url).not.toContain("cursor=");
  expect(url).not.toContain("time_from");
});

test("address passes sync only when given", async () => {
  const f = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", f);
  await api.address("0xabc");
  await api.address("0xabc", { sync: "auto" });
  expect(f.mock.calls[0]![0]).toBe("/api/address/0xabc");
  expect(f.mock.calls[1]![0]).toBe("/api/address/0xabc?sync=auto");
});
