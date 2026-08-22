//! Interactive Menu Module
//!
//! Provides a simple interactive interface - no need to memorize commands
//! 提供简单的交互式界面 - 无需记住命令

use colored::*;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use std::io::{self, Write};

use crate::KeyManager;

/// Search for a keystore file recursively in subdirectories (max 3 levels deep).
/// Returns the first match as a relative path, or None if not found.
/// Skips directories named "dev" and prefers "prod" paths.
fn search_keystore_in_subdirs(filename: &str) -> Option<String> {
    fn search(
        dir: &std::path::Path,
        filename: &str,
        depth: usize,
        max_depth: usize,
        results: &mut Vec<String>,
    ) {
        if depth > max_depth {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name = path.file_name().unwrap_or_default().to_string_lossy();
                    // Skip hidden dirs, common large dirs, and "dev" dirs
                    if name.starts_with('.')
                        || name == "target"
                        || name == "node_modules"
                        || name == "dev"
                    {
                        continue;
                    }
                    search(&path, filename, depth + 1, max_depth, results);
                } else if path.file_name().unwrap_or_default() == filename {
                    results.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    let mut results = Vec::new();
    search(std::path::Path::new("."), filename, 0, 3, &mut results);
    // Prefer prod path
    results
        .into_iter()
        .find(|p| p.contains("prod"))
        .or_else(|| {
            // Fallback: return first non-dev result (shouldn't happen since we skip dev dirs)
            let mut results = Vec::new();
            search(std::path::Path::new("."), filename, 0, 3, &mut results);
            results.into_iter().next()
        })
}

/// Language selection
#[derive(Clone, Copy, PartialEq)]
pub enum Language {
    English,
    Chinese,
}

/// Text strings for bilingual UI
struct Texts {
    // Main menu
    title: &'static str,
    core_functions: &'static str,
    create_plain: &'static str,
    create_encrypted: &'static str,
    decrypt: &'static str,
    exit: &'static str,
    select_option: &'static str,
    goodbye: &'static str,
    invalid_option: &'static str,
    continue_use: &'static str,

    // Plain key creation
    create_plain_title: &'static str,
    keypair_generated: &'static str,
    public_key: &'static str,
    private_key: &'static str,
    output_method: &'static str,
    display_only: &'static str,
    save_to_file: &'static str,
    select: &'static str,
    file_path: &'static str,
    file_saved: &'static str,
    security_warning: &'static str,
    plaintext_warning: &'static str,
    save_securely: &'static str,
    dont_share: &'static str,
    recommend_encrypted: &'static str,

    // Encrypted key creation
    create_encrypted_title: &'static str,
    choose_method: &'static str,
    generate_new: &'static str,
    import_existing: &'static str,
    generating: &'static str,
    enter_private_key: &'static str,
    private_key_empty: &'static str,
    keypair_ready: &'static str,
    keystore_recommended: &'static str,
    show_encrypted_string: &'static str,
    keystore_created: &'static str,
    private_key_encrypted: &'static str,
    important_note: &'static str,
    keep_safe: &'static str,
    lost_password_warning: &'static str,
    backup_recommended: &'static str,
    encrypted_private_key: &'static str,
    keep_safe_both: &'static str,

    // Key decryption
    decrypt_title: &'static str,
    input_method: &'static str,
    from_keystore: &'static str,
    from_encrypted_string: &'static str,
    encrypted_key: &'static str,
    enter_password: &'static str,
    decrypt_success: &'static str,
    file_not_exist: &'static str,
    dont_share_warning: &'static str,
    delete_plaintext: &'static str,
    use_encryption: &'static str,

    // Password
    set_password: &'static str,
    new_password: &'static str,
    confirm_password: &'static str,
    password_empty: &'static str,
    password_min_length: &'static str,
    password_mismatch: &'static str,
    password_set: &'static str,

    // Errors
    invalid_choice: &'static str,
    write_failed: &'static str,
}

impl Texts {
    fn chinese() -> Self {
        Self {
            title: "  FnzSafe - Solana 密钥管理工具",
            core_functions: "核心功能 (只需3个操作):",
            create_plain: "  {}  创建明文私钥",
            create_encrypted: "  {}  创建加密私钥(bot)",
            decrypt: "  {}  解密私钥",
            exit: "  {}  退出",
            select_option: "请输入选项 [0-14]: ",
            goodbye: "👋 再见！",
            invalid_option: "❌ 无效选项，请重新选择",
            continue_use: "是否继续使用? [Y/n]: ",

            create_plain_title: "  创建明文私钥",
            keypair_generated: "✅ 密钥对生成成功！",
            public_key: "公钥地址:",
            private_key: "私钥:",
            output_method: "输出方式:",
            display_only: "  1. 仅显示 (当前已显示)",
            save_to_file: "  2. 保存到文件",
            select: "请选择 [1/2]: ",
            file_path: "文件路径 (默认: keypair.json): ",
            file_saved: "✅ 已保存到文件",
            security_warning: "⚠️  安全警告:",
            plaintext_warning: "  • 明文私钥非常不安全",
            save_securely: "  • 请立即保存到安全位置",
            dont_share: "  • 不要分享给任何人",
            recommend_encrypted: "  • 建议使用 '创建加密私钥' 功能",

            create_encrypted_title: "  创建加密私钥",
            choose_method: "选择方式:",
            generate_new: "  1. 生成新的密钥对并加密",
            import_existing: "  2. 导入现有私钥并加密",
            generating: "🎲 生成新的密钥对...",
            enter_private_key: "请输入私钥 (base58 格式): ",
            private_key_empty: "私钥不能为空",
            keypair_ready: "✅ 密钥对准备完成",
            keystore_recommended: "  1. 保存为 Keystore 文件 (推荐)",
            show_encrypted_string: "  2. 显示加密字符串",
            keystore_created: "  ✅ Keystore 创建成功！",
            private_key_encrypted: "🔒 私钥已加密保存",
            important_note: "⚠️  重要提示:",
            keep_safe: "  • 请妥善保管 Keystore 文件和密码",
            lost_password_warning: "  • 丢失密码将无法恢复钱包",
            backup_recommended: "  • 建议备份到安全位置",
            encrypted_private_key: "加密后的私钥:",
            keep_safe_both: "⚠️  提示: 请妥善保管加密私钥和密码",

            decrypt_title: "  解密私钥",
            input_method: "输入方式:",
            from_keystore: "  1. 从 Keystore 文件读取",
            from_encrypted_string: "  2. 输入加密字符串",
            encrypted_key: "加密的私钥: ",
            enter_password: "请输入密码: ",
            decrypt_success: "  ✅ 解密成功！",
            file_not_exist: "文件不存在: {}",
            dont_share_warning: "  • 请勿分享私钥给任何人",
            delete_plaintext: "  • 使用完毕后请立即删除明文私钥文件",
            use_encryption: "  • 建议使用加密方式保存",

            set_password: "设置加密密码 (至少 10 个字符):",
            new_password: "新密码: ",
            confirm_password: "确认密码: ",
            password_empty: "密码不能为空",
            password_min_length: "密码长度至少 10 个字符",
            password_mismatch: "两次密码不一致",
            password_set: "✅ 密码设置成功",

            invalid_choice: "无效选项",
            write_failed: "写入文件失败: {}",
        }
    }

    fn english() -> Self {
        Self {
            title: "  FnzSafe - Solana Key Management Tool",
            core_functions: "Core Functions (3 operations):",
            create_plain: "  {}  Create Plain Private Key",
            create_encrypted: "  {}  Create Encrypted Private Key (Bot)",
            decrypt: "  {}  Decrypt Private Key",
            exit: "  {}  Exit",
            select_option: "Select option [0-14]: ",
            goodbye: "👋 Goodbye!",
            invalid_option: "❌ Invalid option, please try again",
            continue_use: "Continue? [Y/n]: ",

            create_plain_title: "  Create Plain Private Key",
            keypair_generated: "✅ Keypair generated successfully!",
            public_key: "Public Key:",
            private_key: "Private Key:",
            output_method: "Output Method:",
            display_only: "  1. Display Only (already shown)",
            save_to_file: "  2. Save to File",
            select: "Select [1/2]: ",
            file_path: "File path (default: keypair.json): ",
            file_saved: "✅ Saved to file",
            security_warning: "⚠️  Security Warning:",
            plaintext_warning: "  • Plaintext private key is very insecure",
            save_securely: "  • Save to a secure location immediately",
            dont_share: "  • Never share with anyone",
            recommend_encrypted: "  • Consider using 'Create Encrypted Private Key'",

            create_encrypted_title: "  Create Encrypted Private Key",
            choose_method: "Choose Method:",
            generate_new: "  1. Generate new keypair and encrypt",
            import_existing: "  2. Import existing private key and encrypt",
            generating: "🎲 Generating new keypair...",
            enter_private_key: "Enter private key (base58 format): ",
            private_key_empty: "Private key cannot be empty",
            keypair_ready: "✅ Keypair ready",
            keystore_recommended: "  1. Save as Keystore file (Recommended)",
            show_encrypted_string: "  2. Show encrypted string",
            keystore_created: "  ✅ Keystore created successfully!",
            private_key_encrypted: "🔒 Private key encrypted and saved",
            important_note: "⚠️  Important:",
            keep_safe: "  • Keep Keystore file and password safe",
            lost_password_warning: "  • Lost password = lost wallet",
            backup_recommended: "  • Backup to a secure location",
            encrypted_private_key: "Encrypted Private Key:",
            keep_safe_both: "⚠️  Note: Keep encrypted key and password safe",

            decrypt_title: "  Decrypt Private Key",
            input_method: "Input Method:",
            from_keystore: "  1. From Keystore file",
            from_encrypted_string: "  2. Enter encrypted string",
            encrypted_key: "Encrypted key: ",
            enter_password: "Enter password: ",
            decrypt_success: "  ✅ Decryption successful!",
            file_not_exist: "File not found: {}",
            dont_share_warning: "  • Never share private key with anyone",
            delete_plaintext: "  • Delete plaintext key file after use",
            use_encryption: "  • Consider using encryption for storage",

            set_password: "Set encryption password (minimum 10 characters):",
            new_password: "New password: ",
            confirm_password: "Confirm password: ",
            password_empty: "Password cannot be empty",
            password_min_length: "Password must be at least 10 characters",
            password_mismatch: "Passwords do not match",
            password_set: "✅ Password set successfully",

            invalid_choice: "Invalid choice",
            write_failed: "Write failed: {}",
        }
    }
}

/// 选择语言
fn select_language() -> Result<Language, String> {
    println!("\n{}", "=".repeat(50).cyan());
    println!("{}", "  Language / 语言选择".cyan().bold());
    println!("{}", "=".repeat(50).cyan());
    println!();
    println!("  {}  English", "1.".green().bold());
    println!("  {}  中文", "2.".green().bold());
    println!();
    print!("Select / 选择 [1/2]: ");
    io::stdout().flush().map_err(|e| e.to_string())?;

    let mut choice = String::new();
    io::stdin()
        .read_line(&mut choice)
        .map_err(|e| e.to_string())?;
    let choice = choice.trim();

    match choice {
        "1" => Ok(Language::English),
        "2" => Ok(Language::Chinese),
        _ => {
            println!("\n{}", "❌ Invalid option / 无效选项".red());
            select_language()
        }
    }
}

/// Session state to hold unlocked keypair
struct SessionState {
    keypair: Option<Keypair>,
    keystore_path: Option<String>,
}

impl SessionState {
    fn new() -> Self {
        Self {
            keypair: None,
            keystore_path: None,
        }
    }

    fn is_unlocked(&self) -> bool {
        self.keypair.is_some()
    }

    fn unlock(&mut self, keypair: Keypair, path: String) {
        self.keypair = Some(keypair);
        self.keystore_path = Some(path);
    }

    fn get_keypair(&self) -> Option<&Keypair> {
        self.keypair.as_ref()
    }

    fn lock(&mut self) {
        self.keypair = None;
        self.keystore_path = None;
    }
}

/// 显示主菜单并处理用户选择
pub fn show_main_menu() -> Result<(), String> {
    // 首先选择语言
    let lang = select_language()?;
    let texts = match lang {
        Language::Chinese => Texts::chinese(),
        Language::English => Texts::english(),
    };

    // Create session state to hold unlocked keypair
    let mut session = SessionState::new();

    loop {
        println!("\n{}", "=".repeat(50).cyan());
        println!("{}", texts.title.cyan().bold());
        println!("{}", "=".repeat(50).cyan());
        println!();
        println!("{}", texts.core_functions);
        println!();
        println!("  {}  {}", "1.".green().bold(), &texts.create_plain[6..]);
        println!(
            "  {}  {}",
            "2.".green().bold(),
            &texts.create_encrypted[6..]
        );
        println!("  {}  {}", "3.".green().bold(), &texts.decrypt[6..]);

        // Show unlock/lock status
        println!();
        if session.is_unlocked() {
            if lang == Language::Chinese {
                println!(
                    "  🔓 {} {}",
                    "钱包已解锁:".green().bold(),
                    session
                        .get_keypair()
                        .unwrap()
                        .pubkey()
                        .to_string()
                        .bright_white()
                );
                println!("  {}  {}", "L.".yellow().bold(), "锁定钱包".yellow());
            } else {
                println!(
                    "  🔓 {} {}",
                    "Wallet Unlocked:".green().bold(),
                    session
                        .get_keypair()
                        .unwrap()
                        .pubkey()
                        .to_string()
                        .bright_white()
                );
                println!("  {}  {}", "L.".yellow().bold(), "Lock Wallet".yellow());
            }
        } else if lang == Language::Chinese {
            println!("  🔒 {} {}", "钱包状态:".red(), "未解锁".red());
            println!(
                "  {}  {}",
                "U.".green().bold(),
                "解锁钱包（用于Solana操作）".green()
            );
        } else {
            println!("  🔒 {} {}", "Wallet Status:".red(), "Locked".red());
            println!(
                "  {}  {}",
                "U.".green().bold(),
                "Unlock Wallet (for Solana Operations)".green()
            );
        }

        // Advanced security features
        #[cfg(feature = "2fa")]
        {
            println!();
            if lang == Language::Chinese {
                println!("{}", "  高级安全功能:".bright_magenta().bold());
            } else {
                println!("{}", "  Advanced Security:".bright_magenta().bold());
            }
            println!(
                "  {}  {}",
                "4.".bright_magenta().bold(),
                if lang == Language::Chinese {
                    "设置 2FA 认证"
                } else {
                    "Setup 2FA Authentication"
                }
            );
            println!(
                "  {}  {}",
                "5.".bright_magenta().bold(),
                if lang == Language::Chinese {
                    "生成三因子钱包"
                } else {
                    "Generate Triple-Factor Wallet"
                }
            );
            println!(
                "  {}  {}",
                "6.".bright_magenta().bold(),
                if lang == Language::Chinese {
                    "解锁三因子钱包"
                } else {
                    "Unlock Triple-Factor Wallet"
                }
            );
        }

        // Solana operations (if feature is enabled)
        #[cfg(feature = "solana-ops")]
        {
            println!();
            if lang == Language::Chinese {
                println!("{}", "  Solana 链上操作:".bright_blue().bold());
            } else {
                println!("{}", "  Solana Operations:".bright_blue().bold());
            }
            #[cfg(feature = "2fa")]
            {
                println!(
                    "  {}  {}",
                    "7.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "查询 SOL 余额"
                    } else {
                        "Check SOL Balance"
                    }
                );
                println!(
                    "  {}  {}",
                    "8.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "转账 SOL"
                    } else {
                        "Transfer SOL"
                    }
                );
                println!(
                    "  {}  {}",
                    "9.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "创建 WSOL ATA"
                    } else {
                        "Create WSOL ATA"
                    }
                );
                println!(
                    "  {}  {}",
                    "10.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "包装 SOL → WSOL"
                    } else {
                        "Wrap SOL → WSOL"
                    }
                );
                println!(
                    "  {}  {}",
                    "11.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "解包 WSOL → SOL"
                    } else {
                        "Unwrap WSOL → SOL"
                    }
                );
                println!(
                    "  {}  {}",
                    "12.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "关闭 WSOL ATA"
                    } else {
                        "Close WSOL ATA"
                    }
                );
                println!(
                    "  {}  {}",
                    "13.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "转账 SPL 代币"
                    } else {
                        "Transfer SPL Token"
                    }
                );
                println!(
                    "  {}  {}",
                    "14.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "创建 Nonce 账户"
                    } else {
                        "Create Nonce Account"
                    }
                );

                #[cfg(feature = "sol-trade-sdk")]
                println!(
                    "  {}  {}",
                    "15.".bright_magenta().bold(),
                    if lang == Language::Chinese {
                        "Pump.fun 卖出代币"
                    } else {
                        "Pump.fun Sell Tokens"
                    }
                );
                #[cfg(feature = "sol-trade-sdk")]
                println!(
                    "  {}  {}",
                    "16.".bright_magenta().bold(),
                    if lang == Language::Chinese {
                        "PumpSwap 卖出代币"
                    } else {
                        "PumpSwap Sell Tokens"
                    }
                );
                #[cfg(feature = "sol-trade-sdk")]
                println!(
                    "  {}  {}",
                    "17.".bright_magenta().bold(),
                    if lang == Language::Chinese {
                        "Pump.fun 返现（查看与领取）"
                    } else {
                        "Pump.fun Cashback (View & Claim)"
                    }
                );
                #[cfg(feature = "sol-trade-sdk")]
                println!(
                    "  {}  {}",
                    "18.".bright_magenta().bold(),
                    if lang == Language::Chinese {
                        "PumpSwap 返现（查看与领取）"
                    } else {
                        "PumpSwap Cashback (View & Claim)"
                    }
                );
            }
            #[cfg(not(feature = "2fa"))]
            {
                println!(
                    "  {}  {}",
                    "4.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "查询 SOL 余额"
                    } else {
                        "Check SOL Balance"
                    }
                );
                println!(
                    "  {}  {}",
                    "5.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "转账 SOL"
                    } else {
                        "Transfer SOL"
                    }
                );
                println!(
                    "  {}  {}",
                    "6.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "创建 WSOL ATA"
                    } else {
                        "Create WSOL ATA"
                    }
                );
                println!(
                    "  {}  {}",
                    "7.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "包装 SOL → WSOL"
                    } else {
                        "Wrap SOL → WSOL"
                    }
                );
                println!(
                    "  {}  {}",
                    "8.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "解包 WSOL → SOL"
                    } else {
                        "Unwrap WSOL → SOL"
                    }
                );
                println!(
                    "  {}  {}",
                    "9.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "关闭 WSOL ATA"
                    } else {
                        "Close WSOL ATA"
                    }
                );
                println!(
                    "  {}  {}",
                    "10.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "转账 SPL 代币"
                    } else {
                        "Transfer SPL Token"
                    }
                );
                println!(
                    "  {}  {}",
                    "11.".bright_cyan().bold(),
                    if lang == Language::Chinese {
                        "创建 Nonce 账户"
                    } else {
                        "Create Nonce Account"
                    }
                );

                #[cfg(feature = "sol-trade-sdk")]
                println!(
                    "  {}  {}",
                    "12.".bright_magenta().bold(),
                    if lang == Language::Chinese {
                        "Pump.fun 卖出代币"
                    } else {
                        "Pump.fun Sell Tokens"
                    }
                );
                #[cfg(feature = "sol-trade-sdk")]
                println!(
                    "  {}  {}",
                    "13.".bright_magenta().bold(),
                    if lang == Language::Chinese {
                        "PumpSwap 卖出代币"
                    } else {
                        "PumpSwap Sell Tokens"
                    }
                );
                #[cfg(feature = "sol-trade-sdk")]
                println!(
                    "  {}  {}",
                    "14.".bright_magenta().bold(),
                    if lang == Language::Chinese {
                        "Pump.fun 返现（查看与领取）"
                    } else {
                        "Pump.fun Cashback (View & Claim)"
                    }
                );
                #[cfg(feature = "sol-trade-sdk")]
                println!(
                    "  {}  {}",
                    "15.".bright_magenta().bold(),
                    if lang == Language::Chinese {
                        "PumpSwap 返现（查看与领取）"
                    } else {
                        "PumpSwap Cashback (View & Claim)"
                    }
                );
            }
        }

        println!();
        println!("  {}  {}", "0.".red().bold(), &texts.exit[6..]);
        println!();
        print!("{}", texts.select_option);
        io::stdout().flush().map_err(|e| e.to_string())?;

        let mut choice = String::new();
        io::stdin()
            .read_line(&mut choice)
            .map_err(|e| e.to_string())?;
        let choice = choice.trim();

        match choice.to_lowercase().as_str() {
            "1" => create_plain_key_interactive(&texts)?,
            "2" => create_encrypted_key_interactive(&texts)?,
            "3" => decrypt_key_interactive(&texts)?,

            // Unlock/Lock wallet
            "u" => {
                if session.is_unlocked() {
                    if lang == Language::Chinese {
                        println!("\n✅ 钱包已经解锁！");
                    } else {
                        println!("\n✅ Wallet already unlocked!");
                    }
                } else if let Err(e) = unlock_wallet_interactive(&mut session, lang) {
                    eprintln!("❌ {}", e);
                }
                // 解锁/锁定后直接回到菜单，不再问「是否继续使用」
                continue;
            }
            "l" => {
                if session.is_unlocked() {
                    session.lock();
                    if lang == Language::Chinese {
                        println!("\n🔒 钱包已锁定");
                    } else {
                        println!("\n🔒 Wallet locked");
                    }
                } else if lang == Language::Chinese {
                    println!("\n⚠️ 钱包未解锁");
                } else {
                    println!("\n⚠️ Wallet not unlocked");
                }
                continue;
            }

            // Advanced security features (2FA)
            #[cfg(feature = "2fa")]
            "4" => {
                if let Err(e) = setup_2fa_interactive(lang) {
                    eprintln!("❌ {}", e);
                }
            }
            #[cfg(feature = "2fa")]
            "5" => {
                if let Err(e) = generate_triple_factor_wallet_interactive(lang) {
                    eprintln!("❌ {}", e);
                }
            }
            #[cfg(feature = "2fa")]
            "6" => {
                if let Err(e) = unlock_triple_factor_wallet_interactive(lang) {
                    eprintln!("❌ {}", e);
                }
            }

            // Solana operations
            #[cfg(all(feature = "solana-ops", feature = "2fa"))]
            "7" | "8" | "9" | "10" | "11" | "12" | "13" | "14" | "15" | "16" | "17" | "18" => {
                if let Err(e) = handle_solana_operation(choice, lang, &mut session) {
                    eprintln!("❌ {}", e);
                }
            }
            #[cfg(all(feature = "solana-ops", not(feature = "2fa")))]
            "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "14" | "15" => {
                if let Err(e) = handle_solana_operation(choice, lang, &mut session) {
                    eprintln!("❌ {}", e);
                }
            }

            "0" => {
                println!("\n{}", texts.goodbye.cyan());
                break;
            }
            _ => {
                println!("\n{}", texts.invalid_option.red());
                continue;
            }
        }

        // 询问是否继续
        println!();
        print!("{}", texts.continue_use);
        io::stdout().flush().map_err(|e| e.to_string())?;

        let mut continue_choice = String::new();
        io::stdin()
            .read_line(&mut continue_choice)
            .map_err(|e| e.to_string())?;
        let continue_choice = continue_choice.trim().to_lowercase();

        if continue_choice == "n" || continue_choice == "no" {
            println!("\n{}", texts.goodbye.cyan());
            break;
        }
    }

    Ok(())
}

/// 功能1: 创建明文私钥
fn create_plain_key_interactive(texts: &Texts) -> Result<(), String> {
    println!("\n{}", "=".repeat(50).yellow());
    println!("{}", texts.create_plain_title.yellow().bold());
    println!("{}", "=".repeat(50).yellow());
    println!();

    // 生成密钥对
    let keypair = KeyManager::generate_keypair();
    let pubkey = keypair.pubkey();
    let private_key = keypair.to_base58_string();

    println!("{}", texts.keypair_generated.green().bold());
    println!();
    println!(
        "{} {}",
        texts.public_key.cyan(),
        pubkey.to_string().white().bold()
    );
    println!("{} {}", texts.private_key.red().bold(), private_key);
    println!();

    // 询问输出方式
    println!("{}", texts.output_method);
    println!("{}", texts.display_only);
    println!("{}", texts.save_to_file);
    println!();
    print!("{}", texts.select);
    io::stdout().flush().map_err(|e| e.to_string())?;

    let mut output_choice = String::new();
    io::stdin()
        .read_line(&mut output_choice)
        .map_err(|e| e.to_string())?;
    let output_choice = output_choice.trim();

    if output_choice == "2" {
        print!("{}", texts.file_path);
        io::stdout().flush().map_err(|e| e.to_string())?;

        let mut file_path = String::new();
        io::stdin()
            .read_line(&mut file_path)
            .map_err(|e| e.to_string())?;
        let file_path = file_path.trim();
        let file_path = if file_path.is_empty() {
            "keypair.json"
        } else {
            file_path
        };

        // 保存为 Solana keypair JSON 格式 (数组格式)
        let bytes = keypair.to_bytes();
        let json = serde_json::to_string(&bytes.to_vec())
            .map_err(|e| texts.write_failed.replace("{}", &e.to_string()))?;

        std::fs::write(file_path, json)
            .map_err(|e| texts.write_failed.replace("{}", &e.to_string()))?;

        println!();
        println!("{}", texts.file_saved.green());
        println!("{} {}", texts.file_path.trim_end_matches(':'), file_path);
    }

    println!();
    println!("{}", texts.security_warning.yellow().bold());
    println!("{}", texts.plaintext_warning);
    println!("{}", texts.save_securely);
    println!("{}", texts.dont_share);
    println!("{}", texts.recommend_encrypted);

    Ok(())
}

/// 功能2: 创建加密私钥
fn create_encrypted_key_interactive(texts: &Texts) -> Result<(), String> {
    println!("\n{}", "=".repeat(50).yellow());
    println!("{}", texts.create_encrypted_title.yellow().bold());
    println!("{}", "=".repeat(50).yellow());
    println!();

    // 询问是生成新的还是导入现有私钥
    println!("{}", texts.choose_method);
    println!("{}", texts.generate_new);
    println!("{}", texts.import_existing);
    println!();
    print!("{}", texts.select);
    io::stdout().flush().map_err(|e| e.to_string())?;

    let mut source_choice = String::new();
    io::stdin()
        .read_line(&mut source_choice)
        .map_err(|e| e.to_string())?;
    let source_choice = source_choice.trim();

    let keypair = match source_choice {
        "1" => {
            // 生成新密钥对
            println!();
            println!("{}", texts.generating.cyan());
            KeyManager::generate_keypair()
        }
        "2" => {
            // 导入现有私钥
            println!();
            print!("{}", texts.enter_private_key);
            io::stdout().flush().map_err(|e| e.to_string())?;

            let mut private_key = String::new();
            io::stdin()
                .read_line(&mut private_key)
                .map_err(|e| e.to_string())?;
            let private_key = private_key.trim();

            if private_key.is_empty() {
                return Err(texts.private_key_empty.to_string());
            }

            Keypair::from_base58_string(private_key)
        }
        _ => {
            return Err(texts.invalid_choice.to_string());
        }
    };

    let pubkey = keypair.pubkey();

    println!();
    println!("{}", texts.keypair_ready.green());
    println!("{} {}", texts.public_key.cyan(), pubkey);
    println!();

    // 获取密码
    let password = read_password_confirmed(texts)?;

    // 询问输出方式
    println!();
    println!("{}", texts.output_method);
    println!("{}", texts.keystore_recommended);
    println!("{}", texts.show_encrypted_string);
    println!();
    print!("{}", texts.select);
    io::stdout().flush().map_err(|e| e.to_string())?;

    let mut output_choice = String::new();
    io::stdin()
        .read_line(&mut output_choice)
        .map_err(|e| e.to_string())?;
    let output_choice = output_choice.trim();

    match output_choice {
        "1" => {
            // 保存为文件
            print!("{}", texts.file_path.replace("keypair", "wallet"));
            io::stdout().flush().map_err(|e| e.to_string())?;

            let mut file_path = String::new();
            io::stdin()
                .read_line(&mut file_path)
                .map_err(|e| e.to_string())?;
            let file_path = file_path.trim();
            let file_path = if file_path.is_empty() {
                "keystore.json"
            } else {
                file_path
            };

            let keystore_json = KeyManager::keypair_to_encrypted_json(&keypair, &password)?;
            std::fs::write(file_path, keystore_json)
                .map_err(|e| texts.write_failed.replace("{}", &e.to_string()))?;

            println!();
            println!("{}", "=".repeat(50).green());
            println!("{}", texts.keystore_created.green().bold());
            println!("{}", "=".repeat(50).green());
            println!();
            println!("{} {}", texts.file_path.trim_end_matches(':'), file_path);
            println!("{} {}", texts.public_key.cyan(), pubkey);
            println!("{}", texts.private_key_encrypted.green());
            println!();
            println!("{}", texts.important_note.yellow().bold());
            println!("{}", texts.keep_safe);
            println!("{}", texts.lost_password_warning);
            println!("{}", texts.backup_recommended);
        }
        "2" => {
            // 显示加密字符串
            let private_key = keypair.to_base58_string();
            let encrypted = KeyManager::encrypt_with_password(&private_key, &password)?;

            println!();
            println!("{}", texts.keypair_ready.green().bold());
            println!();
            println!("{} {}", texts.public_key.cyan(), pubkey);
            println!("{}", texts.encrypted_private_key.cyan());
            println!("{}", encrypted);
            println!();
            println!("{}", texts.keep_safe_both.yellow());
        }
        _ => {
            return Err(texts.invalid_choice.to_string());
        }
    }

    Ok(())
}

/// 功能3: 解密私钥
fn decrypt_key_interactive(texts: &Texts) -> Result<(), String> {
    println!("\n{}", "=".repeat(50).yellow());
    println!("{}", texts.decrypt_title.yellow().bold());
    println!("{}", "=".repeat(50).yellow());
    println!();

    // 选择输入方式
    println!("{}", texts.input_method);
    println!("{}", texts.from_keystore);
    println!("{}", texts.from_encrypted_string);
    println!();
    print!("{}", texts.select);
    io::stdout().flush().map_err(|e| e.to_string())?;

    let mut input_choice = String::new();
    io::stdin()
        .read_line(&mut input_choice)
        .map_err(|e| e.to_string())?;
    let input_choice = input_choice.trim();

    let (private_key, pubkey) = match input_choice {
        "1" => {
            // 从文件读取
            print!(
                "{}",
                texts
                    .file_path
                    .trim_end_matches("(默认: keypair.json): ")
                    .trim_end_matches("(default: keypair.json): ")
            );
            io::stdout().flush().map_err(|e| e.to_string())?;

            let mut file_path = String::new();
            io::stdin()
                .read_line(&mut file_path)
                .map_err(|e| e.to_string())?;
            let file_path = file_path.trim();

            if !std::path::Path::new(file_path).exists() {
                return Err(texts.file_not_exist.replace("{}", file_path));
            }

            println!();
            let password = prompt_password(texts.enter_password, texts)?;

            let keystore_json = std::fs::read_to_string(file_path)
                .map_err(|e| texts.write_failed.replace("{}", &e.to_string()))?;

            let keypair = KeyManager::keypair_from_encrypted_json(&keystore_json, &password)?;
            let pubkey = keypair.pubkey();
            let private_key = keypair.to_base58_string();

            (private_key, pubkey)
        }
        "2" => {
            // 输入加密字符串
            print!("{}", texts.encrypted_key);
            io::stdout().flush().map_err(|e| e.to_string())?;

            let mut encrypted = String::new();
            io::stdin()
                .read_line(&mut encrypted)
                .map_err(|e| e.to_string())?;
            let encrypted = encrypted.trim();

            println!();
            let password = prompt_password(texts.enter_password, texts)?;

            let private_key = KeyManager::decrypt_with_password(encrypted, &password)?;
            let keypair = Keypair::from_base58_string(&private_key);
            let pubkey = keypair.pubkey();

            (private_key, pubkey)
        }
        _ => {
            return Err(texts.invalid_choice.to_string());
        }
    };

    println!();
    println!("{}", "=".repeat(50).green());
    println!("{}", texts.decrypt_success.green().bold());
    println!("{}", "=".repeat(50).green());
    println!();
    println!("{} {}", texts.public_key.cyan(), pubkey);
    println!("{} {}", texts.private_key.red().bold(), private_key);
    println!();

    // 询问输出方式
    println!("{}", texts.output_method);
    println!("{}", texts.display_only);
    println!("{}", texts.save_to_file);
    println!();
    print!("{}", texts.select);
    io::stdout().flush().map_err(|e| e.to_string())?;

    let mut output_choice = String::new();
    io::stdin()
        .read_line(&mut output_choice)
        .map_err(|e| e.to_string())?;
    let output_choice = output_choice.trim();

    if output_choice == "2" {
        let default_filename = "decrypted_key.txt";

        print!(
            "{}",
            texts.file_path.replace("keypair.json", default_filename)
        );
        io::stdout().flush().map_err(|e| e.to_string())?;

        let mut file_path = String::new();
        io::stdin()
            .read_line(&mut file_path)
            .map_err(|e| e.to_string())?;
        let file_path = file_path.trim();
        let file_path = if file_path.is_empty() {
            default_filename
        } else {
            file_path
        };

        let content = format!(
            "{} {}\n{} {}\n",
            texts.public_key,
            pubkey,
            texts.private_key.trim_end_matches(':'),
            private_key
        );
        std::fs::write(file_path, content)
            .map_err(|e| texts.write_failed.replace("{}", &e.to_string()))?;

        println!();
        println!("{}", texts.file_saved.green());
        println!("{} {}", texts.file_path.trim_end_matches(':'), file_path);
    }

    println!();
    println!("{}", texts.security_warning.yellow().bold());
    println!("{}", texts.dont_share_warning);
    println!("{}", texts.delete_plaintext);
    println!("{}", texts.use_encryption);

    Ok(())
}

/// 在 **stdout** 打印提示，在 TTY 上无回显读取密码（避免 `prompt_password` 仅写 TTY 导致 IDE 终端里看不到提示）。
fn prompt_password(prompt: &str, texts: &Texts) -> Result<String, String> {
    print!("{}", prompt);
    io::stdout().flush().map_err(|e| e.to_string())?;

    let password =
        rpassword::read_password().map_err(|e| texts.write_failed.replace("{}", &e.to_string()))?;

    Ok(password.trim().to_string())
}

/// Unlock wallet interactively and store in session
fn unlock_wallet_interactive(session: &mut SessionState, language: Language) -> Result<(), String> {
    println!();
    if language == Language::Chinese {
        println!("{}", "  解锁钱包".cyan().bold());
        print!("Keystore 文件路径 [keystore.json]: ");
    } else {
        println!("{}", "  Unlock Wallet".cyan().bold());
        print!("Keystore file path [keystore.json]: ");
    }
    io::stdout().flush().map_err(|e| e.to_string())?;

    let mut keystore_path = String::new();
    io::stdin()
        .read_line(&mut keystore_path)
        .map_err(|e| e.to_string())?;
    let keystore_path = keystore_path.trim();

    // Only search subdirectories when user pressed Enter without typing a path
    let keystore_path = if keystore_path.is_empty() {
        if let Some(found) = search_keystore_in_subdirs("keystore.json") {
            if language == Language::Chinese {
                println!("🔍 在子目录中找到: {}", found);
            } else {
                println!("🔍 Found in subdirectory: {}", found);
            }
            found
        } else {
            "keystore.json".to_string()
        }
    } else {
        keystore_path.to_string()
    };

    // Read encrypted file
    let file_content = std::fs::read_to_string(&keystore_path).map_err(|e| {
        if language == Language::Chinese {
            format!(
                "无法读取 Keystore 文件「{}」: {}（请确认路径正确、当前工作目录是否为文件所在目录）",
                keystore_path, e
            )
        } else {
            format!("Failed to read keystore '{}': {}", keystore_path, e)
        }
    })?;

    // Parse JSON to get encryption type
    let json: serde_json::Value = serde_json::from_str(&file_content)
        .map_err(|e| format!("Failed to parse keystore: {}", e))?;

    let encryption_type = json["encryption_type"].as_str().unwrap_or("password_only");

    // Decrypt keypair: use bot_helper::unlock_wallet for password_only to guarantee
    // the exact same code path as bot startup (config/mod.rs → ensure_wallet_ready).
    let keypair = match encryption_type {
        "password_only" => crate::bot_helper::unlock_wallet(&keystore_path)
            .map_err(|e| format!("Failed to decrypt keystore: {}", e))?,
        "triple_factor_v1" => {
            return Err(
                "Triple-factor wallets not yet supported in interactive mode. Please use the CLI."
                    .to_string(),
            );
        }
        _ => {
            return Err(format!("Unknown encryption type: {}", encryption_type));
        }
    };

    // Store in session
    session.unlock(keypair, keystore_path.to_string());

    if language == Language::Chinese {
        println!("✅ 钱包解锁成功！");
        println!("📍 钱包地址: {}", session.get_keypair().unwrap().pubkey());
        println!("💡 提示: 在本次会话中，Solana操作将使用此钱包，无需重复输入密码");
    } else {
        println!("✅ Wallet unlocked successfully!");
        println!(
            "📍 Wallet address: {}",
            session.get_keypair().unwrap().pubkey()
        );
        println!("💡 Tip: Solana operations in this session will use this wallet without re-entering password");
    }

    Ok(())
}

/// Handle Solana operation using session keypair
#[cfg(feature = "solana-ops")]
fn handle_solana_operation(
    choice: &str,
    language: Language,
    session: &mut SessionState,
) -> Result<(), String> {
    // Convert Language to operations::Language
    let ops_language = match language {
        Language::English => crate::operations::Language::English,
        Language::Chinese => crate::operations::Language::Chinese,
    };

    // Check if wallet is unlocked
    let keypair = if let Some(kp) = session.get_keypair() {
        kp
    } else {
        // Wallet not unlocked, prompt user to unlock first
        if language == Language::Chinese {
            println!("\n⚠️  请先使用 'U' 选项解锁钱包");
        } else {
            println!("\n⚠️  Please unlock wallet first using 'U' option");
        }
        return Ok(());
    };

    if language == Language::Chinese {
        println!("\n📍 使用钱包: {}", keypair.pubkey());
    } else {
        println!("\n📍 Using wallet: {}", keypair.pubkey());
    }

    // Call the appropriate operation
    #[cfg(feature = "2fa")]
    let result = match choice {
        "7" => crate::operations::check_balance(keypair, ops_language),
        "8" => crate::operations::transfer_sol(keypair, ops_language),
        "9" => crate::operations::create_wsol_ata(keypair, ops_language),
        "10" => crate::operations::wrap_sol(keypair, ops_language),
        "11" => crate::operations::unwrap_sol(keypair, ops_language),
        "12" => crate::operations::close_wsol_ata(keypair, ops_language),
        "13" => crate::operations::transfer_token(keypair, ops_language),
        "14" => crate::operations::create_nonce_account(keypair, ops_language),
        #[cfg(feature = "sol-trade-sdk")]
        "15" => crate::operations::pumpfun_sell_interactive(keypair, ops_language),
        #[cfg(feature = "sol-trade-sdk")]
        "16" => crate::operations::pumpswap_sell_interactive(keypair, ops_language),
        #[cfg(feature = "sol-trade-sdk")]
        "17" => crate::operations::pumpfun_cashback_interactive(keypair, ops_language),
        #[cfg(feature = "sol-trade-sdk")]
        "18" => crate::operations::pumpswap_cashback_interactive(keypair, ops_language),
        _ => Err("Invalid operation".to_string()),
    };

    #[cfg(not(feature = "2fa"))]
    let result = match choice {
        "4" => crate::operations::check_balance(keypair, ops_language),
        "5" => crate::operations::transfer_sol(keypair, ops_language),
        "6" => crate::operations::create_wsol_ata(keypair, ops_language),
        "7" => crate::operations::wrap_sol(keypair, ops_language),
        "8" => crate::operations::unwrap_sol(keypair, ops_language),
        "9" => crate::operations::close_wsol_ata(keypair, ops_language),
        "10" => crate::operations::transfer_token(keypair, ops_language),
        "11" => crate::operations::create_nonce_account(keypair, ops_language),
        #[cfg(feature = "sol-trade-sdk")]
        "12" => crate::operations::pumpfun_sell_interactive(keypair, ops_language),
        #[cfg(feature = "sol-trade-sdk")]
        "13" => crate::operations::pumpswap_sell_interactive(keypair, ops_language),
        #[cfg(feature = "sol-trade-sdk")]
        "14" => crate::operations::pumpfun_cashback_interactive(keypair, ops_language),
        #[cfg(feature = "sol-trade-sdk")]
        "15" => crate::operations::pumpswap_cashback_interactive(keypair, ops_language),
        _ => Err("Invalid operation".to_string()),
    };

    result
}

/// Setup 2FA authentication interactively
#[cfg(feature = "2fa")]
fn setup_2fa_interactive(language: Language) -> Result<(), String> {
    use crate::{
        derive_totp_secret_from_hardware_and_password, hardware_fingerprint::HardwareFingerprint,
        security_question::SecurityQuestion, totp::*,
    };
    use rpassword;

    let account = "wallet";
    let issuer = "FnzSafe";

    println!("\n{}", "=".repeat(50).bright_magenta());
    if language == Language::Chinese {
        println!("{}", "  🔐 三因子 2FA 安全设置".bright_magenta().bold());
    } else {
        println!(
            "{}",
            "  🔐 Triple-Factor 2FA Security Setup"
                .bright_magenta()
                .bold()
        );
    }
    println!("{}", "=".repeat(50).bright_magenta());
    println!();

    if language == Language::Chinese {
        println!("{}", "⚠️  安全架构说明:".yellow().bold());
        println!("  • 因子1: 硬件指纹（自动收集，绑定设备）");
        println!("  • 因子2: 主密码（您设置的强密码）");
        println!("  • 因子3: 安全问题答案（防止密码泄露）");
        println!("  • 2FA密钥: 从硬件指纹+主密码派生（确定性）");
        println!("  • 解锁需要: 主密码 + 安全问题答案 + 2FA动态验证码");
    } else {
        println!("{}", "⚠️  Security Architecture:".yellow().bold());
        println!("  • Factor 1: Hardware Fingerprint (auto-collected, device-bound)");
        println!("  • Factor 2: Master Password (your strong password)");
        println!("  • Factor 3: Security Question Answer (prevents password leak)");
        println!("  • 2FA Key: Derived from hardware fingerprint + master password");
        println!("  • Unlock requires: Master password + Security answer + 2FA code");
    }
    println!();

    // Step 1: Collect hardware fingerprint
    if language == Language::Chinese {
        println!("{}", "步骤 1/4: 收集硬件指纹...".bright_blue());
    } else {
        println!(
            "{}",
            "Step 1/4: Collecting hardware fingerprint...".bright_blue()
        );
    }

    let hardware_fp = HardwareFingerprint::collect()
        .map_err(|e| format!("Failed to collect hardware fingerprint: {}", e))?;

    if language == Language::Chinese {
        println!("{} 硬件指纹已收集（SHA256哈希）", "✅".green());
        println!("   指纹预览: {}...", &hardware_fp.as_str()[..16]);
    } else {
        println!(
            "{} Hardware fingerprint collected (SHA256 hash)",
            "✅".green()
        );
        println!("   Preview: {}...", &hardware_fp.as_str()[..16]);
    }
    println!();

    // Step 2: Set master password
    if language == Language::Chinese {
        println!("{}", "步骤 2/4: 设置主密码".bright_blue());
    } else {
        println!("{}", "Step 2/4: Set master password".bright_blue());
    }

    let master_password = loop {
        let password = rpassword::prompt_password(if language == Language::Chinese {
            "请输入主密码: "
        } else {
            "Enter master password: "
        })
        .map_err(|e| format!("Failed to read password: {}", e))?;

        if password.is_empty() {
            println!(
                "{} {}",
                "❌".red(),
                if language == Language::Chinese {
                    "主密码不能为空"
                } else {
                    "Master password cannot be empty"
                }
            );
            continue;
        }

        // Check password strength
        if password.len() < 10 {
            println!(
                "{} {}",
                "❌".red(),
                if language == Language::Chinese {
                    "密码长度至少10个字符"
                } else {
                    "Password must be at least 10 characters"
                }
            );
            continue;
        }

        let password_confirm = rpassword::prompt_password(if language == Language::Chinese {
            "请再次输入主密码确认: "
        } else {
            "Confirm master password: "
        })
        .map_err(|e| format!("Failed to read password: {}", e))?;

        if password != password_confirm {
            println!(
                "{} {}",
                "❌".red(),
                if language == Language::Chinese {
                    "两次输入的密码不一致"
                } else {
                    "Passwords do not match"
                }
            );
            continue;
        }

        break password;
    };

    if language == Language::Chinese {
        println!("{} 主密码设置成功", "✅".green());
    } else {
        println!("{} Master password set successfully", "✅".green());
    }
    println!();

    // Step 3: Set security question
    if language == Language::Chinese {
        println!("{}", "步骤 3/4: 设置安全问题".bright_blue());
    } else {
        println!("{}", "Step 3/4: Set security question".bright_blue());
    }

    let (question_index, _security_answer) = SecurityQuestion::setup_interactive()
        .map_err(|e| format!("Failed to setup security question: {}", e))?;
    println!();

    // Step 4: Setup 2FA
    if language == Language::Chinese {
        println!("{}", "步骤 4/4: 设置 2FA 动态验证码".bright_blue());
    } else {
        println!("{}", "Step 4/4: Setup 2FA TOTP".bright_blue());
    }

    let twofa_secret = derive_totp_secret_from_hardware_and_password(
        hardware_fp.as_str(),
        &master_password,
        account,
        issuer,
    )
    .map_err(|e| format!("Failed to derive 2FA secret: {}", e))?;

    let config = TOTPConfig {
        secret: twofa_secret.clone(),
        account: account.to_string(),
        issuer: issuer.to_string(),
        algorithm: "SHA1".to_string(),
        digits: 6,
        step: 30,
    };

    let totp_manager = TOTPManager::new(config);

    if language == Language::Chinese {
        println!(
            "{}",
            "📱 请使用 Google Authenticator 或 Authy 扫描以下 QR 码：".yellow()
        );
    } else {
        println!(
            "{}",
            "📱 Scan this QR code with Google Authenticator or Authy:".yellow()
        );
    }
    println!();

    match totp_manager.generate_qr_code() {
        Ok(qr_code) => {
            println!("{}", qr_code);
        }
        Err(e) => {
            if language == Language::Chinese {
                eprintln!("{} QR 码生成失败: {}", "⚠️".yellow(), e);
                println!("{}", "📝 请手动输入以下信息：".yellow());
            } else {
                eprintln!("{} QR code generation failed: {}", "⚠️".yellow(), e);
                println!("{}", "📝 Please enter this info manually:".yellow());
            }
            println!("{}", totp_manager.get_manual_setup_info());
        }
    }

    println!();
    if language == Language::Chinese {
        println!(
            "{} 或者手动输入密钥: {}",
            "🔑".bright_cyan(),
            twofa_secret.bright_white()
        );
    } else {
        println!(
            "{} Or enter manually: {}",
            "🔑".bright_cyan(),
            twofa_secret.bright_white()
        );
    }
    println!();

    // Verify 2FA setup
    loop {
        print!(
            "{}",
            if language == Language::Chinese {
                "请输入认证器显示的 6 位验证码以确认设置: "
            } else {
                "Enter the 6-digit code from your authenticator to verify: "
            }
        );
        io::stdout().flush().map_err(|e| e.to_string())?;

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .map_err(|e| e.to_string())?;
        let code = input.trim();

        match totp_manager.verify_code(code) {
            Ok(true) => {
                println!(
                    "{}",
                    if language == Language::Chinese {
                        "✅ 2FA 验证成功！".green()
                    } else {
                        "✅ 2FA verification successful!".green()
                    }
                );
                break;
            }
            Ok(false) => {
                println!(
                    "{}",
                    if language == Language::Chinese {
                        "❌ 验证码不正确，请重试".red()
                    } else {
                        "❌ Code incorrect, please try again".red()
                    }
                );
                continue;
            }
            Err(e) => {
                eprintln!(
                    "{} {}: {}",
                    "❌".red(),
                    if language == Language::Chinese {
                        "验证失败"
                    } else {
                        "Verification failed"
                    },
                    e
                );
                continue;
            }
        }
    }

    println!();
    if language == Language::Chinese {
        println!("{}", "🎉 三因子 2FA 设置完成！".green().bold());
        println!();
        println!("{}", "📝 重要信息（请妥善保管）:".yellow().bold());
        println!("  • 硬件指纹: 已绑定到当前设备");
        println!(
            "  • 安全问题: 问题 {} - {}",
            question_index + 1,
            crate::security_question::SECURITY_QUESTIONS[question_index]
        );
        println!("  • 2FA密钥: 已添加到认证器");
        println!();
        println!("{}", "💡 下一步: 使用选项5生成三因子钱包".bright_blue());
    } else {
        println!("{}", "🎉 Triple-factor 2FA setup complete!".green().bold());
        println!();
        println!("{}", "📝 Important info (keep safe):".yellow().bold());
        println!("  • Hardware fingerprint: Bound to current device");
        println!(
            "  • Security question: Question {} - {}",
            question_index + 1,
            crate::security_question::SECURITY_QUESTIONS[question_index]
        );
        println!("  • 2FA key: Added to authenticator");
        println!();
        println!(
            "{}",
            "💡 Next step: Use option 5 to generate triple-factor wallet".bright_blue()
        );
    }

    Ok(())
}

/// Generate triple-factor wallet interactively
#[cfg(feature = "2fa")]
fn generate_triple_factor_wallet_interactive(_language: Language) -> Result<(), String> {
    Err(
        "This feature will be implemented soon. Please use CLI command: fnzero-safe gen-2fa-wallet"
            .to_string(),
    )
}

/// Unlock triple-factor wallet interactively
#[cfg(feature = "2fa")]
fn unlock_triple_factor_wallet_interactive(_language: Language) -> Result<(), String> {
    Err("This feature will be implemented soon. Please use CLI command: fnzero-safe unlock-2fa-wallet -f <file>".to_string())
}

/// Read password with confirmation and validation
fn read_password_confirmed(texts: &Texts) -> Result<String, String> {
    println!("{}", texts.set_password);

    let password = prompt_password(texts.new_password, texts)?;

    if password.is_empty() {
        return Err(texts.password_empty.to_string());
    }

    if password.len() < 10 {
        return Err(texts.password_min_length.to_string());
    }

    let password_confirm = prompt_password(texts.confirm_password, texts)?;

    if password != password_confirm {
        return Err(texts.password_mismatch.to_string());
    }

    println!("{}", texts.password_set.green());
    Ok(password)
}
