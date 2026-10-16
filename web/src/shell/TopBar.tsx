import type { ReactNode } from "react";
import { useQuota } from "./statusStore";

export interface TopBarProps {
  search?: ReactNode;
  filter?: ReactNode;
  workspaceMenu?: ReactNode;
  onToggleDetail?: () => void;
}

export function TopBar({ search, filter, workspaceMenu, onToggleDetail }: TopBarProps) {
  const quota = useQuota((s) => s.quota);
  return (
    <header className="topbar">
      <h1 className="topbar__title">etherGraph</h1>
      {search ?? (
        <input
          type="search"
          className="topbar__search"
          placeholder="搜索 地址 / 交易哈希 / ENS"
          aria-label="搜索"
        />
      )}
      {filter ?? <button className="btn" disabled>⚙ 过滤 ▾</button>}
      <span className={`pill${quota?.paused ? " pill--warn" : ""}`}>
        额度 {quota ? `${quota.used}/${quota.limit}` : "—"}
      </span>
      {workspaceMenu ?? <button className="btn" disabled>画布 ▾</button>}
      <button className="btn topbar__detail-toggle" aria-label="详情栏" onClick={onToggleDetail}>▤</button>
    </header>
  );
}
