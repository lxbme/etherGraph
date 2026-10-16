import { useJobProgress } from "./statusStore";

export function StatusBar({ queueLen, saveStatus }: { queueLen?: number; saveStatus?: string }) {
  const active = useJobProgress((s) => s.activeCount());
  return (
    <footer className="statusbar">
      <span>{active > 0 ? `⏳ 同步任务 ${active}` : "无进行中的任务"}</span>
      <span>队列 {queueLen ?? 0}</span>
      <span className="statusbar__save">画布: {saveStatus ?? "未保存"}</span>
    </footer>
  );
}
