import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { t } from "../i18n";
import { newBatchId } from "../lib/batchId";
import { toast } from "../shell/Toasts";

/** The API takes at most this many addresses per request. */
export const IDENTIFY_CHUNK = 500;

/** A node whose type/name was never looked up; wallets (already known to be wallets) need nothing. */
export function needsIdentify(n: NodeSummaryDto): boolean {
  return !n.identified && n.kind !== "eoa";
}

/** The addresses among `nodes` that need identification (lowercase, deduped). */
export function identifiable(nodes: readonly NodeSummaryDto[]): string[] {
  return [...new Set(nodes.filter(needsIdentify).map((n) => n.address.toLowerCase()))];
}

/**
 * Queues identification of `addrs` (deduped by lowercase) in chunks of at most 500 sharing one batch id,
 * then toasts the summed queued count (or that nothing needed it).
 */
export async function identifyAddresses(addrs: string[]): Promise<void> {
  const unique = [...new Set(addrs.map((a) => a.toLowerCase()))];
  if (unique.length === 0) return;
  const batch = newBatchId();
  try {
    let queued = 0;
    for (let i = 0; i < unique.length; i += IDENTIFY_CHUNK) {
      const r = await api.identify({ addresses: unique.slice(i, i + IDENTIFY_CHUNK), batch });
      queued += r.queued;
    }
    toast(queued > 0 ? t("identify.queued", { count: queued }) : t("identify.none"));
  } catch (err) {
    toast(messageFor(err), "error");
  }
}
