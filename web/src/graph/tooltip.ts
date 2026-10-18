import type { FlowDto } from "../api/generated/FlowDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import { t, type MsgKey } from "../i18n";
import { shortAddr } from "../lib/address";
import { formatFixed } from "../lib/amount";
import { assetClass, NATIVE_SYMBOL } from "../lib/assets";
import { circled, formatCount, formatLocalTime, formatTime } from "../lib/format";
import { CATEGORIES } from "../panels/LabelEditor";
import type { VisualEdge } from "./visualEdges";

export interface TooltipLine {
  label?: string;
  value: string;
  mono?: boolean;
  /** Muted secondary text after the value (tooltips cannot show `title` hovers). */
  sub?: string;
}


/** The newest `last_synced_at` among the coverage rows, as an ISO string. */
function latestSync(coverage: SyncStatusDto[] | undefined): string | null {
  let best: string | null = null;
  for (const c of coverage ?? []) {
    if (c.last_synced_at && (best === null || new Date(c.last_synced_at) > new Date(best))) best = c.last_synced_at;
  }
  return best;
}

/** The block range the coverage rows span (lowest start to highest end), and whether any category stopped at the record cap. */
function blockRange(coverage: SyncStatusDto[] | undefined): { from: number; to: number; truncated: boolean } | null {
  let from: number | null = null;
  let to: number | null = null;
  let truncated = false;
  for (const c of coverage ?? []) {
    if (c.from_block !== null && (from === null || c.from_block < from)) from = c.from_block;
    if (c.to_block !== null && (to === null || c.to_block > to)) to = c.to_block;
    truncated ||= c.truncated;
  }
  return from === null || to === null ? null : { from, to, truncated };
}

/** The exact amount has digits the zero-padded fixed display cut off. */
const moreExact = (text: string, full: string) =>
  (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text) !== full;

/** Display name where known, else the short address (`names` is keyed by lower-case address). */
const named = (names: Map<string, string>, a: string) => names.get(a.toLowerCase()) ?? shortAddr(a.toLowerCase());

export function nodeTooltip(
  n: NodeSummaryDto,
  extra: {
    coverage?: SyncStatusDto[];
    omitted?: number;
    degree?: number;
    center?: boolean;
    pinned?: boolean;
    /** A tx-view token contract that only emitted the Transfer logs of its flows. */
    assetContract?: boolean;
  },
): TooltipLine[] {
  const lines: TooltipLine[] = [];
  // Labels arrive best first, so the first one names the node (unless an ENS name does); say when that name is only known from another EVM chain.
  const first = n.labels[0];
  const xchain = first?.source === "import:eth-labels-xchain" && n.display_name === first.text ? t("label.source.xchain", { dataset: "eth-labels" }) : null;
  lines.push(
    n.display_name
      ? { label: t("tooltip.name"), value: n.display_name, ...(xchain && { sub: xchain }) }
      : { label: t("tooltip.name"), value: shortAddr(n.address.toLowerCase()), mono: true },
  );
  lines.push({ label: t("tooltip.type"), value: t(`node.kind.${n.kind}`) });
  const cats = [...new Set(n.labels.map((l) => l.category))].map((c) => ((CATEGORIES as string[]).includes(c) ? t(`category.${c}` as MsgKey) : c));
  if (cats.length > 0) lines.push({ label: t("tooltip.category"), value: cats.join(", ") });
  const states: MsgKey[] = [];
  if (extra.center) states.push("tooltip.state.center");
  if (extra.pinned) states.push("tooltip.state.pinned");
  if (n.labels.some((l) => l.source === "user")) states.push("tooltip.state.userLabel");
  if (states.length > 0) lines.push({ label: t("tooltip.state"), value: states.map((k) => t(k)).join(", ") });

  if (n.partial) lines.push({ label: t("tooltip.sync"), value: t("tooltip.partial") });
  else if (n.syncing) lines.push({ label: t("tooltip.sync"), value: t("tooltip.syncing") });
  else if (n.synced) {
    const at = latestSync(extra.coverage);
    lines.push(
      at
        ? {
            label: t("tooltip.sync"),
            value: t("tooltip.synced", { time: `${formatTime(at)} UTC` }),
            sub: t("tooltip.localTime", { time: formatLocalTime(at) }),
          }
        : { label: t("tooltip.sync"), value: t("tooltip.synced.noTime") },
    );
  } else lines.push({ label: t("tooltip.sync"), value: t("tooltip.notSynced") });
  const range = blockRange(extra.coverage);
  if (range) {
    lines.push({
      label: t("tooltip.coverage"),
      value: t("tooltip.blocks", { from: formatCount(range.from), to: formatCount(range.to) }),
      ...(range.truncated && { sub: t("tooltip.coverage.partial") }),
    });
  }

  if (extra.degree !== undefined) {
    const hidden = extra.omitted ?? 0;
    lines.push({
      label: t("tooltip.neighbours"),
      value: hidden > 0 ? t("tooltip.hidden", { count: extra.degree, hidden }) : formatCount(extra.degree),
    });
  }
  if (n.nonce !== null) lines.push({ label: t("tooltip.nonce"), value: formatCount(n.nonce) });
  if (n.balance !== null) {
    const b = formatFixed(n.balance, 18, "eth");
    lines.push({ label: t("tooltip.balance"), value: `${b.text} ${NATIVE_SYMBOL}`, mono: true, ...(moreExact(b.text, b.full) && { sub: `${b.full} ${NATIVE_SYMBOL}` }) });
  }
  if (extra.assetContract) lines.push({ value: t("tooltip.assetContract") });
  return lines;
}

/** One address-graph edge; `names` maps lower-case addresses to display names. */
export function edgeTooltip(v: VisualEdge, names: Map<string, string> = new Map()): TooltipLine[] {
  const lines: TooltipLine[] = [{ label: t("tooltip.direction"), value: `${named(names, v.from)} → ${named(names, v.to)}` }];
  const perAsset = new Map<string, { symbol: string; count: number }>();
  for (const e of v.assets) {
    const key = e.asset?.toLowerCase() ?? "";
    const symbol = e.asset === null ? NATIVE_SYMBOL : (e.symbol ?? shortAddr(key));
    const cur = perAsset.get(key);
    if (cur) cur.count += e.count;
    else perAsset.set(key, { symbol, count: e.count });
  }
  for (const a of [...perAsset.values()].sort((x, y) => y.count - x.count)) {
    lines.push({ label: a.symbol, value: t("tooltip.transfers", { count: a.count }) });
  }
  lines.push({ value: t("tooltip.width") });
  return lines;
}

/** The tx call edge, with the decoded method name when known and the delegate whose ABI decoded it (EIP-7702). */
export function callTooltip(method?: string | null, viaDelegate?: string | null): TooltipLine[] {
  const lines: TooltipLine[] = [{ value: t("tooltip.call") }];
  if (method) lines.push({ label: t("tooltip.method"), value: method, mono: true });
  if (viaDelegate) lines.push({ value: t("tooltip.viaDelegate", { address: shortAddr(viaDelegate.toLowerCase()) }) });
  return lines;
}

/** An EIP-7702 delegation edge (signer → delegate); `names` maps lower-case addresses to display names. */
export function delegationTooltip(authority: string, delegate: string, names: Map<string, string>): TooltipLine[] {
  return [
    { value: t("tooltip.delegation") },
    { label: t("tooltip.direction"), value: `${named(names, authority)} → ${named(names, delegate)}` },
  ];
}

export function moreTooltip(count: number): TooltipLine[] {
  return [{ value: t("tooltip.more", { count }) }, { value: t("tooltip.moreHint") }];
}

/** One tx-flow transfer; `names` maps lower-case addresses to display names. */
export function flowTooltip(f: FlowDto, names: Map<string, string>): TooltipLine[] {
  const symbol = f.asset === null ? NATIVE_SYMBOL : (f.symbol ?? shortAddr(f.asset.toLowerCase()));
  const nft = f.kind === "erc721" || f.kind === "erc1155";
  const lines: TooltipLine[] = [
    { label: t("tooltip.direction"), value: `${named(names, f.from)} → ${named(names, f.to)}` },
    { label: t("tooltip.asset"), value: symbol },
  ];
  if (nft && f.token_id !== null) {
    lines.push({ label: t("tooltip.amount"), value: `#${f.token_id} × ${formatFixed(f.amount, 0, "nft").text}`, mono: true });
  } else {
    const a = formatFixed(f.amount, f.decimals, assetClass(f.asset, f.kind));
    lines.push({ label: t("tooltip.amount"), value: `${a.text} ${symbol}`, mono: true, ...(moreExact(a.text, a.full) && { sub: `${a.full} ${symbol}` }) });
  }
  lines.push({ label: t("tooltip.seq"), value: circled(f.seq) });
  lines.push({ label: t("tooltip.flowKind"), value: t(`tooltip.flowKind.${f.kind}` as MsgKey) });
  return lines;
}
