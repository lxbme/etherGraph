import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { t } from "../i18n";
import { shortAddr } from "../lib/address";
import { usePick } from "../panels/pick/pickStore";
import { toast } from "../shell/Toasts";
import { useTabs } from "../shell/tabs";
import { neighborsOf } from "./neighbors";
import { useGraph } from "./store";

const lc = (s: string) => s.toLowerCase();

/** Sync (or refresh) one address of the address graph (after a refresh from the chain when it shows a snapshot); `direction: "older"` pulls earlier records. */
export function syncNode(addr: string, direction?: "older"): void {
  const a = lc(addr);
  useGraph.getState().guardLive(() => {
    api
      .sync(direction ? { addresses: [a], direction } : { addresses: [a] })
      .then(() => toast(t(direction ? "sync.startedOlder" : "sync.startedAddr", { addr: shortAddr(a) })))
      .catch((err) => toast(messageFor(err), "error"));
  });
}

/**
 * Puts addresses on the address graph alone (spec §5.1, §5.5): those that are not shown centers become ones (one
 * history step; a new center starts picked with none, so no neighbour comes along), and the picker opens for the ones
 * that were not centers before (the picker asks before syncing one that is not synced). An address that already was a
 * center opens nothing (a reload of `#/address/…` on it, say). `activateGraph`: switch to the graph and select the
 * first address. Nothing is synced or refreshed here.
 */
export function introduce(addrs: string[], opts: { activateGraph: boolean }): void {
  const list = [...new Set(addrs.map(lc))];
  const first = list[0];
  if (first === undefined) return;
  if (opts.activateGraph) useTabs.getState().activate("graph");
  // A snapshot graph is refreshed from the chain first (after a confirm); the steps below then run live.
  useGraph.getState().guardLive(() => {
    const before = new Set(useGraph.getState().centers);
    useGraph.getState().revealCenters(list);
    if (opts.activateGraph) useGraph.getState().select({ kind: "node", address: first });
    const fresh = list.filter((a) => !before.has(a));
    if (fresh.length > 0) usePick.getState().open(fresh);
  });
}

/**
 * "Add to graph" everywhere: `addr` is put on the address graph alone and the picker offered for it, without leaving
 * the current tab (`introduce`). A list is one history step and one toast with the count.
 */
export function addToGraph(addr: string | string[]): void {
  const list = typeof addr === "string" ? [addr] : addr;
  useGraph.getState().guardLive(() => {
    introduce(list, { activateGraph: false });
    toast(typeof addr === "string" ? t("tx.added") : t("batch.added", { count: new Set(addr.map(lc)).size }));
  });
}

/**
 * "Pick neighbours…" of a node: the picker for `addr`. A node the canvas (`data`) does not show (or hides) becomes a
 * shown center first, so the picker has it to list for.
 */
export function pickNeighbours(addr: string, data: GraphResponseDto | undefined): void {
  const a = lc(addr);
  useGraph.getState().guardLive(() => {
    const s = useGraph.getState();
    const shown = !s.ui[a]?.hidden && !!data?.nodes.some((n) => lc(n.address) === a);
    if (!shown) s.revealCenter(a);
    usePick.getState().open([a]);
  });
}

export function togglePin(addr: string): void {
  const a = lc(addr);
  const { ui, setPinned } = useGraph.getState();
  setPinned([a], !ui[a]?.pinned);
}

export function hideNode(addr: string): void {
  useGraph.getState().setHidden([addr], true);
}

export function focusNode(addr: string, data: GraphResponseDto | undefined): void {
  const nb = data ? neighborsOf(addr, data.edges) : [];
  useGraph.getState().focusNeighborhood(addr, nb, data?.nodes.map((n) => n.address));
}

/** Copies an address to the clipboard, toasting the outcome. */
export function copyAddress(addr: string): void {
  if (!navigator.clipboard) {
    toast(t("common.copyFailed"), "error");
    return;
  }
  navigator.clipboard
    .writeText(lc(addr))
    .then(() => toast(t("common.copied")))
    .catch(() => toast(t("common.copyFailed"), "error"));
}

export function openInEtherscan(addr: string): void {
  window.open(`https://etherscan.io/address/${lc(addr)}`, "_blank", "noopener");
}
