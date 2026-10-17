import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { t } from "../i18n";
import { shortAddr } from "../lib/address";
import { toast } from "../shell/Toasts";
import { neighborsOf } from "./neighbors";
import { useGraph } from "./store";

const lc = (s: string) => s.toLowerCase();

/** Sync (or refresh) one address; `direction: "older"` pulls earlier records. */
export function syncNode(addr: string, direction?: "older"): void {
  const a = lc(addr);
  api
    .sync(direction ? { addresses: [a], direction } : { addresses: [a] })
    .then(() => toast(t(direction ? "sync.startedOlder" : "sync.startedAddr", { addr: shortAddr(a) })))
    .catch((err) => toast(messageFor(err), "error"));
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
