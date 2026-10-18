import type { TrustDto } from "../../api/generated/TrustDto";
import { useT } from "../../i18n";
import { trustFlag, trustReason, trustText } from "../../lib/trust";

/**
 * A token's trust warning next to its symbol: a warn tag for a possible impersonation, a scam-hued tag for a known
 * scam, with the reason as the title. Listed and unknown tokens show nothing.
 */
export function TrustBadge({ trust, subject }: { trust: TrustDto; /** Names the token in the title where the badge stands apart from its symbol. */ subject?: string }) {
  const t = useT();
  const flag = trustFlag(trust);
  if (!flag) return null;
  const why = trustReason(trust, t);
  return (
    <span className={flag === "scam" ? "tag tag--scam" : "tag tag--warn"} title={why && subject ? `${subject}: ${why}` : (why ?? undefined)}>
      {trustText(flag, t)}
    </span>
  );
}
