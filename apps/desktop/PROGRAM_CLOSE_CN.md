# 通过 FnzSafe 查找并关闭 Solana 合约

仅有钱包私钥也可以使用：先通过已有导入流程把私钥保存在 FnzSafe 加密钱包中。无需 Program ID、合约源码、Program keypair JSON 或本地部署记录。私钥无需导出给关闭功能。

## 操作

1. 选择该钱包及部署网络。
2. 打开“合约工具 → 关闭合约 / 回收部署租金”。Program 工作区也提供相同入口。
3. 点击“查询该钱包可关闭的合约”。查询是只读操作，不需要钱包密码或签名。
4. 选择扫描出的 Program ID，再点击“第一步：查询权限与可回收租金”。也可直接手动填写已知地址。
5. 检查网络、genesis hash、升级权限、固定退款钱包、ProgramData 租金、保留的 Program 租金、交易费和预计净回收。
6. 勾选永久关闭确认，再输入完整 Program ID。若钱包尚未解锁，输入钱包密码。
7. 点击第二步按钮签名。等待 finalized 和关闭回读，保存交易签名及可下载的 JSON 回执。

关闭是不可逆操作；程序永久停用，原 Program ID 不能重新部署。此功能只支持 loader-v3，退款回到当前签名钱包。需要钱包预先持有手续费所需的 SOL；不能使用尚未退回的租金支付交易费。

## 自动发现的范围

扫描按**当前升级权限**查找，而非只按历史部署付款人查找。曾经部署过但已经转移权限、放弃升级权限、关闭或部署在其他网络的合约，不会作为可关闭合约列出。扫描为空不证明钱包从未部署合约。

后端从已保存钱包公钥查询 upgradeable loader 的 ProgramData：验证状态类型、Some authority 标记和权限公钥，再从 Program 账户关联并核对规范 ProgramData PDA。不需要读取或拥有源码；扫描仅读取 ProgramData 的 45 字节元数据和 Program 的 36 字节状态，不下载 ELF。

两次扫描可能来自不同 finalized bank，所以列表只是发现结果。审批预览会在单次 finalized getMultipleAccounts 中重新读取两个完整账户并核对权限。当前状态观察不属于历史回放，也不是历史部署清单。

某些 RPC 禁用 loader 的 getProgramAccounts 或缺少索引。此时明确返回查询失败，不把失败转换成空列表；可在钱包设置中切换支持该查询的 RPC。

## 关闭边界

关闭指令针对 ProgramData，并携带 Program 引用与当前升级权限签名。只退回 ProgramData 的 lamports；Program 地址本身保留的小额租金不会退回。PDA、Token 账户和遗留 Buffer 不会随程序关闭。

预览有效期为五分钟，只可提交一次，并绑定钱包、Program ID、实际 RPC endpoint、集群 genesis hash、账户摘要和批准费用。提交前重新检查这些值；账户或费用变化时拒绝并要求重新预览。关闭与本进程部署、升级共享互斥锁。

使用现有加密 API、钱包解锁会话、签名模拟和确定签名提交流程。关闭超时不会自动重新签名。出现不确定状态时保留错误中的交易签名，先核对链上状态，不能盲目重试。审批与发送之间仍存在链上并发变化窗口，链上 loader 的权限校验继续生效；预览不是锁定链上状态。

finalized 回读确认 ProgramData 已不存在或余额归零。若交易元数据可得，再以 ProgramData 清空、Program 余额不变、退款钱包净变化等于退款减手续费核验实际退款。元数据不可得时回执只记录预期退款，不声称已测得实际退款。

## 本轮验证（2026-10-25）

证据等级为本地逻辑/交易构造验证、组件初始态检查，以及公开 devnet 当前状态的只读发现验证；未执行任何真实关闭交易。

- `cargo test -p fnzero-safe-desktop-api --locked --offline program_close::tests`：10 项离线测试通过，1 项只读网络测试默认忽略。覆盖发现过滤偏移及账户关联、错误权限、不可升级状态、owner/长度/状态异常、快照变化、关闭指令与签名、两步确认、过期和一次性预览、退款余额核对及未知请求字段拒绝。
- 显式运行 `public_devnet_discovery_read_only -- --ignored --nocapture`：通过。以公开 System Program 地址为查询样例，官方 devnet RPC 扫描和规范 PDA 关联得到 12 个程序。该地址仅是只读查询样例，未使用私钥或发送交易；结果不涉及用户钱包，也不证明这些程序可由用户关闭。
- `npm run test:program-close`：2 项前端测试通过，覆盖 lamport 精度及确认准入。
- 单独编译并运行 `programDeploy.test.ts`、`programWorkspace.test.ts`：11 项回归通过。
- TypeScript、修改组件的 ESLint、敏感输入检查、`git diff --check`：通过。
- 浏览器检查了真实组件的初始态、永久关闭提示、自动查询入口和未选择钱包时的禁用状态；未完成用户钱包解锁、预览到签名的 UI 端到端测试。

首次默认 Rust 构建受本机 OpenSSL 4 与 curl 依赖不兼容阻塞。临时使用本机 OpenSSL 3 后测试构建通过，未修改仓库构建配置。Node 测试保留现有 module type 提示。

`npm run test:program-deploy` 的完整脚本在编译现有 `evmAbi.test.ts` / `evmAbiProjects.test.ts` 时遇到 TS5097（`.ts` 导入与编译参数不一致），因此不能报告该整套脚本通过；相关 Program 测试已单独运行。未构建发行安装包，未运行 Tauri 完整构建，未完成 devnet/mainnet 真实关闭、历史回放或移动端接入。
