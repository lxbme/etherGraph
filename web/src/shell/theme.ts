import { create } from "zustand";

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "eg.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const mql = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref === "system") return mql()?.matches ? "dark" : "light";
  return pref;
}

interface ThemeState {
  pref: ThemePref;
  resolved: ResolvedTheme;
  setPref(p: ThemePref): void;
}

let detach: (() => void) | null = null;

function apply(resolved: ResolvedTheme) {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = resolved;
}

const initialPref = readPref();
const initialResolved = resolve(initialPref);
apply(initialResolved); // before first render, so there is no light/dark flash

export const useTheme = create<ThemeState>((set) => {
  /** Follow the OS only while the preference is "system". */
  const follow = (pref: ThemePref) => {
    detach?.();
    detach = null;
    const mq = mql();
    if (pref !== "system" || !mq) return;
    const onChange = (e: { matches: boolean }) => {
      const resolved: ResolvedTheme = e.matches ? "dark" : "light";
      apply(resolved);
      set({ resolved });
    };
    mq.addEventListener("change", onChange);
    detach = () => mq.removeEventListener("change", onChange);
  };
  follow(initialPref);
  return {
    pref: initialPref,
    resolved: initialResolved,
    setPref(pref) {
      try {
        localStorage.setItem(STORAGE_KEY, pref);
      } catch {
        /* storage unavailable: keep the choice for this session only */
      }
      const resolved = resolve(pref);
      apply(resolved);
      follow(pref);
      set({ pref, resolved });
    },
  };
});
