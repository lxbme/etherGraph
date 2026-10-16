import type { JobDto } from "../api/generated/JobDto";
import { shortAddr } from "../lib/address";
import { formatCount } from "../lib/format";
import type { JobProgressEvent } from "./statusStore";

export const KIND_NAMES: Record<JobDto["kind"], string> = {
  sync_address: "同步地址",
  fetch_tx: "抓取交易",
  contract_meta: "合约信息",
  resolve_names: "ENS 解析",
  token_meta: "代币信息",
};

export const STATUS_NAMES: Record<JobDto["status"], string> = {
  pending: "排队中",
  running: "进行中",
  paused_quota: "额度暂停",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
};

/** Human-readable target of a job; params are read defensively (unknown shape gives "—"). */
export function targetText(job: Pick<JobDto, "kind" | "params">): string {
  const p = job.params;
  const obj = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  if (job.kind === "sync_address") {
    if (typeof obj?.address !== "string") return "—";
    return shortAddr(obj.address) + (obj.direction === "older" ? "（更早）" : "");
  }
  if (job.kind === "fetch_tx") return typeof obj?.hash === "string" ? shortAddr(obj.hash) : "—";
  const list = Array.isArray(p) ? p : obj ? Object.values(obj).find(Array.isArray) : undefined;
  return list ? `${list.length} 个地址/代币` : "—";
}

/** Status bar text for the most recent progress event; `job` (if known) supplies the target. */
export function progressText(e: JobProgressEvent, job?: Pick<JobDto, "kind" | "params">): string {
  const kind = KIND_NAMES[e.kind] ?? e.kind;
  if (e.kind === "sync_address") {
    const target = job ? ` ${targetText(job)}` : "";
    return `${kind}${target} · 已取 ${formatCount(e.fetched)} 条`;
  }
  return `${kind} · ${STATUS_NAMES[e.status] ?? e.status}`;
}
