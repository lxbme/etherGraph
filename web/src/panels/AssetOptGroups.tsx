import type { TrustDto } from "../api/generated/TrustDto";
import { useT } from "../i18n";
import { shortAddr } from "../lib/address";
import { TRUST_MARK, TRUST_TIER, isListed, trustFlag, trustText } from "../lib/trust";

/** One asset of an asset select: `key` is its option value (the native coin's is the caller's `native`). */
export interface AssetOption {
  key: string;
  label: string;
  trust: TrustDto;
}

/** Tokens on a token list first, the native coin leading; every other token after, unknown ones before flagged. */
export function splitAssetOptions(options: AssetOption[], native: string): { listed: AssetOption[]; other: AssetOption[] } {
  const bySymbol = (x: AssetOption, y: AssetOption) => x.label.localeCompare(y.label) || x.key.localeCompare(y.key);
  return {
    listed: options
      .filter((o) => isListed(o.trust))
      .sort((x, y) => (x.key === native ? -1 : y.key === native ? 1 : bySymbol(x, y))),
    other: options
      .filter((o) => !isListed(o.trust))
      .sort((x, y) => TRUST_TIER[x.trust.level] - TRUST_TIER[y.trust.level] || bySymbol(x, y)),
  };
}

/**
 * The options of an asset select, in the listed-first order: the token-list group, then every other token. A
 * token shows its symbol with its contract, so look-alikes differ; flagged ones also say why.
 */
export function AssetOptGroups({ options, native }: { options: AssetOption[]; native: string }) {
  const t = useT();
  const { listed, other } = splitAssetOptions(options, native);
  const text = (o: AssetOption) => {
    const name = o.key === native || o.label === shortAddr(o.key) ? o.label : `${o.label} · ${shortAddr(o.key)}`;
    const flag = trustFlag(o.trust);
    return flag ? `${TRUST_MARK} ${name} · ${trustText(flag, t)}` : name;
  };
  const option = (o: AssetOption) => (
    <option key={o.key} value={o.key} title={o.key === native ? undefined : o.key}>
      {text(o)}
    </option>
  );
  return (
    <>
      {listed.length > 0 && <optgroup label={t("filter.listedTokens", { count: listed.length })}>{listed.map(option)}</optgroup>}
      {other.length > 0 && <optgroup label={t("filter.otherTokens", { count: other.length })}>{other.map(option)}</optgroup>}
    </>
  );
}
