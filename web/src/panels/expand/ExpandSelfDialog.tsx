import { useEffect, useRef, useState } from "react";
import { messageFor } from "../../api/errors";
import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { nodeCapacity, SHALLOW_CALLS } from "../../graph/budget";
import { useCanvasMetrics } from "../../graph/canvasMetrics";
import type { TargetEstimate } from "../../graph/estimate";
import { firstBatchFor, MAX_NEIGHBOUR_LIMIT, useGraph } from "../../graph/store";
import { useT } from "../../i18n";
import { shortAddr } from "../../lib/address";
import { useQuota } from "../../shell/statusStore";
import { expandSelf } from "./expandSelf";
import { useExpandEstimate } from "./useExpandEstimate";

const lc = (s: string) => s.toLowerCase();

const nameOf = (n: NodeSummaryDto) => n.display_name ?? n.ens ?? n.contract_name ?? shortAddr(lc(n.address));

/** The stepper's value as a neighbour limit, or null when it is not a whole number in 1..=MAX_NEIGHBOUR_LIMIT. */
function parseK(s: string): number | null {
  const n = Number(s);
  return s.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= MAX_NEIGHBOUR_LIMIT ? n : null;
}

/** One target's estimate as sentences: a range until a pending target is synced, else its counterparty split. */
function facts(row: TargetEstimate, summary: NodeSummaryDto | undefined, k: number, t: ReturnType<typeof useT>): string[] {
  const out: string[] = [];
  if (row.pending) {
    out.push(
      row.upper > row.fresh
        ? t("expandSelf.row.range", { min: row.fresh, max: row.upper })
        : t("expandSelf.row.fresh", { count: row.fresh }),
    );
    out.push(t("expandSelf.row.onCanvas", { count: row.onCanvas }));
    if (summary?.nonce != null) out.push(t("expandSelf.row.nonce", { count: summary.nonce }));
  } else {
    out.push(t("expandSelf.row.total", { count: row.total }));
    out.push(t("expandSelf.row.onCanvas", { count: row.onCanvas }));
    out.push(t("expandSelf.row.fresh", { count: row.fresh }));
    if (row.remaining > 0) out.push(t("expandSelf.row.remaining", { count: row.remaining }));
  }
  // The server ranks canvas neighbours first: they take slots of the batch (spec §4).
  if (row.fresh < k && row.onCanvas > 0) out.push(t("expandSelf.slotsUsed", { count: row.onCanvas }));
  return out;
}

/**
 * Confirm dialog of a single-layer expansion (spec §3–§4): makes `targets` centers with a per-address limit k,
 * showing how many nodes that adds (a dry run against the current canvas), the sync calls of unsynced targets
 * and the canvas size after. Budgets are soft: going over warns, never blocks; Expand works while estimating.
 */
export function ExpandSelfDialog({ targets, data, onClose }: { targets: NodeSummaryDto[]; data: GraphResponseDto; onClose(): void }) {
  const t = useT();
  const many = targets.length > 1;
  const title = many ? t("expandSelf.titleMany", { count: targets.length }) : t("expandSelf.title", { name: nameOf(targets[0]!) });
  const [k, setK] = useState(() => firstBatchFor(targets.length));
  const [draft, setDraft] = useState(() => String(k));
  const invalid = parseK(draft) === null;
  const { estimate, loading, error } = useExpandEstimate({ targets, k, data });
  const quota = useQuota((s) => s.quota);
  const metrics = useCanvasMetrics();
  const [submitting, setSubmitting] = useState(false);
  const alive = useRef(true);
  /** A confirm is in flight: no second submit, and the dialog cannot be closed until it settles. */
  const submittingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !submittingRef.current && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      alive.current = false;
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summaries = new Map(targets.map((n) => [lc(n.address), n]));
  const pendingCount = targets.filter((n) => !n.synced || n.syncing).length;
  const syncCount = targets.filter((n) => !n.synced && !n.syncing).length;
  const calls = syncCount * SHALLOW_CALLS;
  const quotaLeft = quota ? Math.max(quota.limit - quota.used, 0) : null;
  const capacity = nodeCapacity(metrics);
  const after = estimate ? metrics.visible + estimate.max : null;

  const onDraft = (v: string) => {
    setDraft(v);
    const n = parseK(v);
    if (n !== null) setK(n);
  };

  const confirm = async () => {
    if (submittingRef.current || invalid) return;
    // A snapshot asks to go live first; that question replaces this dialog.
    const deferred = !!useGraph.getState().frozen;
    submittingRef.current = true;
    setSubmitting(true);
    const done = await expandSelf(targets, k);
    submittingRef.current = false;
    if (done || deferred) onClose();
    else if (alive.current) setSubmitting(false);
  };

  let headline: string | null = null;
  if (estimate && !loading) {
    headline =
      estimate.min === estimate.max
        ? t("expandSelf.headline", { count: estimate.min })
        : t("expandSelf.headlineRange", { min: estimate.min, max: estimate.max });
  } else if (loading || error == null) {
    headline = t("expandSelf.estimating");
  }

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && !submittingRef.current && onClose()}>
      <div className="dialog expand-self" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        <h3 className="dialog__title">{title}</h3>
        <div aria-live="polite">
          {headline && <div className="expand-self__headline">{headline}</div>}
          {pendingCount > 0 && <div className="dialog__summary">{t("expandSelf.pendingNote", { count: pendingCount })}</div>}
          {error != null && !loading && <div className="dialog__error" role="alert">{messageFor(error)}</div>}
        </div>
        <label className="expand-self__batch">
          <span>{t("expandSelf.batch")}</span>
          <input
            className="input input--compact num expand-self__k"
            type="number"
            min={1}
            max={MAX_NEIGHBOUR_LIMIT}
            step={1}
            value={draft}
            aria-invalid={invalid}
            onChange={(e) => onDraft(e.target.value)}
          />
        </label>
        {estimate && (
          <div className="expand-self__estimate" aria-busy={loading}>
            {many ? (
              <div className="expand-self__table">
                <table className="table table--inset">
                  <tbody>
                    {estimate.targets.map((row) => {
                      const summary = summaries.get(row.address);
                      return (
                        <tr key={row.address}>
                          <td title={row.address}>{summary ? nameOf(summary) : shortAddr(row.address)}</td>
                          <td>{facts(row, summary, k, t).join(" · ")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              estimate.targets[0] && (
                <ul className="expand-self__facts">
                  {facts(estimate.targets[0], targets[0], k, t).map((f) => <li key={f}>{f}</li>)}
                </ul>
              )
            )}
          </div>
        )}
        <div className="expand-self__lines">
          {syncCount === 0 ? (
            <span>{t("expandSelf.noCalls")}</span>
          ) : (
            <span>{t("expandSelf.calls", { count: syncCount, calls })}</span>
          )}
          {quotaLeft != null && <span>{t("expandSelf.quotaLeft", { count: quotaLeft })}</span>}
          {after != null && <span className="expand-self__canvas">{t("expandSelf.canvas", { after, capacity })}</span>}
        </div>
        <div className="expand__warnings" aria-live="polite">
          {quotaLeft != null && calls > quotaLeft && <div className="dialog__warn">{t("expand.overQuota")}</div>}
          {after != null && after > capacity && <div className="dialog__warn">{t("expandSelf.overCanvas")}</div>}
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" disabled={submitting} onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="btn btn--primary" disabled={invalid || submitting} onClick={confirm}>
            {t("expand.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
