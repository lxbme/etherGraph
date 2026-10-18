import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, CircleHelp, LogOut, PanelRight, ShieldCheck } from "lucide-react";
import { api } from "../api/endpoints";
import type { MeDto } from "../api/generated/MeDto";
import { logout, useMe } from "../auth/useMe";
import { shortAddr } from "../lib/address";
import { FilterPanel } from "../panels/FilterPanel";
import { SearchBox } from "../search/SearchBox";
import { useT } from "../i18n";
import { formatCount, formatLocalTime, formatTime } from "../lib/format";
import { useUi } from "../panels/uiStore";
import { BrandLockup } from "./Brand";
import { HELP_BUTTON_ID, HELP_DRAWER_ID } from "./HelpDrawer";
import { SettingsMenu } from "./SettingsMenu";
import { useQuota } from "./statusStore";

export interface TopBarProps {
  search?: ReactNode;
  filter?: ReactNode;
  workspaceMenu?: ReactNode;
  onToggleDetail?: () => void;
  /** Whether the detail panel is open (drives the toggle's pressed state). */
  detailOpen?: boolean;
}

function Account() {
  const me = useMe();
  return me ? <SignedIn me={me} /> : null;
}

/** The signed-in address (its ENS name when the backend knows one), the admin entry and logout. */
function SignedIn({ me }: { me: MeDto }) {
  const t = useT();
  // The backend's own summary (no side effects, no third party), under its own key so graph refreshes
  // do not refetch it.
  const summary = useQuery({ queryKey: ["account", me.address], queryFn: () => api.nodes([me.address]), staleTime: Infinity });
  const ens = summary.data?.[0]?.ens ?? null;
  return (
    <>
      {me.is_admin && (
        <a className="btn" href="#/admin">
          <ShieldCheck size={14} />
          {t("topbar.admin")}
        </a>
      )}
      <span className={ens ? "topbar__account" : "topbar__account num"} title={me.address}>
        {ens ?? shortAddr(me.address)}
      </span>
      <button className="btn btn--icon" aria-label={t("topbar.logout")} title={t("topbar.logout")} onClick={() => void logout()}>
        <LogOut size={16} />
      </button>
    </>
  );
}

export function TopBar({ search, filter, workspaceMenu, onToggleDetail, detailOpen }: TopBarProps) {
  const t = useT();
  const quota = useQuota((s) => s.quota);
  const helpOpen = useUi((s) => s.helpOpen);
  const toggleHelp = useUi((s) => s.toggleHelp);
  const quotaClass = quota?.paused
    ? " chip--error"
    : quota && quota.limit > 0 && quota.used * 5 >= quota.limit * 4
      ? " chip--warn"
      : "";
  return (
    <header className="topbar">
      <h1 className="topbar__logo">
        <BrandLockup />
      </h1>
      {search ?? <SearchBox />}
      {filter ?? <FilterPanel />}
      <span className="topbar__spacer" />
      <span
        className={`chip num topbar__quota${quotaClass}`}
        title={
          quota
            ? t("topbar.quotaTitle", {
                used: quota.used,
                remaining: Math.max(0, quota.limit - quota.used),
                time: formatTime(quota.reset_at),
                local: formatLocalTime(quota.reset_at),
              })
            : undefined
        }
      >
        {t("topbar.quota", { value: quota ? `${formatCount(quota.used)}/${formatCount(quota.limit)}` : "—" })}
      </span>
      {workspaceMenu ?? (
        <button className="btn" disabled>
          {t("topbar.workspace")}
          <ChevronDown size={14} />
        </button>
      )}
      <button
        id={HELP_BUTTON_ID}
        data-tour="help"
        className="btn btn--icon"
        aria-label={t("help.open")}
        title={t("help.open")}
        aria-haspopup="dialog"
        aria-expanded={helpOpen}
        aria-controls={helpOpen ? HELP_DRAWER_ID : undefined}
        onClick={toggleHelp}
      >
        <CircleHelp size={16} />
      </button>
      <SettingsMenu />
      <button
        className="btn btn--icon"
        aria-label={t("topbar.details")}
        aria-pressed={detailOpen}
        title={t("topbar.details")}
        onClick={onToggleDetail}
      >
        <PanelRight size={16} />
      </button>
      <Account />
    </header>
  );
}
