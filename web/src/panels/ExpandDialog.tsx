import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { shortAddr } from "../lib/address";
import { useQuota } from "../shell/statusStore";
import { toast } from "../shell/Toasts";

const FALLBACK_RATE = 2.8;
const lc = (s: string) => s.toLowerCase();

export interface ExpandDialogProps {
  /** All neighbours of the node being expanded. */
  neighbors: NodeSummaryDto[];
  /** When given, only these start checked (top-K); otherwise every non-hot neighbour does. */
  preChecked?: string[];
  onClose(): void;
}

/** Cost-confirmation dialog for expanding neighbours: one dry run up front, totals recomputed locally. */
export function ExpandDialog({ neighbors, preChecked, onClose }: ExpandDialogProps) {
  const [checked, setChecked] = useState<Set<string>>(() => {
    const pre = preChecked ? new Set(preChecked.map(lc)) : null;
    return new Set(
      neighbors.filter((n) => (pre ? pre.has(lc(n.address)) : !n.hot)).map((n) => lc(n.address)),
    );
  });
  const [perAddress, setPerAddress] = useState<Record<string, number> | null>(null);
  const [rate, setRate] = useState(FALLBACK_RATE);
  const [busy, setBusy] = useState(false);
  const quota = useQuota((s) => s.quota);
  const t = useT();

  // The raw error, translated at render time so a language switch re-renders it.
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const aliveRef = useRef(true);
  const dialogRef = useRef<HTMLDivElement>(null);

  const runDry = useCallback(() => {
    setError(null);
    const addresses = neighbors.map((n) => lc(n.address));
    api
      .sync({ addresses, dry_run: true })
      .then((r) => {
        if (!aliveRef.current) return;
        const per: Record<string, number> = {};
        for (const [k, v] of Object.entries(r.per_address ?? {})) per[lc(k)] = v;
        setPerAddress(per);
      })
      .catch((err) => {
        if (aliveRef.current) setError({ cause: err });
      });
  }, [neighbors]);

  // One dry run for all neighbours (retryable), one status fetch, both on open.
  useEffect(() => {
    aliveRef.current = true;
    runDry();
    api
      .status()
      .then((s) => {
        if (aliveRef.current && s.rate > 0) setRate(s.rate);
      })
      .catch(() => {});
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      aliveRef.current = false;
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const calls = useMemo(() => {
    if (!perAddress) return 0;
    let sum = 0;
    for (const a of checked) sum += perAddress[a] ?? 0;
    return sum;
  }, [perAddress, checked]);
  const seconds = Math.ceil(calls / rate);
  const remaining = quota ? Math.max(quota.limit - quota.used, 0) : null;

  const toggle = (addr: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (!next.delete(addr)) next.add(addr);
      return next;
    });

  const confirm = async () => {
    const addresses = neighbors.map((n) => lc(n.address)).filter((a) => checked.has(a));
    if (addresses.length === 0 || perAddress == null) return;
    setBusy(true);
    try {
      await api.sync({ addresses });
      useGraph.getState().setCenters([...useGraph.getState().centers, ...addresses]);
      toast(t("expand.started", { count: addresses.length }));
      onClose();
    } catch (err) {
      toast(messageFor(err), "error");
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t("expand.label")} tabIndex={-1} ref={dialogRef}>
        <h3 className="dialog__title">{t("expand.title", { count: neighbors.length })}</h3>
        <ul className="dialog__list">
          {neighbors.map((n) => {
            const addr = lc(n.address);
            const c = perAddress?.[addr];
            return (
              <li key={addr}>
                <label className="dialog__row">
                  <input type="checkbox" checked={checked.has(addr)} onChange={() => toggle(addr)} />
                  <span className="dialog__name">{n.display_name ?? shortAddr(addr)}</span>
                  {n.hot && <span className="dialog__tag">{t("expand.hot")}</span>}
                  <span className="dialog__calls">
                    {perAddress == null ? "…" : c === undefined ? "—" : c === 0 ? t("expand.synced") : t("expand.calls", { count: c })}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="dialog__summary">
          {error != null ? (
            <>
              <span role="alert">{messageFor(error.cause)}</span>{" "}
              <button type="button" className="btn btn--compact" onClick={runDry}>{t("common.retry")}</button>
            </>
          ) : perAddress == null
            ? t("expand.estimating")
            : t("expand.estimate", { count: calls, seconds }) +
              (remaining != null ? t("expand.quotaLeft", { remaining }) : "")}
        </div>
        {/* A warning only: the sync still runs, pausing when the quota is used up. */}
        {error == null && perAddress != null && remaining != null && calls > remaining && (
          <div className="dialog__warn" role="alert">{t("expand.overQuota")}</div>
        )}
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="btn btn--primary" disabled={perAddress == null || error != null || checked.size === 0 || busy} onClick={confirm}>{t("expand.start")}</button>
        </div>
      </div>
    </div>
  );
}
