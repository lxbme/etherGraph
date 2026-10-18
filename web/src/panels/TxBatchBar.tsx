import type { BoxSelectionStore } from "../graph/boxSelection";
import { addToGraph } from "../graph/nodeActions";
import { useT } from "../i18n";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { BatchBarShell, identifyAction, type BatchAction } from "./BatchBar";

/** A tx tab's batch bar, over that tab's box selection. */
export function TxBatchBar({ selection, insetLeft, nodes }: { selection: BoxSelectionStore; insetLeft?: number; nodes: readonly NodeSummaryDto[] }) {
  const ids = selection((s) => s.ids);
  const clear = selection((s) => s.clear);
  const tr = useT();
  const actions: BatchAction[] = [
    ...identifyAction(ids, nodes, clear, tr),
    { id: "addToGraph", label: tr("batch.addToGraph"), onClick: () => { addToGraph(ids); clear(); } },
  ];
  return <BatchBarShell ids={ids} actions={actions} onCancel={clear} insetLeft={insetLeft} />;
}
