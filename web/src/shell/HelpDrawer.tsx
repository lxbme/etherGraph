import { useEffect, useRef } from "react";
import { CirclePlay, X } from "lucide-react";
import { HORIZON_SEC, PROBE_CHUNK } from "../graph/budget";
import { fullLegendGroups } from "../graph/legend";
import { formatCombo, isMac, SHORTCUTS } from "../graph/shortcuts";
import { MAX_NEIGHBOUR_LIMIT } from "../graph/store";
import { useT, type MsgKey } from "../i18n";
import { useUi } from "../panels/uiStore";
import { Legend } from "../views/Legend";
import { useQuota } from "./statusStore";
import { useTheme } from "./theme";
import { replayTour } from "./tourBus";

export const HELP_BUTTON_ID = "eg-help-button";
export const HELP_DRAWER_ID = "eg-help";
const TITLE_ID = "eg-help-title";

/** Etherscan free tier and server defaults (config.example.toml), quoted in "Data & quotas" (the server's own limit once known). */
const DAILY_QUOTA = 100_000;
const RATE_PER_SEC = "2.5";
/** Records per category a shallow sync fetches (server side). */
const SHALLOW_RECORDS = 1000;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type SectionId = "reading" | "expanding" | "tx" | "shortcuts" | "data";
type Params = Record<string, string | number>;

/** Body keys of each section after its intro (`help.<id>.body`), rendered as a bullet list. */
function bullets(id: SectionId, mac: boolean, quota: number): { key: MsgKey; params?: Params }[] {
  switch (id) {
    case "reading":
      return [{ key: "help.reading.body1" }, { key: "help.reading.body2" }, { key: "help.reading.body3" }, { key: "help.reading.body4" }, { key: "help.reading.body5" }];
    case "expanding":
      return [
        { key: "help.expanding.body1", params: { chunk: PROBE_CHUNK } },
        { key: "help.expanding.body2" },
        { key: "help.expanding.body3", params: { seconds: HORIZON_SEC } },
        { key: "help.expanding.body4" },
        { key: "help.expanding.body5" },
        { key: "help.expanding.body6" },
        { key: "help.expanding.body7", params: { undo: formatCombo("Mod+Z", mac) } },
        { key: "help.expanding.body8", params: { max: MAX_NEIGHBOUR_LIMIT } },
        { key: "help.expanding.body9" },
      ];
    case "tx":
      return [{ key: "help.tx.body1" }, { key: "help.tx.body2" }, { key: "help.tx.body3" }, { key: "help.tx.body4" }, { key: "help.tx.body5" }];
    case "shortcuts":
      return [];
    case "data":
      return [
        { key: "help.data.body1", params: { quota } },
        { key: "help.data.body2", params: { rate: RATE_PER_SEC } },
        { key: "help.data.body3", params: { records: SHALLOW_RECORDS } },
        { key: "help.data.body4" },
      ];
  }
}

const SECTIONS: SectionId[] = ["reading", "expanding", "tx", "shortcuts", "data"];

/** The "?" drawer: how to read the graph, expansion rules, the tx view, shortcuts, data and quotas. */
export function HelpDrawer() {
  const open = useUi((s) => s.helpOpen);
  return open ? <HelpDrawerPanel /> : null;
}

function HelpDrawerPanel() {
  const t = useT();
  const theme = useTheme((s) => s.resolved);
  const toggleHelp = useUi((s) => s.toggleHelp);
  const ref = useRef<HTMLDivElement>(null);
  const mac = isMac();
  const quota = useQuota((s) => s.quota?.limit) ?? DAILY_QUOTA;

  // Modal: focus moves in on open, Tab cycles inside, Escape closes, focus returns to the "?" button.
  useEffect(() => {
    const root = ref.current;
    root?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        useUi.setState({ helpOpen: false });
      } else if (e.key === "Tab" && root) {
        const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!first || !last) {
          e.preventDefault();
          root.focus();
        } else if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !root.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.getElementById(HELP_BUTTON_ID)?.focus();
    };
  }, []);

  const replay = () => {
    toggleHelp();
    replayTour();
  };

  return (
    <div className="drawer-backdrop" onClick={(e) => e.target === e.currentTarget && toggleHelp()}>
      <div className="drawer help" id={HELP_DRAWER_ID} role="dialog" aria-modal="true" aria-labelledby={TITLE_ID} tabIndex={-1} ref={ref}>
        <div className="drawer__head">
          <h2 className="drawer__title" id={TITLE_ID}>{t("help.title")}</h2>
          <button type="button" className="btn btn--icon btn--ghost" aria-label={t("help.close")} title={t("help.close")} onClick={toggleHelp}>
            <X size={16} />
          </button>
        </div>
        {/* Focusable so the keyboard can scroll the long text. */}
        <div className="drawer__body" tabIndex={0}>
          {SECTIONS.map((id) => {
            const items = bullets(id, mac, quota);
            return (
              <section key={id} className="help__section" aria-labelledby={`eg-help-${id}`}>
                <h3 className="help__title" id={`eg-help-${id}`}>{t(`help.${id}.title`)}</h3>
                <p>{t(`help.${id}.body`)}</p>
                {id === "reading" && <Legend groups={fullLegendGroups(theme)} />}
                {id === "shortcuts" && <ShortcutTable mac={mac} />}
                {items.length > 0 && (
                  <ul className="help__list">
                    {items.map((b) => (
                      <li key={b.key}>{t(b.key, b.params)}</li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
        <div className="drawer__foot">
          <button type="button" className="btn" onClick={replay}>
            <CirclePlay size={16} />
            {t("help.replayTour")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One row per SHORTCUTS entry, in table order. */
function ShortcutTable({ mac }: { mac: boolean }) {
  const t = useT();
  return (
    <table className="table table--inset help__keys" aria-labelledby="eg-help-shortcuts">
      <thead>
        <tr>
          <th scope="col">{t("help.shortcuts.col.action")}</th>
          <th scope="col">{t("help.shortcuts.col.keys")}</th>
        </tr>
      </thead>
      <tbody>
        {SHORTCUTS.map((s) => (
          <tr key={s.id}>
            <td className="help__action">{t(s.label)}</td>
            <td>
              {s.keys.map((k, i) => (
                <span key={k}>
                  {i > 0 && <span className="help__or"> / </span>}
                  <kbd className="kbd">{formatCombo(k, mac)}</kbd>
                </span>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
