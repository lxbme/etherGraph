import { useEffect } from "react";
import { useGraph } from "../graph/store";
import { useTabs } from "./tabs";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

export type Route = { kind: "address"; addr: string } | { kind: "tx"; hash: string } | null;

export function parseHash(hash: string): Route {
  const m = /^#\/(address|tx)\/([^/?#]+)$/.exec(hash);
  if (!m) return null;
  const v = m[2] ?? "";
  if (m[1] === "address" && ADDR.test(v)) return { kind: "address", addr: v.toLowerCase() };
  if (m[1] === "tx" && TX.test(v)) return { kind: "tx", hash: v.toLowerCase() };
  return null;
}

let applying = false;

export function applyRoute(r: Route): void {
  if (!r) return;
  applying = true;
  try {
    if (r.kind === "address") {
      useGraph.getState().revealCenter(r.addr);
      useGraph.getState().select({ kind: "node", address: r.addr });
      useTabs.getState().activate("graph");
    } else {
      useTabs.getState().openTx(r.hash);
    }
  } finally {
    applying = false;
  }
}

function currentHash(): string {
  const { active } = useTabs.getState();
  if (active !== "graph") return `#/tx/${active}`;
  const sel = useGraph.getState().selection;
  return sel?.kind === "node" ? `#/address/${sel.address.toLowerCase()}` : "#/";
}

function writeBack() {
  if (applying) return;
  const h = currentHash();
  if (location.hash !== h) history.replaceState(null, "", h);
}

/** Parses the hash on mount, then mirrors tab/selection changes back into it. */
export function useHashRouting(): void {
  useEffect(() => {
    applyRoute(parseHash(location.hash));
    const onHash = () => applyRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    const u1 = useTabs.subscribe(writeBack);
    const u2 = useGraph.subscribe((s, p) => {
      if (s.selection !== p.selection) writeBack();
    });
    return () => {
      window.removeEventListener("hashchange", onHash);
      u1();
      u2();
    };
  }, []);
}
