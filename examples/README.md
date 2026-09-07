# FnzeroSafe 快速入门教程

本教程将带你完成 FnzeroSafe 的安装和基本使用流程。

## 📋 目录

1. [安装 FnzeroSafe](#安装-fnzero-safe)
2. [启动交互式菜单](#启动交互式菜单)
3. [创建 keystore.json 钱包](#创建-keystorejson-钱包)
4. [解锁钱包](#解锁钱包)
5. [创建 WSOL ATA 账号](#创建-wsol-ata-账号)
6. [创建 Durable Nonce 账号](#创建-durable-nonce-账号)

---

## 📦 安装 FnzeroSafe

### 方式一：从源码编译安装（推荐）

```bash
# 1. 克隆或进入项目目录
cd /path/to/fnzero-safe

# 2. 使用 full feature 编译并安装
cargo install --path crates/core --features="full"

# 3. 验证安装
fnzero-safe --version
```

### 方式二：从 crates.io 安装

```bash
cargo install fnzero-safe --features="full"
```

---

## 🚀 启动交互式菜单

安装完成后，启动交互式菜单：

```bash
fnzero-safe start
```

你将看到语言选择界面：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FnzeroSafe - Solana 密钥管理工具
  Solana Security Key Management Tool
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Please select language | 请选择语言:

  1. 中文
  2. English

Select language (1-2): _
```

输入 `1` 选择中文，或 `2` 选择 English。

---

## 🔐 创建 keystore.json 钱包

选择语言后，进入主菜单：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    主菜单 | Main Menu
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  U.  解锁钱包 (解锁钱包)
  1.  创建 keystore.json 钱包 (创建 keystore 钱包)
  2.  加密现有私钥 (加密现有私钥)
  3.  解密 keystore.json (解密 keystore)
  4.  Solana 操作 (Solana 操作)
  5.  设置三因子认证 (设置三因子认证)
  6.  解锁三因子钱包 (解锁三因子钱包)
  Q.  退出 (退出)

请选择操作 (1-6/U/Q): _
```

**步骤：**
1. 输入 `1` 并回车，选择创建 keystore.json 钱包
2. 系统将生成一个新的 Solana 密钥对
3. 你需要设置一个密码（密码长度 10-20 字符，必须包含大写、小写、数字、特殊字符中的至少 3 种）
4. 系统会将私钥加密并保存到 `keystore.json` 文件

**示例输出：**

```
🔐 创建 keystore.json 钱包

正在生成新的 Solana 密钥对...
✅ 密钥对生成成功！

公钥: 7xKm...9xW3

请设置密码 (长度 10-20 字符，必须包含大写、小写、数字、特殊字符中的至少 3 种):
输入密码: ********
再次输入密码: ********

密码强度验证通过！✅

正在加密私钥...
✅ 钱包已保存: keystore.json

📝 重要提醒:
   • 密码请妥善保管，丢失无法恢复！
   • keystore.json 文件包含了加密后的私钥
   • 建议将 keystore.json 备份到多个安全位置
```

---

## 🔓 解锁钱包

创建钱包后，返回主菜单，输入 `U` 解锁钱包：

```
请选择操作 (1-6/U/Q): U
```

**步骤：**
1. 系统会提示输入 keystore 文件路径（默认为 `keystore.json`）
2. 直接回车使用默认路径
3. 输入之前设置的密码
4. 解锁成功后，钱包将保存在会话中，可以进行 Solana 操作

**示例输出：**

```
  解锁钱包
Keystore 文件路径 [keystore.json]:

请输入密码: ********

✅ 钱包解锁成功！
📍 当前钱包: 7xKm...9xW3
```

---

## 💰 创建 WSOL ATA 账号

解锁钱包后，选择 `4` 进入 Solana 操作菜单：

```
请选择操作 (1-6/U/Q): 4

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
              Solana 操作菜单 | Solana Operations
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1.  查询余额 (查询余额)
  2.  创建 WSOL ATA (创建 WSOL ATA)
  3.  SOL ⟷ WSOL (打包 SOL)
  4.  WSOL ⟷ SOL (解包 WSOL)
  5.  创建 Nonce 账户 (创建 Nonce 账户)
  B.  返回 (返回)

请选择操作 (1-5/B): _
```

**步骤：**
1. 输入 `2` 并回车
2. 系统会自动创建 WSOL Associated Token Account
3. 等待交易确认

**示例输出：**

```
📝 创建 WSOL ATA

🚀 正在创建 WSOL Associated Token Account...
✅ WSOL ATA 创建成功！

📍 ATA 地址: 7xKm...9xW3
📊 Token Mint: So11111111111111111111111111111111111111111112

Signature: 5xKm...9xW3
Explorer: https://solscan.io/tx/5xKm...9xW3
```

---

## 🔑 创建 Durable Nonce 账号

返回 Solana 操作菜单，输入 `5` 创建 Nonce 账号：

```
请选择操作 (1-5/B): 5

🔑 创建 Nonce 账户

ℹ️  A nonce account will be created for durable transactions
ℹ️  将创建一个用于持久交易的 Nonce 账户
```

**步骤：**
1. 系统会自动创建一个新的 nonce 账号
2. nonce 账号用于确保交易的幂等性和防止重放攻击
3. 等待交易确认

**示例输出：**

```
🚀 正在创建 Nonce 账户...

✅ Nonce 账户创建和初始化成功！
   📍 地址: 5xKm...7xW3
   🔐 Nonce值: 1234abcd...efgh5678

💡 请保存此 Nonce 账户地址以供将来使用！

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    Solana 操作菜单
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  B.  返回 (返回)
```

---

## 📚 其他常用操作

### 查询余额

```
在 Solana 操作菜单中输入: 1
```

### 打包 SOL 到 WSOL

```
在 Solana 操作菜单中输入: 3
```

### 解包 WSOL 到 SOL

```
在 Solana 操作菜单中输入: 4
```

### 返回主菜单

在任何子菜单中输入 `B` 返回上一级菜单。

---

## ⚠️ 重要安全提示

1. **密码安全**
   - 密码长度必须在 10-20 字符之间
   - 必须包含大写、小写、数字、特殊字符中的至少 3 种
   - 不要使用生日、电话号码等容易猜测的密码
   - 请妥善保管密码，丢失无法恢复！

2. **文件备份**
   - `keystore.json` 文件包含加密后的私钥
   - 建议备份到多个安全位置（U盘、云盘等）
   - 不要分享给任何人

3. **私钥安全**
   - 永远不要将明文私钥发送给任何人
   - 不要将私钥提交到代码仓库
   - 使用钱包前验证公钥是否正确

---

## 🆘 常见问题

### Q: 忘记密码怎么办？

A: 密码无法恢复。如果忘记了密码，你需要：
   - 从其他备份位置恢复 keystore.json
   - 重新创建新的钱包（会生成新的公私钥对）

### Q: 如何在不同设备使用钱包？

A: 将 `keystore.json` 文件复制到目标设备，然后：
   ```bash
   fnzero-safe start
   # 选择 3. 解密 keystore.json
   ```

### Q: 交易失败怎么办？

A: 可能的原因：
   - 余额不足
   - 网络拥堵
   - RPC 节点问题
   - 检查交易签名在 Solscan 上的详情

---

## 📚 更多资源

- **Solana 官网**: https://solana.com
- **Solana Explorer**: https://solscan.io
- **FnzSafe GitHub**: https://github.com/0xfnzero/FnzSafe

---

## 🎉 恭喜！

你已经学会了如何：
- ✅ 安装和配置 FnzeroSafe
- ✅ 创建安全的加密钱包
- ✅ 解锁钱包进行操作
- ✅ 创建 WSOL ATA 账号
- ✅ 创建 Durable Nonce 账号

继续探索 Solana 的世界吧！🚀
