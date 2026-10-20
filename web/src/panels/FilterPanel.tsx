import { ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetFilterDto } from "../api/generated/AssetFilterDto";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import type { TrustDto } from "../api/generated/TrustDto";
import { ETH_KEY as ETH, assetKey, useAssetRegistry } from "../graph/assetRegistry";
import { useGraph, type SortKey } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";
import { type MsgKey, useT } from "../i18n";
import { shortAddr } from "../lib/address";
import { parseHumanAmount } from "../lib/amount";
import { TRUST_TIER, isListed } from "../lib/trust";
import { TRANSFER_KINDS, transferKindName } from "../lib/transferKinds";
import { TrustBadge } from "./info/TrustBadge";

type Kind = NonNullable<EdgeFilterDto["kinds"]>[number];
type Direction = NonNullable<EdgeFilterDto["direction"]>;

const KINDS = TRANSFER_KINDS;
const DIRECTIONS: { value: Direction; label: MsgKey }[] = [
  { value: "both", label: "filter.dir.both" },
  { value: "in", label: "filter.dir.in" },
  { value: "out", label: "filter.dir.out" },
];
const SORTS: { value: SortKey; label: MsgKey }[] = [
  { value: "count", label: "filter.sort.count" },
  { value: "amount", label: "filter.sort.amount" },
  { value: "recent", label: "filter.sort.recent" },
];

/** Above this many assets the list gets a search box. */
const SEARCH_MIN = 8;
const UNRATED: TrustDto = { level: "unknown", impersonates: null, reason: null };

interface AssetOption {
  key: string;
  label: string;
  decimals: number | null;
  trust: TrustDto;
}

const matches = (o: AssetOption, q: string) => q === "" || o.label.toLowerCase().includes(q) || o.key.includes(q);

function toLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const toIso = (local: string) => new Date(local).toISOString();
/** Backend-safe decimal: no commas, ".5" -> "0.5", "5." -> "5". */
const normalize = (s: string) => {
  let t = s.trim().replace(/,/g, "");
  if (t.startsWith(".")) t = "0" + t;
  if (t.endsWith(".")) t = t.slice(0, -1);
  return t;
};

/** How many filter dimensions (time, type, direction, assets, hidden impersonations) are narrowed. */
function activeCount(f: EdgeFilterDto): number {
  return [f.time?.from || f.time?.to, f.kinds?.length, f.direction && f.direction !== "both", f.assets?.length, f.hide_suspicious]
    .filter(Boolean).length;
}

export function FilterPanel() {
  const [open, setOpen] = useState(false);
  const filter = useGraph((s) => s.filter);
  const rootRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const count = activeCount(filter);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="filter" ref={rootRef}>
      <button className={`chip${count ? " chip--active" : ""}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <SlidersHorizontal size={14} />
        {count ? (
          <span data-testid="filter-active">{t("filter.chipCount", { count })}</span>
        ) : (
          t("filter.chip")
        )}
      </button>
      {open && <FilterForm onClose={() => setOpen(false)} />}
    </div>
  );
}

function FilterForm({ onClose }: { onClose: () => void }) {
  const t = useT();
  const store = useGraph.getState();
  const { data } = useGraphData();
  const init = useGraph.getState().filter;
  const initSort = useGraph.getState().sort;

  const [from, setFrom] = useState(toLocal(init.time?.from));
  const [to, setTo] = useState(toLocal(init.time?.to));
  const [kinds, setKinds] = useState<Set<Kind>>(new Set(init.kinds ?? []));
  const [direction, setDirection] = useState<Direction>(init.direction ?? "both");
  const [assets, setAssets] = useState<Map<string, string>>(
    () => new Map((init.assets ?? []).map((a) => [assetKey(a.asset), a.min_amount ?? ""])),
  );
  const [sort, setSort] = useState<SortKey>(initSort);
  const [hideSuspicious, setHideSuspicious] = useState(init.hide_suspicious === true);
  const [query, setQuery] = useState("");

  const registry = useAssetRegistry((r) => r.assets);
  const options = useMemo(() => {
    const m = new Map<string, AssetOption>();
    const add = (key: string, symbol: string | null, decimals: number | null, trust: TrustDto) => {
      if (!m.has(key)) m.set(key, { key, label: key === ETH ? "ETH" : (symbol ?? shortAddr(key)), decimals, trust });
    };
    for (const e of data?.edges ?? []) add(assetKey(e.asset), e.symbol, assetKey(e.asset) === ETH ? 18 : e.decimals, e.trust);
    for (const [key, k] of Object.entries(registry)) add(key, k.symbol, k.decimals, k.trust);
    add(ETH, null, 18, { ...UNRATED, level: "listed" });
    for (const key of init.assets?.map((a) => assetKey(a.asset)) ?? []) add(key, null, null, UNRATED);
    return [...m.values()].sort(
      (a, b) =>
        TRUST_TIER[a.trust.level] - TRUST_TIER[b.trust.level] ||
        (a.key === ETH ? -1 : b.key === ETH ? 1 : a.label.localeCompare(b.label)) ||
        a.key.localeCompare(b.key),
    );
  }, [data, registry, init.assets]);
  const [groupOpen, setGroupOpen] = useState(() => options.some((o) => !isListed(o.trust) && assets.has(o.key)));
  const q = query.trim().toLowerCase();
  const shown = options.filter((o) => matches(o, q));
  const listed = shown.filter((o) => isListed(o.trust));
  const other = shown.filter((o) => !isListed(o.trust));

  const thresholdValid = (opt: AssetOption, text: string) =>
    text.trim() === "" || typeof opt.decimals !== "number" || parseHumanAmount(text, opt.decimals) !== null;
  const anyInvalid = options.some((o) => assets.has(o.key) && !thresholdValid(o, assets.get(o.key)!));
  const timeInvalid = from !== "" && to !== "" && new Date(from) > new Date(to);
  const canAmountSort = assets.size === 1;
  const effectiveSort: SortKey = sort === "amount" && !canAmountSort ? "count" : sort;

  useEffect(() => {
    if (!canAmountSort) setSort((s) => (s === "amount" ? "count" : s));
  }, [canAmountSort]);

  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set);
    if (!next.delete(v)) next.add(v);
    return next;
  };

  const apply = () => {
    const f: EdgeFilterDto = {};
    const time: { from?: string; to?: string } = {};
    if (from) time.from = toIso(from);
    if (to) time.to = toIso(to);
    if (time.from || time.to) f.time = time;
    if (kinds.size) f.kinds = KINDS.map((k) => k.value).filter((k) => kinds.has(k));
    if (direction !== "both") f.direction = direction;
    const list: AssetFilterDto[] = [];
    for (const o of options) {
      if (!assets.has(o.key)) continue;
      const min = normalize(assets.get(o.key)!);
      const item: AssetFilterDto = { asset: o.key === ETH ? null : o.key };
      if (min !== "") item.min_amount = min;
      list.push(item);
    }
    if (list.length) f.assets = list;
    if (hideSuspicious) f.hide_suspicious = true;
    store.applyFilter(f, effectiveSort);
    onClose();
  };

  const reset = () => {
    store.applyFilter({}, "count");
    onClose();
  };

  const row = (o: AssetOption) => {
    const checked = assets.has(o.key);
    const text = assets.get(o.key) ?? "";
    const known = typeof o.decimals === "number";
    const valid = thresholdValid(o, text);
    const toggleAsset = () => {
      const next = new Map(assets);
      if (!next.delete(o.key)) next.set(o.key, "");
      setAssets(next);
    };
    return (
      <div className="filter__asset" key={o.key}>
        <label className="filter__check">
          <input type="checkbox" checked={checked} onChange={toggleAsset} />
          {o.label}
        </label>
        {o.key !== ETH && o.label !== shortAddr(o.key) && (
          <span className="filter__addr num" title={o.key}>{shortAddr(o.key)}</span>
        )}
        <TrustBadge trust={o.trust} subject={o.label} />
        {checked && (
          <>
            <input
              className="input input--compact num filter__threshold"
              aria-label={t("filter.minAmountFor", { asset: o.label })}
              aria-invalid={!valid}
              placeholder={t("filter.minAmount")}
              inputMode="decimal"
              disabled={!known}
              value={text}
              onChange={(e) => setAssets(new Map(assets).set(o.key, e.target.value))}
            />
            {!known && <span className="filter__hint">{t("filter.unknownDecimals")}</span>}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="popover filter__popover" role="dialog" aria-label={t("filter.button")}>
      <h2 className="popover__title filter__head">{t("filter.button")}</h2>
      <div className="filter__body">
        <fieldset className="filter__group">
          <legend className="popover__section">{t("filter.time")}</legend>
          <div className="filter__times">
            <label className="filter__field">
              {t("filter.from")}
              <input className="input input--compact" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="filter__field">
              {t("filter.to")}
              <input className="input input--compact" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          {timeInvalid && <span className="filter__error">{t("filter.timeInvalid")}</span>}
        </fieldset>

        <fieldset className="filter__group">
          <legend className="popover__section">{t("filter.kinds")}</legend>
          <div className="filter__chips">
            {KINDS.map((k) => (
              <label key={k.value} className={`chip chip--toggle${kinds.has(k.value) ? " chip--active" : ""}`}>
                <input type="checkbox" checked={kinds.has(k.value)} onChange={() => setKinds(toggle(kinds, k.value))} />
                {transferKindName(k.value, t)}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="filter__group">
          <legend className="popover__section">{t("filter.direction")}</legend>
          <div className="seg">
            {DIRECTIONS.map((d) => (
              <label key={d.value} className="seg__item">
                <input type="radio" name="filter-direction" checked={direction === d.value} onChange={() => setDirection(d.value)} />
                {t(d.label)}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="filter__group">
          <legend className="popover__section">{t("filter.assets")}</legend>
          <label className="filter__check">
            <input type="checkbox" checked={hideSuspicious} onChange={() => setHideSuspicious((v) => !v)} />
            {t("filter.hideSuspicious")}
          </label>
          {options.length === 0 && <span className="filter__hint">{t("filter.noAssets")}</span>}
          {options.length > SEARCH_MIN && (
            <input
              className="input input--compact"
              type="search"
              aria-label={t("filter.searchAssets")}
              placeholder={t("filter.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {options.length > 0 && shown.length === 0 && <span className="filter__hint">{t("filter.noMatch")}</span>}
          {listed.length > 0 && (
            <>
              <div className="filter__subhead">{t("filter.listedTokens", { count: listed.length })}</div>
              {listed.map(row)}
            </>
          )}
          {other.length > 0 && (
            <>
              <button type="button" className="filter__group-head" aria-expanded={groupOpen} onClick={() => setGroupOpen((v) => !v)}>
                {groupOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t("filter.otherTokens", { count: other.length })}
              </button>
              {groupOpen && other.map(row)}
            </>
          )}
        </fieldset>

        <fieldset className="filter__group">
          <legend className="popover__section">{t("filter.sort")}</legend>
          <div className="seg">
            {SORTS.map((s) => (
              <label key={s.value} className="seg__item">
                <input
                  type="radio"
                  name="filter-sort"
                  checked={effectiveSort === s.value}
                  disabled={s.value === "amount" && !canAmountSort}
                  onChange={() => setSort(s.value)}
                />
                {t(s.label)}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="filter__actions">
        <button className="btn" onClick={reset}>{t("filter.reset")}</button>
        <button className="btn btn--primary" onClick={apply} disabled={anyInvalid || timeInvalid}>{t("filter.apply")}</button>
      </div>
    </div>
  );
}
