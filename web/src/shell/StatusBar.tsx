import { useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { qk } from "../api/queryClient";
import { statusQuery } from "../api/statusQuery";
import { useT, type MsgKey } from "../i18n";
import { JobsPopover } from "./JobsPopover";
import { progressText } from "./jobText";
import { useJobProgress, useSseState } from "./statusStore";
import type { SseState } from "../api/sse";

const STATUS_POLL_MS = 10_000;

const SSE: Record<SseState, { dot: "pos" | "warn" | "neg"; label: MsgKey }> = {
  open: { dot: "pos", label: "status.live" },
  connecting: { dot: "warn", label: "status.connecting" },
  closed: { dot: "neg", label: "status.offline" },
};

export function StatusBar({ saveStatus }: { saveStatus?: string }) {
  const t = useT();
  const active = useJobProgress((s) => s.activeCount());
  const latest = useJobProgress((s) => (s.lastId === null ? undefined : s.byId[s.lastId]));
  const sse = SSE[useSseState((s) => s.state)];
  const status = useQuery({ ...statusQuery, refetchInterval: STATUS_POLL_MS });
  const jobs = useQuery({ queryKey: qk.jobs(), queryFn: api.jobs });

  const job = latest && jobs.data?.find((j) => j.id === latest.job_id);
  const progress = latest ? progressText(latest, job) : t("status.idle");
  const save = t("status.workspace", { status: saveStatus ?? t("ws.status.unsaved") });
  return (
    <footer className="statusbar">
      <span className="statusbar__item">
        <span className={`dot dot--${sse.dot}`} aria-hidden="true" />
        {t(sse.label)}
      </span>
      <JobsPopover activeCount={active} />
      <span className="statusbar__item statusbar__progress" title={progress}>{progress}</span>
      <span className="statusbar__item num">{t("status.queue", { count: status.data?.queue_len ?? 0 })}</span>
      <span className="statusbar__item statusbar__save" title={save}>{save}</span>
    </footer>
  );
}
