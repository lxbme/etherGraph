import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { api, type TransfersParams } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import type { TransferDto } from "../api/generated/TransferDto";
import { qk } from "../api/queryClient";
import { useT } from "../i18n";
import { useAssetRegistry } from "../graph/assetRegistry";
import { graphSelection, useGraph } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";
import { shortAddr } from "../lib/address";
import { formatFixed } from "../lib/amount";
import { assetClass } from "../lib/assets";
import { formatLocalTime, formatTime } from "../lib/format";
import { transferKindName } from "../lib/transferKinds";
import { useTabs } from "../shell/tabs";
import { AssetButton } from "./info/AssetButton";
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

function UnknownDecimals() {
  const t = useT();
  return (
    <span className="transfers__warn" role="img" aria-label={t("transfers.unknownDecimals")} title={t("transfers.unknownDecimals")}>
      <AlertTriangle size={12} aria-hidden="true" />
    </span>
  );
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
                  <AssetButton tab="graph" asset={asset} tokenId={row.token_id} kind={row.kind} title={row.asset ?? undefined}>
                    {symbolOf(row.asset, row.symbol)}
                  </AssetButton>
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
  filter,
  selected,
}: {
  group: TransferGroup;
  open: boolean;
  onToggle: () => void;
  filter: EdgeFilterDto;
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
  const t = useT();
  const groups = groupsForPair(data?.edges ?? [], a, b);
  if (groups.length === 0) return <div className="transfers__msg">{t("transfers.empty")}</div>;
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

/** Node scope with two or more filtered assets: one collapsible section per asset, each with its threshold. */
function AssetSections({ address, filter, direction }: { address: string; filter: EdgeFilterDto; direction: Dir }) {
  const known = useAssetRegistry((r) => r.assets);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const assets = [...new Set((filter.assets ?? []).map((f) => normAsset(f.asset)))];
  return (
    <>
      {assets.map((asset, i) => {
        const key = asset ?? "eth";
        const isOpen = open[key] ?? i === 0;
        const min = thresholdFor(filter, asset);
        const symbol = symbolOf(asset, asset === null ? "ETH" : known[asset]?.symbol ?? null);
        return (
          <section key={key} className="transfers__group" data-testid="transfer-group">
            <button
              type="button"
              className="transfers__group-head"
              aria-expanded={isOpen}
              onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}
            >
              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>
                {symbol}
                {min !== undefined ? ` · ≥ ${min}` : ""}
              </span>
            </button>
            {isOpen && (
              <TransferRows
                selected={address}
                params={{ ...nodeParams(filter, address, direction), asset, minAmount: min }}
              />
            )}
          </section>
        );
      })}
    </>
  );
}

type Dir = TransfersParams["direction"];

/**
 * The filter's direction is relative to the centers, the transfer query's to the selected node. A center
 * keeps it; any other node sits on the far side of the canvas edges, so it flips. A center adjacent to
 * another center shows edges on both sides of it (into it and into the other center), so no direction.
 */
export function nodeDirection(dir: EdgeFilterDto["direction"], address: string, centers: string[], edges: EdgeDto[]): Dir {
  if (dir !== "in" && dir !== "out") return undefined;
  const a = address.toLowerCase();
  const cs = new Set(centers.map((c) => c.toLowerCase()));
  if (!cs.has(a)) return dir === "in" ? "out" : "in";
  const touchesCenter = edges.some((e) => {
    const f = e.from.toLowerCase();
    const t = e.to.toLowerCase();
    return (f === a && t !== a && cs.has(t)) || (t === a && f !== a && cs.has(f));
  });
  return touchesCenter ? undefined : dir;
}

/** Address-scope params: the shared carry-over plus the canvas-matching direction. */
function nodeParams(filter: EdgeFilterDto, address: string, direction: Dir): TransfersParams {
  return { ...baseParams(filter), address, direction };
}

export function TransferTable() {
  const selection = useGraph((s) => graphSelection(s.selection));
  const filter = useGraph((s) => s.filter);
  const centers = useGraph((s) => s.centers);
  const { data } = useGraphData();
  const t = useT();

  let body;
  if (!selection) {
    body = <div className="transfers__msg">{t("transfers.select")}</div>;
  } else if (selection.kind === "node") {
    const n = filter.assets?.length ?? 0;
    const direction = nodeDirection(filter.direction, selection.address, centers, data?.edges ?? []);
    if (n >= 2) {
      body = (
        <AssetSections
          key={`${selection.address}|${direction}|${JSON.stringify(filter)}`}
          address={selection.address}
          filter={filter}
          direction={direction}
        />
      );
    } else {
      const params = nodeParams(filter, selection.address, direction);
      if (n === 1) {
        const only = normAsset(filter.assets![0]!.asset);
        params.asset = only;
        params.minAmount = thresholdFor(filter, only);
      }
      body = <TransferRows key={JSON.stringify(params)} params={params} selected={selection.address} />;
    }
  } else {
    body = <PairGroups key={`${selection.a}|${selection.b}`} a={selection.a} b={selection.b} />;
  }
  return <div className="transfers">{body}</div>;
}
