import type { DocId } from "../panels/info/docs";

/** The text of one documentation page; its external link is `DOC_LINKS[id]`, its code is the info panel header. */
export interface DocText {
  readonly title: string;
  /** The standard's code, e.g. "EIP-1559". */
  readonly code: string;
  readonly status: string;
  /** The fork and date that introduced it. */
  readonly introduced: string;
  /** Paragraphs. */
  readonly summary: readonly string[];
  /** [name, meaning] pairs: transaction fields, or a token standard's functions and events. */
  readonly fields: readonly (readonly [name: string, meaning: string])[];
  /** Formulas, one per line, shown in monospace. */
  readonly math?: readonly string[];
  /** Where the page's subject shows up in etherGraph. */
  readonly inThisApp: readonly string[];
}

export const docsEn = {
  "tx-legacy": {
    title: "Legacy transactions",
    code: "EIP-155",
    status: "Transaction type 0",
    introduced: "The original format; EIP-155 since Spurious Dragon, November 2016",
    summary: [
      "A legacy transaction uses Ethereum's original transaction format, from before typed transactions were introduced by EIP-2718 in the Berlin hard fork. This app shows it as type 0.",
      "It is priced with a single gas price per unit of gas. EIP-155, activated in the Spurious Dragon hard fork in November 2016, folds the chain ID into the signature's v value, so a transaction signed for one chain cannot be replayed on another.",
    ],
    fields: [
      ["nonce", "Sequence number of the sender's transactions."],
      ["gasPrice", "Price the sender pays per unit of gas, in wei."],
      ["gasLimit", "Maximum amount of gas the transaction may use."],
      ["to", "Recipient address; empty when the transaction creates a contract."],
      ["value", "Amount of ETH sent, in wei."],
      ["data", "Call data for a contract, or the init code of a contract being created."],
      ["v, r, s", "The sender's signature. Under EIP-155, v also carries the chain ID."],
    ],
    math: ["fee = gasUsed × gasPrice"],
    inThisApp: ["Overview labels the type “Legacy” and shows the gas price and the transaction fee computed as above."],
  },
  "eip-2930": {
    title: "Optional access lists",
    code: "EIP-2930",
    status: "Transaction type 1",
    introduced: "Berlin hard fork, 15 April 2021",
    summary: [
      "EIP-2930 defines type 1 transactions. It went live in the Berlin hard fork on 15 April 2021, alongside EIP-2718, which defines the typed transaction envelope, and EIP-2929, which raised the gas cost of the first access to an account or storage slot.",
      "A type 1 transaction can declare up front the addresses and storage keys it will touch. Listed items are pre-warmed: the transaction pays a smaller per-item cost for them instead of the cold-access cost.",
      "Gas is still priced with a single gas price, as in a legacy transaction.",
    ],
    fields: [
      ["chainId", "ID of the chain the transaction belongs to."],
      ["accessList", "Addresses and storage keys declared up front; each listed item is pre-warmed."],
      ["nonce, gasPrice, gasLimit, to, value, data", "As in a legacy transaction."],
    ],
    math: ["fee = gasUsed × gasPrice"],
    inThisApp: ["Overview shows the number of access list entries and the transaction fee computed as above."],
  },
  "eip-1559": {
    title: "Fee market change",
    code: "EIP-1559",
    status: "Transaction type 2",
    introduced: "London hard fork, 5 August 2021",
    summary: [
      "EIP-1559 changed how transaction fees work. Since the London hard fork on 5 August 2021, every block has a base fee set by the protocol.",
      "A block's gas target is half its gas limit. If the previous block used more gas than the target, the base fee goes up; if it used less, the base fee goes down — by at most 12.5% per block.",
      "The base fee is burned. On top of it the sender offers a priority fee to the block producer, and caps the total price per unit of gas with maxFeePerGas; the difference between that cap and the price actually paid is never charged.",
    ],
    fields: [
      ["maxFeePerGas", "Most the sender will pay per unit of gas, base fee and priority fee included."],
      ["maxPriorityFeePerGas", "Most the sender will pay per unit of gas to the block producer, on top of the base fee."],
      ["chainId", "ID of the chain the transaction belongs to."],
      ["accessList", "Addresses and storage keys to pre-warm, as in EIP-2930."],
    ],
    math: [
      "effective gas price = min(maxFeePerGas, baseFee + maxPriorityFeePerGas)",
      "fee = gasUsed × effective gas price",
      "burnt = gasUsed × baseFee",
      "priority fee (to the block producer) = gasUsed × (effective gas price − baseFee)",
      "savings = gasUsed × (maxFeePerGas − effective gas price)",
    ],
    inThisApp: [
      "Overview shows the base fee (from the block) and the max fee and max priority fee (from the transaction); the burnt fees, savings and transaction fee are computed with the formulas above.",
      "For these transactions the price row reads “Effective gas price”.",
    ],
  },
  "eip-4844": {
    title: "Shard blob transactions",
    code: "EIP-4844",
    status: "Transaction type 3",
    introduced: "Dencun upgrade (Cancun + Deneb), 13 March 2024",
    summary: [
      "EIP-4844, known as proto-danksharding, introduced transactions that carry blobs of data. It went live in the Dencun upgrade (Cancun + Deneb) on 13 March 2024 and is used mainly by rollups to post data cheaply.",
      "A blob is 4096 field elements of 32 bytes each, 128 KiB in all. Blobs are held by consensus clients and pruned after about 18 days (4096 epochs). The execution layer never sees the data itself, only blobVersionedHashes derived from the blobs' KZG commitments.",
      "Blobs have a gas market of their own: each blob costs 131072 blob gas, priced by a separate blob base fee that is burned as well. The target and maximum number of blobs per block are protocol parameters; Pectra's EIP-7691 later raised them to a target of 6 and a maximum of 9.",
      "A blob transaction must set to, so it cannot create a contract.",
    ],
    fields: [
      ["maxFeePerBlobGas", "Most the sender will pay per unit of blob gas."],
      ["blobVersionedHashes", "One versioned hash per blob, derived from its KZG commitment."],
      ["maxFeePerGas, maxPriorityFeePerGas", "Fees for ordinary gas, as in EIP-1559."],
      ["to", "Must be set; a blob transaction cannot create a contract."],
    ],
    math: [
      "blob size = 4096 × 32 bytes = 128 KiB",
      "blob gas per blob = 131072",
      "blob fee = blobGasUsed × blobGasPrice",
    ],
    inThisApp: [
      "Overview shows the blob gas used, blob gas price and blob fee.",
      "Ordinary gas fees are shown as for an EIP-1559 transaction.",
    ],
  },
  "eip-7702": {
    title: "Set code for EOAs",
    code: "EIP-7702",
    status: "Transaction type 4",
    introduced: "Pectra upgrade (Prague + Electra), 7 May 2025",
    summary: [
      "EIP-7702 went live in the Pectra upgrade (Prague + Electra) on 7 May 2025. It lets an externally owned account (EOA) run a contract's code while keeping its own key and address.",
      "A type 4 transaction carries an authorization list. Each authorization is signed by an EOA and sets that account's code to a delegation designator: 0xef0100 followed by a contract address. From then on the EOA runs that contract's code.",
      "The delegation stays until another authorization replaces it; delegating to the zero address clears it.",
      "This makes batching, gas sponsorship and limited permissions possible for ordinary accounts. Fees work as in EIP-1559, and to must be set.",
    ],
    fields: [
      ["authorizationList", "The authorizations, each a tuple (chainId, address, nonce, yParity, r, s) signed by an EOA."],
      ["address", "In an authorization: the contract whose code the EOA will run."],
      ["yParity, r, s", "In an authorization: the EOA's signature."],
      ["maxFeePerGas, maxPriorityFeePerGas", "Gas fees, as in EIP-1559."],
      ["to", "Must be set."],
    ],
    math: ["delegation designator = 0xef0100 || address"],
    inThisApp: ["Overview labels the type “EIP-7702” and shows its fees as for an EIP-1559 transaction."],
  },
  "erc-20": {
    title: "Fungible tokens",
    code: "ERC-20",
    status: "Token standard",
    introduced: "EIP-20, 2015",
    summary: [
      "ERC-20, proposed as EIP-20 in 2015, is the standard interface for fungible tokens: any unit of a token is interchangeable with any other.",
      "Amounts are always integers. decimals only says how to display them: the shown value is the raw amount divided by 10^decimals. name, symbol and decimals are all optional metadata.",
      "Minting is a Transfer from the zero address, and burning is a Transfer to it.",
    ],
    fields: [
      ["totalSupply", "Total amount of the token in existence."],
      ["balanceOf", "Balance of an address."],
      ["transfer", "Sends tokens from the caller to another address."],
      ["transferFrom", "Sends tokens on an owner's behalf, within the allowance the owner approved."],
      ["approve", "Sets how much a spender may transfer from the caller's balance."],
      ["allowance", "How much a spender may still transfer on an owner's behalf."],
      ["Transfer(from, to, value)", "Event emitted whenever tokens move, mints and burns included."],
      ["Approval(owner, spender, value)", "Event emitted when an allowance is set."],
      ["name, symbol, decimals", "Optional metadata; decimals only affects how amounts are displayed."],
    ],
    math: ["shown value = raw ÷ 10^decimals"],
    inThisApp: [
      "Token transfers come from Transfer logs.",
      "Asset details show the name, symbol and decimals when they are known.",
    ],
  },
  "erc-721": {
    title: "Non-fungible tokens",
    code: "ERC-721",
    status: "Token standard",
    introduced: "EIP-721, 2018",
    summary: [
      "ERC-721, proposed as EIP-721 in 2018, is the standard for non-fungible tokens (NFTs). Each token is identified by a uint256 tokenId, is unique, and has exactly one owner.",
      "Every transfer emits Transfer(from, to, tokenId), with the id indexed. name, symbol and tokenURI are optional metadata.",
    ],
    fields: [
      ["ownerOf", "Owner of a token id."],
      ["balanceOf", "Number of the contract's tokens an address owns."],
      ["safeTransferFrom, transferFrom", "Move a token to a new owner."],
      ["approve", "Lets another address transfer one specific token."],
      ["getApproved", "The address approved for one specific token."],
      ["setApprovalForAll", "Lets an operator transfer all of the caller's tokens in this contract."],
      ["isApprovedForAll", "Whether an operator may transfer all of an owner's tokens."],
      ["Transfer(from, to, tokenId)", "Event emitted when a token changes owner; tokenId is indexed."],
      ["name, symbol, tokenURI", "Optional metadata."],
    ],
    inThisApp: [
      "Token ids can be very large numbers, so graph edges show them shortened.",
      "Opening the asset from a transfer shows the full token id, with a copy button.",
    ],
  },
  "erc-1155": {
    title: "Multi-token standard",
    code: "ERC-1155",
    status: "Token standard",
    introduced: "EIP-1155, 2018",
    summary: [
      "ERC-1155, proposed as EIP-1155 in 2018, lets a single contract manage many token ids, each of which can be fungible or non-fungible.",
      "Batch functions move several ids at once, and TransferBatch records such a move. Each id's metadata comes from uri(id).",
    ],
    fields: [
      ["balanceOf(account, id)", "Balance of one token id for an account."],
      ["balanceOfBatch", "Several balances in one call."],
      ["safeTransferFrom", "Moves an amount of one token id."],
      ["safeBatchTransferFrom", "Moves amounts of several token ids at once."],
      ["setApprovalForAll", "Lets an operator transfer all of the caller's tokens in this contract."],
      ["TransferSingle(operator, from, to, id, value)", "Event emitted for a transfer of one id."],
      ["TransferBatch(operator, from, to, ids, values)", "Event emitted for a transfer of several ids."],
      ["uri(id)", "Where the metadata of a token id is found."],
    ],
    inThisApp: ["Asset details link here when a contract is identified as ERC-1155, and show the token id when opened from a transfer."],
  },
  "native-eth": {
    title: "Ether",
    code: "ETH",
    status: "Native currency",
    introduced: "Built into the protocol",
    summary: [
      "Ether (ETH) is Ethereum's native currency. It is not a token contract: the protocol itself keeps every account's balance, in wei.",
      "ETH moves as a transaction's value, or through internal calls between contracts, which this app shows as internal transfers. Gas fees are paid in ETH.",
      "WETH (0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2) is an ERC-20 wrapper for ETH.",
    ],
    fields: [
      ["wei", "The unit balances are kept in."],
      ["value", "The ETH a transaction sends, in wei."],
      ["internal transfer", "ETH moved by a call between contracts."],
      ["gas fee", "Paid in ETH."],
      ["WETH", "The ERC-20 wrapper for ETH."],
    ],
    math: ["1 ETH = 10^18 wei"],
    inThisApp: [
      "Values and fees are shown in ETH.",
      "Internal transfers are listed with an address's transfers and on a transaction's Internal Calls tab.",
    ],
  },
} as const satisfies Record<DocId, DocText>;
