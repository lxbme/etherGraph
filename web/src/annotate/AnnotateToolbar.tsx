import { Circle, MousePointer2, MoveUpRight, Square, Type, type LucideIcon } from "lucide-react";
import type { MsgKey } from "../i18n";
import { useT } from "../i18n";
import { ANNOTATION_COLORS, type AnnotationKind, type ViewId } from "./model";
import { useAnnotations } from "./store";

const TOOLS: readonly ["select" | AnnotationKind, MsgKey, LucideIcon][] = [
  ["select", "annotate.select", MousePointer2],
  ["text", "annotate.text", Type],
  ["arrow", "annotate.arrow", MoveUpRight],
  ["rect", "annotate.rect", Square],
  ["ellipse", "annotate.ellipse", Circle],
];

/**
 * The annotate-mode bar of a canvas, floating centred near its top (under the canvas tools): the tools, the colours
 * (picking one also recolours the selected annotation) and Done. Renders nothing unless `view` is in annotate mode.
 */
export function AnnotateToolbar({ view }: { view: ViewId }) {
  const t = useT();
  const on = useAnnotations((s) => s.active === view);
  const tool = useAnnotations((s) => s.tool);
  const color = useAnnotations((s) => s.color);
  if (!on) return null;
  const s = useAnnotations.getState;
  return (
    <div className="annotate-bar" role="toolbar" aria-label={t("annotate.toggle")}>
      {TOOLS.map(([id, key, Icon]) => (
        <button
          key={id}
          type="button"
          className="btn btn--icon btn--compact"
          aria-label={t(key)}
          title={t(key)}
          aria-pressed={tool === id}
          onClick={() => s().setTool(id)}
        >
          <Icon size={14} />
        </button>
      ))}
      <span className="annotate-bar__sep" aria-hidden="true" />
      {ANNOTATION_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className="btn btn--icon btn--compact annotate-bar__swatch"
          aria-label={t(`annotate.color.${c}`)}
          title={t(`annotate.color.${c}`)}
          aria-pressed={color === c}
          onClick={() => s().setColor(c)}
        >
          <span className="annotate-bar__dot" style={{ background: `var(--note-${c})` }} />
        </button>
      ))}
      <span className="annotate-bar__sep" aria-hidden="true" />
      <button type="button" className="btn btn--compact" onClick={() => s().setMode(null)}>
        {t("annotate.done")}
      </button>
    </div>
  );
}
