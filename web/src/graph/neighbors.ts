import type { EdgeDto } from "../api/generated/EdgeDto";

const lc = (s: string) => s.toLowerCase();

/** Nodes connected to `a` by any edge (either direction), excluding `a`; lowercase, first-seen order. */
export function neighborsOf(a: string, edges: EdgeDto[]): string[] {
  const me = lc(a);
  const out = new Set<string>();
  for (const e of edges) {
    const f = lc(e.from);
    const t = lc(e.to);
    if (f === me && t !== me) out.add(t);
    else if (t === me && f !== me) out.add(f);
  }
  return [...out];
}
