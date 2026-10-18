import type { BoxSelectionStore } from "../graph/boxSelection";
import { addToGraph } from "../graph/nodeActions";
import { useT } from "../i18n";
import { BatchBarShell, type BatchAction } from "./BatchBar";

/** A tx tab's batch bar, over that tab's box selection. */
export function TxBatchBar({ selection, insetLeft }: { selection: BoxSelectionStore; insetLeft?: number }) {
  const ids = selection((s) => s.ids);
  const clear = selection((s) => s.clear);
  const tr = useT();
  const actions: BatchAction[] = [
    { id: "addToGraph", label: tr("batch.addToGraph"), onClick: () => { addToGraph(ids); clear(); } },
  ];
  return <BatchBarShell ids={ids} actions={actions} onCancel={clear} insetLeft={insetLeft} />;
}
