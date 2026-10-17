import { useT } from "../i18n";
import { formatTime } from "../lib/format";
import { useQuota, useSseState } from "./statusStore";

export function Banners() {
  const t = useT();
  // Hidden during the very first connect; afterwards stays up through closed → connecting retry cycles.
  const sseDown = useSseState((s) => s.state !== "open" && (s.firstConnectDone || s.state === "closed"));
  const { quota, degraded } = useQuota();
  return (
    <div className="banners">
      {degraded === "invalid_key" && (
        <div className="banner banner--fatal" role="alert">{t("banner.invalidKey")}</div>
      )}
      {sseDown && <div className="banner banner--warn" role="alert">{t("banner.sseDown")}</div>}
      {quota?.paused && (
        <div className="banner banner--warn" role="alert">
          {t("banner.quotaPaused", { time: formatTime(quota.reset_at) })}
        </div>
      )}
    </div>
  );
}
