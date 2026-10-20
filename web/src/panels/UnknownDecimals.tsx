import { AlertTriangle } from "lucide-react";
import { useT } from "../i18n";

/** The marker next to an amount whose token decimals are unknown (the amount is then the raw integer). */
export function UnknownDecimals() {
  const t = useT();
  return (
    <span className="transfers__warn" role="img" aria-label={t("transfers.unknownDecimals")} title={t("transfers.unknownDecimals")}>
      <AlertTriangle size={12} aria-hidden="true" />
    </span>
  );
}
