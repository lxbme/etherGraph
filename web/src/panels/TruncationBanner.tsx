import { useMutation } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { transferKindName } from "../lib/transferKinds";
import { toast } from "../shell/Toasts";

/**
 * The strip shown where an address's transfers are read (side panel, transfer table, pick dialog) when a shallow
 * sync stopped short: per truncated kind how far back it reaches, and a button that fetches the older records.
 * Renders nothing when no row of `coverage` is truncated. `forGraph`: the sync first asks to leave a snapshot.
 */
export function TruncationBanner({
  address,
  coverage,
  forGraph = false,
}: {
  address: string;
  coverage: SyncStatusDto[];
  forGraph?: boolean;
}) {
  const t = useT();
  const sync = useMutation({
    mutationFn: () => api.sync({ addresses: [address], direction: "older" }),
    onError: (e) => toast(messageFor(e), "error"),
  });
  const truncated = coverage.filter((c) => c.truncated);
  if (truncated.length === 0) return null;

  const kinds = truncated.map((c) => {
    const kind = transferKindName(c.kind, t);
    const ms = c.oldest_ts === null ? NaN : Date.parse(c.oldest_ts);
    // Without a usable time, say where the sync stopped instead.
    return Number.isNaN(ms)
      ? t("trunc.kindBlock", { kind, block: c.from_block === null ? "—" : String(c.from_block) })
      : t("trunc.kindDate", { kind, date: new Date(ms).toISOString().slice(0, 10) });
  });
  const busy = sync.isPending || coverage.some((c) => c.state === "syncing");
  const run = () => {
    if (forGraph) useGraph.getState().guardLive(() => sync.mutate());
    else sync.mutate();
  };

  return (
    <div className="trunc-banner" role="status">
      <span>{`${kinds.join(t("trunc.kindSep"))} · ${t("trunc.missing")}`}</span>
      <button type="button" className="btn btn--compact" disabled={busy} onClick={run}>
        {busy ? t("trunc.filling") : t("trunc.fill")}
      </button>
    </div>
  );
}
