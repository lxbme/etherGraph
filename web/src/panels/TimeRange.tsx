import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";

/** A time range of two UTC days "YYYY-MM-DD"; null = open. */
export interface DayRange {
  from: string | null;
  to: string | null;
}

/** The time button with its popover of two UTC days; `onChange` gets the side(s) that changed. */
export function TimeRange({ from, to, onChange }: DayRange & { onChange(patch: Partial<DayRange>): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = from === null && to === null ? t("transfers.f.timeAll") : `${from ?? "…"} – ${to ?? "…"}`;
  return (
    <div className="dropdown" ref={rootRef}>
      <button type="button" className="btn btn--compact" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div className="popover dropdown__panel transfers__time" role="dialog" aria-label={t("transfers.col.time")}>
          <input
            className="input input--compact"
            type="date"
            aria-label={t("transfers.f.from")}
            value={from ?? ""}
            max={to ?? undefined}
            onChange={(e) => onChange({ from: e.target.value || null })}
          />
          <input
            className="input input--compact"
            type="date"
            aria-label={t("transfers.f.to")}
            value={to ?? ""}
            min={from ?? undefined}
            onChange={(e) => onChange({ to: e.target.value || null })}
          />
          <button type="button" className="btn btn--compact" onClick={() => onChange({ from: null, to: null })}>
            {t("transfers.f.clear")}
          </button>
        </div>
      )}
    </div>
  );
}
