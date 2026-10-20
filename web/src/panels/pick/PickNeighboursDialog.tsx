import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { TrustDto } from "../../api/generated/TrustDto";
import { nodeCapacity, SHALLOW_CALLS, SHALLOW_MAX_CALLS } from "../../graph/budget";
import { useCanvasMetrics } from "../../graph/canvasMetrics";
import { MAX_CENTERS, MAX_NEIGHBOUR_LIMIT, ownNeighbours, useGraph, type SortKey } from "../../graph/store";
import { useT } from "../../i18n";
import { shortAddr } from "../../lib/address";
import { newBatchId } from "../../lib/batchId";
import { formatAmount } from "../../lib/amount";
import { formatTime } from "../../lib/format";
import { TRUST_MARK, TRUST_TIER, isListed, trustFlag, trustText } from "../../lib/trust";
import { useJobProgress, useQuota } from "../../shell/statusStore";
import { toast } from "../../shell/Toasts";
import { offerUndo } from "../expand/expansion";
import { TrustBadge } from "../info/TrustBadge";
import { TruncationBanner } from "../TruncationBanner";
import { UnknownDecimals } from "../UnknownDecimals";
import { flowMatches, flowTotals, type NeighbourRow } from "./neighbours";
import { usePickData, type PickGroup } from "./usePickData";

/** Height of one neighbour row in px: `--h-pick-row` in tokens.css. */
export const PICK_ROW_HEIGHT = 44;
/** Rows rendered beyond the visible ones, above and below. */
const OVERSCAN = 10;
/** The list's height before it is measured (and in tests, where nothing has a size). */
const FALLBACK_VIEW = 600;
/** The asset filter's "all assets" value; the native coin (no asset address) is "native". */
const ALL = "";
const NATIVE = "native";

const lc = (s: string) => s.toLowerCase();
const nameOf = (n: NodeSummaryDto | undefined, address: string) =>
  n?.display_name ?? n?.ens ?? n?.contract_name ?? shortAddr(address);
const assetKey = (a: string | null) => a ?? NATIVE;

/** The direction filter's values, relative to the center ("out": center → neighbour). */
type Direction = "all" | "in" | "out";
const DIRECTIONS: Direction[] = ["all", "in", "out"];

interface AssetOption {
  key: string;
  label: string;
  trust: TrustDto;
}

type T = ReturnType<typeof useT>;

/** "3 days ago" for `iso` as of `now`; the input unchanged if it does not parse. */
export function ago(iso: string, now: number, t: T): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return t("pick.ago.now");
  if (minutes < 60) return t("pick.ago.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("pick.ago.hours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("pick.ago.days", { count: days });
  if (days < 365) return t("pick.ago.months", { count: Math.floor(days / 30) });
  return t("pick.ago.years", { count: Math.floor(days / 365) });
}

/** The stepper's value as k, or null when it is not a whole number in 1..=MAX_NEIGHBOUR_LIMIT. */
function parseK(s: string): number | null {
  const n = Number(s);
  return s.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= MAX_NEIGHBOUR_LIMIT ? n : null;
}

/** Whether `r` matches the search text `q` (lowercase, trimmed): its name, ENS name, contract name or address. */
function matches(r: NeighbourRow, q: string): boolean {
  if (q === "") return true;
  const n = r.node;
  return [r.address, n.display_name, n.ens, n.contract_name].some((s) => s != null && lc(s).includes(q));
}

/** Job statuses that end a sync without its data: "Syncing…" stops and Sync is offered again. */
const ENDED_UNDONE: ReadonlySet<string> = new Set(["failed", "cancelled"]);

/** A sync asked for in the dialog: the group's `lastSynced` then, and the jobs queued for it (null until answered). */
interface Requested {
  lastSynced: string | null;
  jobs: number[] | null;
}

/** Where the list is scrolled to and how tall it is. */
interface View {
  top: number;
  height: number;
}

/**
 * The neighbour picker (spec §3, §5.2–§5.3): every neighbour of each target under the graph's filter, checked by
 * default like "top k" would add them; confirming makes each synced target a picked center showing exactly the checked
 * ones (one undo step). A target that is not synced asks to sync first (the only call the dialog makes, on a click);
 * its group fills itself once the sync is done. A dialog for one unsynced target is that question alone.
 * Mount it fresh per open: k starts from the number of targets.
 */
export function PickNeighboursDialog({
  targets,
  data,
  onClose,
}: {
  targets: string[];
  /** The canvas: which neighbours each center shows now (for the hiding rule of `applyPicks`). */
  data: GraphResponseDto | undefined;
  onClose(): void;
}) {
  const t = useT();
  const { groups, loading, error, k, setK } = usePickData(targets);
  const graphSort = useGraph((s) => s.sort);
  const centers = useGraph((s) => s.centers);
  const picks = useGraph((s) => s.picks);
  const quota = useQuota((s) => s.quota);
  const metrics = useCanvasMetrics();
  const [openedK] = useState(k);
  const [draft, setDraft] = useState(() => String(k));
  const [query, setQuery] = useState("");
  const [asset, setAsset] = useState(ALL);
  const [direction, setDirection] = useState<Direction>("all");
  const [sort, setSort] = useState<SortKey>(graphSort);
  /** Checks per center; a center without an entry shows its `defaults` (a top-k one follows k that way). */
  const [checked, setChecked] = useState<Record<string, Set<string>>>({});
  /** Each group's checks when it was first listed: what "Restore default checks" goes back to. */
  const [initial, setInitial] = useState<Record<string, string[]>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  /** Per center, the row focused last: the group's one Tab stop while it is rendered (roving tabindex). */
  const [active, setActive] = useState<Record<string, string>>({});
  /**
   * Syncs asked for here, with the group's `lastSynced` then and the jobs the server queued (null until it answers):
   * "Syncing…" until the summary takes over.
   */
  const [requested, setRequested] = useState<Record<string, Requested>>({});
  /** The checks and k right before the last change of k: what "Undo" next to k goes back to (once). */
  const [kUndo, setKUndo] = useState<{ k: number; checked: Record<string, Set<string>> } | null>(null);
  const [view, setView] = useState<View>({ top: 0, height: 0 });
  const dialogRef = useRef<HTMLDivElement>(null);
  /** The list element while it is mounted (not while the dialog is loading or the sync question). */
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const jobs = useJobProgress((s) => s.byId);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const many = groups.length > 1;
  const first = groups[0];
  /** One target known not to be synced: the dialog is the sync question alone. */
  const confirmOnly = !many && !!first && !!data && first.known && !first.synced;
  /** One target the canvas does not show yet (or shows only in a stand-in result): nothing is known about it. */
  const waiting = !data || (!many && !!first && !first.known);

  // The list's height, for windowing, measured whenever the list mounts (it is not there while loading or asking to sync).
  useEffect(() => {
    const el = listEl;
    if (!el) return;
    const measure = () => setView((v) => (v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [listEl]);

  // A group listed for the first time: remember its default checks.
  useEffect(() => {
    if (loading) return;
    const fresh = groups.filter((g) => g.synced && !(g.center in initial));
    if (fresh.length > 0) setInitial((prev) => ({ ...prev, ...Object.fromEntries(fresh.map((g) => [g.center, g.defaults])) }));
  }, [loading, groups, initial]);

  // A requested sync shows as the summary's own flag once it is set (so "Syncing…" ends when that flag clears again,
  // done or failed), is over once the sync time moved, and ends when its jobs failed or were cancelled before the
  // canvas ever showed it syncing.
  useEffect(() => {
    setRequested((prev) => {
      let next: Record<string, Requested> | null = null;
      for (const g of groups) {
        const r = prev[g.center];
        if (!r) continue;
        const failed = !!r.jobs && r.jobs.every((id) => jobs[id] && ENDED_UNDONE.has(jobs[id].status));
        if (!g.syncing && g.lastSynced === r.lastSynced && !failed) continue;
        next ??= { ...prev };
        delete next[g.center];
      }
      return next ?? prev;
    });
  }, [groups, jobs]);

  const synced = groups.filter((g) => g.synced);
  const selection = (g: PickGroup): Set<string> => checked[g.center] ?? new Set(g.defaults);
  const isChecked = (r: NeighbourRow, sel: Set<string>) => r.locked || sel.has(r.address);
  /** The group's new picks: the checked rows, locked ones included, plus checked addresses the filter does not list. */
  const resultOf = (g: PickGroup): string[] => {
    const sel = selection(g);
    const out = new Set(g.rows.filter((r) => isChecked(r, sel)).map((r) => r.address));
    for (const a of sel) out.add(a);
    return [...out];
  };
  /** The neighbours the center shows now (picks, or a top-k center's shown ones): clearing them to none is a change. */
  const shownNow = (c: string): string[] => (centers.includes(c) ? ownNeighbours(c, data) : []);

  let checkedCount = 0;
  const newNodes = new Set<string>();
  const listed = new Set<string>();
  const onCanvas = new Set<string>();
  for (const g of synced) {
    const sel = selection(g);
    for (const r of g.rows) {
      listed.add(r.address);
      if (r.onCanvas) onCanvas.add(r.address);
      if (!isChecked(r, sel)) continue;
      checkedCount++;
      if (!r.onCanvas) newNodes.add(r.address);
    }
  }
  const centerCount = new Set([...centers, ...synced.map((g) => g.center)]).size;
  const tooMany = centerCount > MAX_CENTERS;
  const capacity = nodeCapacity(metrics);
  const overCanvas = metrics.visible + newNodes.size > capacity;
  // An errored list or top-k run lists nothing to keep: confirming could clear a center showing neighbours to none.
  const canConfirm =
    !loading &&
    error == null &&
    !tooMany &&
    synced.some((g) => resultOf(g).length > 0 || shownNow(g.center).length > 0);
  const quotaLeft = quota ? Math.max(quota.limit - quota.used, 0) : null;

  const assets = useMemo(() => {
    const out = new Map<string, AssetOption>();
    for (const g of groups) {
      for (const r of g.rows) {
        for (const a of r.assets) {
          const key = assetKey(a.asset);
          if (!out.has(key)) out.set(key, { key, label: a.symbol ?? (a.asset ? shortAddr(a.asset) : key), trust: a.trust });
        }
      }
    }
    return [...out.values()];
  }, [groups]);
  // Tokens on a token list come first, the native coin leading; every other token after, unknown ones before flagged.
  const bySymbol = (x: AssetOption, y: AssetOption) => x.label.localeCompare(y.label) || x.key.localeCompare(y.key);
  const listedAssets = assets
    .filter((o) => isListed(o.trust))
    .sort((x, y) => (x.key === NATIVE ? -1 : y.key === NATIVE ? 1 : bySymbol(x, y)));
  const otherAssets = assets
    .filter((o) => !isListed(o.trust))
    .sort((x, y) => TRUST_TIER[x.trust.level] - TRUST_TIER[y.trust.level] || bySymbol(x, y));
  /** A token's symbol with its contract, so look-alikes differ; flagged ones also say why. */
  const assetText = (o: AssetOption) => {
    const name = o.key === NATIVE || o.label === shortAddr(o.key) ? o.label : `${o.label} · ${shortAddr(o.key)}`;
    const flag = trustFlag(o.trust);
    return flag ? `${TRUST_MARK} ${name} · ${trustText(flag, t)}` : name;
  };
  const assetOption = (o: AssetOption) => <option key={o.key} value={o.key} title={o.key === NATIVE ? undefined : o.key}>{assetText(o)}</option>;

  const q = query.trim().toLowerCase();
  /** The asset filter as a flow's asset ("all": any). */
  const flowAsset: string | null | "all" = asset === ALL ? "all" : asset === NATIVE ? null : asset;
  /** The view shows other rows, or in another order, than the graph's list: k then follows the shown order. */
  const narrowed = asset !== ALL || direction !== "all" || sort !== graphSort || q !== "";
  /** The group's rows under the search, the asset and direction filters, in the dialog's sort. */
  const shownRows = (g: PickGroup): NeighbourRow[] => {
    const rows = g.rows.filter((r) => matches(r, q) && r.flows.some((f) => flowMatches(f, flowAsset, direction)));
    const index = new Map(rows.map((r, i) => [r.address, i]));
    const byIndex = (x: NeighbourRow, y: NeighbourRow) => index.get(x.address)! - index.get(y.address)!;
    // The chosen asset's amount in the chosen direction, largest first.
    if (sort === "amount" && flowAsset !== "all") {
      const sum = new Map(rows.map((r) => [r.address, flowTotals(r, flowAsset, direction).sum]));
      return [...rows].sort((x, y) => {
        const a = sum.get(x.address)!;
        const b = sum.get(y.address)!;
        return b > a ? 1 : b < a ? -1 : byIndex(x, y);
      });
    }
    if (sort === graphSort || sort === "amount") return rows;
    const time = (s: string) => Date.parse(s) || 0;
    const key = sort === "recent" ? (r: NeighbourRow) => time(r.lastTs) : (r: NeighbourRow) => r.count;
    return [...rows].sort((x, y) => key(y) - key(x) || byIndex(x, y));
  };
  /** Each synced group's shown rows, by center. */
  const shown = new Map(synced.map((g) => [g.center, shownRows(g)]));
  /** Per synced group, its shown rows that are neither locked nor checked: what "Check all shown" adds. */
  const uncheckedShown = synced.map((g) => {
    const sel = selection(g);
    return { g, rows: shown.get(g.center)!.filter((r) => !r.locked && !sel.has(r.address)) };
  });
  const uncheckedShownCount = uncheckedShown.reduce((n, x) => n + x.rows.length, 0);

  const toggle = (g: PickGroup, address: string) => {
    setKUndo(null);
    setChecked((prev) => {
      const next = new Set(prev[g.center] ?? g.defaults);
      if (!next.delete(address)) next.add(address);
      return { ...prev, [g.center]: next };
    });
  };

  const onK = (v: string) => {
    setDraft(v);
    const n = parseK(v);
    if (n === null) return;
    // Consecutive changes (typing "1" then "12") are one change: the offer keeps the checks from before the first.
    setKUndo((prev) => prev ?? { k, checked: Object.fromEntries(synced.map((g) => [g.center, new Set(selection(g))])) });
    setK(n);
    // k replaces the checks: a top-k group follows its defaults (the new top-k run); a picked one takes its first k.
    // On a narrowed view every group takes its first k shown rows.
    setChecked((prev) => {
      const next = { ...prev };
      for (const g of synced) {
        const top = narrowed ? shown.get(g.center)! : picks[g.center]?.length ? g.rows : null;
        if (top) next[g.center] = new Set([...top.slice(0, n), ...g.rows.filter((r) => r.locked)].map((r) => r.address));
        else delete next[g.center];
      }
      return next;
    });
  };

  /** Adds every shown, unlocked row of each synced group to its checks. */
  const checkShown = () => {
    if (uncheckedShownCount === 0) return;
    setKUndo(null);
    setChecked((prev) => {
      const next = { ...prev };
      for (const { g, rows } of uncheckedShown) {
        if (rows.length > 0) next[g.center] = new Set([...(prev[g.center] ?? g.defaults), ...rows.map((r) => r.address)]);
      }
      return next;
    });
  };

  const onAsset = (v: string) => {
    setAsset(v);
    // The amount sort needs an asset unless the graph sorts by amount itself.
    if (v === ALL && sort === "amount" && graphSort !== "amount") setSort(graphSort);
  };

  /** Back to the checks and k right before the change of k; the checks stay put when the old k's run answers. */
  const undoK = () => {
    if (!kUndo) return;
    setK(kUndo.k);
    setDraft(String(kUndo.k));
    setChecked(kUndo.checked);
    setKUndo(null);
  };

  const restore = () => {
    setKUndo(null);
    setK(openedK);
    setDraft(String(openedK));
    setChecked(Object.fromEntries(Object.entries(initial).map(([c, l]) => [c, new Set(l)])));
  };

  const selectNone = () => {
    setKUndo(null);
    setChecked(Object.fromEntries(synced.map((g) => [g.center, new Set<string>()])));
  };

  const startSync = (g: PickGroup) => {
    const c = g.center;
    const drop = () =>
      setRequested((prev) => {
        const next = { ...prev };
        delete next[c];
        return next;
      });
    setRequested((prev) => ({ ...prev, [c]: { lastSynced: g.lastSynced, jobs: null } }));
    api
      .sync({ addresses: [c], depth: "shallow", batch: newBatchId() })
      .then((res) => {
        // Nothing queued: nothing will report back, so Sync is offered again.
        if (!res.jobs?.length) return drop();
        const queued = res.jobs;
        setRequested((prev) => (prev[c] ? { ...prev, [c]: { ...prev[c], jobs: queued } } : prev));
      })
      .catch((err) => {
        toast(messageFor(err), "error");
        drop();
      });
  };

  const confirm = () => {
    if (!canConfirm) return;
    const next = Object.fromEntries(synced.map((g) => [g.center, resultOf(g)]));
    const previous = Object.fromEntries(centers.map((c) => [c, ownNeighbours(c, data)]));
    useGraph.getState().applyPicks(next, previous);
    offerUndo(synced.length);
    onClose();
  };

  /** Arrow keys move between the rendered rows' checkboxes; the list scrolls along. */
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLInputElement) || !target.dataset.pickRow) return;
    const boxes = [...(listEl?.querySelectorAll<HTMLInputElement>("input[data-pick-row]:not(:disabled)") ?? [])];
    const to = boxes[boxes.indexOf(target) + (e.key === "ArrowDown" ? 1 : -1)];
    if (!to) return;
    e.preventDefault();
    to.focus();
  };

  const syncing = (g: PickGroup) => g.syncing || g.center in requested;
  const title = many ? t("pick.titleMany", { count: groups.length }) : t("pick.title", { name: nameOf(first?.summary, targets[0] ?? "") });
  const backdrop = (body: ReactNode, className: string) => (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        {body}
      </div>
    </div>
  );

  // The canvas is not there yet, or not with the target: nothing is known about it (no sync question).
  if (waiting) {
    return backdrop(
      <>
        <h3 className="dialog__title">{title}</h3>
        <p className="dialog__summary" aria-live="polite">{t("common.loading")}</p>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
        </div>
      </>,
      "pick pick--confirm",
    );
  }

  // One target that is not synced: the sync question alone; it turns into the list once synced.
  if (confirmOnly && first) {
    const busy = syncing(first);
    return backdrop(
      <>
        <h3 className="dialog__title">{title}</h3>
        <div className="pick__confirm" aria-live="polite">
          <p>{t("pick.needSync", { min: SHALLOW_CALLS, max: SHALLOW_MAX_CALLS })}</p>
          {quotaLeft != null && <p className="dialog__summary">{t("expandSelf.quotaLeft", { count: quotaLeft })}</p>}
          {quotaLeft != null && SHALLOW_CALLS > quotaLeft && <p className="dialog__warn">{t("expandSelf.overQuota")}</p>}
          {busy && <p className="pick__syncing">{t("pick.syncing")}</p>}
        </div>
        <div className="dialog__actions">
          {busy ? (
            <button type="button" className="btn" onClick={onClose}>{t("pick.close")}</button>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose}>{t("pick.notNow")}</button>
              <button type="button" className="btn btn--primary" onClick={() => startSync(first)}>{t("pick.sync")}</button>
            </>
          )}
        </div>
      </>,
      "pick pick--confirm",
    );
  }

  const notes = (g: PickGroup) => {
    if (!g.known) {
      return (
        <div className="pick__notes" aria-live="polite">
          <span>{t("common.loading")}</span>
        </div>
      );
    }
    if (!g.synced) {
      return (
        <div className="pick__notes" aria-live="polite">
          {syncing(g) ? (
            <span className="pick__syncing">{t("pick.syncing")}</span>
          ) : (
            <>
              <span>{t("pick.needSync", { min: SHALLOW_CALLS, max: SHALLOW_MAX_CALLS })}</span>
              {quotaLeft != null && <span>{t("expandSelf.quotaLeft", { count: quotaLeft })}</span>}
              <button type="button" className="btn btn--compact" onClick={() => startSync(g)}>{t("pick.sync")}</button>
            </>
          )}
        </div>
      );
    }
    return (
      <div className="pick__notes" aria-live="polite">
        <TruncationBanner address={g.center} coverage={g.coverage} forGraph />
        {g.listedCap && <span>{t("pick.cap")}</span>}
        {g.hiddenByFilter > 0 && <span>{t("pick.filtered", { count: g.hiddenByFilter })}</span>}
        {g.lastSynced && (
          <span className="pick__refresh">
            <span title={formatTime(g.lastSynced)}>{t("pick.lastSynced", { ago: ago(g.lastSynced, Date.now(), t) })}</span>
            {syncing(g) ? (
              <span className="pick__syncing">{t("pick.syncing")}</span>
            ) : (
              <>
                <span>
                  {t("pick.calls", { min: SHALLOW_CALLS, max: SHALLOW_MAX_CALLS })}
                  {quotaLeft != null && ` · ${t("expandSelf.quotaLeft", { count: quotaLeft })}`}
                </span>
                <button type="button" className="btn btn--compact" onClick={() => startSync(g)}>{t("pick.refresh")}</button>
              </>
            )}
          </span>
        )}
      </div>
    );
  };

  const [before, after] = t("pick.k").split("{k}");

  return backdrop(
    <>
      <div className="pick__head">
        <h3 className="dialog__title">{title}</h3>
        <span className="pick__total">{t("pick.total", { total: listed.size, onCanvas: onCanvas.size })}</span>
      </div>
      <div className="pick__tools">
        <input
          className="input input--compact pick__search"
          type="search"
          placeholder={t("pick.search")}
          aria-label={t("pick.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="input input--compact" aria-label={t("filter.assets")} value={asset} onChange={(e) => onAsset(e.target.value)}>
          <option value={ALL}>{t("pick.assetAll")}</option>
          {listedAssets.length > 0 && <optgroup label={t("filter.listedTokens", { count: listedAssets.length })}>{listedAssets.map(assetOption)}</optgroup>}
          {otherAssets.length > 0 && <optgroup label={t("filter.otherTokens", { count: otherAssets.length })}>{otherAssets.map(assetOption)}</optgroup>}
        </select>
        <select className="input input--compact" aria-label={t("pick.dir")} value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
          {DIRECTIONS.map((d) => <option key={d} value={d}>{t(`pick.dir.${d}`)}</option>)}
        </select>
        <select className="input input--compact" aria-label={t("filter.sort")} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="count">{t("filter.sort.count")}</option>
          <option value="recent">{t("filter.sort.recent")}</option>
          {(asset !== ALL || graphSort === "amount") && <option value="amount">{t("filter.sort.amount")}</option>}
        </select>
        <div className="pick__k-row">
          <label className="pick__k">
            {before}
            <input
              className="input input--compact num pick__k-input"
              type="number"
              min={1}
              max={MAX_NEIGHBOUR_LIMIT}
              step={1}
              value={draft}
              aria-invalid={parseK(draft) === null}
              onChange={(e) => onK(e.target.value)}
            />
            {after}
          </label>
          {kUndo && (
            <button type="button" className="btn btn--compact" onClick={undoK}>{t("pick.undoK")}</button>
          )}
          <button type="button" className="btn btn--ghost btn--compact pick__check-shown" disabled={uncheckedShownCount === 0} onClick={checkShown}>
            {t("pick.checkVisible", { count: uncheckedShownCount })}
          </button>
        </div>
      </div>
      {!many && first && notes(first)}
      {error != null && !loading && <div className="dialog__error" role="alert">{messageFor(error)}</div>}
      <div
        className="pick__list"
        role="group"
        aria-label={t("pick.list")}
        aria-busy={loading}
        ref={setListEl}
        onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onKeyDown={onListKey}
      >
        {groups.map((g) => {
          const open = !many || !collapsed.has(g.center);
          const rows = shown.get(g.center) ?? [];
          const sel = selection(g);
          const name = nameOf(g.summary, g.center);
          return (
            <section key={g.center} className="pick__group">
              {many && (
                <button
                  type="button"
                  className="pick__group-head"
                  aria-expanded={open}
                  title={g.center}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(g.center)) next.add(g.center);
                      return next;
                    })
                  }
                >
                  {t("pick.group", { name, total: g.rows.length, checked: g.rows.filter((r) => isChecked(r, sel)).length })}
                </button>
              )}
              {open && many && notes(g)}
              {open && g.synced && !loading && rows.length === 0 && <div className="pick__empty">{t("pick.empty")}</div>}
              {open && rows.length > 0 && (
                <Rows
                  rows={rows}
                  view={view}
                  asset={flowAsset}
                  direction={direction}
                  isChecked={(r) => isChecked(r, sel)}
                  onToggle={(r) => toggle(g, r.address)}
                  active={active[g.center]}
                  onFocusRow={(r) => setActive((prev) => (prev[g.center] === r.address ? prev : { ...prev, [g.center]: r.address }))}
                  t={t}
                />
              )}
            </section>
          );
        })}
      </div>
      <div className="pick__footer">
        <div className="dialog__summary" aria-live="polite">{t("pick.summary", { count: checkedCount, nodes: newNodes.size })}</div>
        <div className="expand__warnings" aria-live="polite">
          {tooMany && <div className="dialog__error" role="alert">{t("expandSelf.tooManyCenters", { max: MAX_CENTERS, count: centerCount })}</div>}
          {overCanvas && <div className="dialog__warn">{t("expandSelf.overCanvas")}</div>}
        </div>
        <div className="dialog__actions pick__actions">
          <button type="button" className="btn" onClick={selectNone}>{t("pick.none")}</button>
          <button type="button" className="btn" onClick={restore}>{t("pick.resetDefault")}</button>
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="btn btn--primary" disabled={!canConfirm} onClick={confirm}>
            {t("pick.confirm", { count: checkedCount })}
          </button>
        </div>
      </div>
    </>,
    "pick",
  );
}

/**
 * One group's rows, windowed: a block as tall as all its rows, with only those near the list's visible part rendered
 * (absolutely placed at a fixed height), so a thousand rows stay smooth. The group is one Tab stop (roving tabindex):
 * the row focused last (`active`) while it is rendered, else the first rendered row that can take focus; the arrow
 * keys move between rows.
 */
function Rows({
  rows,
  view,
  asset,
  direction,
  isChecked,
  onToggle,
  active,
  onFocusRow,
  t,
}: {
  rows: NeighbourRow[];
  view: View;
  /** The asset filter ("all": none): a chosen asset's amount shows on each row. */
  asset: string | null | "all";
  direction: Direction;
  isChecked(r: NeighbourRow): boolean;
  onToggle(r: NeighbourRow): void;
  active: string | undefined;
  onFocusRow(r: NeighbourRow): void;
  t: T;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** The block's offset in the scrolled list (the list is its offset parent). */
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const o = ref.current?.offsetTop ?? 0;
    if (o !== offset) setOffset(o);
  });
  const height = view.height > 0 ? view.height : FALLBACK_VIEW;
  const from = Math.max(0, Math.floor((view.top - offset) / PICK_ROW_HEIGHT) - OVERSCAN);
  const to = Math.min(rows.length, Math.ceil((view.top + height - offset) / PICK_ROW_HEIGHT) + OVERSCAN);
  const now = Date.now();
  const rendered = rows.slice(from, Math.max(from, to));
  const stop =
    rendered.find((r) => r.address === active && !r.locked)?.address ?? rendered.find((r) => !r.locked)?.address;
  return (
    <div className="pick__rows" ref={ref} style={{ height: rows.length * PICK_ROW_HEIGHT }}>
      {rendered.map((r, i) => (
        <label
          key={r.address}
          className={r.locked ? "pick__row pick__row--locked" : "pick__row"}
          style={{ top: (from + i) * PICK_ROW_HEIGHT }}
        >
          <input
            type="checkbox"
            data-pick-row="1"
            checked={isChecked(r)}
            disabled={r.locked}
            tabIndex={r.address === stop ? 0 : -1}
            title={r.locked ? t("pick.lockedHint") : undefined}
            onChange={() => onToggle(r)}
            onFocus={() => onFocusRow(r)}
          />
          <span className="pick__who">
            <span className="pick__name">
              <span className="pick__label" title={r.address}>{nameOf(r.node, r.address)}</span>
              {r.locked && <span className="tag tag--neutral">{t("pick.onCanvas")}</span>}
            </span>
            <span className="pick__assets">
              {r.assets.map((a) => (
                <span key={assetKey(a.asset)} className="pick__asset">
                  <span>{a.symbol ?? (a.asset ? shortAddr(a.asset) : NATIVE)}</span>
                  <TrustBadge trust={a.trust} subject={a.symbol ?? undefined} />
                </span>
              ))}
            </span>
          </span>
          <Nums row={r} asset={asset} direction={direction} now={now} t={t} />
        </label>
      ))}
    </div>
  );
}

/**
 * A row's figures: the transfers in the filtered asset and direction and the latest one's age; with an asset chosen,
 * that asset's amount first (the raw integer, marked, when its decimals are unknown). Two lines, so the row keeps its
 * fixed height.
 */
function Nums({ row, asset, direction, now, t }: { row: NeighbourRow; asset: string | null | "all"; direction: Direction; now: number; t: T }) {
  const { count, sum } = flowTotals(row, asset, direction);
  const countText = <span className="num">{t("pick.count", { count })}</span>;
  const age = <span title={formatTime(row.lastTs)}>{ago(row.lastTs, now, t)}</span>;
  if (asset === "all") {
    return (
      <span className="pick__nums">
        {countText}
        {age}
      </span>
    );
  }
  const flow = row.flows.find((f) => flowMatches(f, asset, direction));
  const amount = formatAmount(sum.toString(), flow?.decimals ?? null);
  const symbol = flow?.symbol ?? (asset ? shortAddr(asset) : NATIVE);
  return (
    <span className="pick__nums">
      <span className="num pick__amount">
        {amount.unknownDecimals && <UnknownDecimals />}
        {`${amount.text} ${symbol}`}
      </span>
      <span>
        {countText} · {age}
      </span>
    </span>
  );
}
