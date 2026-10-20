import { useMemo } from "react";
import type { TransferDto } from "../api/generated/TransferDto";
import { useT } from "../i18n";
import { TRANSFER_KINDS, transferKindName } from "../lib/transferKinds";
import { AssetSelect, type AssetSource } from "../panels/AssetSelect";
import { TimeRange } from "../panels/TimeRange";
import { amountBoundValid, isDefaultDataFilter, useDataFilter, type DataFilter } from "./dataFilter";

/** One source per asset of `rows` (the first row's symbol and trust), for the asset select. */
function rowAssets(rows: TransferDto[]): AssetSource[] {
  const out = new Map<string, AssetSource>();
  for (const r of rows) {
    const key = r.asset === null ? "" : r.asset.toLowerCase();
    if (!out.has(key)) out.set(key, { asset: r.asset, symbol: r.symbol, trust: r.trust });
  }
  return [...out.values()];
}

/**
 * The Data tab's filter sidebar, controls only: time, asset (over the loaded rows, listed first), type, address or
 * name with its side, amount bounds once one asset is chosen, whether hidden transfers are listed, and a reset link
 * while anything narrows.
 */
export function DataFilters({ rows }: { rows: TransferDto[] }) {
  const t = useT();
  const filter = useDataFilter();
  const sources = useMemo(() => rowAssets(rows), [rows]);
  const bound = (key: "minAmount" | "maxAmount", label: string) => (
    <input
      className="input input--compact"
      type="text"
      inputMode="decimal"
      aria-label={label}
      placeholder={label}
      aria-invalid={amountBoundValid(filter[key]) ? undefined : true}
      value={filter[key]}
      onChange={(e) => filter.set({ [key]: e.target.value })}
    />
  );
  return (
    <div className="data__side" role="search">
      <TimeRange from={filter.from} to={filter.to} onChange={filter.set} />
      {/* Bounds are in the chosen asset's units: a new asset starts them over. */}
      <AssetSelect sources={sources} value={filter.asset} onChange={(asset) => filter.set({ asset, minAmount: "", maxAmount: "" })} />
      <select
        className="input input--compact"
        aria-label={t("transfers.col.type")}
        value={filter.kind}
        onChange={(e) => filter.set({ kind: e.target.value as DataFilter["kind"] })}
      >
        <option value="all">{t("transfers.f.kindAll")}</option>
        {TRANSFER_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {transferKindName(k.value, t)}
          </option>
        ))}
      </select>
      <input
        className="input input--compact"
        type="text"
        aria-label={t("data.f.address")}
        placeholder={t("data.f.address")}
        value={filter.address}
        onChange={(e) => filter.set({ address: e.target.value })}
      />
      <select
        className="input input--compact"
        aria-label={t("transfers.col.direction")}
        value={filter.addressRole}
        onChange={(e) => filter.set({ addressRole: e.target.value as DataFilter["addressRole"] })}
      >
        <option value="any">{t("data.f.role.any")}</option>
        <option value="from">{t("data.f.role.from")}</option>
        <option value="to">{t("data.f.role.to")}</option>
      </select>
      {filter.asset !== undefined && (
        <div className="data__amounts">
          {bound("minAmount", t("data.f.min"))}
          {bound("maxAmount", t("data.f.max"))}
        </div>
      )}
      <label className="switch">
        <input type="checkbox" role="switch" checked={filter.showHidden} onChange={() => filter.set({ showHidden: !filter.showHidden })} />
        <span>{t("data.f.showHidden")}</span>
      </label>
      {!isDefaultDataFilter(filter) && (
        <button type="button" className="transfers__reset data__reset" onClick={filter.reset}>
          {t("transfers.f.reset")}
        </button>
      )}
    </div>
  );
}
