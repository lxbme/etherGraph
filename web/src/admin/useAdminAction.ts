import { create } from "zustand";
import { api } from "../api/endpoints";
import type { AdminAction } from "../api/generated/AdminAction";
import type { AdminActionResultDto } from "../api/generated/AdminActionResultDto";
import { ApiError } from "../api/errors";
import { queryClient } from "../api/queryClient";
import { useAuth } from "../auth/useMe";
import { t } from "../i18n";
import { toast } from "../shell/Toasts";
import { adminCall, adminErrorText, adminKeys, isAdminModeGone, isUserRejection, signAs, useAdminMode } from "./adminMode";

/** The action waiting in the confirm dialog: the server's message for it, signed only on confirm. */
export interface PendingAction {
  /** This run of the dialog (late wallet answers for an earlier one are told apart by it). */
  id: number;
  action: AdminAction;
  nonce: string;
  /** The exact text the wallet signs, shown verbatim. */
  message: string;
  phase: "confirm" | "signing" | "submitting" | "failed";
  /** Why it failed (phase `failed`). */
  error: string | null;
}

interface ActionConfirmState {
  current: PendingAction | null;
  /** The nonce for an action is being requested. */
  requesting: boolean;
}

export const useActionConfirm = create<ActionConfirmState>(() => ({ current: null, requesting: false }));

let nextId = 1;

/** Settles the promise `runAdminAction` returned for the pending action. */
let settle: ((r: AdminActionResultDto | null) => void) | null = null;

function finish(r: AdminActionResultDto | null): void {
  const s = settle;
  settle = null;
  useActionConfirm.setState({ current: null, requesting: false });
  s?.(r);
}

function update(patch: Partial<PendingAction>): void {
  const cur = useActionConfirm.getState().current;
  if (cur) useActionConfirm.setState({ current: { ...cur, ...patch } });
}

// Admin mode ending closes the dialog: nothing more can be signed for it.
useAdminMode.subscribe((s, prev) => {
  if (s.status !== "on" && prev.status === "on") finish(null);
});

/**
 * Runs one signed admin action (spec §8): asks the server for the message describing `action`, shows it
 * in the confirm dialog (ActionConfirmDialog), and only on confirm signs it with the wallet and submits
 * it. Resolves with the server's result, or null when nothing was applied (cancelled, not signed,
 * refused, or admin mode over). One action at a time.
 */
export async function runAdminAction(action: AdminAction): Promise<AdminActionResultDto | null> {
  const st = useActionConfirm.getState();
  if (st.requesting || st.current) return null;
  useActionConfirm.setState({ requesting: true });
  let issued;
  try {
    issued = await adminCall(api.adminActionNonce(action));
  } catch (e) {
    useActionConfirm.setState({ requesting: false });
    if (!isAdminModeGone(e)) toast(adminErrorText(e), "error");
    return null;
  }
  return new Promise((resolve) => {
    settle = resolve;
    useActionConfirm.setState({
      requesting: false,
      current: { id: nextId++, action, nonce: issued.nonce, message: issued.message, phase: "confirm", error: null },
    });
  });
}

/**
 * Closes the confirm dialog without submitting: before signing, while the wallet is still asked (a
 * signature arriving later is dropped, see confirmAdminAction), or after a failure. The issued nonce is
 * never used. Not while the signed action is being submitted.
 */
export function cancelAdminAction(): void {
  const cur = useActionConfirm.getState().current;
  if (cur && cur.phase !== "submitting") finish(null);
}

/** Signs the pending action's message with the signed-in address's wallet and submits it. */
export async function confirmAdminAction(): Promise<void> {
  const cur = useActionConfirm.getState().current;
  const me = useAuth.getState().me;
  if (!cur || cur.phase !== "confirm" || !me) return;
  update({ phase: "signing" });
  /** Still this action's dialog: not cancelled, nor admin mode ended, while the wallet was asked. */
  const current = () => useActionConfirm.getState().current?.id === cur.id;
  let signature: string;
  try {
    signature = await signAs(me.address, cur.message);
  } catch (e) {
    if (!current()) return;
    if (isUserRejection(e)) {
      finish(null);
      toast(t("admin.notSigned"));
    } else update({ phase: "failed", error: adminErrorText(e) });
    return;
  }
  // A signature for a dialog that is gone is never submitted.
  if (!current()) return;
  update({ phase: "submitting" });
  try {
    const result = await adminCall(api.adminAction({ action: cur.action, nonce: cur.nonce, signature }));
    void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    toast(t("admin.applied"));
    finish(result);
  } catch (e) {
    if (isAdminModeGone(e)) return; // adminModeEnded closed the dialog
    // The values the message described are out of date: show the current ones.
    if (e instanceof ApiError && e.message === "stale_action") void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    update({ phase: "failed", error: adminErrorText(e) });
  }
}

/** A mutating admin control: `run(action)` goes through the signed confirm flow; `busy` while one is under way. */
export function useAdminAction(): { run: typeof runAdminAction; busy: boolean } {
  const busy = useActionConfirm((s) => s.requesting || s.current !== null);
  return { run: runAdminAction, busy };
}
