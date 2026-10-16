export function shortAddr(a: string): string {
  return a.length <= 10 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
