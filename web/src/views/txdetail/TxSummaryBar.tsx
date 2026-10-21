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
import { nodeOf, ViaDelegateNote } from "./common";

const TOKEN_KINDS: ReadonlySet<FlowDto["kind"]> = new Set(["erc20", "erc721", "erc1155"]);
/** Transfer lines shown before the rest collapse into "+N more". */
const SHOWN = 2;

/** Headline order by trust: listed tokens first, then unknown, suspicious, scam. */
const TRUST_RANK: Record<FlowDto["trust"]["level"], number> = { listed: 0, unknown: 1, suspicious: 2, scam: 3 };

/** The token transfers in log order, ranked listed ahead of unknown ahead of suspicious ahead of scam (stable within a rank). */
function headlineTransfers(flows: readonly FlowDto[]): FlowDto[] {
  const key = (f: FlowDto) => TRUST_RANK[f.trust.level];
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
      <span className="txbar__method txbar__transfer-label">{t("tx.summary.transfer")}</span>
      {/* One line only. When room is short the whole recipient goes, then the label ellipsises; the amount truncates last (full value in its title); one within its 8ch floor never shrinks, so keeps no wider floor. */}
      {full !== null && <span className={full.length > 8 ? "num txbar__amt" : "num txbar__amt txbar__amt--short"} title={`${full} ${label}`}>{full}</span>}
      {f.asset ? (
        <AssetButton tab={flow.tx.hash.toLowerCase()} asset={f.asset.toLowerCase()} tokenId={f.token_id} kind={f.kind} title={`${label} · ${f.asset}`}>
          {label}
        </AssetButton>
      ) : (
        <span className="txbar__sym" title={label}>{symbol}</span>
      )}
      <TrustBadge trust={f.trust} />
      {/* The slot the CSS shrinks; the arrow and address inside it show whole or not at all. No copy / add buttons: a
          clipped recipient would leave invisible tab stops (the Token Transfers tab offers both; the name's title is the address). */}
      <span className="txbar__to">
        <span className="txbar__to-addr">
          <ArrowRight size={14} className="txbar__arrow" />
          <AddressCell address={f.to} node={nodeOf(flow, f.to)} actions={false} />
        </span>
      </span>
    </div>
  );
}

/** "+N more", or just "+N" where the transfers area is too tight for the words (the CSS picks; the button's aria-label is the full text). */
function MoreText({ count }: { count: number }) {
  const t = useT();
  return (
    <>
      <span className="txbar__more-full">{t("tx.summary.more", { count })}</span>
      <span className="txbar__more-short" aria-hidden="true">+{count}</span>
    </>
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
      {call?.via_delegate && <ViaDelegateNote via={call.via_delegate} current={call.via_delegate_current} inline />}
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
        <div className={transfers.length > 1 ? "txbar__transfers txbar__transfers--more" : "txbar__transfers"}>
          {transfers.slice(0, SHOWN).map((f, i) => (
            <TransferLine key={`${f.seq}-${i}`} flow={flow} f={f} second={i > 0} />
          ))}
          {/* Where the transfers area is too narrow for two lines the CSS hides the second and swaps in the count that includes it; only one button is ever displayed. */}
          {transfers.length > SHOWN && (
            <button type="button" className="btn btn--ghost btn--compact txbar__more txbar__more--wide" aria-label={t("tx.summary.more", { count: transfers.length - SHOWN })} onClick={openTransfers}>
              <MoreText count={transfers.length - SHOWN} />
            </button>
          )}
          {transfers.length > 1 && (
            <button type="button" className="btn btn--ghost btn--compact txbar__more txbar__more--narrow" aria-label={t("tx.summary.more", { count: transfers.length - 1 })} onClick={openTransfers}>
              <MoreText count={transfers.length - 1} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
