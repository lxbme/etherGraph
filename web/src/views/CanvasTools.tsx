import type cytoscape from "cytoscape";
import { Download, ScanSearch, SquareDashedMousePointer } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { exportImage, IMAGE_EXT, type ImageFormat } from "../graph/exportImage";
import { identifiable, identifyAddresses, useIdentifying } from "../graph/identify";
import { useT } from "../i18n";
import { download } from "../lib/download";
import { toast } from "../shell/Toasts";

/** What a canvas' Export menu works on. */
export interface CanvasExport {
  /** The live canvas (null before it is ready). */
  cy(): cytoscape.Core | null;
  /** The download name without its extension, e.g. `ethergraph-tx-7e57000000`. */
  baseName(): string;
  /** "File…" (Task 8: the view as a snapshot file); the item is shown only when this is given. */
  onExportFile?(): void;
}

/**
 * The top-right tool group of a canvas: `children` (more tools, e.g. "show hidden"), the select-mode
 * toggle and the Export menu, in one row so they never overlap.
 */
export function CanvasTools({
  selectMode,
  onSelectModeChange,
  exporter,
  children,
}: {
  selectMode: boolean;
  onSelectModeChange(v: boolean): void;
  exporter: CanvasExport;
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
      <ExportMenu exporter={exporter} />
    </div>
  );
}

/** The Export menu: the whole graph as PNG, transparent PNG or SVG (and, once wired, as a file). */
function ExportMenu({ exporter }: { exporter: CanvasExport }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Like the workspace menu: an outside press or Escape closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const exportAs = (format: ImageFormat) => {
    const cy = exporter.cy();
    if (!cy || cy.elements().empty()) return void toast(t("tools.nothingToExport"), "error");
    let blob: Blob;
    try {
      blob = exportImage(cy, format);
    } catch (e) {
      return void toast(t("tools.exportFailed", { reason: e instanceof Error ? e.message : String(e) }), "error");
    }
    download(blob, `${exporter.baseName()}.${IMAGE_EXT[format]}`);
  };

  const label = t("tools.export");
  const item = (text: string, fn: () => void) => (
    <button
      type="button"
      className="menu__item"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        fn();
      }}
    >
      {text}
    </button>
  );
  return (
    <div className="dropdown" ref={rootRef}>
      <button
        type="button"
        className="btn btn--icon btn--compact"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Download size={14} />
      </button>
      {open && (
        <div className="menu dropdown__panel" role="menu" aria-label={label}>
          {item(t("tools.exportPng"), () => exportAs("png"))}
          {item(t("tools.exportPngTransparent"), () => exportAs("png-transparent"))}
          {item(t("tools.exportSvg"), () => exportAs("svg"))}
          {exporter.onExportFile && item(t("tools.exportFile"), () => exporter.onExportFile?.())}
        </div>
      )}
    </div>
  );
}

/** "Identify all (N)" over the canvas' nodes; renders nothing when none needs identification. */
export function IdentifyAllButton({ nodes }: { nodes: readonly NodeSummaryDto[] }) {
  const t = useT();
  const addrs = identifiable(nodes);
  const running = useIdentifying((s) => s.running);
  if (addrs.length === 0) return null;
  return (
    <button
      type="button"
      className="btn btn--compact"
      title={t("tools.identifyAllHint")}
      disabled={running}
      onClick={() => void identifyAddresses(addrs)}
    >
      <ScanSearch size={14} />
      {t("tools.identifyAll", { count: addrs.length })}
    </button>
  );
}
