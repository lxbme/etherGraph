export type InputKind = "address" | "tx" | "ens" | "invalid";

export function classifyInput(q: string): InputKind {
  const s = q.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return "address";
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return "tx";
  if (s.includes(".") && !/\s/.test(s)) return "ens";
  return "invalid";
}
