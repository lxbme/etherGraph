import { Plus } from "lucide-react";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { addToGraph } from "../graph/nodeActions";
import { useT } from "../i18n";
import { shortAddr } from "../lib/address";
import { CopyButton } from "./CopyButton";

/**
 * An address as its name (or short form, monospace) with copy and "Add to graph" buttons; the full address is the
 * title. With `onSelect` the name is a button that reports the address (e.g. to select it in a graph). `actions={false}`
 * leaves the buttons out, for a place that may clip the cell whole and so must hold nothing to tab to.
 */
export function AddressCell({ address, node, onSelect, actions = true }: { address: string; node?: NodeSummaryDto; onSelect?(address: string): void; actions?: boolean }) {
  const t = useT();
  const name = node?.display_name ?? node?.contract_name ?? null;
  const cls = name ? "addr-cell__name" : "addr-cell__name num";
  return (
    <span className="addr-cell">
      {onSelect ? (
        <button type="button" className={`${cls} addr-cell__select`} title={address} onClick={() => onSelect(address)}>
          {name ?? shortAddr(address)}
        </button>
      ) : (
        <span className={cls} title={address}>
          {name ?? shortAddr(address)}
        </span>
      )}
      {actions && (
        <>
          <CopyButton value={address} />
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--compact"
            aria-label={t("tx.addToGraph")}
            title={t("tx.addToGraph")}
            onClick={() => addToGraph(address)}
          >
            <Plus size={14} />
          </button>
        </>
      )}
    </span>
  );
}
