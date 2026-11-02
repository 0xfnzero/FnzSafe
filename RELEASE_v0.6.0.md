# FnzSafe v0.6.0

## 更新内容

- 新增桌面端 Safe EVM 多签：Safe 1.4.1 创建向导、已有账户导入、交易提案、EOA 签名收集与合并、费用预览、执行及回执检查。
- 支持 ABI 类型化合约调用、嵌套 tuple / 数组参数、Safe Transaction Builder 1.0 文件导入和提案签名交换；主网与测试网记录隔离。
- 钱包恢复支持明文私钥、明文助记词和原有加密备份，涵盖 EVM、Solana 及项目已实现的其它链适配器。Bitcoin 私钥恢复限主网压缩 WIF。
- 集成 Binance Agent OS、Web3 技能市场和连接中心，完善交易及链上操作流程。
- 新增项目化 EVM ABI 读写、解锁后深链接处理、Solana 钱包程序发现与部署租金回收。
- 修复 DApp 自动填充同步查询网页地址导致 CEF 主线程死锁、整个桌面窗口无响应的问题，并在填充时重新校验页面来源。
- 更新桌面端及本地 API 版本至 0.6.0，修复发布测试兼容性。

## 安装包

`FnzSafe_0.6.0_aarch64.dmg` 适用于 macOS Apple Silicon（M 系列芯片）。下载后打开 DMG，将 FnzSafe 拖入 Applications。`SHA256SUMS` 提供安装包 SHA-256 校验值。

本安装包使用本地 ad-hoc 签名，**没有 Apple Developer ID 签名，也未经过 Apple 公证**。首次启动可能被 Gatekeeper 阻止；确认来源后，可在「系统设置 → 隐私与安全性」中允许打开。本次不提供 Intel Mac、Windows、Linux 或移动端安装包。

## 范围与验证

Safe 当前支持 EOA 所有者、至少 2 人阈值及单笔 CALL；不支持 delegatecall、原子批处理或合约所有者签名。仅接受经链 ID 与部署字节码校验的兼容 Safe 1.4.1 部署。账户和提案记录保存在本地，应导出备份。详情见 [Safe 多签文档](https://github.com/0xfnzero/FnzSafe/blob/v0.6.0/docs/safe-multisig.md)。

发布验证包含前端单元测试、类型检查、lint、静态生产构建、Rust 服务测试（220 项通过）、桌面壳测试（119 项通过）及格式检查；ABI 编码与 ethers v6 进行 1,273 次独立对照，并在隔离 Anvil 上执行真实 Safe 合约生命周期与 12 组 Solidity 参数解码检查。未使用用户私钥或在公共网络广播测试交易。

SDK crate 保持各自版本，本次不发布 crates.io 包。
