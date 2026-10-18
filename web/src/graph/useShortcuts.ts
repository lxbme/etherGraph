import { useEffect } from "react";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { useUi } from "../panels/uiStore";
import { useTabs } from "../shell/tabs";
import { useBoxSelection } from "./boxSelection";
import { focusNode, hideNode, syncNode, togglePin } from "./nodeActions";
import { requestSave } from "../workspace/saveRequest";
import { isShortcut, shortcutFor, type ShortcutId } from "./shortcuts";
import { graphSelection, useGraph } from "./store";

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

function overlayOpen(e: KeyboardEvent): boolean {
  const t = e.target as Element | null;
  return !!(document.querySelector('[role="dialog"],[role="menu"]') || t?.closest?.('[role="dialog"],[role="menu"]'));
}

/** Whether the key belongs to something else: a text field being typed in, or an open dialog / popover / menu. */
function keyOwnedElsewhere(e: KeyboardEvent): boolean {
  return isTyping(e.target) || overlayOpen(e);
}

/** Save / Save as: always taken from the browser (it would save the page), but acted on only with no overlay open. */
function isSaveKey(e: KeyboardEvent): boolean {
  return isShortcut(e, "save") || isShortcut(e, "saveAs");
}

/**
 * Calls `onKey` for key presses nothing else owns (see keyOwnedElsewhere); returns the unsubscribe.
 *
 * Listens on window in the capture phase, i.e. before any element or `document` handler. Popovers and menus
 * close on Escape from `document` listeners, and in a browser React removes them before a bubble-phase window
 * listener runs: checked then, one Escape would both close a popover and act here.
 */
export function listenShortcutKeys(onKey: (e: KeyboardEvent) => void): () => void {
  const listener = (e: KeyboardEvent) => {
    if (isSaveKey(e)) {
      e.preventDefault();
      if (!overlayOpen(e)) onKey(e); // saving from a text field is fine
    } else if (!keyOwnedElsewhere(e)) onKey(e);
  };
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}

interface Ctx {
  /** The selected node ("" for global shortcuts, which never read it). */
  address: string;
  getData: () => GraphResponseDto | undefined;
}

/** What each SHORTCUTS entry does ("search" belongs to the search box); `false`: nothing to do, the key is not consumed. */
const HANDLERS: Record<Exclude<ShortcutId, "search">, (c: Ctx) => void | false> = {
  save: () => requestSave("save"),
  saveAs: () => requestSave("saveAs"),
  undo: () => useGraph.getState().undo(),
  redo: () => useGraph.getState().redo(),
  sync: (c) => syncNode(c.address),
  pin: (c) => togglePin(c.address),
  hide: (c) => hideNode(c.address),
  focus: (c) => focusNode(c.address, c.getData()),
  label: (c) => useUi.getState().openLabelEditor(c.address),
  clearSelection: () => {
    if (useBoxSelection.getState().ids.length === 0) return false;
    useBoxSelection.getState().clear();
  },
};

/**
 * Keyboard shortcuts from the SHORTCUTS table: save / save as (any tab), undo/redo, Escape (clears the box selection), and node keys
 * on the selected node.
 * Inactive while typing or while a dialog / popover / menu is open (listenShortcutKeys), and while a tx tab is
 * shown (the address graph they act on is hidden then).
 */
export function useShortcuts(getData: () => GraphResponseDto | undefined): void {
  useEffect(
    () =>
      listenShortcutKeys((e) => {
        const hit = shortcutFor(e);
        if (!hit || hit.id === "search") return;
        if (useTabs.getState().active !== "graph" && hit.id !== "save" && hit.id !== "saveAs") return;
        let address = "";
        if (hit.scope === "node") {
          const sel = graphSelection(useGraph.getState().selection);
          if (sel?.kind !== "node") return;
          address = sel.address;
        }
        if (HANDLERS[hit.id]({ address, getData }) !== false) e.preventDefault();
      }),
    [getData],
  );
}
