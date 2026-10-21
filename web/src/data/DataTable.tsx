import { Eye, EyeOff } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TransferDto } from "../api/generated/TransferDto";
import { hiddenFromTransfer, transferKey } from "../graph/hiddenTransfers";
import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { shortAddr } from "../lib/address";
import { formatFixed } from "../lib/amount";
import { assetClass } from "../lib/assets";
import { formatLocalTime, formatTime } from "../lib/format";
import { transferKindName } from "../lib/transferKinds";
import { UnknownDecimals } from "../panels/UnknownDecimals";
import { useTabs } from "../shell/tabs";

/** A row's fixed height in px (the `--h-data-row` token): rows are placed by index. */
export const DATA_ROW_HEIGHT = 32;
/** Rows rendered beyond each edge of the visible part. */
const OVERSCAN = 10;
/** The height assumed before the list is measured (and in tests, where nothing has a size). */
const FALLBACK_VIEW = 600;

type View = { top: number; height: number };

/** An address cell: its name when it has one, else the short address; the full address is the title. */
function Who({ addr, names }: { addr: string; names: ReadonlyMap<string, string> }) {
  return (
    <span role="cell" className="data__cell num" title={addr}>
      {names.get(addr.toLowerCase()) ?? shortAddr(addr)}
    </span>
  );
}

/**
 * The Data tab's transfers, windowed: a block as tall as all the rows, with only those near the visible part
 * rendered (absolutely placed at a fixed height), so tens of thousands stay smooth. Each row's eye button hides or
 * shows that transfer (one undo step); the hash opens its tx tab. `names`: display names by lowercase address.
 */
export function DataTable({ rows, names }: { rows: TransferDto[]; names: ReadonlyMap<string, string> }) {
  const t = useT();
  const hiddenTransfers = useGraph((s) => s.hiddenTransfers);
  const setTransfersHidden = useGraph((s) => s.setTransfersHidden);
  const openTx = useTabs((s) => s.openTx);
  const [view, setView] = useState<View>({ top: 0, height: 0 });
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  /** The rows block's offset in the scrolled box (below the sticky header). */
  const [offset, setOffset] = useState(0);

  // The box's height, for windowing, measured on mount and whenever it is resized.
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;
    const measure = () => setView((v) => (v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollEl]);
  useLayoutEffect(() => {
    const o = body.current?.offsetTop ?? 0;
    if (o !== offset) setOffset(o);
  });

  const height = view.height > 0 ? view.height : FALLBACK_VIEW;
  const from = Math.max(0, Math.floor((view.top - offset) / DATA_ROW_HEIGHT) - OVERSCAN);
  const to = Math.min(rows.length, Math.ceil((view.top + height - offset) / DATA_ROW_HEIGHT) + OVERSCAN);

  return (
    <div
      className="data__scroll"
      ref={setScrollEl}
      data-testid="data-scroll"
      onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
    >
      <div className="data__table" role="table" aria-rowcount={rows.length + 1}>
        <div className="data__head" role="row" aria-rowindex={1}>
          <span role="columnheader" className="data__cell" aria-label={t("data.col.visible")} />
          <span role="columnheader" className="data__cell">{t("transfers.col.time")}</span>
          <span role="columnheader" className="data__cell">{t("tx.col.from")}</span>
          <span role="columnheader" className="data__cell">{t("tx.col.to")}</span>
          <span role="columnheader" className="data__cell data__num">{t("transfers.col.amount")}</span>
          <span role="columnheader" className="data__cell">{t("transfers.col.asset")}</span>
          <span role="columnheader" className="data__cell">{t("transfers.col.type")}</span>
          <span role="columnheader" className="data__cell">{t("transfers.col.hash")}</span>
        </div>
        <div className="data__body" role="rowgroup" ref={body} style={{ height: rows.length * DATA_ROW_HEIGHT }}>
          {rows.slice(from, Math.max(from, to)).map((row, i) => {
            const hidden = transferKey(row) in hiddenTransfers;
            const amount = formatFixed(row.amount, row.decimals, assetClass(row.asset, row.kind));
            return (
              <div
                key={`${transferKey(row)}:${row.kind}`}
                role="row"
                aria-rowindex={from + i + 2}
                className={hidden ? "data__row data__row--hidden" : "data__row"}
                style={{ top: (from + i) * DATA_ROW_HEIGHT }}
                data-testid="data-row"
              >
                <span role="cell" className="data__cell">
                  <button
                    type="button"
                    className="btn btn--icon btn--compact"
                    aria-pressed={hidden}
                    aria-label={t(hidden ? "data.row.show" : "data.row.hide")}
                    title={t(hidden ? "data.row.show" : "data.row.hide")}
                    onClick={() => setTransfersHidden([hiddenFromTransfer(row)], !hidden)}
                  >
                    {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </span>
                <span role="cell" className="data__cell num" title={formatLocalTime(row.ts)}>{formatTime(row.ts)}</span>
                <Who addr={row.from} names={names} />
                <Who addr={row.to} names={names} />
                <span role="cell" className="data__cell data__num num" title={amount.full}>
                  {amount.unknownDecimals && <UnknownDecimals />}
                  {amount.text}
                </span>
                <span role="cell" className="data__cell" title={row.asset ?? undefined}>
                  {row.symbol ?? (row.asset === null ? "ETH" : shortAddr(row.asset))}
                </span>
                <span role="cell" className="data__cell data__muted">{transferKindName(row.kind, t)}</span>
                <span role="cell" className="data__cell">
                  <button type="button" className="transfers__hash num" title={row.tx_hash} onClick={() => openTx(row.tx_hash)}>
                    {shortAddr(row.tx_hash)}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
