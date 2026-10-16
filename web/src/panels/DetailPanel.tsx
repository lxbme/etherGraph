import { useGraph } from "../graph/store";
import { EdgeDetail } from "./EdgeDetail";
import { NodeDetail } from "./NodeDetail";

export function DetailPanel() {
  const selection = useGraph((s) => s.selection);
  return (
    <div className="detail">
      {!selection && <div className="placeholder">选择节点或边查看详情</div>}
      {selection?.kind === "node" && <NodeDetail key={selection.address.toLowerCase()} address={selection.address.toLowerCase()} />}
      {selection?.kind === "pair" && <EdgeDetail a={selection.a.toLowerCase()} b={selection.b.toLowerCase()} />}
    </div>
  );
}
