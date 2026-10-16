export const HISTORY_LIMIT = 100;

/** Push onto a capped stack (oldest entries dropped), returning a new array. */
export function pushCapped<T>(stack: readonly T[], item: T, limit = HISTORY_LIMIT): T[] {
  const next = [...stack, item];
  return next.length > limit ? next.slice(next.length - limit) : next;
}
