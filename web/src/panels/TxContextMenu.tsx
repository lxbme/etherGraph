import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { identifyAddresses, needsIdentify } from "../graph/identify";
import { addToGraph, copyAddress, openInEtherscan } from "../graph/nodeActions";
import { useT } from "../i18n";
import { MenuItem, MenuShell } from "./MenuShell";
import { useUi } from "./uiStore";

/** Right-click menu of a tx flow node: identify (when needed), add to graph, add label, copy, Etherscan. */
export function TxContextMenu({ x, y, node, onClose }: { x: number; y: number; node: NodeSummaryDto; onClose(): void }) {
  const t = useT();
  const addr = node.address.toLowerCase();
  const item = (label: string, onRun: () => void) => (
    <MenuItem onRun={onRun} onClose={onClose}>{label}</MenuItem>
  );
  return (
    <MenuShell x={x} y={y} onClose={onClose}>
      {needsIdentify(node) && item(t("ctx.identify"), () => void identifyAddresses([addr]))}
      {item(t("tx.addToGraph"), () => addToGraph(addr))}
      {item(t("ctx.addLabel"), () => useUi.getState().openLabelEditor(addr))}
      {item(t("ctx.copyAddress"), () => copyAddress(addr))}
      {item(t("ctx.openEtherscan"), () => openInEtherscan(addr))}
    </MenuShell>
  );
}
