import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { NewLabelDto } from "../api/generated/NewLabelDto";
import { qk } from "../api/queryClient";
import { t, useT } from "../i18n";

type Category = NewLabelDto["category"];

export const CATEGORIES: Category[] = ["exchange", "defi", "bridge", "mixer", "scam", "sanctioned", "other"];

/** Localised category name; an id from a newer server is shown as-is. */
export const categoryName = (c: string): string => ((CATEGORIES as string[]).includes(c) ? t(`category.${c as Category}`) : c);

const MAX = 64;

export function LabelEditor({ address, onClose }: { address: string; onClose: () => void }) {
  const qc = useQueryClient();
  const tr = useT();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<Category>("other");
  const trimmed = text.trim();
  const len = [...trimmed].length;
  const valid = len >= 1 && len <= MAX;

  const add = useMutation({
    mutationFn: () => api.addLabel({ address, text: trimmed, category }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.address(address) }),
        qc.invalidateQueries({ queryKey: ["graph"] }),
      ]);
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
      <label>
        {tr("label.text")}
        <input value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </label>
      <span className={len > MAX ? "label-editor__count label-editor__count--bad" : "label-editor__count"}>
        {len}/{MAX}
      </span>
      <label>
        {tr("label.category")}
        <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{tr(`category.${c}`)}</option>
          ))}
        </select>
      </label>
      {add.isError && <div className="detail__error" role="alert">{messageFor(add.error)}</div>}
      <div className="label-editor__actions">
        <button type="submit" disabled={!valid || add.isPending}>{tr("label.add")}</button>
        <button type="button" onClick={onClose}>{tr("common.cancel")}</button>
      </div>
    </form>
  );
}
