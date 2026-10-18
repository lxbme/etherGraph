import { create } from "zustand";

/** A pending Save / Save as request from a keyboard shortcut; the workspace menu, which owns the dialogs, acts on it. */
interface SaveRequestState {
  /** `n` makes repeated requests distinct. */
  pending: { kind: "save" | "saveAs"; n: number } | null;
}

export const useSaveRequest = create<SaveRequestState>(() => ({ pending: null }));

export function requestSave(kind: "save" | "saveAs"): void {
  useSaveRequest.setState((s) => ({ pending: { kind, n: (s.pending?.n ?? 0) + 1 } }));
}

export function clearSaveRequest(): void {
  useSaveRequest.setState({ pending: null });
}
