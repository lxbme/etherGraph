import { Plus } from "lucide-react";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { shortAddr } from "../lib/address";
import { CopyButton } from "./CopyButton";

/** An address as its name (or short form, monospace) with copy and "Add to graph" buttons; the full address is the title. */
export function AddressCell({ address, node }: { address: string; node?: NodeSummaryDto }) {
  const t = useT();
  const name = node?.display_name ?? node?.contract_name ?? null;
  return (
    <span className="addr-cell">
      <span className={name ? "addr-cell__name" : "addr-cell__name num"} title={address}>
        {name ?? shortAddr(address)}
      </span>
      <CopyButton value={address} />
      <button
        type="button"
        className="btn btn--ghost btn--icon btn--compact"
        aria-label={t("tx.addToGraph")}
        title={t("tx.addToGraph")}
        onClick={() => useGraph.getState().revealCenter(address)}
      >
        <Plus size={14} />
      </button>
    </span>
  );
}
