import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError, messageFor } from "../api/errors";
import { useGraph } from "../graph/store";
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
      <td className="num table__num">{job.attempts}</td>
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
    <table className="table table--inset">
      <thead>
        <tr>
          <th>{t("jobs.col.kind")}</th>
          <th>{t("jobs.col.target")}</th>
          <th>{t("jobs.col.status")}</th>
          <th className="table__num">{t("jobs.col.attempts")}</th>
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

const shortId = (id: string) => id.slice(0, 8);

/** Active jobs by their first batch, in first-seen order; batch-less jobs go last under `null`. */
function groupByBatch(jobs: JobDto[]): { batch: string | null; jobs: JobDto[] }[] {
  const map = new Map<string | null, JobDto[]>();
  for (const j of jobs) {
    const k = j.batches[0] ?? null;
    map.set(k, [...(map.get(k) ?? []), j]);
  }
  const groups = [...map].map(([batch, js]) => ({ batch, jobs: js }));
  return [...groups.filter((g) => g.batch !== null), ...groups.filter((g) => g.batch === null)];
}

/** Addresses count of an expansion batch, if its history step is still around. */
function batchAddresses(batch: string): number | undefined {
  const { _past, _future } = useGraph.getState();
  return [..._past, ..._future].find((e) => e.effect?.batch === batch)?.effect?.addresses.length;
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

  const cancelBatch = useMutation({
    mutationFn: (id: string) => api.cancelBatch(id),
    onError: (e) => toast(messageFor(e), "error"),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.jobs() }),
  });
  const cancelBackground = useMutation({
    mutationFn: () => api.cancelBackground(),
    onError: (e) => toast(messageFor(e), "error"),
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
          <button className="btn btn--compact" disabled={cancelBackground.isPending} onClick={() => cancelBackground.mutate()}>
            {t("jobs.cancelBackground")}
          </button>
          {(active.data ?? []).length === 0 && <p className="jobs__empty">{t("jobs.emptyActive")}</p>}
          {groupByBatch(active.data ?? []).map((g) => {
            const addrs = g.batch ? batchAddresses(g.batch) : undefined;
            const title = g.batch === null
              ? t("jobs.other")
              : addrs === undefined
                ? t("jobs.batch", { id: shortId(g.batch) })
                : t("jobs.batchAddrs", { id: shortId(g.batch), count: addrs });
            const batch = g.batch;
            return (
              <section key={batch ?? "other"} className="jobs__group" aria-label={title}>
                <div className="jobs__group-head">
                  <strong>{title}</strong>
                  <span className="num">{t("jobs.groupJobs", { count: g.jobs.length })}</span>
                  {batch !== null && (
                    <button className="btn btn--compact" disabled={cancelBatch.isPending} onClick={() => cancelBatch.mutate(batch)}>
                      {t("jobs.cancelBatch")}
                    </button>
                  )}
                </div>
                <Table
                  jobs={g.jobs}
                  empty=""
                  cancel={(id) => cancel.mutate(id)}
                  cancellingId={cancel.isPending ? cancel.variables : undefined}
                />
              </section>
            );
          })}
          <h3 className="popover__section">{t("jobs.recent")}</h3>
          <Table jobs={recent.data ?? []} empty={t("jobs.emptyRecent")} />
        </div>
      )}
    </div>
  );
}
