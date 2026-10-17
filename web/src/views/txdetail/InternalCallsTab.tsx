import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useT } from "../../i18n";
import { formatFixed } from "../../lib/amount";
import { AddressCell } from "../../shell/AddressCell";
import { nodeOf, useFlowLink } from "./common";

/** Value-carrying internal calls in execution order (Etherscan does not report zero-value ones). */
export function InternalCallsTab({ flow }: { flow: TxFlowDto }) {
  const t = useT();
  const { select, rowProps } = useFlowLink(flow.tx.hash);
  const rows = flow.flows.filter((f) => f.kind === "internal").sort((a, b) => a.seq - b.seq);
  return (
    <>
      <p className="txdetail__note">{t("tx.internal.note")}</p>
      {rows.length === 0 ? (
        <div className="placeholder">{t("tx.internal.empty")}</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th className="table__num">{t("tx.col.seq")}</th>
              <th>{t("tx.col.from")}</th>
              <th>{t("tx.col.to")}</th>
              <th className="table__num">{t("tx.col.value")}</th>
              <th>{t("tx.col.trace")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => {
              const v = formatFixed(f.amount, 18, "eth");
              return (
                <tr key={`${f.seq}-${i}`} {...rowProps(f.seq)}>
                  <td className="num table__num">{f.seq}</td>
                  <td><AddressCell address={f.from} node={nodeOf(flow, f.from)} onSelect={select} /></td>
                  <td><AddressCell address={f.to} node={nodeOf(flow, f.to)} onSelect={select} /></td>
                  <td className="num table__num" title={v.full}>{v.text} ETH</td>
                  <td className="num">{f.trace_path ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
