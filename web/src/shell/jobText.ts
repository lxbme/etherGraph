import type { JobDto } from "../api/generated/JobDto";
import { type MsgKey, t } from "../i18n";
import { shortAddr } from "../lib/address";
import type { JobProgressEvent } from "./statusStore";

// Typed against the DTO unions, so a new kind/status from the server fails to compile until it has a key.
const KINDS: Record<JobDto["kind"], MsgKey> = {
  sync_address: "job.kind.sync_address",
  fetch_tx: "job.kind.fetch_tx",
  contract_meta: "job.kind.contract_meta",
  resolve_names: "job.kind.resolve_names",
  token_meta: "job.kind.token_meta",
  fetch_block: "job.kind.fetch_block",
  fetch_trace: "job.kind.fetch_trace",
  fetch_nft: "job.kind.fetch_nft",
};
const STATUSES: Record<JobDto["status"], MsgKey> = {
  pending: "job.status.pending",
  running: "job.status.running",
  paused_quota: "job.status.paused_quota",
  paused_user_quota: "job.status.paused_user_quota",
  done: "job.status.done",
  failed: "job.status.failed",
  cancelled: "job.status.cancelled",
};

/** Localised job kind; a value outside the DTO union (a newer server at runtime) is shown as-is. */
export function kindName(kind: JobDto["kind"]): string {
  const key = Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
  return key ? t(key) : kind;
}

export function statusName(status: JobDto["status"]): string {
  const key = Object.hasOwn(STATUSES, status) ? STATUSES[status] : undefined;
  return key ? t(key) : status;
}

/** Human-readable target of a job; params are read defensively (unknown shape gives "—"). */
export function targetText(job: Pick<JobDto, "kind" | "params">): string {
  const p = job.params;
  const obj = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  if (job.kind === "sync_address") {
    if (typeof obj?.address !== "string") return "—";
    return shortAddr(obj.address) + (obj.direction === "older" ? t("job.older") : "");
  }
  if (job.kind === "fetch_tx" || job.kind === "fetch_trace") return typeof obj?.hash === "string" ? shortAddr(obj.hash) : "—";
  if (job.kind === "fetch_nft") {
    return typeof obj?.token === "string" && typeof obj.token_id === "string" ? `${shortAddr(obj.token)} #${obj.token_id}` : "—";
  }
  const list = Array.isArray(p) ? p : obj ? Object.values(obj).find(Array.isArray) : undefined;
  return list ? t("job.targetList", { count: list.length }) : "—";
}

/** Status bar text for the most recent progress event; `job` (if known) supplies the target. */
export function progressText(e: JobProgressEvent, job?: Pick<JobDto, "kind" | "params">): string {
  const kind = kindName(e.kind);
  if (e.kind === "sync_address") {
    const target = job ? ` ${targetText(job)}` : "";
    return `${kind}${target} · ${t("job.fetched", { count: e.fetched })}`;
  }
  return `${kind} · ${statusName(e.status)}`;
}
