import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetFilterDto } from "../api/generated/AssetFilterDto";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import { useGraph, type SortKey } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";
import { parseHumanAmount } from "../lib/amount";

type Kind = NonNullable<EdgeFilterDto["kinds"]>[number];
type Direction = NonNullable<EdgeFilterDto["direction"]>;

const KINDS: { value: Kind; label: string }[] = [
  { value: "native", label: "普通转账" },
  { value: "internal", label: "内部交易" },
  { value: "erc20", label: "ERC20" },
  { value: "erc721", label: "ERC721" },
  { value: "erc1155", label: "ERC1155" },
];
const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: "both", label: "双向" },
  { value: "in", label: "流入" },
  { value: "out", label: "流出" },
];
const SORTS: { value: SortKey; label: string }[] = [
  { value: "count", label: "按笔数" },
  { value: "amount", label: "按金额" },
  { value: "recent", label: "最近" },
];

const ETH = "eth";
const assetKey = (a: string | null | undefined) => (a == null || a.toLowerCase() === ETH ? ETH : a.toLowerCase());

interface AssetOption {
  key: string;
  label: string;
  /** null = unknown; undefined = not in the current graph. */
  decimals: number | null | undefined;
}

function toLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const toIso = (local: string) => new Date(local).toISOString();
const normalize = (s: string) => s.trim().replace(/,/g, "");
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function hasFilter(f: EdgeFilterDto): boolean {
  return !!(f.time?.from || f.time?.to || f.kinds?.length || (f.direction && f.direction !== "both") || f.assets?.length);
}

export function FilterPanel() {
  const [open, setOpen] = useState(false);
  const filter = useGraph((s) => s.filter);
  const rootRef = useRef<HTMLDivElement>(null);

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
      <button className="btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ⚙ 过滤 ▾
        {hasFilter(filter) && <span className="filter__dot" data-testid="filter-active" aria-label="已启用过滤" />}
      </button>
      {open && <FilterForm onClose={() => setOpen(false)} />}
    </div>
  );
}

function FilterForm({ onClose }: { onClose: () => void }) {
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

  const options = useMemo(() => {
    const m = new Map<string, AssetOption>();
    for (const e of data?.edges ?? []) {
      const key = assetKey(e.asset);
      if (m.has(key)) continue;
      m.set(key, {
        key,
        label: key === ETH ? "ETH" : (e.symbol ?? shortAddr(key)),
        decimals: key === ETH ? 18 : e.decimals,
      });
    }
    // Assets already in the filter may be missing from the (filtered) graph.
    for (const key of assets.keys()) {
      if (!m.has(key)) m.set(key, { key, label: key === ETH ? "ETH" : shortAddr(key), decimals: key === ETH ? 18 : undefined });
    }
    return [...m.values()].sort((a, b) =>
      a.key === ETH ? -1 : b.key === ETH ? 1 : a.label.localeCompare(b.label),
    );
  }, [data, assets]);

  const thresholdValid = (opt: AssetOption, text: string) =>
    text.trim() === "" || typeof opt.decimals !== "number" || parseHumanAmount(text, opt.decimals) !== null;
  const anyInvalid = options.some((o) => assets.has(o.key) && !thresholdValid(o, assets.get(o.key)!));
  const timeInvalid = from !== "" && to !== "" && new Date(from) > new Date(to);
  const canAmountSort = assets.size === 1;
  const effectiveSort: SortKey = sort === "amount" && !canAmountSort ? "count" : sort;

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
    store.setFilter(f);
    store.setSort(effectiveSort);
    onClose();
  };

  const reset = () => {
    store.setFilter({});
    store.setSort("count");
    onClose();
  };

  return (
    <div className="filter__popover" role="dialog" aria-label="过滤">
      <fieldset className="filter__group">
        <legend>时间范围</legend>
        <label>
          开始时间
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          结束时间
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {timeInvalid && <span className="filter__error">开始时间晚于结束时间</span>}
      </fieldset>

      <fieldset className="filter__group">
        <legend>类别</legend>
        {KINDS.map((k) => (
          <label key={k.value}>
            <input type="checkbox" checked={kinds.has(k.value)} onChange={() => setKinds(toggle(kinds, k.value))} />
            {k.label}
          </label>
        ))}
      </fieldset>

      <fieldset className="filter__group">
        <legend>方向</legend>
        {DIRECTIONS.map((d) => (
          <label key={d.value}>
            <input type="radio" name="filter-direction" checked={direction === d.value} onChange={() => setDirection(d.value)} />
            {d.label}
          </label>
        ))}
      </fieldset>

      <fieldset className="filter__group">
        <legend>资产</legend>
        {options.length === 0 && <span className="filter__hint">暂无资产</span>}
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
                    aria-label={`${o.label} 最小金额`}
                    aria-invalid={!valid}
                    placeholder="最小金额"
                    inputMode="decimal"
                    disabled={!known}
                    value={text}
                    onChange={(e) => setAssets(new Map(assets).set(o.key, e.target.value))}
                  />
                  {o.decimals === null && <span className="filter__hint">未知精度，无法设阈值</span>}
                </>
              )}
            </div>
          );
        })}
      </fieldset>

      <fieldset className="filter__group">
        <legend>排序</legend>
        {SORTS.map((s) => (
          <label key={s.value}>
            <input
              type="radio"
              name="filter-sort"
              checked={effectiveSort === s.value}
              disabled={s.value === "amount" && !canAmountSort}
              onChange={() => setSort(s.value)}
            />
            {s.label}
          </label>
        ))}
      </fieldset>

      <div className="filter__actions">
        <button className="btn" onClick={reset}>重置</button>
        <button className="btn filter__apply" onClick={apply} disabled={anyInvalid || timeInvalid}>应用</button>
      </div>
    </div>
  );
}
