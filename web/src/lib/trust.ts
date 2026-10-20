import type { TrustDto } from "../api/generated/TrustDto";
import type { t as translate } from "../i18n";
import { shortAddr } from "./address";

/** The trust levels that get a warning; listed and unknown tokens show nothing. */
export type TrustFlag = "suspicious" | "scam";

/** Sort rank of a trust level: listed tokens first, then unknown ones, then possible impersonations and scams. */
export const TRUST_TIER: Record<TrustDto["level"], number> = { listed: 0, unknown: 1, suspicious: 2, scam: 2 };

/** The prefix of a flagged edge's label on both canvases. */
export const TRUST_MARK = "⚠";

/** Whether the token is on a token list; the only level that is vouched for. */
export const isListed = (trust: TrustDto): boolean => trust.level === "listed";

export function trustFlag(trust: TrustDto): TrustFlag | null {
  return trust.level === "suspicious" || trust.level === "scam" ? trust.level : null;
}

/** The worst flag among `items`: scam over suspicious; null when none is flagged. */
export function worstFlag(items: readonly { trust: TrustDto }[]): TrustFlag | null {
  let out: TrustFlag | null = null;
  for (const it of items) {
    const f = trustFlag(it.trust);
    if (f === "scam") return f;
    out ??= f;
  }
  return out;
}

/** `label` with the warning mark in front; the mark alone when there is no label. */
export const flaggedLabel = (label: string | null | undefined): string => (label ? `${TRUST_MARK} ${label}` : TRUST_MARK);

/** The badge text of a flagged level. */
export const trustText = (flag: TrustFlag, t: typeof translate): string => t(flag === "scam" ? "trust.scam" : "trust.suspicious");

/** Why a token is flagged: the listed token a suspicious one copies, or what marked it a scam; null when not flagged. */
export function trustReason(trust: TrustDto, t: typeof translate): string | null {
  if (trust.level === "suspicious") {
    const imp = trust.impersonates;
    if (!imp) return t("trust.suspicious.reasonGeneric");
    const address = shortAddr(imp.address.toLowerCase());
    return t("trust.suspicious.reason", { name: imp.name ?? imp.symbol ?? address, address });
  }
  if (trust.level === "scam") return t(trust.reason === "spam-token" ? "trust.scam.spam" : "trust.scam.label");
  return null;
}
