/** Order-independent key for an unordered address pair (lowercased, "|" joined). */
export function pairKey(a: string, b: string): string {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x <= y ? `${x}|${y}` : `${y}|${x}`;
}
