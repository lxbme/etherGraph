import type { DocId } from "../panels/info/docs";
import type { docsEn } from "./docs.en";

/** Same shape as the English page: every string becomes `string`, every list keeps its length. */
type Widen<T> = T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> };

/** The zh dictionary must have every en doc, every field and the same number of paragraphs, fields and formulas. */
export type DocDictionary = { readonly [K in DocId]: Widen<(typeof docsEn)[K]> };

export const docsZh: DocDictionary = {
  "tx-legacy": {
    title: "传统交易",
    code: "EIP-155",
    status: "交易类型 0",
    introduced: "以太坊最初的交易格式；EIP-155 于 2016 年 11 月随 Spurious Dragon 硬分叉启用",
    summary: [
      "传统交易沿用以太坊最初的交易格式，早于 Berlin 硬分叉中由 EIP-2718 引入的类型化交易。本应用将其显示为类型 0。",
      "这类交易用单一的 gas 价格按每单位 gas 计费。2016 年 11 月随 Spurious Dragon 硬分叉启用的 EIP-155 把链 ID 编入签名的 v 值，这样，为某条链签名的交易就无法在另一条链上重放。",
    ],
    fields: [
      ["nonce", "发送方的交易序号。"],
      ["gasPrice", "发送方为每单位 gas 支付的价格，单位为 wei。"],
      ["gasLimit", "本交易最多可消耗的 gas 数量。"],
      ["to", "接收地址；创建合约时为空。"],
      ["value", "转出的 ETH 数量，单位为 wei。"],
      ["data", "调用合约时的调用数据，或创建合约时的初始化代码。"],
      ["v, r, s", "发送方的签名；在 EIP-155 下，v 同时携带链 ID。"],
    ],
    math: ["手续费 = gasUsed × gasPrice"],
    inThisApp: ["“概览”中的交易类型显示为 Legacy，并列出 Gas 价格和按上式计算的交易手续费。"],
  },
  "eip-2930": {
    title: "可选访问列表",
    code: "EIP-2930",
    status: "交易类型 1",
    introduced: "Berlin 硬分叉，2021 年 4 月 15 日",
    summary: [
      "EIP-2930 定义了类型 1 交易，于 2021 年 4 月 15 日随 Berlin 硬分叉上线。同批启用的还有定义类型化交易封装格式的 EIP-2718，以及上调首次访问账户或存储槽 gas 成本的 EIP-2929。",
      "类型 1 交易可以预先声明将要访问的地址和存储键。列表中的条目会被预热：交易为每个条目支付一笔较低的费用，而不是冷访问的成本。",
      "gas 的计价方式与传统交易相同，仍然只有一个 gas 价格。",
    ],
    fields: [
      ["chainId", "交易所属链的 ID。"],
      ["accessList", "预先声明的地址和存储键；列出的条目会被预热。"],
      ["nonce, gasPrice, gasLimit, to, value, data", "与传统交易相同。"],
    ],
    math: ["手续费 = gasUsed × gasPrice"],
    inThisApp: ["“概览”显示访问列表的条目数，以及按上式计算的交易手续费。"],
  },
  "eip-1559": {
    title: "手续费市场改革",
    code: "EIP-1559",
    status: "交易类型 2",
    introduced: "London 硬分叉，2021 年 8 月 5 日",
    summary: [
      "EIP-1559 改变了交易手续费的计算方式。自 2021 年 8 月 5 日 London 硬分叉起，每个区块都有一个由协议设定的基础费用。",
      "区块的 gas 目标是其 gas 上限的一半。上一个区块的用量高于目标时，基础费用上调；低于目标时则下调，每个区块的变动幅度最多 12.5%。",
      "基础费用会被燃烧。在此之上，发送方另付优先费给出块者，并用 maxFeePerGas 为每单位 gas 的总价设定上限；上限与实际价格之间的差额不会被收取。",
    ],
    fields: [
      ["maxFeePerGas", "发送方愿为每单位 gas 支付的最高总价，含基础费用和优先费。"],
      ["maxPriorityFeePerGas", "在基础费用之外，发送方愿为每单位 gas 付给出块者的最高优先费。"],
      ["chainId", "交易所属链的 ID。"],
      ["accessList", "需要预热的地址和存储键，同 EIP-2930。"],
    ],
    math: [
      "实际 gas 价格 = min(maxFeePerGas, baseFee + maxPriorityFeePerGas)",
      "手续费 = gasUsed × 实际 gas 价格",
      "燃烧费用 = gasUsed × baseFee",
      "优先费（归出块者）= gasUsed × (实际 gas 价格 − baseFee)",
      "节省费用 = gasUsed × (maxFeePerGas − 实际 gas 价格)",
    ],
    inThisApp: [
      "“概览”显示基础费（取自区块）以及最高费用和最高优先费（取自交易），燃烧费用、节省费用和交易手续费则按上述公式计算。",
      "这类交易的价格一行显示为“实际 Gas 价格”。",
    ],
  },
  "eip-4844": {
    title: "分片 Blob 交易",
    code: "EIP-4844",
    status: "交易类型 3",
    introduced: "Dencun 升级（Cancun + Deneb），2024 年 3 月 13 日",
    summary: [
      "EIP-4844 又称 Proto-Danksharding，引入了携带 blob 数据的交易，于 2024 年 3 月 13 日随 Dencun 升级（Cancun + Deneb）上线，主要供 Rollup 以较低成本发布数据。",
      "每个 blob 由 4096 个 32 字节的域元素组成，共 128 KiB。blob 由共识层客户端保存，约 18 天（4096 个 epoch）后即被裁剪。执行层看不到 blob 数据本身，只能看到由其 KZG 承诺派生的 blobVersionedHashes。",
      "blob 有独立的 gas 市场：每个 blob 消耗 131072 blob gas，按单独的 blob 基础费用计价，这部分费用同样会被燃烧。每个区块的目标 blob 数和最大 blob 数都是协议参数，后来由 Pectra 中的 EIP-7691 上调为目标 6 个、最多 9 个。",
      "blob 交易必须填写 to，因此不能用来创建合约。",
    ],
    fields: [
      ["maxFeePerBlobGas", "发送方愿为每单位 blob gas 支付的最高价格。"],
      ["blobVersionedHashes", "每个 blob 对应一个版本化哈希，由其 KZG 承诺派生。"],
      ["maxFeePerGas, maxPriorityFeePerGas", "普通 gas 的费用字段，同 EIP-1559。"],
      ["to", "必填；blob 交易不能创建合约。"],
    ],
    math: [
      "blob 大小 = 4096 × 32 字节 = 128 KiB",
      "每个 blob 的 blob gas = 131072",
      "blob 费用 = blobGasUsed × blobGasPrice",
    ],
    inThisApp: [
      "“概览”显示 Blob gas 用量、Blob gas 价格和 Blob 费用。",
      "普通 gas 费用的显示方式与 EIP-1559 交易相同。",
    ],
  },
  "eip-7702": {
    title: "为 EOA 设置代码",
    code: "EIP-7702",
    status: "交易类型 4",
    introduced: "Pectra 升级（Prague + Electra），2025 年 5 月 7 日",
    summary: [
      "EIP-7702 于 2025 年 5 月 7 日随 Pectra 升级（Prague + Electra）上线，让外部账户（EOA）在保留自身私钥和地址的同时运行合约代码。",
      "类型 4 交易带有一个授权列表。每条授权由一个 EOA 签名，把该账户的代码设为委托标识：0xef0100 后接一个合约地址。此后，该 EOA 运行的就是那个合约的代码。",
      "委托会一直有效，直到被新的授权替换；委托给零地址即可清除。",
      "借此，普通账户也能实现批量调用、gas 代付和受限权限。费用规则与 EIP-1559 相同，且必须填写 to。",
    ],
    fields: [
      ["authorizationList", "授权列表，每条授权是由 EOA 签名的元组 (chainId, address, nonce, yParity, r, s)。"],
      ["address", "授权中的合约地址：EOA 将运行该合约的代码。"],
      ["yParity, r, s", "授权中 EOA 的签名。"],
      ["maxFeePerGas, maxPriorityFeePerGas", "gas 费用字段，同 EIP-1559。"],
      ["to", "必填。"],
    ],
    math: ["委托标识 = 0xef0100 || address"],
    inThisApp: ["“概览”中的交易类型显示为 EIP-7702，费用的显示方式与 EIP-1559 交易相同。"],
  },
  "erc-20": {
    title: "同质化代币",
    code: "ERC-20",
    status: "代币标准",
    introduced: "EIP-20，2015 年",
    summary: [
      "ERC-20 于 2015 年以 EIP-20 提出，是同质化代币的标准接口：同一种代币的任意两个单位都可以互换。",
      "数量始终是整数，decimals 只决定显示方式：显示值等于原始数量除以 10^decimals。name、symbol 和 decimals 都是可选的元数据。",
      "铸造就是从零地址发出的 Transfer，销毁就是转入零地址的 Transfer。",
    ],
    fields: [
      ["totalSupply", "代币的总供应量。"],
      ["balanceOf", "某个地址的余额。"],
      ["transfer", "从调用者账户向另一个地址转出代币。"],
      ["transferFrom", "在所有者授权的额度内，代其转出代币。"],
      ["approve", "设定某个支出方可从调用者余额中转走的额度。"],
      ["allowance", "支出方还能代所有者转出的剩余额度。"],
      ["Transfer(from, to, value)", "代币发生转移时触发的事件，铸造和销毁也包括在内。"],
      ["Approval(owner, spender, value)", "设定授权额度时触发的事件。"],
      ["name, symbol, decimals", "可选元数据；decimals 只影响数量的显示方式。"],
    ],
    math: ["显示值 = 原始数量 ÷ 10^decimals"],
    inThisApp: [
      "代币转账来自 Transfer 事件日志。",
      "名称、符号和小数位数已知时，资产详情会显示出来。",
    ],
  },
  "erc-721": {
    title: "非同质化代币",
    code: "ERC-721",
    status: "代币标准",
    introduced: "EIP-721，2018 年",
    summary: [
      "ERC-721 于 2018 年以 EIP-721 提出，是非同质化代币（NFT）的标准。每个代币以 uint256 类型的 tokenId 标识，独一无二，且只有一个所有者。",
      "每次转移都会触发 Transfer(from, to, tokenId) 事件，其中 tokenId 是索引参数。name、symbol 和 tokenURI 是可选元数据。",
    ],
    fields: [
      ["ownerOf", "某个 tokenId 的所有者。"],
      ["balanceOf", "某个地址持有的该合约代币数量。"],
      ["safeTransferFrom, transferFrom", "把代币转给新的所有者。"],
      ["approve", "授权另一个地址转移某一个代币。"],
      ["getApproved", "某一个代币的被授权地址。"],
      ["setApprovalForAll", "授权某个操作者转移调用者在该合约中的全部代币。"],
      ["isApprovedForAll", "某个操作者是否获准转移所有者的全部代币。"],
      ["Transfer(from, to, tokenId)", "代币易主时触发的事件；tokenId 为索引参数。"],
      ["name, symbol, tokenURI", "可选元数据。"],
    ],
    inThisApp: [
      "tokenId 可能是非常大的数，因此关系图的连线上会缩写显示。",
      "从转账打开资产详情时，会显示完整的 tokenId，并可一键复制。",
    ],
  },
  "erc-1155": {
    title: "多代币标准",
    code: "ERC-1155",
    status: "代币标准",
    introduced: "EIP-1155，2018 年",
    summary: [
      "ERC-1155 于 2018 年以 EIP-1155 提出，允许一个合约管理多种 tokenId，每一种既可以是同质化代币，也可以是非同质化代币。",
      "批量函数可以一次转移多个 id，TransferBatch 事件则记录这类批量转移。每个 id 的元数据通过 uri(id) 获取。",
    ],
    fields: [
      ["balanceOf(account, id)", "某个账户持有某个 tokenId 的余额。"],
      ["balanceOfBatch", "一次调用查询多个余额。"],
      ["safeTransferFrom", "转移某个 tokenId 的一定数量。"],
      ["safeBatchTransferFrom", "一次转移多个 tokenId 的相应数量。"],
      ["setApprovalForAll", "授权某个操作者转移调用者在该合约中的全部代币。"],
      ["TransferSingle(operator, from, to, id, value)", "转移单个 id 时触发的事件。"],
      ["TransferBatch(operator, from, to, ids, values)", "批量转移多个 id 时触发的事件。"],
      ["uri(id)", "某个 tokenId 元数据的所在位置。"],
    ],
    inThisApp: ["当该合约的转账属于 ERC-1155 时，资产详情会链接到本页；从转账打开时还会显示 tokenId。"],
  },
  "native-eth": {
    title: "以太币",
    code: "ETH",
    status: "原生货币",
    introduced: "协议内置",
    summary: [
      "以太币（ETH）是以太坊的原生货币。它不是代币合约：每个账户的余额都由协议本身记录，单位为 wei。",
      "ETH 可以作为交易的 value 转移，也可以经由合约之间的内部调用转移，本应用把后者显示为内部转账。gas 费用以 ETH 支付。",
      "WETH（0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2）是 ETH 的 ERC-20 封装代币。",
    ],
    fields: [
      ["wei", "记录余额所用的单位。"],
      ["value", "交易转出的 ETH，单位为 wei。"],
      ["内部转账", "合约之间调用时转移的 ETH。"],
      ["gas 费用", "以 ETH 支付。"],
      ["WETH", "ETH 的 ERC-20 封装代币。"],
    ],
    math: ["1 ETH = 10^18 wei"],
    inThisApp: [
      "金额和手续费均以 ETH 显示。",
      "内部转账会出现在地址的转账列表中，以及交易的“内部调用”标签页里。",
    ],
  },
};
