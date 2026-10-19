import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { MsgKey } from "../i18n";

const STANDARD_KEYS: Record<NonNullable<NodeSummaryDto["token"]>["standard"], MsgKey> = {
  erc20: "node.tag.erc20",
  erc721: "node.tag.erc721",
  erc1155: "node.tag.erc1155",
};

/** What a node is beyond its kind, shown next to it: its token standard, then proxy (none for files saved before these facts). */
export function nodeTags(n: Pick<NodeSummaryDto, "token" | "is_proxy">): MsgKey[] {
  const tags: MsgKey[] = [];
  if (n.token) tags.push(STANDARD_KEYS[n.token.standard]);
  if (n.is_proxy) tags.push("node.tag.proxy");
  return tags;
}

/** The label categories to show: the imported catch-all "other" says nothing once a node has a tag. */
export const shownCategories = (categories: string[], tags: readonly MsgKey[]): string[] =>
  tags.length > 0 ? categories.filter((c) => c !== "other") : categories;
