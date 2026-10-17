import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import { useLocale, useT } from "../i18n";
import { qk } from "../api/queryClient";
import { CytoscapeView } from "../graph/CytoscapeView";
import { exposeTxCy } from "../graph/cyRegistry";
import { txFlowStylesheet } from "../graph/styles";
import { NodeDetail } from "../panels/NodeDetail";
import { useUi } from "../panels/uiStore";
import { useJobProgress } from "../shell/statusStore";
import { useTheme } from "../shell/theme";
import { txElements } from "./txElements";
import { addToGraph } from "./txdetail/common";
import { TxDetailTabs } from "./txdetail/TxDetailTabs";
import { TxSummaryBar } from "./txdetail/TxSummaryBar";

const NOOP = () => {};

/**
 * The active tx tab's node detail, shown in the app's right panel (so the flow canvas keeps its width):
 * the tab's own selection with "Add to graph".
 */
export function TxNodeDetail({ hash }: { hash: string }) {
  const selected = useUi((s) => s.txSelection[hash.toLowerCase()] ?? null);
  const selectTx = useUi((s) => s.selectTx);
  const t = useT();
  if (!selected) {
    return (
      <div className="detail">
        <div className="placeholder">{t("tx.selectNode")}</div>
      </div>
    );
  }
  return (
    <div className="detail">
      <NodeDetail key={selected} address={selected} onNavigate={(a) => selectTx(hash, a)} />
      <button
        type="button"
        className="btn txview__add"
        onClick={() => addToGraph(selected)}
      >
        {t("tx.addToGraph")}
      </button>
    </div>
  );
}

/** The transaction tab: summary bar, fund-flow graph and detail tabs; its node detail lives in the right panel. */
export function TxFlowView({ hash }: { hash: string }) {
  const q = useQuery({
    queryKey: qk.tx(hash),
    queryFn: () => api.tx(hash),
    // Safety net behind the TxReady SSE invalidation.
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 5000 : false),
  });
  const jobId = q.data?.job_id ?? null;
  const job = useJobProgress((s) => (jobId === null ? undefined : s.byId[jobId]));
  const theme = useTheme((s) => s.resolved);
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const stylesheet = useMemo(() => txFlowStylesheet(theme), [theme]);
  const selected = useUi((s) => s.txSelection[hash.toLowerCase()] ?? null);
  const selectTx = useUi((s) => s.selectTx);
  const setSelected = useCallback((a: string | null) => selectTx(hash, a), [selectTx, hash]);
  const flow = q.data?.status === "ready" ? q.data.flow : null;
  const elements = useMemo(() => (flow ? txElements(flow, selected) : []), [flow, selected, locale]); // labels are translated when built
  useEffect(
    () => () => {
      exposeTxCy(hash, null);
      useUi.getState().forgetTx(hash);
    },
    [hash],
  );

  if (q.isError) {
    return (
      <div className="placeholder" role="alert">
        {messageFor(q.error)}{" "}
        <button type="button" className="btn btn--compact" onClick={() => void q.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (!flow && job?.status === "failed") {
    return (
      <div className="placeholder" role="alert">
        {t("events.txFetchFailed", { reason: job.error ?? t("events.unknownReason") })}{" "}
        <button
          type="button"
          className="btn btn--compact"
          onClick={() => {
            useJobProgress.getState().remove([job.job_id]);
            void q.refetch();
          }}
        >
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (!flow) return <div className="placeholder">{t("tx.loading")}</div>;

  return (
    <div className="txview" data-testid="tx-view">
      <div className="txview__main">
        <TxSummaryBar flow={flow} />
        {flow.completeness === "fund_flow" && <div className="txview__banner">{t("tx.banner")}</div>}
        <div className="txview__graph">
          <CytoscapeView
            elements={elements}
            stylesheet={stylesheet}
            layout="dagre-lr"
            onTapNode={(id) => setSelected(id.toLowerCase())}
            onTapBackground={() => setSelected(null)}
            onTapEdge={NOOP}
            onDblTapNode={NOOP}
            onDblTapEdge={NOOP}
            onCxtNode={NOOP}
            onBoxSelect={NOOP}
            onDragEnd={NOOP}
            onReady={(cy) => exposeTxCy(hash, cy)}
          />
        </div>
        <TxDetailTabs flow={flow} />
      </div>
    </div>
  );
}
