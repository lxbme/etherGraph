import { useState } from "react";
import type { DecodedEventDto } from "../../api/generated/DecodedEventDto";
import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useT } from "../../i18n";
import { AddressCell } from "../../shell/AddressCell";
import { eventSignature } from "../../lib/tokenArgs";
import { ArgsTable, erc20Of, nodeOf, RawHex, useFlowLink } from "./common";

/** Cards rendered before "Show all". */
export const LOG_LIMIT = 200;

function LogCard({ event: e, flow }: { event: DecodedEventDto; flow: TxFlowDto }) {
  const t = useT();
  const decoded = e.name !== null;
  const [raw, setRaw] = useState(!decoded);
  const { select } = useFlowLink(flow.tx.hash);
  return (
    <article className="txlog" data-testid="tx-log">
      <header className="txlog__head">
        <span className="num detail__muted">{t("tx.logs.index", { index: String(e.log_index) })}</span>
        <AddressCell address={e.address} node={nodeOf(flow, e.address)} onSelect={select} />
        {decoded ? <b>{e.name}</b> : <span className="txview__tag">{t("tx.undecoded")}</span>}
        <div className="seg txlog__toggle" role="group" aria-label={t("tx.logs.view")}>
          <button type="button" className="seg__item" aria-pressed={!raw} disabled={!decoded} onClick={() => setRaw(false)}>
            {t("tx.logs.decoded")}
          </button>
          <button type="button" className="seg__item" aria-pressed={raw} onClick={() => setRaw(true)}>
            {t("tx.logs.raw")}
          </button>
        </div>
      </header>
      {raw ? (
        <div className="txlog__raw">
          <div className="detail__muted">{t("tx.logs.topics")}</div>
          <ol className="txlog__topics">
            {e.topics.map((topic, i) => (
              <li key={i} className="detail__mono">
                <span className="detail__muted">{`[${i}]`}</span> <span>{topic}</span>
              </li>
            ))}
          </ol>
          <div className="detail__muted">{t("tx.logs.data")}</div>
          <RawHex hex={e.data} selector={false} />
        </div>
      ) : (
        e.args.length > 0 && (
          <ArgsTable
            args={e.args}
            flow={flow}
            signature={e.name === null ? undefined : eventSignature(e.name, e.args)}
            token={erc20Of(flow, e.address)}
          />
        )
      )}
    </article>
  );
}

/** One card per event log; past LOG_LIMIT only the first are rendered until "Show all". */
export function LogsTab({ flow }: { flow: TxFlowDto }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const { events } = flow;
  if (events.length === 0) return <div className="placeholder">{t("tx.logs.empty")}</div>;
  const shown = all ? events : events.slice(0, LOG_LIMIT);
  return (
    <div className="txdetail__logs">
      {shown.map((e) => (
        <LogCard key={e.log_index} event={e} flow={flow} />
      ))}
      {shown.length < events.length && (
        <button type="button" className="btn" onClick={() => setAll(true)}>
          {t("tx.logs.showAll", { count: events.length })}
        </button>
      )}
    </div>
  );
}
