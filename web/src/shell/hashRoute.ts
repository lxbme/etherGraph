import { useEffect } from "react";
import { create } from "zustand";
import { graphSelection, useGraph } from "../graph/store";
import { useTabs } from "./tabs";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

export type Route = { kind: "address"; addr: string } | { kind: "tx"; hash: string } | { kind: "admin" } | null;

/** Whether `#/admin` is open: the admin page covers the app (which stays mounted, keeping the canvas). */
export const useAdminRoute = create<{ open: boolean }>(() => ({ open: false }));

export function parseHash(hash: string): Route {
  if (hash === "#/admin") return { kind: "admin" };
  const m = /^#\/(address|tx)\/([^/?#]+)$/.exec(hash);
  if (!m) return null;
  const v = m[2] ?? "";
  if (m[1] === "address" && ADDR.test(v)) return { kind: "address", addr: v.toLowerCase() };
  if (m[1] === "tx" && TX.test(v)) return { kind: "tx", hash: v.toLowerCase() };
  return null;
}

let applying = false;

export function applyRoute(r: Route): void {
  if (!r || r.kind === "admin") return;
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
  const sel = graphSelection(useGraph.getState().selection);
  return sel?.kind === "node" ? `#/address/${sel.address.toLowerCase()}` : "#/";
}

function writeBack() {
  if (applying || useAdminRoute.getState().open) return;
  const h = currentHash();
  if (location.hash !== h) history.replaceState(null, "", h);
}

/** Leaves the admin page for the app, putting back the hash of what the app shows. */
export function leaveAdmin(): void {
  useAdminRoute.setState({ open: false });
  history.replaceState(null, "", currentHash());
}

function route(): void {
  const r = parseHash(location.hash);
  useAdminRoute.setState({ open: r?.kind === "admin" });
  applyRoute(r);
}

/** Parses the hash on mount, then mirrors tab/selection changes back into it (not while the admin page is open). */
export function useHashRouting(): void {
  useEffect(() => {
    route();
    const onHash = route;
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
