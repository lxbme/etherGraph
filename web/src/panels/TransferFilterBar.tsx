import type { AddressAssetDto } from "../api/generated/AddressAssetDto";
import { useT } from "../i18n";
import { TRANSFER_KINDS, transferKindName } from "../lib/transferKinds";
import { AssetSelect } from "./AssetSelect";
import { TimeRange } from "./TimeRange";
import { isDefault, useTransferFilter, type TransferTableFilter } from "./transferFilter";

/**
 * The transfer table's own filter (time, asset, direction, type), independent of the graph filter: controls only.
 * `assets` are the selection's own assets over all its stored transfers (`GET /api/address/{a}/assets`), not the
 * graph's filtered edges; `pair` hides the direction, which each of a pair's groups already has.
 */
export function TransferFilterBar({ assets, pair = false }: { assets: AddressAssetDto[]; pair?: boolean }) {
  const t = useT();
  const filter = useTransferFilter();
  // Reset follows the controls shown: the hidden direction does not count in pair scope.
  const narrowed = !isDefault(pair ? { ...filter, direction: "all" } : filter);
  return (
    <div className="transfers__bar" role="toolbar">
      <TimeRange from={filter.from} to={filter.to} onChange={filter.set} />
      <AssetSelect sources={assets} value={filter.asset} onChange={(asset) => filter.set({ asset })} />
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
      {narrowed && (
        <button type="button" className="transfers__reset" onClick={filter.reset}>
          {t("transfers.f.reset")}
        </button>
      )}
    </div>
  );
}
