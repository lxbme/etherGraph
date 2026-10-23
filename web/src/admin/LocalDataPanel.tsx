import { skipToken, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/endpoints";
import type { LocalSourceDto } from "../api/generated/LocalSourceDto";
import { qk, queryClient } from "../api/queryClient";
import type { LocalDataProgress } from "../api/useEvents";
import { useT, type MsgKey } from "../i18n";
import { formatCount, formatLocalTime, formatShortTime, formatTime } from "../lib/format";
import { toast } from "../shell/Toasts";
import { adminCall, adminErrorText, isAdminModeGone } from "./adminMode";
import { useAdminAction } from "./useAdminAction";

/**
 * Column widths, mockup C's with 2% moved from source to actions (so "Download and import" fits at the
 * table's min width): source, local version, imported, rows, upstream, actions.
 */
const WIDTHS = ["24%", "13%", "15%", "11%", "21%", "16%"];

/** Each source's category and source name (a dictionary key, or a proper noun shown as is). */
const SOURCES: Record<string, { category: MsgKey; name: MsgKey | { noun: string } }> = {
  eth_labels: { category: "admin.data.cat.labels", name: { noun: "eth-labels" } },
  tokens_uniswap: { category: "admin.data.cat.tokens", name: "admin.data.src.uniswap" },
  tokens_coingecko: { category: "admin.data.cat.tokens", name: { noun: "CoinGecko" } },
  tokens_eth_labels: { category: "admin.data.cat.tokens", name: { noun: "eth-labels" } },
  signatures_sourcify: { category: "admin.data.cat.signatures", name: { noun: "Sourcify" } },
};

/** The source whose row count enables the signature-guess switch. */
const SIGNATURES = "signatures_sourcify";

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB"];

/** `570 MB`, `1.4 MB`, `10 B`: decimal units, one decimal below 10. */
function formatBytes(n: number): string {
  let v = n;
  let u = 0;
  while (v >= 1000 && u < BYTE_UNITS.length - 1) {
    v /= 1000;
    u++;
  }
  return `${u === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${BYTE_UNITS[u]}`;
}

/** The admin page's local datasets against their upstreams; updates, cancels and the signature switch are signed actions. */
export function LocalDataPanel() {
  const t = useT();
  const { data, error, isPending } = useQuery({ queryKey: qk.localData(), queryFn: () => adminCall(api.adminLocalData()) });
  const progress = useQuery<Record<string, LocalDataProgress>>({ queryKey: qk.localDataProgress(), queryFn: skipToken }).data;
  const { run, busy } = useAdminAction();
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      queryClient.setQueryData(qk.localData(), await adminCall(api.adminLocalDataCheck()));
    } catch (e) {
      if (!isAdminModeGone(e)) toast(adminErrorText(e), "error");
    } finally {
      setChecking(false);
    }
  };
  const signatureRows = data?.sources.find((s) => s.source === SIGNATURES)?.rows ?? 0;
  const noSignatures = signatureRows === 0;
  return (
    <section className="admin__section" aria-labelledby="admin-local-data">
      <div className="local-data__head">
        <h2 id="admin-local-data" className="admin__heading">
          {t("admin.data.title")}
        </h2>
        {data?.checked_at && (
          <span className="admin__note" title={formatLocalTime(data.checked_at)}>
            {t("admin.data.checked", { time: formatTime(data.checked_at) })}
          </span>
        )}
        <button className="btn btn--compact local-data__check" disabled={checking} onClick={() => void check()}>
          {t("admin.data.check")}
        </button>
      </div>
      {isPending && <p className="admin__note">{t("common.loading")}</p>}
      {error && !data && <p className="dialog__error">{adminErrorText(error)}</p>}
      {data && (
        <>
          <div className="admin__table">
            <table className="table local-data">
              <colgroup>
                {WIDTHS.map((w, i) => (
                  <col key={i} style={{ width: w }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th>{t("admin.data.col.source")}</th>
                  <th>{t("admin.data.col.version")}</th>
                  <th className="table__num">{t("admin.data.col.imported")}</th>
                  <th className="table__num">{t("admin.data.col.rows")}</th>
                  <th>{t("admin.data.col.upstream")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <SourceRows
                    key={s.source}
                    source={s}
                    running={data.running}
                    progress={progress?.[s.source]}
                    busy={busy}
                    onUpdate={() => void run({ type: "UpdateLocalData", source: s.source })}
                    onCancel={() => void run({ type: "CancelLocalData", source: s.source })}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="local-data__switch">
            <label className="switch">
              <input
                type="checkbox"
                role="switch"
                checked={data.signatures_enabled}
                disabled={busy || (noSignatures && !data.signatures_enabled)}
                onChange={() => void run({ type: "SetSignatureGuess", enabled: !data.signatures_enabled })}
              />
              <span>{t("admin.data.guess")}</span>
            </label>
            {noSignatures && <span className="admin__note">{t("admin.data.guessNeedsSignatures")}</span>}
          </div>
        </>
      )}
    </section>
  );
}

interface SourceRowsProps {
  source: LocalSourceDto;
  /** The source of the running update, if any. */
  running: string | null;
  /** This source's latest progress event while it runs. */
  progress: LocalDataProgress | undefined;
  /** A signed action is under way. */
  busy: boolean;
  onUpdate(): void;
  onCancel(): void;
}

/** One source's row, and under it a detail row while it runs or after it failed. */
function SourceRows({ source: s, running, progress, busy, onUpdate, onCancel }: SourceRowsProps) {
  const t = useT();
  const names = SOURCES[s.source];
  const isRunning = running === s.source;
  const otherRunning = running !== null && !isRunning;
  const failed = !isRunning && s.state === "failed";
  const notImported = s.upstream.status === "not_imported" || (s.imported_at === null && !s.rows);
  const label = t(isRunning ? "admin.data.cancel" : failed ? "admin.data.retry" : notImported ? "admin.data.downloadImport" : "admin.data.update");
  const version = s.partial ? t("admin.data.partial", { done: s.partial.done, total: s.partial.total }) : s.version;
  const tag = upstreamTag(s, isRunning, failed);
  return (
    <>
      <tr className={isRunning || failed ? "local-data__row--open" : undefined}>
        <td>
          <span className="local-data__category">{names ? t(names.category) : s.source}</span>
          {names && <span className="local-data__name">{typeof names.name === "string" ? t(names.name) : names.name.noun}</span>}
        </td>
        <td className={version ? "num" : "num admin__muted"} title={version ?? undefined}>
          {version ?? "—"}
        </td>
        <td className={s.imported_at ? "table__num num" : "table__num num admin__muted"} title={s.imported_at ? `${formatTime(s.imported_at)}\n${formatLocalTime(s.imported_at)}` : undefined}>
          {s.imported_at ? formatShortTime(s.imported_at) : "—"}
        </td>
        <td className={s.rows === null ? "table__num num admin__muted" : "table__num num"}>{s.rows === null ? "—" : formatCount(s.rows)}</td>
        <td>
          <span className={tag.className} title={tag.title}>
            {t(tag.key, tag.params)}
          </span>
        </td>
        <td className="table__num">
          <button
            className={notImported && !isRunning && !failed ? "btn btn--compact btn--primary local-data__action" : "btn btn--compact local-data__action"}
            disabled={busy || otherRunning}
            title={otherRunning ? t("admin.data.busy") : undefined}
            onClick={isRunning ? onCancel : onUpdate}
          >
            {label}
          </button>
        </td>
      </tr>
      {isRunning && (
        <tr className="local-data__detail">
          <td colSpan={WIDTHS.length}>
            <Progress progress={progress} upstreamVersion={s.upstream.version} />
          </td>
        </tr>
      )}
      {failed && (
        <tr className="local-data__detail">
          <td colSpan={WIDTHS.length}>
            <span className="local-data__error">
              {s.error_at ? `${formatTime(s.error_at)} ` : ""}
              {s.error === "interrupted" ? t("admin.data.interrupted") : s.error}
            </span>
            <span className="admin__muted"> · {t("admin.data.unchanged")}</span>
          </td>
        </tr>
      )}
    </>
  );
}

/** The upstream column's tag: the row's own state first, then what the upstream check found. */
function upstreamTag(
  s: LocalSourceDto,
  running: boolean,
  failed: boolean,
): { className: string; key: MsgKey; params?: Record<string, string | number>; title?: string } {
  if (running) return { className: "tag", key: "admin.data.up.running" };
  if (failed) return { className: "tag tag--neg", key: "admin.data.up.failed" };
  const up = s.upstream;
  switch (up.status) {
    case "up_to_date":
      return { className: "tag tag--ok", key: "admin.data.up.upToDate", title: up.version ?? undefined };
    case "update":
      return { className: "tag tag--warn", key: "admin.data.up.update", title: up.version ?? undefined };
    case "not_imported":
      return {
        className: "tag tag--neutral",
        key: "admin.data.up.notImported",
        params: { files: up.files ?? 1, size: up.bytes === null ? "—" : formatBytes(up.bytes) },
      };
    case "unchecked":
      return { className: "tag tag--neutral", key: "admin.data.up.unchecked", title: up.error ?? undefined };
  }
}

/**
 * A running update's phase, a bar, and the bytes (download) or rows (import) so far. The bar follows the
 * files done when the update has several (Sourcify), else the bytes.
 */
function Progress({ progress: p, upstreamVersion }: { progress: LocalDataProgress | undefined; upstreamVersion: string | null }) {
  const t = useT();
  const phase = t(p?.phase === "import" ? "admin.data.phase.import" : "admin.data.phase.download");
  const text = [phase, upstreamVersion, p?.files_total != null ? `${p.files_done ?? 0}/${p.files_total}` : null].filter(Boolean).join(" · ");
  const fraction = p?.files_total ? (p.files_done ?? 0) / p.files_total : p?.total_bytes ? p.bytes / p.total_bytes : null;
  const pct = fraction === null ? null : Math.min(100, Math.round(fraction * 100));
  const count = !p
    ? ""
    : p.phase === "import"
      ? t("admin.data.rows", { n: formatCount(p.rows) })
      : p.total_bytes
        ? `${formatBytes(p.bytes)} / ${formatBytes(p.total_bytes)}`
        : formatBytes(p.bytes);
  return (
    <div className="local-data__progress">
      <span>{text}</span>
      <div
        className="local-data__bar"
        role="progressbar"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <span className="local-data__fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
      <span className="num">{count}</span>
    </div>
  );
}
