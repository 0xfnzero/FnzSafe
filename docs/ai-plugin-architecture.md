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

设置中的“内置技能市场”展示 12 个技能与 4 个角色卡。它们不是静态宣传项：运行时自检要求每个目录项都存在对应 `SKILL.md`，目录引用的每个工具都必须由 MCP 注册并实现。

- 市场：Web3 综合研究、CoinGecko 市场情报、DEX 流动性、市场情绪。
- DeFi：协议、收益池、稳定币流动性、协议费用与收入分析。
- 风险与情报：代币风险、KOL 信号、加密新闻、来源验证。
- 角色卡：Web3 加密研究员、区块链安全审计师、DeFi 风险分析师、Web3 情报分析师。
- `fnzsafe_web3` MCP：17 个只读工具，覆盖 CoinGecko、DeFiLlama、DexScreener、GoPlus、Rugcheck、Alternative.me，以及 CoinDesk、Cointelegraph、Decrypt 的公开 RSS。

## 安全边界

- AI 运行时固定为只读，文件、Shell、后台任务、子 Agent 和编辑工具均在 Cordis patch 中禁用。
- AI 不持有钱包解锁密码、私钥、助记词或签名材料，也不能发起、批准或广播交易。
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
