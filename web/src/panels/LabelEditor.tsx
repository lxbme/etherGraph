import { useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { NewLabelDto } from "../api/generated/NewLabelDto";
import { qk } from "../api/queryClient";
import { t, useT } from "../i18n";
import { toast } from "../shell/Toasts";

type Category = NewLabelDto["category"];

/** The category ids in UI order; the one list the editor, tags and tooltip share. */
export const CATEGORIES: Category[] = [
  "cex", "dex", "defi", "bridge", "mixer", "scam", "sanctioned", "hacker", "mev", "fund", "nft", "staking", "other",
];

/** Categories with their own hue (every one but "other"). */
export const HUED_CATEGORIES: readonly string[] = CATEGORIES.filter((c) => c !== "other");

/** The dataset a label came from (`import:eth-labels` gives `eth-labels`); null for a user label. */
export const labelDataset = (source: string): string | null => (source.startsWith("import:") ? source.slice("import:".length) : null);

/** Provenance text for an imported label; null for a user label. */
export function labelProvenance(source: string): string | null {
  const ds = labelDataset(source);
  if (ds === null) return null;
  return ds === "eth-labels-xchain" ? t("label.source.xchain", { dataset: "eth-labels" }) : t("label.source.dataset", { dataset: ds });
}

/** Localised category name; an id from a newer server is shown as-is. */
export const categoryName = (c: string): string => ((CATEGORIES as string[]).includes(c) ? t(`category.${c as Category}`) : c);

const MAX = 64;
/** Label requests in flight at once when one label goes to many addresses. */
const MAX_IN_FLIGHT = 4;

/** Runs `run` over `items` with at most `limit` at a time; resolves with each item's error (or null), in order. */
async function settleLimited<T>(items: T[], limit: number, run: (item: T) => Promise<unknown>): Promise<unknown[]> {
  const errors: unknown[] = items.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        await run(items[i]!);
      } catch (e) {
        errors[i] = e ?? new Error("label request failed");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return errors;
}

/** Adds one label (same text and category) to each of `addresses`; one toast with the count once all are saved. */
export function LabelEditor({ addresses, onClose }: { addresses: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const tr = useT();
  const textId = useId();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<Category>("other");
  /** Addresses an earlier, partly failed submit already gave this text and category: a retry skips them. */
  const done = useRef({ key: "", addrs: new Set<string>() });
  const trimmed = text.trim();
  const len = [...trimmed].length;
  const valid = len >= 1 && len <= MAX;

  const add = useMutation({
    mutationFn: async () => {
      const key = `${category}\n${trimmed}`;
      if (done.current.key !== key) done.current = { key, addrs: new Set() };
      const saved = done.current.addrs;
      const todo = addresses.filter((a) => !saved.has(a));
      const errors = await settleLimited(todo, MAX_IN_FLIGHT, async (address) => {
        await api.addLabel({ address, text: trimmed, category });
        saved.add(address);
      });
      await Promise.all([
        ...todo.map((a) => qc.invalidateQueries({ queryKey: qk.address(a) })),
        qc.invalidateQueries({ queryKey: ["graph"] }),
        qc.invalidateQueries({ queryKey: ["tx"] }),
      ]);
      const first = errors.find((e) => e !== null);
      if (first !== undefined) throw first;
    },
    onSuccess: () => {
      toast(t("label.saved", { count: addresses.length }));
      onClose();
    },
  });

  return (
    <form
      className="label-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !add.isPending) add.mutate();
      }}
    >
      <div className="label-editor__field">
        <span className="label-editor__head">
          <label htmlFor={textId}>{tr("label.text")}</label>
          <span className={len > MAX ? "label-editor__count label-editor__count--bad num" : "label-editor__count num"}>
            {len}/{MAX}
          </span>
        </span>
        <input
          id={textId}
          className="input input--compact"
          aria-invalid={len > MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </div>
      <label className="label-editor__field">
        {tr("label.category")}
        <select className="input input--compact" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{tr(`category.${c}`)}</option>
          ))}
        </select>
      </label>
      {add.isError && <div className="detail__error" role="alert">{messageFor(add.error)}</div>}
      <div className="label-editor__actions">
        <button type="button" className="btn btn--compact" onClick={onClose}>{tr("common.cancel")}</button>
        <button type="submit" className="btn btn--compact btn--primary" disabled={!valid || add.isPending}>{tr("label.add")}</button>
      </div>
    </form>
  );
}
