import type cytoscape from "cytoscape";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { t, useLocale, useT } from "../i18n";
import { messageFor } from "../api/errors";
import { setMainCy } from "../graph/cyRegistry";
import { useBoxSelection } from "../graph/boxSelection";
import { CytoscapeView } from "../graph/CytoscapeView";
import { toElements } from "../graph/elements";
import { neighborsOf, topNeighbors } from "../graph/neighbors";
import { useShortcuts } from "../graph/useShortcuts";
import { BatchBar } from "../panels/BatchBar";
import { ContextMenu } from "../panels/ContextMenu";
import { ExpandDialog } from "../panels/ExpandDialog";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { useGraph, type Pos } from "../graph/store";
import { graphStylesheet } from "../graph/styles";
import { useGraphData } from "../graph/useGraphData";
import { deriveVisualEdges } from "../graph/visualEdges";
import { shortAddr } from "../lib/address";
import { toast } from "../shell/Toasts";
import { useTheme } from "../shell/theme";

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
  // `locale` is a dependency only because the edge badges are translated when derived.
  const visual = useMemo(
    () => (data ? deriveVisualEdges(data.edges, expandedPairs, hidden) : []),
    [data, expandedPairs, hidden, locale],
  );
  const elements = useMemo(
    () => (data ? toElements(data.nodes, visual, { ui, centers, selection, highlightTransfer }, data.omitted) : []),
    [data, visual, ui, centers, selection, highlightTransfer],
  );

  const cyRef = useRef<cytoscape.Core | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const getData = useCallback(() => dataRef.current, []);
  useShortcuts(getData);

  const filter = useGraph((s) => s.filter);
  const [menu, setMenu] = useState<{ x: number; y: number; node: NodeSummaryDto } | null>(null);
  const [expand, setExpand] = useState<{ neighbors: NodeSummaryDto[]; preChecked?: string[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeExpand = useCallback(() => setExpand(null), []);

  const openExpand = (node: NodeSummaryDto, top: boolean) => {
    if (!data) return;
    const addrs = neighborsOf(node.address, data.edges);
    const byAddr = new Map(data.nodes.map((n) => [lc(n.address), n]));
    const neighbors = addrs
      .filter((a) => !ui[a]?.hidden)
      .map((a) => byAddr.get(a))
      .filter((n): n is NodeSummaryDto => !!n);
    if (neighbors.length === 0) {
      toast(t("view.noNeighbors"));
      return;
    }
    setExpand({
      neighbors,
      preChecked: top ? topNeighbors(node.address, data.nodes, data.edges.filter((e) => !ui[lc(e.from)]?.hidden && !ui[lc(e.to)]?.hidden), filter) : undefined,
    });
  };

  const onCxtNode = (id: string, pos: Pos) => {
    const node = data?.nodes.find((n) => lc(n.address) === lc(id));
    const rect = rootRef.current?.getBoundingClientRect();
    if (!node) return;
    // The menu acts on this node, so it becomes the selection (the detail panel and L follow it).
    useBoxSelection.getState().clear();
    useGraph.getState().select({ kind: "node", address: lc(id) });
    setMenu({ x: pos.x + (rect?.left ?? 0), y: pos.y + (rect?.top ?? 0), node });
  };
  /** Node positions at the moment they were grabbed: the "before" of a drag for undo. */
  const grabbed = useRef<Record<string, Pos>>({});

  // The store owns selection; drop Cytoscape's native :selected so the two never disagree.
  const clearNativeSelection = () => {
    cyRef.current?.$(":selected").unselect();
  };
  useEffect(() => {
    clearNativeSelection();
  }, [selection]);

  useEffect(() => () => setMainCy(null), []);

  const onReady = (cy: cytoscape.Core) => {
    cyRef.current = cy;
    setMainCy(cy);
    cy.on("viewport", () => setMenu(null));
    cy.on("grab", "node", (e) => {
      const p = e.target.position();
      grabbed.current[e.target.id()] = { x: p.x, y: p.y };
    });
  };

  const onDblTapNode = (id: string) => {
    const a = lc(id);
    const n = data?.nodes.find((x) => lc(x.address) === a);
    if (!n || n.synced || n.syncing) return;
    api
      .sync({ addresses: [a] })
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
          useBoxSelection.getState().clear();
          useGraph.getState().select({ kind: "node", address: lc(id) });
        }}
        onTapBackground={() => useBoxSelection.getState().clear()}
        onTapEdge={(a, b) => useGraph.getState().select({ kind: "pair", a: lc(a), b: lc(b) })}
        onDblTapNode={onDblTapNode}
        onDblTapEdge={(a, b) => useGraph.getState().togglePair(a, b)}
        onCxtNode={onCxtNode}
        onBoxSelect={(ids) => {
          if (ids.length === 0) return;
          useBoxSelection.getState().set(ids);
          clearNativeSelection();
        }}
        onDragEnd={onDragEnd}
        onReady={onReady}
      />
      <BatchBar />
      {hiddenOnCanvas > 0 && (
        <button
          type="button"
          className="btn address-graph__unhide"
          onClick={() => useGraph.getState().setHidden([...hidden], false)}
        >
          {tr("view.showHidden", { count: hiddenOnCanvas })}
        </button>
      )}
      {menu && data && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          node={menu.node}
          data={data}
          byAmount={filter.assets?.length === 1}
          onExpandSelect={() => openExpand(menu.node, false)}
          onExpandTop={() => openExpand(menu.node, true)}
          onClose={closeMenu}
        />
      )}
      {expand && <ExpandDialog neighbors={expand.neighbors} preChecked={expand.preChecked} onClose={closeExpand} />}
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
