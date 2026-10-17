import { ChevronDown, ChevronRight } from "lucide-react";
import type { Candidate } from "../../graph/budget";
import { useT } from "../../i18n";
import { shortAddr } from "../../lib/address";
import { formatFixed } from "../../lib/amount";
import { formatCount } from "../../lib/format";

/** One expansion candidate as shown in the dialog. */
export interface CandidateRow {
  /** Lowercase. */
  address: string;
  displayName: string | null;
  /** Stored transfers with the expanded address; null when unknown (preset candidates). */
  count: number | null;
  /** Outgoing transactions (probe, or the probe cache via the node summary); null when unknown. */
  nonce: number | null;
  /** Wei, decimal; null when unknown. */
  balance: string | null;
  heavy: boolean;
  cand: Candidate;
}

export interface CandidateListProps {
  wallets: CandidateRow[];
  contracts: CandidateRow[];
  checked: ReadonlySet<string>;
  onToggle(address: string): void;
  contractsOpen: boolean;
  onToggleContracts(): void;
}

function Check({ row, checked, onToggle }: { row: CandidateRow; checked: boolean; onToggle(a: string): void }) {
  return (
    <td>
      <input
        type="checkbox"
        aria-label={row.displayName ?? row.address}
        checked={checked}
        onChange={() => onToggle(row.address)}
      />
    </td>
  );
}

const countText = (n: number | null) => (n != null ? formatCount(n) : "—");

function Name({ row }: { row: CandidateRow }) {
  const t = useT();
  return (
    <td>
      <span className="expand__name">
        <span className={row.displayName ? undefined : "num"} title={row.address}>
          {row.displayName ?? shortAddr(row.address)}
        </span>
        {row.heavy && <span className="tag tag--warn">{t("expand.heavy")}</span>}
        {row.cand.hot && <span className="tag tag--warn">{t("expand.hot")}</span>}
      </span>
    </td>
  );
}

/** Wallets (light first) with their probe facts, then the collapsed, never pre-checked contracts group. */
export function CandidateList(p: CandidateListProps) {
  const t = useT();
  return (
    <div className="expand__list">
      {p.wallets.length > 0 && (
        <table className="table table--inset">
          <caption className="expand__caption">{t("expand.wallets", { count: p.wallets.length })}</caption>
          <thead>
            <tr>
              <th />
              <th>{t("expand.col.address")}</th>
              <th className="table__num">{t("expand.col.transfers")}</th>
              <th className="table__num">{t("expand.col.weight")}</th>
              <th className="table__num">{t("expand.col.nonce")}</th>
              <th className="table__num">{t("expand.col.balance")}</th>
            </tr>
          </thead>
          <tbody>
            {p.wallets.map((r) => {
              const bal = r.balance != null ? formatFixed(r.balance, 18, "eth") : null;
              return (
                <tr key={r.address}>
                  <Check row={r} checked={p.checked.has(r.address)} onToggle={p.onToggle} />
                  <Name row={r} />
                  <td className="table__num num">{countText(r.count)}</td>
                  <td className="table__num num">
                    {r.cand.weight.estimated && (
                      <span className="tag tag--neutral expand__est" title={t("expand.estTitle")}>{t("expand.est")}</span>
                    )}
                    {r.cand.weight.value.toFixed(1)}
                  </td>
                  <td className="table__num num">{r.nonce != null ? formatCount(r.nonce) : "—"}</td>
                  <td className="table__num num" title={bal ? `${bal.full} ETH` : undefined}>{bal ? `${bal.text} ETH` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {p.contracts.length > 0 && (
        <div className="expand__group">
          <div className="expand__group-head">
            <button type="button" className="btn btn--compact btn--ghost" aria-expanded={p.contractsOpen} onClick={p.onToggleContracts}>
              {p.contractsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t("expand.contracts", { count: p.contracts.length })}
            </button>
            <span className="expand__hint">{t("expand.contracts.hint")}</span>
          </div>
          {p.contractsOpen && (
            <table className="table table--inset">
              <thead>
                <tr>
                  <th />
                  <th>{t("expand.col.address")}</th>
                  <th className="table__num">{t("expand.col.transfers")}</th>
                </tr>
              </thead>
              <tbody>
                {p.contracts.map((r) => (
                  <tr key={r.address}>
                    <Check row={r} checked={p.checked.has(r.address)} onToggle={p.onToggle} />
                    <Name row={r} />
                    <td className="table__num num">{countText(r.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
