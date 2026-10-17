import { useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError, messageFor } from "../api/errors";
import { useT } from "../i18n";
import { qk, queryClient } from "../api/queryClient";
import { useGraph } from "../graph/store";
import { toast } from "../shell/Toasts";
import { useTabs } from "../shell/tabs";
import { classifyInput } from "./classify";

export function SearchBox() {
  const t = useT();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openAddress = (addr: string) => {
    const a = addr.toLowerCase();
    useGraph.getState().revealCenter(a);
    useTabs.getState().activate("graph");
    useGraph.getState().select({ kind: "node", address: a });
    // The profile it returns is what the detail panel shows: seed its cache instead of fetching again.
    api
      .address(a, { sync: "auto" })
      .then((p) => queryClient.setQueryData(qk.address(a), p))
      .catch((e) => toast(messageFor(e), "error"));
  };

  const submit = async () => {
    if (busy) return;
    const q = value.trim();
    if (classifyInput(q) === "invalid") {
      setError(t("search.invalid"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const r = await api.search(q);
      if (r.kind === "tx") useTabs.getState().openTx(r.value);
      else if (r.resolved_address ?? (r.kind === "address" ? r.value : null)) {
        openAddress((r.resolved_address ?? r.value) as string);
      } else {
        setError(t("search.notFound"));
        return;
      }
      setValue("");
    } catch (e) {
      setError(e instanceof ApiError && e.code === "not_found" ? t("search.notFound") : messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="search">
      <input
        ref={inputRef}
        type="search"
        className="topbar__search"
        placeholder={t("search.placeholder")}
        aria-label={t("search.label")}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            setError(null);
            e.currentTarget.blur();
          }
        }}
      />
      {busy && <span className="search__busy">{t("search.busy")}</span>}
      {error && (
        <div className="search__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
