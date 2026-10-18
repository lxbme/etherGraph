import { useState, type ReactNode } from "react";
import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useT, type MsgKey } from "../../i18n";
import { useTabs, type TxDetailTab } from "../../shell/tabs";
import { InputTab } from "./InputTab";
import { InternalCallsTab } from "./InternalCallsTab";
import { LogsTab } from "./LogsTab";
import { OverviewTab } from "./OverviewTab";
import { RawTab } from "./RawTab";
import { TokenTransfersTab } from "./TokenTransfersTab";

const TABS: readonly [TxDetailTab, MsgKey][] = [
  ["overview", "tx.detail.overview"],
  ["input", "tx.detail.input"],
  ["transfers", "tx.detail.transfers"],
  ["internal", "tx.detail.internal"],
  ["logs", "tx.detail.logs"],
  ["raw", "tx.detail.raw"],
];

/**
 * The transaction's detail sections under its flow graph. The chosen section is kept on the tx tab entry, so it
 * survives tab switches; only the chosen section renders.
 */
export function TxDetailTabs({ flow }: { flow: TxFlowDto }) {
  const t = useT();
  const id = flow.tx.hash.toLowerCase();
  const stored = useTabs((s) => {
    const entry = s.tabs.find((x) => x.id === id);
    return entry && "kind" in entry ? entry.detailTab : undefined;
  });
  // Used only when the view is shown without a tab entry (nothing to store the choice on).
  const [local, setLocal] = useState<TxDetailTab>("overview");
  const active = stored ?? local;
  const pick = (tab: TxDetailTab) => {
    setLocal(tab);
    useTabs.getState().setDetailTab(id, tab);
  };

  let body: ReactNode;
  switch (active) {
    case "overview":
      body = <OverviewTab flow={flow} onShowTransfers={() => pick("transfers")} />;
      break;
    case "input":
      body = <InputTab flow={flow} />;
      break;
    case "transfers":
      body = <TokenTransfersTab flow={flow} />;
      break;
    case "internal":
      body = <InternalCallsTab flow={flow} />;
      break;
    case "logs":
      body = <LogsTab flow={flow} />;
      break;
    case "raw":
      body = <RawTab hash={flow.tx.hash} />;
      break;
  }
  return (
    <div className="txdetail" data-testid="tx-detail">
      <div className="txdetail__tabs">
        <div className="seg" role="group" aria-label={t("tx.detail.label")}>
          {TABS.map(([tab, key]) => (
            <button key={tab} type="button" className="seg__item" aria-pressed={active === tab} onClick={() => pick(tab)}>
              {t(key)}
            </button>
          ))}
        </div>
      </div>
      <div className="txdetail__body">{body}</div>
    </div>
  );
}
