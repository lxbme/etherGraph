import type { Page } from "@playwright/test";
import { verifyMessage, type Hex } from "viem";
import type { LoginDto } from "../src/api/generated/LoginDto";
import type { MeDto } from "../src/api/generated/MeDto";
import type { SiweFieldsDto } from "../src/api/generated/SiweFieldsDto";
import { FAKE_WALLET_NAME, installFakeWallet, type FakeWallet, type FakeWalletHooks } from "./fakeWallet";
import { ME, expect, test, unauthorized, type MockApi } from "./mockApi";

const NONCE = "5f0c9e2a7b1d4c3e8a6f2b9d0c7e1a4b";

/** The server's fields for a login message (what `GET /api/auth/nonce` answers). */
function fieldsFor(address: string): SiweFieldsDto {
  const issued = new Date();
  return {
    domain: "localhost:4173",
    address: address.toLowerCase(),
    statement: "Sign in to etherGraph",
    uri: "http://localhost:4173",
    version: "1",
    chain_id: 1,
    nonce: NONCE,
    issued_at: issued.toISOString(),
    expiration_time: new Date(issued.getTime() + 5 * 60_000).toISOString(),
  };
}

/** The backend's canonical text (crates/eg-server/src/auth/siwe.rs `canonical_message`), written out independently. */
const canonical = (f: SiweFieldsDto, checksummed: string) =>
  `${f.domain} wants you to sign in with your Ethereum account:\n${checksummed}\n\n${f.statement}\n\n` +
  `URI: ${f.uri}\nVersion: ${f.version}\nChain ID: ${f.chain_id}\nNonce: ${f.nonce}\n` +
  `Issued At: ${f.issued_at}\nExpiration Time: ${f.expiration_time}`;

/**
 * A backend without a session for this page: the nonce and login routes behave like the real ones
 * (exact message, valid signature from the claimed address); `refuse` makes login answer that 401 reason.
 */
function serveLogin(mock: MockApi, wallet: FakeWallet, opts: { refuse?: string } = {}): { endSession(): void } {
  let session: MeDto | null = null;
  let issued: SiweFieldsDto | null = null;
  mock.on("GET /api/auth/me", () => (session ? { json: session } : unauthorized("no_session")));
  mock.on("GET /api/auth/nonce", (_req, url) => {
    issued = fieldsFor(url.searchParams.get("address") ?? "");
    return { json: issued };
  });
  mock.on("POST /api/auth/login", async (req) => {
    const body = req.postDataJSON() as LoginDto;
    if (!issued || body.message !== canonical(issued, wallet.address)) return unauthorized("bad_message");
    const ok = await verifyMessage({ address: wallet.address, message: body.message, signature: body.signature as Hex });
    if (!ok) return unauthorized("bad_signature");
    if (opts.refuse) return unauthorized(opts.refuse);
    session = { ...ME, address: wallet.address.toLowerCase() };
    return { json: session };
  });
  return { endSession: () => void (session = null) };
}

/** Every request the page makes, from before the first navigation. */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  page.on("websocket", (ws) => urls.push(ws.url()));
  return urls;
}

/** Requests that left this machine (anything but the app's own origin; inline data is not a request). */
const offHost = (urls: string[]) =>
  urls.filter((u) => {
    const url = new URL(u);
    if (url.protocol === "data:" || url.protocol === "blob:") return false;
    return !["localhost", "127.0.0.1"].includes(url.hostname);
  });

async function signIn(page: Page) {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: FAKE_WALLET_NAME }).click();
  await page.getByRole("button", { name: "Sign message" }).click();
}

test("a fresh page signs in with the wallet and never contacts a third party", async ({ page, mock }) => {
  const wallet = await installFakeWallet(page);
  serveLogin(mock, wallet);
  const urls = recordRequests(page);
  await page.goto("/?e2e=1");

  await expect(page.getByRole("heading", { name: "etherGraph" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search" })).toHaveCount(0);
  await signIn(page);

  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toHaveCount(0);
  const short = `${wallet.address.toLowerCase().slice(0, 6)}…${wallet.address.toLowerCase().slice(-4)}`;
  await expect(page.locator(".topbar__account")).toHaveText(short);
  expect(wallet.signed).toHaveLength(1);
  expect(mock.requests("GET /api/auth/nonce")[0]!.url()).toContain(`address=${wallet.address}`);
  expect(mock.count("POST /api/auth/login")).toBe(1);
  expect(urls.length).toBeGreaterThan(0);
  expect(offHost(urls)).toEqual([]);
  expect(mock.unhandled).toEqual([]);
});

test("an address that is not whitelisted is told so and stays on the login page", async ({ page, mock }) => {
  const wallet = await installFakeWallet(page);
  serveLogin(mock, wallet, { refuse: "not_whitelisted" });
  await page.goto("/?e2e=1");
  await signIn(page);

  await expect(page.getByRole("alert")).toHaveText("This address is not on the whitelist yet. Ask an administrator for access.");
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search" })).toHaveCount(0);
  expect(mock.unhandled).toEqual([]);
});

test("logging out ends the session and returns to the login page", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  mock.on("GET /api/auth/me", () => unauthorized("no_session"));
  await page.getByRole("button", { name: "Log out" }).click();

  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  expect(mock.count("POST /api/auth/logout")).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a session that dies while the event stream is open returns to the login page and stops reconnecting", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  await expect.poll(() => mock.count("GET /api/events")).toBe(1);
  // The server revoked the session: every route answers 401, and it ends the open stream.
  mock.on("GET /api/auth/me", () => unauthorized("no_session"));
  mock.on("GET /api/status", () => unauthorized("no_session"));
  mock.on("GET /api/jobs", () => unauthorized("no_session"));
  await mock.pushEvents([]);

  await expect(page.getByRole("alert")).toHaveText("Your session has ended. Sign in again.");
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await page.waitForTimeout(2500);
  expect(mock.count("GET /api/events")).toBe(1);
});

/** Base (8453): a chain the app does not configure. */
const BASE = "0x2105";
const walletCalls = (page: Page) => page.evaluate(() => (window as unknown as FakeWalletHooks).__egFakeWallet.calls);
const walletChain = (page: Page, chainId: string) =>
  page.evaluate((id) => (window as unknown as FakeWalletHooks).__egFakeWallet.setChain(id), chainId);

test("a wallet on another chain is switched to mainnet when connecting, then signs in", async ({ page, mock }) => {
  const wallet = await installFakeWallet(page, { chainId: BASE });
  serveLogin(mock, wallet);
  await page.goto("/?e2e=1");
  await signIn(page);
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  expect(await walletCalls(page)).toContain("wallet_switchEthereumChain");
  expect(wallet.signed).toHaveLength(1);
});

test("a wallet still connected on another chain after a reload signs in again", async ({ page, mock }) => {
  const wallet = await installFakeWallet(page);
  const server = serveLogin(mock, wallet);
  await page.goto("/?e2e=1");
  await signIn(page);
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  // The user moves the wallet to Base; the session expires; the page is reloaded and the wallet reconnects there.
  await walletChain(page, BASE);
  server.endSession();
  await page.reload();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();

  await signIn(page);
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  expect(wallet.signed).toHaveLength(2);
});

test("an ended session disconnects the wallet, so signing in again starts from choosing it", async ({ page, mock }) => {
  const wallet = await installFakeWallet(page);
  const server = serveLogin(mock, wallet);
  await page.goto("/?e2e=1");
  await signIn(page);
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  await walletChain(page, BASE);
  server.endSession();
  mock.on("GET /api/status", () => unauthorized("no_session"));
  mock.on("GET /api/jobs", () => unauthorized("no_session"));
  await mock.pushEvents([]);
  await expect(page.getByRole("alert")).toHaveText("Your session has ended. Sign in again.");
  await expect.poll(() => walletCalls(page)).toContain("wallet_revokePermissions");

  await signIn(page);
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
});

test("a 401 that is not about the session (an admin route, a bad origin) keeps the user signed in", async ({ page, mock }) => {
  mock.on("GET /api/jobs", () => unauthorized("no_admin_session"));
  await page.goto("/?e2e=1");
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  await expect.poll(() => mock.count("GET /api/jobs")).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toHaveCount(0);
});
