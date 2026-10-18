import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import { qk } from "../api/queryClient";
import { neighborsOf } from "../graph/neighbors";
import { useGraph } from "../graph/store";
import { useGraphData } from "../graph/useGraphData";
import { formatFixed } from "../lib/amount";
import { formatCount, formatLocalTime, formatTime } from "../lib/format";
import { shortAddr } from "../lib/address";
import { TRANSFER_KINDS, transferKindName } from "../lib/transferKinds";
import { type MsgKey, useT } from "../i18n";
import { CopyButton } from "../shell/CopyButton";
import { toast } from "../shell/Toasts";
import { useTabs } from "../shell/tabs";
import { HUED_CATEGORIES, LabelEditor, categoryName, labelProvenance } from "./LabelEditor";
import { useUi } from "./uiStore";

const KINDS = TRANSFER_KINDS;
const STATE_KEYS: Record<SyncStatusDto["state"], MsgKey> = { syncing: "sync.syncing", ok: "sync.ok", failed: "sync.failed" };
const KIND_KEYS: Record<string, MsgKey> = { eoa: "node.kind.eoa", contract: "node.kind.contract", unknown: "node.kind.unknown" };

/** Transfer count and distinct counterparties over the canvas edges touching `address`; null when none do. */
function canvasStats(address: string, edges: EdgeDto[]): { transfers: number; neighbours: number } | null {
  const a = address.toLowerCase();
  let transfers = 0;
  let touched = false;
  for (const e of edges) {
    if (e.from.toLowerCase() !== a && e.to.toLowerCase() !== a) continue;
    touched = true;
    transfers += e.count;
  }
  return touched ? { transfers, neighbours: neighborsOf(a, edges).length } : null;
}

function Time({ iso }: { iso: string }) {
  return <span className="num" title={formatLocalTime(iso)}>{formatTime(iso)}</span>;
}

function AddrButton({ addr, onNavigate }: { addr: string; onNavigate?: (addr: string) => void }) {
  const addCenter = useGraph((s) => s.addCenter);
  const select = useGraph((s) => s.select);
  return (
    <button
      className="detail__link num"
      title={addr}
      onClick={() => {
        if (onNavigate) return onNavigate(addr.toLowerCase());
        addCenter(addr);
        select({ kind: "node", address: addr.toLowerCase() });
      }}
    >
      {shortAddr(addr)}
    </button>
  );
}

function Note({ address }: { address: string }) {
  const stored = useGraph((s) => s.ui[address]?.note ?? "");
  const setNote = useGraph((s) => s.setNote);
  const [draft, setDraft] = useState(stored);
  const t = useT();
  useEffect(() => setDraft(stored), [stored]);
  return (
    <label className="detail__note">
      {t("node.note")}
      <textarea
        className="input detail__textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== stored) setNote(address, draft);
        }}
      />
    </label>
  );
}

export function NodeDetail({ address, onNavigate }: { address: string; onNavigate?: (addr: string) => void }) {
  const qc = useQueryClient();
  const openTx = useTabs((s) => s.openTx);
  const t = useT();
  const editorFor = useUi((u) => u.labelEditorFor);
  const closeEditor = useUi((u) => u.closeLabelEditor);
  const openEditor = useUi((u) => u.openLabelEditor);
  const { data: graph } = useGraphData();
  const q = useQuery({ queryKey: qk.address(address), queryFn: () => api.address(address) });

  const sync = useMutation({
    mutationFn: (direction?: "older") => api.sync(direction ? { addresses: [address], direction } : { addresses: [address] }),
    onSuccess: () => toast(t("node.syncStarted")),
    onError: (e) => toast(messageFor(e), "error"),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteLabel(id),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.address(address) }),
        qc.invalidateQueries({ queryKey: ["graph"] }),
      ]),
  });

  if (q.isPending) return <div className="placeholder">{t("common.loading")}</div>;
  if (q.isError) return <div className="placeholder detail__error" role="alert">{messageFor(q.error)}</div>;
  const p = q.data;
  const n = p.node;
  const coverage = new Map(p.coverage.map((c) => [c.kind, c]));
  const anyTruncated = p.coverage.some((c) => c.truncated);
  const covered = KINDS.filter((k) => coverage.get(k.value)?.to_block != null).length;
  const stats = canvasStats(address, graph?.edges ?? []);
  const balance = n.balance != null ? formatFixed(n.balance, 18, "eth") : null;
  const categories = [...new Set(n.labels.map((l) => l.category))];
  const syncKey: MsgKey = n.syncing ? "sync.syncing" : n.synced ? "sync.ok" : "node.notSynced";

  return (
    <div className="detail__section">
      {/* 1. Kind */}
      <div className="overline">{KIND_KEYS[n.kind] ? t(KIND_KEYS[n.kind]!) : n.kind}</div>
      {n.display_name && <h3 className="detail__title">{n.display_name}</h3>}

      {/* 2. Address */}
      <div className="detail__addr">
        <span className="num">{address}</span>
        <CopyButton value={address} />
      </div>

      {/* 3. Tags: categories, sync state, labels */}
      <div className="detail__tags" data-testid="node-tags">
        {categories.map((c) => (
          <span key={`cat:${c}`} className={`tag tag--${HUED_CATEGORIES.includes(c) ? c : "neutral"}`}>{categoryName(c)}</span>
        ))}
        <span className="tag tag--neutral">{t(syncKey)}</span>
        {n.partial && <span className="tag tag--warn">{t("node.truncated")}</span>}
        {n.labels.map((l) => {
          const provenance = labelProvenance(l.source);
          const imported = provenance !== null;
          return (
            <span
              key={l.id}
              className="tag"
              title={imported ? `${categoryName(l.category)} · ${provenance}` : categoryName(l.category)}
            >
              {l.text}
              {!imported && (
                <button type="button" className="tag__remove" aria-label={t("label.delete")} onClick={() => del.mutate(l.id)}>
                  <X size={12} />
                </button>
              )}
            </span>
          );
        })}
        {editorFor !== address && (
          <button type="button" className="btn btn--ghost btn--compact" onClick={() => openEditor(address)}>
            <Plus size={14} />
            {t("label.addButton")}
          </button>
        )}
      </div>
      {del.isError && <div className="detail__error" role="alert">{messageFor(del.error)}</div>}
      {editorFor === address && <LabelEditor address={address} onClose={closeEditor} />}

      {/* 4. Balance: only once probed. */}
      {balance && (
        <div className="detail__balance num" data-testid="node-balance" title={`${balance.full} ETH`}>
          {balance.text} ETH
        </div>
      )}

      {/* 5. Key/value grid */}
      <dl className="kv" data-testid="node-kv">
        {n.nonce != null ? (
          <>
            <dt>{t("node.transactionsSent")}</dt>
            <dd className="num">{formatCount(n.nonce)}</dd>
          </>
        ) : (
          <>
            <dt>{t("node.transactions")}</dt>
            <dd className="num" title={t("node.canvasCount")}>{stats ? formatCount(stats.transfers) : "—"}</dd>
          </>
        )}
        <dt>{t("node.firstSeen")}</dt>
        <dd>{p.first_seen ? <Time iso={p.first_seen} /> : "—"}</dd>
        <dt>{t("node.lastSeen")}</dt>
        <dd>{p.last_seen ? <Time iso={p.last_seen} /> : "—"}</dd>
        <dt>{t("node.neighbours")}</dt>
        <dd className="num" title={t("node.canvasCount")}>{stats ? formatCount(stats.neighbours) : "—"}</dd>
        <dt>{t("node.coverageShort")}</dt>
        <dd className="num">{`${covered} / ${KINDS.length}`}</dd>
        {n.ens && (<><dt>ENS</dt><dd title={n.ens}>{n.ens}</dd></>)}
        {n.contract_name && (<><dt>{t("node.contractName")}</dt><dd title={n.contract_name}>{n.contract_name}</dd></>)}
        {p.is_proxy && (
          <>
            <dt>{t("node.proxy")}</dt>
            <dd>{p.implementation ? <AddrButton addr={p.implementation} onNavigate={onNavigate} /> : t("common.yes")}</dd>
          </>
        )}
        {p.creator && (<><dt>{t("node.deployer")}</dt><dd><AddrButton addr={p.creator} onNavigate={onNavigate} /></dd></>)}
        {p.creation_tx && (
          <>
            <dt>{t("node.deployTx")}</dt>
            <dd>
              <button className="detail__link num" title={p.creation_tx} onClick={() => openTx(p.creation_tx!)}>
                {shortAddr(p.creation_tx)}
              </button>
            </dd>
          </>
        )}
      </dl>

      {/* 6. Primary action */}
      <div className="detail__actions">
        <button className="btn btn--primary" onClick={() => sync.mutate(undefined)}>{t("node.syncRefresh")}</button>
        {anyTruncated && <button className="btn" onClick={() => sync.mutate("older")}>{t("node.fetchOlder")}</button>}
      </div>

      <h4 className="overline">{t("node.coverage")}</h4>
      <ul className="detail__list">
        {KINDS.map((k) => {
          const c = coverage.get(k.value);
          return (
            <li key={k.value}>
              <span>{transferKindName(k.value, t)}</span>
              {c ? (
                <>
                  <span className="detail__state">
                    {c.truncated && <span className="tag tag--warn">{t("node.truncated")}</span>}
                    {t(STATE_KEYS[c.state])}
                  </span>
                  <span className="num detail__range">
                    {c.from_block === null || c.to_block === null ? "—" : `${c.from_block} – ${c.to_block}`}
                  </span>
                </>
              ) : (
                <span className="detail__state detail__muted">{t("node.notSynced")}</span>
              )}
            </li>
          );
        })}
      </ul>

      <Note address={address} />
    </div>
  );
}
