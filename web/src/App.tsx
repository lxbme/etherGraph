import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { queryClient } from "./api/queryClient";
import { useEvents } from "./api/useEvents";
import { Banners } from "./shell/Banners";
import { ResizableSplit } from "./shell/ResizableSplit";
import { StatusBar } from "./shell/StatusBar";
import { TabBar } from "./shell/TabBar";
import { Toasts } from "./shell/Toasts";
import { TopBar } from "./shell/TopBar";
import { useHashRouting } from "./shell/hashRoute";
import { TransferTable } from "./panels/TransferTable";
import { DetailPanel, TxView } from "./shell/placeholders";
import { useTabs } from "./shell/tabs";
import { AddressGraph } from "./views/AddressGraph";

function initialDetailOpen(): boolean {
  return typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 899px)").matches;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}

function Shell() {
  useHashRouting();
  useEvents();
  const { tabs, active } = useTabs();
  const [detailOpen, setDetailOpen] = useState(initialDetailOpen);
  const tx = tabs.find((t) => t.id === active && "kind" in t);

  return (
    <div className="app">
      <TopBar onToggleDetail={() => setDetailOpen((v) => !v)} />
      <TabBar />
      <Banners />
      <div className="main">
        <div className="main__left">
          <div className="main__graph" hidden={!!tx}>
            <ResizableSplit top={<AddressGraph />} bottom={<TransferTable />} />
          </div>
          {tx && "kind" in tx && <TxView hash={tx.hash} />}
        </div>
        {detailOpen && (
          <aside className="main__right">
            <DetailPanel />
          </aside>
        )}
      </div>
      <StatusBar />
      <Toasts />
    </div>
  );
}
