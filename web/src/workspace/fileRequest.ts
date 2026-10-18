import { useEffect } from "react";
import { create } from "zustand";
import { useAdminRoute } from "../shell/hashRoute";
import type { FileKind } from "./file";

/**
 * Pending file export / import requests from anywhere in the app (a canvas' Export menu, a dropped file). The
 * export dialog acts on `exporting`; the workspace menu, which owns the unsaved-changes confirm, on `importing`.
 */
interface FileRequestState {
  exporting: { kind: FileKind; tabHash?: string } | null;
  /** `n` makes repeated requests distinct. */
  importing: { file: Blob; n: number } | null;
}

export const useFileRequest = create<FileRequestState>(() => ({ exporting: null, importing: null }));

/** Opens the export dialog for the workspace, the address graph, or the tx tab `tabHash`. */
export function requestExport(kind: FileKind, tabHash?: string): void {
  useFileRequest.setState({ exporting: tabHash === undefined ? { kind } : { kind, tabHash } });
}

export function clearExport(): void {
  useFileRequest.setState({ exporting: null });
}

export function requestImport(file: Blob): void {
  useFileRequest.setState((s) => ({ importing: { file, n: (s.importing?.n ?? 0) + 1 } }));
}

export function clearImport(): void {
  useFileRequest.setState({ importing: null });
}

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;

/**
 * A file dropped anywhere on the window is imported (the browser would otherwise open it in place of the app);
 * on the admin page it is only kept from opening.
 */
export function useFileDrop(): void {
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      // The admin page covers the workspace: a file dropped there must not replace it unseen.
      if (useAdminRoute.getState().open) return;
      const file = e.dataTransfer?.files[0];
      if (file) requestImport(file);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
}
