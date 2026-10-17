import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./api/queryClient";
import { useEvents } from "./api/useEvents";
import { Banners } from "./shell/Banners";
import { HelpDrawer } from "./shell/HelpDrawer";
import { ResizableSplit } from "./shell/ResizableSplit";
import { RightPanel } from "./shell/RightPanel";
import { StatusBar } from "./shell/StatusBar";
import { TabBar } from "./shell/TabBar";
import { Toasts } from "./shell/Toasts";
import { TopBar } from "./shell/TopBar";
import { useHashRouting } from "./shell/hashRoute";
import { TransferTable } from "./panels/TransferTable";
import { DetailPanel } from "./panels/DetailPanel";
import { TxFlowView, TxNodeDetail } from "./views/TxFlowView";
import { useUi } from "./panels/uiStore";
import { useTabs, type Tab } from "./shell/tabs";
import { WorkspaceMenu } from "./shell/WorkspaceMenu";
import { useLocale } from "./i18n";
import { saveStatusLabel, useUnsavedChangesPrompt, useWorkspace } from "./workspace/useWorkspace";
import { registerExpansionEffects } from "./panels/expand/expansion";
import { AddressGraph } from "./views/AddressGraph";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}

function Shell() {
  useEffect(() => registerExpansionEffects(), []);
  useHashRouting();
  useEvents();
  useUnsavedChangesPrompt();
  const { tabs, active } = useTabs();
  const detailOpen = useUi((s) => s.detailOpen);
  const toggleDetail = useUi((s) => s.toggleDetail);
  useLocale((s) => s.locale); // re-render on language switch so the label below is re-translated
  const wsId = useWorkspace((s) => s.id);
  const wsDirty = useWorkspace((s) => s.dirty);
  const wsStatus = saveStatusLabel({ id: wsId, dirty: wsDirty });
  const tx = tabs.find((t): t is Extract<Tab, { kind: "tx" }> => t.id === active && "kind" in t);

  return (
    <div className="app">
      <TopBar workspaceMenu={<WorkspaceMenu />} onToggleDetail={toggleDetail} detailOpen={detailOpen} />
      <TabBar />
      <Banners />
      <div className="main">
        <div className="main__left">
          <div className="main__graph" hidden={!!tx}>
            <ResizableSplit top={<AddressGraph />} bottom={<TransferTable />} />
          </div>
          {tabs.map(
            (t) =>
              "kind" in t && (
                <div key={t.hash} className="main__tx" hidden={t.id !== active}>
                  <TxFlowView hash={t.hash} />
                </div>
              ),
          )}
        </div>
        {/* One panel for the active tab: the graph's selection, or the active tx tab's own selection. */}
        {detailOpen && (
          <RightPanel>{tx ? <TxNodeDetail key={tx.hash} hash={tx.hash} /> : <DetailPanel />}</RightPanel>
        )}
      </div>
      <StatusBar saveStatus={wsStatus} />
      <HelpDrawer />
      <Toasts />
    </div>
  );
}
