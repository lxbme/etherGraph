import { Circle, MousePointer2, MoveUpRight, Square, Trash2, Type, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { MsgKey } from "../i18n";
import { useT } from "../i18n";
import {
  ANNOTATION_COLORS,
  ANNOTATION_FONTS,
  clampFontSize,
  familyOf,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  textSizeOf,
  type AnnotationKind,
  type ViewId,
} from "./model";
import { useAnnotations } from "./store";

const TOOLS: readonly ["select" | AnnotationKind, MsgKey, LucideIcon][] = [
  ["select", "annotate.select", MousePointer2],
  ["text", "annotate.text", Type],
  ["arrow", "annotate.arrow", MoveUpRight],
  ["rect", "annotate.rect", Square],
  ["ellipse", "annotate.ellipse", Circle],
];

/**
 * The text size field: a size in range applies as it is typed (or stepped); on blur or Enter the field shows `value`
 * again, so an out-of-range or empty entry is dropped. What is typed belongs to `target` (the selected text, "" for
 * new text) and is not shown for another; the field is not remounted, so it keeps the focus.
 */
function SizeInput({ value, target, label, onApply }: { value: number; target: string; label: string; onApply: (n: number) => void }) {
  const [typed, setTyped] = useState<{ target: string; text: string } | null>(null);
  const setDraft = (text: string | null) => setTyped(text === null ? null : { target, text });
  const draft = typed?.target === target ? typed.text : null;
  return (
    <input
      type="number"
      className="input input--compact num annotate-bar__size"
      min={FONT_SIZE_MIN}
      max={FONT_SIZE_MAX}
      step={1}
      aria-label={label}
      title={label}
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && clampFontSize(n) === n) onApply(n);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => e.key === "Enter" && setDraft(null)}
    />
  );
}

/**
 * The annotate-mode bar of a canvas, floating centred near its top (under the canvas tools): the tools, the colours
 * (picking one also recolours the selected annotation), with the text tool or a text selected the font and size
 * (also applied to the selected text), delete (the selected annotation) and Done. Renders nothing unless `view` is
 * in annotate mode.
 */
export function AnnotateToolbar({ view }: { view: ViewId }) {
  const t = useT();
  const on = useAnnotations((s) => s.active === view);
  const tool = useAnnotations((s) => s.tool);
  const color = useAnnotations((s) => s.color);
  const fontSize = useAnnotations((s) => s.fontSize);
  const font = useAnnotations((s) => s.font);
  const selected = useAnnotations((s) => (s.active === view ? s.selected : null));
  const selectedText = useAnnotations((s) =>
    s.active === view && s.selected !== null ? s.byView[view]?.find((a) => a.id === s.selected && a.kind === "text") : undefined,
  );
  if (!on) return null;
  const s = useAnnotations.getState;
  // The selected text's own size and font, else the ones new text gets.
  const size = selectedText ? textSizeOf(selectedText) : fontSize;
  const shownFont = selectedText ? (selectedText.font ?? "sans") : font;
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
      {(tool === "text" || selectedText) && (
        <>
          {ANNOTATION_FONTS.map((f) => (
            <button
              key={f}
              type="button"
              className="btn btn--icon btn--compact"
              aria-label={t(`annotate.font.${f}`)}
              title={t(`annotate.font.${f}`)}
              aria-pressed={shownFont === f}
              onClick={() => s().setFont(f)}
            >
              <span style={{ fontFamily: familyOf(f) }}>Aa</span>
            </button>
          ))}
          <SizeInput value={size} target={selectedText?.id ?? ""} label={t("annotate.size")} onApply={(n) => s().setFontSize(n)} />
          <span className="annotate-bar__sep" aria-hidden="true" />
        </>
      )}
      <button
        type="button"
        className="btn btn--icon btn--compact"
        aria-label={t("annotate.delete")}
        title={t("annotate.delete")}
        disabled={selected === null}
        onClick={() => selected !== null && s().remove(view, selected)}
      >
        <Trash2 size={14} />
      </button>
      <button type="button" className="btn btn--compact" onClick={() => s().setMode(null)}>
        {t("annotate.done")}
      </button>
    </div>
  );
}
