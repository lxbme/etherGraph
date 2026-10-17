import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../i18n";
import { formatTime } from "../lib/format";
import { useQuota, useSseState } from "./statusStore";

function Banner({ kind, children }: { kind: "warn" | "fatal"; children: ReactNode }) {
  return (
    <div className={`banner banner--${kind}`} role="alert">
      <AlertTriangle className="banner__icon" size={16} />
      <span>{children}</span>
    </div>
  );
}

export function Banners() {
  const t = useT();
  // Hidden during the very first connect; afterwards stays up through closed → connecting retry cycles.
  const sseDown = useSseState((s) => s.state !== "open" && (s.firstConnectDone || s.state === "closed"));
  const { quota, degraded } = useQuota();
  return (
    <div className="banners">
      {degraded === "invalid_key" && <Banner kind="fatal">{t("banner.invalidKey")}</Banner>}
      {sseDown && <Banner kind="warn">{t("banner.sseDown")}</Banner>}
      {quota?.paused && <Banner kind="warn">{t("banner.quotaPaused", { time: formatTime(quota.reset_at) })}</Banner>}
    </div>
  );
}
