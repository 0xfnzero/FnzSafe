use data_encoding::BASE32_NOPAD;
use qrcode::{render::unicode, QrCode};
use rand::{thread_rng, Rng};
use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};
use totp_rs::{Algorithm, TOTP};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TOTPConfig {
    pub secret: String,
    pub issuer: String,
    pub account: String,
    pub algorithm: String,
    pub digits: u32,
    pub step: u64,
}

impl Default for TOTPConfig {
    fn default() -> Self {
        Self {
            secret: String::new(),
            issuer: "FnzSafe".to_string(),
            account: "master-key".to_string(),
            algorithm: "SHA1".to_string(),
            digits: 6,
            step: 30,
        }
    }
}

pub struct TOTPManager {
    pub config: TOTPConfig,
}

impl TOTPManager {
    pub fn new(config: TOTPConfig) -> Self {
        Self { config }
    }

    /// 生成新的 TOTP 密钥
    pub fn generate_secret() -> String {
        let mut secret = [0u8; 20]; // 160 bits
        thread_rng().fill(&mut secret);
        BASE32_NOPAD.encode(&secret)
    }

    /// 创建 TOTP 实例
    pub fn create_totp(&self) -> Result<TOTP, String> {
        let algorithm = match self.config.algorithm.as_str() {
            "SHA1" => Algorithm::SHA1,
            "SHA256" => Algorithm::SHA256,
            "SHA512" => Algorithm::SHA512,
            _ => return Err("Unsupported algorithm".to_string()),
        };

        let secret_bytes = BASE32_NOPAD
            .decode(self.config.secret.as_bytes())
            .map_err(|_| "Invalid secret format")?;

        TOTP::new(
            algorithm,
            self.config.digits as usize,
            1,
            self.config.step,
            secret_bytes,
        )
        .map_err(|e| format!("TOTP creation failed: {}", e))
    }

    /// 生成当前的 TOTP 码
    pub fn generate_current_code(&self) -> Result<String, String> {
        let totp = self.create_totp()?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        Ok(totp.generate(timestamp))
    }

    /// 验证 TOTP 码
    pub fn verify_code(&self, code: &str) -> Result<bool, String> {
        let totp = self.create_totp()?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // 允许前后30秒的时间窗口（考虑时钟偏差）
        for window in [-1, 0, 1] {
            let check_time = timestamp as i64 + (window as i64 * self.config.step as i64);
            if check_time > 0 {
                let expected_code = totp.generate(check_time as u64);
                if expected_code == code {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// 验证 TOTP 码（扩展时间窗口用于解锁）
    pub fn verify_code_extended(&self, code: &str) -> Result<(bool, String), String> {
        let totp = self.create_totp()?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let current_code = totp.generate(timestamp);
        let mut debug_info = format!("当前时间戳: {}, 当前验证码: {}\n", timestamp, current_code);

        // 扩展时间窗口：前后1个窗口（±30秒，安全范围内）
        for window in -1..=1 {
            let check_time = timestamp as i64 + (window as i64 * self.config.step as i64);
            if check_time > 0 {
                let expected_code = totp.generate(check_time as u64);
                debug_info.push_str(&format!(
                    "窗口 {}: 时间戳 {}, 验证码 {}\n",
                    window, check_time, expected_code
                ));
                if expected_code == code {
                    return Ok((true, debug_info));
                }
            }
        }
        Ok((false, debug_info))
    }

    /// 获取多个时间窗口的验证码（用于调试）
    pub fn get_codes_for_windows(&self, windows: i32) -> Result<Vec<(i64, String)>, String> {
        let totp = self.create_totp()?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let mut codes = Vec::new();
        for window in -windows..=windows {
            let check_time = timestamp as i64 + (window as i64 * self.config.step as i64);
            if check_time > 0 {
                let code = totp.generate(check_time as u64);
                codes.push((check_time, code));
            }
        }
        Ok(codes)
    }

    /// 生成设置 QR 码
    pub fn generate_qr_code(&self) -> Result<String, String> {
        // 简化版本：直接构建 TOTP URI（不进行 URL 编码，假设账户名和发行商不包含特殊字符）
        let uri = format!(
            "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm={}&digits={}&period={}",
            self.config.issuer.replace(" ", "%20"),
            self.config.account.replace(" ", "%20"),
            self.config.secret,
            self.config.issuer.replace(" ", "%20"),
            self.config.algorithm,
            self.config.digits,
            self.config.step
        );

        let qr_code = QrCode::new(&uri).map_err(|e| format!("QR code generation failed: {}", e))?;

        Ok(qr_code
            .render::<unicode::Dense1x2>()
            .dark_color(unicode::Dense1x2::Light)
            .light_color(unicode::Dense1x2::Dark)
            .build())
    }

    /// 获取手动输入的密钥信息
    pub fn get_manual_setup_info(&self) -> String {
        format!(
            "Account: {}\nIssuer: {}\nSecret Key: {}\nTime Step: {} seconds\nDigits: {}",
            self.config.account,
            self.config.issuer,
            self.config.secret,
            self.config.step,
            self.config.digits
        )
    }

    /// 获取剩余有效时间
    pub fn get_remaining_time(&self) -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        self.config.step - (now % self.config.step)
    }

    /// 生成备用恢复码
    pub fn generate_backup_codes(&self, count: usize) -> Vec<String> {
        let mut codes = Vec::new();
        let mut rng = thread_rng();

        for _ in 0..count {
            let code: String = (0..8).map(|_| rng.gen_range(0..=9).to_string()).collect();
            codes.push(format!("{}-{}", &code[0..4], &code[4..8]));
        }

        codes
    }
}

/// 保存 TOTP 配置到文件
pub fn save_totp_config(config: &TOTPConfig, file_path: &str) -> Result<(), String> {
    let json_data =
        serde_json::to_string_pretty(config).map_err(|e| format!("JSON 序列化失败: {}", e))?;

    fs::write(file_path, json_data).map_err(|e| format!("文件写入失败: {}", e))
}

/// 从文件加载 TOTP 配置
pub fn load_totp_config(file_path: &str) -> Result<TOTPConfig, String> {
    let content = fs::read_to_string(file_path).map_err(|e| format!("读取配置文件失败: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("配置文件解析失败: {}", e))
}

/// 解析加密文件中的加密数据
pub fn parse_encrypted_file(content: &str) -> Result<String, String> {
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(json) => json
            .get("encrypted_private_key")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or("文件中未找到加密私钥".to_string()),
        Err(_) => {
            // 如果不是 JSON，尝试直接作为加密数据
            Ok(content.trim().to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_generation() {
        let secret = TOTPManager::generate_secret();
        assert!(!secret.is_empty());
        assert!(secret.len() >= 32); // Base32 encoded 160-bit key should be at least 32 chars
    }

    #[test]
    fn test_totp_creation() {
        let secret = TOTPManager::generate_secret();
        let config = TOTPConfig {
            secret,
            ..Default::default()
        };
        let manager = TOTPManager::new(config);
        assert!(manager.create_totp().is_ok());
    }

    #[test]
    fn test_code_generation_and_verification() {
        let secret = TOTPManager::generate_secret();
        let config = TOTPConfig {
            secret,
            ..Default::default()
        };
        let manager = TOTPManager::new(config);

        let code = manager.generate_current_code().unwrap();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));

        // 验证刚生成的代码应该是有效的
        assert!(manager.verify_code(&code).unwrap());

        // 验证无效代码
        assert!(!manager.verify_code("000000").unwrap());
    }
}
