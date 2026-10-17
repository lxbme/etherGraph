import { create } from "zustand";
import { en, type MsgKey } from "./en";
import { zh } from "./zh";

export type Locale = "en" | "zh";
export type { MsgKey };

export const LOCALES: readonly Locale[] = ["en", "zh"];
/** Native names, shown in the language picker regardless of the active locale. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", zh: "中文" };

const STORAGE_KEY = "eg.locale";
const dictionaries = { en, zh } as const;

function readLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

interface LocaleState {
  locale: Locale;
  setLocale(l: Locale): void;
}

export const useLocale = create<LocaleState>((set) => ({
  locale: readLocale(),
  setLocale(l) {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* storage unavailable: keep the choice for this session only */
    }
    set({ locale: l });
  },
}));

type Params = Record<string, string | number>;

function translate(locale: Locale, key: MsgKey, params?: Params): string {
  const entry: string | { one: string; other: string } = dictionaries[locale][key];
  let text: string;
  if (typeof entry === "string") {
    text = entry;
  } else {
    const count = params?.count;
    const form = typeof count === "number" ? new Intl.PluralRules(locale).select(count) : "other";
    text = form === "one" ? entry.one : entry.other;
  }
  return text.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params?.[name];
    return v === undefined ? m : String(v);
  });
}

/** Non-hook translate for toasts and other non-component code. */
export function t(key: MsgKey, params?: Params): string {
  return translate(useLocale.getState().locale, key, params);
}

/** Hook version: re-renders the component when the locale changes. */
export function useT(): typeof t {
  const locale = useLocale((s) => s.locale);
  return (key, params) => translate(locale, key, params);
}
