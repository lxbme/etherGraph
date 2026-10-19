// All amount math is BigInt / string based. Never convert amounts to JS number.

import type { AssetClass } from "./assets";

function withCommas(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatAmount(
  raw: string,
  decimals: number | null,
  opts?: { maxFrac?: number },
): { text: string; unknownDecimals: boolean } {
  if (!/^\d+$/.test(raw)) return { text: "?", unknownDecimals: false };
  const value = BigInt(raw);
  if (decimals === null) return { text: withCommas(value.toString()), unknownDecimals: true };
  const maxFrac = opts?.maxFrac ?? 4;
  const base = 10n ** BigInt(decimals);
  const int = value / base;
  const intText = withCommas(int.toString());
  if (decimals === 0) return { text: intText, unknownDecimals: false };
  const fracFull = (value % base).toString().padStart(decimals, "0");
  const frac = fracFull.slice(0, maxFrac).replace(/0+$/, "");
  if (frac === "") {
    if (int === 0n && value !== 0n) {
      return { text: `<0.${"0".repeat(Math.max(maxFrac - 1, 0))}1`, unknownDecimals: false };
    }
    return { text: intText, unknownDecimals: false };
  }
  return { text: `${intText}.${frac}`, unknownDecimals: false };
}

/** Fraction digits shown per asset class, so a column of one asset lines up on the decimal point. */
export const FIXED_DECIMALS: Record<AssetClass, number> = { eth: 6, stable: 2, erc20: 4, nft: 0 };

/**
 * Fixed-width amount: always FIXED_DECIMALS[cls] fraction digits, zero-padded and truncated (never rounded).
 * `full` is the exact value (trailing zeros dropped) for a `title`. Unknown decimals show the raw integer.
 */
export function formatFixed(
  raw: string,
  decimals: number | null,
  cls: AssetClass,
): { text: string; full: string; unknownDecimals: boolean } {
  if (!/^\d+$/.test(raw)) return { text: "?", full: raw, unknownDecimals: false };
  const value = BigInt(raw);
  if (decimals === null) {
    const text = withCommas(value.toString());
    return { text, full: text, unknownDecimals: true };
  }
  const places = FIXED_DECIMALS[cls];
  const base = 10n ** BigInt(decimals);
  const int = value / base;
  const intText = withCommas(int.toString());
  const fracFull = decimals === 0 ? "" : (value % base).toString().padStart(decimals, "0");
  const fracTrimmed = fracFull.replace(/0+$/, "");
  const full = fracTrimmed === "" ? intText : `${intText}.${fracTrimmed}`;
  const frac = fracFull.padEnd(places, "0").slice(0, places);
  if (int === 0n && value !== 0n && /^0*$/.test(frac)) {
    const text = places === 0 ? "<1" : `<0.${"0".repeat(places - 1)}1`;
    return { text, full, unknownDecimals: false };
  }
  return { text: places === 0 ? intText : `${intText}.${frac}`, full, unknownDecimals: false };
}

/** Exact amount: thousands separators and every fraction digit (trailing zeros dropped). Unknown decimals show the raw integer. */
export function formatFull(raw: string, decimals: number | null): string {
  if (!/^\d+$/.test(raw)) return "?";
  const value = BigInt(raw);
  if (decimals === null || decimals === 0) return withCommas(value.toString());
  const base = 10n ** BigInt(decimals);
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const int = withCommas((value / base).toString());
  return frac === "" ? int : `${int}.${frac}`;
}

export function parseHumanAmount(input: string, decimals: number): string | null {
  const s = input.trim();
  if (s === "") return null;
  const dot = s.indexOf(".");
  let intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? "" : s.slice(dot + 1);
  if (intPart.includes(",")) {
    // Grouped thousands: a 1-3 digit leading group without a leading zero ("0,001" is rejected), then groups of 3.
    if (!/^[1-9]\d{0,2}(,\d{3})+$/.test(intPart)) return null;
    intPart = intPart.replace(/,/g, "");
  }
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  if (intPart === "" && fracPart === "") return null;
  if (fracPart.length > decimals) return null;
  const digits = (intPart + fracPart.padEnd(decimals, "0")).replace(/^0+(?=\d)/, "");
  return digits === "" ? "0" : digits;
}
