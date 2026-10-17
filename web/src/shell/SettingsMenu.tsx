import { useEffect, useRef, useState } from "react";
import { useTheme, type ThemePref } from "./theme";
import { LOCALES, LOCALE_NAMES, useLocale, useT, type MsgKey } from "../i18n";

const THEMES: { value: ThemePref; label: MsgKey }[] = [
  { value: "light", label: "settings.theme.light" },
  { value: "dark", label: "settings.theme.dark" },
  { value: "system", label: "settings.theme.system" },
];

export function SettingsMenu() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  const [open, setOpen] = useState(false);
  const pref = useTheme((s) => s.pref);
  const setPref = useTheme((s) => s.setPref);
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

  return (
    <div className="wsmenu" ref={rootRef}>
      <button className="btn" aria-label={t("settings.title")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t("settings.title")}
      </button>
      {open && (
        <div className="wsmenu__list" role="dialog" aria-label={t("settings.title")}>
          <div role="radiogroup" aria-label={t("settings.language")}>
            <div>{t("settings.language")}</div>
            {LOCALES.map((l) => (
              <label key={l}>
                <input type="radio" name="eg-locale" checked={locale === l} onChange={() => setLocale(l)} />
                {LOCALE_NAMES[l]}
              </label>
            ))}
          </div>
          <div role="radiogroup" aria-label={t("settings.theme")}>
            <div>{t("settings.theme")}</div>
            {THEMES.map((o) => (
              <label key={o.value}>
                <input type="radio" name="eg-theme" checked={pref === o.value} onChange={() => setPref(o.value)} />
                {t(o.label)}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
