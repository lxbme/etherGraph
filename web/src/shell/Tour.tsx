import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useT, type MsgKey } from "../i18n";
import { setReplayTourHandler } from "./tourBus";

/** localStorage key set once the tour was finished or skipped ("1"). */
export const TOUR_DONE_KEY = "eg.tour.done";
const START_DELAY_MS = 500;
const GAP = 12;
const MARGIN = 8;

const STEPS = ["search", "legend", "help"] as const;
type StepId = (typeof STEPS)[number];

function markDone() {
  try {
    localStorage.setItem(TOUR_DONE_KEY, "1");
  } catch {
    /* storage unavailable: the tour may show again next load */
  }
}

function isDone(): boolean {
  try {
    return localStorage.getItem(TOUR_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

interface TourState {
  /** Index into the three steps, or null while the tour is not showing. */
  step: number | null;
  start(): void;
  next(): void;
  skip(): void;
}

export const useTour = create<TourState>((set, get) => ({
  step: null,
  start: () => set({ step: 0 }),
  next: () => {
    const step = get().step;
    if (step === null) return;
    if (step + 1 >= STEPS.length) {
      markDone();
      set({ step: null });
    } else set({ step: step + 1 });
  },
  skip: () => {
    markDone();
    set({ step: null });
  },
}));

/** The element a step points at, if it exists and is laid out. */
function findTarget(id: StepId): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${id}"]`);
  if (!el || el.offsetParent === null) return null;
  const r = el.getBoundingClientRect();
  return r.width === 0 || r.height === 0 ? null : el;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** Three-step first-run tour: an outline on the target and a bubble beside it. */
export function Tour() {
  const t = useT();
  const step = useTour((s) => s.step);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setReplayTourHandler(() => useTour.getState().start());
    return () => setReplayTourHandler(null);
  }, []);

  useEffect(() => {
    if (isDone()) return;
    const timer = setTimeout(() => useTour.getState().start(), START_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const id = step === null ? null : STEPS[step];
  const target = id ? findTarget(id) : null;

  // A step whose target is missing is skipped; with no target left at all the tour ends unmarked.
  useEffect(() => {
    if (step === null || target) return;
    const anyLeft = STEPS.some((s, i) => i >= step && findTarget(s));
    if (!anyLeft && step === 0) useTour.setState({ step: null });
    else useTour.getState().next();
  }, [step, target]);

  // Measure the target now and whenever the window resizes.
  useLayoutEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }
    const measure = () => setRect(target.getBoundingClientRect());
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [target]);

  // Below the target, or above when it would leave the viewport; kept inside horizontally.
  useLayoutEffect(() => {
    if (!rect || !bubble.current) return setPos(null);
    const w = bubble.current.offsetWidth;
    const h = bubble.current.offsetHeight;
    const below = rect.bottom + GAP;
    const top = below + h + MARGIN > window.innerHeight ? Math.max(MARGIN, rect.top - GAP - h) : below;
    setPos({ left: clamp(rect.left, MARGIN, Math.max(MARGIN, window.innerWidth - w - MARGIN)), top });
  }, [rect, step]);

  useEffect(() => {
    if (!rect || !pos) return;
    next.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        useTour.getState().skip();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [rect, pos, step]);

  if (step === null || !id || !rect) return null;
  const titleId = "eg-tour-title";
  const last = step === STEPS.length - 1;
  return (
    <>
      <div
        className="tour__highlight"
        aria-hidden="true"
        style={{ left: rect.left + window.scrollX, top: rect.top + window.scrollY, width: rect.width, height: rect.height }}
      />
      <div
        ref={bubble}
        className="tour__bubble"
        role="dialog"
        aria-labelledby={titleId}
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
      >
        <h2 className="tour__title" id={titleId}>{t(`tour.${id}.title` as MsgKey)}</h2>
        <p className="tour__body">{t(`tour.${id}.body` as MsgKey)}</p>
        <div className="tour__actions">
          <button type="button" className="btn btn--ghost" onClick={() => useTour.getState().skip()}>{t("tour.skip")}</button>
          <button type="button" className="btn" ref={next} onClick={() => useTour.getState().next()}>{t(last ? "tour.done" : "tour.next")}</button>
        </div>
      </div>
    </>
  );
}
