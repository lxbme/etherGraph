import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import { useLocale, useT, type MsgKey } from "../i18n";
import { qk } from "../api/queryClient";
import { createBoxSelection } from "../graph/boxSelection";
import { CytoscapeView } from "../graph/CytoscapeView";
import { getTxCy, registerTxCy } from "../graph/cyRegistry";
import { txLegendFor } from "../graph/legend";
import { callTooltip, delegationTooltip, flowTooltip, nodeTooltip, type TooltipLine } from "../graph/tooltip";
import { addToGraph } from "../graph/nodeActions";
import { isShortcut } from "../graph/shortcuts";
import { listenShortcutKeys } from "../graph/useShortcuts";
import { txFlowStylesheet } from "../graph/styles";
import { NodeDetail } from "../panels/NodeDetail";
import { TxContextMenu } from "../panels/TxContextMenu";
import { TxBatchBar } from "../panels/TxBatchBar";
import { useInfo } from "../panels/info/infoStore";
import { useUi } from "../panels/uiStore";
import { useJobProgress } from "../shell/statusStore";
import { useTabs, useTxSnapshot, type TxView } from "../shell/tabs";
import { useTheme } from "../shell/theme";
import { markTxLayoutChanged } from "../workspace/useWorkspace";
import { requestExport } from "../workspace/fileRequest";
import { fileLabelsOf, overlayNodes, useLiveIdentities } from "../workspace/snapshot";
import { CallTreeView } from "./calltree/CallTreeView";
import { CanvasTools, IdentifyAllButton, type CanvasExport } from "./CanvasTools";
import { GraphTooltip } from "./GraphTooltip";
import { LEGEND_COLLAPSED_KEY, Legend } from "./Legend";
import { SnapshotBanner } from "./SnapshotBanner";
import { assetOnlyAddresses, assetViewForEdge, assetViewForNode, delegationsOf, txElements } from "./txElements";
import { ResizableSplit } from "../shell/ResizableSplit";
import { TxDetailTabs } from "./txdetail/TxDetailTabs";
import { TxSummaryBar } from "./txdetail/TxSummaryBar";

const NOOP = () => {};
const NO_ADDRS: string[] = [];
const VIEWS: readonly [TxView, MsgKey][] = [
  ["flow", "tx.view.flow"],
  ["calls", "tx.view.calls"],
];

/**
 * The active tx tab's node detail, shown in the app's right panel (so the flow canvas keeps its width):
 * the tab's own selection with "Add to graph".
 */
export function TxNodeDetail({ hash }: { hash: string }) {
  const selected = useUi((s) => s.txSelection[hash.toLowerCase()] ?? null);
  const selectTx = useUi((s) => s.selectTx);
  const t = useT();
  const snapshot = useTxSnapshot(hash);
  const fileLabels = useMemo(
    () => (selected && snapshot ? fileLabelsOf(snapshot.flow.nodes, selected) : undefined),
    [selected, snapshot],
  );
  if (!selected) {
    return (
      <div className="detail">
        <div className="placeholder">{t("tx.selectNode")}</div>
      </div>
    );
  }
  return (
    <div className="detail">
      <NodeDetail key={selected} address={selected} onNavigate={(a) => selectTx(hash, a)} fileLabels={fileLabels} />
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

/**
 * The transaction tab: summary bar, the asset-flow graph or the call tree (a switch kept on the tab), and detail
 * tabs; its node detail lives in the right panel. A tab with a snapshot shows the file's flow (no tx request) with
 * the receiver's live identities, until refreshed. The flow canvas stays mounted under the call tree, so it keeps
 * its layout; the call tree mounts (and requests its trace) only while shown.
 */
export function TxFlowView({ hash }: { hash: string }) {
  const snapshot = useTxSnapshot(hash);
  const q = useQuery({
    queryKey: qk.tx(hash),
    queryFn: () => api.tx(hash),
    enabled: !snapshot,
    // Safety net behind the TxReady SSE invalidation.
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 5000 : false),
  });
  const snapshotAddrs = useMemo(() => (snapshot ? snapshot.flow.nodes.map((n) => n.address) : NO_ADDRS), [snapshot]);
  const live = useLiveIdentities(snapshotAddrs);
  const snapshotFlow = useMemo(
    () => (snapshot ? { ...snapshot.flow, nodes: overlayNodes(snapshot.flow.nodes, live) } : null),
    [snapshot, live],
  );
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
  /** The layout this tab was restored with (a workspace); the canvas uses it once. */
  const savedLayout = useTabs((s) => {
    const entry = s.tabs.find((x) => x.id === hash.toLowerCase());
    return entry && "kind" in entry ? entry.layout : undefined;
  });
  const storedView = useTabs((s) => {
    const entry = s.tabs.find((x) => x.id === hash.toLowerCase());
    return entry && "kind" in entry ? entry.view : undefined;
  });
  // Used only when the view is shown without a tab entry (nothing to store the choice on).
  const [localView, setLocalView] = useState<TxView>("flow");
  const view = storedView ?? localView;
  const pickView = (v: TxView) => {
    setLocalView(v);
    useTabs.getState().setTxView(hash.toLowerCase(), v);
  };
  const flow = snapshotFlow ?? (q.data?.status === "ready" ? q.data.flow : null);
  const elements = useMemo(
    () => (flow ? txElements(flow, selected, highlightedSeq) : []),
    [flow, selected, highlightedSeq, locale], // labels are translated when built
  );
  const assetOnly = useMemo(() => (flow ? assetOnlyAddresses(flow) : new Set<string>()), [flow]);
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
  const exporter = useMemo<CanvasExport>(
    () => ({
      cy: () => getTxCy(hash),
      baseName: () => `ethergraph-tx-${hash.replace(/^0x/i, "").slice(0, 10).toLowerCase()}`,
      onExportFile: () => requestExport("tx", hash.toLowerCase()),
    }),
    [hash],
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
      if (hover.id === "call") return callTooltip(flow.call?.name, flow.call?.via_delegate);
      const names = new Map(flow.nodes.flatMap((n) => (n.display_name ? [[n.address.toLowerCase(), n.display_name] as const] : [])));
      const d = /^delegation-(\d+)$/.exec(hover.id);
      const del = d ? delegationsOf(flow)[Number(d[1])] : undefined;
      if (del) return delegationTooltip(del.authority, del.delegate, names);
      const m = /^flow-\d+-(\d+)$/.exec(hover.id);
      const f = m ? flow.flows[Number(m[1])] : undefined;
      if (!f) return null;
      return flowTooltip(f, names);
    }
    const n = flow.nodes.find((x) => x.address.toLowerCase() === hover.id);
    return n ? nodeTooltip(n, { assetContract: assetOnly.has(hover.id) }) : null;
  }, [hover, flow, assetOnly, locale]);
  useEffect(
    () => () => {
      registerTxCy(hash, null);
      box.getState().bindCanvas(null);
      useUi.getState().forgetTx(hash);
      useInfo.getState().forget(hash);
    },
    [hash, box],
  );

  if (!snapshot && q.isError) {
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
        {snapshot && (
          <SnapshotBanner exportedAt={snapshot.exported_at} onRefresh={() => useTabs.getState().refreshTx(hash.toLowerCase())} />
        )}
        <TxSummaryBar flow={flow} />
        <ResizableSplit
          className="txview__split"
          storageKey="ethergraph.txDetailHeight"
          label={t("split.resizeTxDetail")}
          defaultShare={0.4}
          // The view switch and the banner or filter bar (~85 px) keep ~120 px of graph under them.
          minTop={200}
          top={
            <div className="txview__stage">
              <div className="txview__views">
                <div className="seg" role="group" aria-label={t("tx.view.label")}>
                  {VIEWS.map(([v, key]) => (
                    <button key={v} type="button" className="seg__item" aria-pressed={view === v} onClick={() => pickView(v)}>
                      {t(key)}
                    </button>
                  ))}
                </div>
              </div>
              {view === "flow" && flow.completeness === "fund_flow" && <div className="txview__banner">{t("tx.banner")}</div>}
              <div className="txview__graph" ref={graphRef} hidden={view !== "flow"}>
                <CytoscapeView
                  elements={elements}
                  stylesheet={stylesheet}
                  layout="dagre-lr"
                  onTapNode={(id) => {
                    box.getState().clear();
                    useInfo.getState().close(hash.toLowerCase());
                    // A token contract that only emitted Transfer logs opens its asset; the node detail stays underneath.
                    const asset = assetViewForNode(flow, id);
                    if (asset) useInfo.getState().open(hash.toLowerCase(), asset);
                    else setSelected(id.toLowerCase());
                  }}
                  onTapBackground={() => setSelected(null)}
                  onTapEdge={(_s, _t, id) => {
                    const view = assetViewForEdge(flow, id);
                    if (view) useInfo.getState().open(hash.toLowerCase(), view);
                    else useInfo.getState().close(hash.toLowerCase());
                  }}
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
                  onDragEnd={markTxLayoutChanged}
                  initialLayout={savedLayout}
                  onReady={(cy) => {
                    registerTxCy(hash, cy);
                    box.getState().bindCanvas(() => cy.$(":selected").unselect());
                    cy.on("viewport", closeMenu);
                  }}
                  onHover={setHover}
                  fitInsetLeft={legendCover}
                />
                {hover && tooltipLines && <GraphTooltip anchor={hover.pos} lines={tooltipLines} />}
                <Legend groups={legend} collapsedKey={LEGEND_COLLAPSED_KEY} onCover={setLegendCover} />
                <CanvasTools selectMode={selectMode} onSelectModeChange={box.getState().setSelectMode} exporter={exporter}>
                  <IdentifyAllButton nodes={flow.nodes} />
                </CanvasTools>
                <TxBatchBar selection={box} insetLeft={legendCover} nodes={flow.nodes} />
                {menu && <TxContextMenu x={menu.x} y={menu.y} node={menu.node} onClose={closeMenu} />}
              </div>
              {view === "calls" && <CallTreeView hash={hash} />}
            </div>
          }
          bottom={<TxDetailTabs flow={flow} />}
        />
      </div>
    </div>
  );
}
