import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { EdgeDetail } from "./EdgeDetail";
import { NodeDetail } from "./NodeDetail";

export function DetailPanel() {
  const selection = useGraph((s) => s.selection);
  const t = useT();
  return (
    <div className="detail">
      {!selection && <div className="placeholder">{t("detail.placeholder")}</div>}
      {selection?.kind === "node" && <NodeDetail key={selection.address.toLowerCase()} address={selection.address.toLowerCase()} />}
      {selection?.kind === "pair" && <EdgeDetail a={selection.a.toLowerCase()} b={selection.b.toLowerCase()} />}
    </div>
  );
}
