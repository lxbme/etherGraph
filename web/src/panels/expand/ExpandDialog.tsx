import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { ProbeItemDto } from "../../api/generated/ProbeItemDto";
import type { SyncStatusDto } from "../../api/generated/SyncStatusDto";
import { statusQuery } from "../../api/statusQuery";
import {
  byLightness,
  callBudget,
  defaultSelection,
  heavySet,
  nodeBudget,
  nodeCapacity,
  perCenterBatch,
  SHALLOW_CALLS,
  usage,
  weight,
} from "../../graph/budget";
import { useCanvasMetrics } from "../../graph/canvasMetrics";
import { useGraph } from "../../graph/store";
import { graphQueryKey } from "../../graph/useGraphData";
import { t as tr, useT } from "../../i18n";
import { shortAddr } from "../../lib/address";
import { newBatchId } from "../../lib/batchId";
import { formatCount } from "../../lib/format";
import { useQuota } from "../../shell/statusStore";
import { dismissToast, toast } from "../../shell/Toasts";
import { CandidateList, type CandidateRow } from "./CandidateList";
import { useProbe } from "./useProbe";
import { useSyncOnOpen } from "./useSyncOnOpen";

/** Permits per second assumed until /api/status answers. */
const FALLBACK_RATE = 2.8;
/** The candidate list: the node's stored counterparties, fewest transfers first. */
const CANDIDATE_QUERY = { sort: "count_asc", limit: 1000, kind: "all" } as const;
/** Most addresses one POST /api/sync accepts. */
const SYNC_MAX = 50;

const lc = (s: string) => s.toLowerCase();

export interface ExpandDialogProps {
  /** The address whose neighbours are expanded. */
  node: NodeSummaryDto;
  /** Candidates picked elsewhere (e.g. a contract's interactions): no counterparties request, all start checked. */
  preset?: string[];
  /** Cancel (or Escape / backdrop). */
  onClose(): void;
  /** After a confirmed expansion; defaults to `onClose`. */
  onDone?(): void;
}

/** A candidate before probing: its summary and its transfer count with the expanded address. */
interface Source {
  address: string;
  summary: NodeSummaryDto;
  /** Null when unknown (preset candidates). */
  count: number | null;
}

/** A summary for an address the cached graph does not know (preset candidates). */
const placeholder = (address: string): NodeSummaryDto => ({
  address, kind: "unknown", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: false, hot: false, identified: false, nonce: null, balance: null,
});

/** The graph result currently on the canvas, if cached. */
function shownGraph(qc: QueryClient): GraphResponseDto | undefined {
  return qc.getQueryData<GraphResponseDto>(graphQueryKey(useGraph.getState()));
}

/**
 * Calls of the candidate's shallow sync: none when every category is synced and not truncated, and (when the
 * cached graph has its coverage) no category failed or never finished. Age-based staleness (the server's
 * stale_after_secs) is not exposed to the frontend, so a synced address whose rows merely aged still counts as 0.
 */
function syncCalls(synced: boolean, partial: boolean, coverage: SyncStatusDto[] | undefined): number {
  const fresh = synced && !partial && (coverage ?? []).every((c) => c.state !== "failed" && c.last_synced_at != null);
  return fresh ? 0 : SHALLOW_CALLS;
}

/** Probe facts override the summary; `coverage` comes from the cached graph when the candidate is on it. */
function toRow(
  s: Source,
  probe: ProbeItemDto | undefined,
  onCanvas: boolean,
  coverage: SyncStatusDto[] | undefined,
): Omit<CandidateRow, "heavy"> {
  const nonce = probe ? probe.nonce : s.summary.nonce;
  const synced = probe?.synced ?? s.summary.synced;
  const partial = probe?.partial ?? s.summary.partial;
  return {
    address: s.address,
    displayName: s.summary.display_name,
    count: s.count,
    nonce,
    balance: probe ? probe.balance : s.summary.balance,
    cand: {
      address: s.address,
      kind: probe?.kind ?? s.summary.kind,
      hot: s.summary.hot,
      onCanvas,
      calls: syncCalls(synced, partial, coverage),
      weight: weight({ nonce, localTransfers: probe?.local_transfers ?? s.count ?? 0 }),
      withCenter: s.count ?? 0,
    },
  };
}

const byWeight = (x: CandidateRow, y: CandidateRow) => byLightness(x.cand, y.cand);

/**
 * Shows the expansion as one undoable step: "Expanded N · Undo" with no timer, until another history step
 * replaces it or the user closes it.
 */
function offerUndo(count: number): void {
  const past = useGraph.getState()._past;
  const entry = past[past.length - 1];
  if (!entry) return;
  const isTop = (p: typeof past) => p[p.length - 1] === entry;
  let id = 0;
  const unsubscribe = useGraph.subscribe((s) => {
    if (!isTop(s._past)) dismissToast(id);
  });
  id = toast(tr("expand.done", { count }), "info", {
    ttlMs: null,
    onDismiss: unsubscribe,
    action: {
      label: tr("common.undo"),
      onClick: () => {
        if (isTop(useGraph.getState()._past)) useGraph.getState().undo();
      },
    },
  });
}

function BudgetBar({ label, used, budget }: { label: string; used: number; budget: number }) {
  const scale = Math.max(used, budget, 1);
  const within = Math.min(used, budget);
  const over = Math.max(0, used - budget);
  return (
    <>
      <span className="expand__meter-label">{label}</span>
      <div
        className="meter"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.max(used, budget)}
        aria-valuenow={used}
        aria-valuetext={`${formatCount(used)} / ${formatCount(budget)}`}
      >
        <div className="meter__fill" style={{ width: `${(within / scale) * 100}%` }} />
        {over > 0 && <div className="meter__over" style={{ width: `${(over / scale) * 100}%` }} />}
      </div>
      <span className={`num expand__meter-value${over > 0 ? " expand__meter-value--over" : ""}`}>
        {formatCount(used)} / {formatCount(budget)}
      </span>
    </>
  );
}

/**
 * Expansion dialog (spec §5.3–5.5): candidates from the stored counterparties (or `preset`), probed in chunks,
 * light wallets first; the lightest non-heavy wallets that fit the node and call budgets start checked.
 * Budgets are soft: going over warns, never blocks. Confirming syncs shallow under a new batch and expands
 * as one undoable step.
 */
export function ExpandDialog({ node, preset, onClose, onDone = onClose }: ExpandDialogProps) {
  const t = useT();
  const qc = useQueryClient();
  const self = lc(node.address);
  const title = t("expand.title", { name: node.display_name ?? shortAddr(self) });

  // What the canvas shows when the dialog opens: preset summaries and which candidates are already on it.
  const [shown] = useState(() => {
    const g = shownGraph(qc);
    const ui = useGraph.getState().ui;
    const summaries = new Map((g?.nodes ?? []).map((n) => [lc(n.address), n]));
    const onCanvas = new Set([...summaries.keys()].filter((a) => !ui[a]?.hidden));
    const coverage = new Map(Object.entries(g?.coverage ?? {}).map(([a, c]) => [lc(a), c]));
    return { summaries, onCanvas, coverage };
  });

  // Preset picks, minus the node itself and current centers: an expansion's Undo cancels its batch, which must
  // not stop a sync an existing center started.
  const [presetSources] = useState<Source[] | null>(() => {
    if (!preset) return null;
    const centers = new Set(useGraph.getState().centers.map(lc));
    return [...new Set(preset.map(lc))]
      .filter((a) => a !== self && !centers.has(a))
      .map((a) => ({ address: a, summary: shown.summaries.get(a) ?? placeholder(a), count: null }));
  });
  // Prefix ["counterparties", self]: refetched on AddressDataChanged for the node (see useEvents).
  const counterparties = useQuery({
    queryKey: ["counterparties", self, CANDIDATE_QUERY],
    queryFn: () => api.counterparties(self, CANDIDATE_QUERY),
    enabled: !preset,
  });
  // An unsynced node has no stored counterparties yet: sync it (shallow) and reload when its job ends.
  const syncing = useSyncOnOpen(node, () => void counterparties.refetch(), !preset);
  const page = counterparties.data;
  const sources = useMemo((): Source[] | null => {
    if (presetSources) return presetSources;
    if (!page) return null;
    const centers = new Set(useGraph.getState().centers.map(lc));
    const out: Source[] = [];
    for (const c of page.items) {
      const a = lc(c.node.address);
      if (a !== self && !centers.has(a)) out.push({ address: a, summary: c.node, count: c.count });
    }
    return out;
  }, [presetSources, page, self]);
  const [submitting, setSubmitting] = useState(false);
  const [manual, setManual] = useState<Set<string> | null>(() =>
    presetSources ? new Set(presetSources.map((s) => s.address)) : null,
  );
  // Collapsed by default; open for a preset, whose contracts were picked by hand and start checked.
  const [contractsOpen, setContractsOpen] = useState(!!preset);
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

  // Known contracts are never probed; the rest in count-ascending order (the order counterparties came in).
  const order = useMemo(
    () => (sources ?? []).filter((s) => s.summary.kind !== "contract").map((s) => s.address),
    [sources],
  );
  const probe = useProbe(order);

  // Budgets: refetch the status on open (rate, queue); quota from the status store.
  const status = useQuery({ ...statusQuery, refetchOnMount: "always" }).data;
  const quota = useQuota((s) => s.quota);
  const metrics = useCanvasMetrics();
  const rate = status?.rate ?? FALLBACK_RATE;
  const queued = status?.queued_calls ?? 0;
  const quotaLeft = quota ? Math.max(quota.limit - quota.used, 0) : null;
  const budget = useMemo(
    () => ({
      nodes: nodeBudget(nodeCapacity(metrics), metrics.visible),
      calls: callBudget({ rate, queuedCalls: queued, quotaRemaining: quotaLeft }),
    }),
    [metrics, rate, queued, quotaLeft],
  );

  const rows = useMemo(() => {
    const base = (sources ?? []).map((s) =>
      toRow(s, probe.items.get(s.address), shown.onCanvas.has(s.address), shown.coverage.get(s.address)),
    );
    // Heavy is judged among measured weights only: count-based estimates are on another scale (ruling R14).
    const heavy = heavySet(new Map(base.filter((r) => !r.cand.weight.estimated).map((r) => [r.address, r.cand.weight.value])));
    return base.map((r): CandidateRow => ({ ...r, heavy: heavy.has(r.address) }));
  }, [sources, probe.items, shown]);
  const wallets = useMemo(() => rows.filter((r) => r.cand.kind !== "contract").sort(byWeight), [rows]);
  const contracts = useMemo(() => rows.filter((r) => r.cand.kind === "contract"), [rows]);

  // Defaults come from measured weights only (probe or cached nonce): an estimate from the transfer count with
  // the center is not comparable with log(nonce) and could pick an unprobed exchange (ruling R14). Estimated
  // rows are unprobed ones (only contracts lack a nonce after probing, and those are never defaults).
  const measured = useMemo(() => rows.filter((r) => !r.cand.weight.estimated), [rows]);
  const defaults = useMemo(
    () => new Set(defaultSelection(measured.map((r) => r.cand), budget).selected),
    [measured, budget],
  );
  // Until the user changes a box, the checks follow the default selection as probe results arrive.
  const checked = manual ?? defaults;
  const toggle = (a: string) => {
    const next = new Set(checked);
    if (!next.delete(a)) next.add(a);
    setManual(next);
  };

  // Spec §5.3 (ruling R14): probe on while the defaults are starved (they take every eligible probed wallet: not
  // limited by the budget yet); once they are budget-limited, probe exactly one more chunk, then stop. Further
  // chunks only via "Probe more"; a failed chunk also waits for it.
  const eligible = (r: CandidateRow) => r.cand.kind !== "contract" && !r.cand.hot && !r.heavy;
  const starved = measured.filter(eligible).every((r) => defaults.has(r.address));
  const autoProbe = !preset && probe.remaining > 0 && probe.error == null;
  const extraChunkSent = useRef(false);
  const { busy: probing, more, items: probedItems } = probe;
  // `probedItems`: a whole chunk can land within one render, leaving the other inputs unchanged.
  useEffect(() => {
    if (!autoProbe || probing) return;
    if (starved) more();
    else if (!extraChunkSent.current && more()) extraChunkSent.current = true;
  }, [autoProbe, starved, probing, probedItems, more]);

  const selected = useMemo(
    () => [...wallets, ...contracts].filter((r) => checked.has(r.address)),
    [wallets, contracts, checked],
  );
  const used = usage(selected.map((r) => r.cand), budget);
  const seconds = rate > 0 ? String(Math.ceil((queued + used.calls) / rate)) : "?";
  const noDefaults = sources != null && sources.length > 0 && !rows.some(eligible) && checked.size === 0;

  const confirm = async () => {
    const addresses = selected.map((r) => r.address);
    if (addresses.length === 0 || submittingRef.current) return;
    const batch = newBatchId();
    submittingRef.current = true;
    setSubmitting(true);
    const chunks: string[][] = [];
    for (let i = 0; i < addresses.length; i += SYNC_MAX) chunks.push(addresses.slice(i, i + SYNC_MAX));
    const results = await Promise.allSettled(chunks.map((c) => api.sync({ addresses: c, batch, depth: "shallow" })));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) {
      // Every request has settled, so all jobs the others started belong to the batch: release them.
      api.cancelBatch(batch).catch(() => {});
      toast(messageFor(failed.reason), "error");
      submittingRef.current = false;
      if (alive.current) setSubmitting(false);
      return;
    }
    const newSelf = selected.filter((r) => !r.cand.onCanvas).length;
    useGraph.getState().expand(addresses, batch, perCenterBatch(budget.nodes, addresses.length, newSelf));
    offerUndo(addresses.length);
    onDone();
  };

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && !submittingRef.current && onClose()}>
      <div className="dialog expand" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        <h3 className="dialog__title">{title}</h3>
        <div className="expand__budget">
          <BudgetBar label={t("expand.budget.nodes")} used={used.nodes} budget={budget.nodes} />
          <BudgetBar label={t("expand.budget.calls")} used={used.calls} budget={budget.calls} />
        </div>
        {syncing && (sources == null || sources.length === 0) && (
          <div className="dialog__summary">{t("expand.syncing")}</div>
        )}
        {sources == null ? (
          counterparties.isError ? (
            <div className="dialog__error" role="alert">
              {messageFor(counterparties.error)}{" "}
              <button type="button" className="btn btn--compact" onClick={() => void counterparties.refetch()}>
                {t("common.retry")}
              </button>
            </div>
          ) : (
            !syncing && <div className="dialog__summary">{t("expand.loading")}</div>
          )
        ) : sources.length === 0 ? (
          !syncing && <div className="dialog__summary">{t("expand.empty")}</div>
        ) : (
          <CandidateList
            wallets={wallets}
            contracts={contracts}
            checked={checked}
            onToggle={toggle}
            contractsOpen={contractsOpen}
            onToggleContracts={() => setContractsOpen((v) => !v)}
          />
        )}
        {sources != null && sources.length > 0 && (
          <div className="expand__footer">
            <span>
              {page && page.total > page.items.length
                ? t("expand.probedOf", { probed: probe.probed, total: order.length, all: formatCount(page.total) })
                : t("expand.probed", { probed: probe.probed, total: order.length })}
            </span>
            <button type="button" className="btn btn--compact" disabled={probe.busy || probe.remaining === 0} onClick={more}>
              {t("expand.probeMore")}
            </button>
            {probe.error != null && <span className="dialog__error" role="alert">{messageFor(probe.error)}</span>}
          </div>
        )}
        {probe.calls > 0 && <div className="dialog__summary">{t("expand.probeCost", { count: probe.calls })}</div>}
        <div className="expand__warnings" aria-live="polite">
          {used.overNodes && <div className="dialog__warn">{t("expand.overNodes", { count: used.nodes - budget.nodes })}</div>}
          {used.overCalls && (
            <div className="dialog__warn">{t("expand.overCalls", { count: used.calls - budget.calls, seconds })}</div>
          )}
          {budget.calls === 0 && queued > 0 && <div className="dialog__warn">{t("expand.queueBusy", { count: queued })}</div>}
          {/* The latest status's quota already includes the probe spend: compare the checked calls only. */}
          {quotaLeft != null && used.calls > quotaLeft && <div className="dialog__warn">{t("expand.overQuota")}</div>}
          {noDefaults && <div className="dialog__warn">{t("expand.none")}</div>}
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" disabled={submitting} onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="btn btn--primary" disabled={checked.size === 0 || submitting} onClick={confirm}>
            {t("expand.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
