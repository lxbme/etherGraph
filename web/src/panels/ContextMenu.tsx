import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { identifyAddresses, needsIdentify } from "../graph/identify";
import { copyAddress, focusNode, hideNode, openInEtherscan, syncNode, togglePin } from "../graph/nodeActions";
import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { MenuItem, MenuShell } from "./MenuShell";
import { useUi } from "./uiStore";

export interface ContextMenuProps {
  /** Viewport (client) coordinates. */
  x: number;
  y: number;
  node: NodeSummaryDto;
  data: GraphResponseDto;
  /** Opens the expansion dialog for `node` (wallets and unknown kinds only). */
  onExpand(): void;
  /** Opens the interactions list of `node` (contracts only). */
  onBrowse(): void;
  /** Opens the neighbour picker for `node` (a center too: to change its picks, or make them after "Not now"). */
  onExpandSelf(): void;
  onClose(): void;
}

/** Right-click menu of a node (spec §6.4). Closes after any action, on Escape or on an outside press. */
export function ContextMenu(p: ContextMenuProps) {
  const { node, onClose } = p;
  const t = useT();
  const addr = node.address.toLowerCase();
  const pinned = useGraph((s) => !!s.ui[addr]?.pinned);
  const isCenter = useGraph((s) => s.centers.includes(addr));
  const proxyHidden = useGraph((s) => s.hiddenProxies.includes(addr));
  const item = (label: string, onRun: () => void) => (
    <MenuItem onRun={onRun} onClose={onClose}>{label}</MenuItem>
  );

  return (
    <MenuShell x={p.x} y={p.y} onClose={onClose}>
      {item(t("ctx.sync"), () => syncNode(addr))}
      {needsIdentify(node) && item(t("ctx.identify"), () => void identifyAddresses([addr]))}
      {node.partial && item(t("ctx.older"), () => syncNode(addr, "older"))}
      {/* The picker syncs no neighbour, so contracts get it too; a center gets it to pick again (spec §5.2). */}
      {item(t("ctx.expandSelf"), p.onExpandSelf)}
      {/* Contracts are never expanded directly: their counterparties are picked from a list (spec §5.9). */}
      {node.kind !== "contract" ? item(t("ctx.expand"), p.onExpand) : item(t("ctx.browse"), p.onBrowse)}
      {item(pinned ? t("ctx.unpin") : t("ctx.pin"), () => togglePin(addr))}
      {item(t("ctx.hide"), () => hideNode(addr))}
      {isCenter && item(t("ctx.removeCenter"), () => useGraph.getState().removeCenter(addr))}
      {isCenter && proxyHidden && item(t("ctx.showMore"), () => useGraph.getState().setProxiesHidden([addr], false))}
      {item(t("ctx.focus"), () => focusNode(addr, p.data))}
      {item(t("ctx.addLabel"), () => useUi.getState().openLabelEditor(addr))}
      {item(t("ctx.copyAddress"), () => copyAddress(addr))}
      {item(t("ctx.openEtherscan"), () => openInEtherscan(addr))}
    </MenuShell>
  );
}
