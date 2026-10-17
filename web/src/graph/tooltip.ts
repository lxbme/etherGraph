import type { FlowDto } from "../api/generated/FlowDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import { t, type MsgKey } from "../i18n";
import { shortAddr } from "../lib/address";
import { formatFixed } from "../lib/amount";
import { assetClass, NATIVE_SYMBOL } from "../lib/assets";
import { formatCount, formatLocalTime, formatTime } from "../lib/format";
import type { VisualEdge } from "./visualEdges";

export interface TooltipLine {
  label?: string;
  value: string;
  mono?: boolean;
  /** Muted secondary text after the value (tooltips cannot show `title` hovers). */
  sub?: string;
}

const CATEGORIES = new Set(["exchange", "defi", "bridge", "mixer", "scam", "sanctioned", "other"]);

/** The newest `last_synced_at` among the coverage rows, as an ISO string. */
function latestSync(coverage: SyncStatusDto[] | undefined): string | null {
  let best: string | null = null;
  for (const c of coverage ?? []) {
    if (c.last_synced_at && (best === null || new Date(c.last_synced_at) > new Date(best))) best = c.last_synced_at;
  }
  return best;
}

/** The exact amount has digits the zero-padded fixed display cut off. */
const moreExact = (text: string, full: string) =>
  (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text) !== full;

export function nodeTooltip(
  n: NodeSummaryDto,
  extra: { coverage?: SyncStatusDto[]; omitted?: number; degree?: number },
): TooltipLine[] {
  const lines: TooltipLine[] = [];
  lines.push(
    n.display_name
      ? { label: t("tooltip.name"), value: n.display_name }
      : { label: t("tooltip.name"), value: shortAddr(n.address.toLowerCase()), mono: true },
  );
  lines.push({ label: t("tooltip.type"), value: t(`node.kind.${n.kind}`) });
  const cats = [...new Set(n.labels.map((l) => l.category))].map((c) => (CATEGORIES.has(c) ? t(`category.${c}` as MsgKey) : c));
  if (cats.length > 0) lines.push({ label: t("tooltip.category"), value: cats.join(", ") });

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
  return lines;
}

export function edgeTooltip(v: VisualEdge): TooltipLine[] {
  const lines: TooltipLine[] = [
    { label: t("tooltip.direction"), value: `${shortAddr(v.from)} → ${shortAddr(v.to)}`, mono: true },
  ];
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

export function callTooltip(): TooltipLine[] {
  return [{ value: t("tooltip.call") }];
}

export function moreTooltip(count: number): TooltipLine[] {
  return [{ value: t("tooltip.more", { count }) }, { value: t("tooltip.moreHint") }];
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

/** One tx-flow transfer; `names` maps lower-case addresses to display names. */
export function flowTooltip(f: FlowDto, names: Map<string, string>): TooltipLine[] {
  const nm = (a: string) => names.get(a.toLowerCase()) ?? shortAddr(a.toLowerCase());
  const symbol = f.asset === null ? NATIVE_SYMBOL : (f.symbol ?? shortAddr(f.asset.toLowerCase()));
  const nft = f.kind === "erc721" || f.kind === "erc1155";
  const lines: TooltipLine[] = [
    { label: t("tooltip.direction"), value: `${nm(f.from)} → ${nm(f.to)}` },
    { label: t("tooltip.asset"), value: symbol },
  ];
  if (nft && f.token_id !== null) {
    lines.push({ label: t("tooltip.amount"), value: `#${f.token_id} × ${formatFixed(f.amount, 0, "nft").text}`, mono: true });
  } else {
    const a = formatFixed(f.amount, f.decimals, assetClass(f.asset, f.kind));
    lines.push({ label: t("tooltip.amount"), value: `${a.text} ${symbol}`, mono: true, ...(moreExact(a.text, a.full) && { sub: `${a.full} ${symbol}` }) });
  }
  lines.push({ label: t("tooltip.seq"), value: f.seq >= 1 && f.seq <= 20 ? CIRCLED[f.seq - 1]! : `(${f.seq})` });
  lines.push({ label: t("tooltip.flowKind"), value: t(`tooltip.flowKind.${f.kind}` as MsgKey) });
  return lines;
}
