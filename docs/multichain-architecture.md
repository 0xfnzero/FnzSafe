# FnzSafe 多链架构

FnzSafe 的多链层以链族适配器、CAIP 标识和显式能力声明为边界。目标不是把所有链伪装成 EVM，而是让账户模型链、UTXO 链和未来的对象模型链共享注册、发现与安全策略，同时保留各自的交易语义。

## 当前支持矩阵

| 链族 | 已注册网络 | 当前能力 | 支持级别 |
|---|---|---|---|
| Solana | Mainnet、Devnet、Testnet | 账户、余额、Token、转账、历史、签名、DApp、Squads、Program | Stable |
| EVM | Ethereum、BSC、Polygon、Arbitrum、Optimism、Base、Avalanche、Fantom、Linea、Scroll、zkSync Era、Robinhood Chain，以及 Sepolia、BSC Testnet、Polygon Amoy、Base Sepolia | 账户、原生币/ERC-20、转账、签名、移动端 EIP-1193；兼容 explorer 的网络提供历史能力；支持自定义 RPC | Beta |
| Bitcoin | Mainnet、Testnet | 默认使用兼容 TP/Phantom 私钥导入的 Taproot，可切换 BIP84 Native SegWit；支持地址校验、原生币余额、PSBT 交易预览与签名、RBF、广播；桌面钱包当前接入 Mainnet | Experimental |
| TRON | Mainnet、Shasta、Nile | BIP44 账户派生、Base58Check 地址校验、TRX 余额、带宽与账户激活费用预览、签名和广播；桌面钱包当前接入 Mainnet | Experimental |

统一目录当前包含 24 个网络。`GET /api/chains` 和移动端生产 Rust Bridge 的 `MobileBridge.multichainCatalog()` 返回同一份链描述；无原生库的开发 fallback 只返回覆盖四个链族的代表性测试目录，并移除 fallback 未实现的账户派生与地址校验能力声明。旧的 `/api/evm/chains` 与现有 Solana/EVM DTO 继续保留，作为兼容层。

身份层操作通过同一个 CAIP-2 注册表路由。桌面端提供 `POST /api/chains/address/normalize` 和 `POST /api/chains/account/derive`，移动端提供 `MobileBridge.normalizeMultichainAddress()` 和 `MobileBridge.deriveMultichainAccount()`。桌面派生请求使用既有加密请求体并在阻塞任务中执行；助记词进入服务层后立即移入可清零内存。移动开发 fallback 不伪造链地址或派生结果，这两个操作会明确返回 `unsupported`，生产构建则调用本地 Rust Bridge。

“网络已注册”不等于“所有钱包操作均已实现”。调用端必须读取 `capabilities`，只有声明了对应能力时才展示或调用功能。Bitcoin 和 TRON 已声明原生币余额与转账能力，并在桌面端接入 Mainnet；两者尚未声明 Token、历史、交易状态或 DApp 能力。

EVM 历史能力使用 Etherscan V2。只有启动时存在有效的 `FNZERO_SAFE_ETHERSCAN_API_KEY`，并且 explorer 域名与 CAIP-2 中的 EIP-155 chain ID 精确匹配，链描述才会声明 `transactions:history`；未配置 Key 时历史功能按不支持降级，而不会发布虚假能力。

EVM 网络不是一个可穷举集合。目前尚未作为内置网络维护的代表包括 Gnosis、Celo、Moonbeam、Cronos、Mantle、Blast、opBNB、Zora、Berachain、Sonic、Polygon zkEVM、Ronin、Aurora、Metis、Kava EVM、Arbitrum Nova、Sei EVM、HyperEVM 和 Monad。它们可以通过自定义 EVM RPC 配置尝试接入，但在完成保存前 `eth_chainId` 核验、链级回归测试和费用模型验证前，不视为 FnzSafe 正式支持的内置网络。

## 模块边界

- `crates/chain-core`：CAIP-2 `ChainId`、CAIP-10 `AccountId`、开放式 `ChainFamily`、能力标识、链描述、适配器契约和注册表。新增链族不需要修改中心枚举。
- `crates/app-services`：组装内置适配器，向桌面端和移动端提供统一目录；旧业务 API 仍由兼容层承接。
- `crates/evm-services`：EVM 账户、资产、交易、签名和 EIP-1193 逻辑，并提供 EVM 链适配器。
- `crates/bitcoin-services`：Bitcoin 派生、地址、Esplora 余额/UTXO、手续费、PSBT、本地签名与广播。
- `crates/tron-services`：TRON 派生、地址、账户资源、节点交易构建校验、本地签名与广播。

`ChainAdapter` 只定义所有链都能可靠实现的身份层操作。余额、交易构建、签名和广播不会被塞入一个最低公分母请求结构；后续应按能力接口挂接，并由 `ChainId` 路由到具体实现。

## 标识与不变量

- 链使用 CAIP-2，例如 Ethereum `eip155:1`、Solana Mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`、Bitcoin Mainnet `bip122:000000000019d6689c085ae165831e93`、TRON Mainnet `tron:728126428`。
- 账户使用 CAIP-10，即 `<chain-id>:<address>`。
- `ChainId`、`AccountId`、`ChainFamily` 和 `CapabilityId` 在构造与反序列化时执行相同校验，外部 JSON 不能绕过类型不变量。
- 助记词只在账户派生请求方向短暂传入 Rust：桌面端沿用加密请求体，移动端经本地 FFI 传递；响应、调试输出和日志均不得包含助记词或私钥，Rust 服务层接收后应尽快移入可清零内存。

## 能力发布规则

只有实现、测试并接入最终应用流程的能力才能写入链描述。至少满足以下条件后，才可声明 `transactions:transfer`：

1. 地址与网络校验完成；
2. 金额单位、手续费或资源消耗可预览；
3. 交易构建、签名、广播和状态查询完成；
4. 重放保护与链 ID/网络核验完成；
5. 桌面和移动确认界面不会隐藏关键签名字段；
6. 存在协议测试向量和错误路径测试。

## 后续实现顺序

### EVM 完整化

1. 自定义 RPC 保存前调用 `eth_chainId`，要求结果与用户配置严格一致。
2. 增加 EIP-2930/type-1、EIP-4844/type-3 的解析和预览策略；不支持签名时明确拒绝。
3. 将桌面 dApp Provider 补齐为 EIP-1193，并统一权限、链切换和签名预览。
4. 针对 L2 增加估算差异和 L1 data fee 展示，避免只显示执行层 gas。

### TRON 后续阶段

1. 引入官方 protobuf 数据结构，替换当前对节点返回 `raw_data_hex` 的严格校验边界。
2. 增加 TRC-20、收据和确认状态。
3. 扩展 energy、`fee_limit` 与冻结资源预览。
4. 支持 account permission 多签语义，再接入 TronLink 风格 Provider。

### Bitcoin 后续阶段

1. 增加交易确认状态和历史记录。
2. 扩展 PSBT 预览，展示输入来源与区块确认数。
3. 增加 BIP44 Legacy、BIP49 Nested SegWit 与更细粒度的选币策略。
4. 硬件钱包与多签继续复用 PSBT，不将 Bitcoin 强行映射为账户链 nonce 模型。

### 尚未支持的主要链族

Cosmos SDK、Polkadot/Substrate、Cardano、XRP Ledger、Stellar、NEAR、TON、Sui、Aptos 和其他 Move/Object 链目前都没有适配器。接入时应分别新增 crate，并先交付身份层与测试向量，再按该链的原生交易模型逐项发布能力。

接入新链族的最小验收项是：正式 CAIP-2 标识、明确的派生路径、地址格式与网络校验、密钥清零策略、已验证测试向量、准确的能力列表，以及桌面/移动统一目录可见。
