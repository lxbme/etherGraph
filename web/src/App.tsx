import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./api/queryClient";
import { useEvents } from "./api/useEvents";
import { Banners } from "./shell/Banners";
import { HelpDrawer } from "./shell/HelpDrawer";
import { Tour } from "./shell/Tour";
import { ResizableSplit } from "./shell/ResizableSplit";
import { RightPanel } from "./shell/RightPanel";
import { StatusBar } from "./shell/StatusBar";
import { TabBar } from "./shell/TabBar";
import { Toasts } from "./shell/Toasts";
import { TopBar } from "./shell/TopBar";
import { useAdminRoute, useHashRouting } from "./shell/hashRoute";
import { TransferTable } from "./panels/TransferTable";
import { DetailPanel } from "./panels/DetailPanel";
import { TxFlowView, TxNodeDetail } from "./views/TxFlowView";
import { InfoPanel } from "./panels/info/InfoPanel";
import { useInfo } from "./panels/info/infoStore";
import { useUi } from "./panels/uiStore";
import { useTabs, type Tab } from "./shell/tabs";
import { WorkspaceMenu } from "./shell/WorkspaceMenu";
import { useLocale } from "./i18n";
import { saveStatusLabel, useUnsavedChangesPrompt, useWorkspace } from "./workspace/useWorkspace";
import { registerExpansionEffects } from "./panels/expand/expansion";
import { AddressGraph } from "./views/AddressGraph";
import { GraphSnapshotBanner, LiveConfirm } from "./views/SnapshotBanner";
import { registerSnapshotEffects } from "./workspace/snapshot";
import { ExportFileDialog } from "./shell/ExportFileDialog";
import { useFileDrop } from "./workspace/fileRequest";
import { AuthGate } from "./auth/AuthGate";
import { AdminPage } from "./admin/AdminView";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <Shell />
      </AuthGate>
    </QueryClientProvider>
  );
}

function Shell() {
  useEffect(() => {
    registerExpansionEffects();
    registerSnapshotEffects();
  }, []);
  useHashRouting();
  useEvents();
  useUnsavedChangesPrompt();
  useFileDrop();
  const { tabs, active } = useTabs();
  const detailOpen = useUi((s) => s.detailOpen);
  const toggleDetail = useUi((s) => s.toggleDetail);
  useLocale((s) => s.locale); // re-render on language switch so the label below is re-translated
  const wsId = useWorkspace((s) => s.id);
  const wsDirty = useWorkspace((s) => s.dirty);
  const wsStatus = saveStatusLabel({ id: wsId, dirty: wsDirty });
  const hasInfo = useInfo((s) => (s.stacks[active]?.length ?? 0) > 0);
  const tx = tabs.find((t): t is Extract<Tab, { kind: "tx" }> => t.id === active && "kind" in t);
  // The admin page covers the app, which stays mounted underneath (canvas, tabs and live updates kept).
  const admin = useAdminRoute((s) => s.open);

  return (
    <>
      <div className="app" hidden={admin}>
        <TopBar workspaceMenu={<WorkspaceMenu />} onToggleDetail={toggleDetail} detailOpen={detailOpen} />
        <TabBar />
        <Banners />
        <div className="main">
          <div className="main__left">
            <div className="main__graph" hidden={!!tx}>
              <GraphSnapshotBanner />
              <ResizableSplit top={<AddressGraph />} bottom={<TransferTable />} />
            </div>
            {tabs.map(
              (t) =>
                "kind" in t && (
                  // A tab restored from a workspace gets a fresh view, which applies its saved layout.
                  <div key={`${t.hash}:${t.restored ?? 0}`} className="main__tx" hidden={t.id !== active}>
                    <TxFlowView hash={t.hash} />
                  </div>
                ),
            )}
          </div>
          {/* One panel for the active tab: the graph's selection, or the active tx tab's own selection. */}
          {detailOpen && (
            <RightPanel>
              {hasInfo ? <InfoPanel tab={active} /> : tx ? <TxNodeDetail key={tx.hash} hash={tx.hash} /> : <DetailPanel />}
            </RightPanel>
          )}
        </div>
        <StatusBar saveStatus={wsStatus} />
        <HelpDrawer />
        <Tour />
        <LiveConfirm />
        <ExportFileDialog />
      </div>
      {admin && <AdminPage />}
      <Toasts />
    </>
  );
}
