import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type TransfersParams } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import type { TransferDto } from "../api/generated/TransferDto";
import { qk } from "../api/queryClient";
import { useGraph } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";
import { shortAddr } from "../lib/address";
import { formatAmount } from "../lib/amount";
import { formatTime } from "../lib/format";
import { useTabs } from "../shell/tabs";
import { groupsForPair, type TransferGroup } from "./transferGroups";

const PAGE_SIZE = 50;

/** Normalizes a filter asset ("eth" / null / undefined -> null, else lowercase address). */
function normAsset(a: string | null | undefined): string | null {
  return a == null || a.toLowerCase() === "eth" ? null : a.toLowerCase();
}

function thresholdFor(filter: EdgeFilterDto, asset: string | null): string | undefined {
  const hit = filter.assets?.find((e) => normAsset(e.asset) === asset);
  return hit?.min_amount ?? undefined;
}

/** Filter carry-over shared by every scope (kinds, time). */
function baseParams(filter: EdgeFilterDto): TransfersParams {
  return {
    kinds: filter.kinds ?? undefined,
    timeFrom: filter.time?.from ?? undefined,
    timeTo: filter.time?.to ?? undefined,
  };
}

function symbolOf(asset: string | null, symbol: string | null): string {
  return symbol ?? (asset === null ? "ETH" : shortAddr(asset));
}

function Amount({ raw, decimals }: { raw: string; decimals: number | null }) {
  const f = formatAmount(raw, decimals);
  return (
    <>
      {f.text}
      {f.unknownDecimals && (
        <span className="transfers__warn" title="未知精度">
          {" "}
          ⚠
        </span>
      )}
    </>
  );
}

function TransferRows({ params, selected }: { params: TransfersParams; selected: string }) {
  const highlight = useGraph((s) => s.highlightTransfer);
  const setHighlight = useGraph((s) => s.setHighlightTransfer);
  const openTx = useTabs((s) => s.openTx);
  const q = useInfiniteQuery({
    queryKey: qk.transfers(params),
    queryFn: ({ pageParam }) => api.transfers({ ...params, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });

  if (q.error) {
    return (
      <div className="transfers__msg transfers__msg--error" role="alert">
        {messageFor(q.error)}{" "}
        <button type="button" className="btn" onClick={() => void q.refetch()}>
          重试
        </button>
      </div>
    );
  }
  if (q.isPending) return <div className="transfers__msg">加载中…</div>;
  const items: TransferDto[] = q.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <div className="transfers__msg">没有符合条件的转账</div>;

  const sel = selected.toLowerCase();
  const onRow = (t: TransferDto) => {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    const asset = t.asset === null ? null : t.asset.toLowerCase();
    const same = highlight && highlight.from === from && highlight.to === to && highlight.asset === asset;
    setHighlight(same ? null : { from, to, asset });
  };

  return (
    <>
      <table className="transfers__table">
        <thead>
          <tr>
            <th>时间</th>
            <th>方向</th>
            <th>对手方</th>
            <th>金额</th>
            <th>类别</th>
            <th>交易哈希</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => {
            const from = t.from.toLowerCase();
            const to = t.to.toLowerCase();
            const asset = t.asset === null ? null : t.asset.toLowerCase();
            const dir = from === sel && to === sel ? "自转" : to === sel ? "流入" : "流出";
            const other = from === sel ? t.to : t.from;
            const active = !!highlight && highlight.from === from && highlight.to === to && highlight.asset === asset;
            return (
              <tr
                key={`${t.tx_hash}:${t.sub_id}:${t.kind}`}
                className={active ? "transfers__row transfers__row--active" : "transfers__row"}
                onClick={() => onRow(t)}
              >
                <td>{formatTime(t.ts)}</td>
                <td>{dir}</td>
                <td title={other}>{shortAddr(other)}</td>
                <td className="transfers__amount">
                  <Amount raw={t.amount} decimals={t.decimals} /> {symbolOf(t.asset, t.symbol)}
                </td>
                <td>{t.kind}</td>
                <td>
                  <button
                    type="button"
                    className="transfers__hash"
                    title={t.tx_hash}
                    onClick={(e) => {
                      e.stopPropagation();
                      openTx(t.tx_hash);
                    }}
                  >
                    {shortAddr(t.tx_hash)}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {q.hasNextPage && (
        <button type="button" className="btn transfers__more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? "加载中…" : "加载更多"}
        </button>
      )}
    </>
  );
}

function GroupSection({
  group,
  open,
  onToggle,
  filter,
  selected,
}: {
  group: TransferGroup;
  open: boolean;
  onToggle: () => void;
  filter: EdgeFilterDto;
  selected: string;
}) {
  const sum = formatAmount(group.sum, group.decimals);
  const title = `${symbolOf(group.asset, group.symbol)} · ${shortAddr(group.from)}→${shortAddr(group.to)} · ${group.count} 笔 · Σ ${sum.text}`;
  return (
    <section className="transfers__group">
      <button type="button" className="transfers__group-head" aria-expanded={open} onClick={onToggle}>
        {open ? "▾" : "▸"} {title}
        {sum.unknownDecimals ? " ⚠" : ""}
      </button>
      {open && (
        <TransferRows
          selected={selected}
          params={{
            ...baseParams(filter),
            from: group.from,
            to: group.to,
            asset: group.asset,
            minAmount: thresholdFor(filter, group.asset),
          }}
        />
      )}
    </section>
  );
}

function PairGroups({ a, b }: { a: string; b: string }) {
  const filter = useGraph((s) => s.filter);
  const { data } = useGraphData();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = groupsForPair(data?.edges ?? [], a, b);
  if (groups.length === 0) return <div className="transfers__msg">没有符合条件的转账</div>;
  return (
    <>
      {groups.map((g, i) => (
        <GroupSection
          key={g.key}
          group={g}
          open={open[g.key] ?? i === 0}
          onToggle={() => setOpen((o) => ({ ...o, [g.key]: !(o[g.key] ?? i === 0) }))}
          filter={filter}
          selected={a}
        />
      ))}
    </>
  );
}

export function TransferTable() {
  const selection = useGraph((s) => s.selection);
  const filter = useGraph((s) => s.filter);

  let body;
  if (!selection) {
    body = <div className="transfers__msg">选择一个节点或一条边查看转账明细</div>;
  } else if (selection.kind === "node") {
    const only = filter.assets?.length === 1 ? normAsset(filter.assets[0]!.asset) : undefined;
    const params: TransfersParams = { ...baseParams(filter), address: selection.address };
    if (only !== undefined) {
      params.asset = only;
      params.minAmount = thresholdFor(filter, only);
    }
    body = <TransferRows key={JSON.stringify(params)} params={params} selected={selection.address} />;
  } else {
    body = <PairGroups key={`${selection.a}|${selection.b}`} a={selection.a} b={selection.b} />;
  }
  return <div className="transfers">{body}</div>;
}
