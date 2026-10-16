import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import { qk } from "../api/queryClient";
import { CytoscapeView } from "../graph/CytoscapeView";
import { exposeTxCy } from "../graph/cyRegistry";
import { useGraph } from "../graph/store";
import { graphStylesheet } from "../graph/styles";
import { shortAddr } from "../lib/address";
import { formatAmount } from "../lib/amount";
import { assetClass } from "../lib/assets";
import { formatTime } from "../lib/format";
import { NodeDetail } from "../panels/NodeDetail";
import { useJobProgress } from "../shell/statusStore";
import { toast } from "../shell/Toasts";
import { useColorScheme } from "./AddressGraph";
import { flowAmountText, flowSymbol, txElements } from "./txElements";
import type { TxFlowDto } from "../api/generated/TxFlowDto";

const BANNER = "这是资金流图，不是完整调用树：数据来自 Etherscan 的内部交易和事件日志，不包含不带 ETH 的调用和 delegatecall 的层级。";
const CLASS_NAMES = { eth: "ETH", stable: "稳定币", erc20: "ERC20", nft: "NFT" } as const;
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
  const target = tx.to ? nodes.find((n) => n.address.toLowerCase() === tx.to!.toLowerCase()) : undefined;
  const targetName = target?.contract_name ?? target?.display_name ?? (tx.to ? shortAddr(tx.to) : "");
  return (
    <div className="txview__header">
      <div className="txview__call">
        {call ? (
          <>
            <span>{tx.to ? targetName : "合约创建"} · {call.signature}</span>
            {call.args.length > 0 && (
              <details>
                <summary>参数（{call.args.length}）</summary>
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
            <span className="detail__mono">{tx.selector}</span> <span className="txview__tag">未解码</span>
          </>
        ) : (
          <span>{tx.to ? "转账" : "合约创建"}</span>
        )}
      </div>
      <div className="txview__meta">
        <span className={tx.success ? "txview__ok" : "txview__fail"}>{tx.success ? "✓ 成功" : "✗ 失败"}</span>
        <span>区块 <b>{tx.block_number}</b></span>
        <span>{formatTime(tx.ts)}</span>
        <span>手续费 <b>{formatAmount(tx.fee, 18).text} ETH</b></span>
      </div>
    </div>
  );
}

function Tables({ flow, onPick }: { flow: TxFlowDto; onPick(addr: string): void }) {
  const [tab, setTab] = useState<"flows" | "events">("flows");
  const addr = (a: string) => (
    <button className="detail__link detail__mono" title={a} onClick={() => onPick(a.toLowerCase())}>{shortAddr(a)}</button>
  );
  return (
    <div className="txview__tables">
      <div className="txview__tabs">
        <button aria-pressed={tab === "flows"} onClick={() => setTab("flows")}>资金流动</button>
        <button aria-pressed={tab === "events"} onClick={() => setTab("events")}>事件</button>
      </div>
      {tab === "flows" ? (
        <table>
          <thead><tr><th>#</th><th>From</th><th>To</th><th>金额</th><th>类别</th></tr></thead>
          <tbody>
            {[...flow.flows].sort((a, b) => a.seq - b.seq).map((f, i) => (
              <tr key={`${f.seq}-${i}`}>
                <td>{f.seq}</td>
                <td>{addr(f.from)}</td>
                <td>{addr(f.to)}</td>
                <td>{`${flowAmountText(f)} ${flowSymbol(f)}`}</td>
                <td>{CLASS_NAMES[assetClass(f.asset, f.kind)]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table>
          <thead><tr><th>log</th><th>合约</th><th>事件</th><th>参数</th></tr></thead>
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
                    <td><span className="txview__tag">未解码</span></td>
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

/** The transaction fund-flow tab: header, flow graph, tables and a local node-detail panel. */
export function TxFlowView({ hash }: { hash: string }) {
  const q = useQuery({
    queryKey: qk.tx(hash),
    queryFn: () => api.tx(hash),
    // Safety net behind the TxReady SSE invalidation.
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 5000 : false),
  });
  const jobId = q.data?.job_id ?? null;
  const job = useJobProgress((s) => (jobId === null ? undefined : s.byId[jobId]));
  const addCenter = useGraph((s) => s.addCenter);
  const theme = useColorScheme();
  const stylesheet = useMemo(() => txStylesheet(theme), [theme]);
  const [selected, setSelected] = useState<string | null>(null);
  const flow = q.data?.status === "ready" ? q.data.flow : null;
  const elements = useMemo(() => (flow ? txElements(flow, selected) : []), [flow, selected]);
  useEffect(() => () => exposeTxCy(hash, null), [hash]);

  if (q.isError) {
    return (
      <div className="placeholder" role="alert">
        {messageFor(q.error)} <button onClick={() => void q.refetch()}>重试</button>
      </div>
    );
  }
  if (!flow && job?.status === "failed") {
    return (
      <div className="placeholder" role="alert">
        交易抓取失败：{job.error ?? "未知错误"}{" "}
        <button
          onClick={() => {
            useJobProgress.getState().remove([job.job_id]);
            void q.refetch();
          }}
        >
          重试
        </button>
      </div>
    );
  }
  if (!flow) return <div className="placeholder">正在获取交易…</div>;

  return (
    <div className="txview" data-testid="tx-view">
      <div className="txview__main">
        <Header flow={flow} />
        {flow.completeness === "fund_flow" && <div className="txview__banner">{BANNER}</div>}
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
      {selected && (
        <aside className="txview__side detail">
          <NodeDetail address={selected} onNavigate={setSelected} />
          <button
            className="txview__add"
            onClick={() => {
              addCenter(selected);
              toast("已加入关系图");
            }}
          >
            加入关系图
          </button>
        </aside>
      )}
    </div>
  );
}
