import type { ReactNode } from "react";
import { useT } from "../../i18n";
import type { DocId } from "./docs";
import { openDoc } from "./infoStore";

/**
 * Opens a documentation page in the right panel of `tab` (the graph's, shown, from the data tab); `onOpen` runs
 * after (e.g. to close a drawer).
 */
export function DocButton({ tab, doc, onOpen, children }: { tab: string; doc: DocId; onOpen?: () => void; children: ReactNode }) {
  const t = useT();
  return (
    <button
      type="button"
      className="doc-link"
      title={t("info.openDoc")}
      onClick={() => {
        openDoc(tab, doc);
        onOpen?.();
      }}
    >
      {children}
    </button>
  );
}
