# FnzSafe 对 MetaMask 的可借鉴设计

本文记录 FnzSafe 可以借鉴的公开钱包设计模式。它不是复制清单。MetaMask Extension 当前许可证对商业使用和衍生作品有限制，因此 FnzSafe 只采用公开标准、通用架构原则和独立实现，不复制其源代码、品牌资产或界面素材。

## 资产和价格并不是同一个接口

MetaMask Core 的公开 `assets-controllers` 将资产功能拆成账户跟踪、代币候选列表、代币检测、余额、原生币汇率、ERC-20 汇率、NFT、DeFi 仓位等控制器。这说明“获取钱包所有代币”不能依赖一次标准 JSON-RPC 调用：EVM 节点没有按持有人枚举所有 ERC-20 的标准方法。

FnzSafe 采用以下独立边界：

```text
PortfolioController
  -> TokenDiscoveryProvider      候选代币和持仓索引
  -> BalanceProvider             链上余额或批量 balanceOf 校验
  -> TokenMetadataProvider       名称、精度、Logo 和验证状态
  -> PriceProvider               按链及合约地址获取价格
  -> SpamRiskProvider            垃圾币、钓鱼文本和可疑空投
  -> NFTProvider                 NFT 发现和元数据
  -> DeFiPositionProvider        借贷、质押和 LP 仓位
```

各层允许独立失败、缓存和刷新。价格服务失败时仍展示链上余额；索引器失败时仍展示原生币和手工添加的代币；过期价格不能参与总资产计算。

## FnzSafe 的链级方案

| 链族 | 持仓发现 | 余额依据 | 价格键 |
|---|---|---|---|
| EVM | 默认查询 Blockscout/Alchemy/Moralis/Covalent 等可替换索引器，用户可关闭 | 原生币用 RPC；关键 ERC-20 可用 Multicall3 复核 | `<chain-namespace>:<contract-address>` |
| Solana | `getTokenAccountsByOwner` 同时查询 SPL Token 与 Token-2022 | 所选 Solana RPC | `solana:<mint>` |
| Bitcoin | Esplora/Electrum 扫描派生地址和 UTXO | UTXO 集 | `coingecko:bitcoin` |
| TRON | TronGrid 或自建索引器发现 TRC-20 | TRON 节点复核 TRX/TRC-20 | `tron:<contract-address>` |

禁止只按 symbol 匹配价格，因为不同链、甚至同一条链上可以存在大量同名代币。每个价格必须带来源、时间戳和失效判断。FnzSafe 第一阶段使用 DefiLlama 的地址型价格键，并保留更换或增加第二供应商的接口。

## 隐私默认值

自动资产发现会把公开钱包地址发送给索引服务，可能把多个链上的地址关联为同一用户。FnzSafe 默认开启“增强代币发现”，与主流钱包的开箱体验保持一致，同时在设置中明确显示数据披露并允许用户关闭。发现到的普通和未验证代币默认展示；命中垃圾币规则的资产也不直接隐藏，而是显示风险标签并排到列表最后。价格查询只包含公开的币种、合约或 mint 标识，不包含钱包地址。后续可增加自建代理、请求分批、供应商选择和完全本地模式。

## 值得继续实现的功能

优先级最高：

1. 交易模拟和签名前资产变化预览，显示将支出、将收到、授权额度和失败原因。
2. ERC-20 无限授权、Permit/Permit2、NFT `setApprovalForAll` 和可疑 spender 风险提示。
3. 每个站点分别管理账户、链和方法权限，而不只是一个“已连接”布尔值。
4. 地址簿、剪贴板篡改检测、地址投毒提示和首次收款地址加强确认。
5. EIP-1559 费用档位、L2 数据费、pending 交易加速/取消和 nonce 管理。
6. 硬件钱包、watch-only 账户、备份验证和恢复短语复查。
7. NFT 垃圾内容隐藏、代币风险标签、钓鱼域名与签名域不一致提示。

需要审计后再启用：

- Passkey/智能账户：采用成熟的 ERC-4337 实现，并明确 bundler、paymaster 和恢复信任边界。
- Google 登录/社交恢复：OAuth 只能证明身份，不能直接生成或解锁私钥；必须使用经过审计的 MPC/门限密钥方案、PKCE、严格 redirect allowlist、恢复延迟和撤销机制。
- 插件生态：在能力权限、隔离、升级签名和供应链审计成熟前，不开放类似 Snaps 的第三方执行环境。

## 安全性取舍

值得借鉴的是“最小权限 + 明确确认 + 分层控制器”，不是降低 FnzSafe 的现有密钥保护。FnzSafe 继续保持密钥只在受信后台短时解密、页面脚本永不接触私钥或全局密码、按来源授权、自动锁定和敏感操作逐次确认。后续需要补充交易模拟、防钓鱼数据、硬件钱包和独立安全审计。

扩展端已经加入第一阶段交易安全控制：交易的 `from` 和 `chainId` 必须与当前选择严格一致；发送或离线签名前通过当前 RPC 执行 `eth_call` 与 `eth_estimateGas`；确认页解析 ERC-20 `approve`、NFT `setApprovalForAll`、Permit/Permit2 等高风险动作；站点权限绑定来源、账户和已批准网络，并支持逐站点撤销。第三方模拟服务提供的完整资产变化 diff、防钓鱼信誉数据和独立审计仍属于后续阶段。

移动端内置浏览器同样只允许 HTTPS 和本机开发 HTTP，连接权限绑定当前来源、账户和网络，连接、切链、添加网络都需要用户确认。移动端 keystore 主副本存放于 Keychain/EncryptedSharedPreferences，旧版应用文件会在成功写入安全存储后迁移删除；应用进入后台立即清理密码会话，Android 禁止截图和系统备份，iOS 后台任务快照由隐私遮罩覆盖。私钥剪贴板会在 60 秒后清除，但操作系统或第三方输入法仍可能在清除前读取剪贴板，因此私钥导出只适合作为紧急恢复能力。

当前仍需明确的边界：Flutter/Dart 与浏览器 JavaScript 的不可变字符串无法可靠原地清零；“内存加密密码”只能降低普通内存字符串扫描风险，因为密文和解密密钥仍处于同一进程。高价值托管前应把解密和签名迁移到持有不透明会话句柄的 Rust/native 隔离层，并完成独立安全审计。Google 登录和社交恢复继续保持关闭，直到具备审计过的 MPC、OAuth PKCE、恢复延迟及撤销方案。

## 公开参考

- MetaMask Core `@metamask/assets-controllers` README
- MetaMask Core `@metamask/permission-controller` README 和 architecture 文档
- EIP-1193、EIP-2255、EIP-6963、EIP-712、EIP-1559、ERC-4337
- Blockscout API v2 `/addresses/{address_hash}/token-balances`
- DefiLlama Coins API `/prices/current/{coins}`
