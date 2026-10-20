import { useMemo } from "react";
import type { TrustDto } from "../api/generated/TrustDto";
import { useAssetRegistry } from "../graph/assetRegistry";
import { useT } from "../i18n";
import { shortAddr } from "../lib/address";
import { AssetOptGroups, type AssetOption } from "./AssetOptGroups";

/** A chosen asset: undefined = all assets; null = ETH; else a lowercase token address. */
export type AssetChoice = string | null | undefined;

/** One asset an option can come from (an assets-endpoint row, a transfer): token address, null for ETH. */
export interface AssetSource {
  asset: string | null;
  symbol: string | null;
  trust: TrustDto;
}

/** The select's "all assets" value; the native coin's is "eth". */
const ALL = "";
const ETH = "eth";
const ETH_OPTION: AssetOption = { key: ETH, label: "ETH", trust: { level: "listed", impersonates: null, reason: null } };

const assetValue = (a: AssetChoice) => (a === undefined ? ALL : a === null ? ETH : a);
const assetOf = (v: string): AssetChoice => (v === ALL ? undefined : v === ETH ? null : v.toLowerCase());

/** ETH, the tokens of `sources`, and the chosen asset even when `sources` have none of it (it survives their changes). */
function useAssetOptions(sources: readonly AssetSource[], chosen: AssetChoice): AssetOption[] {
  const known = useAssetRegistry((r) => r.assets);
  return useMemo(() => {
    const out = new Map<string, AssetOption>([[ETH, ETH_OPTION]]);
    for (const a of sources) {
      if (a.asset === null) continue;
      const key = a.asset.toLowerCase();
      if (!out.has(key)) out.set(key, { key, label: a.symbol ?? shortAddr(key), trust: a.trust });
    }
    if (typeof chosen === "string" && !out.has(chosen)) {
      const k = known[chosen];
      out.set(chosen, { key: chosen, label: k?.symbol ?? shortAddr(chosen), trust: k?.trust ?? { level: "unknown", impersonates: null, reason: null } });
    }
    return [...out.values()];
  }, [sources, chosen, known]);
}

/** The asset select of a transfer filter: all assets, then ETH and the tokens of `sources`, listed first. */
export function AssetSelect({ sources, value, onChange }: { sources: readonly AssetSource[]; value: AssetChoice; onChange(asset: AssetChoice): void }) {
  const t = useT();
  const options = useAssetOptions(sources, value);
  return (
    <select className="input input--compact" aria-label={t("transfers.col.asset")} value={assetValue(value)} onChange={(e) => onChange(assetOf(e.target.value))}>
      <option value={ALL}>{t("transfers.f.assetAll")}</option>
      <AssetOptGroups options={options} native={ETH} />
    </select>
  );
}
