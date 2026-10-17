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

const GWEI = 1_000_000_000n;

/** A per-gas price in Gwei (in wei below 1 Gwei); the exact wei and ETH values are the title. */
function Price({ wei }: { wei: string }) {
  const t = useT();
  const exact = t("tx.wei", { value: count(wei) });
  const title = `${exact} = ${formatFixed(wei, 18, "eth").full} ETH`;
  const text = /^\d+$/.test(wei) && BigInt(wei) < GWEI ? exact : t("tx.gwei", { value: formatAmount(wei, 9, { maxFrac: 9 }).text });
  return <span className="num" title={title}>{text}</span>;
}

function Copyable({ value, text }: { value: string; text?: string }) {
  return (
    <span className="addr-cell">
      <span className="addr-cell__name num" title={value}>{text ?? value}</span>
      <CopyButton value={value} />
    </span>
  );
}

type Rows = [MsgKey, ReactNode][];

function Group({ rows, className }: { rows: Rows; className?: string }) {
  const t = useT();
  return (
    <dl className={className ? `kv txdetail__kv ${className}` : "kv txdetail__kv"}>
      {rows.map(([key, value]) => (
        <Fragment key={key}>
          <dt>{t(key)}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * Every field of the transaction in spec order; absent fields have no row, except base fee / burnt / savings ("—").
 * Hash and status span the full width; below them the identity / parties / value group and the gas / fees group
 * sit side by side on a wide panel, so related rows never split across columns.
 */
export function OverviewTab({ flow }: { flow: TxFlowDto }) {
  const t = useT();
  const { tx, detail: d } = flow;
  const typeKey = `tx.type.${d.tx_type}` as MsgKey;
  const typeText = d.tx_type >= 0 && d.tx_type <= 4 ? t(typeKey) : t("tx.type.other", { type: String(d.tx_type) });
  const pct = usage(d.gas_used, d.gas_limit);
  const price = d.effective_gas_price ?? d.gas_price;
  const head: Rows = [
    ["tx.ov.hash", <Copyable value={tx.hash} />],
    [
      "tx.ov.status",
      <span className="txdetail__status">
        <TxStatusTag success={tx.success} />
        {!tx.success && d.revert_reason && <span className="detail__error" title={d.revert_reason}>{d.revert_reason}</span>}
      </span>,
    ],
  ];
  const parties: Rows = [
    ["tx.block", <Copyable value={String(tx.block_number)} />],
    ["tx.ov.confirmations", <span className="num">{d.confirmations === null ? DASH : formatCount(d.confirmations)}</span>],
    ["tx.time", <span className="num" title={formatLocalTime(tx.ts)}>{formatTime(tx.ts)}</span>],
    ["tx.col.from", <AddressCell address={tx.from} node={nodeOf(flow, tx.from)} />],
    ["tx.col.to", tx.to ? <AddressCell address={tx.to} node={nodeOf(flow, tx.to)} /> : t("tx.contractCreation")],
  ];
  // A reverted creation's receipt still names an address, but nothing was deployed there.
  if (tx.success && d.contract_created) {
    parties.push(["tx.ov.contractCreated", <AddressCell address={d.contract_created} node={nodeOf(flow, d.contract_created)} />]);
  }
  parties.push(
    ["tx.value", <Eth wei={tx.value} />],
    ["tx.ov.type", typeText],
    ["tx.ov.nonce", <span className="num">{formatCount(d.nonce)}</span>],
  );
  if (d.position !== null) parties.push(["tx.ov.position", <span className="num">{formatCount(d.position)}</span>]);
  const fees: Rows = [
    ["tx.ov.gasLimit", <span className="num">{count(d.gas_limit)}</span>],
    ["tx.ov.gasUsed", <span className="num">{count(d.gas_used)}{pct && ` (${pct})`}</span>],
  ];
  if (price !== null) {
    fees.push([d.effective_gas_price !== null && d.tx_type >= 2 ? "tx.ov.effectiveGasPrice" : "tx.ov.gasPrice", <Price wei={price} />]);
  }
  if (d.max_fee !== null) fees.push(["tx.ov.maxFee", <Price wei={d.max_fee} />]);
  if (d.max_priority_fee !== null) fees.push(["tx.ov.maxPriorityFee", <Price wei={d.max_priority_fee} />]);
  fees.push(
    ["tx.ov.baseFee", d.base_fee === null ? DASH : <Price wei={d.base_fee} />],
    ["tx.ov.burnt", d.burnt_fee === null ? DASH : <Eth wei={d.burnt_fee} />],
    ["tx.ov.savings", d.savings === null ? DASH : <Eth wei={d.savings} />],
    ["tx.ov.fee", <Eth wei={tx.fee} />],
  );
  if (d.blob_gas_used !== null) fees.push(["tx.ov.blobGasUsed", <span className="num">{count(d.blob_gas_used)}</span>]);
  if (d.blob_gas_price !== null) fees.push(["tx.ov.blobGasPrice", <Price wei={d.blob_gas_price} />]);
  if (d.blob_fee !== null) fees.push(["tx.ov.blobFee", <Eth wei={d.blob_fee} />]);
  if (d.access_list_len !== null) fees.push(["tx.ov.accessList", <span className="num">{formatCount(d.access_list_len)}</span>]);

  return (
    <div className="txdetail__overview" data-testid="tx-overview">
      <Group rows={head} className="txdetail__kv--head" />
      <Group rows={parties} />
      <Group rows={fees} />
    </div>
  );
}
