import type { FlowDto } from "../../api/generated/FlowDto";
import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useT } from "../../i18n";
import { shortAddr } from "../../lib/address";
import { formatFixed } from "../../lib/amount";
import { assetClass } from "../../lib/assets";
import { AddressCell } from "../../shell/AddressCell";
import { CopyButton } from "../../shell/CopyButton";
import { nodeOf, useFlowLink } from "./common";

const TOKEN_KINDS: ReadonlySet<FlowDto["kind"]> = new Set(["erc20", "erc721", "erc1155"]);

/** Fixed-decimals amount; NFTs show their token id (ERC-1155 with its quantity). */
function Amount({ f }: { f: FlowDto }) {
  if (f.token_id !== null && (f.kind === "erc721" || f.kind === "erc1155")) {
    const text = f.kind === "erc1155" ? `${formatFixed(f.amount, 0, "nft").text} × #${f.token_id}` : `#${f.token_id}`;
    return <span title={f.token_id}>{text}</span>;
  }
  const v = formatFixed(f.amount, f.decimals, assetClass(f.asset, f.kind));
  return <span title={v.full}>{v.text}</span>;
}

/** ERC-20 / 721 / 1155 transfers of the transaction in log order. */
export function TokenTransfersTab({ flow }: { flow: TxFlowDto }) {
  const t = useT();
  const { select, rowProps } = useFlowLink(flow.tx.hash);
  const rows = flow.flows
    .filter((f) => TOKEN_KINDS.has(f.kind))
    .sort((a, b) => (a.log_index ?? Number.MAX_SAFE_INTEGER) - (b.log_index ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq);
  if (rows.length === 0) return <div className="placeholder">{t("tx.transfers.empty")}</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th className="table__num">{t("tx.col.seq")}</th>
          <th>{t("tx.col.from")}</th>
          <th>{t("tx.col.to")}</th>
          <th className="table__num">{t("transfers.col.amount")}</th>
          <th>{t("tx.col.token")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((f, i) => (
          <tr key={`${f.seq}-${i}`} {...rowProps(f.seq)}>
            <td className="num table__num">{f.seq}</td>
            <td><AddressCell address={f.from} node={nodeOf(flow, f.from)} onSelect={select} /></td>
            <td><AddressCell address={f.to} node={nodeOf(flow, f.to)} onSelect={select} /></td>
            <td className="num table__num"><Amount f={f} /></td>
            <td>
              {f.asset && (
                <span className="txdetail__addr">
                  <span title={f.asset}>{f.symbol ?? shortAddr(f.asset)}</span>
                  <CopyButton value={f.asset} />
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
