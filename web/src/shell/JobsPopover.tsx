import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import { qk } from "../api/queryClient";
import type { JobDto } from "../api/generated/JobDto";
import { KIND_NAMES, STATUS_NAMES, targetText } from "./jobText";
import { toast } from "./Toasts";

const REFRESH_MS = 5000;
const ERR_MAX = 40;

function Row({ job, onCancel, cancelling }: { job: JobDto; onCancel?: () => void; cancelling?: boolean }) {
  const err = job.error;
  return (
    <tr>
      <td>{KIND_NAMES[job.kind] ?? job.kind}</td>
      <td>{targetText(job)}</td>
      <td>{STATUS_NAMES[job.status] ?? job.status}</td>
      <td>{job.attempts}</td>
      <td className="jobs__err" title={err ?? undefined}>
        {err ? (err.length > ERR_MAX ? `${err.slice(0, ERR_MAX)}…` : err) : ""}
      </td>
      {onCancel && (
        <td>
          <button className="btn" disabled={cancelling} onClick={onCancel}>
            取消
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
  if (jobs.length === 0) return <p className="jobs__empty">{empty}</p>;
  return (
    <table className="jobs__table">
      <thead>
        <tr>
          <th>类型</th>
          <th>目标</th>
          <th>状态</th>
          <th>尝试</th>
          <th>错误</th>
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
      <button className="btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        任务 {activeCount}
      </button>
      {open && (
        <div className="jobs__popover" role="dialog" aria-label="任务">
          <h3>进行中</h3>
          <Table
            jobs={active.data ?? []}
            empty="暂无进行中的任务"
            cancel={(id) => cancel.mutate(id)}
            cancellingId={cancel.isPending ? cancel.variables : undefined}
          />
          <h3>最近</h3>
          <Table jobs={recent.data ?? []} empty="暂无最近任务" />
        </div>
      )}
    </div>
  );
}
