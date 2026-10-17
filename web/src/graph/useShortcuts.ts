import { useEffect } from "react";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { useUi } from "../panels/uiStore";
import { useTabs } from "../shell/tabs";
import { focusNode, hideNode, syncNode, togglePin } from "./nodeActions";
import { shortcutFor, type ShortcutId } from "./shortcuts";
import { graphSelection, useGraph } from "./store";

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

interface Ctx {
  /** The selected node ("" for global shortcuts, which never read it). */
  address: string;
  getData: () => GraphResponseDto | undefined;
}

/** What each SHORTCUTS entry does ("search" belongs to the search box). */
const HANDLERS: Record<Exclude<ShortcutId, "search">, (c: Ctx) => void> = {
  undo: () => useGraph.getState().undo(),
  redo: () => useGraph.getState().redo(),
  sync: (c) => syncNode(c.address),
  pin: (c) => togglePin(c.address),
  hide: (c) => hideNode(c.address),
  focus: (c) => focusNode(c.address, c.getData()),
  label: (c) => useUi.getState().openLabelEditor(c.address),
};

/**
 * Keyboard shortcuts from the SHORTCUTS table: undo/redo, and node keys on the selected node.
 * Inactive while typing, and while a tx tab is shown (the address graph they act on is hidden then).
 */
export function useShortcuts(getData: () => GraphResponseDto | undefined): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useTabs.getState().active !== "graph") return;
      if (isTyping(e.target)) return;
      // A dialog or context menu owns the keyboard while open.
      const t = e.target as Element | null;
      if (document.querySelector('[role="dialog"],[role="menu"]') || t?.closest?.('[role="dialog"],[role="menu"]')) return;
      const hit = shortcutFor(e);
      if (!hit || hit.id === "search") return;
      let address = "";
      if (hit.scope === "node") {
        const sel = graphSelection(useGraph.getState().selection);
        if (sel?.kind !== "node") return;
        address = sel.address;
      }
      HANDLERS[hit.id]({ address, getData });
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [getData]);
}
