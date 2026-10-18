import type { ReactNode } from "react";
import { useT } from "../../i18n";
import type { DocId } from "./docs";
import { useInfo } from "./infoStore";

/** Opens a documentation page in the right panel of `tab`; `onOpen` runs after (e.g. to close a drawer). */
export function DocButton({ tab, doc, onOpen, children }: { tab: string; doc: DocId; onOpen?: () => void; children: ReactNode }) {
  const t = useT();
  const open = useInfo((s) => s.open);
  return (
    <button
      type="button"
      className="doc-link"
      title={t("info.openDoc")}
      onClick={() => {
        open(tab, { kind: "doc", id: doc });
        onOpen?.();
      }}
    >
      {children}
    </button>
  );
}
