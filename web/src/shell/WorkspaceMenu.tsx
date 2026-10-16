import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { WorkspaceMetaDto } from "../api/generated/WorkspaceMetaDto";
import { getMainCy } from "../graph/cyRegistry";
import { SCHEMA_VERSION } from "../workspace/serialize";
import {
  captureState,
  deleteWorkspace,
  loadWorkspace,
  newWorkspace,
  overwriteCurrent,
  renameCurrent,
  saveAs,
  saveCurrent,
  saveNew,
  useWorkspace,
} from "../workspace/useWorkspace";
import { toast } from "./Toasts";

type Dialog =
  | { kind: "name"; purpose: "save" | "saveAs" | "rename" }
  | { kind: "confirm"; text: string; confirmLabel: string; onConfirm: () => void }
  | { kind: "conflict" }
  | { kind: "open" };

const MAX_NAME = 100;

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Safe download base name: no path separators/control chars, no leading dots. */
export function safeFileName(name: string | null): string {
  const cleaned = (name ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "");
  return cleaned.trim() === "" ? "未命名" : cleaned;
}

function themeBg(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  return v || "#ffffff";
}

function Modal({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

function NameDialog({ initial, onSubmit, onCancel }: { initial: string; onSubmit(name: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const name = value.trim();
    if (name.length < 1 || name.length > MAX_NAME) {
      setError(`名称需为 1–${MAX_NAME} 个字符`);
      return;
    }
    onSubmit(name);
  };
  return (
    <Modal label="画布名称">
      <h3 className="dialog__title">画布名称</h3>
      <input
        className="wsmenu__input"
        aria-label="画布名称"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      {error && <div className="wsmenu__error" role="alert">{error}</div>}
      <div className="dialog__actions">
        <button className="btn" onClick={onCancel}>取消</button>
        <button className="btn" onClick={submit}>确定</button>
      </div>
    </Modal>
  );
}

function OpenDialog({ onPick, onCancel }: { onPick(id: number): void; onCancel(): void }) {
  const [items, setItems] = useState<WorkspaceMetaDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceMetaDto | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    api
      .workspaces()
      .then((l) => alive.current && setItems(l))
      .catch((e) => alive.current && setError(messageFor(e)));
    return () => {
      alive.current = false;
    };
  }, []);
  const remove = async (w: WorkspaceMetaDto) => {
    setBusy(w.id);
    try {
      await deleteWorkspace(w.id);
      if (alive.current) setItems((cur) => cur?.filter((x) => x.id !== w.id) ?? cur);
    } catch (e) {
      toast(messageFor(e), "error");
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  return (
    <Modal label="打开画布">
      <h3 className="dialog__title">打开画布</h3>
      {error && <div className="wsmenu__error" role="alert">{error}</div>}
      {!items && !error && <div className="dialog__summary">加载中…</div>}
      {items && items.length === 0 && <div className="dialog__summary">还没有保存的画布</div>}
      <ul className="dialog__list">
        {items?.map((w) => (
          <li key={w.id} className="dialog__row">
            <button className="btn dialog__name" onClick={() => onPick(w.id)}>{w.name}</button>
            <span className="dialog__calls">{new Date(w.updated_at).toLocaleString()}</span>
            <button className="btn" aria-label={`删除 ${w.name}`} disabled={busy === w.id} onClick={() => setPendingDelete(w)}>删除</button>
          </li>
        ))}
      </ul>
      <div className="dialog__actions">
        <button className="btn" onClick={onCancel}>关闭</button>
      </div>
      {pendingDelete && (
        <Modal label="确认删除">
          <p>确定删除画布「{pendingDelete.name}」？</p>
          <div className="dialog__actions">
            <button className="btn" onClick={() => setPendingDelete(null)}>取消</button>
            <button
              className="btn"
              onClick={() => {
                const w = pendingDelete;
                setPendingDelete(null);
                void remove(w);
              }}
            >
              删除
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

export function WorkspaceMenu() {
  const { id, name, dirty } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Like the filter popover: an outside press or Escape closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(messageFor(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const confirmDiscard = (verb: string, action: () => void) => {
    if (!useWorkspace.getState().dirty) return action();
    setDialog({
      kind: "confirm",
      text: `当前画布有未保存的修改，确定${verb}？`,
      confirmLabel: "确定",
      onConfirm: action,
    });
  };
  const doSave = () =>
    run(async () => {
      if (useWorkspace.getState().id == null) return setDialog({ kind: "name", purpose: "save" });
      if ((await saveCurrent()) === "conflict") setDialog({ kind: "conflict" });
      else toast("已保存");
    });
  const submitName = (purpose: "save" | "saveAs" | "rename", n: string) => {
    setDialog(null);
    return run(async () => {
      if (purpose === "rename") {
        if ((await renameCurrent(n)) === "conflict") toast("画布已在别处修改，请重新加载后再重命名", "error");
        return;
      }
      await (purpose === "save" ? saveNew : saveAs)(n);
      toast("已保存");
    });
  };
  const onDelete = () => {
    if (id == null) return;
    setDialog({
      kind: "confirm",
      text: `确定删除画布「${name}」？`,
      confirmLabel: "删除",
      onConfirm: () => run(() => deleteWorkspace(id)),
    });
  };
  const exportPng = () => {
    const cy = getMainCy();
    if (!cy) return toast("没有可导出的画布", "error");
    const blob = cy.png({ full: true, scale: 2, bg: themeBg(), output: "blob" });
    download(blob, `ethergraph-${safeFileName(name)}.png`);
  };
  const exportJson = () => {
    const body = JSON.stringify({ name: name ?? "未命名", schema_version: SCHEMA_VERSION, state: captureState() }, null, 2);
    download(new Blob([body], { type: "application/json" }), `ethergraph-${safeFileName(name)}.json`);
  };

  const item = (label: string, fn: () => void, disabled = false) => (
    <button
      className="btn"
      role="menuitem"
      disabled={disabled || busy}
      onClick={() => {
        setOpen(false);
        fn();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="wsmenu" ref={rootRef}>
      <button className="btn" aria-label="画布菜单" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {name ?? "画布"}{dirty ? " *" : ""} ▾
      </button>
      {open && (
        <div className="wsmenu__list" role="menu">
          {item("新建", () => confirmDiscard("新建", newWorkspace))}
          {item("保存", doSave)}
          {item("另存为", () => setDialog({ kind: "name", purpose: "saveAs" }))}
          {item("打开…", () => setDialog({ kind: "open" }))}
          {item("重命名", () => setDialog({ kind: "name", purpose: "rename" }), id == null)}
          {item("删除", onDelete, id == null)}
          {item("导出 PNG", exportPng)}
          {item("导出 JSON", exportJson)}
        </div>
      )}
      {dialog?.kind === "name" && (
        <NameDialog
          initial={dialog.purpose === "rename" ? name ?? "" : dialog.purpose === "saveAs" ? name ?? "" : ""}
          onSubmit={(n) => submitName(dialog.purpose, n)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "confirm" && (
        <Modal label="确认">
          <p>{dialog.text}</p>
          <div className="dialog__actions">
            <button className="btn" onClick={() => setDialog(null)}>取消</button>
            <button
              className="btn"
              onClick={() => {
                const f = dialog.onConfirm;
                setDialog(null);
                f();
              }}
            >
              {dialog.confirmLabel}
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "conflict" && (
        <Modal label="画布已在别处修改">
          <h3 className="dialog__title">画布已在别处修改</h3>
          <p>服务器上的版本比本地更新。重新加载会丢弃本地修改；覆盖保存会替换服务器上的版本。</p>
          <div className="dialog__actions">
            <button className="btn" onClick={() => setDialog(null)}>取消</button>
            <button
              className="btn"
              onClick={() => {
                setDialog(null);
                const cur = useWorkspace.getState().id;
                if (cur != null) void run(async () => void (await loadWorkspace(cur)));
              }}
            >
              重新加载
            </button>
            <button
              className="btn"
              onClick={() => {
                setDialog(null);
                void run(async () => {
                  await overwriteCurrent();
                  toast("已保存");
                });
              }}
            >
              覆盖保存
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "open" && (
        <OpenDialog
          onCancel={() => setDialog(null)}
          onPick={(pick) => {
            setDialog(null);
            confirmDiscard("打开", () => void run(async () => void (await loadWorkspace(pick))));
          }}
        />
      )}
    </div>
  );
}
