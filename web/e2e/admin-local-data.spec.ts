import type { Locator, Page } from "@playwright/test";
import { verifyMessage, type Hex } from "viem";
import type { AdminAction } from "../src/api/generated/AdminAction";
import type { AdminActionRequestDto } from "../src/api/generated/AdminActionRequestDto";
import type { LocalDataDto } from "../src/api/generated/LocalDataDto";
import type { LocalSourceDto } from "../src/api/generated/LocalSourceDto";
import type { LoginDto } from "../src/api/generated/LoginDto";
import type { SiweFieldsDto } from "../src/api/generated/SiweFieldsDto";
import { FAKE_WALLET_NAME, installFakeWallet, type FakeWallet } from "./fakeWallet";
import { ME, expect, fixtures, test, unauthorized, type MockApi } from "./mockApi";

const GECKO = "tokens_coingecko";

/** The backend's canonical EIP-4361 text (crates/eg-server/src/auth/siwe.rs), written out independently. */
const canonical = (f: SiweFieldsDto, checksummed: string) =>
  `${f.domain} wants you to sign in with your Ethereum account:\n${checksummed}\n\n${f.statement}\n\n` +
  `URI: ${f.uri}\nVersion: ${f.version}\nChain ID: ${f.chain_id}\nNonce: ${f.nonce}\n` +
  `Issued At: ${f.issued_at}\nExpiration Time: ${f.expiration_time}`;

/**
 * An admin backend for the fake wallet's address: admin mode needs the admin-mode message signed by the
 * admin; a local-data action runs only with its nonce and the admin's signature of its message. The
 * local datasets start as the fixture's with CoinGecko's upstream not checked yet.
 */
function serveAdmin(mock: MockApi, wallet: FakeWallet) {
  const admin = wallet.address.toLowerCase();
  let adminMode = false;
  let issued: SiweFieldsDto | null = null;
  let data: LocalDataDto = {
    ...fixtures.localData,
    checked_at: null,
    sources: fixtures.localData.sources.map((s) =>
      s.source === GECKO ? { ...s, upstream: { ...s.upstream, status: "unchecked", version: null } } : s,
    ),
  };
  const patch = (source: string, over: Partial<LocalSourceDto>, running: string | null) => {
    data = { ...data, running, sources: data.sources.map((s) => (s.source === source ? { ...s, ...over } : s)) };
  };
  const nonces = new Map<string, { action: AdminAction; message: string }>();
  const applied: AdminAction[] = [];
  let n = 0;
  const line = (a: AdminAction): string => {
    if (a.type === "UpdateLocalData") return `Update local dataset ${a.source}`;
    if (a.type === "CancelLocalData") return `Cancel the update of local dataset ${a.source}`;
    throw new Error(`not served: ${a.type}`);
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
  mock.on("GET /api/admin/overview", inMode(() => ({ json: { open_registration: false, default_quota: 5000, server_used: 0, server_limit: 100000, reset_at: "2026-10-24T00:00:00.000Z" } })));
  mock.on("GET /api/admin/users", inMode(() => ({ json: [] })));
  mock.on("GET /api/admin/whitelist", inMode(() => ({ json: [] })));
  mock.on("GET /api/admin/audit", inMode(() => ({ json: { rows: [], next_cursor: null } })));
  mock.on("GET /api/admin/local-data", inMode(() => ({ json: data })));
  mock.on(
    "POST /api/admin/local-data/check",
    inMode(() => {
      data = { ...data, checked_at: "2026-10-23T10:00:00.000Z" };
      patch(GECKO, { upstream: { status: "update", version: "1612.0.0", files: null, bytes: null, error: null } }, data.running);
      return { json: data };
    }),
  );
  mock.on("POST /api/admin/actions/nonce", (req) => {
    if (!adminMode) return unauthorized("no_admin_session");
    const { action } = req.postDataJSON() as { action: AdminAction };
    const nonce = `action${++n}`;
    const message = `etherGraph admin action on ${new URL(req.url()).host}\n${line(action)}\n\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
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
    applied.push(body.action);
    if (body.action.type === "UpdateLocalData") patch(body.action.source, { state: "running" }, body.action.source);
    return { json: { before: null, after: null, rows: null } };
  });
  return {
    applied,
    /** The running update finished: the new version is imported and current. */
    finish(source: string, over: Partial<LocalSourceDto>) {
      patch(source, { state: "idle", ...over }, null);
    },
  };
}

/** Opens the admin page and enters admin mode: connect the wallet, sign the admin-mode message. */
async function enterAdminMode(page: Page) {
  await page.goto("/?e2e=1#/admin");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: FAKE_WALLET_NAME }).click();
  await page.getByRole("button", { name: "Enter admin mode" }).click();
  await expect(page.getByRole("heading", { name: "Local data" })).toBeVisible();
}

/** A source's row: its first cell holds the category and the source name. */
const sourceRow = (section: Locator, category: string, name: string) =>
  section.getByRole("row").filter({ has: section.page().getByRole("cell", { name: `${category}${name}`, exact: true }) });

test("an admin checks for updates, updates CoinGecko with one signed click and watches it finish", async ({ page, mock }) => {
  const wallet = await installFakeWallet(page);
  const server = serveAdmin(mock, wallet);
  await enterAdminMode(page);
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Local data" }) });
  const gecko = sourceRow(section, "Token lists", "CoinGecko");
  await expect(gecko.getByText("Not checked")).toBeVisible();

  // 1. Check for updates: the upstream now has a newer list.
  await section.getByRole("button", { name: "Check for updates" }).click();
  await expect(section.getByText("Upstream checked 2026-10-23 10:00:00 UTC")).toBeVisible();
  await expect(gecko.getByText("Update available")).toBeVisible();

  // Alignment (mockup C): fixed columns, versions mono and left, times and counts right with tabular figures.
  const cells = gecko.getByRole("cell");
  const style = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  expect(await style(section.locator("table"), "table-layout")).toBe("fixed");
  expect(["left", "start"]).toContain(await style(cells.nth(1), "text-align"));
  expect(await style(cells.nth(1), "font-family")).toContain("IBM Plex Mono");
  for (const i of [2, 3]) {
    expect(await style(cells.nth(i), "text-align")).toBe("right");
    expect(await style(cells.nth(i), "font-variant-numeric")).toBe("tabular-nums");
  }
  expect(await style(cells.nth(5), "text-align")).toBe("right");
  // Action buttons: one width, right edges in line.
  const boxes = await section.locator(".local-data__action").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
  expect(boxes).toHaveLength(5);
  for (const b of boxes) {
    expect(b.width).toBeCloseTo(boxes[0]!.width, 0);
    expect(b.right).toBeCloseTo(boxes[0]!.right, 0);
  }

  // 2. Update CoinGecko and sign.
  await gecko.getByRole("button", { name: "Update" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign this change" });
  await expect(dialog.locator("pre")).toContainText(`Update local dataset ${GECKO}`);
  await dialog.getByRole("button", { name: "Sign and apply" }).click();
  await expect(dialog).toHaveCount(0);
  expect(server.applied).toEqual([{ type: "UpdateLocalData", source: GECKO }]);
  await expect(gecko.getByText("Importing")).toBeVisible();
  await expect(gecko.getByRole("button", { name: "Cancel" })).toBeEnabled();
  const uniswapUpdate = sourceRow(section, "Token lists", "Uniswap default").getByRole("button", { name: "Update" });
  await expect(uniswapUpdate).toBeDisabled();
  await expect(uniswapUpdate).toHaveAttribute("title", "Another dataset is updating");

  // 3. The server reports progress, then the end.
  await mock.pushEvents([
    { type: "LocalDataProgress", source: GECKO, phase: "download", bytes: 1_400_000, total_bytes: 3_500_000, rows: 0, files_done: null, files_total: null },
    { type: "LocalDataProgress", source: GECKO, phase: "import", bytes: 3_500_000, total_bytes: 3_500_000, rows: 2240, files_done: null, files_total: null },
  ]);
  const detail = section.locator(".local-data__detail");
  await expect(detail.getByText("Importing · 1612.0.0")).toBeVisible();
  await expect(detail.getByText("2,240")).toBeVisible();
  await expect(detail.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  // The detail row starts at the first column's text.
  const textX = (await gecko.locator(".local-data__category").boundingBox())!.x;
  expect((await detail.locator(".local-data__progress").boundingBox())!.x).toBeCloseTo(textX, 0);

  server.finish(GECKO, {
    version: "1612.0.0",
    rows: 6071,
    imported_at: "2026-10-23T10:01:00.000Z",
    upstream: { status: "up_to_date", version: "1612.0.0", files: null, bytes: null, error: null },
  });
  await mock.pushEvents([{ type: "LocalDataDone", source: GECKO, outcome: "succeeded", error: null }]);

  // 4. Back to up to date, with the new version and count.
  await expect(gecko.getByText("Up to date")).toBeVisible();
  await expect(gecko.getByRole("cell", { name: "1612.0.0", exact: true })).toBeVisible();
  await expect(gecko.getByRole("cell", { name: "6,071", exact: true })).toBeVisible();
  await expect(detail).toHaveCount(0);
  await expect(uniswapUpdate).toBeEnabled();
  expect(mock.unhandled).toEqual([]);
});
