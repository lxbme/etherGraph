import { vi } from "vitest";
import type { AdminAction } from "../api/generated/AdminAction";
import type { AdminOverviewDto } from "../api/generated/AdminOverviewDto";
import type { AdminUserDto } from "../api/generated/AdminUserDto";
import type { AuditPageDto } from "../api/generated/AuditPageDto";
import type { AuditRowDto } from "../api/generated/AuditRowDto";
import type { MeDto } from "../api/generated/MeDto";
import type { WhitelistEntryDto } from "../api/generated/WhitelistEntryDto";

/** The signed-in admin (lower case, as the server sends it) and the wallet's checksummed form of it. */
export const ADMIN = "0xa0cf798816d4b9b9866b5330eea46a18382f251e";
export const ADMIN_CHECKSUMMED = "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e";
export const USER = "0xb0b0000000000000000000000000000000000002";

export const adminMe = (is_admin = true): MeDto => ({
  address: ADMIN,
  is_admin,
  quota: { used: 0, limit: 5000, reset_at: "2026-10-20T00:00:00Z" },
});

export const OVERVIEW: AdminOverviewDto = {
  open_registration: false,
  default_quota: 5000,
  server_used: 1234,
  server_limit: 100000,
  reset_at: "2026-10-20T00:00:00.000Z",
};

export const USERS: AdminUserDto[] = [
  {
    address: ADMIN,
    is_admin: true,
    created_at: "2026-10-01T08:00:00.000Z",
    last_login_at: "2026-10-19T09:00:00.000Z",
    used_today: 10,
    quota_limit: 5000,
    quota_override: null,
    waiting_jobs: 0,
  },
  {
    address: USER,
    is_admin: false,
    created_at: "2026-10-02T08:00:00.000Z",
    last_login_at: null,
    used_today: 900,
    quota_limit: 1000,
    quota_override: 1000,
    waiting_jobs: 3,
  },
];

export const WHITELIST: WhitelistEntryDto[] = [
  { address: USER, added_by: ADMIN, added_at: "2026-10-02T07:00:00.000Z" },
];

export const auditRow = (id: number, extra: Partial<AuditRowDto> = {}): AuditRowDto => ({
  id,
  at: "2026-10-19T10:00:00.000Z",
  actor: ADMIN,
  action: "whitelist_add",
  target: USER,
  before: null,
  after: { whitelisted: true },
  outcome: "ok",
  ip: "127.0.0.1",
  user_agent: "test",
  message: "Add 0xB0b0… to the whitelist",
  signature: "0xsig",
  ...extra,
});

/** The server's message for an action: the app and origin, a line, then Nonce and Issued At (crates/eg-server/src/auth/actions.rs). */
export const actionMessage = (line: string, nonce = "n1") =>
  `etherGraph admin action on 127.0.0.1:8080\n${line}\n\nNonce: ${nonce}\nIssued At: 2026-10-19T10:00:00.000Z`;

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const refused = (reason: string, status = 401) =>
  json(status, { error: { code: status === 404 ? "not_found" : "unauthorized", message: reason } });

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
type Route = (call: Call) => Response | Promise<Response>;

/**
 * Stubs `fetch` with an admin backend in admin mode: `METHOD /path` routes, overridable per test. The
 * action nonce answers `actionMessage("Server line for <type>")`. Every request is recorded in `calls`.
 */
export function stubAdminApi(overrides: Record<string, Route> = {}) {
  const calls: Call[] = [];
  const routes: Record<string, Route> = {
    "GET /api/auth/me": () => json(200, adminMe()),
    "GET /api/admin/session": () => json(200, { address: ADMIN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
    "GET /api/admin/overview": () => json(200, OVERVIEW),
    "GET /api/admin/users": () => json(200, USERS),
    "GET /api/admin/whitelist": () => json(200, WHITELIST),
    "GET /api/admin/audit": () => json(200, { rows: [auditRow(2), auditRow(1, { action: "login", target: null })], next_cursor: null } satisfies AuditPageDto),
    "POST /api/admin/actions/nonce": (c) =>
      json(200, { nonce: "n1", message: actionMessage(`Server line for ${(c.body as { action: AdminAction }).action.type}`) }),
    "POST /api/admin/actions": () => json(200, { before: null, after: null, rows: null }),
    ...overrides,
  };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) throw new TypeError(`no route for ${call.method} ${call.path}`);
    return route(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    /** The bodies of `POST /api/admin/actions` (the submitted, signed actions). */
    submitted: () => calls.filter((c) => c.method === "POST" && c.path === "/api/admin/actions").map((c) => c.body),
    route: (key: string, r: Route) => void (routes[key] = r),
  };
}
