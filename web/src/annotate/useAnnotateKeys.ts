import { useEffect } from "react";
import { isShortcut, matchesCombo } from "../graph/shortcuts";
import { listenShortcutKeys } from "../graph/useShortcuts";
import type { ViewId } from "./model";
import { useAnnotations } from "./store";

/**
 * The keys of annotate mode on `view`, while `enabled`: undo / redo (the canvas' own history, in place of the graph's),
 * Delete or Backspace (removes the selected annotation), Escape (clears the selection, else leaves the mode).
 * Like the other shortcuts, they stay out of the way while typing (e.g. in the text editor) or with a dialog or menu open.
 */
export function useAnnotateKeys(view: ViewId, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    return listenShortcutKeys((e) => {
      const s = useAnnotations.getState();
      if (s.active !== view) return;
      if (isShortcut(e, "undo")) s.undo(view);
      else if (isShortcut(e, "redo")) s.redo(view);
      else if (matchesCombo(e, "Delete") || matchesCombo(e, "Backspace")) {
        if (s.selected === null) return;
        s.remove(view, s.selected);
      } else if (matchesCombo(e, "Escape")) {
        if (s.selected !== null) s.select(null);
        else s.setMode(null);
      } else return;
      e.preventDefault();
    });
  }, [view, enabled]);
}
