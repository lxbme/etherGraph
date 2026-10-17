import { Fragment, type ReactNode } from "react";
import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useT, type MsgKey } from "../../i18n";
import { formatAmount, formatFixed } from "../../lib/amount";
import { formatCount, formatLocalTime, formatTime } from "../../lib/format";
import { TxStatusTag } from "../../panels/TxSummaryCard";
import { AddressCell } from "../../shell/AddressCell";
import { CopyButton } from "../../shell/CopyButton";
import { nodeOf } from "./common";

const DASH = "—";

/** A count kept as a decimal string (gas), grouped. */
const count = (raw: string) => formatAmount(raw, 0).text;

/** gas_used / gas_limit with one decimal; null when the limit is zero or unparsable. Gas counts fit a JS number. */
function usage(used: string, limit: string): string | null {
  const u = Number(used);
  const l = Number(limit);
  if (!Number.isFinite(u) || !Number.isFinite(l) || l <= 0) return null;
  return `${((u / l) * 100).toFixed(1)}%`;
}

function Eth({ wei }: { wei: string }) {
  const v = formatFixed(wei, 18, "eth");
  return <span className="num" title={v.full}>{v.text} ETH</span>;
}

/** A per-gas price: ETH (fixed 6 dp) and its exact Gwei value. */
function Price({ wei }: { wei: string }) {
  const t = useT();
  return (
    <>
      <Eth wei={wei} /> <span className="num detail__muted">({t("tx.gwei", { value: formatAmount(wei, 9, { maxFrac: 9 }).text })})</span>
    </>
  );
}

function Copyable({ value, text }: { value: string; text?: string }) {
  return (
    <span className="addr-cell">
      <span className="addr-cell__name num" title={value}>{text ?? value}</span>
      <CopyButton value={value} />
    </span>
  );
}

/** Every field of the transaction in spec order; absent fields have no row, except base fee / burnt / savings ("—"). */
export function OverviewTab({ flow }: { flow: TxFlowDto }) {
  const t = useT();
  const { tx, detail: d } = flow;
  const typeKey = `tx.type.${d.tx_type}` as MsgKey;
  const typeText = d.tx_type >= 0 && d.tx_type <= 4 ? t(typeKey) : t("tx.type.other", { type: String(d.tx_type) });
  const pct = usage(d.gas_used, d.gas_limit);
  const price = d.effective_gas_price ?? d.gas_price;
  const rows: [MsgKey, ReactNode][] = [
    ["tx.ov.hash", <Copyable value={tx.hash} />],
    [
      "tx.ov.status",
      <span className="txdetail__status">
        <TxStatusTag success={tx.success} />
        {!tx.success && d.revert_reason && <span className="detail__error" title={d.revert_reason}>{d.revert_reason}</span>}
      </span>,
    ],
    ["tx.block", <Copyable value={String(tx.block_number)} />],
    ["tx.ov.confirmations", <span className="num">{d.confirmations === null ? DASH : formatCount(d.confirmations)}</span>],
    ["tx.time", <span className="num" title={formatLocalTime(tx.ts)}>{formatTime(tx.ts)}</span>],
    ["tx.col.from", <AddressCell address={tx.from} node={nodeOf(flow, tx.from)} />],
    ["tx.col.to", tx.to ? <AddressCell address={tx.to} node={nodeOf(flow, tx.to)} /> : t("tx.contractCreation")],
  ];
  if (d.contract_created) {
    rows.push(["tx.ov.contractCreated", <AddressCell address={d.contract_created} node={nodeOf(flow, d.contract_created)} />]);
  }
  rows.push(
    ["tx.value", <Eth wei={tx.value} />],
    ["tx.ov.type", typeText],
    ["tx.ov.nonce", <span className="num">{formatCount(d.nonce)}</span>],
  );
  if (d.position !== null) rows.push(["tx.ov.position", <span className="num">{formatCount(d.position)}</span>]);
  rows.push(
    ["tx.ov.gasLimit", <span className="num">{count(d.gas_limit)}</span>],
    ["tx.ov.gasUsed", <span className="num">{count(d.gas_used)}{pct && ` (${pct})`}</span>],
  );
  if (price !== null) {
    rows.push([d.effective_gas_price !== null && d.tx_type >= 2 ? "tx.ov.effectiveGasPrice" : "tx.ov.gasPrice", <Price wei={price} />]);
  }
  if (d.max_fee !== null) rows.push(["tx.ov.maxFee", <Price wei={d.max_fee} />]);
  if (d.max_priority_fee !== null) rows.push(["tx.ov.maxPriorityFee", <Price wei={d.max_priority_fee} />]);
  rows.push(
    ["tx.ov.baseFee", d.base_fee === null ? DASH : <Price wei={d.base_fee} />],
    ["tx.ov.burnt", d.burnt_fee === null ? DASH : <Eth wei={d.burnt_fee} />],
    ["tx.ov.savings", d.savings === null ? DASH : <Eth wei={d.savings} />],
    ["tx.ov.fee", <Eth wei={tx.fee} />],
  );
  if (d.blob_gas_used !== null) rows.push(["tx.ov.blobGasUsed", <span className="num">{count(d.blob_gas_used)}</span>]);
  if (d.blob_gas_price !== null) rows.push(["tx.ov.blobGasPrice", <Price wei={d.blob_gas_price} />]);
  if (d.access_list_len !== null) rows.push(["tx.ov.accessList", <span className="num">{formatCount(d.access_list_len)}</span>]);

  return (
    <dl className="kv txdetail__kv">
      {rows.map(([key, value]) => (
        <Fragment key={key}>
          <dt>{t(key)}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
