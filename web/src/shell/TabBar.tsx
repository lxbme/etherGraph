import { X } from "lucide-react";
import { useT } from "../i18n";
import { useTabs } from "./tabs";

export function TabBar() {
  const t = useT();
  const { tabs, active, activate, close } = useTabs();
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((tab) => {
        const label =
          tab.kind === "tx"
            ? t("tab.tx", { hash: `${tab.hash.slice(0, 6)}…${tab.hash.slice(-4)}` })
            : tab.kind === "data"
              ? t("tab.data")
              : t("tab.graph");
        return (
          <div key={tab.id} className={`tab${tab.id === active ? " tab--active" : ""}`}>
            <button role="tab" aria-selected={tab.id === active} className="tab__label" onClick={() => activate(tab.id)}>
              {label}
            </button>
            {/* Only tx tabs close: the graph and data tabs are always there. */}
            {tab.kind === "tx" && (
              <button className="tab__close" aria-label={t("tab.close", { label })} onClick={() => close(tab.id)}>
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
