/**
 * A popover like FilterPanel / SettingsMenu / JobsPopover: a `role="dialog"` that closes on Escape from a
 * `document` keydown listener, with focus left on its trigger button outside it. It is removed at once, as
 * in a browser, where React flushes the close between the document and window listeners (jsdom does not).
 */
export function openFakePopover(): { trigger: HTMLButtonElement; popover: HTMLElement; isOpen(): boolean; dispose(): void } {
  const trigger = document.createElement("button");
  trigger.textContent = "popover trigger";
  const popover = document.createElement("div");
  popover.setAttribute("role", "dialog");
  document.body.append(trigger, popover);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") popover.remove();
  };
  document.addEventListener("keydown", onKey);
  trigger.focus();
  return {
    trigger,
    popover,
    isOpen: () => popover.isConnected,
    dispose: () => {
      document.removeEventListener("keydown", onKey);
      trigger.remove();
      popover.remove();
    },
  };
}

/** Escape pressed on `target` (bubbling through document to window, like a real key press). */
export function pressEscape(target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}
