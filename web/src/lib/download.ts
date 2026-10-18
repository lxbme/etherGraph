import { t } from "../i18n";

/** Saves `blob` as `filename` through a temporary download link. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Safe download base name: no path separators/control chars, no leading dots; `fallback` when nothing is left. */
export function safeFileName(name: string | null, fallback: string = t("ws.untitled")): string {
  const cleaned = (name ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "");
  return cleaned.trim() === "" ? fallback : cleaned;
}
