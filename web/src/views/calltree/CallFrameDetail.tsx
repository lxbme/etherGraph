import type { CallFrameDto } from "../../api/generated/CallFrameDto";
import { useT } from "../../i18n";
import { formatFixed } from "../../lib/amount";
import { formatCount } from "../../lib/format";
import { AddressCell } from "../../shell/AddressCell";
import { ArgsTable, erc20Of, GuessedTag, nodeOf, RawHex, useFlowLink, ViaDelegateNote, type FlowNodes } from "../txdetail/common";
import { KIND_TEXT } from "./CallTreeList";
import { contextOf } from "./model";

/**
 * One call in full: caller → callee, the decoded method and arguments (addresses select their node), value (labelled
 * apart where it is not ETH sent, see `sendsEth`), gas, the failure and decoded revert, and the raw input / output
 * with copy. ERC-20 amounts read in the decimals of the token the frame acts as (`contextOf`).
 */
export function CallFrameDetail({ frame, flow }: { frame: CallFrameDto; flow: FlowNodes }) {
  const t = useT();
  const { select } = useFlowLink(flow.tx.hash);
  const creation = frame.kind === "create" || frame.kind === "create2";
  const value = formatFixed(frame.value, 18, "eth");
  const via = frame.via_delegate;
  // No ETH moves on a DELEGATECALL (it repeats its context's value) or a CALLCODE (it pays the caller itself).
  const valueLabel =
    frame.kind === "delegatecall" ? "tx.calls.inheritedValue" : frame.kind === "callcode" ? "tx.calls.callcodeValue" : "tx.value";
  return (
    <div className="calltree__detail txdetail__pane" data-testid="call-detail">
      <div className="txdetail__line">
        <span className={`calltree__kind calltree__kind--${frame.kind}`}>{KIND_TEXT[frame.kind]}</span>
        <AddressCell address={frame.from} node={nodeOf(flow, frame.from)} onSelect={select} />
        <span className="detail__muted">→</span>
        {frame.to ? <AddressCell address={frame.to} node={nodeOf(flow, frame.to)} onSelect={select} /> : <span>—</span>}
      </div>
      {frame.call ? (
        frame.call.guessed ? (
          <div className="txdetail__line">
            <span className="detail__mono">{frame.call.signature}</span>
            <GuessedTag alternatives={frame.call.alternatives} />
          </div>
        ) : (
          <div className="detail__mono">{frame.call.signature}</div>
        )
      ) : (
        !creation && frame.input.length >= 10 && (
          <div className="txdetail__line">
            {t("tx.input.selector")} <span className="detail__mono">{frame.input.slice(0, 10)}</span>
            <span className="txview__tag">{t("tx.undecoded")}</span>
          </div>
        )
      )}
      {via && <ViaDelegateNote via={via} current={frame.via_delegate_current} />}
      <dl className="kv">
        <dt>{t(valueLabel)}</dt>
        <dd className="num" title={value.full}>{value.text} ETH</dd>
        <dt>{t("tx.ov.gasLimit")}</dt>
        <dd className="num">{formatCount(frame.gas)}</dd>
        <dt>{t("tx.ov.gasUsed")}</dt>
        <dd className="num">{frame.gas_used === null ? "—" : formatCount(frame.gas_used)}</dd>
      </dl>
      {frame.error !== null && (
        <div className="txdetail__line">
          <span className="tag tag--neg">{t("tx.calls.error")}</span>
          <span className="detail__error">{frame.error}</span>
        </div>
      )}
      {frame.revert && (
        <>
          <div className="popover__section">{t("tx.calls.revert")}</div>
          <div className="detail__mono">{frame.revert.name}</div>
          {frame.revert.args.length > 0 && <ArgsTable args={frame.revert.args} flow={flow} />}
        </>
      )}
      {frame.call && frame.call.args.length > 0 && (
        <>
          <div className="popover__section">{t("tx.calls.args")}</div>
          <ArgsTable args={frame.call.args} flow={flow} signature={frame.call.signature} token={erc20Of(flow, contextOf(frame))} />
        </>
      )}
      <div className="popover__section">{t("tx.calls.input")}</div>
      <RawHex hex={frame.input} selector={!creation} />
      {frame.output !== null && (
        <>
          <div className="popover__section">{t("tx.calls.output")}</div>
          <RawHex hex={frame.output} selector={false} />
        </>
      )}
    </div>
  );
}
