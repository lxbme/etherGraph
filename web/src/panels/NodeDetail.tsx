import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import { qk } from "../api/queryClient";
import { useGraph } from "../graph/store";
import { formatTime } from "../lib/format";
import { shortAddr } from "../lib/address";
import { toast } from "../shell/Toasts";
import { useTabs } from "../shell/tabs";
import { LabelEditor, categoryName } from "./LabelEditor";
import { useUi } from "./uiStore";

const KINDS: { value: SyncStatusDto["kind"]; label: string }[] = [
  { value: "native", label: "普通转账" },
  { value: "internal", label: "内部交易" },
  { value: "erc20", label: "ERC20" },
  { value: "erc721", label: "ERC721" },
  { value: "erc1155", label: "ERC1155" },
];
const STATES: Record<SyncStatusDto["state"], string> = { syncing: "同步中", ok: "已同步", failed: "失败" };
const KIND_NAMES: Record<string, string> = { eoa: "外部账户", contract: "合约", unknown: "未知" };

function AddrButton({ addr }: { addr: string }) {
  const addCenter = useGraph((s) => s.addCenter);
  const select = useGraph((s) => s.select);
  return (
    <button
      className="detail__link detail__mono"
      title={addr}
      onClick={() => {
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
  useEffect(() => setDraft(stored), [stored]);
  return (
    <label className="detail__note">
      备注
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

export function NodeDetail({ address }: { address: string }) {
  const qc = useQueryClient();
  const openTx = useTabs((t) => t.openTx);
  const editorFor = useUi((u) => u.labelEditorFor);
  const closeEditor = useUi((u) => u.closeLabelEditor);
  const openEditor = useUi((u) => u.openLabelEditor);
  const q = useQuery({ queryKey: qk.address(address), queryFn: () => api.address(address) });

  const sync = useMutation({
    mutationFn: (direction?: "older") => api.sync(direction ? { addresses: [address], direction } : { addresses: [address] }),
    onSuccess: () => toast("已开始同步"),
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

  if (q.isPending) return <div className="placeholder">加载中…</div>;
  if (q.isError) return <div className="placeholder detail__error" role="alert">{messageFor(q.error)}</div>;
  const p = q.data;
  const n = p.node;
  const coverage = new Map(p.coverage.map((c) => [c.kind, c]));
  const anyTruncated = p.coverage.some((c) => c.truncated);
  const copy = () => {
    if (!navigator.clipboard) return toast("复制失败", "error");
    navigator.clipboard.writeText(address).then(() => toast("已复制")).catch(() => toast("复制失败", "error"));
  };

  return (
    <div className="detail__section">
      <h3 className="detail__title">{n.display_name ?? shortAddr(address)}</h3>
      <div>
        <span className="detail__mono detail__addr">{address}</span>
        <button onClick={copy}>复制</button>
      </div>
      <dl className="detail__props">
        <dt>类型</dt><dd>{KIND_NAMES[n.kind] ?? n.kind}</dd>
        {n.ens && (<><dt>ENS</dt><dd>{n.ens}</dd></>)}
        {n.contract_name && (<><dt>合约名</dt><dd>{n.contract_name}</dd></>)}
        {p.is_proxy && (
          <>
            <dt>代理</dt>
            <dd>{p.implementation ? <AddrButton addr={p.implementation} /> : "是"}</dd>
          </>
        )}
        {p.creator && (<><dt>部署者</dt><dd><AddrButton addr={p.creator} /></dd></>)}
        {p.creation_tx && (
          <>
            <dt>部署交易</dt>
            <dd>
              <button className="detail__link detail__mono" title={p.creation_tx} onClick={() => openTx(p.creation_tx!)}>
                {shortAddr(p.creation_tx)}
              </button>
            </dd>
          </>
        )}
        {p.first_seen && (<><dt>首次活跃</dt><dd>{formatTime(p.first_seen)}</dd></>)}
        {p.last_seen && (<><dt>最后活跃</dt><dd>{formatTime(p.last_seen)}</dd></>)}
      </dl>

      <h4>同步覆盖</h4>
      <ul className="detail__list">
        {KINDS.map((k) => {
          const c = coverage.get(k.value);
          return (
            <li key={k.value}>
              <span>{k.label}</span>
              {c ? (
                <>
                  <span className="detail__mono">
                    {c.from_block === null || c.to_block === null ? "—" : `${c.from_block} – ${c.to_block}`}
                  </span>
                  {c.truncated && <span className="detail__tag">已截断</span>}
                  <span>{STATES[c.state]}</span>
                </>
              ) : (
                <span className="detail__muted">未同步</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="detail__actions">
        <button onClick={() => sync.mutate(undefined)}>同步/刷新</button>
        {anyTruncated && <button onClick={() => sync.mutate("older")}>拉更早记录</button>}
      </div>

      <h4>标签</h4>
      <ul className="detail__list">
        {n.labels.map((l) => (
          <li key={l.id}>
            <span>{l.text}</span>
            <span className="detail__muted">{categoryName(l.category)}</span>
            {l.source.startsWith("import:") ? (
              <span className="detail__muted">{l.source.slice("import:".length)}</span>
            ) : (
              <button aria-label="删除标签" onClick={() => del.mutate(l.id)}>×</button>
            )}
          </li>
        ))}
      </ul>
      {del.isError && <div className="detail__error" role="alert">{messageFor(del.error)}</div>}
      {editorFor === address ? (
        <LabelEditor address={address} onClose={closeEditor} />
      ) : (
        <button onClick={() => openEditor(address)}>添加标签</button>
      )}

      <Note address={address} />
    </div>
  );
}
