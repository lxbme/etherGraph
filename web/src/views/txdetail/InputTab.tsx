import { useState } from "react";
import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useT } from "../../i18n";
import { CopyButton } from "../../shell/CopyButton";
import { ArgsTable, erc20Of, GuessedTag, hexBytes, RawHex, ViaDelegateNote } from "./common";

/**
 * Calldata: the decoded signature and arguments with a "Raw hex" toggle; undecodable calls show their selector and
 * the hex; a contract creation shows only its initcode size and hex (it is never decoded as a call).
 */
export function InputTab({ flow }: { flow: TxFlowDto }) {
  const t = useT();
  const { tx, detail, call } = flow;
  const [showHex, setShowHex] = useState(false);
  const bytes = hexBytes(detail.input);

  if (tx.to === null) {
    return (
      <div className="txdetail__pane">
        <div>{t("tx.input.creation", { count: bytes })}</div>
        <RawHex hex={detail.input} selector={false} />
      </div>
    );
  }
  if (bytes === 0) return <div className="placeholder">{t("tx.input.empty")}</div>;
  if (!call) {
    return (
      <div className="txdetail__pane">
        <div className="txdetail__line">
          {t("tx.input.selector")} <span className="detail__mono">{tx.selector ?? detail.input.slice(0, 10)}</span>
          <span className="txview__tag">{t("tx.undecoded")}</span>
        </div>
        <RawHex hex={detail.input} selector />
      </div>
    );
  }
  return (
    <div className="txdetail__pane">
      <div className="txdetail__line">
        <span className="detail__mono">{call.signature}</span>
        <CopyButton value={call.signature} />
        {call.guessed && <GuessedTag alternatives={call.alternatives} />}
        <div className="seg txdetail__toggle" role="group" aria-label={t("tx.input.view")}>
          <button type="button" className="seg__item" aria-pressed={showHex} onClick={() => setShowHex(!showHex)}>
            {t("tx.input.rawHex")}
          </button>
        </div>
      </div>
      {call.via_delegate && <ViaDelegateNote via={call.via_delegate} current={call.via_delegate_current} />}
      {call.args.length > 0 && <ArgsTable args={call.args} flow={flow} signature={call.signature} token={erc20Of(flow, tx.to)} />}
      {showHex && <RawHex hex={detail.input} selector />}
    </div>
  );
}
