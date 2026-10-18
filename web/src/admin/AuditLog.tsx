import { useInfiniteQuery } from "@tanstack/react-query";
import { Fragment, useState, type FormEvent } from "react";
import { api, type AuditParams } from "../api/endpoints";
import type { AuditRowDto } from "../api/generated/AuditRowDto";
import { useT } from "../i18n";
import { download } from "../lib/download";
import { formatLocalTime, formatTime } from "../lib/format";
import { adminCall, adminErrorText, adminKeys } from "./adminMode";
import { useAdminAction } from "./useAdminAction";

/** Audit-log action names (crates/eg-server: auth, admin routes and actions, CLI imports). */
const ACTIONS = [
  "login",
  "logout",
  "admin_access",
  "audit_suppressed",
  "admin_mode_enter",
  "admin_mode_exit",
  "whitelist_add",
  "whitelist_remove",
  "set_open_registration",
  "set_default_quota",
  "set_user_quota",
  "revoke_sessions",
  "export_audit",
  "import_labels",
  "import_tokens",
];

interface Draft {
  actor: string;
  action: string;
  /** `datetime-local` values, read as UTC (the app shows UTC everywhere). */
  from: string;
  to: string;
}
const EMPTY: Draft = { actor: "", action: "", from: "", to: "" };

/** A `datetime-local` value as UTC, RFC 3339; undefined when empty or invalid. */
function utc(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(`${v}${v.length === 16 ? ":00" : ""}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function toParams(d: Draft): AuditParams {
  const p: AuditParams = {};
  if (d.actor.trim()) p.actor = d.actor.trim();
  if (d.action) p.action = d.action;
  const from = utc(d.from);
  const to = utc(d.to);
  if (from) p.from = from;
  if (to) p.to = to;
  return p;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** `ethergraph-audit-YYYYMMDD-HHMMSS.json` (UTC now). */
function exportName(now: Date): string {
  const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `ethergraph-audit-${d}-${t}.json`;
}

/** The audit log, newest first: filters, paging, and a signed export of a time range to a JSON file. */
export function AuditLog() {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [applied, setApplied] = useState<AuditParams>({});
  const [open, setOpen] = useState<number | null>(null);
  const { run, busy } = useAdminAction();
  const log = useInfiniteQuery({
    queryKey: adminKeys.audit(applied),
    queryFn: ({ pageParam }) => adminCall(api.adminAudit({ ...applied, ...(pageParam === undefined ? {} : { cursor: pageParam }) })),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = log.data?.pages.flatMap((p) => p.rows) ?? [];
  const apply = (e: FormEvent) => {
    e.preventDefault();
    setApplied(toParams(draft));
  };
  const exportLog = async () => {
    const from = applied.from ?? null;
    const to = applied.to ?? null;
    const r = await run({ type: "ExportAudit", from, to });
    if (!r?.rows) return;
    const now = new Date();
    const file = { exported_at: now.toISOString(), from, to, rows: r.rows };
    download(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }), exportName(now));
  };
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  return (
    <section className="admin__section" aria-labelledby="admin-audit">
      <h2 id="admin-audit" className="admin__heading">
        {t("admin.audit.title")}
      </h2>
      <form className="admin__filters" onSubmit={apply}>
        <label className="admin__field">
          <span>{t("admin.audit.actor")}</span>
          <input className="input input--compact num" spellCheck={false} placeholder="0x… / cli" value={draft.actor} onChange={set("actor")} />
        </label>
        <label className="admin__field">
          <span>{t("admin.audit.action")}</span>
          <select className="input input--compact" value={draft.action} onChange={set("action")}>
            <option value="">{t("admin.audit.allActions")}</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="admin__field">
          <span>{t("admin.audit.from")}</span>
          <input className="input input--compact num" type="datetime-local" value={draft.from} onChange={set("from")} />
        </label>
        <label className="admin__field">
          <span>{t("admin.audit.to")}</span>
          <input className="input input--compact num" type="datetime-local" value={draft.to} onChange={set("to")} />
        </label>
        <div className="admin__row admin__filters-actions">
          <button className="btn btn--compact btn--primary" type="submit">
            {t("admin.audit.apply")}
          </button>
          <button
            className="btn btn--compact"
            type="button"
            onClick={() => {
              setDraft(EMPTY);
              setApplied({});
            }}
          >
            {t("admin.audit.clear")}
          </button>
          <span className="topbar__spacer" />
          <button className="btn btn--compact" type="button" disabled={busy} onClick={() => void exportLog()}>
            {t("admin.audit.export")}
          </button>
        </div>
      </form>
      <p className="admin__note">{t("admin.audit.exportHint")}</p>
      {log.error && !log.data && <p className="dialog__error">{adminErrorText(log.error)}</p>}
      {log.data &&
        (rows.length === 0 ? (
          <p className="admin__note">{t("admin.audit.empty")}</p>
        ) : (
          <div className="admin__table">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("admin.audit.time")}</th>
                  <th>{t("admin.audit.actor")}</th>
                  <th>{t("admin.audit.action")}</th>
                  <th>{t("admin.audit.target")}</th>
                  <th>{t("admin.audit.outcome")}</th>
                  <th>{t("admin.audit.ip")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td className="num" title={formatLocalTime(r.at)}>
                        {formatTime(r.at)}
                      </td>
                      <td className="num">{r.actor}</td>
                      <td className="num">{r.action}</td>
                      <td className="num">{r.target ?? "—"}</td>
                      <td className={`admin__outcome admin__outcome--${r.outcome}`}>{r.outcome}</td>
                      <td className="num">{r.ip ?? "—"}</td>
                      <td className="table__num">
                        <button
                          className="btn btn--compact btn--ghost"
                          aria-expanded={open === r.id}
                          onClick={() => setOpen(open === r.id ? null : r.id)}
                        >
                          {t("admin.audit.details")}
                        </button>
                      </td>
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={7} className="admin__details">
                          <AuditDetails row={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {log.hasNextPage && (
        <button className="btn btn--compact admin__more" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          {t("admin.audit.more")}
        </button>
      )}
    </section>
  );
}

/** Everything else the row records: the change, the signed message and signature, the client. */
function AuditDetails({ row }: { row: AuditRowDto }) {
  const { before, after, message, signature, user_agent } = row;
  return <pre className="admin__json">{JSON.stringify({ before, after, message, signature, user_agent }, null, 2)}</pre>;
}
