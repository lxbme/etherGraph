import { useEffect } from "react";
import { useBoxSelection } from "../graph/boxSelection";
import { useGraph } from "../graph/store";
import { t, useT } from "../i18n";
import { toast } from "../shell/Toasts";
import { LabelEditor } from "./LabelEditor";
import { useUi } from "./uiStore";

export interface BatchAction {
  id: string;
  label: string;
  onClick(): void;
}

/** Copies the addresses, one per line; toasts the count (or the failure). */
export function copyAddresses(ids: string[]): Promise<void> {
  const fail = () => {
    toast(t("common.copyFailed"), "error");
  };
  if (!navigator.clipboard) {
    fail();
    return Promise.resolve();
  }
  return navigator.clipboard.writeText(ids.join("\n")).then(() => {
    toast(t("batch.copied", { count: ids.length }));
  }, fail);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The batch bar both canvases share: the count, the view's `actions`, then Add label, Copy addresses and
 * Cancel. Shown for one or more selected nodes. The batch label editor opens above it.
 */
export function BatchBarShell({
  ids,
  actions,
  onCancel,
  insetLeft = 0,
}: {
  ids: string[];
  actions: BatchAction[];
  onCancel(): void;
  /** Canvas width covered from the left (the expanded legend): the bar centres in the rest. */
  insetLeft?: number;
}) {
  const tr = useT();
  const editorFor = useUi((s) => s.labelEditorFor);
  const closeEditor = useUi((s) => s.closeLabelEditor);
  // A batch label request belongs to this selection: it goes when the selection changes or clears.
  const key = ids.join("\n");
  useEffect(
    () => () => {
      const req = useUi.getState().labelEditorFor;
      if (key !== "" && Array.isArray(req) && sameSet(req, key.split("\n"))) useUi.getState().closeLabelEditor();
    },
    [key],
  );
  if (ids.length === 0) return null;
  const editing = Array.isArray(editorFor) && sameSet(editorFor, ids);
  const all: BatchAction[] = [
    ...actions,
    { id: "addLabel", label: tr("batch.addLabel"), onClick: () => useUi.getState().openLabelEditor(ids) },
    { id: "copy", label: tr("batch.copy"), onClick: () => void copyAddresses(ids) },
    { id: "cancel", label: tr("common.cancel"), onClick: onCancel },
  ];
  return (
    <div className="batch-bar" role="toolbar" aria-label={tr("batch.label")} style={insetLeft > 0 ? { left: `calc(50% + ${insetLeft / 2}px)` } : undefined}>
      <span className="batch-bar__count">{tr("batch.selected", { count: ids.length })}</span>
      {all.map((a) => (
        <button key={a.id} type="button" className="btn btn--compact" onClick={a.onClick}>
          {a.label}
        </button>
      ))}
      {editing && (
        <div className="batch-bar__editor">
          <LabelEditor addresses={ids} onClose={closeEditor} />
        </div>
      )}
    </div>
  );
}

/** The address graph's batch bar, over its box selection. */
export function BatchBar({ insetLeft }: { insetLeft?: number }) {
  const ids = useBoxSelection((s) => s.ids);
  const clear = useBoxSelection((s) => s.clear);
  const anyPinned = useGraph((s) => ids.some((id) => !!s.ui[id]?.pinned));
  const tr = useT();
  const g = () => useGraph.getState();
  const actions: BatchAction[] = [
    { id: "pin", label: tr("batch.pin"), onClick: () => { g().setPinned(ids, true); clear(); } },
    ...(anyPinned ? [{ id: "unpin", label: tr("batch.unpin"), onClick: () => { g().setPinned(ids, false); clear(); } }] : []),
    { id: "hide", label: tr("batch.hide"), onClick: () => { g().setHidden(ids, true); clear(); } },
    { id: "makeCenters", label: tr("batch.makeCenters"), onClick: () => { g().setCenters([...g().centers, ...ids]); clear(); } },
  ];
  return <BatchBarShell ids={ids} actions={actions} onCancel={clear} insetLeft={insetLeft} />;
}
