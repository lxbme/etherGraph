import { queryClient } from "../api/queryClient";
import { useJobProgress, useQuota, useSseState } from "../shell/statusStore";
import { checkSession, login, logout, page, sessionEnded, useAuth } from "./useMe";

const A = "0xa0cf798816d4b9b9866b5330eea46a18382f251e";
const B = "0xb0b0000000000000000000000000000000000002";
const me = (address: string) => ({ address, is_admin: false, quota: { used: 0, limit: 5000, reset_at: "2026-10-20T00:00:00Z" } });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("an ended session leaves nothing behind: cached responses and the per-user status stores", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json(200, me(A))));
  await login("m", "0x1");
  queryClient.setQueryData(["labels", A], [1]);
  useQuota.setState({ quota: { used: 5, limit: 10, paused: false, server_paused: false, reset_at: "x" } });
  useJobProgress.getState().upsert({ type: "JobProgress", job_id: 1, kind: "sync_address", fetched: 0, cursor_block: null, status: "running", error: null });
  useSseState.getState().set("closed");

  sessionEnded("session_ended");
  expect(useAuth.getState()).toMatchObject({ status: "unauthenticated", me: null, reason: "session_ended" });
  expect(queryClient.getQueryData(["labels", A])).toBeUndefined();
  expect(useQuota.getState().quota).toBeNull();
  expect(useJobProgress.getState().byId).toEqual({});
  expect(useSseState.getState()).toMatchObject({ state: "connecting", firstConnectDone: false });
});

test("the same address signs back in on this page; another address gets a fresh page", async () => {
  const restart = vi.spyOn(page, "restart").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json(200, me(A))));
  await login("m", "0x1");
  expect(useAuth.getState().status).toBe("authenticated");
  sessionEnded("session_ended");
  expect(await login("m", "0x1")).toBe(true);
  expect(restart).not.toHaveBeenCalled();
  expect(useAuth.getState().status).toBe("authenticated");

  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(null, { status: 204 })));
  await logout();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json(200, me(B))));
  await login("m", "0x1");
  expect(restart).toHaveBeenCalledTimes(1);
  expect(useAuth.getState().me).toBeNull();
});

test("logout is a no-op without a session", async () => {
  const f = vi.fn();
  vi.stubGlobal("fetch", f);
  useAuth.setState({ status: "unauthenticated", me: null, reason: null });
  await logout();
  expect(f).not.toHaveBeenCalled();
});

describe("checkSession", () => {
  const unauthorized = (reason: string) => async () => json(401, { error: { code: "unauthorized", message: reason } });
  beforeEach(() => useAuth.setState({ status: "authenticated", me: me(A), reason: null }));

  test("the same user: alive, nothing changes", async () => {
    const restart = vi.spyOn(page, "restart").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json(200, me(A))));
    await expect(checkSession()).resolves.toBe(true);
    expect(restart).not.toHaveBeenCalled();
    expect(useAuth.getState().status).toBe("authenticated");
  });

  test("another tab signed in as someone else: this tab drops its state and restarts as them", async () => {
    const restart = vi.spyOn(page, "restart").mockImplementation(() => {});
    queryClient.setQueryData(["labels", A], [1]);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json(200, me(B))));
    await expect(checkSession()).resolves.toBe(false);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(useAuth.getState().me).toBeNull();
    expect(queryClient.getQueryData(["labels", A])).toBeUndefined();
  });

  test("no session: dead, back to the login page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(unauthorized("no_session")));
    await expect(checkSession()).resolves.toBe(false);
    expect(useAuth.getState()).toMatchObject({ status: "unauthenticated", reason: "session_ended" });
  });

  test("offline: still alive", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(checkSession()).resolves.toBe(true);
    expect(useAuth.getState().status).toBe("authenticated");
  });
});

test("a 401 that is not no_session leaves the session alone", async () => {
  useAuth.setState({ status: "authenticated", me: me(A), reason: null });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json(401, { error: { code: "unauthorized", message: "no_admin_session" } })));
  await import("../api/endpoints").then(({ api }) => api.status().catch(() => {}));
  expect(useAuth.getState().status).toBe("authenticated");
});
