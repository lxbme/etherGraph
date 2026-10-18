import { useState } from "react";
import { useT } from "../i18n";
import { download } from "../lib/download";
import { buildFile, fileName, type FileKind } from "../workspace/file";
import { clearExport, useFileRequest } from "../workspace/fileRequest";
import { toast } from "./Toasts";

/** The "Export file" dialog for a pending export request: what private data goes along, then the download. */
export function ExportFileDialog() {
  const req = useFileRequest((s) => s.exporting);
  return req ? <ExportForm kind={req.kind} tabHash={req.tabHash} /> : null;
}

function ExportForm({ kind, tabHash }: { kind: FileKind; tabHash?: string }) {
  const t = useT();
  // Private data stays out unless ticked.
  const [labels, setLabels] = useState(false);
  const [notes, setNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const file = await buildFile(kind, { labels, notes, ...(tabHash !== undefined ? { tabHash } : {}) });
      download(new Blob([JSON.stringify(file)], { type: "application/json" }), fileName(kind, tabHash));
    } catch (e) {
      toast(t("tools.exportFailed", { reason: e instanceof Error ? e.message : String(e) }), "error");
    } finally {
      clearExport();
    }
  };
  const title = t("file.exportTitle");
  return (
    <div className="dialog-backdrop">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Escape") clearExport();
        }}
      >
        <h3 className="dialog__title">{title}</h3>
        <p className="dialog__summary">{t("file.exportHint")}</p>
        <label className="dialog__check">
          <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
          {t("file.includeLabels")}
        </label>
        <label className="dialog__check">
          <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} />
          {t("file.includeNotes")}
        </label>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={clearExport}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn--primary" autoFocus disabled={busy} onClick={() => void submit()}>
            {t("file.export")}
          </button>
        </div>
      </div>
    </div>
  );
}
