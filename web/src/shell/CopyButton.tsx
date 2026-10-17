import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { toast } from "./Toasts";

const CONFIRM_MS = 1500;

/** Compact icon button that copies `value`; shows a check for 1.5 s, or an error toast without a clipboard. */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), CONFIRM_MS);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = () => {
    if (!navigator.clipboard) return toast(t("common.copyFailed"), "error");
    navigator.clipboard.writeText(value).then(
      () => setCopied(true),
      () => toast(t("common.copyFailed"), "error"),
    );
  };
  const name = copied ? t("common.copied") : (label ?? t("common.copy"));
  return (
    <button type="button" className="btn btn--ghost btn--icon btn--compact" aria-label={name} title={name} onClick={copy}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
