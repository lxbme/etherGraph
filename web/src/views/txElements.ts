import type cytoscape from "cytoscape";
import type { FlowDto } from "../api/generated/FlowDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import { nodeElement } from "../graph/elements";
import { t } from "../i18n";
import { shortAddr } from "../lib/address";
import { assetClass } from "../lib/assets";
import { formatAmount } from "../lib/amount";

const lc = (s: string) => s.toLowerCase();
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

/** ①…⑳ for 1–20, "(n)" beyond. */
export function circled(seq: number): string {
  return seq >= 1 && seq <= 20 ? CIRCLED[seq - 1]! : `(${seq})`;
}

export function flowSymbol(f: FlowDto): string {
  if (f.asset === null) return "ETH";
  return f.symbol ?? shortAddr(lc(f.asset));
}

/** Amounts stay BigInt/string based; NFTs show their token id instead of an amount. */
export function flowAmountText(f: FlowDto): string {
  if ((f.kind === "erc721" || f.kind === "erc1155") && f.token_id !== null) return `#${f.token_id}`;
  return formatAmount(f.amount, f.decimals, { maxFrac: 4 }).text;
}

export function flowLabel(f: FlowDto): string {
  return `${circled(f.seq)}  ${flowAmountText(f)} ${flowSymbol(f)}`;
}

export function callLabel(flow: TxFlowDto): string {
  return flow.call?.name ?? (flow.tx.selector ? t("tx.undecodedSelector", { selector: flow.tx.selector }) : t("tx.call"));
}

/** Nodes, a dashed call edge (tx.from → tx.to) and one solid edge per flow; edges to unknown nodes are skipped. */
export function txElements(flow: TxFlowDto, selected?: string | null): cytoscape.ElementDefinition[] {
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
      classes: `asset-${assetClass(f.asset, f.kind)}`,
    });
  });
  return out;
}
