import { ScanSearch, SquareDashedMousePointer } from "lucide-react";
import type { ReactNode } from "react";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { identifiable, identifyAddresses } from "../graph/identify";
import { useT } from "../i18n";

/**
 * The top-right tool group of a canvas: `children` (more tools, e.g. "show hidden") then the select-mode
 * toggle, in one row so they never overlap.
 */
export function CanvasTools({
  selectMode,
  onSelectModeChange,
  children,
}: {
  selectMode: boolean;
  onSelectModeChange(v: boolean): void;
  children?: ReactNode;
}) {
  const t = useT();
  const label = t("tools.selectMode");
  return (
    <div className="canvas-tools" role="toolbar" aria-label={t("tools.label")}>
      {children}
      <button
        type="button"
        className="btn btn--icon btn--compact"
        aria-pressed={selectMode}
        aria-label={label}
        title={label}
        onClick={() => onSelectModeChange(!selectMode)}
      >
        <SquareDashedMousePointer size={14} />
      </button>
    </div>
  );
}

/** "Identify all (N)" over the canvas' nodes; renders nothing when none needs identification. */
export function IdentifyAllButton({ nodes }: { nodes: readonly NodeSummaryDto[] }) {
  const t = useT();
  const addrs = identifiable(nodes);
  if (addrs.length === 0) return null;
  return (
    <button
      type="button"
      className="btn btn--compact"
      title={t("tools.identifyAllHint")}
      onClick={() => void identifyAddresses(addrs)}
    >
      <ScanSearch size={14} />
      {t("tools.identifyAll", { count: addrs.length })}
    </button>
  );
}
