import type { ReactNode } from "react";
import { useT } from "../../i18n";
import { useInfo } from "./infoStore";

/** A symbol that opens the asset (null = ETH) in the right panel of `tab`; the click does not reach a clickable row. */
export function AssetButton({ tab, asset, tokenId, title, children }: { tab: string; asset: string | null; tokenId?: string | null; title?: string; children: ReactNode }) {
  const t = useT();
  const open = useInfo((s) => s.open);
  return (
    <button
      type="button"
      className="asset-link"
      title={title ?? t("info.openAsset")}
      onClick={(e) => {
        e.stopPropagation();
        open(tab, tokenId ? { kind: "asset", asset, tokenId } : { kind: "asset", asset });
      }}
    >
      {children}
    </button>
  );
}
