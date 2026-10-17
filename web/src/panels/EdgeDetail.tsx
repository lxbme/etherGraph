import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { useGraphData } from "../graph/useGraphData";
import { formatFixed } from "../lib/amount";
import { assetClass } from "../lib/assets";
import { formatCount } from "../lib/format";
import { shortAddr } from "../lib/address";
import { groupsForPair } from "./transferGroups";
import { pairKey } from "../graph/pairKey";

export function EdgeDetail({ a, b }: { a: string; b: string }) {
  const { data } = useGraphData();
  const t = useT();
  const expanded = useGraph((s) => s.expandedPairs.has(pairKey(a, b)));
  const togglePair = useGraph((s) => s.togglePair);
  const groups = groupsForPair(data?.edges ?? [], a, b);
  // The two ends are named A and B once; each row then reads "A → B" or "B → A".
  const side = (addr: string) => (addr === a ? "A" : "B");

  return (
    <div className="detail__section">
      <div className="overline">{t("edge.title")}</div>
      <dl className="kv">
        <dt>A</dt>
        <dd className="num" title={a}>{shortAddr(a)}</dd>
        <dt>B</dt>
        <dd className="num" title={b}>{shortAddr(b)}</dd>
      </dl>
      {groups.length === 0 ? (
        <div className="detail__muted">{t("edge.empty")}</div>
      ) : (
        <table className="table table--inset">
          <thead>
            <tr>
              <th>{t("transfers.col.asset")}</th>
              <th>{t("transfers.col.direction")}</th>
              <th className="table__num">{t("edge.col.count")}</th>
              <th className="table__num">{t("transfers.col.amount")}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const sum = formatFixed(g.sum, g.decimals, assetClass(g.asset, g.kind));
              return (
                <tr key={g.key}>
                  <td>{g.symbol ?? (g.asset === null ? "ETH" : shortAddr(g.asset))}</td>
                  <td className="num">{`${side(g.from)} → ${side(g.to)}`}</td>
                  <td className="num table__num">{formatCount(g.count)}</td>
                  <td className="num table__num" title={sum.full}>{sum.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="detail__actions">
        <button className="btn" onClick={() => togglePair(a, b)}>{expanded ? t("edge.collapse") : t("edge.expand")}</button>
      </div>
    </div>
  );
}
