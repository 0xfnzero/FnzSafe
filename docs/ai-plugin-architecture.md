# FnzSafe AI 插件架构

FnzSafe 参考 OneAI 的 DeepSeek Harness 集成，采用“钱包是宿主，AI 能力属于 DSH 插件”的边界。Tauri 负责安全存储 API Key、查询本地 KOL 证据和启动运行时；模型、Agent 循环、会话、技能发现及工具调用均由 DeepSeek Harness 管理。

## 运行链路

1. UI 调用 Tauri `research_ai_chat` 命令。
2. Rust 从研究库生成本地证据，并从 Keychain 或 DPAPI 读取用户配置的 API Key。
3. Rust 通过标准输入调用 `ai-runtime/run.mjs`，密钥不会进入命令行或前端持久化。
4. sidecar 通过 `@deepseek-ai/dsh-sdk-client` 启动官方 `sdk-minimal` profile，并应用 `fnzsafe.patch.yml`，显式装配技能、Web 和 MCP 能力。
5. DSH 从 `ai-runtime/skills/` 发现技能和角色卡，通过 MCP 调用 `fnzsafe_web3` 公共数据工具，最终回答返回 Tauri。

无模型配置时仍可使用本地确定性检索。模型路径禁止在 Rust、React 或其它本地服务中直接拼接 `/chat/completions` 请求。

## 作者入口

- 技能：在 `ai-runtime/skills/<id>/SKILL.md` 添加 `name`、`description`、`whenToUse` 和完整规则。
- 目录：在 `ai-runtime/skill-catalog.json` 为同一个 `<id>` 添加中英文名称、用途、数据源和真实工具映射；设置页直接读取这份随应用打包的目录。
- 角色卡：同样使用 DSH 技能格式，名称使用 `rolecard:<locale>:<category>:<slug>`；不在 UI 中维护另一套角色注册表。
- 工具：实现为 DSH Cordis 插件或 MCP server，并在 `fnzsafe.patch.yml` 装配；不直接暴露给渲染进程。
- 模型：用户在 AI 面板配置 OpenAI-compatible endpoint、model 和 API Key。当前原生适配器是 DSH DeepSeek/OpenAI-compatible 路径；Claude Messages API 需要后续增加对应 DSH provider 插件。

## 已内置能力

设置中的“内置技能市场”展示 15 个技能与 4 个角色卡。它们不是静态宣传项：运行时自检要求每个目录项都存在对应 `SKILL.md`，目录引用的每个工具都必须由 MCP 注册并实现。

- 市场：Web3 综合研究、CoinGecko 市场情报、DEX 流动性、市场情绪。
- DeFi：协议、收益池、稳定币流动性、协议费用与收入分析。
- 风险与情报：代币风险、Binance Web3 代币审计、KOL 信号、加密新闻、来源验证。
- Agent 交易：Binance 官方 OAuth Agentic MCP、Spot 行情、账户与订单查询，以及带短时预览、逐笔确认和单笔限额的 MARKET/LIMIT 下单与撤单。
- 角色卡：Web3 加密研究员、区块链安全审计师、DeFi 风险分析师、Web3 情报分析师。
- `fnzsafe_web3` MCP：28 个工具，覆盖 CoinGecko、DeFiLlama、DexScreener、GoPlus、Rugcheck、Alternative.me、Binance Spot/Binance Web3，以及 CoinDesk、Cointelegraph、Decrypt 的公开 RSS；其中交易工具受独立策略约束。

Binance 官方 Agentic MCP 端点是 `https://agent.binance.com/mcp/agentic`，使用 OAuth 和隔离的 Agentic 子账户。Binance 不提供动态客户端注册，FnzSafe 按其支持的 Client ID Metadata Document 协议发布公开客户端元数据，通过 OAuth PKCE 连接；OAuth token 由 `mcp-remote` 保存在权限受限的本机应用数据目录。官方 MCP 默认关闭，可在设置页显式启用。用户也可以配置自己的最小权限 Binance Spot API Key 使用独立的现货交易工具。

## 安全边界

- AI 运行时禁止文件、Shell、后台任务、子 Agent 和编辑工具；默认只读，仅显式注册的受控交易工具可以改变外部状态。
- AI 不持有钱包解锁密码、私钥、助记词或签名材料。Binance API Key/Secret 由 Keychain 或 DPAPI 保存，只在单次 sidecar 进程环境中注入，不进入前端持久化或模型上下文。
- Binance Exchange API 集成不暴露提现、任意签名、杠杆、合约、Convert 或 Pay。官方 Agentic MCP 中标记为只读且名称不含写操作动词的工具可直接查询；其它工具一律由本地代理转为五分钟防篡改预览，只有宿主验证用户后续一条消息精确为 `CONFIRM` 后才能执行。执行失败或超时不会自动重试。
- 推文和网页内容均是不可信数据，不能覆盖系统策略或作为工具指令执行。
- “10 倍潜力”等问题只能返回有证据的情景分析、风险和失效条件，不能承诺收益。
- DSH 遥测在钱包运行时中关闭。

## 构建与验证

`npm run prepare:ai-runtime` 安装锁定的 sidecar 依赖并复制当前平台的 Node 可执行文件到忽略目录 `build-cache/ai-runtime/`。Tauri 打包时将 Node、运行时文件、插件、技能及独立 `node_modules` 作为资源加入应用。

可单独验证：

```bash
cd apps/desktop
npm run prepare:ai-runtime
node ai-runtime/run.mjs --self-test
npm run test:ai-runtime-live
```

`--self-test` 是离线结构校验；`test:ai-runtime-live` 会通过标准 MCP 客户端实际调用全部工具路径，需要联网，适合发布前运行。
