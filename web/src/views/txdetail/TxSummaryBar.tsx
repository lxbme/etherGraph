import { ArrowRight } from "lucide-react";
import type { FlowDto } from "../../api/generated/FlowDto";
import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useT } from "../../i18n";
import { shortAddr } from "../../lib/address";
import { formatFixed, formatFull } from "../../lib/amount";
import { formatLocalTime, formatTime } from "../../lib/format";
import { trustFlag } from "../../lib/trust";
import { AssetButton } from "../../panels/info/AssetButton";
import { TrustBadge } from "../../panels/info/TrustBadge";
import { TxStatusTag } from "../../panels/TxSummaryCard";
import { AddressCell } from "../../shell/AddressCell";
import { useTabs } from "../../shell/tabs";
import { nodeOf } from "./common";

const TOKEN_KINDS: ReadonlySet<FlowDto["kind"]> = new Set(["erc20", "erc721", "erc1155"]);
/** Transfer lines shown before the rest collapse into "+N more". */
const SHOWN = 2;

/** The token transfers in log order, listed / unknown tokens ahead of suspicious ahead of scam (stable within a rank). */
function headlineTransfers(flows: readonly FlowDto[]): FlowDto[] {
  const key = (f: FlowDto) => { const flag = trustFlag(f.trust); return flag === "scam" ? 2 : flag === "suspicious" ? 1 : 0; };
  return flows
    .filter((f) => TOKEN_KINDS.has(f.kind))
    .sort((a, b) => (a.log_index ?? Number.MAX_SAFE_INTEGER) - (b.log_index ?? Number.MAX_SAFE_INTEGER) || a.seq - b.seq)
    .sort((a, b) => key(a) - key(b));
}

function TransferLine({ flow, f, second }: { flow: TxFlowDto; f: FlowDto; second: boolean }) {
  const t = useT();
  const symbol = f.symbol ?? (f.asset ? shortAddr(f.asset) : "");
  const nft = f.token_id !== null && (f.kind === "erc721" || f.kind === "erc1155");
  const full = nft ? null : formatFull(f.amount, f.decimals);
  // Exact amount, never the table's fixed-decimals rounding; an ERC-1155 quantity above one leads its token id.
  const quantity = nft && f.kind === "erc1155" && f.amount !== "1" ? `${formatFixed(f.amount, 0, "nft").text} × ` : "";
  const muted = trustFlag(f.trust) !== null;
  const cls = ["txbar__transfer", muted && "txbar__transfer--muted", second && "txbar__transfer--second"].filter(Boolean).join(" ");
  const label = nft ? `${quantity}${symbol} #${f.token_id}` : symbol;
  return (
    <div className={cls} data-testid="tx-summary-transfer">
      <span className="txbar__method">{t("tx.summary.transfer")}</span>
      {/* One line only: a long amount or symbol truncates here, its full value in the title. */}
      <span className="txbar__amt" title={full !== null ? `${full} ${label}` : label}>
        {full !== null && <span className="num" title={full}>{full}</span>}
        {f.asset ? (
          <AssetButton tab={flow.tx.hash.toLowerCase()} asset={f.asset.toLowerCase()} tokenId={f.token_id} kind={f.kind} title={f.asset}>
            {label}
          </AssetButton>
        ) : (
          <span>{symbol}</span>
        )}
      </span>
      <TrustBadge trust={f.trust} />
      <ArrowRight size={14} className="txbar__arrow" />
      <AddressCell address={f.to} node={nodeOf(flow, f.to)} />
    </div>
  );
}

/** One line above the flow graph: status, method, from → to (or the created contract), value, fee and time. */
export function TxSummaryBar({ flow }: { flow: TxFlowDto }) {
  const t = useT();
  const { tx, call } = flow;
  const value = formatFixed(tx.value, 18, "eth");
  const fee = formatFixed(tx.fee, 18, "eth");
  const name = call?.name ?? tx.method;
  // A creation points at the contract it deployed, when known (a reverted one deployed nothing).
  const transfers = headlineTransfers(flow.flows);
  const openTransfers = () => useTabs.getState().setDetailTab(tx.hash.toLowerCase(), "transfers");
  const to = tx.to ?? (tx.success ? flow.detail.contract_created : null);
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
      {transfers.length > 0 && (
        <div className="txbar__transfers">
          {transfers.slice(0, SHOWN).map((f, i) => (
            <TransferLine key={`${f.seq}-${i}`} flow={flow} f={f} second={i > 0} />
          ))}
          {/* Narrow or short viewports show one line (the CSS hides the second), so the count differs there. */}
          {transfers.length > SHOWN && (
            <button type="button" className="btn btn--ghost btn--compact txbar__more txbar__more--wide" onClick={openTransfers}>
              {t("tx.summary.more", { count: transfers.length - SHOWN })}
            </button>
          )}
          {transfers.length > 1 && (
            <button type="button" className="btn btn--ghost btn--compact txbar__more txbar__more--narrow" onClick={openTransfers}>
              {t("tx.summary.more", { count: transfers.length - 1 })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
