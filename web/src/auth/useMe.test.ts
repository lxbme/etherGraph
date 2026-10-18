import { queryClient } from "../api/queryClient";
import { useJobProgress, useQuota, useSseState } from "../shell/statusStore";
import { login, logout, page, sessionEnded, useAuth } from "./useMe";

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
