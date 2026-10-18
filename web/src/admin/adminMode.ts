import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getAccount, signMessage, watchAccount } from "wagmi/actions";
import { create } from "zustand";
import { api } from "../api/endpoints";
import { ApiError, messageFor } from "../api/errors";
import { queryClient } from "../api/queryClient";
import { siweMessage } from "../auth/siweAdapter";
import { wagmiConfig } from "../auth/wagmi";
import { t, type MsgKey } from "../i18n";
import { toast } from "../shell/Toasts";

/**
 * Admin mode (spec §8): a separate signature on top of the login session, an hour long. `checking` until
 * the server has answered, `error` when it could not be asked.
 */
export type AdminModeStatus = "checking" | "off" | "on" | "error";

interface AdminModeState {
  status: AdminModeStatus;
  /** When admin mode ends (status `on`). */
  expiresAt: string | null;
  /** Admin mode was on and has ended (expired, or the server stopped accepting it). */
  ended: boolean;
  /** Why the server could not be asked (status `error`). */
  error: string | null;
}

export const useAdminMode = create<AdminModeState>(() => ({ status: "checking", expiresAt: null, ended: false, error: null }));

/** The 401 reason of a missing or expired admin mode (crates/eg-server/src/auth/extract.rs). */
export const ADMIN_MODE_GONE = "no_admin_session";

export function isAdminModeGone(e: unknown): boolean {
  return e instanceof ApiError && e.code === "unauthorized" && e.message === ADMIN_MODE_GONE;
}

/** Query keys of the admin reads, all under `["admin"]`. */
export const adminKeys = {
  all: ["admin"] as const,
  overview: ["admin", "overview"] as const,
  users: ["admin", "users"] as const,
  whitelist: ["admin", "whitelist"] as const,
  audit: (filter: unknown) => ["admin", "audit", filter] as const,
};

/** Admin mode is over: back to the enter step, with nothing of the admin reads left cached. */
export function adminModeEnded(): void {
  const wasOn = useAdminMode.getState().status === "on";
  useAdminMode.setState({ status: "off", expiresAt: null, ended: wasOn || useAdminMode.getState().ended, error: null });
  queryClient.removeQueries({ queryKey: adminKeys.all });
}

/** Awaits an admin API call; a 401 `no_admin_session` ends admin mode here before it is rethrown. */
export async function adminCall<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (isAdminModeGone(e)) adminModeEnded();
    throw e;
  }
}

/** Asks the server whether admin mode is on for this login session. */
export async function checkAdminMode(): Promise<void> {
  // What was known before (another visit, an earlier login session) may be out of date.
  useAdminMode.setState({ status: "checking", error: null });
  try {
    const s = await api.adminSession();
    useAdminMode.setState({ status: "on", expiresAt: s.expires_at, ended: false, error: null });
  } catch (e) {
    if (isAdminModeGone(e)) useAdminMode.setState({ status: "off", expiresAt: null, error: null });
    else useAdminMode.setState({ status: "error", expiresAt: null, error: messageFor(e) });
  }
}

/** Signs the server's admin-mode message with the wallet of `address` and enters admin mode. */
export async function enterAdminMode(address: string): Promise<void> {
  const fields = await api.adminSessionNonce();
  const message = siweMessage(fields, address);
  const signature = await signAs(address, message);
  const s = await api.adminEnter({ message, signature });
  queryClient.removeQueries({ queryKey: adminKeys.all });
  useAdminMode.setState({ status: "on", expiresAt: s.expires_at, ended: false, error: null });
}

/**
 * Leaves admin mode on the server (the login session stays). When the server could not end it, says so
 * and shows what the server reports instead of pretending it is off.
 */
export async function exitAdminMode(): Promise<void> {
  try {
    await api.adminExit();
  } catch (e) {
    toast(adminErrorText(e), "error");
    await checkAdminMode();
    return;
  }
  useAdminMode.setState({ status: "off", expiresAt: null, ended: false, error: null });
  queryClient.removeQueries({ queryKey: adminKeys.all });
}

/** The connected wallet is not the signed-in address (or none is connected): it cannot sign for it. */
export class WalletMismatch extends Error {
  constructor(readonly address: string) {
    super("the connected wallet is not the signed-in address");
    this.name = "WalletMismatch";
  }
}

/** The wallet's signature of `message` (EIP-191), from the account of `address` only. */
export async function signAs(address: string, message: string): Promise<string> {
  const connected = getAccount(wagmiConfig).address;
  if (!connected || connected.toLowerCase() !== address.toLowerCase()) throw new WalletMismatch(address);
  return signMessage(wagmiConfig, { message, account: connected });
}

/** The user declined in the wallet (EIP-1193 code 4001), anywhere in the error's cause chain. */
export function isUserRejection(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === "object" && depth < 10; depth++) {
    const err = cur as { name?: unknown; code?: unknown; cause?: unknown };
    if (err.code === 4001 || err.name === "UserRejectedRequestError") return true;
    cur = err.cause;
  }
  return false;
}

/** 401 reasons of a refused admin-mode entry or action (crates/eg-server/src/routes/admin.rs). */
const REFUSALS: Record<string, MsgKey> = {
  stale_action: "admin.error.stale",
  bad_signature: "admin.error.badSignature",
  bad_nonce: "admin.error.badNonce",
  bad_message: "admin.error.badMessage",
  payload_mismatch: "admin.error.mismatch",
};

/** What to tell the admin about a failed admin-mode entry or action. */
export function adminErrorText(e: unknown): string {
  if (e instanceof WalletMismatch) return t("admin.error.wallet", { address: e.address });
  if (e instanceof ApiError && e.code === "unauthorized") {
    const key = REFUSALS[e.message];
    return key ? t(key) : t("admin.error.refused", { reason: e.message });
  }
  if (e instanceof ApiError) return messageFor(e);
  return t("admin.error.signFailed", { reason: e instanceof Error ? e.message : String(e) });
}

/** The connected wallet's address (undefined when none is connected), kept current. */
export function useWalletAddress(): string | undefined {
  return useSyncExternalStore(
    (onChange) => watchAccount(wagmiConfig, { onChange }),
    () => getAccount(wagmiConfig).address,
  );
}

export const useAdminOverview = () => useQuery({ queryKey: adminKeys.overview, queryFn: () => adminCall(api.adminOverview()) });

/** Largest quota the server stores (i32). */
const MAX_CALLS = 2 ** 31 - 1;

/** A whole number of Etherscan calls a day, or null when `s` is not one. */
export function parseCalls(s: string): number | null {
  if (!/^\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return n <= MAX_CALLS ? n : null;
}
