import type { MsgKey } from "../i18n";

export type ShortcutId = "search" | "undo" | "redo" | "sync" | "pin" | "hide" | "focus" | "label" | "clearSelection" | "save" | "saveAs";

export interface Shortcut {
  id: ShortcutId;
  /** Key combos, e.g. "Shift+Mod+Z": modifiers (Shift, Alt, Ctrl, Mod = Ctrl or ⌘) then the key. */
  keys: string[];
  /** "node" shortcuts act on the selected node and do nothing without one. */
  scope: "global" | "node";
  label: MsgKey;
}

/**
 * The keyboard shortcuts, listed in the help in this order. useShortcuts dispatches every entry except
 * "search", which the search box handles itself (it works everywhere, even while typing).
 */
export const SHORTCUTS: ReadonlyArray<Shortcut> = [
  { id: "search", keys: ["Mod+K"], scope: "global", label: "shortcut.search" },
  { id: "undo", keys: ["Mod+Z"], scope: "global", label: "shortcut.undo" },
  { id: "redo", keys: ["Shift+Mod+Z", "Ctrl+Y"], scope: "global", label: "shortcut.redo" },
  { id: "save", keys: ["Mod+S"], scope: "global", label: "shortcut.save" },
  { id: "saveAs", keys: ["Shift+Mod+S"], scope: "global", label: "shortcut.saveAs" },
  { id: "sync", keys: ["S"], scope: "node", label: "shortcut.sync" },
  { id: "pin", keys: ["P"], scope: "node", label: "shortcut.pin" },
  { id: "hide", keys: ["H"], scope: "node", label: "shortcut.hide" },
  { id: "focus", keys: ["F"], scope: "node", label: "shortcut.focus" },
  { id: "label", keys: ["L"], scope: "node", label: "shortcut.label" },
  { id: "clearSelection", keys: ["Escape"], scope: "global", label: "shortcut.clearSelection" },
];

type KeyState = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/** Whether the event is exactly this combo: Shift and Alt must match, and no Ctrl/⌘ unless the combo asks for one. */
export function matchesCombo(e: KeyState, combo: string): boolean {
  const mods = combo.split("+");
  const key = mods.pop()!.toLowerCase();
  if (e.key.toLowerCase() !== key) return false;
  if (e.shiftKey !== mods.includes("Shift") || e.altKey !== mods.includes("Alt")) return false;
  if (mods.includes("Mod")) return e.ctrlKey || e.metaKey;
  if (mods.includes("Ctrl")) return e.ctrlKey;
  return !e.ctrlKey && !e.metaKey;
}

/** The table entry the event triggers, if any. */
export function shortcutFor(e: KeyState): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.keys.some((k) => matchesCombo(e, k)));
}

/** Whether the event triggers the entry with this id. */
export function isShortcut(e: KeyState, id: ShortcutId): boolean {
  return shortcutFor(e)?.id === id;
}

/** macOS (and iPadOS) render Mod as ⌘. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad|ipod/i.test(uaData?.platform || navigator.platform || "");
}

/** A combo as shown to the user: Mod becomes ⌘ on macOS, Ctrl elsewhere. */
export function formatCombo(combo: string, mac: boolean = isMac()): string {
  return combo
    .split("+")
    .map((p) => (p === "Mod" ? (mac ? "⌘" : "Ctrl") : p))
    .join("+");
}
