import { useEffect, useLayoutEffect, useRef } from "react";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { focusNode, hideNode, syncNode, togglePin } from "../graph/nodeActions";
import { useGraph } from "../graph/store";
import { useT } from "../i18n";
import { toast } from "../shell/Toasts";
import { TOP_K } from "../graph/neighbors";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { useUi } from "./uiStore";

export interface ContextMenuProps {
  /** Viewport (client) coordinates. */
  x: number;
  y: number;
  node: NodeSummaryDto;
  data: GraphResponseDto;
  /** True when the filter has exactly one asset, so top-K ranks by amount. */
  byAmount: boolean;
  onExpandSelect(): void;
  onExpandTop(): void;
  onClose(): void;
}

/** Right-click menu of a node (spec §6.4). Closes after any action, on Escape or on an outside press. */
export function ContextMenu(p: ContextMenuProps) {
  const { node, onClose } = p;
  const t = useT();
  const addr = node.address.toLowerCase();
  const pinned = useGraph((s) => !!s.ui[addr]?.pinned);
  const isCenter = useGraph((s) => s.centers.includes(addr));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(".ctx-menu")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  const ref = useRef<HTMLDivElement>(null);
  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${Math.max(0, Math.min(p.x, window.innerWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(0, Math.min(p.y, window.innerHeight - el.offsetHeight - 4))}px`;
  }, [p.x, p.y]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const copy = () => {
    if (!navigator.clipboard) {
      toast(t("common.copyFailed"), "error");
      return;
    }
    navigator.clipboard
      .writeText(addr)
      .then(() => toast(t("common.copied")))
      .catch(() => toast(t("common.copyFailed"), "error"));
  };

  return (
    <div className="menu ctx-menu" role="menu" ref={ref} style={{ left: p.x, top: p.y }}>
      <button role="menuitem" className="menu__item" onClick={run(() => syncNode(addr))}>{t("ctx.sync")}</button>
      {node.partial && (
        <button role="menuitem" className="menu__item" onClick={run(() => syncNode(addr, "older"))}>{t("ctx.older")}</button>
      )}
      <div className="menu__group">{t("ctx.expandGroup")}</div>
      <button role="menuitem" className="menu__item menu__item--sub" onClick={run(p.onExpandSelect)}>{t("ctx.select")}</button>
      <button role="menuitem" className="menu__item menu__item--sub" onClick={run(p.onExpandTop)}>
        {t(p.byAmount ? "ctx.topAmount" : "ctx.topCount", { k: TOP_K })}
      </button>
      <button role="menuitem" className="menu__item" onClick={run(() => togglePin(addr))}>{pinned ? t("ctx.unpin") : t("ctx.pin")}</button>
      <button role="menuitem" className="menu__item" onClick={run(() => hideNode(addr))}>{t("ctx.hide")}</button>
      {isCenter && (
        <button role="menuitem" className="menu__item" onClick={run(() => useGraph.getState().removeCenter(addr))}>{t("ctx.removeCenter")}</button>
      )}
      <button role="menuitem" className="menu__item" onClick={run(() => focusNode(addr, p.data))}>{t("ctx.focus")}</button>
      <button role="menuitem" className="menu__item" onClick={run(() => useUi.getState().openLabelEditor(addr))}>{t("ctx.addLabel")}</button>
      <button role="menuitem" className="menu__item" onClick={run(() => void copy())}>{t("ctx.copyAddress")}</button>
      <button
        role="menuitem"
        className="menu__item"
        onClick={run(() => window.open(`https://etherscan.io/address/${addr}`, "_blank", "noopener"))}
      >
        {t("ctx.openEtherscan")}
      </button>
    </div>
  );
}
