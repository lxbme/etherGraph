import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../api/endpoints";
import { qk } from "../api/queryClient";
import { useT } from "../i18n";
import { formatLocalTime, formatTime } from "../lib/format";
import { useJobProgress, useQuota, useSseState } from "./statusStore";

function Banner({ kind, title, children }: { kind: "warn" | "fatal"; title?: string; children: ReactNode }) {
  return (
    <div className={`banner banner--${kind}`} role="alert">
      <AlertTriangle className="banner__icon" size={16} />
      <span title={title}>{children}</span>
    </div>
  );
}

/**
 * The viewer's active jobs waiting for tomorrow's quota (the list is loaded only while `enabled`); a
 * job's latest progress event beats its listed status.
 */
function useWaitingJobs(enabled: boolean): number {
  const jobs = useQuery({ queryKey: qk.jobs(), queryFn: api.jobs, enabled }).data ?? [];
  const progress = useJobProgress((s) => s.byId);
  const status = new Map<number, string>(jobs.map((j) => [j.id, j.status]));
  for (const e of Object.values(progress)) status.set(e.job_id, e.status);
  return [...status.values()].filter((s) => s === "paused_user_quota").length;
}

export function Banners() {
  const t = useT();
  // Hidden during the very first connect; afterwards stays up through closed → connecting retry cycles.
  const sseDown = useSseState((s) => s.state !== "open" && (s.firstConnectDone || s.state === "closed"));
  const { quota, degraded } = useQuota();
  const waiting = useWaitingJobs(!!quota?.paused && !quota.server_paused);
  return (
    <div className="banners">
      {degraded === "invalid_key" && <Banner kind="fatal">{t("banner.invalidKey")}</Banner>}
      {sseDown && <Banner kind="warn">{t("banner.sseDown")}</Banner>}
      {quota?.paused && (
        <Banner kind="warn" title={formatLocalTime(quota.reset_at)}>
          {quota.server_paused
            ? t("banner.quotaPaused", { time: formatTime(quota.reset_at) })
            : waiting > 0
              ? t("banner.userQuotaPaused", { time: formatTime(quota.reset_at), count: waiting })
              : t("banner.userQuotaPausedIdle", { time: formatTime(quota.reset_at) })}
        </Banner>
      )}
    </div>
  );
}
