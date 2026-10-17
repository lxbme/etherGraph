/** Hook point between the help drawer's "Replay tour" button and the tour, which registers the handler. */
let handler: (() => void) | null = null;

/** Sets (or clears, with null) what replayTour runs. */
export function setReplayTourHandler(fn: (() => void) | null): void {
  handler = fn;
}

/** Restarts the first-run tour; a no-op until the tour registers a handler. */
export function replayTour(): void {
  handler?.();
}
