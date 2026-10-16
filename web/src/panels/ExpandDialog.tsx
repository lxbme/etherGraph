import { useEffect, useMemo, useState } from "react";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { useGraph } from "../graph/store";
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

  // One dry run for all neighbours, one status fetch, both on open.
  useEffect(() => {
    let alive = true;
    const addresses = neighbors.map((n) => lc(n.address));
    api
      .sync({ addresses, dry_run: true })
      .then((r) => {
        if (!alive) return;
        const per: Record<string, number> = {};
        for (const [k, v] of Object.entries(r.per_address ?? {})) per[lc(k)] = v;
        setPerAddress(per);
      })
      .catch((err) => {
        if (alive) toast(messageFor(err), "error");
      });
    api
      .status()
      .then((s) => {
        if (alive && s.rate > 0) setRate(s.rate);
      })
      .catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
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
    if (addresses.length === 0) return;
    setBusy(true);
    try {
      await api.sync({ addresses });
      for (const a of addresses) useGraph.getState().addCenter(a);
      toast(`已开始同步 ${addresses.length} 个地址`);
      onClose();
    } catch (err) {
      toast(messageFor(err), "error");
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="展开邻居"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="dialog__title">展开邻居（{neighbors.length}）</h3>
        <ul className="dialog__list">
          {neighbors.map((n) => {
            const addr = lc(n.address);
            const c = perAddress?.[addr];
            return (
              <li key={addr}>
                <label className="dialog__row">
                  <input type="checkbox" checked={checked.has(addr)} onChange={() => toggle(addr)} />
                  <span className="dialog__name">{n.display_name ?? shortAddr(addr)}</span>
                  {n.hot && <span className="dialog__tag">热门</span>}
                  <span className="dialog__calls">
                    {perAddress == null ? "…" : c === 0 ? "已同步" : `${c ?? 0} 次`}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="dialog__summary">
          {perAddress == null
            ? "估算中…"
            : `预计 ${calls} 次调用 · 约 ${seconds} 秒${remaining != null ? ` · 今日剩余额度 ${remaining}` : ""}`}
        </div>
        <div className="dialog__actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="button" disabled={checked.size === 0 || busy} onClick={confirm}>开始同步</button>
        </div>
      </div>
    </div>
  );
}
