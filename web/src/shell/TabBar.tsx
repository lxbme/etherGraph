import { useTabs } from "./tabs";

export function TabBar() {
  const { tabs, active, activate, close } = useTabs();
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => {
        const label = "kind" in t ? `交易 ${t.hash.slice(0, 6)}…${t.hash.slice(-4)}` : "关系图";
        return (
          <div key={t.id} className={`tab${t.id === active ? " tab--active" : ""}`}>
            <button role="tab" aria-selected={t.id === active} className="tab__label" onClick={() => activate(t.id)}>
              {label}
            </button>
            {"kind" in t && (
              <button className="tab__close" aria-label={`关闭 ${label}`} onClick={() => close(t.id)}>×</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
