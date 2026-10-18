import { useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError, messageFor } from "../api/errors";
import { useT, type MsgKey } from "../i18n";
import { isShortcut } from "../graph/shortcuts";
import { syncCenter } from "../graph/nodeActions";
import { useGraph } from "../graph/store";
import { useTabs } from "../shell/tabs";
import { classifyInput } from "./classify";

export function SearchBox() {
  const t = useT();
  const [value, setValue] = useState("");
  // Kept as a key or the raw error and translated at render, so a language switch updates it at once.
  type SearchError = { key: MsgKey } | { err: unknown };
  const [error, setError] = useState<SearchError | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A modal dialog keeps the keyboard (and focus) to itself.
      if (isShortcut(e, "search") && !document.querySelector('[aria-modal="true"]')) {
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
    useTabs.getState().activate("graph");
    // A snapshot graph is refreshed from the chain first (after a confirm).
    useGraph.getState().guardLive(() => {
      useGraph.getState().revealCenter(a);
      useGraph.getState().select({ kind: "node", address: a });
      syncCenter(a);
    });
  };

  const submit = async () => {
    if (busy) return;
    const q = value.trim();
    if (classifyInput(q) === "invalid") {
      setError({ key: "search.invalid" });
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
        setError({ key: "search.notFound" });
        return;
      }
      setValue("");
    } catch (e) {
      setError(e instanceof ApiError && e.code === "not_found" ? { key: "search.notFound" } : { err: e });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="search" data-tour="search">
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
          {"key" in error ? t(error.key) : messageFor(error.err)}
        </div>
      )}
    </div>
  );
}
