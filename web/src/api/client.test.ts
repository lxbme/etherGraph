import { ApiError } from "./errors";
import { request } from "./client";

afterEach(() => vi.unstubAllGlobals());

test("request parses error body into ApiError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: { code: "conflict", message: "x" } }), { status: 409 }),
  ));
  const err = (await request("GET", "/x").catch((e: unknown) => e)) as ApiError;
  expect(err).toBeInstanceOf(ApiError);
  expect(err.code).toBe("conflict");
  expect(err.status).toBe(409);
  expect(err.message).toBe("x");
});

test("request maps fetch rejection to network", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fail")));
  const err = (await request("GET", "/x").catch((e: unknown) => e)) as ApiError;
  expect(err).toBeInstanceOf(ApiError);
  expect(err.code).toBe("network");
});

test("request returns undefined on 204", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  expect(await request("DELETE", "/x")).toBeUndefined();
});

test("request sends JSON body and query", async () => {
  const f = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", f);
  await request("POST", "/api/x", { query: { a: "1", b: undefined }, body: { k: 1 } });
  const [url, init] = f.mock.calls[0]!;
  expect(url).toBe("/api/x?a=1");
  expect(init.method).toBe("POST");
  expect(init.body).toBe('{"k":1}');
});

test("request resolves undefined on empty 200 body", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("", { status: 200 })));
  expect(await request("GET", "/x")).toBeUndefined();
});

test("request rejects with internal ApiError on non-JSON 200 body", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("not json", { status: 200 })));
  const err = (await request("GET", "/x").catch((e: unknown) => e)) as ApiError;
  expect(err).toBeInstanceOf(ApiError);
  expect(err.code).toBe("internal");
});
