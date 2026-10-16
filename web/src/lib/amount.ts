// All amount math is BigInt / string based. Never convert amounts to JS number.

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

export function parseHumanAmount(input: string, decimals: number): string | null {
  const s = input.trim();
  if (s === "") return null;
  const dot = s.indexOf(".");
  let intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? "" : s.slice(dot + 1);
  if (intPart.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+$/.test(intPart)) return null;
    intPart = intPart.replace(/,/g, "");
  }
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  if (intPart === "" && fracPart === "") return null;
  if (fracPart.length > decimals) return null;
  const digits = (intPart + fracPart.padEnd(decimals, "0")).replace(/^0+(?=\d)/, "");
  return digits === "" ? "0" : digits;
}
