import { useMemo } from "react";
import { useGraph } from "../graph/store";
import { fileLabelsOf } from "../workspace/snapshot";
import { useT } from "../i18n";
import { EdgeDetail } from "./EdgeDetail";
import { NodeDetail } from "./NodeDetail";
import { TxSummaryCard } from "./TxSummaryCard";

export function DetailPanel() {
  const selection = useGraph((s) => s.selection);
  const frozen = useGraph((s) => s.frozen);
  const t = useT();
  const nodeAddr = selection?.kind === "node" ? selection.address.toLowerCase() : null;
  const fileLabels = useMemo(() => (nodeAddr ? fileLabelsOf(frozen?.data.nodes, nodeAddr) : []), [frozen, nodeAddr]);
  return (
    <div className="detail">
      {!selection && <div className="placeholder">{t("detail.placeholder")}</div>}
      {nodeAddr && <NodeDetail key={nodeAddr} address={nodeAddr} fileLabels={fileLabels} />}
      {selection?.kind === "tx" && <TxSummaryCard key={selection.hash.toLowerCase()} hash={selection.hash.toLowerCase()} />}
      {selection?.kind === "pair" && <EdgeDetail a={selection.a.toLowerCase()} b={selection.b.toLowerCase()} />}
    </div>
  );
}
