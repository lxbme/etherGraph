import type { ReactNode } from "react";
import { FilterPanel } from "../panels/FilterPanel";
import { SearchBox } from "../search/SearchBox";
import { useT } from "../i18n";
import { formatCount, formatTime } from "../lib/format";
import { SettingsMenu } from "./SettingsMenu";
import { useQuota } from "./statusStore";

export interface TopBarProps {
  search?: ReactNode;
  filter?: ReactNode;
  workspaceMenu?: ReactNode;
  onToggleDetail?: () => void;
}

export function TopBar({ search, filter, workspaceMenu, onToggleDetail }: TopBarProps) {
  const t = useT();
  const quota = useQuota((s) => s.quota);
  const pillClass = quota?.paused
    ? " pill--error"
    : quota && quota.limit > 0 && quota.used * 5 >= quota.limit * 4
      ? " pill--warn"
      : "";
  return (
    <header className="topbar">
      <h1 className="topbar__title">etherGraph</h1>
      {search ?? <SearchBox />}
      {filter ?? <FilterPanel />}
      <span className={`pill${pillClass}`} title={quota ? t("topbar.quotaReset", { time: formatTime(quota.reset_at) }) : undefined}>
        {t("topbar.quota", { value: quota ? `${formatCount(quota.used)}/${formatCount(quota.limit)}` : "—" })}
      </span>
      {workspaceMenu ?? <button className="btn" disabled>{t("topbar.workspace")} ▾</button>}
      <SettingsMenu />
      <button className="btn topbar__detail-toggle" aria-label={t("topbar.details")} onClick={onToggleDetail}>▤</button>
    </header>
  );
}
