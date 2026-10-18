/** Every documentation topic the info panel can open; the pages are in i18n/docs.en.ts and docs.zh.ts. */
export const DOC_IDS = ["tx-legacy", "eip-2930", "eip-1559", "eip-4844", "eip-7702", "erc-20", "erc-721", "erc-1155", "native-eth"] as const;
export type DocId = (typeof DOC_IDS)[number];

const EIP = (n: number) => `https://eips.ethereum.org/EIPS/eip-${n}`;

/** The external specification of each topic. */
export const DOC_LINKS: Record<DocId, string> = {
  "tx-legacy": EIP(155),
  "eip-2930": EIP(2930),
  "eip-1559": EIP(1559),
  "eip-4844": EIP(4844),
  "eip-7702": EIP(7702),
  "erc-20": EIP(20),
  "erc-721": EIP(721),
  "erc-1155": EIP(1155),
  "native-eth": "https://ethereum.org/en/developers/docs/intro-to-ether/",
};
