import { useGraph } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";
import { formatAmount } from "../lib/amount";
import { formatCount } from "../lib/format";
import { shortAddr } from "../lib/address";
import { groupsForPair } from "./transferGroups";
import { pairKey } from "../graph/pairKey";

export function EdgeDetail({ a, b }: { a: string; b: string }) {
  const { data } = useGraphData();
  const expanded = useGraph((s) => s.expandedPairs.has(pairKey(a, b)));
  const togglePair = useGraph((s) => s.togglePair);
  const groups = groupsForPair(data?.edges ?? [], a, b);

  return (
    <div className="detail__section">
      <h3 className="detail__title">节点对</h3>
      <div className="detail__mono" title={a}>{shortAddr(a)}</div>
      <div className="detail__mono" title={b}>{shortAddr(b)}</div>
      <ul className="detail__list">
        {groups.map((g) => (
          <li key={g.key}>
            <span>{g.symbol ?? (g.asset === null ? "ETH" : shortAddr(g.asset))}</span>
            <span className="detail__mono">{shortAddr(g.from)} → {shortAddr(g.to)}</span>
            <span>{formatCount(g.count)}</span>
            <span>{formatAmount(g.sum, g.decimals).text}</span>
          </li>
        ))}
      </ul>
      {groups.length === 0 && <div className="placeholder">暂无转账</div>}
      <button onClick={() => togglePair(a, b)}>{expanded ? "收起平行边" : "展开平行边"}</button>
    </div>
  );
}
