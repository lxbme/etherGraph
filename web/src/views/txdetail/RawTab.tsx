import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { qk } from "../../api/queryClient";
import { useT } from "../../i18n";
import { CopyButton } from "../../shell/CopyButton";

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

/** The stored tx and receipt JSON, fetched from /api/tx/{hash}/raw the first time this tab opens. */
export function RawTab({ hash }: { hash: string }) {
  const t = useT();
  const q = useQuery({ queryKey: qk.txRaw(hash), queryFn: () => api.txRaw(hash), staleTime: Infinity });
  const text = useMemo(
    () => (q.data ? { tx: JSON.stringify(q.data.tx, null, 2), receipt: JSON.stringify(q.data.receipt, null, 2) } : null),
    [q.data],
  );
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
