import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import { useLocale, useT } from "../i18n";
import { qk } from "../api/queryClient";
import { createBoxSelection } from "../graph/boxSelection";
import { CytoscapeView } from "../graph/CytoscapeView";
import { exposeTxCy } from "../graph/cyRegistry";
import { txLegendFor } from "../graph/legend";
import { callTooltip, flowTooltip, nodeTooltip, type TooltipLine } from "../graph/tooltip";
import { addToGraph } from "../graph/nodeActions";
import { isShortcut } from "../graph/shortcuts";
import { listenShortcutKeys } from "../graph/useShortcuts";
import { txFlowStylesheet } from "../graph/styles";
import { NodeDetail } from "../panels/NodeDetail";
import { TxContextMenu } from "../panels/TxContextMenu";
import { TxBatchBar } from "../panels/TxBatchBar";
import { useUi } from "../panels/uiStore";
import { useJobProgress } from "../shell/statusStore";
import { useTabs } from "../shell/tabs";
import { useTheme } from "../shell/theme";
import { CanvasTools, IdentifyAllButton } from "./CanvasTools";
import { GraphTooltip } from "./GraphTooltip";
import { LEGEND_COLLAPSED_KEY, Legend } from "./Legend";
import { txElements } from "./txElements";
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
  const highlightedSeq = useTabs((s) => {
    const entry = s.tabs.find((x) => x.id === hash.toLowerCase());
    return entry && "kind" in entry ? (entry.highlightedSeq ?? null) : null;
  });
  const flow = q.data?.status === "ready" ? q.data.flow : null;
  const elements = useMemo(
    () => (flow ? txElements(flow, selected, highlightedSeq) : []),
    [flow, selected, highlightedSeq, locale], // labels are translated when built
  );
  /** This tab's own box selection (each tx tab and the address graph have one). */
  const [box] = useState(createBoxSelection);
  const boxCount = box((s) => s.ids.length);
  const legend = useMemo(() => txLegendFor(elements, theme, boxCount), [elements, theme, boxCount]);
  const selectMode = box((s) => s.selectMode);
  // Escape clears it while this tab is shown (the global shortcuts act on the address graph only).
  useEffect(
    () =>
      listenShortcutKeys((e) => {
        if (useTabs.getState().active !== hash.toLowerCase()) return;
        if (!isShortcut(e, "clearSelection") || box.getState().ids.length === 0) return;
        box.getState().clear();
        e.preventDefault();
      }),
    [box, hash],
  );
  const graphRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: NodeSummaryDto } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  /** Canvas width the expanded legend covers from the left; fits keep it clear. */
  const [legendCover, setLegendCover] = useState(0);
  const [hover, setHover] = useState<{ kind: "node" | "edge"; id: string; pos: { x: number; y: number } } | null>(null);
  const tooltipLines = useMemo((): TooltipLine[] | null => {
    if (!hover || !flow) return null;
    if (hover.kind === "edge") {
      if (hover.id === "call") return callTooltip(flow.call?.name);
      const m = /^flow-\d+-(\d+)$/.exec(hover.id);
      const f = m ? flow.flows[Number(m[1])] : undefined;
      if (!f) return null;
      const names = new Map(flow.nodes.flatMap((n) => (n.display_name ? [[n.address.toLowerCase(), n.display_name] as const] : [])));
      return flowTooltip(f, names);
    }
    const n = flow.nodes.find((x) => x.address.toLowerCase() === hover.id);
    return n ? nodeTooltip(n, {}) : null;
  }, [hover, flow, locale]);
  useEffect(
    () => () => {
      exposeTxCy(hash, null);
      box.getState().bindCanvas(null);
      useUi.getState().forgetTx(hash);
    },
    [hash, box],
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
        <div className="txview__graph" ref={graphRef}>
          <CytoscapeView
            elements={elements}
            stylesheet={stylesheet}
            layout="dagre-lr"
            onTapNode={(id) => {
              box.getState().clear();
              setSelected(id.toLowerCase());
            }}
            onTapBackground={() => setSelected(null)}
            onTapEdge={NOOP}
            onDblTapNode={NOOP}
            onDblTapEdge={NOOP}
            onCxtNode={(id, pos) => {
              const node = flow.nodes.find((n) => n.address.toLowerCase() === id.toLowerCase());
              if (!node) return;
              // The menu acts on this node, so it becomes the tab's selection.
              // Right-clicking a node inside the box selection keeps it; one outside drops it.
              if (!box.getState().ids.includes(node.address.toLowerCase())) box.getState().clear();
              setSelected(node.address.toLowerCase());
              const rect = graphRef.current?.getBoundingClientRect();
              setMenu({ x: pos.x + (rect?.left ?? 0), y: pos.y + (rect?.top ?? 0), node });
            }}
            onSelectionChange={box.getState().set}
            selectMode={selectMode}
            onDragEnd={NOOP}
            onReady={(cy) => {
              exposeTxCy(hash, cy);
              box.getState().bindCanvas(() => cy.$(":selected").unselect());
              cy.on("viewport", closeMenu);
            }}
            onHover={setHover}
            fitInsetLeft={legendCover}
          />
          {hover && tooltipLines && <GraphTooltip anchor={hover.pos} lines={tooltipLines} />}
          <Legend groups={legend} collapsedKey={LEGEND_COLLAPSED_KEY} onCover={setLegendCover} />
          <CanvasTools selectMode={selectMode} onSelectModeChange={box.getState().setSelectMode}>
            <IdentifyAllButton nodes={flow.nodes} />
          </CanvasTools>
          <TxBatchBar selection={box} insetLeft={legendCover} nodes={flow.nodes} />
          {menu && <TxContextMenu x={menu.x} y={menu.y} node={menu.node} onClose={closeMenu} />}
        </div>
        <TxDetailTabs flow={flow} />
      </div>
    </div>
  );
}
