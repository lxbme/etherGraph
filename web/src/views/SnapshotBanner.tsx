import { SHALLOW_CALLS } from "../graph/budget";
import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { formatLocalTime, formatTime } from "../lib/format";
import { useRefreshFromChain, useRefreshSyncCount } from "../workspace/snapshot";

/** The bar above a snapshot (frozen) view's canvas: when the file was exported, and the way back to live data. */
export function SnapshotBanner({ exportedAt, onRefresh }: { exportedAt: string; onRefresh: () => void }) {
  const t = useT();
  return (
    <div className="snapshot-banner" data-testid="snapshot-banner">
      <span className="snapshot-banner__text" title={formatLocalTime(exportedAt)}>{t("snapshot.banner", { time: formatTime(exportedAt) })}</span>
      <button type="button" className="btn btn--compact" onClick={onRefresh}>
        {t("snapshot.refresh")}
      </button>
    </div>
  );
}

/**
 * The address graph's banner, while it shows a snapshot. Refreshing syncs the centers never synced here, so it asks
 * first (the confirm says how many) unless there are none.
 */
export function GraphSnapshotBanner() {
  const exportedAt = useGraph((s) => s.frozen?.exported_at ?? null);
  const refresh = useRefreshFromChain();
  if (exportedAt === null) return null;
  return <SnapshotBanner exportedAt={exportedAt} onRefresh={refresh} />;
}

/** Asks before a graph-changing action on a snapshot graph: refresh from the chain first, then run it. */
export function LiveConfirm() {
  const t = useT();
  const pending = useGraph((s) => s.pendingLive !== null);
  const syncs = useRefreshSyncCount();
  if (!pending) return null;
  const resolve = (go: boolean) => useGraph.getState().resolveLive(go);
  return (
    <div className="dialog-backdrop">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("snapshot.refresh")}
        onKeyDown={(e) => {
          if (e.key === "Escape") resolve(false);
        }}
      >
        <p>{t("snapshot.confirm")}</p>
        {syncs != null && syncs > 0 && (
          <p className="dialog__summary">{t("snapshot.syncNote", { count: syncs, calls: syncs * SHALLOW_CALLS })}</p>
        )}
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={() => resolve(false)}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn--primary" autoFocus onClick={() => resolve(true)}>
            {t("snapshot.refresh")}
          </button>
        </div>
      </div>
    </div>
  );
}
