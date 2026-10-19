import type cytoscape from "cytoscape";
import { useEffect, useMemo, useState } from "react";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { CytoscapeView } from "../../graph/CytoscapeView";
import { getCallCy, registerCallCy } from "../../graph/cyRegistry";
import { nodeElement } from "../../graph/elements";
import type { Pos } from "../../graph/store";
import { nodeTooltip, type TooltipLine } from "../../graph/tooltip";
import { t, useLocale } from "../../i18n";
import { formatAmount } from "../../lib/amount";
import { ellipsize } from "../../lib/format";
import { useUi } from "../../panels/uiStore";
import { useTabs } from "../../shell/tabs";
import { useTheme } from "../../shell/theme";
import { requestExport } from "../../workspace/fileRequest";
import { livePositions, markTxLayoutChanged } from "../../workspace/useWorkspace";
import { CanvasTools, type CanvasExport } from "../CanvasTools";
import { GraphTooltip } from "../GraphTooltip";
import { EDGE_LABEL_MAX } from "../txElements";
import { callGraphStylesheet } from "./callGraphStyles";
import type { CallEdge } from "./model";

const NOOP = () => {};

const ethText = (wei: bigint) => `${formatAmount(wei.toString(), 18, { maxFrac: 4 }).text} ETH`;
const isCreate = (e: CallEdge) => e.kinds.has("create") || e.kinds.has("create2");

function edgeClasses(e: CallEdge, highlighted: boolean): string {
  const kinds = [...e.kinds];
  return [
    kinds.every((k) => k === "staticcall") ? "static" : "",
    e.kinds.has("delegatecall") || e.kinds.has("callcode") ? "delegate" : "",
    isCreate(e) ? "create" : "",
    e.kinds.has("selfdestruct") ? "destruct" : "",
    e.failed ? "failed" : "",
    e.selfLoop ? "self-loop" : "",
    highlighted ? "highlighted" : "",
  ].filter(Boolean).join(" ");
}

/**
 * Address nodes named as in the asset-flow view, and one edge per caller → callee pair: thicker with more calls,
 * labelled with the first call's order and method (`×N` when merged), a creation marker and the ETH sent. A node
 * with a saved position carries it (the canvas keeps it there; the others are laid out).
 */
export function callElements(
  nodes: NodeSummaryDto[],
  edges: CallEdge[],
  selectedNode: string | null,
  highlightedEdge: string | null,
  positions?: Record<string, Pos>,
): cytoscape.ElementDefinition[] {
  const hl = edges.find((e) => e.id === highlightedEdge);
  const ends = new Set(hl ? [hl.from, hl.to] : []);
  const out: cytoscape.ElementDefinition[] = nodes.map((n) => {
    const id = n.address.toLowerCase();
    const el = nodeElement(n, undefined, { selected: selectedNode === id, isCenter: false, omitted: 0 });
    if (ends.has(id)) el.classes = `${String(el.classes)} highlighted`;
    const pos = positions?.[id];
    if (pos) el.position = { ...pos };
    return el;
  });
  for (const e of edges) {
    let label = isCreate(e) ? `${t("tx.calls.create")} ${e.label}` : e.label;
    if (e.valueWei > 0n) label += ` · ${ethText(e.valueWei)}`;
    out.push({
      group: "edges",
      data: { id: e.id, source: e.from, target: e.to, width: Math.min(1.5 + Math.log2(e.frameIds.length), 6), label: ellipsize(label, EDGE_LABEL_MAX) },
      classes: edgeClasses(e, e.id === highlightedEdge),
    });
  }
  return out;
}

function edgeTooltip(e: CallEdge): TooltipLine[] {
  const lines: TooltipLine[] = [{ value: e.label }, { label: t("tx.calls.kinds"), value: [...e.kinds].join(", "), mono: true }];
  if (e.valueWei > 0n) lines.push({ label: t("tx.value"), value: ethText(e.valueWei) });
  if (e.failed) lines.push({ value: t("tx.calls.failedMark") });
  if (e.kinds.has("delegatecall")) lines.push({ value: t("tx.calls.delegateNote") });
  return lines;
}

/**
 * The call graph of a transaction: tapping an edge steps through its calls (the parent selects them in the
 * tree), tapping a node selects it like in the asset flow (its detail opens in the right panel). Dragging a node
 * stores every node's position on the tab (this canvas is unmounted while the asset flow shows);
 * `initialPositions` are those stored (or restored from a workspace or file).
 */
export function CallGraph({
  hash,
  nodes,
  edges,
  highlightedEdge,
  initialPositions,
  onTapEdge,
}: {
  hash: string;
  nodes: NodeSummaryDto[];
  edges: CallEdge[];
  highlightedEdge: string | null;
  initialPositions?: Record<string, Pos>;
  onTapEdge(id: string): void;
}) {
  const theme = useTheme((s) => s.resolved);
  const locale = useLocale((s) => s.locale);
  const stylesheet = useMemo(() => callGraphStylesheet(theme), [theme]);
  const selected = useUi((s) => s.txSelection[hash.toLowerCase()] ?? null);
  const elements = useMemo(
    () => callElements(nodes, edges, selected, highlightedEdge, initialPositions),
    [nodes, edges, selected, highlightedEdge, initialPositions, locale], // labels are translated when built
  );
  const [hover, setHover] = useState<{ kind: "node" | "edge"; id: string; pos: { x: number; y: number } } | null>(null);
  const tooltipLines = useMemo((): TooltipLine[] | null => {
    if (!hover) return null;
    if (hover.kind === "edge") {
      const e = edges.find((x) => x.id === hover.id);
      return e ? edgeTooltip(e) : null;
    }
    const n = nodes.find((x) => x.address.toLowerCase() === hover.id);
    return n ? nodeTooltip(n, {}) : null;
  }, [hover, edges, nodes, locale]);
  const exporter = useMemo<CanvasExport>(
    () => ({
      cy: () => getCallCy(hash),
      baseName: () => `ethergraph-calls-${hash.replace(/^0x/i, "").slice(0, 10).toLowerCase()}`,
      onExportFile: () => requestExport("tx", hash.toLowerCase()),
    }),
    [hash],
  );
  const initialLayout = useMemo(() => ({ positions: initialPositions }), [initialPositions]);
  useEffect(() => () => registerCallCy(hash, null), [hash]);

  return (
    <div className="txview__graph calltree__graph">
      <CytoscapeView
        elements={elements}
        stylesheet={stylesheet}
        layout="dagre-lr"
        onTapNode={(id) => useUi.getState().selectTx(hash, id.toLowerCase())}
        onTapBackground={() => useUi.getState().selectTx(hash, null)}
        onTapEdge={(_s, _t, id) => onTapEdge(id)}
        onDblTapNode={NOOP}
        onDblTapEdge={NOOP}
        onCxtNode={NOOP}
        onSelectionChange={NOOP}
        onDragEnd={() => {
          const all = livePositions(getCallCy(hash));
          if (!all) return;
          useTabs.getState().setCallLayout(hash.toLowerCase(), all);
          markTxLayoutChanged();
        }}
        initialLayout={initialLayout}
        onReady={(cy) => registerCallCy(hash, cy)}
        onHover={setHover}
      />
      {hover && tooltipLines && <GraphTooltip anchor={hover.pos} lines={tooltipLines} />}
      <CanvasTools exporter={exporter} />
    </div>
  );
}
