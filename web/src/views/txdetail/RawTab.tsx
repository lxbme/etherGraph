import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { qk } from "../../api/queryClient";
import { useT } from "../../i18n";
import { CopyButton } from "../../shell/CopyButton";
import { useTxSnapshot } from "../../shell/tabs";

function JsonBlock({ title, json }: { title: string; json: string }) {
  return (
    <section className="txdetail__raw">
      <div className="txdetail__line">
        <b>{title}</b>
        <CopyButton value={json} />
      </div>
      <pre className="txdetail__pre">{json}</pre>
    </section>
  );
}

/**
 * The stored tx and receipt JSON, fetched from /api/tx/{hash}/raw the first time this tab opens; a snapshot tab
 * shows the file's raw data instead (no request).
 */
export function RawTab({ hash }: { hash: string }) {
  const t = useT();
  const snapshot = useTxSnapshot(hash);
  const q = useQuery({ queryKey: qk.txRaw(hash), queryFn: () => api.txRaw(hash), staleTime: Infinity, enabled: !snapshot });
  const raw = snapshot ? snapshot.raw : q.data;
  const text = useMemo(
    () => (raw ? { tx: JSON.stringify(raw.tx, null, 2), receipt: JSON.stringify(raw.receipt, null, 2) } : null),
    [raw],
  );
  if (snapshot && !snapshot.raw) return <div className="placeholder">{t("tx.raw.noSnapshotRaw")}</div>;
  if (q.isError) {
    return (
      <div className="placeholder" role="alert">
        {messageFor(q.error)}{" "}
        <button type="button" className="btn btn--compact" onClick={() => void q.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (!text) return <div className="placeholder">{t("common.loading")}</div>;
  return (
    <div className="txdetail__pane">
      <JsonBlock title={t("tx.raw.tx")} json={text.tx} />
      <JsonBlock title={t("tx.raw.receipt")} json={text.receipt} />
    </div>
  );
}
