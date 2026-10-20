import { create } from "zustand";
import { commitOpenText } from "../annotate/store";

/** A pending Save / Save as request from a keyboard shortcut; the workspace menu, which owns the dialogs, acts on it. */
interface SaveRequestState {
  /** `n` makes repeated requests distinct. */
  pending: { kind: "save" | "saveAs"; n: number } | null;
}

export const useSaveRequest = create<SaveRequestState>(() => ({ pending: null }));

/** Asks for a save; a text annotation being written is committed first, so the save includes it. */
export function requestSave(kind: "save" | "saveAs"): void {
  commitOpenText();
  useSaveRequest.setState((s) => ({ pending: { kind, n: (s.pending?.n ?? 0) + 1 } }));
}

export function clearSaveRequest(): void {
  useSaveRequest.setState({ pending: null });
}
