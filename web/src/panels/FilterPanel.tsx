import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetFilterDto } from "../api/generated/AssetFilterDto";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import { ETH_KEY as ETH, assetKey, useAssetRegistry } from "../graph/assetRegistry";
import { useGraph, type SortKey } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";
import { type MsgKey, useT } from "../i18n";
import { parseHumanAmount } from "../lib/amount";

type Kind = NonNullable<EdgeFilterDto["kinds"]>[number];
type Direction = NonNullable<EdgeFilterDto["direction"]>;

const KINDS: { value: Kind; label: MsgKey | null }[] = [
  { value: "native", label: "kind.native" },
  { value: "internal", label: "kind.internal" },
  { value: "erc20", label: null },
  { value: "erc721", label: null },
  { value: "erc1155", label: null },
];
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


interface AssetOption {
  key: string;
  label: string;
  decimals: number | null;
}

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
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** How many filter dimensions (time, type, direction, assets) are narrowed. */
function activeCount(f: EdgeFilterDto): number {
  return [f.time?.from || f.time?.to, f.kinds?.length, f.direction && f.direction !== "both", f.assets?.length].filter(Boolean).length;
}

export function FilterPanel() {
  const [open, setOpen] = useState(false);
  const filter = useGraph((s) => s.filter);
  const rootRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const registry = useAssetRegistry((r) => r.assets);
  const count = activeCount(filter);
  const assets = filter.assets ?? [];
  const assetLabel = (a: AssetFilterDto) => {
    const key = assetKey(a.asset);
    return key === ETH ? "ETH" : (registry[key]?.symbol ?? shortAddr(key));
  };
  const assetText =
    assets.length === 0
      ? t("filter.allAssets")
      : assets.length === 1
        ? assetLabel(assets[0]!)
        : t("filter.assetCount", { count: assets.length });

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
      <button className={`chip${assets.length ? " chip--active" : ""}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="chip__text" title={assetText}>{assetText}</span>
        <ChevronDown size={14} />
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

  const registry = useAssetRegistry((r) => r.assets);
  const options = useMemo(() => {
    const m = new Map<string, AssetOption>();
    const add = (key: string, symbol: string | null, decimals: number | null) => {
      if (!m.has(key)) m.set(key, { key, label: key === ETH ? "ETH" : (symbol ?? shortAddr(key)), decimals });
    };
    for (const e of data?.edges ?? []) add(assetKey(e.asset), e.symbol, assetKey(e.asset) === ETH ? 18 : e.decimals);
    for (const [key, k] of Object.entries(registry)) add(key, k.symbol, k.decimals);
    add(ETH, null, 18);
    for (const key of init.assets?.map((a) => assetKey(a.asset)) ?? []) add(key, null, null);
    return [...m.values()].sort((a, b) =>
      a.key === ETH ? -1 : b.key === ETH ? 1 : a.label.localeCompare(b.label),
    );
  }, [data, registry, init.assets]);

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
    store.applyFilter(f, effectiveSort);
    onClose();
  };

  const reset = () => {
    store.applyFilter({}, "count");
    onClose();
  };

  return (
    <div className="filter__popover" role="dialog" aria-label={t("filter.button")}>
      <fieldset className="filter__group">
        <legend>{t("filter.time")}</legend>
        <label>
          {t("filter.from")}
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t("filter.to")}
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {timeInvalid && <span className="filter__error">{t("filter.timeInvalid")}</span>}
      </fieldset>

      <fieldset className="filter__group">
        <legend>{t("filter.kinds")}</legend>
        {KINDS.map((k) => (
          <label key={k.value}>
            <input type="checkbox" checked={kinds.has(k.value)} onChange={() => setKinds(toggle(kinds, k.value))} />
            {k.label ? t(k.label) : k.value.toUpperCase()}
          </label>
        ))}
      </fieldset>

      <fieldset className="filter__group">
        <legend>{t("filter.direction")}</legend>
        {DIRECTIONS.map((d) => (
          <label key={d.value}>
            <input type="radio" name="filter-direction" checked={direction === d.value} onChange={() => setDirection(d.value)} />
            {t(d.label)}
          </label>
        ))}
      </fieldset>

      <fieldset className="filter__group">
        <legend>{t("filter.assets")}</legend>
        {options.length === 0 && <span className="filter__hint">{t("filter.noAssets")}</span>}
        {options.map((o) => {
          const checked = assets.has(o.key);
          const text = assets.get(o.key) ?? "";
          const known = typeof o.decimals === "number";
          const valid = thresholdValid(o, text);
          return (
            <div className="filter__asset" key={o.key}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = new Map(assets);
                    if (!next.delete(o.key)) next.set(o.key, "");
                    setAssets(next);
                  }}
                />
                {o.label}
              </label>
              {checked && (
                <>
                  <input
                    className={`filter__threshold${valid ? "" : " filter__threshold--invalid"}`}
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
        })}
      </fieldset>

      <fieldset className="filter__group">
        <legend>{t("filter.sort")}</legend>
        {SORTS.map((s) => (
          <label key={s.value}>
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
      </fieldset>

      <div className="filter__actions">
        <button className="btn" onClick={reset}>{t("filter.reset")}</button>
        <button className="btn filter__apply" onClick={apply} disabled={anyInvalid || timeInvalid}>{t("filter.apply")}</button>
      </div>
    </div>
  );
}
