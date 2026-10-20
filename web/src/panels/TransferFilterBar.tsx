import { useEffect, useRef, useState } from "react";
import type { EdgeDto } from "../api/generated/EdgeDto";
import { useAssetRegistry } from "../graph/assetRegistry";
import { useT } from "../i18n";
import { shortAddr } from "../lib/address";
import { TRANSFER_KINDS, transferKindName } from "../lib/transferKinds";
import { AssetOptGroups, type AssetOption } from "./AssetOptGroups";
import { isDefault, useTransferFilter, type TransferTableFilter } from "./transferFilter";

/** The asset select's "all assets" value; the native coin's is "eth". */
const ALL = "";
const ETH = "eth";
const ETH_OPTION: AssetOption = { key: ETH, label: "ETH", trust: { level: "listed", impersonates: null, reason: null } };

const assetValue = (a: TransferTableFilter["asset"]) => (a === undefined ? ALL : a === null ? ETH : a);
const assetOf = (v: string): TransferTableFilter["asset"] => (v === ALL ? undefined : v === ETH ? null : v.toLowerCase());

/** ETH, the assets of `edges`, and the chosen asset even when no edge carries it (it survives selection changes). */
function useAssetOptions(edges: EdgeDto[], chosen: TransferTableFilter["asset"]): AssetOption[] {
  const known = useAssetRegistry((r) => r.assets);
  const out = new Map<string, AssetOption>([[ETH, ETH_OPTION]]);
  for (const e of edges) {
    if (e.asset === null) continue;
    const key = e.asset.toLowerCase();
    if (!out.has(key)) out.set(key, { key, label: e.symbol ?? shortAddr(key), trust: e.trust });
  }
  if (typeof chosen === "string" && !out.has(chosen)) {
    const k = known[chosen];
    out.set(chosen, { key: chosen, label: k?.symbol ?? shortAddr(chosen), trust: k?.trust ?? { level: "unknown", impersonates: null, reason: null } });
  }
  return [...out.values()];
}

/** The time button with its popover of two UTC days. */
function TimeRange() {
  const t = useT();
  const from = useTransferFilter((s) => s.from);
  const to = useTransferFilter((s) => s.to);
  const set = useTransferFilter((s) => s.set);
  const [open, setOpen] = useState(false);
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

  const label = from === null && to === null ? t("transfers.f.timeAll") : `${from ?? "…"} – ${to ?? "…"}`;
  return (
    <div className="dropdown" ref={rootRef}>
      <button type="button" className="btn btn--compact" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div className="popover dropdown__panel transfers__time" role="dialog" aria-label={t("transfers.col.time")}>
          <input
            className="input input--compact"
            type="date"
            aria-label={t("transfers.f.from")}
            value={from ?? ""}
            max={to ?? undefined}
            onChange={(e) => set({ from: e.target.value || null })}
          />
          <input
            className="input input--compact"
            type="date"
            aria-label={t("transfers.f.to")}
            value={to ?? ""}
            min={from ?? undefined}
            onChange={(e) => set({ to: e.target.value || null })}
          />
          <button type="button" className="btn btn--compact" onClick={() => set({ from: null, to: null })}>
            {t("transfers.f.clear")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The transfer table's own filter (time, asset, direction, type), independent of the graph filter: controls only.
 * `edges` are the graph edges touching the selection, for the asset list; `pair` hides the direction, which each
 * of a pair's groups already has.
 */
export function TransferFilterBar({ edges, pair = false }: { edges: EdgeDto[]; pair?: boolean }) {
  const t = useT();
  const filter = useTransferFilter();
  const options = useAssetOptions(edges, filter.asset);
  return (
    <div className="transfers__bar" role="toolbar">
      <TimeRange />
      <select
        className="input input--compact"
        aria-label={t("transfers.col.asset")}
        value={assetValue(filter.asset)}
        onChange={(e) => filter.set({ asset: assetOf(e.target.value) })}
      >
        <option value={ALL}>{t("transfers.f.assetAll")}</option>
        <AssetOptGroups options={options} native={ETH} />
      </select>
      {!pair && (
        <select
          className="input input--compact"
          aria-label={t("transfers.col.direction")}
          value={filter.direction}
          onChange={(e) => filter.set({ direction: e.target.value as TransferTableFilter["direction"] })}
        >
          <option value="all">{t("transfers.f.dirAll")}</option>
          <option value="in">{t("transfers.dir.in")}</option>
          <option value="out">{t("transfers.dir.out")}</option>
        </select>
      )}
      <select
        className="input input--compact"
        aria-label={t("transfers.col.type")}
        value={filter.kind}
        onChange={(e) => filter.set({ kind: e.target.value as TransferTableFilter["kind"] })}
      >
        <option value="all">{t("transfers.f.kindAll")}</option>
        {TRANSFER_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {transferKindName(k.value, t)}
          </option>
        ))}
      </select>
      {!isDefault(filter) && (
        <button type="button" className="transfers__reset" onClick={filter.reset}>
          {t("transfers.f.reset")}
        </button>
      )}
    </div>
  );
}
