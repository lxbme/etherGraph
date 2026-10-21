import type cytoscape from "cytoscape";
import type { FlowDto } from "../api/generated/FlowDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import { nodeElement } from "../graph/elements";
import { t } from "../i18n";
import { shortAddr } from "../lib/address";
import { assetClass } from "../lib/assets";
import { formatAmount } from "../lib/amount";
import { circled, ellipsize, shortTokenId } from "../lib/format";
import { guessedName } from "../lib/guessed";
import { flaggedLabel, trustFlag } from "../lib/trust";
import { tokenKindOf, type InfoView } from "../panels/info/infoStore";

/** Longest edge label, in characters; the tooltip and detail tables keep the full text. */
export const EDGE_LABEL_MAX = 48;

const lc = (s: string) => s.toLowerCase();
export { circled };

/**
 * Token contracts that only emitted the Transfer logs of their flows: the asset of some flow, never a flow's sender
 * or recipient, and neither the tx's sender, its recipient nor the contract it created (lower-case, in flow order).
 */
export function assetOnlyAddresses(flow: TxFlowDto): Set<string> {
  const { to } = flow.tx;
  const created = flow.detail.contract_created;
  const parties = new Set<string>([lc(flow.tx.from), ...(to ? [lc(to)] : []), ...(created ? [lc(created)] : [])]);
  for (const f of flow.flows) parties.add(lc(f.from)).add(lc(f.to));
  const out = new Set<string>();
  for (const f of flow.flows) if (f.asset !== null && !parties.has(lc(f.asset))) out.add(lc(f.asset));
  return out;
}

/** The server's effective EIP-7702 delegations; absent from responses of servers older than the field. */
export const delegationsOf = (flow: TxFlowDto) => flow.detail.delegations ?? [];

export function flowSymbol(f: FlowDto): string {
  if (f.asset === null) return "ETH";
  return f.symbol ?? shortAddr(lc(f.asset));
}

/** Amounts stay BigInt/string based; NFTs show their token id instead of an amount. */
export function flowAmountText(f: FlowDto): string {
  if ((f.kind === "erc721" || f.kind === "erc1155") && f.token_id !== null) return `#${shortTokenId(f.token_id)}`;
  return formatAmount(f.amount, f.decimals, { maxFrac: 4 }).text;
}

/** `① 12.5 USDT`, with a ⚠ in front for a suspicious or scam token. */
export function flowLabel(f: FlowDto): string {
  const text = `${circled(f.seq)}  ${flowAmountText(f)} ${flowSymbol(f)}`;
  return ellipsize(trustFlag(f.trust) ? flaggedLabel(text) : text, EDGE_LABEL_MAX);
}

export function callLabel(flow: TxFlowDto): string {
  const label = flow.call ? guessedName(flow.call.name, flow.call.guessed) : (flow.tx.selector ? t("tx.undecodedSelector", { selector: flow.tx.selector }) : t("tx.call"));
  return ellipsize(label, EDGE_LABEL_MAX);
}

/** `asset-suspicious` / `asset-scam` for a flow of a flagged token (its label colour), else nothing. */
function flagClass(f: FlowDto): string {
  const flag = trustFlag(f.trust);
  return flag ? `asset-${flag}` : "";
}

/**
 * Nodes, a dashed call edge (tx.from → tx.to; a loop when they are the same) and one solid edge per flow; edges to
 * unknown nodes are skipped. Token contracts that only emitted Transfer logs are muted (`asset-contract`) with one
 * dotted `asset-link` (no arrow) between them and each distinct sender of their flows; each effective EIP-7702
 * delegation the server computed (`detail.delegations`) is a dashed `delegation-<index>` edge from signer to delegate.
 * The flow with seq `highlightedSeq` (picked in a detail table) gets the `highlighted` class.
 */
export function txElements(flow: TxFlowDto, selected?: string | null, highlightedSeq?: number | null): cytoscape.ElementDefinition[] {
  const out: cytoscape.ElementDefinition[] = [];
  const present = new Set<string>();
  const sel = selected ? lc(selected) : null;
  const assetOnly = assetOnlyAddresses(flow);
  for (const n of flow.nodes) {
    const id = lc(n.address);
    if (present.has(id)) continue;
    present.add(id);
    const el = nodeElement(n, undefined, { selected: sel === id, isCenter: false, omitted: 0 });
    if (assetOnly.has(id)) el.classes = `${String(el.classes)} asset-contract`;
    out.push(el);
  }
  const { from, to } = flow.tx;
  if (to && present.has(lc(from)) && present.has(lc(to))) {
    out.push({
      group: "edges",
      data: { id: "call", source: lc(from), target: lc(to), width: 1.5, label: callLabel(flow) },
      classes: lc(from) === lc(to) ? "call self-call" : "call",
    });
  }
  delegationsOf(flow).forEach((d, i) => {
    const source = lc(d.authority);
    const target = lc(d.delegate);
    if (!present.has(source) || !present.has(target)) return;
    out.push({
      group: "edges",
      data: { id: `delegation-${i}`, source, target, width: 1.5, label: t("tx.delegatesTo") },
      classes: "delegation",
    });
  });
  for (const asset of assetOnly) {
    if (!present.has(asset)) continue;
    const senders = new Set(flow.flows.filter((f) => f.asset !== null && lc(f.asset) === asset).map((f) => lc(f.from)));
    for (const sender of senders) {
      if (!present.has(sender)) continue;
      // Sender → token: the left-to-right layout then ranks the token after its senders, clear of the tx sender's loops.
      out.push({ group: "edges", data: { id: `asset-link-${asset}-${sender}`, source: sender, target: asset, width: 1 }, classes: "asset-link" });
    }
  }
  flow.flows.forEach((f, i) => {
    if (!present.has(lc(f.from)) || !present.has(lc(f.to))) return;
    out.push({
      group: "edges",
      data: { id: `flow-${f.seq}-${i}`, source: lc(f.from), target: lc(f.to), width: 2.5, label: flowLabel(f) },
      classes: [`asset-${assetClass(f.asset, f.kind)}`, flagClass(f), f.seq === highlightedSeq ? "highlighted" : ""].filter(Boolean).join(" "),
    });
  });
  return out;
}

/** A tapped token-contract node (one that only emitted Transfer logs) as its asset, with the kind of its flows; other nodes resolve to nothing. */
export function assetViewForNode(flow: TxFlowDto, id: string): InfoView | null {
  const asset = lc(id);
  if (!assetOnlyAddresses(flow).has(asset)) return null;
  const f = flow.flows.find((x) => x.asset !== null && lc(x.asset) === asset);
  const tokenKind = f ? tokenKindOf(f.kind) : undefined;
  const view: Extract<InfoView, { kind: "asset" }> = { kind: "asset", asset };
  if (tokenKind) view.tokenKind = tokenKind;
  return view;
}

/** The asset a tapped edge carries (`flow-<seq>-<index>`); NFTs include their token id. The call edge has none. */
export function assetViewForEdge(flow: TxFlowDto, edgeId: string): InfoView | null {
  const m = /^flow-\d+-(\d+)$/.exec(edgeId);
  const f = m ? flow.flows[Number(m[1])] : undefined;
  if (!f) return null;
  const asset = f.asset === null ? null : lc(f.asset);
  const tokenKind = asset === null ? undefined : tokenKindOf(f.kind);
  const view: Extract<InfoView, { kind: "asset" }> = { kind: "asset", asset };
  if (tokenKind) view.tokenKind = tokenKind;
  if (f.token_id !== null && (f.kind === "erc721" || f.kind === "erc1155")) view.tokenId = f.token_id;
  return view;
}
