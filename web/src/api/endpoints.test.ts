import { api } from "./endpoints";

afterEach(() => vi.unstubAllGlobals());

test("transfers joins kinds with commas and omits undefined params", async () => {
  const f = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", f);
  await api.transfers({ address: "0xabc", kinds: ["native", "erc20"], minAmount: "1", asset: null, direction: "in" });
  const url: string = f.mock.calls[0]![0];
  expect(url).toContain("kinds=native%2Cerc20");
  expect(url).toContain("direction=in");
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

function stub() {
  const f = vi.fn().mockImplementation(async () => new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", f);
  return f;
}

test("tx encodes the hash path segment", async () => {
  const f = stub();
  await api.tx("a/b?c");
  expect(f.mock.calls[0]![0]).toBe("/api/tx/a%2Fb%3Fc");
});

test("transfers maps from/to/time_from/time_to", async () => {
  const f = stub();
  await api.transfers({ from: "0x1", to: "0x2", timeFrom: "2026-01-01T00:00:00Z", timeTo: "2026-02-01T00:00:00Z" });
  const url: string = f.mock.calls[0]![0];
  expect(url).toContain("from=0x1");
  expect(url).toContain("to=0x2");
  expect(url).toContain("time_from=2026-01-01T00%3A00%3A00Z");
  expect(url).toContain("time_to=2026-02-01T00%3A00%3A00Z");
  expect(url).not.toContain("direction");
});

test("jobs and recentJobs use the active flag", async () => {
  const f = stub();
  await api.recentJobs();
  await api.jobs();
  expect(f.mock.calls[0]![0]).toBe("/api/jobs?active=false");
  expect(f.mock.calls[1]![0]).toBe("/api/jobs?active=true");
});

test("labels uses the addr query", async () => {
  const f = stub();
  await api.labels("0xabc");
  expect(f.mock.calls[0]![0]).toBe("/api/labels?addr=0xabc");
});
