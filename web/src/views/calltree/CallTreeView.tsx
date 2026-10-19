import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ScanSearch } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import type { CallFrameDto } from "../../api/generated/CallFrameDto";
import type { CallTraceResponseDto } from "../../api/generated/CallTraceResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { qk } from "../../api/queryClient";
import { identifyAddresses, useIdentifying } from "../../graph/identify";
import { useT } from "../../i18n";
import { shortAddr } from "../../lib/address";
import { useJobProgress } from "../../shell/statusStore";
import { useTxSnapshot } from "../../shell/tabs";
import { overlayIdentity, useLiveIdentities } from "../../workspace/snapshot";
import type { FlowNodes } from "../txdetail/common";
import { CallFrameDetail } from "./CallFrameDetail";
import { CallGraph } from "./CallGraph";
import { CallTreeList } from "./CallTreeList";
import { buildCallGraph, defaultCollapsed, edgeOfFrame, frameId, nextFrameOfEdge, treeRows, type TreeFilter } from "./model";

/** Rows down to this depth start expanded (the root is depth 0). */
const DEFAULT_DEPTH = 3;
/** Identifying a contract takes about this many upstream requests (ABI and name). */
const CALLS_PER_CONTRACT = 2;

const lc = (s: string) => s.toLowerCase();

/** An address the server has not described (yet): drawn with its short form until its summary arrives. */
const bareNode = (address: string): NodeSummaryDto => ({
  address, kind: "unknown", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: false, hot: false, identified: false, nonce: null, balance: null,
});

/** Ids of the frames above `id`, root first. */
function ancestorsOf(id: string): string[] {
  const path = id === "root" ? [] : id.split(".").map(Number);
  return path.map((_, n) => frameId(path.slice(0, n)));
}

/**
 * A transaction's call tree, in place of its asset-flow graph. A tab showing a file never requests the trace;
 * otherwise the trace is requested only once this view is shown (the server starts a fetch job and bills it).
 */
export function CallTreeView({ hash }: { hash: string }) {
  const snapshot = useTxSnapshot(hash);
  const t = useT();
  if (snapshot) return <div className="placeholder calltree__state">{t("tx.calls.notInFile")}</div>;
  return <LiveCallTree hash={hash} />;
}

/**
 * The trace from the server: progress of its fetch job, its failure with Retry, then the tree. Every request while
 * nothing is cached starts (and bills) a new fetch job, so once the watched job has failed nothing requests again
 * (no polling, no SSE invalidation) until the user presses Retry.
 */
function LiveCallTree({ hash }: { hash: string }) {
  const t = useT();
  const watched = useQueryClient().getQueryData<CallTraceResponseDto>(qk.txTrace(hash))?.job_id ?? null;
  const failed = useJobProgress((s) => watched !== null && s.byId[watched]?.status === "failed");
  const q = useQuery({
    queryKey: qk.txTrace(hash),
    queryFn: () => api.txTrace(hash),
    enabled: !failed,
    // Fresh until invalidated (TraceReady, MetaUpdated), so re-enabling after a Retry does not request twice.
    staleTime: Infinity,
    // Safety net behind the TraceReady SSE invalidation.
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 5000 : false),
  });
  const jobId = q.data?.job_id ?? null;
  const job = useJobProgress((s) => (jobId === null ? undefined : s.byId[jobId]));

  if (q.data?.status === "ready" && q.data.frames) {
    return <CallTreePanel hash={hash} frames={q.data.frames} undecoded={q.data.undecoded} />;
  }
  const retry = (
    <button
      type="button"
      className="btn btn--compact"
      onClick={() => {
        // The only request after a failure; the failed job is forgotten once its successor is known.
        void q.refetch().finally(() => {
          if (job) useJobProgress.getState().remove([job.job_id]);
        });
      }}
    >
      {t("common.retry")}
    </button>
  );
  if (q.isError) {
    return (
      <div className="placeholder calltree__state" role="alert">
        {messageFor(q.error)} {retry}
      </div>
    );
  }
  if (job?.status === "failed") {
    return (
      <div className="placeholder calltree__state" role="alert">
        {t("tx.calls.failed", { reason: job.error ?? t("events.unknownReason") })} {retry}
      </div>
    );
  }
  let text = t("tx.calls.loading");
  if (job?.status === "pending") text = t("tx.calls.queued");
  else if (job?.status === "paused_quota") text = t("tx.calls.sourceQuota");
  else if (job?.status === "paused_user_quota") text = t("job.status.paused_user_quota");
  return <div className="placeholder calltree__state">{text}</div>;
}

/**
 * The call graph beside the indented tree, both under one filter. Selecting a row highlights its edge and both
 * ends; tapping an edge selects its next call in the tree (unfolding and scrolling to it). `fileNodes` are a
 * snapshot's node identities, laid under the receiver's live ones.
 */
export function CallTreePanel({
  hash,
  frames,
  undecoded,
  fileNodes,
}: {
  hash: string;
  frames: CallFrameDto[];
  undecoded: string[];
  fileNodes?: NodeSummaryDto[];
}) {
  const t = useT();
  const [filter, setFilter] = useState<TreeFilter>({ showStatic: false, failedOnly: false });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => defaultCollapsed(frames, DEFAULT_DEPTH));
  const [selected, setSelected] = useState<string | null>(null);
  /** Bumped to scroll the selected row into view. */
  const [reveal, setReveal] = useState(0);
  const identifying = useIdentifying((s) => s.running);

  const rows = useMemo(() => treeRows(frames, filter, collapsed), [frames, filter, collapsed]);
  const graph = useMemo(() => buildCallGraph(frames, filter), [frames, filter]);
  const frameById = useMemo(() => new Map(frames.map((f) => [frameId(f.path), f])), [frames]);
  // Every party of the trace at once, so changing the filter asks for nothing new.
  const parties = useMemo(
    () => [...new Set(frames.flatMap((f) => (f.to ? [f.from, f.to] : [f.from])).map(lc))],
    [frames],
  );
  const live = useLiveIdentities(parties);
  const byAddr = useMemo(() => {
    const m = new Map<string, NodeSummaryDto>();
    for (const n of fileNodes ?? []) m.set(lc(n.address), overlayIdentity(n, live.get(lc(n.address))));
    for (const [a, n] of live) if (!m.has(a)) m.set(a, n);
    return m;
  }, [fileNodes, live]);
  const graphNodes = useMemo(() => graph.nodes.map((a) => byAddr.get(a) ?? bareNode(a)), [graph.nodes, byAddr]);
  const flowNodes = useMemo<FlowNodes>(() => ({ tx: { hash }, nodes: [...byAddr.values()] }), [hash, byAddr]);
  const nameOf = useCallback(
    (a: string) => {
      const n = byAddr.get(lc(a));
      return n?.display_name ?? n?.contract_name ?? shortAddr(lc(a));
    },
    [byAddr],
  );
  const highlightedEdge = useMemo(() => (selected ? edgeOfFrame(graph.edges, selected) : null), [graph.edges, selected]);

  const select = useCallback((id: string, scroll?: boolean) => {
    setSelected(id);
    if (scroll) setReveal((n) => n + 1);
  }, []);
  const toggle = useCallback((id: string) => {
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const onTapEdge = (id: string) => {
    const edge = graph.edges.find((e) => e.id === id);
    if (!edge) return;
    const next = nextFrameOfEdge(edge, selected);
    const folded = ancestorsOf(next).filter((a) => collapsed.has(a));
    if (folded.length > 0) {
      setCollapsed((c) => {
        const open = new Set(c);
        for (const a of folded) open.delete(a);
        return open;
      });
    }
    select(next, true);
  };
  const chip = (key: keyof TreeFilter, label: string) => (
    <label className={`chip chip--toggle${filter[key] ? " chip--active" : ""}`}>
      <input type="checkbox" checked={filter[key]} onChange={() => setFilter((f) => ({ ...f, [key]: !f[key] }))} />
      {label}
    </label>
  );
  const frame = selected ? frameById.get(selected) : undefined;

  return (
    <div className="calltree" data-testid="call-tree">
      <div className="calltree__bar">
        <div className="calltree__filters" role="group" aria-label={t("tx.calls.filters")}>
          {chip("showStatic", t("tx.calls.showStatic"))}
          {chip("failedOnly", t("tx.calls.failedOnly"))}
        </div>
        {undecoded.length > 0 && (
          <button
            type="button"
            className="btn btn--compact"
            title={t("tx.calls.decodeRestHint")}
            disabled={identifying}
            onClick={() => void identifyAddresses(undecoded)}
          >
            <ScanSearch size={14} />
            {t("tx.calls.decodeRest", { count: undecoded.length, calls: undecoded.length * CALLS_PER_CONTRACT })}
          </button>
        )}
      </div>
      <div className="calltree__body">
        <CallGraph hash={hash} nodes={graphNodes} edges={graph.edges} highlightedEdge={highlightedEdge} onTapEdge={onTapEdge} />
        <div className="calltree__side">
          <CallTreeList
            rows={rows}
            collapsed={collapsed}
            selected={selected}
            reveal={reveal}
            nameOf={nameOf}
            onSelect={select}
            onToggle={toggle}
          />
          {frame ? (
            <CallFrameDetail key={selected} frame={frame} flow={flowNodes} />
          ) : (
            <div className="calltree__hint">{t("tx.calls.selectRow")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
