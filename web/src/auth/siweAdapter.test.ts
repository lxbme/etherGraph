// @ts-expect-error node builtins are untyped here (no @types/node); the module exists at runtime.
import { readFileSync } from "node:fs";
import type { SiweFieldsDto } from "../api/generated/SiweFieldsDto";
import { createSiweAdapter, siweMessage } from "./siweAdapter";
import { useAuth } from "./useMe";

// One source of truth for D1: the same cases the Rust `canonical_message` test reads (vitest runs from web/).
const CASES = JSON.parse(readFileSync("../crates/eg-server/tests/data/siwe_canonical.json", "utf8") as string) as {
  fields: SiweFieldsDto;
  address: string;
  expected: string;
}[];

const ADDR = "0xa0cf798816d4b9b9866b5330eea46a18382f251e";
const fields = (nonce: string): SiweFieldsDto => ({
  domain: "127.0.0.1:8080",
  address: ADDR,
  statement: "Sign in to etherGraph",
  uri: "http://127.0.0.1:8080",
  version: "1",
  chain_id: 1,
  nonce,
  issued_at: "2026-10-19T12:00:00.000Z",
  expiration_time: "2026-10-19T12:05:00.000Z",
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const me = { address: ADDR, is_admin: false, quota: { used: 0, limit: 5000, reset_at: "2026-10-20T00:00:00Z" } };

beforeEach(() => useAuth.setState({ status: "unauthenticated", me: null, reason: null }));
afterEach(() => vi.unstubAllGlobals());

describe("siweMessage", () => {
  it("finds the shared fixture", () => expect(CASES.length).toBeGreaterThanOrEqual(3));

  it.each(CASES.map((c, i) => [i, c] as const))("case %i equals the server's canonical text", (_i, c) => {
    expect(siweMessage(c.fields, c.address)).toBe(c.expected);
  });
});

describe("createSiweAdapter", () => {
  it("asks for a nonce for the connected address and signs the server's exact fields", async () => {
    const f = vi.fn().mockResolvedValue(json(200, fields("3f1c2a9b8e7d6c5b4a39281706f5e4d3")));
    vi.stubGlobal("fetch", f);
    const adapter = createSiweAdapter(() => ADDR);
    const nonce = await adapter.getNonce();
    expect(nonce).toBe("3f1c2a9b8e7d6c5b4a39281706f5e4d3");
    expect(f.mock.calls[0]![0]).toBe(`/api/auth/nonce?address=${ADDR}`);
    const message = await adapter.createMessage({ nonce, address: ADDR, chainId: 1 });
    expect(message).toBe(CASES[0]!.expected);
  });

  it("refuses to build a message for a nonce it did not receive", async () => {
    const adapter = createSiweAdapter(() => ADDR);
    expect(() => adapter.createMessage({ nonce: "ffffffffffffffff", address: ADDR, chainId: 1 })).toThrow();
  });

  it("verify posts the message and signature and signs the user in", async () => {
    const f = vi.fn().mockResolvedValue(json(200, me));
    vi.stubGlobal("fetch", f);
    const ok = await createSiweAdapter(() => ADDR).verify({ message: "msg", signature: "0xsig" });
    expect(ok).toBe(true);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ message: "msg", signature: "0xsig" });
    expect(useAuth.getState()).toMatchObject({ status: "authenticated", me, reason: null });
  });

  it.each([
    [json(401, { error: { code: "unauthorized", message: "not_whitelisted" } }), "not_whitelisted"],
    [json(401, { error: { code: "unauthorized", message: "bad_signature" } }), "failed"],
    [json(429, { error: { code: "rate_limited", message: "too many requests" } }), "rate_limited"],
  ])("a refused login keeps the user out and records why (%#)", async (res, reason) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    const ok = await createSiweAdapter(() => ADDR).verify({ message: "msg", signature: "0xsig" });
    expect(ok).toBe(false);
    expect(useAuth.getState()).toMatchObject({ status: "unauthenticated", me: null, reason });
  });

  it("a rate-limited nonce request records the reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(429, { error: { code: "rate_limited", message: "x" } })));
    await expect(createSiweAdapter(() => ADDR).getNonce()).rejects.toThrow();
    expect(useAuth.getState().reason).toBe("rate_limited");
  });
});
