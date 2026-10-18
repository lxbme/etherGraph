import type cytoscape from "cytoscape";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { t, useLocale, useT } from "../i18n";
import { messageFor } from "../api/errors";
import { getMainCy, setMainCy } from "../graph/cyRegistry";
import { useBoxSelection } from "../graph/boxSelection";
import { CytoscapeView } from "../graph/CytoscapeView";
import { isMoreId, MORE_PREFIX, toElements } from "../graph/elements";
import { useCanvasMetrics } from "../graph/canvasMetrics";
import { legendFor } from "../graph/legend";
import { edgeTooltip, moreTooltip, nodeTooltip, type TooltipLine } from "../graph/tooltip";
import { useShortcuts } from "../graph/useShortcuts";
import { BatchBar } from "../panels/BatchBar";
import { ContextMenu } from "../panels/ContextMenu";
import { ExpandDialog } from "../panels/expand/ExpandDialog";
import { InteractionsDialog } from "../panels/expand/InteractionsDialog";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { MAX_NEIGHBOUR_LIMIT, revealBatch, useGraph, type Pos } from "../graph/store";
import { graphStylesheet } from "../graph/styles";
import { useGraphData } from "../graph/useGraphData";
import { deriveVisualEdges } from "../graph/visualEdges";
import { shortAddr } from "../lib/address";
import { safeFileName } from "../lib/download";
import { toast } from "../shell/Toasts";
import { useTheme } from "../shell/theme";
import { useWorkspace } from "../workspace/useWorkspace";
import { GraphTooltip } from "./GraphTooltip";
import { CanvasTools, IdentifyAllButton, type CanvasExport } from "./CanvasTools";
import { LEGEND_COLLAPSED_KEY, Legend } from "./Legend";

/** The address graph's Export menu: the live canvas, named after the workspace. */
const EXPORTER: CanvasExport = {
  cy: getMainCy,
  baseName: () => `ethergraph-${safeFileName(useWorkspace.getState().name, "graph")}`,
};

/** A second tap on the same "+N more" node within this window is part of a double-click. */
const REVEAL_DEBOUNCE_MS = 300;

const NO_NODES: NodeSummaryDto[] = [];
const lc = (s: string) => s.toLowerCase();

/** The address relationship canvas: store + graph data → Cytoscape, and interactions back into the store/API. */
export function AddressGraph() {
  const { data: fresh, isFetching, error } = useGraphData();
  const centers = useGraph((s) => s.centers);
  // A failed query (e.g. after a filter change) keeps showing the last good result; the error is shown inline.
  const lastGood = useRef<GraphResponseDto | undefined>(undefined);
  if (fresh) lastGood.current = fresh;
  else if (centers.length === 0) lastGood.current = undefined;
  const data = fresh ?? (error != null ? lastGood.current : undefined);
  const expandedPairs = useGraph((s) => s.expandedPairs);
  const ui = useGraph((s) => s.ui);
  const selection = useGraph((s) => s.selection);
  const highlightTransfer = useGraph((s) => s.highlightTransfer);
  // Only the centers at the server's maximum limit matter here (they get no "+N more"); keyed so a raised
  // limit below it does not re-derive the elements.
  const maxedKey = useGraph((s) =>
    Object.keys(s.limits)
      .filter((c) => (s.limits[c] ?? 0) >= MAX_NEIGHBOUR_LIMIT)
      .sort()
      .join(","),
  );
  const limits = useMemo(
    () => Object.fromEntries((maxedKey ? maxedKey.split(",") : []).map((c) => [c, MAX_NEIGHBOUR_LIMIT])),
    [maxedKey],
  );
  const epoch = useGraph((s) => s.epoch);

  const theme = useTheme((s) => s.resolved);
  const tr = useT();
  const locale = useLocale((s) => s.locale);
  const stylesheet = useMemo(() => graphStylesheet(theme), [theme]);

  // Keyed by content so position-only ui updates don't re-derive the edges.
  const hiddenKey = useMemo(
    () => Object.keys(ui).filter((k) => ui[k]?.hidden).sort().join(","),
    [ui],
  );
  const hidden = useMemo(() => new Set(hiddenKey ? hiddenKey.split(",") : []), [hiddenKey]);
  /** Hidden nodes that the current result would otherwise show. */
  const hiddenOnCanvas = useMemo(
    () => (data ? data.nodes.filter((n) => hidden.has(lc(n.address))).length : 0),
    [data, hidden],
  );
  /** Nodes on the canvas: not hidden (the "+N more" placeholders are not result nodes). */
  const shownNodes = useMemo(() => (data ? data.nodes.filter((n) => !hidden.has(lc(n.address))) : NO_NODES), [data, hidden]);
  // `locale` is a dependency only because the edge badges are translated when derived.
  const visual = useMemo(
    () => (data ? deriveVisualEdges(data.edges, expandedPairs, hidden) : []),
    [data, expandedPairs, hidden, locale],
  );
  const elements = useMemo(
    () => (data ? toElements(data.nodes, visual, { ui, centers, selection, highlightTransfer, limits }, data.omitted) : []),
    [data, visual, ui, centers, selection, highlightTransfer, limits],
  );
  const boxCount = useBoxSelection((s) => s.ids.length);
  const legend = useMemo(() => legendFor(elements, theme, boxCount), [elements, theme, boxCount]);
  /** Canvas width the expanded legend covers from the left; fits keep it clear. */
  const [legendCover, setLegendCover] = useState(0);

  const [hover, setHover] = useState<{ kind: "node" | "edge"; id: string; pos: Pos } | null>(null);
  // `locale` is a dependency so an open tooltip is re-translated.
  const tooltipLines = useMemo((): TooltipLine[] | null => {
    if (!hover || !data) return null;
    if (hover.id.startsWith(MORE_PREFIX)) return moreTooltip(data.omitted[hover.id.slice(MORE_PREFIX.length)] ?? 0);
    if (isMoreId(hover.id)) return null;
    if (hover.kind === "edge") {
      const v = visual.find((e) => e.id === hover.id);
      if (!v) return null;
      const names = new Map(
        data.nodes.flatMap((n) => (n.display_name && (lc(n.address) === v.from || lc(n.address) === v.to) ? [[lc(n.address), n.display_name] as const] : [])),
      );
      return edgeTooltip(v, names);
    }
    const a = lc(hover.id);
    const n = data.nodes.find((x) => lc(x.address) === a);
    if (!n) return null;
    const neighbours = new Set<string>();
    for (const v of visual) {
      if (v.from === a) neighbours.add(v.to);
      else if (v.to === a) neighbours.add(v.from);
    }
    return nodeTooltip(n, {
      coverage: data.coverage[a] ?? data.coverage[n.address],
      omitted: data.omitted[a],
      degree: neighbours.size,
      center: centers.some((c) => lc(c) === a),
      pinned: !!ui[a]?.pinned,
    });
  }, [hover, data, visual, centers, ui, locale]);

  const cyRef = useRef<cytoscape.Core | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const getData = useCallback(() => dataRef.current, []);
  useShortcuts(getData);

  const [menu, setMenu] = useState<{ x: number; y: number; node: NodeSummaryDto } | null>(null);
  const [expanding, setExpanding] = useState<NodeSummaryDto | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [browsing, setBrowsing] = useState<NodeSummaryDto | null>(null);
  const closeExpand = useCallback(() => setExpanding(null), []);
  const closeBrowse = useCallback(() => setBrowsing(null), []);

  const onCxtNode = (id: string, pos: Pos) => {
    const node = data?.nodes.find((n) => lc(n.address) === lc(id));
    const rect = rootRef.current?.getBoundingClientRect();
    if (!node) return;
    // The menu acts on this node, so it becomes the selection (the detail panel and L follow it).
    // Right-clicking a node inside the box selection keeps it; one outside drops it.
    if (!useBoxSelection.getState().ids.includes(lc(id))) useBoxSelection.getState().clear();
    useGraph.getState().select({ kind: "node", address: lc(id) });
    setMenu({ x: pos.x + (rect?.left ?? 0), y: pos.y + (rect?.top ?? 0), node });
  };
  /** Node positions at the moment they were grabbed: the "before" of a drag for undo. */
  const grabbed = useRef<Record<string, Pos>>({});
  const selectMode = useBoxSelection((s) => s.selectMode);

  useEffect(
    () => () => {
      setMainCy(null);
      useBoxSelection.getState().bindCanvas(null);
    },
    [],
  );

  // Canvas size and on-canvas node count feed the expansion budget.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry?.contentRect;
      if (r) useCanvasMetrics.getState().set({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const visible = elements.filter((e) => e.group === "nodes" && !String(e.classes ?? "").split(" ").includes("more")).length;
    useCanvasMetrics.getState().set({ visible });
  }, [elements]);

  const onReady = (cy: cytoscape.Core) => {
    cyRef.current = cy;
    setMainCy(cy);
    // The box selection is the canvas's native selection: clearing it drops the ring too.
    useBoxSelection.getState().bindCanvas(() => cy.$(":selected").unselect());
    cy.on("viewport", () => setMenu(null));
    cy.on("grab", "node", (e) => {
      const p = e.target.position();
      grabbed.current[e.target.id()] = { x: p.x, y: p.y };
    });
  };

  /** A "+N more" node: raise its center's limit by one more per-center batch. */
  const lastReveal = useRef<{ center: string; at: number } | null>(null);
  const revealMore = (center: string) => {
    // A double-click taps twice: reveal one batch, not two.
    const now = Date.now();
    const last = lastReveal.current;
    if (last && last.center === center && now - last.at < REVEAL_DEBOUNCE_MS) return;
    lastReveal.current = { center, at: now };
    useGraph.getState().raiseLimit(center, revealBatch());
  };

  const onDblTapNode = (id: string) => {
    const a = lc(id);
    const n = data?.nodes.find((x) => lc(x.address) === a);
    if (!n || n.synced || n.syncing) return;
    api
      .sync(n.kind === "contract" ? { addresses: [a], depth: "shallow" } : { addresses: [a] })
      .then(() => toast(t("sync.startedAddr", { addr: shortAddr(a) })))
      .catch((err) => toast(messageFor(err), "error"));
  };

  const onDragEnd = (positions: Record<string, Pos>) => {
    const { ui: before, setPositions, commitMove } = useGraph.getState();
    const prev: Record<string, Pos> = {};
    for (const id of Object.keys(positions)) {
      const p = grabbed.current[id] ?? before[lc(id)]?.pos;
      if (p) prev[id] = p;
      delete grabbed.current[id];
    }
    setPositions(positions);
    if (Object.keys(prev).length > 0) commitMove(prev);
  };

  return (
    <div className="address-graph" ref={rootRef} data-testid="address-graph">
      <CytoscapeView
        elements={elements}
        stylesheet={stylesheet}
        layout="incremental"
        positionsEpoch={epoch}
        onTapNode={(id) => {
          if (id.startsWith(MORE_PREFIX)) {
            revealMore(id.slice(MORE_PREFIX.length));
            return;
          }
          useBoxSelection.getState().clear();
          useGraph.getState().select({ kind: "node", address: lc(id) });
        }}
        onTapBackground={() => useBoxSelection.getState().clear()}
        onTapEdge={(a, b) => {
          if (isMoreId(a) || isMoreId(b)) return;
          useGraph.getState().select({ kind: "pair", a: lc(a), b: lc(b) });
        }}
        onDblTapNode={onDblTapNode}
        onDblTapEdge={(a, b) => !isMoreId(a) && !isMoreId(b) && useGraph.getState().togglePair(a, b)}
        onCxtNode={onCxtNode}
        onSelectionChange={(ids) => useBoxSelection.getState().set(ids)}
        selectMode={selectMode}
        onDragEnd={onDragEnd}
        onReady={onReady}
        onHover={setHover}
        fitInsetLeft={legendCover}
      />
      {hover && tooltipLines && <GraphTooltip anchor={hover.pos} lines={tooltipLines} />}
      <Legend groups={legend} collapsedKey={LEGEND_COLLAPSED_KEY} onCover={setLegendCover} />
      <BatchBar insetLeft={legendCover} nodes={data?.nodes ?? NO_NODES} />
      <CanvasTools selectMode={selectMode} onSelectModeChange={useBoxSelection.getState().setSelectMode} exporter={EXPORTER}>
        <IdentifyAllButton nodes={shownNodes} />
        {hiddenOnCanvas > 0 && (
          <button
            type="button"
            className="btn btn--compact"
            onClick={() => useGraph.getState().setHidden([...hidden], false)}
          >
            {tr("view.showHidden", { count: hiddenOnCanvas })}
          </button>
        )}
      </CanvasTools>
      {menu && data && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          node={menu.node}
          data={data}
          onExpand={() => setExpanding(menu.node)}
          onBrowse={() => setBrowsing(menu.node)}
          onClose={closeMenu}
        />
      )}
      {expanding && <ExpandDialog node={expanding} onClose={closeExpand} />}
      {browsing && <InteractionsDialog contract={browsing} onClose={closeBrowse} />}
      {centers.length === 0 && <div className="address-graph__empty">{tr("view.empty")}</div>}
      {centers.length > 0 && error != null && (
        <div className="address-graph__status address-graph__status--error" role="alert">{messageFor(error)}</div>
      )}
      {centers.length > 0 && error == null && isFetching && !data && <div className="address-graph__status">{tr("common.loading")}</div>}
      {/* Background refetch (data already shown): a small non-blocking dot. */}
      {data && isFetching && <div className="address-graph__refreshing" role="status" aria-label={tr("view.updating")} />}
    </div>
  );
}
