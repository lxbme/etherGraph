/** The zero address (lower-case); as an EIP-7702 delegate it clears the signer's delegation. */
export const ZERO_ADDRESS = "0x" + "0".repeat(40);

export function shortAddr(a: string): string {
  return a.length <= 10 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
