import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { formatLocalTime } from "../lib/format";

/** The bar above a snapshot (frozen) view's canvas: when the file was exported, and the way back to live data. */
export function SnapshotBanner({ exportedAt, onRefresh }: { exportedAt: string; onRefresh: () => void }) {
  const t = useT();
  return (
    <div className="snapshot-banner" data-testid="snapshot-banner">
      <span className="snapshot-banner__text">{t("snapshot.banner", { time: formatLocalTime(exportedAt) })}</span>
      <button type="button" className="btn btn--compact" onClick={onRefresh}>
        {t("snapshot.refresh")}
      </button>
    </div>
  );
}

/** The address graph's banner, while it shows a snapshot. */
export function GraphSnapshotBanner() {
  const exportedAt = useGraph((s) => s.frozen?.exported_at ?? null);
  if (exportedAt === null) return null;
  return <SnapshotBanner exportedAt={exportedAt} onRefresh={() => useGraph.getState().unfreeze()} />;
}

/** Asks before a graph-changing action on a snapshot graph: refresh from the chain first, then run it. */
export function LiveConfirm() {
  const t = useT();
  const pending = useGraph((s) => s.pendingLive !== null);
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
