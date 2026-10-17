import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError, messageFor } from "../api/errors";
import { qk } from "../api/queryClient";
import type { JobDto } from "../api/generated/JobDto";
import { useT } from "../i18n";
import { kindName, statusName, targetText } from "./jobText";
import { toast } from "./Toasts";

const REFRESH_MS = 5000;
const ERR_MAX = 40;

function Row({ job, onCancel, cancelling }: { job: JobDto; onCancel?: () => void; cancelling?: boolean }) {
  const t = useT();
  const err = job.error;
  return (
    <tr>
      <td>{kindName(job.kind)}</td>
      <td>{targetText(job)}</td>
      <td>{statusName(job.status)}</td>
      <td className="num">{job.attempts}</td>
      <td className="jobs__err" title={err ?? undefined}>
        {err ? (err.length > ERR_MAX ? `${err.slice(0, ERR_MAX)}…` : err) : ""}
      </td>
      {onCancel && (
        <td>
          <button className="btn btn--compact" disabled={cancelling} onClick={onCancel}>
            {t("jobs.cancel")}
          </button>
        </td>
      )}
    </tr>
  );
}

function Table({
  jobs,
  empty,
  cancel,
  cancellingId,
}: {
  jobs: JobDto[];
  empty: string;
  cancel?: (id: number) => void;
  cancellingId?: number;
}) {
  const t = useT();
  if (jobs.length === 0) return <p className="jobs__empty">{empty}</p>;
  return (
    <table className="jobs__table">
      <thead>
        <tr>
          <th>{t("jobs.col.kind")}</th>
          <th>{t("jobs.col.target")}</th>
          <th>{t("jobs.col.status")}</th>
          <th>{t("jobs.col.attempts")}</th>
          <th>{t("jobs.col.error")}</th>
          {cancel && <th />}
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <Row key={j.id} job={j} cancelling={cancellingId === j.id} onCancel={cancel && (() => cancel(j.id))} />
        ))}
      </tbody>
    </table>
  );
}

export function JobsPopover({ activeCount }: { activeCount: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const active = useQuery({ queryKey: qk.jobs(), queryFn: api.jobs, refetchInterval: open ? REFRESH_MS : false });
  const recent = useQuery({
    queryKey: [...qk.jobs(), "recent"],
    queryFn: api.recentJobs,
    refetchInterval: open ? REFRESH_MS : false,
    enabled: open,
  });
  const cancel = useMutation({
    mutationFn: (id: number) => api.cancelJob(id),
    // 404: the job finished (or was cancelled) before the click reached the server.
    onError: (e) =>
      e instanceof ApiError && e.code === "not_found"
        ? toast(t("jobs.alreadyDone"), "info")
        : toast(messageFor(e), "error"),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.jobs() }),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="jobs" ref={root}>
      <button className="btn btn--ghost statusbar__jobs" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t("jobs.button", { count: activeCount })}
      </button>
      {open && (
        <div className="popover jobs__popover" role="dialog" aria-label={t("jobs.title")}>
          <h2 className="popover__title">{t("jobs.title")}</h2>
          <h3 className="popover__section">{t("jobs.active")}</h3>
          <Table
            jobs={active.data ?? []}
            empty={t("jobs.emptyActive")}
            cancel={(id) => cancel.mutate(id)}
            cancellingId={cancel.isPending ? cancel.variables : undefined}
          />
          <h3 className="popover__section">{t("jobs.recent")}</h3>
          <Table jobs={recent.data ?? []} empty={t("jobs.emptyRecent")} />
        </div>
      )}
    </div>
  );
}
