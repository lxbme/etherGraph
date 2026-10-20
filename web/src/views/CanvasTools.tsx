import type cytoscape from "cytoscape";
import { Download, Eye, EyeOff, PenLine, ScanSearch, SquareDashedMousePointer } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { Annotation, ViewId } from "../annotate/model";
import { useAnnotations } from "../annotate/store";
import { exportImage, IMAGE_EXT, type ImageFormat } from "../graph/exportImage";
import { identifiable, identifyAddresses, useIdentifying } from "../graph/identify";
import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { download } from "../lib/download";
import { toast } from "../shell/Toasts";

/** What a canvas' Export menu works on. */
export interface CanvasExport {
  /** The live canvas (null before it is ready). */
  cy(): cytoscape.Core | null;
  /** The download name without its extension, e.g. `ethergraph-tx-7e57000000`. */
  baseName(): string;
  /** The view's annotations, drawn into the PNG and SVG exports (none when absent). */
  annotations?(): Annotation[];
  /** "File…": the view as a snapshot file; the item is shown only when this is given. */
  onExportFile?(): void;
}

/**
 * The top-right tool group of a canvas: `children` (more tools, e.g. "show hidden"), the select-mode
 * toggle (on canvases with a box selection), the annotate toggle (on canvases with annotations, `annotateView`)
 * and the Export menu, in one row so they never overlap.
 */
export function CanvasTools({
  selectMode,
  onSelectModeChange,
  exporter,
  annotateView,
  children,
}: {
  selectMode?: boolean;
  onSelectModeChange?(v: boolean): void;
  exporter: CanvasExport;
  annotateView?: ViewId;
  children?: ReactNode;
}) {
  const t = useT();
  const label = t("tools.selectMode");
  return (
    <div className="canvas-tools" role="toolbar" aria-label={t("tools.label")}>
      {children}
      {onSelectModeChange && (
        <button
          type="button"
          className="btn btn--icon btn--compact"
          aria-pressed={!!selectMode}
          aria-label={label}
          title={label}
          onClick={() => onSelectModeChange(!selectMode)}
        >
          <SquareDashedMousePointer size={14} />
        </button>
      )}
      {annotateView && <AnnotateToggle view={annotateView} />}
      <ExportMenu exporter={exporter} />
    </div>
  );
}

/** Enters or leaves annotate mode on this canvas. */
function AnnotateToggle({ view }: { view: ViewId }) {
  const t = useT();
  const on = useAnnotations((s) => s.active === view);
  const label = t("annotate.toggle");
  return (
    <button
      type="button"
      className="btn btn--icon btn--compact"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={() => {
        const s = useAnnotations.getState();
        s.setMode(s.active === view ? null : view);
      }}
    >
      <PenLine size={14} />
    </button>
  );
}

/** The Export menu: the whole graph as PNG, transparent PNG or SVG, or the view as a file. */
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
    const save = (blob: Blob) => download(blob, `${exporter.baseName()}.${IMAGE_EXT[format]}`);
    const fail = (e: unknown) => toast(t("tools.exportFailed", { reason: e instanceof Error ? e.message : String(e) }), "error");
    let out: Blob | Promise<Blob>;
    try {
      out = exportImage(cy, format, exporter.annotations?.() ?? []);
    } catch (e) {
      return void fail(e);
    }
    // Only a PNG with annotations is composed asynchronously.
    if (out instanceof Promise) out.then(save, fail);
    else save(out);
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

/**
 * The address graph's "+N more" toggle: "show all (N)" while some center's proxy is hidden, else "hide all", which hides
 * the proxy of every center in `proxied` (those on the canvas) and is disabled when there is none.
 */
export function MoreToggleButton({ proxied, omitted }: { proxied: readonly string[]; omitted: Readonly<Record<string, number>> }) {
  const t = useT();
  const centers = useGraph((s) => s.centers);
  const all = useGraph((s) => s.hiddenProxies);
  const stale = all.filter((c) => centers.includes(c));
  // Only a hidden center that has something omitted would show a proxy again.
  const hidden = stale.filter((c) => (omitted[c] ?? 0) > 0);
  const showing = hidden.length > 0;
  const label = showing ? t("tools.showAllMore", { count: hidden.length }) : t("tools.hideAllMore");
  return (
    <button
      type="button"
      className="btn btn--icon btn--compact"
      aria-label={label}
      title={label}
      disabled={!showing && proxied.length === 0}
      onClick={() => useGraph.getState().setProxiesHidden(showing ? stale : [...proxied], !showing)}
    >
      {showing ? <Eye size={14} /> : <EyeOff size={14} />}
    </button>
  );
}
