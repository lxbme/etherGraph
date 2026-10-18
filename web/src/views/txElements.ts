import type cytoscape from "cytoscape";
import type { FlowDto } from "../api/generated/FlowDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import { nodeElement } from "../graph/elements";
import { t } from "../i18n";
import { shortAddr } from "../lib/address";
import { assetClass } from "../lib/assets";
import { formatAmount } from "../lib/amount";
import { circled, ellipsize, shortTokenId } from "../lib/format";

/** Longest edge label, in characters; the tooltip and detail tables keep the full text. */
export const EDGE_LABEL_MAX = 48;

const lc = (s: string) => s.toLowerCase();
export { circled };

export function flowSymbol(f: FlowDto): string {
  if (f.asset === null) return "ETH";
  return f.symbol ?? shortAddr(lc(f.asset));
}

/** Amounts stay BigInt/string based; NFTs show their token id instead of an amount. */
export function flowAmountText(f: FlowDto): string {
  if ((f.kind === "erc721" || f.kind === "erc1155") && f.token_id !== null) return `#${shortTokenId(f.token_id)}`;
  return formatAmount(f.amount, f.decimals, { maxFrac: 4 }).text;
}

export function flowLabel(f: FlowDto): string {
  return ellipsize(`${circled(f.seq)}  ${flowAmountText(f)} ${flowSymbol(f)}`, EDGE_LABEL_MAX);
}

export function callLabel(flow: TxFlowDto): string {
  const label = flow.call?.name ?? (flow.tx.selector ? t("tx.undecodedSelector", { selector: flow.tx.selector }) : t("tx.call"));
  return ellipsize(label, EDGE_LABEL_MAX);
}

/**
 * Nodes, a dashed call edge (tx.from → tx.to) and one solid edge per flow; edges to unknown nodes are skipped.
 * The flow with seq `highlightedSeq` (picked in a detail table) gets the `highlighted` class.
 */
export function txElements(flow: TxFlowDto, selected?: string | null, highlightedSeq?: number | null): cytoscape.ElementDefinition[] {
  const out: cytoscape.ElementDefinition[] = [];
  const present = new Set<string>();
  const sel = selected ? lc(selected) : null;
  for (const n of flow.nodes) {
    const id = lc(n.address);
    if (present.has(id)) continue;
    present.add(id);
    out.push(nodeElement(n, undefined, { selected: sel === id, isCenter: false, omitted: 0 }));
  }
  const { from, to } = flow.tx;
  if (to && present.has(lc(from)) && present.has(lc(to))) {
    out.push({
      group: "edges",
      data: { id: "call", source: lc(from), target: lc(to), width: 1.5, label: callLabel(flow) },
      classes: "call",
    });
  }
  flow.flows.forEach((f, i) => {
    if (!present.has(lc(f.from)) || !present.has(lc(f.to))) return;
    out.push({
      group: "edges",
      data: { id: `flow-${f.seq}-${i}`, source: lc(f.from), target: lc(f.to), width: 2.5, label: flowLabel(f) },
      classes: [`asset-${assetClass(f.asset, f.kind)}`, f.seq === highlightedSeq ? "highlighted" : ""].filter(Boolean).join(" "),
    });
  });
  return out;
}
