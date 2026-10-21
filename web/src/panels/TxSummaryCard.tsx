import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import { qk } from "../api/queryClient";
import { useT } from "../i18n";
import { formatFixed } from "../lib/amount";
import { formatLocalTime, formatTime } from "../lib/format";
import { AddressCell } from "../shell/AddressCell";
import { useTabs } from "../shell/tabs";
import { GuessedTag, ViaDelegateNote } from "../views/txdetail/common";

/** Success / Failed badge of a transaction. */
export function TxStatusTag({ success }: { success: boolean }) {
  const t = useT();
  return (
    <span className={`tag ${success ? "tag--ok" : "tag--neg"}`}>
      {success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
      {success ? t("tx.success") : t("tx.failed")}
    </span>
  );
}

/** Right-panel summary of one transaction; "Open transaction" opens its tab. */
export function TxSummaryCard({ hash }: { hash: string }) {
  const t = useT();
  const q = useQuery({
    queryKey: qk.tx(hash),
    queryFn: () => api.tx(hash),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 5000 : false),
  });
  if (q.isError) {
    return (
      <div className="detail__error" role="alert">
        {messageFor(q.error)}{" "}
        <button type="button" className="btn btn--compact" onClick={() => void q.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  const flow = q.data?.status === "ready" ? q.data.flow : null;
  if (!flow) return <div className="placeholder">{t("tx.loading")}</div>;

  const { tx, nodes } = flow;
  const nodeOf = (a: string) => nodes.find((n) => n.address.toLowerCase() === a.toLowerCase());
  const value = formatFixed(tx.value, 18, "eth");
  const fee = formatFixed(tx.fee, 18, "eth");
  const name = flow.call?.name ?? tx.method;
  // A reverted creation's receipt still names an address, but nothing was deployed there.
  const created = !tx.to && tx.success ? (flow.detail.contract_created ?? null) : null;
  return (
    <div className="detail__section" data-testid="tx-summary">
      <h3 className="detail__title">
        <TxStatusTag success={tx.success} />{" "}
        {name !== null ? (
          <>
            {name}
            {flow.call?.guessed && <> <GuessedTag alternatives={flow.call.alternatives} /></>}
          </>
        ) : tx.to && tx.selector ? (
          <>
            <span className="detail__mono">{tx.selector}</span> <span className="txview__tag">{t("tx.undecoded")}</span>
          </>
        ) : tx.to ? (
          t("tx.transfer")
        ) : (
          t("tx.contractCreation")
        )}
      </h3>
      {flow.call?.via_delegate && <ViaDelegateNote via={flow.call.via_delegate} current={flow.call.via_delegate_current} />}
      <dl className="kv">
        <dt>{t("tx.col.from")}</dt>
        <dd><AddressCell address={tx.from} node={nodeOf(tx.from)} /></dd>
        <dt>{t("tx.col.to")}</dt>
        <dd>{tx.to ? <AddressCell address={tx.to} node={nodeOf(tx.to)} /> : t("tx.contractCreation")}</dd>
        {created && (
          <>
            <dt>{t("tx.ov.contractCreated")}</dt>
            <dd><AddressCell address={created} node={nodeOf(created)} /></dd>
          </>
        )}
        <dt>{t("tx.value")}</dt>
        <dd className="num" title={value.full}>{value.text} ETH</dd>
        <dt>{t("tx.fee")}</dt>
        <dd className="num" title={fee.full}>{fee.text} ETH</dd>
        <dt>{t("tx.time")}</dt>
        <dd className="num" title={formatLocalTime(tx.ts)}>{formatTime(tx.ts)}</dd>
      </dl>
      <button type="button" className="btn btn--primary" onClick={() => useTabs.getState().openTx(hash)}>
        {t("tx.openTransaction")}
      </button>
    </div>
  );
}
