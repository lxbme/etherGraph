import { ArrowLeft, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { qk } from "../../api/queryClient";
import { api } from "../../api/endpoints";
import { useT } from "../../i18n";
import { AssetDetail } from "./AssetDetail";
import { useInfo, type InfoView } from "./infoStore";
import { StandardDoc, useDocs } from "./StandardDoc";

function AssetTitle({ view }: { view: Extract<InfoView, { kind: "asset" }> }) {
  const t = useT();
  const addr = view.asset?.toLowerCase() ?? "";
  // Shares the detail's query: no extra request.
  const q = useQuery({ queryKey: qk.token(addr), queryFn: () => api.token(addr), enabled: view.asset !== null });
  if (view.asset === null) return <>ETH</>;
  const d = q.data;
  return <>{d?.symbol ?? d?.name ?? t("info.asset")}</>;
}

/** The top view of the tab's info stack with Back (pop) and Close (clear). */
export function InfoPanel({ tab }: { tab: string }) {
  const t = useT();
  const view = useInfo((s) => s.stacks[tab]?.at(-1));
  const back = useInfo((s) => s.back);
  const close = useInfo((s) => s.close);
  const docs = useDocs();
  if (!view) return null;
  return (
    <div className="detail info" data-testid="info-panel">
      <div className="info__head">
        <button type="button" className="btn btn--ghost btn--compact" onClick={() => back(tab)}>
          <ArrowLeft size={14} aria-hidden="true" /> {t("info.back")}
        </button>
        <h3 className="info__title">{view.kind === "doc" ? docs[view.id].code : <AssetTitle view={view} />}</h3>
        <button type="button" className="btn btn--ghost btn--icon btn--compact" aria-label={t("info.close")} title={t("info.close")} onClick={() => close(tab)}>
          <X size={14} />
        </button>
      </div>
      {view.kind === "doc" ? <StandardDoc id={view.id} /> : <AssetDetail tab={tab} asset={view.asset} tokenId={view.tokenId} />}
    </div>
  );
}
