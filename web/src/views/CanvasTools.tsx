import { SquareDashedMousePointer } from "lucide-react";
import type { ReactNode } from "react";
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
