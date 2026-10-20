import { useMemo } from "react";
import type { TransferDto } from "../api/generated/TransferDto";
import { messageFor } from "../api/errors";
import { hiddenFromTransfer, transferKey } from "../graph/hiddenTransfers";
import { useGraph } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";
import { useT } from "../i18n";
import { useRefreshFromChain } from "../workspace/snapshot";
import { DataFilters } from "./DataFilters";
import { DataTable } from "./DataTable";
import { filterRows, useDataFilter } from "./dataFilter";
import { dataPairs, useDataTransfers } from "./useDataTransfers";

/**
 * The Data tab: every transfer behind the canvas edges, under the graph's filter, each one hideable. A sidebar
 * narrows the loaded rows (newest first); the shown rows hide or unhide at once, one undo step each. A snapshot
 * graph carries no single transfers: it offers to refresh from the chain instead.
 */
export function DataTab() {
  const t = useT();
  const frozen = useGraph((s) => s.frozen !== null);
  const hasCenters = useGraph((s) => s.centers.length > 0);
  const ui = useGraph((s) => s.ui);
  const refreshFromChain = useRefreshFromChain();
  const { data } = useGraphData();
  const hiddenTransfers = useGraph((s) => s.hiddenTransfers);
  const setTransfersHidden = useGraph((s) => s.setTransfersHidden);
  const { rows, loading, capped, loadMore, error } = useDataTransfers();
  const filter = useDataFilter();
  // A node's name: its display name, else its first label.
  const names = useMemo(
    () =>
      new Map(
        (data?.nodes ?? []).flatMap((n) => {
          const name = n.display_name ?? n.labels[0]?.text;
          return name ? [[n.address.toLowerCase(), name] as const] : [];
        }),
      ),
    [data],
  );
  const shown = useMemo(() => filterRows(rows, filter, hiddenTransfers, names), [rows, filter, hiddenTransfers, names]);
  const [toHide, toUnhide] = useMemo(() => {
    const hide: TransferDto[] = [];
    const unhide: TransferDto[] = [];
    for (const r of shown) (transferKey(r) in hiddenTransfers ? unhide : hide).push(r);
    return [hide, unhide];
  }, [shown, hiddenTransfers]);
  const hasEdges = useMemo(() => !!data && dataPairs(data.edges, ui).length > 0, [data, ui]);

  if (frozen) {
    return (
      <div className="data">
        <div className="transfers__msg">
          {t("transfers.snapshot")}{" "}
          <button type="button" className="btn btn--compact" onClick={refreshFromChain}>
            {t("snapshot.refresh")}
          </button>
        </div>
      </div>
    );
  }
  if (!hasEdges) {
    // The graph's first result is still on its way.
    const waiting = hasCenters && !data;
    return (
      <div className="data">
        <div className="transfers__msg">{waiting ? t("data.loading") : t("data.empty")}</div>
      </div>
    );
  }
  return (
    <div className="data data--split">
      <DataFilters rows={rows} />
      <div className="data__main">
        <div className="data__bar">
          <span className="data__status" aria-live="polite">
            <span className="num">{t("data.count", { shown: shown.length, total: rows.length })}</span>
            {loading && <span className="data__muted">{t("data.loading")}</span>}
            {capped && (
              <>
                <span className="data__muted">{t("data.capped", { count: rows.length })}</span>
                <button type="button" className="btn btn--compact" onClick={loadMore}>
                  {t("data.loadMore")}
                </button>
              </>
            )}
          </span>
          <span className="data__bulk">
            <button
              type="button"
              className="btn btn--compact"
              disabled={toHide.length === 0}
              onClick={() => setTransfersHidden(toHide.map(hiddenFromTransfer), true)}
            >
              {t("data.hideShown", { count: toHide.length })}
            </button>
            <button
              type="button"
              className="btn btn--compact"
              disabled={toUnhide.length === 0}
              onClick={() => setTransfersHidden(toUnhide.map(hiddenFromTransfer), false)}
            >
              {t("data.unhideShown", { count: toUnhide.length })}
            </button>
          </span>
        </div>
        {error != null && (
          <div className="transfers__msg transfers__msg--error" role="alert">
            {messageFor(error)}{" "}
            <button type="button" className="btn btn--compact" onClick={loadMore}>
              {t("common.retry")}
            </button>
          </div>
        )}
        <DataTable rows={shown} names={names} />
      </div>
    </div>
  );
}
