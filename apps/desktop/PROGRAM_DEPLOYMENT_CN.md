# 使用 FnzSafe 部署 Solana Program

本文说明如何通过 FnzSafe UI 首次部署任意 Solana SBF Program。该流程适用于新的 upgradeable-loader Program ID，不用于升级已经存在的 Program。

FnzSafe 是通用钱包和 Program 运维工具。它不会自动完成合约审计、批准发布，也不会把不可信的二进制变得安全。进入本流程前，必须完成合约安全与业务逻辑审查、可复现构建、本地验证器测试和发布审批。

部署会消耗 SOL，并且可能发送多笔交易。应使用本地桌面应用，或仅绑定 loopback 的 UI 与 API。不要通过公网代理、隧道或端口转发暴露本地 API。

## 输入与信任边界

打开部署表单前准备好：

- 从已批准源码版本构建出的最终 SBF `.so`；
- 用于新 Program ID 的 Program keypair JSON；
- 将作为付款钱包和 ProgramData Upgrade Authority 的已保存钱包；
- 目标 RPC 配置及独立确认的集群 genesis hash；
- 对完全相同 `.so` 独立复核并批准的 SHA-256；
- 可选的 `max_data_len` 决策，以及仅在恢复时使用的已记录 Buffer 地址。

UI 和本地 API 会检查这些值是否一致，但不能证明合约业务逻辑正确。

## 保护 Program keypair

Program keypair 决定 Program ID，并为新 Program 账户的创建签名。必须把 JSON 文件当作私密密钥材料：

- 存放在代码仓库、下载目录、共享盘、云同步、shell 历史、日志、工单和聊天之外；
- 不要用 `cat` 打印、粘贴到终端，也不要放入截图或屏幕共享；
- 部署前创建加密且受访问控制的备份，并在不显示文件内容的前提下验证备份；
- 只上传到可信的本地 FnzSafe UI；请求结束后清空表单并关闭不需要的浏览器窗口；
- 如果 UI 派生出的 Program ID 与批准值不同，立即停止。

Program keypair 与 Upgrade Authority 是不同角色。Program keypair 固定 Program 地址；部署后，升级由 ProgramData Upgrade Authority 控制，本流程中就是所选部署钱包。两份凭据都需要独立保护。

如果 Program keypair 可能已经泄露，不要部署。应生成新的 Program keypair、更新批准的 Program ID，并重新执行所有依赖地址的审查。

## 独立确认制品

浏览器会计算并显示上传 `.so` 的 SHA-256 和字节长度。第二位操作者必须从已批准制品独立计算摘要，例如：

```bash
shasum -a 256 /absolute/path/to/program.so
wc -c < /absolute/path/to/program.so
```

Linux 可以使用 `sha256sum`。把独立批准的 64 位小写 SHA-256 填入部署表单。输入值、浏览器计算值和发布记录必须完全一致。哈希一致只能证明文件身份，不能证明合约安全。

批准后不要替换或重新构建 `.so`。任何字节变化都必须产生新的摘要并重新完成发布复核。

## 确认网络与 genesis hash

载入任何部署材料前先选择目标 RPC，并确认：

- UI 显示的网络和 RPC endpoint 是预期目标；
- 部署表单显示的 expected genesis hash 与发布目标一致；
- 通过独立的只读检查，从目标 RPC 得到相同 genesis hash；
- 付款钱包在该精确集群上有足够余额。

`devnet` 等 RPC 配置标签不能证明集群身份。FnzSafe 会在解锁钱包或花费 SOL 前读取 RPC 的真实 genesis hash，不匹配时拒绝部署。使用自定义 RPC 时，必须确认它服务于预期集群，并且部署表单支持该 genesis hash。

不要通过修改网络标签或 expected hash 绕过不匹配。应停止操作，查明 RPC 配置和发布目标中哪一项错误。

## `max_data_len`

`max_data_len` 是分配给 ProgramData 的容量，不是当前 `.so` 长度。

- 留空时按当前制品长度分配；
- 只有发布计划明确为未来更大版本预留空间时才设置；
- 必须不小于上传 `.so` 的字节长度，且不超过 UI 显示的上限；
- 更大的值会增加 rent；等于当前文件长度则可能阻止以后升级到更大的二进制；
- 一旦产生 deployment journal，该值就是部署意图的一部分，恢复期间绝不能修改。

签名前把批准值记录到发布证据中。

## 通过 UI 首次部署

1. 在本机启动 FnzSafe 并打开 UI。载入任何密钥材料前，确认本地 API health endpoint 正常。
2. 选择目标 RPC，然后进入“Program 工作区”并打开“部署 Program”。
3. 选择已保存的部署钱包，确认其公钥正是预期付款钱包和 Upgrade Authority。
4. 上传已批准的 `.so`，逐项比较 UI 显示的文件名、字节长度、SHA-256 与发布记录。
5. 输入独立复核并批准的 `.so` SHA-256。
6. 上传 Program keypair JSON，比较 UI 派生 Program ID 与批准 Program ID。
7. 再次确认 expected Upgrade Authority、目标网络、RPC endpoint 和 genesis hash。
8. 保持 `max_data_len` 为空或填写批准容量。全新尝试时，恢复 Buffer 字段必须为空。
9. 检查费用估算，确保付款钱包足以承担 Buffer、Program、ProgramData rent、交易费和页面显示的预留。
10. 确认没有其他操作者、浏览器窗口、CLI 进程或部署工具正在部署同一 Program ID。
11. 点击“部署 Program”，在密码弹窗中解锁已保存钱包，并且只确认一次。交易处理期间不要重复点击、关闭 API 或启动并行部署。

后端会在签名前验证 SBF、检查 keypair 派生 Program ID、比较制品哈希、核对实际 genesis hash，并要求付款钱包等于 expected Upgrade Authority。这些是部署保护，不替代合约审计。

## 中断部署与 Buffer 恢复

首次部署可能包含 create-buffer、多笔 write 和 deploy 交易。超时或响应丢失不能证明交易失败，绝不能盲目重试。

应根据 FnzSafe 显示的持久化部署记录决定下一步。恢复必须保持完全相同的部署意图：

- 集群 genesis hash 和 Program ID；
- `.so` 字节、SHA-256 和字节长度；
- Program keypair 和 Upgrade Authority；
- `max_data_len`；
- 已记录的 Buffer 地址及已完成 write 证据。

“恢复 Buffer”只能使用该部署意图记录的 Buffer。后端必须先在 finalized 状态验证其 owner、authority、分配长度和已有字节，再规划缺失 write。不要粘贴无关 Buffer，不要删除或编辑 journal，不要轮换付款钱包，也不要切换 RPC 来强制继续。

如果某笔交易状态不确定，应先对账已记录的签名和 last-valid-block-height。只有证据证明之前签名的精确效果不存在，或流程正在恢复完全相同的 finalized 状态，才可以安全重试。恢复期间只能保留一个操作者和一个活动 UI 会话。

## Finalized 回读与 receipt

仅获得交易签名不代表部署完成。UI 必须报告成功的 finalized 回读，并绑定：

- 网络与实际 genesis hash；
- Program ID 与 ProgramData 地址；
- Upgrade Authority；
- `.so` SHA-256、部署字节长度与 `max_data_len`；
- 部署相关签名、finalized slot 与 deployed slot；
- `readback_verified = true`。

立即下载 deployment receipt，独立计算 receipt 的 SHA-256，并与源码版本、构建 metadata、制品摘要、Program ID 批准记录和操作者复核证据一起归档。还应通过另一种只读方式独立核对链上 Program。

Receipt 只记录 FnzSafe 观察和提交的内容，不是合约审计、源码到二进制证明或外部证明。任何要求的复核者签名或部署 attestation，都必须在核对 finalized 回读后另行生成。

## 必须停止的情况

遇到以下任一情况都不得签名：

- 制品哈希、长度、Program ID、authority、网络或 genesis hash 与发布记录不同；
- 目标 Program 或 ProgramData 意外已经存在；
- Program keypair 或钱包凭据可能泄露；
- 部署记录属于另一意图或包含未知 Buffer；
- RPC 结果不完整、不一致或无法达到 finalized commitment；
- 另一部署或恢复尝试可能仍在运行；
- 付款钱包余额或费用估算不确定。

已经存在的 Program 必须进入明确的查询、恢复或升级流程。首次部署表单绝不能用来覆盖它。
