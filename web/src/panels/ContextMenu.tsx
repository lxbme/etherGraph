import { useEffect, useLayoutEffect, useRef } from "react";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { focusNode, hideNode, syncNode, togglePin } from "../graph/nodeActions";
import { useGraph } from "../graph/store";
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
      toast("复制失败", "error");
      return;
    }
    navigator.clipboard
      .writeText(addr)
      .then(() => toast("已复制"))
      .catch(() => toast("复制失败", "error"));
  };

  return (
    <div className="ctx-menu" role="menu" ref={ref} style={{ left: p.x, top: p.y }}>
      <button role="menuitem" onClick={run(() => syncNode(addr))}>同步 / 刷新<kbd>S</kbd></button>
      {node.partial && (
        <button role="menuitem" onClick={run(() => syncNode(addr, "older"))}>继续拉更早的记录</button>
      )}
      <div className="ctx-menu__group">展开邻居</div>
      <button role="menuitem" className="ctx-menu__sub" onClick={run(p.onExpandSelect)}>选择…</button>
      <button role="menuitem" className="ctx-menu__sub" onClick={run(p.onExpandTop)}>
        前 {TOP_K} 个（按{p.byAmount ? "金额" : "笔数"}）
      </button>
      <button role="menuitem" onClick={run(() => togglePin(addr))}>{pinned ? "取消固定" : "固定"}<kbd>P</kbd></button>
      <button role="menuitem" onClick={run(() => hideNode(addr))}>从画布隐藏<kbd>H</kbd></button>
      {isCenter && (
        <button role="menuitem" onClick={run(() => useGraph.getState().removeCenter(addr))}>移出中心</button>
      )}
      <button role="menuitem" onClick={run(() => focusNode(addr, p.data))}>只看这个节点的邻域<kbd>F</kbd></button>
      <button role="menuitem" onClick={run(() => useUi.getState().openLabelEditor(addr))}>添加标签 / 备注<kbd>L</kbd></button>
      <button role="menuitem" onClick={run(() => void copy())}>复制地址</button>
      <button
        role="menuitem"
        onClick={run(() => window.open(`https://etherscan.io/address/${addr}`, "_blank", "noopener"))}
      >
        在 Etherscan 打开
      </button>
    </div>
  );
}
