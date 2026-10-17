import { useBoxSelection } from "../graph/boxSelection";
import { useGraph } from "../graph/store";
import { useT } from "../i18n";

/** Actions for the nodes picked by box selection (shown for 2 or more). */
export function BatchBar() {
  const ids = useBoxSelection((s) => s.ids);
  const clear = useBoxSelection((s) => s.clear);
  const t = useT();
  if (ids.length < 2) return null;
  const g = () => useGraph.getState();
  return (
    <div className="batch-bar" role="toolbar" aria-label={t("batch.label")}>
      <span>{t("batch.selected", { count: ids.length })}</span>
      <button onClick={() => { g().setPinned(ids, true); clear(); }}>{t("batch.pin")}</button>
      <button onClick={() => { g().setHidden(ids, true); clear(); }}>{t("batch.hide")}</button>
      <button onClick={() => { g().setCenters([...g().centers, ...ids]); clear(); }}>{t("batch.makeCenters")}</button>
      <button onClick={clear}>{t("common.cancel")}</button>
    </div>
  );
}
