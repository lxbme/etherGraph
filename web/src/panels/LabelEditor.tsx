import { useId, useState } from "react";
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
  const textId = useId();
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
