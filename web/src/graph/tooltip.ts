import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import { t, type MsgKey } from "../i18n";
import { shortAddr } from "../lib/address";
import { formatFixed } from "../lib/amount";
import { NATIVE_SYMBOL } from "../lib/assets";
import { formatCount, formatLocalTime, formatTime } from "../lib/format";
import type { VisualEdge } from "./visualEdges";

export interface TooltipLine {
  label?: string;
  value: string;
  mono?: boolean;
  /** Hover text of the value (the local time next to a UTC one). */
  title?: string;
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
  const cat = n.labels[0]?.category;
  if (cat) lines.push({ label: t("tooltip.category"), value: CATEGORIES.has(cat) ? t(`category.${cat}` as MsgKey) : cat });

  if (n.partial) lines.push({ label: t("tooltip.sync"), value: t("tooltip.partial") });
  else if (n.syncing) lines.push({ label: t("tooltip.sync"), value: t("tooltip.syncing") });
  else if (n.synced) {
    const at = latestSync(extra.coverage);
    lines.push(
      at
        ? { label: t("tooltip.sync"), value: t("tooltip.synced", { time: formatTime(at) }), title: formatLocalTime(at) }
        : { label: t("tooltip.sync"), value: t("tooltip.synced", { time: "?" }) },
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
    lines.push({ label: t("tooltip.balance"), value: `${b.text} ${NATIVE_SYMBOL}`, mono: true, title: `${b.full} ${NATIVE_SYMBOL}` });
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
