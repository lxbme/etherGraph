import type { Page } from "@playwright/test";
import { getAddress, verifyMessage, type Hex } from "viem";
import type { AdminAction } from "../src/api/generated/AdminAction";
import type { AdminActionRequestDto } from "../src/api/generated/AdminActionRequestDto";
import type { AdminUserDto } from "../src/api/generated/AdminUserDto";
import type { AuditRowDto } from "../src/api/generated/AuditRowDto";
import type { LoginDto } from "../src/api/generated/LoginDto";
import type { SiweFieldsDto } from "../src/api/generated/SiweFieldsDto";
import type { WhitelistEntryDto } from "../src/api/generated/WhitelistEntryDto";
import { FAKE_WALLET_NAME, installFakeWallet, type FakeWallet } from "./fakeWallet";
import { B, C, ME, expect, test, unauthorized, type MockApi } from "./mockApi";

const DEFAULT_QUOTA = 5000;

/** The backend's canonical EIP-4361 text (crates/eg-server/src/auth/siwe.rs), written out independently. */
const canonical = (f: SiweFieldsDto, checksummed: string) =>
  `${f.domain} wants you to sign in with your Ethereum account:\n${checksummed}\n\n${f.statement}\n\n` +
  `URI: ${f.uri}\nVersion: ${f.version}\nChain ID: ${f.chain_id}\nNonce: ${f.nonce}\n` +
  `Issued At: ${f.issued_at}\nExpiration Time: ${f.expiration_time}`;

const AUDIT: AuditRowDto[] = [
  {
    id: 2, at: "2026-10-19T09:00:00.000Z", actor: "cli", action: "import_labels", target: null, before: null,
    after: { count: 10 }, outcome: "ok", ip: null, user_agent: null, message: null, signature: null,
  },
  {
    id: 1, at: "2026-10-19T08:00:00.000Z", actor: B, action: "login", target: null, before: null,
    after: null, outcome: "ok", ip: "127.0.0.1", user_agent: "test", message: null, signature: null,
  },
];

/**
 * An admin backend for the fake wallet's address, like the real one: admin mode needs the exact
 * admin-mode message signed by the admin; each action's message is written here from the current
 * values and runs only with the same action, its nonce and the admin's signature of that message.
 */
function serveAdmin(mock: MockApi, wallet: FakeWallet) {
  const admin = wallet.address.toLowerCase();
  let adminMode = false;
  let issued: SiweFieldsDto | null = null;
  const whitelist: WhitelistEntryDto[] = [{ address: B, added_by: admin, added_at: "2026-10-02T07:00:00.000Z" }];
  const users: AdminUserDto[] = [
    { address: admin, is_admin: true, created_at: "2026-10-01T08:00:00.000Z", last_login_at: "2026-10-19T09:00:00.000Z", used_today: 10, quota_limit: DEFAULT_QUOTA, quota_override: null, waiting_jobs: 0 },
    { address: B, is_admin: false, created_at: "2026-10-02T08:00:00.000Z", last_login_at: null, used_today: 900, quota_limit: 1000, quota_override: 1000, waiting_jobs: 3 },
  ];
  const nonces = new Map<string, { action: AdminAction; message: string }>();
  const applied: AdminAction[] = [];
  let n = 0;

  const line = (a: AdminAction): string => {
    const show = (q: number | null) => (q === null ? `the default (${DEFAULT_QUOTA})` : String(q));
    switch (a.type) {
      case "WhitelistAdd":
        return `Add ${getAddress(a.address)} to the whitelist`;
      case "SetUserQuota":
        return `Set the daily quota of ${getAddress(a.address)} from ${show(users.find((u) => u.address === a.address)!.quota_override)} to ${show(a.calls)}`;
      case "ExportAudit":
        return `Export the audit log from ${a.from ?? "the beginning"} to ${a.to ?? "now"}`;
      default:
        throw new Error(`not served: ${a.type}`);
    }
  };
  const inMode = (reply: () => { json?: unknown; status?: number }) => () => (adminMode ? reply() : unauthorized("no_admin_session"));

  mock.on("GET /api/auth/me", () => ({ json: { ...ME, address: admin, is_admin: true } }));
  mock.on("GET /api/admin/session", inMode(() => ({ json: { address: admin, expires_at: "2099-01-01T00:00:00.000Z" } })));
  mock.on("GET /api/admin/session/nonce", () => {
    const at = new Date();
    issued = {
      domain: "localhost:4173", address: admin, statement: "Enter etherGraph admin mode", uri: "http://localhost:4173",
      version: "1", chain_id: 1, nonce: "adminmode0001", issued_at: at.toISOString(),
      expiration_time: new Date(at.getTime() + 5 * 60_000).toISOString(),
    };
    return { json: issued };
  });
  mock.on("POST /api/admin/session", async (req) => {
    const body = req.postDataJSON() as LoginDto;
    if (!issued || body.message !== canonical(issued, wallet.address)) return unauthorized("bad_message");
    if (!(await verifyMessage({ address: wallet.address, message: body.message, signature: body.signature as Hex }))) return unauthorized("bad_signature");
    issued = null;
    adminMode = true;
    return { json: { address: admin, expires_at: "2099-01-01T00:00:00.000Z" } };
  });
  mock.on("GET /api/admin/overview", inMode(() => ({ json: { open_registration: false, default_quota: DEFAULT_QUOTA, server_used: 1234, server_limit: 100000, reset_at: "2026-10-20T00:00:00.000Z" } })));
  mock.on("GET /api/admin/users", inMode(() => ({ json: users })));
  mock.on("GET /api/admin/whitelist", inMode(() => ({ json: whitelist })));
  mock.on("GET /api/admin/audit", inMode(() => ({ json: { rows: AUDIT, next_cursor: null } })));
  mock.on("POST /api/admin/actions/nonce", (req) => {
    if (!adminMode) return unauthorized("no_admin_session");
    const { action } = req.postDataJSON() as { action: AdminAction };
    const nonce = `action${++n}`;
    const header = `etherGraph admin action on ${new URL(req.url()).host}`;
    const message = `${header}\n${line(action)}\n\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
    nonces.set(nonce, { action, message });
    return { json: { nonce, message } };
  });
  mock.on("POST /api/admin/actions", async (req) => {
    if (!adminMode) return unauthorized("no_admin_session");
    const body = req.postDataJSON() as AdminActionRequestDto;
    const taken = nonces.get(body.nonce);
    nonces.delete(body.nonce);
    if (!taken) return unauthorized("bad_nonce");
    if (JSON.stringify(taken.action) !== JSON.stringify(body.action)) return unauthorized("payload_mismatch");
    if (!(await verifyMessage({ address: wallet.address, message: taken.message, signature: body.signature as Hex }))) return unauthorized("bad_signature");
    const a = body.action;
    applied.push(a);
    if (a.type === "WhitelistAdd") whitelist.push({ address: a.address, added_by: admin, added_at: "2026-10-19T10:00:00.000Z" });
    if (a.type === "SetUserQuota") {
      const u = users.find((x) => x.address === a.address)!;
      u.quota_override = a.calls;
      u.quota_limit = a.calls ?? DEFAULT_QUOTA;
    }
    return { json: { before: null, after: null, rows: a.type === "ExportAudit" ? AUDIT : null } };
  });
  return { applied };
}

/** Opens the admin page and enters admin mode: connect the wallet, sign the admin-mode message. */
async function enterAdminMode(page: Page, wallet: FakeWallet) {
  await page.goto("/?e2e=1#/admin");
  await expect(page.getByRole("heading", { name: "Admin mode" })).toBeVisible();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: FAKE_WALLET_NAME }).click();
  await page.getByRole("button", { name: "Enter admin mode" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  expect(wallet.signed).toHaveLength(1);
  expect(wallet.signed[0]).toContain("Enter etherGraph admin mode");
}

/** The confirm dialog's message (the server's text), then signs it in the wallet. */
async function signShown(page: Page, wallet: FakeWallet): Promise<string> {
  const dialog = page.getByRole("dialog", { name: "Sign this change" });
  const shown = (await dialog.locator("pre").textContent()) ?? "";
  const before = wallet.signed.length;
  await dialog.getByRole("button", { name: "Sign and apply" }).click();
  await expect(dialog).toHaveCount(0);
  expect(wallet.signed.slice(before)).toEqual([shown]);
  return shown;
}

test("an admin adds an address to the whitelist with a signed action", async ({ page, mock }) => {
  const wallet = await installFakeWallet(page);
  const server = serveAdmin(mock, wallet);
  await enterAdminMode(page, wallet);

  const whitelist = page.locator("section", { has: page.getByRole("heading", { name: "Whitelist" }) });
  await whitelist.getByRole("textbox", { name: "Address to add" }).fill(getAddress(C));
  await whitelist.getByRole("button", { name: "Add" }).click();
  const shown = await signShown(page, wallet);

  expect(shown).toMatch(
    new RegExp(`^etherGraph admin action on localhost:4173\\nAdd ${getAddress(C)} to the whitelist\\n\\nNonce: action1\\nIssued At: `),
  );
  expect(server.applied).toEqual([{ type: "WhitelistAdd", address: C }]);
  await expect(whitelist.getByRole("cell", { name: C, exact: true })).toBeVisible();
  expect(mock.unhandled).toEqual([]);
});

test("an admin changes a user's daily quota with a signed action", async ({ page, mock }) => {
  const wallet = await installFakeWallet(page);
  const server = serveAdmin(mock, wallet);
  await enterAdminMode(page, wallet);

  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: `End all sessions of ${B}` }) });
  await row.getByRole("button", { name: `Edit the daily quota of ${B}` }).click();
  await row.getByRole("spinbutton", { name: `Daily quota of ${B}` }).fill("2500");
  await row.getByRole("button", { name: "Save" }).click();
  const shown = await signShown(page, wallet);

  expect(shown.split("\n").slice(0, 2)).toEqual([
    "etherGraph admin action on localhost:4173",
    `Set the daily quota of ${getAddress(B)} from 1000 to 2500`,
  ]);
  expect(server.applied).toEqual([{ type: "SetUserQuota", address: B, calls: 2500 }]);
  await expect(row.getByText("2,500")).toBeVisible();
  expect(mock.unhandled).toEqual([]);
});

test("cancelling a signed action sends nothing", async ({ page, mock }) => {
  const wallet = await installFakeWallet(page);
  const server = serveAdmin(mock, wallet);
  await enterAdminMode(page, wallet);

  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: `End all sessions of ${B}` }) });
  await row.getByRole("button", { name: `Edit the daily quota of ${B}` }).click();
  await row.getByRole("spinbutton", { name: `Daily quota of ${B}` }).fill("10");
  await row.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog", { name: "Sign this change" }).getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(wallet.signed).toHaveLength(1); // the admin-mode message only
  expect(mock.count("POST /api/admin/actions")).toBe(0);
  expect(server.applied).toEqual([]);
});

test("an admin exports the audit log to a JSON file with a signed action", async ({ page, mock }) => {
  const wallet = await installFakeWallet(page);
  const server = serveAdmin(mock, wallet);
  await enterAdminMode(page, wallet);
  // The file's blob is revoked right after the click: catch it as it becomes the download URL.
  await page.evaluate(() => {
    const w = window as unknown as { __lastBlob?: Blob };
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource) => {
      w.__lastBlob = b as Blob;
      return create(b);
    };
  });

  const audit = page.locator("section", { has: page.getByRole("heading", { name: "Audit log" }) });
  await expect(audit.getByRole("cell", { name: "import_labels" })).toBeVisible();
  await audit.getByRole("button", { name: "Export to a file" }).click();
  const [dl, shown] = await Promise.all([page.waitForEvent("download"), signShown(page, wallet)]);

  expect(shown.split("\n").slice(0, 2)).toEqual([
    "etherGraph admin action on localhost:4173",
    "Export the audit log from the beginning to now",
  ]);
  expect(server.applied).toEqual([{ type: "ExportAudit", from: null, to: null }]);
  expect(dl.suggestedFilename()).toMatch(/^ethergraph-audit-\d{8}-\d{6}\.json$/);
  const file = await page.evaluate(async () => {
    const b = (window as unknown as { __lastBlob: Blob }).__lastBlob;
    return { type: b.type, text: await b.text() };
  });
  expect(file.type).toBe("application/json");
  expect(JSON.parse(file.text)).toMatchObject({ from: null, to: null, rows: AUDIT });
  expect(mock.unhandled).toEqual([]);
});

test("a user who is not an admin finds nothing at #/admin and no admin API is called", async ({ page, mock }) => {
  await page.goto("/?e2e=1#/admin");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  expect(mock.requests("GET /api/admin/session")).toHaveLength(0);
  await page.getByRole("button", { name: "Back to the graph" }).click();
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
});
