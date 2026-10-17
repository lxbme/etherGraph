import { CheckCircle2, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import { useLocale, useT } from "../i18n";
import { qk } from "../api/queryClient";
import { CytoscapeView } from "../graph/CytoscapeView";
import { exposeTxCy } from "../graph/cyRegistry";
import { useGraph } from "../graph/store";
import { graphStylesheet } from "../graph/styles";
import { shortAddr } from "../lib/address";
import { formatAmount } from "../lib/amount";
import { assetClass } from "../lib/assets";
import { formatLocalTime, formatTime } from "../lib/format";
import { NodeDetail } from "../panels/NodeDetail";
import { useUi } from "../panels/uiStore";
import { useJobProgress } from "../shell/statusStore";
import { toast } from "../shell/Toasts";
import { useTheme } from "../shell/theme";
import { flowAmountText, flowSymbol, txElements } from "./txElements";
import type { TxFlowDto } from "../api/generated/TxFlowDto";

const NOOP = () => {};

/** Edge labels and the dashed call edge on top of the shared graph stylesheet. */
function txStylesheet(theme: "light" | "dark") {
  const extra = [
    {
      selector: "edge[label]",
      style: {
        label: "data(label)",
        "text-background-color": theme === "dark" ? "#14181d" : "#f6f7f9",
        "text-background-opacity": 0.85,
        "text-background-padding": "2px",
        "text-background-shape": "round-rectangle",
        "text-rotation": "autorotate",
      },
    },
    { selector: "edge.call", style: { "line-style": "dashed", "line-color": "#999999", "target-arrow-color": "#999999" } },
  ];
  return [...(graphStylesheet(theme) as unknown as object[]), ...extra] as unknown as ReturnType<typeof graphStylesheet>;
}

function Header({ flow }: { flow: TxFlowDto }) {
  const { tx, call, nodes } = flow;
  const t = useT();
  const target = tx.to ? nodes.find((n) => n.address.toLowerCase() === tx.to!.toLowerCase()) : undefined;
  const targetName = target?.contract_name ?? target?.display_name ?? (tx.to ? shortAddr(tx.to) : "");
  return (
    <div className="txview__header">
      <div className="txview__call">
        {call ? (
          <>
            <span>{tx.to ? targetName : t("tx.contractCreation")} · {call.signature}</span>
            {call.args.length > 0 && (
              <details>
                <summary>{t("tx.args", { count: call.args.length })}</summary>
                <ul>
                  {call.args.map((a, i) => (
                    <li key={i} className="detail__mono">{a.name || `#${i}`} <span className="txview__muted">({a.ty})</span> = {a.value}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : tx.selector ? (
          <>
            <span className="detail__mono">{tx.selector}</span> <span className="txview__tag">{t("tx.undecoded")}</span>
          </>
        ) : (
          <span>{tx.to ? t("tx.transfer") : t("tx.contractCreation")}</span>
        )}
      </div>
      <div className="txview__meta">
        <span className={tx.success ? "txview__ok" : "txview__fail"}>
          {tx.success ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {tx.success ? t("tx.success") : t("tx.failed")}
        </span>
        <span>{t("tx.block")} <b>{tx.block_number}</b></span>
        <span className="num" title={formatLocalTime(tx.ts)}>{formatTime(tx.ts)}</span>
        <span>{t("tx.fee")} <b>{formatAmount(tx.fee, 18).text} ETH</b></span>
      </div>
    </div>
  );
}

function Tables({ flow, onPick }: { flow: TxFlowDto; onPick(addr: string): void }) {
  const [tab, setTab] = useState<"flows" | "events">("flows");
  const t = useT();
  const className = (c: ReturnType<typeof assetClass>) =>
    c === "stable" ? t("tx.class.stable") : c === "eth" ? "ETH" : c === "erc20" ? "ERC20" : "NFT";
  const addr = (a: string) => (
    <button className="detail__link detail__mono" title={a} onClick={() => onPick(a.toLowerCase())}>{shortAddr(a)}</button>
  );
  return (
    <div className="txview__tables">
      <div className="txview__tabs">
        <button aria-pressed={tab === "flows"} onClick={() => setTab("flows")}>{t("tx.tab.flows")}</button>
        <button aria-pressed={tab === "events"} onClick={() => setTab("events")}>{t("tx.tab.events")}</button>
      </div>
      {tab === "flows" ? (
        <table>
          <thead><tr><th>#</th><th>From</th><th>To</th><th>{t("transfers.col.amount")}</th><th>{t("transfers.col.type")}</th></tr></thead>
          <tbody>
            {[...flow.flows].sort((a, b) => a.seq - b.seq).map((f, i) => (
              <tr key={`${f.seq}-${i}`}>
                <td>{f.seq}</td>
                <td>{addr(f.from)}</td>
                <td>{addr(f.to)}</td>
                <td>{`${flowAmountText(f)} ${flowSymbol(f)}`}</td>
                <td>{className(assetClass(f.asset, f.kind))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table>
          <thead><tr><th>log</th><th>{t("tx.col.contract")}</th><th>{t("tx.col.event")}</th><th>{t("tx.col.args")}</th></tr></thead>
          <tbody>
            {flow.events.map((e) => (
              <tr key={e.log_index}>
                <td>{e.log_index}</td>
                <td>{addr(e.address)}</td>
                {e.name ? (
                  <>
                    <td>{e.name}</td>
                    <td className="detail__mono">
                      {e.args.map((a, i) => (
                        <span key={i} className="txview__arg">{`${a.name}=${a.value}`}</span>
                      ))}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="detail__mono">{e.topics[0] ? shortAddr(e.topics[0]) : "—"}</td>
                    <td><span className="txview__tag">{t("tx.undecoded")}</span></td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * The active tx tab's node detail, shown in the app's right panel (so the flow canvas keeps its width):
 * the tab's own selection with "Add to graph".
 */
export function TxNodeDetail({ hash }: { hash: string }) {
  const selected = useUi((s) => s.txSelection[hash.toLowerCase()] ?? null);
  const selectTx = useUi((s) => s.selectTx);
  const addCenter = useGraph((s) => s.addCenter);
  const t = useT();
  if (!selected) {
    return (
      <div className="detail">
        <div className="placeholder">{t("tx.selectNode")}</div>
      </div>
    );
  }
  return (
    <div className="detail">
      <NodeDetail key={selected} address={selected} onNavigate={(a) => selectTx(hash, a)} />
      <button
        className="txview__add"
        onClick={() => {
          addCenter(selected);
          toast(t("tx.added"));
        }}
      >
        {t("tx.addToGraph")}
      </button>
    </div>
  );
}

/** The transaction fund-flow tab: header, flow graph and tables; its node detail lives in the right panel. */
export function TxFlowView({ hash }: { hash: string }) {
  const q = useQuery({
    queryKey: qk.tx(hash),
    queryFn: () => api.tx(hash),
    // Safety net behind the TxReady SSE invalidation.
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 5000 : false),
  });
  const jobId = q.data?.job_id ?? null;
  const job = useJobProgress((s) => (jobId === null ? undefined : s.byId[jobId]));
  const theme = useTheme((s) => s.resolved);
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const stylesheet = useMemo(() => txStylesheet(theme), [theme]);
  const selected = useUi((s) => s.txSelection[hash.toLowerCase()] ?? null);
  const selectTx = useUi((s) => s.selectTx);
  const setSelected = useCallback((a: string | null) => selectTx(hash, a), [selectTx, hash]);
  const flow = q.data?.status === "ready" ? q.data.flow : null;
  const elements = useMemo(() => (flow ? txElements(flow, selected) : []), [flow, selected, locale]); // labels are translated when built
  useEffect(
    () => () => {
      exposeTxCy(hash, null);
      useUi.getState().forgetTx(hash);
    },
    [hash],
  );

  if (q.isError) {
    return (
      <div className="placeholder" role="alert">
        {messageFor(q.error)} <button onClick={() => void q.refetch()}>{t("common.retry")}</button>
      </div>
    );
  }
  if (!flow && job?.status === "failed") {
    return (
      <div className="placeholder" role="alert">
        {t("events.txFetchFailed", { reason: job.error ?? t("events.unknownReason") })}{" "}
        <button
          onClick={() => {
            useJobProgress.getState().remove([job.job_id]);
            void q.refetch();
          }}
        >
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (!flow) return <div className="placeholder">{t("tx.loading")}</div>;

  return (
    <div className="txview" data-testid="tx-view">
      <div className="txview__main">
        <Header flow={flow} />
        {flow.completeness === "fund_flow" && <div className="txview__banner">{t("tx.banner")}</div>}
        <div className="txview__graph">
          <CytoscapeView
            elements={elements}
            stylesheet={stylesheet}
            layout="dagre-lr"
            onTapNode={(id) => setSelected(id.toLowerCase())}
            onTapBackground={() => setSelected(null)}
            onTapEdge={NOOP}
            onDblTapNode={NOOP}
            onDblTapEdge={NOOP}
            onCxtNode={NOOP}
            onBoxSelect={NOOP}
            onDragEnd={NOOP}
            onReady={(cy) => exposeTxCy(hash, cy)}
          />
        </div>
        <Tables flow={flow} onPick={setSelected} />
      </div>
    </div>
  );
}
