import { formatTime } from "../lib/format";
import { useQuota, useSseState } from "./statusStore";

export function Banners() {
  const sse = useSseState((s) => s.state);
  const { quota, degraded } = useQuota();
  return (
    <div className="banners">
      {degraded === "invalid_key" && (
        <div className="banner banner--fatal" role="alert">Etherscan API key 无效，所有抓取已暂停</div>
      )}
      {sse === "closed" && <div className="banner banner--warn" role="alert">实时更新已断开，正在重连…</div>}
      {quota?.paused && (
        <div className="banner banner--warn" role="alert">
          今日 Etherscan 额度已用完，将于 {formatTime(quota.reset_at)} 恢复
        </div>
      )}
    </div>
  );
}
