import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import { messageFor } from "../api/errors";
import type { NewLabelDto } from "../api/generated/NewLabelDto";
import { qk } from "../api/queryClient";

type Category = NewLabelDto["category"];

export const CATEGORIES: { value: Category; label: string }[] = [
  { value: "exchange", label: "交易所" },
  { value: "defi", label: "DeFi" },
  { value: "bridge", label: "跨链桥" },
  { value: "mixer", label: "混币器" },
  { value: "scam", label: "诈骗" },
  { value: "sanctioned", label: "制裁" },
  { value: "other", label: "其它" },
];

export const categoryName = (c: string) => CATEGORIES.find((x) => x.value === c)?.label ?? c;

const MAX = 64;

export function LabelEditor({ address, onClose }: { address: string; onClose: () => void }) {
  const qc = useQueryClient();
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
        标签文本
        <input value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </label>
      <span className={len > MAX ? "label-editor__count label-editor__count--bad" : "label-editor__count"}>
        {len}/{MAX}
      </span>
      <label>
        类别
        <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </label>
      {add.isError && <div className="detail__error" role="alert">{messageFor(add.error)}</div>}
      <div className="label-editor__actions">
        <button type="submit" disabled={!valid || add.isPending}>添加</button>
        <button type="button" onClick={onClose}>取消</button>
      </div>
    </form>
  );
}
