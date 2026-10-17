import type { TransferDto } from "../api/generated/TransferDto";
import type { MsgKey, useT } from "../i18n";

export type TransferKind = TransferDto["kind"];

/** Transfer kinds in display order; token standards have no translation and show as their upper-cased id. */
export const TRANSFER_KINDS: readonly { value: TransferKind; label: MsgKey | null }[] = [
  { value: "native", label: "kind.native" },
  { value: "internal", label: "kind.internal" },
  { value: "erc20", label: null },
  { value: "erc721", label: null },
  { value: "erc1155", label: null },
];

const LABELS = new Map(TRANSFER_KINDS.map((k) => [k.value as string, k.label]));

/** The label shared by the kind filter, coverage list and transfer table. */
export function transferKindName(kind: string, t: ReturnType<typeof useT>): string {
  const label = LABELS.get(kind);
  return label ? t(label) : kind.toUpperCase();
}
