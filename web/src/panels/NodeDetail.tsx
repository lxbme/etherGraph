import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import { qk } from "../api/queryClient";
import { useGraph } from "../graph/store";
import { formatTime } from "../lib/format";
import { shortAddr } from "../lib/address";
import { type MsgKey, useT } from "../i18n";
import { toast } from "../shell/Toasts";
import { useTabs } from "../shell/tabs";
import { LabelEditor, categoryName } from "./LabelEditor";
import { useUi } from "./uiStore";

const KINDS: { value: SyncStatusDto["kind"]; label: MsgKey | null }[] = [
  { value: "native", label: "kind.native" },
  { value: "internal", label: "kind.internal" },
  { value: "erc20", label: null },
  { value: "erc721", label: null },
  { value: "erc1155", label: null },
];
const STATE_KEYS: Record<SyncStatusDto["state"], MsgKey> = { syncing: "sync.syncing", ok: "sync.ok", failed: "sync.failed" };
const KIND_KEYS: Record<string, MsgKey> = { eoa: "node.kind.eoa", contract: "node.kind.contract", unknown: "node.kind.unknown" };

function AddrButton({ addr, onNavigate }: { addr: string; onNavigate?: (addr: string) => void }) {
  const addCenter = useGraph((s) => s.addCenter);
  const select = useGraph((s) => s.select);
  return (
    <button
      className="detail__link detail__mono"
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
  const copy = () => {
    if (!navigator.clipboard) return toast(t("common.copyFailed"), "error");
    navigator.clipboard.writeText(address).then(() => toast(t("common.copied"))).catch(() => toast(t("common.copyFailed"), "error"));
  };

  return (
    <div className="detail__section">
      <h3 className="detail__title">{n.display_name ?? shortAddr(address)}</h3>
      <div>
        <span className="detail__mono detail__addr">{address}</span>
        <button onClick={copy}>{t("common.copy")}</button>
      </div>
      <dl className="detail__props">
        <dt>{t("node.type")}</dt><dd>{KIND_KEYS[n.kind] ? t(KIND_KEYS[n.kind]!) : n.kind}</dd>
        {n.ens && (<><dt>ENS</dt><dd>{n.ens}</dd></>)}
        {n.contract_name && (<><dt>{t("node.contractName")}</dt><dd>{n.contract_name}</dd></>)}
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
              <button className="detail__link detail__mono" title={p.creation_tx} onClick={() => openTx(p.creation_tx!)}>
                {shortAddr(p.creation_tx)}
              </button>
            </dd>
          </>
        )}
        {p.first_seen && (<><dt>{t("node.firstSeen")}</dt><dd>{formatTime(p.first_seen)}</dd></>)}
        {p.last_seen && (<><dt>{t("node.lastSeen")}</dt><dd>{formatTime(p.last_seen)}</dd></>)}
      </dl>

      <h4>{t("node.coverage")}</h4>
      <ul className="detail__list">
        {KINDS.map((k) => {
          const c = coverage.get(k.value);
          return (
            <li key={k.value}>
              <span>{k.label ? t(k.label) : k.value.toUpperCase()}</span>
              {c ? (
                <>
                  <span className="detail__mono">
                    {c.from_block === null || c.to_block === null ? "—" : `${c.from_block} – ${c.to_block}`}
                  </span>
                  {c.truncated && <span className="detail__tag">{t("node.truncated")}</span>}
                  <span>{t(STATE_KEYS[c.state])}</span>
                </>
              ) : (
                <span className="detail__muted">{t("node.notSynced")}</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="detail__actions">
        <button onClick={() => sync.mutate(undefined)}>{t("node.syncRefresh")}</button>
        {anyTruncated && <button onClick={() => sync.mutate("older")}>{t("node.fetchOlder")}</button>}
      </div>

      <h4>{t("node.labels")}</h4>
      <ul className="detail__list">
        {n.labels.map((l) => (
          <li key={l.id}>
            <span>{l.text}</span>
            <span className="detail__muted">{categoryName(l.category)}</span>
            {l.source.startsWith("import:") ? (
              <span className="detail__muted">{l.source.slice("import:".length)}</span>
            ) : (
              <button aria-label={t("label.delete")} onClick={() => del.mutate(l.id)}>×</button>
            )}
          </li>
        ))}
      </ul>
      {del.isError && <div className="detail__error" role="alert">{messageFor(del.error)}</div>}
      {editorFor === address ? (
        <LabelEditor address={address} onClose={closeEditor} />
      ) : (
        <button onClick={() => openEditor(address)}>{t("label.addButton")}</button>
      )}

      <Note address={address} />
    </div>
  );
}
