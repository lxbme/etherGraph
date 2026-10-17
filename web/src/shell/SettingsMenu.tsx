import { Settings } from "lucide-react";
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
    <div className="dropdown" ref={rootRef}>
      <button
        className="btn btn--icon"
        aria-label={t("settings.title")}
        title={t("settings.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Settings size={16} />
      </button>
      {open && (
        <div className="popover dropdown__panel settings" role="dialog" aria-label={t("settings.title")}>
          <h2 className="popover__title">{t("settings.title")}</h2>
          <div className="settings__group">
            <div className="popover__section" id="eg-settings-language">{t("settings.language")}</div>
            <div className="seg" role="radiogroup" aria-labelledby="eg-settings-language">
              {LOCALES.map((l) => (
                <label key={l} className="seg__item">
                  <input type="radio" name="eg-locale" checked={locale === l} onChange={() => setLocale(l)} />
                  {LOCALE_NAMES[l]}
                </label>
              ))}
            </div>
          </div>
          <div className="settings__group">
            <div className="popover__section" id="eg-settings-theme">{t("settings.theme")}</div>
            <div className="seg" role="radiogroup" aria-labelledby="eg-settings-theme">
              {THEMES.map((o) => (
                <label key={o.value} className="seg__item">
                  <input type="radio" name="eg-theme" checked={pref === o.value} onChange={() => setPref(o.value)} />
                  {t(o.label)}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
