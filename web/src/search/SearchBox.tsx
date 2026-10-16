import { useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError, messageFor } from "../api/errors";
import { useGraph } from "../graph/store";
import { toast } from "../shell/Toasts";
import { useTabs } from "../shell/tabs";
import { classifyInput } from "./classify";

const INVALID_HINT = "请输入地址（0x+40位）、交易哈希（0x+64位）或 ENS 名称";

export function SearchBox() {
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
    api.address(a, { sync: "auto" }).catch((e) => toast(messageFor(e), "error"));
  };

  const submit = async () => {
    if (busy) return;
    const q = value.trim();
    if (classifyInput(q) === "invalid") {
      setError(INVALID_HINT);
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
        setError("未找到该名称或地址");
        return;
      }
      setValue("");
    } catch (e) {
      setError(e instanceof ApiError && e.code === "not_found" ? "未找到该名称或地址" : messageFor(e));
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
        placeholder="搜索 地址 / 交易哈希 / ENS（⌘K）"
        aria-label="搜索"
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
      {busy && <span className="search__busy">搜索中…</span>}
      {error && (
        <div className="search__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
