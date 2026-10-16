import { useEffect } from "react";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { useUi } from "../panels/uiStore";
import { focusNode, hideNode, syncNode, togglePin } from "./nodeActions";
import { useGraph } from "./store";

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

/** Global keyboard shortcuts: undo/redo, and S/P/H/F/L on the selected node. Inactive while typing. */
export function useShortcuts(getData: () => GraphResponseDto | undefined): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      // A dialog or context menu owns the keyboard while open.
      const t = e.target as Element | null;
      if (document.querySelector('[role="dialog"],[role="menu"]') || t?.closest?.('[role="dialog"],[role="menu"]')) return;
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const g = useGraph.getState();
      if (mod) {
        if (key === "z" && !e.shiftKey) g.undo();
        else if ((key === "z" && e.shiftKey) || (key === "y" && e.ctrlKey)) g.redo();
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey || e.shiftKey) return;
      const sel = g.selection;
      if (sel?.kind !== "node") return;
      const a = sel.address;
      switch (key) {
        case "s": syncNode(a); break;
        case "p": togglePin(a); break;
        case "h": hideNode(a); break;
        case "f": focusNode(a, getData()); break;
        case "l": useUi.getState().openLabelEditor(a); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [getData]);
}
