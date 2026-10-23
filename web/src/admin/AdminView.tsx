import { useConnectModal } from "@rainbow-me/rainbowkit";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { MeDto } from "../api/generated/MeDto";
import { useMe } from "../auth/useMe";
import { useT } from "../i18n";
import { formatCount, formatLocalTime, formatTime } from "../lib/format";
import { BrandLockup } from "../shell/Brand";
import { leaveAdmin } from "../shell/hashRoute";
import { SettingsMenu } from "../shell/SettingsMenu";
import {
  adminErrorText,
  adminModeEnded,
  checkAdminMode,
  enterAdminMode,
  exitAdminMode,
  isUserRejection,
  parseCalls,
  useAdminMode,
  useAdminOverview,
  useWalletAddress,
} from "./adminMode";
import { AuditLog } from "./AuditLog";
import { LocalDataPanel } from "./LocalDataPanel";
import { cancelAdminAction, confirmAdminAction, useActionConfirm, useAdminAction } from "./useAdminAction";
import { UsersTable } from "./UsersTable";
import { WhitelistPanel } from "./WhitelistPanel";

/** Largest delay setTimeout accepts. */
const MAX_TIMER = 2 ** 31 - 1;

/**
 * `#/admin`: the admin panel (spec §7) for configured admins; anyone else finds only "not found" here
 * (nothing names an admin page, and the admin API is never called for them).
 */
export function AdminPage() {
  const t = useT();
  const me = useMe();
  const admin = me?.is_admin === true;
  return (
    <div className="admin">
      <header className="topbar">
        <span className="topbar__logo">
          <BrandLockup />
        </span>
        {admin && <h1 className="admin__title">{t("admin.title")}</h1>}
        <span className="topbar__spacer" />
        {admin && <ModeStatus />}
        <button className="btn" onClick={leaveAdmin}>
          <ArrowLeft size={14} />
          {t("admin.back")}
        </button>
        <SettingsMenu />
      </header>
      <main className="admin__body">{me && admin ? <AdminView me={me} /> : <NotFound />}</main>
    </div>
  );
}

function NotFound() {
  const t = useT();
  return (
    <section className="admin__section admin__step">
      <h2 className="admin__heading">{t("error.notFound")}</h2>
      <p className="admin__note">{t("admin.notFound")}</p>
    </section>
  );
}

/** Admin mode's end time and the way out of it, in the header. */
function ModeStatus() {
  const t = useT();
  const status = useAdminMode((s) => s.status);
  const expiresAt = useAdminMode((s) => s.expiresAt);
  if (status !== "on" || !expiresAt) return null;
  return (
    <>
      <span className="chip" title={formatLocalTime(expiresAt)}>
        {t("admin.mode.until", { time: formatTime(expiresAt) })}
      </span>
      <button className="btn" onClick={() => void exitAdminMode()}>
        {t("admin.mode.exit")}
      </button>
    </>
  );
}

function AdminView({ me }: { me: MeDto }) {
  const t = useT();
  const status = useAdminMode((s) => s.status);
  const error = useAdminMode((s) => s.error);
  const expiresAt = useAdminMode((s) => s.expiresAt);
  useEffect(() => {
    void checkAdminMode();
  }, []);
  // Admin mode ends on time even when nothing is asked of the server.
  useEffect(() => {
    if (status !== "on" || !expiresAt) return;
    const id = setTimeout(adminModeEnded, Math.min(MAX_TIMER, Math.max(0, Date.parse(expiresAt) - Date.now())));
    return () => clearTimeout(id);
  }, [status, expiresAt]);

  if (status === "checking") return <p className="admin__note">{t("common.loading")}</p>;
  if (status === "error")
    return (
      <section className="admin__section admin__step">
        <p className="dialog__error" role="alert">
          {error}
        </p>
        <button className="btn" onClick={() => void checkAdminMode()}>
          {t("common.retry")}
        </button>
      </section>
    );
  if (status === "off") return <EnterStep address={me.address} />;
  return (
    <>
      <Overview />
      <LocalDataPanel />
      <WhitelistPanel />
      <UsersTable />
      <AuditLog />
      <ActionConfirmDialog />
    </>
  );
}

/** Admin mode is off: one wallet signature of the server's admin-mode message turns it on. */
function EnterStep({ address }: { address: string }) {
  const t = useT();
  const ended = useAdminMode((s) => s.ended);
  const wallet = useWalletAddress();
  const { openConnectModal } = useConnectModal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const walletOk = wallet !== undefined && wallet.toLowerCase() === address.toLowerCase();
  const enter = async () => {
    setBusy(true);
    setError(null);
    try {
      await enterAdminMode(address);
    } catch (e) {
      setError(isUserRejection(e) ? t("admin.notSigned") : adminErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin__section admin__step" aria-labelledby="admin-mode-title">
      <h2 id="admin-mode-title" className="admin__heading">
        {t("admin.mode.title")}
      </h2>
      {ended && <p className="admin__note admin__note--warn">{t("admin.mode.ended")}</p>}
      <p className="admin__note">{t("admin.mode.intro")}</p>
      {!walletOk && <p className="admin__note">{t("admin.error.wallet", { address })}</p>}
      {error && (
        <p className="dialog__error" role="alert">
          {error}
        </p>
      )}
      <div className="admin__row">
        {!walletOk && openConnectModal && (
          <button className="btn" onClick={openConnectModal}>
            {t("login.connect")}
          </button>
        )}
        <button className="btn btn--primary" disabled={!walletOk || busy} onClick={() => void enter()}>
          {t("admin.mode.enter")}
        </button>
      </div>
    </section>
  );
}

/** Open registration, the default quota and the server's usage today. */
function Overview() {
  const t = useT();
  const { data, error } = useAdminOverview();
  const { run, busy } = useAdminAction();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (data ? String(data.default_quota) : "");
  const calls = parseCalls(value);
  const canChange = data !== undefined && calls !== null && calls !== data.default_quota && !busy;
  const change = async (e: FormEvent) => {
    e.preventDefault();
    if (!canChange || calls === null) return;
    if (await run({ type: "SetDefaultQuota", calls })) setDraft(null);
  };
  return (
    <section className="admin__section" aria-labelledby="admin-overview">
      <h2 id="admin-overview" className="admin__heading">
        {t("admin.overview.title")}
      </h2>
      {error && !data && <p className="dialog__error">{adminErrorText(error)}</p>}
      {data && (
        <div className="admin__stats">
          <div className="admin__stat">
            <label className="switch">
              <input
                type="checkbox"
                role="switch"
                checked={data.open_registration}
                disabled={busy}
                onChange={() => void run({ type: "SetOpenRegistration", open: !data.open_registration })}
              />
              <span className="admin__stat-label">{t("admin.overview.openRegistration")}</span>
            </label>
            <p className="admin__note">{t("admin.overview.openRegistrationHint")}</p>
          </div>
          <form className="admin__stat" onSubmit={(e) => void change(e)}>
            <label className="admin__stat-label" htmlFor="admin-default-quota">
              {t("admin.overview.defaultQuota")}
            </label>
            <div className="admin__row">
              <input
                id="admin-default-quota"
                className="input input--compact num admin__quota-input"
                type="number"
                min={0}
                step={1}
                value={value}
                aria-invalid={calls === null}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button className="btn btn--compact" type="submit" disabled={!canChange} aria-label={t("admin.overview.changeDefault")}>
                {t("admin.change")}
              </button>
            </div>
            <p className="admin__note">{t("admin.overview.defaultQuotaHint")}</p>
          </form>
          <div className="admin__stat">
            <span className="admin__stat-label">{t("admin.overview.serverUsage")}</span>
            <span className="admin__stat-value num">
              {formatCount(data.server_used)} / {formatCount(data.server_limit)}
            </span>
            <p className="admin__note" title={formatLocalTime(data.reset_at)}>
              {t("admin.overview.resets", { time: formatTime(data.reset_at) })}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

/** The pending signed action: the server's exact message, signed only when the admin confirms. */
export function ActionConfirmDialog() {
  const t = useT();
  const cur = useActionConfirm((s) => s.current);
  const open = cur !== null;
  // On the document: while the wallet is asked, focus has left the (disabled) Sign button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelAdminAction();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (!cur) return null;
  const title = t("admin.confirm.title");
  const failed = cur.phase === "failed";
  return (
    <div className="dialog-backdrop">
      <div
        className="dialog admin-confirm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h3 className="dialog__title">{title}</h3>
        <p className="dialog__summary">{t("admin.confirm.hint")}</p>
        <pre className="admin-confirm__message">{cur.message}</pre>
        {cur.phase === "signing" && <p className="dialog__summary">{t("admin.confirm.signing")}</p>}
        {cur.phase === "submitting" && <p className="dialog__summary">{t("admin.confirm.submitting")}</p>}
        {cur.error && (
          <p className="dialog__error" role="alert">
            {cur.error}
          </p>
        )}
        <div className="dialog__actions">
          {failed ? (
            <button type="button" className="btn" autoFocus onClick={cancelAdminAction}>
              {t("admin.confirm.close")}
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={cur.phase === "submitting"} onClick={cancelAdminAction}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                autoFocus
                disabled={cur.phase !== "confirm"}
                onClick={() => void confirmAdminAction()}
              >
                {t("admin.confirm.sign")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
