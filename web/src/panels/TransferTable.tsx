import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { api, type TransfersParams } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { TransferDto } from "../api/generated/TransferDto";
import { qk } from "../api/queryClient";
import { useT } from "../i18n";
import { graphSelection, useGraph } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";
import { shortAddr } from "../lib/address";
import { formatFixed } from "../lib/amount";
import { assetClass } from "../lib/assets";
import { formatLocalTime, formatTime } from "../lib/format";
import { transferKindName } from "../lib/transferKinds";
import { useTabs } from "../shell/tabs";
import { AssetButton } from "./info/AssetButton";
import { TrustBadge } from "./info/TrustBadge";
import { TransferFilterBar } from "./TransferFilterBar";
import { transferParams, useTransferFilter } from "./transferFilter";
import { TruncationBanner } from "./TruncationBanner";
import { UnknownDecimals } from "./UnknownDecimals";
import { groupsForPair, type TransferGroup } from "./transferGroups";
import { useRefreshFromChain } from "../workspace/snapshot";

const PAGE_SIZE = 50;

function symbolOf(asset: string | null, symbol: string | null): string {
  return symbol ?? (asset === null ? "ETH" : shortAddr(asset));
}

/** Right-aligned fixed-decimal amount cell; the exact value is the title. */
function AmountCell({ row }: { row: TransferDto }) {
  const f = formatFixed(row.amount, row.decimals, assetClass(row.asset, row.kind));
  return (
    <td className="num table__num" title={f.full}>
      {f.unknownDecimals && <UnknownDecimals />}
      {f.text}
    </td>
  );
}

function TransferRows({ params, selected }: { params: TransfersParams; selected: string }) {
  const highlight = useGraph((s) => s.highlightTransfer);
  const setHighlight = useGraph((s) => s.setHighlightTransfer);
  const openTx = useTabs((s) => s.openTx);
  const t = useT();
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
        <button type="button" className="btn btn--compact" onClick={() => void q.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (q.isPending) return <div className="transfers__msg">{t("common.loading")}</div>;
  const items: TransferDto[] = q.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <div className="transfers__msg">{t("transfers.empty")}</div>;

  const sel = selected.toLowerCase();
  const onRow = (row: TransferDto) => {
    const from = row.from.toLowerCase();
    const to = row.to.toLowerCase();
    const asset = row.asset === null ? null : row.asset.toLowerCase();
    const hash = row.tx_hash.toLowerCase();
    const g = useGraph.getState();
    const context = graphSelection(g.selection);
    const same =
      g.selection?.kind === "tx" && g.selection.hash === hash &&
      !!highlight && highlight.from === from && highlight.to === to && highlight.asset === asset;
    // A second click on the highlighted row returns to the origin node/pair (select() also clears the highlight).
    if (same) {
      g.select(context);
      return;
    }
    // select() clears the highlight, so it goes first; the tx keeps the origin node/pair as its context.
    g.select({ kind: "tx", hash, context });
    setHighlight({ from, to, asset });
  };

  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>{t("transfers.col.time")}</th>
            <th>{t("transfers.col.direction")}</th>
            <th>{t("transfers.col.counterparty")}</th>
            <th className="table__num">{t("transfers.col.amount")}</th>
            <th>{t("transfers.col.asset")}</th>
            <th>{t("transfers.col.type")}</th>
            <th>{t("transfers.col.hash")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => {
            const from = row.from.toLowerCase();
            const to = row.to.toLowerCase();
            const asset = row.asset === null ? null : row.asset.toLowerCase();
            const dir = from === sel && to === sel ? "self" : to === sel ? "in" : "out";
            const other = from === sel ? row.to : row.from;
            const active = !!highlight && highlight.from === from && highlight.to === to && highlight.asset === asset;
            return (
              <tr
                key={`${row.tx_hash}:${row.sub_id}:${row.kind}`}
                className={active ? "transfers__row transfers__row--active" : "transfers__row"}
                data-testid="transfer-row"
                onClick={() => onRow(row)}
              >
                <td className="num" title={formatLocalTime(row.ts)}>{formatTime(row.ts)}</td>
                <td className={`transfers__dir transfers__dir--${dir}`}>{t(`transfers.dir.${dir}`)}</td>
                <td className="num" title={other}>{shortAddr(other)}</td>
                <AmountCell row={row} />
                <td>
                  <span className="asset-symbol">
                    <AssetButton tab="graph" asset={asset} tokenId={row.token_id} kind={row.kind} title={row.asset ?? undefined}>
                      {symbolOf(row.asset, row.symbol)}
                    </AssetButton>
                    <TrustBadge trust={row.trust} />
                  </span>
                </td>
                <td className="transfers__muted">{transferKindName(row.kind, t)}</td>
                <td>
                  <button
                    type="button"
                    className="transfers__hash num"
                    title={row.tx_hash}
                    onClick={(e) => {
                      e.stopPropagation();
                      openTx(row.tx_hash);
                    }}
                  >
                    {shortAddr(row.tx_hash)}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {q.hasNextPage && (
        <button type="button" className="btn btn--compact transfers__more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? t("common.loading") : t("transfers.loadMore")}
        </button>
      )}
    </>
  );
}

function GroupSection({
  group,
  open,
  onToggle,
  params,
  selected,
}: {
  group: TransferGroup;
  open: boolean;
  onToggle: () => void;
  /** The bar's time and type, for every group. */
  params: TransfersParams;
  selected: string;
}) {
  const t = useT();
  const sum = formatFixed(group.sum, group.decimals, assetClass(group.asset, group.kind));
  const title = t("transfers.group", {
    symbol: symbolOf(group.asset, group.symbol),
    from: shortAddr(group.from),
    to: shortAddr(group.to),
    count: group.count,
    sum: sum.text,
  });
  return (
    <section className="transfers__group" data-testid="transfer-group">
      <button type="button" className="transfers__group-head" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span title={sum.full}>{title}</span>
        {sum.unknownDecimals && <UnknownDecimals />}
        <TrustBadge trust={group.trust} />
      </button>
      {open && (
        <TransferRows
          selected={selected}
          params={{ ...params, from: group.from, to: group.to, asset: group.asset }}
        />
      )}
    </section>
  );
}

/** The pair's (direction, asset) groups; the bar's asset hides the others, its time and type narrow the rows. */
function PairGroups({ a, b, edges }: { a: string; b: string; edges: EdgeDto[] }) {
  const filter = useTransferFilter();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const t = useT();
  const groups = groupsForPair(edges, a, b).filter((g) => filter.asset === undefined || g.asset === filter.asset);
  // Each group has its own direction and asset.
  const params = transferParams({ ...filter, asset: undefined, direction: "all" });
  if (groups.length === 0) return <div className="transfers__msg">{t("transfers.empty")}</div>;
  return (
    <>
      {groups.map((g, i) => (
        <GroupSection
          key={g.key}
          group={g}
          open={open[g.key] ?? i === 0}
          onToggle={() => setOpen((o) => ({ ...o, [g.key]: !(o[g.key] ?? i === 0) }))}
          params={params}
          selected={a}
        />
      ))}
    </>
  );
}

/** The graph edges touching a node, or running between a pair in either direction. */
function edgesTouching(edges: EdgeDto[], sel: { kind: "node"; address: string } | { kind: "pair"; a: string; b: string }): EdgeDto[] {
  if (sel.kind === "node") {
    const a = sel.address.toLowerCase();
    return edges.filter((e) => e.from.toLowerCase() === a || e.to.toLowerCase() === a);
  }
  const x = sel.a.toLowerCase();
  const y = sel.b.toLowerCase();
  return edges.filter((e) => {
    const f = e.from.toLowerCase();
    const t = e.to.toLowerCase();
    return (f === x && t === y) || (f === y && t === x);
  });
}

export function TransferTable() {
  const selection = useGraph((s) => graphSelection(s.selection));
  const frozen = useGraph((s) => s.frozen !== null);
  const filter = useTransferFilter();
  const { data } = useGraphData();
  const refreshFromChain = useRefreshFromChain();
  const t = useT();

  if (!selection) {
    return <div className="transfers"><div className="transfers__msg">{t("transfers.select")}</div></div>;
  }
  if (frozen) {
    // A snapshot carries edges, not single transfers; the receiver's own rows would not match its edges.
    return (
      <div className="transfers">
        <div className="transfers__msg">
          {t("transfers.snapshot")}{" "}
          <button type="button" className="btn btn--compact" onClick={refreshFromChain}>
            {t("snapshot.refresh")}
          </button>
        </div>
      </div>
    );
  }
  const edges = data?.edges ?? [];
  let banner = null;
  let body;
  if (selection.kind === "node") {
    const sel = selection.address.toLowerCase();
    const coverage = Object.entries(data?.coverage ?? {}).find(([a]) => a.toLowerCase() === sel)?.[1] ?? [];
    banner = <TruncationBanner address={selection.address} coverage={coverage} forGraph />;
    const params: TransfersParams = { address: selection.address, ...transferParams(filter) };
    body = <TransferRows key={JSON.stringify(params)} params={params} selected={selection.address} />;
  } else {
    body = <PairGroups key={`${selection.a}|${selection.b}`} a={selection.a} b={selection.b} edges={edges} />;
  }
  return (
    <div className="transfers">
      <TransferFilterBar edges={edgesTouching(edges, selection)} pair={selection.kind === "pair"} />
      {banner}
      {body}
    </div>
  );
}
