import { ArrowLeft, ExternalLink, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { qk } from "../../api/queryClient";
import { api } from "../../api/endpoints";
import { useT } from "../../i18n";
import { AssetDetail } from "./AssetDetail";
import { DOC_LINKS, docTitleKey } from "./docs";
import { useInfo, type InfoView } from "./infoStore";

/** Until the written pages exist, a topic is its title and the link to the specification. */
function DocView({ id }: { id: Extract<InfoView, { kind: "doc" }>["id"] }) {
  const t = useT();
  return (
    <div className="detail__section">
      <a className="detail__link" href={DOC_LINKS[id]} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={12} aria-hidden="true" /> {t("info.openSpec")}
      </a>
    </div>
  );
}

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
  if (!view) return null;
  return (
    <div className="detail info" data-testid="info-panel">
      <div className="info__head">
        <button type="button" className="btn btn--ghost btn--compact" onClick={() => back(tab)}>
          <ArrowLeft size={14} aria-hidden="true" /> {t("info.back")}
        </button>
        <h3 className="info__title">{view.kind === "doc" ? t(docTitleKey(view.id)) : <AssetTitle view={view} />}</h3>
        <button type="button" className="btn btn--ghost btn--icon btn--compact" aria-label={t("info.close")} title={t("info.close")} onClick={() => close(tab)}>
          <X size={14} />
        </button>
      </div>
      {view.kind === "doc" ? <DocView id={view.id} /> : <AssetDetail tab={tab} asset={view.asset} tokenId={view.tokenId} />}
    </div>
  );
}
