import type cytoscape from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import { useBoxSelection } from "../graph/boxSelection";
import { CytoscapeView } from "../graph/CytoscapeView";
import { toElements } from "../graph/elements";
import { useGraph, type Pos } from "../graph/store";
import { graphStylesheet } from "../graph/styles";
import { useGraphData } from "../graph/useGraphData";
import { deriveVisualEdges } from "../graph/visualEdges";
import { shortAddr } from "../lib/address";
import { toast } from "../shell/Toasts";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const hasMatchMedia = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

function useColorScheme(): "light" | "dark" {
  const [dark, setDark] = useState(() => hasMatchMedia() && window.matchMedia(DARK_QUERY).matches);
  useEffect(() => {
    if (!hasMatchMedia()) return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark ? "dark" : "light";
}

const lc = (s: string) => s.toLowerCase();

/** The address relationship canvas: store + graph data → Cytoscape, and interactions back into the store/API. */
export function AddressGraph() {
  const { data, isFetching, error } = useGraphData();
  const centers = useGraph((s) => s.centers);
  const expandedPairs = useGraph((s) => s.expandedPairs);
  const ui = useGraph((s) => s.ui);
  const selection = useGraph((s) => s.selection);
  const highlightTransfer = useGraph((s) => s.highlightTransfer);

  const theme = useColorScheme();
  const stylesheet = useMemo(() => graphStylesheet(theme), [theme]);

  // Keyed by content so position-only ui updates don't re-derive the edges.
  const hiddenKey = useMemo(
    () => Object.keys(ui).filter((k) => ui[k]?.hidden).sort().join(","),
    [ui],
  );
  const hidden = useMemo(() => new Set(hiddenKey ? hiddenKey.split(",") : []), [hiddenKey]);
  const visual = useMemo(
    () => (data ? deriveVisualEdges(data.edges, expandedPairs, hidden) : []),
    [data, expandedPairs, hidden],
  );
  const elements = useMemo(
    () => (data ? toElements(data.nodes, visual, { ui, centers, selection, highlightTransfer }, data.omitted) : []),
    [data, visual, ui, centers, selection, highlightTransfer],
  );

  const cyRef = useRef<cytoscape.Core | null>(null);
  /** Node positions at the moment they were grabbed: the "before" of a drag for undo. */
  const grabbed = useRef<Record<string, Pos>>({});

  // The store owns selection; drop Cytoscape's native :selected so the two never disagree.
  const clearNativeSelection = () => {
    cyRef.current?.$(":selected").unselect();
  };
  useEffect(() => {
    clearNativeSelection();
  }, [selection]);

  const onReady = (cy: cytoscape.Core) => {
    cyRef.current = cy;
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
      .then(() => toast(`已开始同步 ${shortAddr(a)}`))
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
    <div className="address-graph">
      <CytoscapeView
        elements={elements}
        stylesheet={stylesheet}
        layout="incremental"
        onTapNode={(id) => useGraph.getState().select({ kind: "node", address: lc(id) })}
        onTapEdge={(a, b) => useGraph.getState().select({ kind: "pair", a: lc(a), b: lc(b) })}
        onDblTapNode={onDblTapNode}
        onDblTapEdge={(a, b) => useGraph.getState().togglePair(a, b)}
        onCxtNode={() => {}}
        onBoxSelect={(ids) => {
          if (ids.length === 0) return;
          useBoxSelection.getState().set(ids);
          clearNativeSelection();
        }}
        onDragEnd={onDragEnd}
        onReady={onReady}
      />
      {centers.length === 0 && <div className="address-graph__empty">输入地址、交易哈希或 ENS 开始探索</div>}
      {centers.length > 0 && error != null && (
        <div className="address-graph__status address-graph__status--error" role="alert">{messageFor(error)}</div>
      )}
      {centers.length > 0 && error == null && isFetching && !data && <div className="address-graph__status">加载中…</div>}
      {/* Background refetch (data already shown): a small non-blocking dot. */}
      {data && isFetching && <div className="address-graph__refreshing" role="status" aria-label="更新中" />}
    </div>
  );
}
