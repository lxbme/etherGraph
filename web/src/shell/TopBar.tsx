import type { ReactNode } from "react";
import { FilterPanel } from "../panels/FilterPanel";
import { SearchBox } from "../search/SearchBox";
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
      {search ?? <SearchBox />}
      {filter ?? <FilterPanel />}
      <span className={`pill${quota?.paused ? " pill--warn" : ""}`}>
        额度 {quota ? `${quota.used}/${quota.limit}` : "—"}
      </span>
      {workspaceMenu ?? <button className="btn" disabled>画布 ▾</button>}
      <button className="btn topbar__detail-toggle" aria-label="详情栏" onClick={onToggleDetail}>▤</button>
    </header>
  );
}
