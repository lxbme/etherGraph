import { useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { qk } from "../api/queryClient";
import { statusQuery } from "../api/statusQuery";
import { JobsPopover } from "./JobsPopover";
import { progressText } from "./jobText";
import { useJobProgress } from "./statusStore";

const STATUS_POLL_MS = 10_000;

export function StatusBar({ saveStatus }: { saveStatus?: string }) {
  const active = useJobProgress((s) => s.activeCount());
  const latest = useJobProgress((s) => (s.lastId === null ? undefined : s.byId[s.lastId]));
  const status = useQuery({ ...statusQuery, refetchInterval: STATUS_POLL_MS });
  const jobs = useQuery({ queryKey: qk.jobs(), queryFn: api.jobs });

  const job = latest && jobs.data?.find((j) => j.id === latest.job_id);
  return (
    <footer className="statusbar">
      <JobsPopover activeCount={active} />
      <span>{latest ? progressText(latest, job) : "无进行中的任务"}</span>
      <span>队列 {status.data?.queue_len ?? 0}</span>
      <span className="statusbar__save">画布: {saveStatus ?? "未保存"}</span>
    </footer>
  );
}
