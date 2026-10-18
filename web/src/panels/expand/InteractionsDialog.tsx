import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import type { CounterpartyDto } from "../../api/generated/CounterpartyDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { useT } from "../../i18n";
import { shortAddr } from "../../lib/address";
import { NATIVE_SYMBOL } from "../../lib/assets";
import { formatCount, formatLocalTime, formatTime } from "../../lib/format";
import { TRUST_MARK, trustFlag, worstFlag } from "../../lib/trust";
import { TrustBadge } from "../info/TrustBadge";
import { ExpandDialog } from "./ExpandDialog";
import { useSyncOnOpen } from "./useSyncOnOpen";

/** Rows per "Load more" page. */
const PAGE = 100;
/** Most asset symbols shown per row; the rest collapse into "+N". */
const MAX_SYMBOLS = 3;
const DAY_MS = 86_400_000;

type Sort = "count_desc" | "recent";
type Kind = "all" | "eoa" | "contract";
type Range = "7d" | "30d" | "all";

const SORTS: { value: Sort; label: "interactions.sort.count" | "interactions.sort.recent" }[] = [
  { value: "count_desc", label: "interactions.sort.count" },
  { value: "recent", label: "interactions.sort.recent" },
];
const KINDS: { value: Kind; label: "interactions.kind.all" | "interactions.kind.eoa" | "interactions.kind.contract" }[] = [
  { value: "all", label: "interactions.kind.all" },
  { value: "eoa", label: "interactions.kind.eoa" },
  { value: "contract", label: "interactions.kind.contract" },
];
const RANGES: { value: Range; label: "interactions.range.7d" | "interactions.range.30d" | "interactions.range.all" }[] = [
  { value: "7d", label: "interactions.range.7d" },
  { value: "30d", label: "interactions.range.30d" },
  { value: "all", label: "interactions.range.all" },
];

const lc = (s: string) => s.toLowerCase();

/** RFC 3339 lower bound of a range, or undefined for "all". */
function rangeFrom(range: Range): string | undefined {
  if (range === "all") return undefined;
  return new Date(Date.now() - (range === "7d" ? 7 : 30) * DAY_MS).toISOString();
}

function Segmented<T extends string>(p: {
  name: string;
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={p.label}>
      {p.options.map((o) => (
        <label key={o.value} className="seg__item">
          <input type="radio" name={p.name} checked={p.value === o.value} onChange={() => p.onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/**
 * The first symbols, a suspicious or scam one marked ⚠, then "+N"; the worst flag among all of the row's assets
 * (folded ones too) shows as one trust badge naming its token.
 */
function Assets({ item }: { item: CounterpartyDto }) {
  const symbols = item.assets.map((a) => {
    const s = a.symbol ?? (a.asset === null ? NATIVE_SYMBOL : shortAddr(a.asset));
    return trustFlag(a.trust) ? `${TRUST_MARK} ${s}` : s;
  });
  const rest = symbols.length - MAX_SYMBOLS;
  const worst = worstFlag(item.assets);
  const flagged = worst ? item.assets.find((a) => a.trust.level === worst) : undefined;
  return (
    <>
      <span title={symbols.join(", ")}>{symbols.slice(0, MAX_SYMBOLS).join(", ")}</span>
      {rest > 0 && <span className="tag tag--neutral interactions__more">{`+${rest}`}</span>}
      {flagged && (
        <span className="interactions__more">
          <TrustBadge trust={flagged.trust} subject={flagged.symbol ?? (flagged.asset === null ? NATIVE_SYMBOL : shortAddr(flagged.asset))} />
        </span>
      )}
    </>
  );
}

export interface InteractionsDialogProps {
  /** The contract whose counterparties are listed (it never becomes a center). */
  contract: NodeSummaryDto;
  onClose(): void;
}

/**
 * A contract's counterparties, to pick from (spec §5.9). Confirming opens the normal expansion dialog on exactly
 * the picked addresses. An unsynced contract is shallow-synced first; the list refetches when its data changes.
 */
export function InteractionsDialog({ contract, onClose }: InteractionsDialogProps) {
  const t = useT();
  const addr = lc(contract.address);
  const [sort, setSort] = useState<Sort>("count_desc");
  const [kind, setKind] = useState<Kind>("all");
  const [range, setRange] = useState<Range>("all");
  // Kept across pages and filter changes.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expanding, setExpanding] = useState<string[] | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const query = useInfiniteQuery({
    // Prefix ["counterparties", addr]: invalidated on AddressDataChanged for the contract.
    queryKey: ["counterparties", addr, { sort, kind, range }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.counterparties(addr, { sort, kind, from: rangeFrom(range), limit: PAGE, offset: pageParam }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? loaded : undefined;
    },
  });
  // Pages can overlap when rows shift between fetches: one row per address.
  const items = [
    ...new Map((query.data?.pages.flatMap((p) => p.items) ?? []).map((i) => [lc(i.node.address), i])).values(),
  ];
  const total = query.data?.pages[0]?.total ?? 0;
  // The job's rows are in: show them without waiting for the coalesced event.
  const syncing = useSyncOnOpen(contract, () => void query.refetch());

  useEffect(() => {
    if (expanding) return;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanding, onClose]);

  const toggle = (a: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(a)) next.add(a);
      return next;
    });

  // Cancelling the expansion comes back to this list, picks intact; a confirmed one closes both.
  if (expanding) {
    return (
      <ExpandDialog
        node={contract}
        preset={expanding.filter((a) => a !== addr)}
        onClose={() => setExpanding(null)}
        onDone={onClose}
      />
    );
  }

  const title = t("interactions.title", { name: contract.display_name ?? contract.contract_name ?? shortAddr(addr) });
  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog interactions" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        <h3 className="dialog__title">{title}</h3>
        <div className="interactions__filters">
          <Segmented<Sort> name="ix-sort" label={t("interactions.sort")} value={sort} onChange={setSort}
            options={SORTS.map((o) => ({ value: o.value, label: t(o.label) }))} />
          <Segmented<Kind> name="ix-kind" label={t("interactions.kind")} value={kind} onChange={setKind}
            options={KINDS.map((o) => ({ value: o.value, label: t(o.label) }))} />
          <Segmented<Range> name="ix-range" label={t("interactions.range")} value={range} onChange={setRange}
            options={RANGES.map((o) => ({ value: o.value, label: t(o.label) }))} />
        </div>
        {syncing && items.length === 0 && <div className="dialog__summary">{t("interactions.syncing")}</div>}
        {query.isError ? (
          <div className="dialog__error" role="alert">
            {messageFor(query.error)}{" "}
            <button type="button" className="btn btn--compact" onClick={() => void query.refetch()}>{t("common.retry")}</button>
          </div>
        ) : query.isPending ? (
          <div className="dialog__summary">{t("expand.loading")}</div>
        ) : items.length === 0 ? (
          !syncing && <div className="dialog__summary">{t("interactions.empty")}</div>
        ) : (
          <div className="expand__list">
            <table className="table table--inset">
              <thead>
                <tr>
                  <th />
                  <th>{t("interactions.col.counterparty")}</th>
                  <th>{t("interactions.col.kind")}</th>
                  <th className="table__num">{t("interactions.col.count")}</th>
                  <th>{t("interactions.col.recent")}</th>
                  <th>{t("interactions.col.assets")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const a = lc(it.node.address);
                  const name = it.node.display_name ?? it.node.contract_name;
                  return (
                    <tr key={a}>
                      <td>
                        <input type="checkbox" aria-label={a} checked={picked.has(a)} onChange={() => toggle(a)} />
                      </td>
                      <td>
                        {name && <div>{name}</div>}
                        <span className="num" title={a}>{shortAddr(a)}</span>
                      </td>
                      <td>{t(`node.kind.${it.node.kind}`)}</td>
                      <td className="table__num num">{formatCount(it.count)}</td>
                      <td className="num" title={it.last_ts ? formatLocalTime(it.last_ts) : undefined}>
                        {it.last_ts ? formatTime(it.last_ts) : "—"}
                      </td>
                      <td><Assets item={it} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {query.hasNextPage && (
              <button
                type="button"
                className="btn btn--compact"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t("transfers.loadMore")}
              </button>
            )}
          </div>
        )}
        <div className="dialog__summary">{t("interactions.shown", { shown: items.length, total })}</div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="btn btn--primary" disabled={picked.size === 0} onClick={() => setExpanding([...picked])}>
            {t("interactions.confirm", { count: picked.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
