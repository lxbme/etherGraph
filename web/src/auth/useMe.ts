import { disconnect } from "wagmi/actions";
import { create } from "zustand";
import { setUnauthorizedHandler } from "../api/client";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { MeDto } from "../api/generated/MeDto";
import { queryClient } from "../api/queryClient";
import { useJobProgress, useQuota, useSseState } from "../shell/statusStore";
import { wagmiConfig } from "./wagmi";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

/** Why the login page is shown (null: a plain first visit or a logout). */
export type LoginReason = "not_whitelisted" | "rate_limited" | "failed" | "session_ended" | "network";

interface AuthState {
  status: AuthStatus;
  /** The signed-in user (null unless authenticated). */
  me: MeDto | null;
  reason: LoginReason | null;
}

export const useAuth = create<AuthState>(() => ({ status: "loading", me: null, reason: null }));

/** The signed-in user, or null. */
export const useMe = (): MeDto | null => useAuth((s) => s.me);

/** The address of the last session this page had: another address signing in starts from a fresh page. */
let pageUser: string | null = null;

/** Replaceable in tests (jsdom cannot navigate). */
export const page = {
  /** Reloads without the hash route, dropping everything the previous user had open. */
  restart: () => window.location.replace(window.location.pathname + window.location.search),
};

/** The per-user status stores (quota, job progress, event stream) back to their initial state. */
function resetStatusStores(): void {
  useQuota.setState({ quota: null, degraded: null });
  useJobProgress.setState({ byId: {}, lastId: null });
  useSseState.setState({ state: "connecting", firstConnectDone: false });
}

/** Nothing of the ended session stays: cached responses and the per-user status stores. */
function dropSessionData(): void {
  queryClient.clear();
  resetStatusStores();
}

function signedIn(me: MeDto): void {
  // The canvas, tabs and workspace of the previous user live in memory: a different user gets a
  // fresh page instead (the same user keeps what was open when the session expired).
  if (pageUser !== null && pageUser !== me.address) {
    page.restart();
    return;
  }
  pageUser = me.address;
  // Again at the start: the old shell's teardown (and late responses) wrote into them after the end.
  resetStatusStores();
  useAuth.setState({ status: "authenticated", me, reason: null });
}

/** Drops the wallet connection, so the next sign-in starts from choosing a wallet. */
function disconnectWallet(): void {
  void disconnect(wagmiConfig).catch(() => {});
}

/**
 * The session is gone (any 401, logout): back to the login page with nothing of the previous
 * session's data left in the query cache.
 */
export function sessionEnded(reason: LoginReason | null = null): void {
  const cur = useAuth.getState();
  // Only a live session can end: a 401 on the first load is a plain visit, and a reason set by a
  // refused attempt stays.
  useAuth.setState({ status: "unauthenticated", me: null, reason: cur.status === "authenticated" ? reason : cur.reason });
  dropSessionData();
}

setUnauthorizedHandler(() => sessionEnded("session_ended"));

/** Asks the server who is signed in (on page load). */
export async function loadMe(): Promise<void> {
  try {
    signedIn(await api.me());
  } catch (e) {
    // A 401 already went through the unauthorized handler.
    if (e instanceof ApiError && e.code === "unauthorized") return;
    useAuth.setState({ status: "unauthenticated", me: null, reason: e instanceof ApiError && e.code === "network" ? "network" : "failed" });
  }
}

/** Records why a sign-in attempt failed and drops the wallet connection (a nonce is good for one try). */
export function loginFailed(e: unknown): void {
  const reason: LoginReason =
    e instanceof ApiError && e.code === "unauthorized" && e.message === "not_whitelisted"
      ? "not_whitelisted"
      : e instanceof ApiError && e.code === "rate_limited"
        ? "rate_limited"
        : e instanceof ApiError && e.code === "network"
          ? "network"
          : "failed";
  useAuth.setState({ status: "unauthenticated", me: null, reason });
  disconnectWallet();
}

/** Submits a signed login message; true once the session exists. */
export async function login(message: string, signature: string): Promise<boolean> {
  try {
    signedIn(await api.login({ message, signature }));
    return true;
  } catch (e) {
    loginFailed(e);
    return false;
  }
}

/** Ends the session on the server and returns to the login page; a no-op when not signed in. */
export async function logout(): Promise<void> {
  if (useAuth.getState().status !== "authenticated") return;
  useAuth.setState({ status: "unauthenticated", me: null, reason: null });
  dropSessionData();
  try {
    await api.logout();
  } catch {
    // The session is dropped locally either way; a server that cannot be reached expires it.
  }
  disconnectWallet();
}
