import { useMemo } from "react";
import { messageFor } from "../api/errors";
import { useGraph } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";
import { useT } from "../i18n";
import { useRefreshFromChain } from "../workspace/snapshot";
import { DataTable } from "./DataTable";
import { dataPairs, useDataTransfers } from "./useDataTransfers";

/**
 * The Data tab: every transfer behind the canvas edges, under the graph's filter, each one hideable. A snapshot
 * graph carries no single transfers: it offers to refresh from the chain instead.
 */
export function DataTab() {
  const t = useT();
  const frozen = useGraph((s) => s.frozen !== null);
  const hasCenters = useGraph((s) => s.centers.length > 0);
  const ui = useGraph((s) => s.ui);
  const refreshFromChain = useRefreshFromChain();
  const { data } = useGraphData();
  const { rows, loading, capped, loadMore, error } = useDataTransfers();
  const names = useMemo(
    () => new Map((data?.nodes ?? []).flatMap((n) => (n.display_name ? [[n.address.toLowerCase(), n.display_name] as const] : []))),
    [data],
  );
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
    <div className="data">
      <div className="data__bar" aria-live="polite">
        <span className="num">{t("data.count", { shown: rows.length, total: rows.length })}</span>
        {loading && <span className="data__muted">{t("data.loading")}</span>}
        {capped && (
          <>
            <span className="data__muted">{t("data.capped", { count: rows.length })}</span>
            <button type="button" className="btn btn--compact" onClick={loadMore}>
              {t("data.loadMore")}
            </button>
          </>
        )}
      </div>
      {error != null && (
        <div className="transfers__msg transfers__msg--error" role="alert">
          {messageFor(error)}{" "}
          <button type="button" className="btn btn--compact" onClick={loadMore}>
            {t("common.retry")}
          </button>
        </div>
      )}
      <DataTable rows={rows} names={names} />
    </div>
  );
}
