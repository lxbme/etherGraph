import type { JobDto } from "../api/generated/JobDto";
import { t } from "../i18n";
import { shortAddr } from "../lib/address";
import { formatCount } from "../lib/format";
import type { JobProgressEvent } from "./statusStore";

const KINDS: ReadonlySet<string> = new Set(["sync_address", "fetch_tx", "contract_meta", "resolve_names", "token_meta"]);
const STATUSES: ReadonlySet<string> = new Set(["pending", "running", "paused_quota", "done", "failed", "cancelled"]);

/** Localised job kind; an unknown kind from a newer server is shown as-is. */
export function kindName(kind: JobDto["kind"]): string {
  return KINDS.has(kind) ? t(`job.kind.${kind}`) : kind;
}

export function statusName(status: JobDto["status"]): string {
  return STATUSES.has(status) ? t(`job.status.${status}`) : status;
}

/** Human-readable target of a job; params are read defensively (unknown shape gives "—"). */
export function targetText(job: Pick<JobDto, "kind" | "params">): string {
  const p = job.params;
  const obj = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  if (job.kind === "sync_address") {
    if (typeof obj?.address !== "string") return "—";
    return shortAddr(obj.address) + (obj.direction === "older" ? t("job.older") : "");
  }
  if (job.kind === "fetch_tx") return typeof obj?.hash === "string" ? shortAddr(obj.hash) : "—";
  const list = Array.isArray(p) ? p : obj ? Object.values(obj).find(Array.isArray) : undefined;
  return list ? t("job.targetList", { count: list.length }) : "—";
}

/** Status bar text for the most recent progress event; `job` (if known) supplies the target. */
export function progressText(e: JobProgressEvent, job?: Pick<JobDto, "kind" | "params">): string {
  const kind = kindName(e.kind);
  if (e.kind === "sync_address") {
    const target = job ? ` ${targetText(job)}` : "";
    return `${kind}${target} · ${t("job.fetched", { count: formatCount(e.fetched) })}`;
  }
  return `${kind} · ${statusName(e.status)}`;
}
