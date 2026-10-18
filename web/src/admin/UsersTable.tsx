import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api/endpoints";
import type { AdminUserDto } from "../api/generated/AdminUserDto";
import { useT } from "../i18n";
import { formatCount, formatLocalTime, formatTime } from "../lib/format";
import { adminCall, adminErrorText, adminKeys, parseCalls, useAdminOverview } from "./adminMode";
import { useAdminAction } from "./useAdminAction";

/** Every user with usage figures only (never what they looked up); quota and session controls are signed actions. */
export function UsersTable() {
  const t = useT();
  const users = useQuery({ queryKey: adminKeys.users, queryFn: () => adminCall(api.adminUsers()) });
  /** The address whose quota is being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section className="admin__section" aria-labelledby="admin-users">
      <h2 id="admin-users" className="admin__heading">
        {t("admin.users.title")}
      </h2>
      <p className="admin__note">{t("admin.users.hint")}</p>
      {users.error && !users.data && <p className="dialog__error">{adminErrorText(users.error)}</p>}
      {users.data &&
        (users.data.length === 0 ? (
          <p className="admin__note">{t("admin.users.empty")}</p>
        ) : (
          <div className="admin__table">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("admin.col.address")}</th>
                  <th>{t("admin.users.registered")}</th>
                  <th>{t("admin.users.lastLogin")}</th>
                  <th className="table__num">{t("admin.users.usedToday")}</th>
                  <th className="table__num">{t("admin.users.quota")}</th>
                  <th className="table__num">{t("admin.users.waiting")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <UserRow
                    key={u.address}
                    user={u}
                    editing={editing === u.address}
                    onEdit={(on) => setEditing(on ? u.address : null)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

function UserRow({ user: u, editing, onEdit }: { user: AdminUserDto; editing: boolean; onEdit(on: boolean): void }) {
  const t = useT();
  const { run, busy } = useAdminAction();
  const [draft, setDraft] = useState(String(u.quota_limit));
  const calls = parseCalls(draft);
  // What saving would replace: the user's own quota, or the default they are on (saving that value would
  // only pin an own quota equal to it).
  const current = u.quota_override ?? useAdminOverview().data?.default_quota ?? u.quota_limit;
  const canSave = calls !== null && calls !== current && !busy;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || calls === null) return;
    if (await run({ type: "SetUserQuota", address: u.address, calls })) onEdit(false);
  };
  return (
    <tr>
      <td>
        <span className="num">{u.address}</span>
        {u.is_admin && <span className="admin__tag">{t("admin.users.admin")}</span>}
      </td>
      <td className="num" title={formatLocalTime(u.created_at)}>
        {formatTime(u.created_at)}
      </td>
      <td className="num" title={u.last_login_at ? formatLocalTime(u.last_login_at) : undefined}>
        {u.last_login_at ? formatTime(u.last_login_at) : "—"}
      </td>
      <td className="table__num num">{formatCount(u.used_today)}</td>
      <td className="table__num">
        {editing ? (
          <form className="admin__row admin__row--end" onSubmit={(e) => void save(e)}>
            <input
              className="input input--compact num admin__quota-input"
              type="number"
              min={0}
              step={1}
              autoFocus
              aria-label={t("admin.users.quotaOf", { address: u.address })}
              aria-invalid={calls === null}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className="btn btn--compact btn--primary" type="submit" disabled={!canSave}>
              {t("admin.save")}
            </button>
            <button className="btn btn--compact" type="button" onClick={() => onEdit(false)}>
              {t("common.cancel")}
            </button>
          </form>
        ) : (
          <>
            <span className="num">{formatCount(u.quota_limit)}</span>{" "}
            <span className="admin__muted">{t(u.quota_override === null ? "admin.users.default" : "admin.users.own")}</span>
          </>
        )}
      </td>
      <td className="table__num num">{formatCount(u.waiting_jobs)}</td>
      <td className="table__num">
        <div className="admin__row admin__row--end">
          {!editing && (
            <button
              className="btn btn--compact"
              disabled={busy}
              aria-label={t("admin.users.editLabel", { address: u.address })}
              onClick={() => {
                setDraft(String(u.quota_limit));
                onEdit(true);
              }}
            >
              {t("admin.users.edit")}
            </button>
          )}
          {u.quota_override !== null && (
            <button
              className="btn btn--compact"
              disabled={busy}
              aria-label={t("admin.users.useDefaultLabel", { address: u.address })}
              onClick={() => void run({ type: "SetUserQuota", address: u.address, calls: null })}
            >
              {t("admin.users.useDefault")}
            </button>
          )}
          <button
            className="btn btn--compact"
            disabled={busy}
            aria-label={t("admin.users.revokeLabel", { address: u.address })}
            onClick={() => void run({ type: "RevokeSessions", address: u.address })}
          >
            {t("admin.users.revoke")}
          </button>
        </div>
      </td>
    </tr>
  );
}
