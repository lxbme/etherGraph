import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { qk, queryClient } from "../api/queryClient";
import { t } from "../i18n";
import { shortAddr } from "../lib/address";
import { toast } from "../shell/Toasts";
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
 * The request sent when an address becomes a center: its profile, syncing it when it has never been synced.
 * The profile seeds the detail panel's cache.
 */
export function syncCenter(addr: string): void {
  const a = lc(addr);
  api
    .address(a, { sync: "auto" })
    .then((p) => queryClient.setQueryData(qk.address(a), p))
    .catch((e) => toast(messageFor(e), "error"));
}

/**
 * "Add to graph" everywhere: `addr` becomes a shown center of the address graph (unhidden if it was hidden).
 * A list is one history step and one toast with the count.
 */
export function addToGraph(addr: string | string[]): void {
  useGraph.getState().guardLive(() => {
    if (typeof addr === "string") {
      useGraph.getState().revealCenter(addr);
      toast(t("tx.added"));
      return;
    }
    useGraph.getState().revealCenters(addr);
    toast(t("batch.added", { count: new Set(addr.map(lc)).size }));
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
