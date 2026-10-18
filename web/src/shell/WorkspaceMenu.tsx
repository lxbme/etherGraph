import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { WorkspaceMetaDto } from "../api/generated/WorkspaceMetaDto";
import { useT } from "../i18n";
import { formatLocalTime, formatTime } from "../lib/format";
import { clearSaveRequest, useSaveRequest } from "../workspace/saveRequest";
import { importBlob } from "../workspace/file";
import { clearImport, requestExport, requestImport, useFileRequest } from "../workspace/fileRequest";
import {
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
  const t = useT();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const name = value.trim();
    if (name.length < 1 || name.length > MAX_NAME) {
      setError(t("ws.nameInvalid", { max: MAX_NAME }));
      return;
    }
    onSubmit(name);
  };
  return (
    <Modal label={t("ws.nameLabel")}>
      <h3 className="dialog__title">{t("ws.nameLabel")}</h3>
      <input
        className="input"
        aria-label={t("ws.nameLabel")}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      {error && <div className="dialog__error" role="alert">{error}</div>}
      <div className="dialog__actions">
        <button className="btn" onClick={onCancel}>{t("common.cancel")}</button>
        <button className="btn btn--primary" onClick={submit}>{t("ws.ok")}</button>
      </div>
    </Modal>
  );
}

function OpenDialog({ onPick, onCancel }: { onPick(id: number): void; onCancel(): void }) {
  const t = useT();
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
    <Modal label={t("ws.openTitle")}>
      <h3 className="dialog__title">{t("ws.openTitle")}</h3>
      {error && <div className="dialog__error" role="alert">{error}</div>}
      {!items && !error && <div className="dialog__summary">{t("common.loading")}</div>}
      {items && items.length === 0 && <div className="dialog__summary">{t("ws.none")}</div>}
      <ul className="dialog__list">
        {items?.map((w) => (
          <li key={w.id} className="dialog__row">
            <button className="btn btn--ghost dialog__name" title={w.name} onClick={() => onPick(w.id)}>{w.name}</button>
            <span className="dialog__calls num" title={formatLocalTime(w.updated_at)}>{formatTime(w.updated_at)}</span>
            <button className="btn btn--compact" aria-label={t("ws.deleteNamed", { name: w.name })} disabled={busy === w.id} onClick={() => setPendingDelete(w)}>{t("ws.delete")}</button>
          </li>
        ))}
      </ul>
      <div className="dialog__actions">
        <button className="btn" onClick={onCancel}>{t("ws.close")}</button>
      </div>
      {pendingDelete && (
        <Modal label={t("ws.confirmDelete")}>
          <p>{t("ws.confirmDeleteText", { name: pendingDelete.name })}</p>
          <div className="dialog__actions">
            <button className="btn" onClick={() => setPendingDelete(null)}>{t("common.cancel")}</button>
            <button
              className="btn btn--primary"
              onClick={() => {
                const w = pendingDelete;
                setPendingDelete(null);
                void remove(w);
              }}
            >
              {t("ws.delete")}
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

export function WorkspaceMenu() {
  const t = useT();
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
  const confirmDiscard = (text: string, action: () => void) => {
    if (!useWorkspace.getState().dirty) return action();
    setDialog({
      kind: "confirm",
      text,
      confirmLabel: t("ws.ok"),
      onConfirm: action,
    });
  };
  const doSave = () =>
    run(async () => {
      if (useWorkspace.getState().id == null) return setDialog({ kind: "name", purpose: "save" });
      if ((await saveCurrent()) === "conflict") setDialog({ kind: "conflict" });
      else toast(t("ws.status.saved"));
    });
  // A save / save-as shortcut (see saveRequest) does exactly what the menu item does.
  const saveRequest = useSaveRequest((s) => s.pending);
  useEffect(() => {
    if (!saveRequest) return;
    clearSaveRequest();
    if (busy) return;
    if (saveRequest.kind === "save") void doSave();
    else setDialog({ kind: "name", purpose: "saveAs" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- acts once per request
  }, [saveRequest]);
  const submitName = (purpose: "save" | "saveAs" | "rename", n: string) => {
    setDialog(null);
    return run(async () => {
      if (purpose === "rename") {
        if ((await renameCurrent(n)) === "conflict") toast(t("ws.renameConflict"), "error");
        return;
      }
      await (purpose === "save" ? saveNew : saveAs)(n);
      toast(t("ws.status.saved"));
    });
  };
  const onDelete = () => {
    if (id == null) return;
    setDialog({
      kind: "confirm",
      text: t("ws.confirmDeleteText", { name: name ?? "" }),
      confirmLabel: t("ws.delete"),
      onConfirm: () => run(() => deleteWorkspace(id)),
    });
  };
  // An imported file (picked here or dropped on the window): a graph or workspace file replaces the workspace,
  // so it goes through the same unsaved-changes confirm as opening one.
  const fileInput = useRef<HTMLInputElement>(null);
  const importRequest = useFileRequest((s) => s.importing);
  useEffect(() => {
    if (!importRequest) return;
    clearImport();
    void importBlob(importRequest.file, (apply) => confirmDiscard(t("ws.discardImport"), apply));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- acts once per request
  }, [importRequest]);

  const item = (label: string, fn: () => void, disabled = false) => (
    <button
      className="menu__item"
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
    <div className="dropdown" ref={rootRef}>
      <button className="btn wsmenu__trigger" aria-label={t("ws.menu")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="wsmenu__name" title={name ?? undefined}>{name ?? t("topbar.workspace")}{dirty ? " *" : ""}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu dropdown__panel" role="menu">
          {item(t("ws.new"), () => confirmDiscard(t("ws.discardNew"), newWorkspace))}
          {item(t("ws.save"), doSave)}
          {item(t("ws.saveAs"), () => setDialog({ kind: "name", purpose: "saveAs" }))}
          {item(t("ws.open"), () => setDialog({ kind: "open" }))}
          {item(t("ws.rename"), () => setDialog({ kind: "name", purpose: "rename" }), id == null)}
          {item(t("ws.delete"), onDelete, id == null)}
          {item(t("ws.exportFile"), () => requestExport("workspace"))}
          {item(t("ws.importFile"), () => fileInput.current?.click())}
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        data-testid="import-file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the same file again is a change too.
          e.target.value = "";
          if (file) requestImport(file);
        }}
      />
      {dialog?.kind === "name" && (
        <NameDialog
          initial={dialog.purpose === "rename" ? name ?? "" : dialog.purpose === "saveAs" ? name ?? "" : ""}
          onSubmit={(n) => submitName(dialog.purpose, n)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "confirm" && (
        <Modal label={t("ws.confirm")}>
          <p>{dialog.text}</p>
          <div className="dialog__actions">
            <button className="btn" onClick={() => setDialog(null)}>{t("common.cancel")}</button>
            <button
              className="btn btn--primary"
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
        <Modal label={t("ws.conflictTitle")}>
          <h3 className="dialog__title">{t("ws.conflictTitle")}</h3>
          <p>{t("ws.conflictBody")}</p>
          <div className="dialog__actions">
            <button className="btn" onClick={() => setDialog(null)}>{t("common.cancel")}</button>
            <button
              className="btn"
              onClick={() => {
                setDialog(null);
                const cur = useWorkspace.getState().id;
                if (cur != null) void run(async () => void (await loadWorkspace(cur)));
              }}
            >
              {t("ws.reload")}
            </button>
            <button
              className="btn btn--primary"
              onClick={() => {
                setDialog(null);
                void run(async () => {
                  await overwriteCurrent();
                  toast(t("ws.status.saved"));
                });
              }}
            >
              {t("ws.overwrite")}
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "open" && (
        <OpenDialog
          onCancel={() => setDialog(null)}
          onPick={(pick) => {
            setDialog(null);
            confirmDiscard(t("ws.discardOpen"), () => void run(async () => void (await loadWorkspace(pick))));
          }}
        />
      )}
    </div>
  );
}
