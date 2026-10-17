/** Side effects of history entries (e.g. an expansion's sync batch). The store stays free of network code: the app registers the real handler. */

export type ExpandEffect = { kind: "expand"; batch: string; addresses: string[] };

export interface HistoryEffectHandler {
  /** Called after an expand step was undone (e.g. cancel its batch). */
  onUndo(e: ExpandEffect): void;
  /** Called after an expand step was redone; a returned effect (e.g. a new batch id) replaces the entry's. */
  onRedo(e: ExpandEffect): ExpandEffect | void;
}

let handler: HistoryEffectHandler | null = null;

/** Registers the handler; `null` unregisters it (then effects do nothing). */
export function setHistoryEffectHandler(h: HistoryEffectHandler | null): void {
  handler = h;
}

export function runUndoEffect(e: ExpandEffect): void {
  handler?.onUndo(e);
}

/** The effect the redone entry carries from now on. */
export function runRedoEffect(e: ExpandEffect): ExpandEffect {
  return handler?.onRedo(e) ?? e;
}
