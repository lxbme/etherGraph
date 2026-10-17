import { ArrowRight } from "lucide-react";
import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useT } from "../../i18n";
import { formatFixed } from "../../lib/amount";
import { formatLocalTime, formatTime } from "../../lib/format";
import { TxStatusTag } from "../../panels/TxSummaryCard";
import { AddressCell } from "../../shell/AddressCell";
import { nodeOf } from "./common";

/** One line above the flow graph: status, method, from → to (or the created contract), value, fee and time. */
export function TxSummaryBar({ flow }: { flow: TxFlowDto }) {
  const t = useT();
  const { tx, call } = flow;
  const value = formatFixed(tx.value, 18, "eth");
  const fee = formatFixed(tx.fee, 18, "eth");
  const name = call?.name ?? tx.method;
  // A creation points at the contract it deployed, when known.
  const to = tx.to ?? flow.detail.contract_created;
  return (
    <div className="txbar" data-testid="tx-summary-bar">
      <TxStatusTag success={tx.success} />
      {name ? (
        <span className="txbar__method" title={call?.signature}>{name}</span>
      ) : tx.to && tx.selector ? (
        <span className="txbar__method">
          <span className="detail__mono">{tx.selector}</span> <span className="txview__tag">{t("tx.undecoded")}</span>
        </span>
      ) : (
        <span className="txbar__method">{tx.to ? t("tx.transfer") : t("tx.contractCreation")}</span>
      )}
      <span className="txbar__parties">
        <AddressCell address={tx.from} node={nodeOf(flow, tx.from)} />
        <ArrowRight size={14} className="txbar__arrow" />
        {to ? <AddressCell address={to} node={nodeOf(flow, to)} /> : <span>{t("tx.contractCreation")}</span>}
      </span>
      <span className="txbar__item">
        {t("tx.value")} <span className="num" title={value.full}>{value.text} ETH</span>
      </span>
      <span className="txbar__item">
        {t("tx.fee")} <span className="num" title={fee.full}>{fee.text} ETH</span>
      </span>
      <span className="txbar__item num" title={formatLocalTime(tx.ts)}>{formatTime(tx.ts)}</span>
    </div>
  );
}
