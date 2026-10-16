import { useBoxSelection } from "../graph/boxSelection";
import { useGraph } from "../graph/store";

/** Actions for the nodes picked by box selection (shown for 2 or more). */
export function BatchBar() {
  const ids = useBoxSelection((s) => s.ids);
  const clear = useBoxSelection((s) => s.clear);
  if (ids.length < 2) return null;
  const g = () => useGraph.getState();
  return (
    <div className="batch-bar" role="toolbar" aria-label="批量操作">
      <span>已选 {ids.length} 个节点</span>
      <button onClick={() => { g().setPinned(ids, true); clear(); }}>固定</button>
      <button onClick={() => { g().setHidden(ids, true); clear(); }}>隐藏</button>
      <button onClick={() => { for (const id of ids) g().addCenter(id); clear(); }}>展开为中心</button>
      <button onClick={clear}>取消</button>
    </div>
  );
}
