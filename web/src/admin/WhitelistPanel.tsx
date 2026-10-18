import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api/endpoints";
import { useT } from "../i18n";
import { formatLocalTime, formatTime } from "../lib/format";
import { adminCall, adminErrorText, adminKeys, useAdminOverview } from "./adminMode";
import { useAdminAction } from "./useAdminAction";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
/** `added_by` of an address that signed in while registration was open. */
const BY_OPEN_REGISTRATION = "open-registration";

/** The whitelist: add an address, remove one (each a signed action). */
export function WhitelistPanel() {
  const t = useT();
  const list = useQuery({ queryKey: adminKeys.whitelist, queryFn: () => adminCall(api.adminWhitelist()) });
  const open = useAdminOverview().data?.open_registration === true;
  const { run, busy } = useAdminAction();
  const [draft, setDraft] = useState("");
  const address = draft.trim();
  const valid = ADDR.test(address);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    if (await run({ type: "WhitelistAdd", address: address.toLowerCase() })) setDraft("");
  };
  return (
    <section className="admin__section" aria-labelledby="admin-whitelist">
      <h2 id="admin-whitelist" className="admin__heading">
        {t("admin.whitelist.title")}
      </h2>
      <form className="admin__row" onSubmit={(e) => void add(e)}>
        <input
          className="input input--compact num admin__address-input"
          aria-label={t("admin.whitelist.address")}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          aria-invalid={draft !== "" && !valid}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn btn--compact btn--primary" type="submit" disabled={!valid || busy}>
          {t("admin.whitelist.add")}
        </button>
      </form>
      {draft !== "" && !valid && <p className="admin__note admin__note--error">{t("admin.whitelist.invalid")}</p>}
      <p className="admin__note">{t(open ? "admin.whitelist.removeOpenNote" : "admin.whitelist.removeNote")}</p>
      {list.error && !list.data && <p className="dialog__error">{adminErrorText(list.error)}</p>}
      {list.data &&
        (list.data.length === 0 ? (
          <p className="admin__note">{t("admin.whitelist.empty")}</p>
        ) : (
          <div className="admin__table">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("admin.col.address")}</th>
                  <th>{t("admin.whitelist.addedBy")}</th>
                  <th>{t("admin.whitelist.addedAt")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((w) => (
                  <tr key={w.address}>
                    <td className="num">{w.address}</td>
                    <td className={w.added_by === BY_OPEN_REGISTRATION ? undefined : "num"}>
                      {w.added_by === BY_OPEN_REGISTRATION ? t("admin.whitelist.byOpenRegistration") : w.added_by}
                    </td>
                    <td className="num" title={formatLocalTime(w.added_at)}>
                      {formatTime(w.added_at)}
                    </td>
                    <td className="table__num">
                      <button
                        className="btn btn--compact"
                        disabled={busy}
                        aria-label={t("admin.whitelist.removeLabel", { address: w.address })}
                        onClick={() => void run({ type: "WhitelistRemove", address: w.address })}
                      >
                        {t("admin.whitelist.remove")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
