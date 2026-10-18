import type { ReactNode } from "react";
import { useT } from "../../i18n";
import { tokenKindOf, useInfo, type InfoView } from "./infoStore";

/** A symbol that opens the asset (null = ETH) in the right panel of `tab`; the click does not reach a clickable row. */
export function AssetButton({ tab, asset, tokenId, kind, title, children }: { tab: string; asset: string | null; tokenId?: string | null; kind?: string; title?: string; children: ReactNode }) {
  const t = useT();
  const open = useInfo((s) => s.open);
  return (
    <button
      type="button"
      className="asset-link"
      title={title ?? t("info.openAsset")}
      onClick={(e) => {
        e.stopPropagation();
        const view: Extract<InfoView, { kind: "asset" }> = { kind: "asset", asset };
        const tokenKind = kind ? tokenKindOf(kind) : undefined;
        if (tokenKind) view.tokenKind = tokenKind;
        if (tokenId) view.tokenId = tokenId;
        open(tab, view);
      }}
    >
      {children}
    </button>
  );
}
