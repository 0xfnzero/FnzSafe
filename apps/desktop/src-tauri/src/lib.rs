use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use aws_lc_rs::rsa::{OaepPublicEncryptingKey, PublicEncryptingKey, OAEP_SHA256_MGF1SHA256};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicU16, Ordering},
    Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, WebviewBuilder,
    WebviewUrl,
};
use tauri_plugin_deep_link::DeepLinkExt;
use zeroize::Zeroizing;

/// Must match `DEFAULT_API_PORT` in `src/lib/api.ts`
const FNZERO_SAFE_API_PORT: u16 = 3841;
const FNZERO_SAFE_API_PORT_ATTEMPTS: u16 = 32;
const SOLANA_MAX_ACCOUNT_DATA_BYTES: usize = 10 * 1024 * 1024;
const UPGRADEABLE_LOADER_PROGRAMDATA_METADATA_BYTES: usize = 45;
const MAX_PROGRAM_SO_BYTES: usize =
    SOLANA_MAX_ACCOUNT_DATA_BYTES - UPGRADEABLE_LOADER_PROGRAMDATA_METADATA_BYTES;
const MAX_PROGRAM_SO_BASE64_BYTES: usize = (MAX_PROGRAM_SO_BYTES + 2) / 3 * 4;
const MAX_PROXY_BODY_BYTES: usize = MAX_PROGRAM_SO_BASE64_BYTES + 1024 * 1024;
const MAX_DOWNLOAD_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SECURE_PUBLIC_KEY_PEM_BYTES: usize = 2 * 1024;
const PROGRAM_DEPLOY_PROXY_TIMEOUT_SECS: u64 = 60 * 60;
const MAX_PROGRAM_OPERATION_PROXY_TIMEOUT_SECS: u64 = 24 * 60 * 60;
const SECURE_BODY_HEADER: &str = "x-fnzero-safe-secure-body";
const SECURE_BODY_VERSION: &str = "1";
const DAPP_TAB_LABEL_PREFIX: &str = "dapp-tab-";
const DAPP_SIGN_REQUEST_EVENT: &str = "dapp://sign-request";
const DAPP_TAB_URL_EVENT: &str = "dapp://tab-url";
const DAPP_TAB_TITLE_EVENT: &str = "dapp://tab-title";
const DAPP_NEW_WINDOW_EVENT: &str = "dapp://new-window";
const DAPP_CONNECT_REQUEST_EVENT: &str = "dapp://connect-request";
const DAPP_REQUEST_TTL_MS: u64 = 3 * 60 * 1000;
const DAPP_WALLET_NAME: &str = "FnzSafe";
const DESKTOP_API_BIN_NAME: &str = "fnzero-safe-desktop-api";
const DESKTOP_API_PID_FILE_NAME: &str = "desktop-api.pid";
#[cfg(target_os = "macos")]
const BIOMETRIC_WALLET_PASSWORD_SERVICE: &str = "dev.fnzero-safe.wallet.password.v6";

#[derive(Clone)]
struct AllowedDapp {
    id: &'static str,
    name: &'static str,
}

#[derive(Clone)]
struct DappSession {
    app_id: String,
    app_name: String,
    url: String,
    wallet_public_key: String,
    network: String,
    opened_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
struct DappKnownProgram {
    program_id: String,
    label: String,
}

#[derive(Clone, Debug, Serialize)]
struct DappSignRequestEvent {
    request_id: String,
    app_id: String,
    app_name: String,
    app_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_purpose: Option<String>,
    method: String,
    wallet_public_key: String,
    network: String,
    transaction_base64: String,
    transaction_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    callback_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    known_programs: Vec<DappKnownProgram>,
    created_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
struct DappConnectRequestEvent {
    request_id: String,
    app_id: String,
    app_name: String,
    app_url: String,
    network: String,
    callback_url: String,
    created_at_ms: u64,
}

#[derive(Clone)]
struct DappPendingRequest {
    webview_label: String,
    event: DappSignRequestEvent,
    result: Option<DappSignResult>,
}

#[derive(Clone)]
struct DappPendingConnectRequest {
    event: DappConnectRequestEvent,
    result: Option<DappSignResult>,
}

#[derive(Clone, Serialize, Deserialize)]
struct DappSignResult {
    approved: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    public_key: Option<String>,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    raw_transaction: Option<String>,
    #[serde(default)]
    recent_blockhash: Option<String>,
}

#[derive(Serialize)]
struct DappPollResponse {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<DappSignResult>,
}

#[derive(Default)]
struct DappBridgeState {
    sessions: Mutex<HashMap<String, DappSession>>,
    requests: Mutex<HashMap<String, DappPendingRequest>>,
    connect_requests: Mutex<HashMap<String, DappPendingConnectRequest>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ManagedProcessPidRecord {
    pid: u32,
    executable: String,
}

fn managed_process_command(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let output = Command::new("ps")
            .args([
                "-ww",
                "-p",
                &pid.to_string(),
                "-o",
                "stat=",
                "-o",
                "command=",
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let process = String::from_utf8(output.stdout).ok()?;
        let process = process.trim();
        let split_at = process.find(char::is_whitespace)?;
        let status = &process[..split_at];
        if status.starts_with('Z') {
            return None;
        }
        let command = process[split_at..].trim().to_string();
        (!command.is_empty()).then_some(command)
    }
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').ExecutablePath"
                ),
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let executable = String::from_utf8(output.stdout).ok()?;
        let executable = executable.trim().to_string();
        (!executable.is_empty()).then_some(executable)
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(any(target_os = "windows", test))]
fn normalize_windows_executable_path(path: &str) -> String {
    let normalized = path.trim().replace('/', "\\");
    let normalized = normalized
        .strip_prefix(r"\\?\UNC\")
        .map(|path| format!(r"\\{path}"))
        .or_else(|| normalized.strip_prefix(r"\\?\").map(ToOwned::to_owned))
        .unwrap_or(normalized);
    normalized.to_lowercase()
}

fn managed_process_matches(record: &ManagedProcessPidRecord) -> bool {
    let Some(command) = managed_process_command(record.pid) else {
        return false;
    };
    #[cfg(target_os = "windows")]
    {
        normalize_windows_executable_path(&command)
            == normalize_windows_executable_path(&record.executable)
    }
    #[cfg(not(target_os = "windows"))]
    {
        command == record.executable
            || command
                .strip_prefix(&record.executable)
                .is_some_and(|suffix| suffix.starts_with(' '))
    }
}

fn signal_managed_process(pid: u32, force: bool) -> bool {
    #[cfg(unix)]
    {
        Command::new("kill")
            .arg(if force { "-KILL" } else { "-TERM" })
            .arg(pid.to_string())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = force;
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = (pid, force);
        false
    }
}

fn terminate_managed_process(record: &ManagedProcessPidRecord) -> Result<(), String> {
    if record.pid <= 1 || record.pid == std::process::id() {
        return Ok(());
    }
    if managed_process_command(record.pid).is_none() {
        return Ok(());
    }
    if !managed_process_matches(record) {
        return Err(format!(
            "PID {} 已被其他进程复用，拒绝终止；记录的程序为 {}",
            record.pid, record.executable
        ));
    }
    if !signal_managed_process(record.pid, false) {
        return Err(format!("无法终止历史 FnzSafe 进程 PID {}", record.pid));
    }
    for _ in 0..30 {
        if managed_process_command(record.pid).is_none() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !managed_process_matches(record) {
        return Ok(());
    }
    if !signal_managed_process(record.pid, true) {
        return Err(format!("无法强制终止历史 FnzSafe 进程 PID {}", record.pid));
    }
    for _ in 0..10 {
        if managed_process_command(record.pid).is_none() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("历史 FnzSafe 进程 PID {} 仍在运行", record.pid))
}

fn read_managed_pid_file(path: &Path) -> Result<Option<ManagedProcessPidRecord>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 PID 文件 {} 失败: {error}", path.display())),
    };
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("解析 PID 文件 {} 失败: {error}", path.display()))
}

fn write_managed_pid_file(path: &Path, executable: &Path, pid: u32) -> Result<(), String> {
    let executable = executable
        .canonicalize()
        .unwrap_or_else(|_| executable.to_path_buf());
    let record = ManagedProcessPidRecord {
        pid,
        executable: executable.to_string_lossy().to_string(),
    };
    let parent = path
        .parent()
        .ok_or_else(|| format!("PID 文件路径无父目录: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建 PID 文件目录 {} 失败: {error}", parent.display()))?;
    let contents =
        serde_json::to_vec(&record).map_err(|error| format!("序列化 PID 文件失败: {error}"))?;
    fs::write(path, contents)
        .map_err(|error| format!("写入 PID 文件 {} 失败: {error}", path.display()))?;
    set_private_file_permissions(path);
    Ok(())
}

fn remove_owned_pid_file(path: &Path, pid: u32) {
    if read_managed_pid_file(path)
        .ok()
        .flatten()
        .is_some_and(|record| record.pid == pid)
    {
        let _ = fs::remove_file(path);
    }
}

fn terminate_recorded_process(path: &Path) -> Result<(), String> {
    if let Some(record) = read_managed_pid_file(path)? {
        terminate_managed_process(&record)?;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("删除 PID 文件 {} 失败: {error}", path.display()));
            }
        }
    }
    Ok(())
}

struct DesktopApiProcess {
    child: Mutex<Option<Child>>,
    port: AtomicU16,
    pid_file: PathBuf,
}

impl DesktopApiProcess {
    fn new(pid_file: PathBuf) -> Self {
        Self {
            child: Mutex::new(None),
            port: AtomicU16::new(FNZERO_SAFE_API_PORT),
            pid_file,
        }
    }

    fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::Relaxed);
    }
}

impl Drop for DesktopApiProcess {
    fn drop(&mut self) {
        let Ok(child) = self.child.get_mut() else {
            return;
        };
        if let Some(mut child) = child.take() {
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            remove_owned_pid_file(&self.pid_file, pid);
        }
    }
}

#[derive(Clone, Serialize)]
struct DappTabUrlEvent {
    tab_id: String,
    url: String,
    loaded: bool,
}

#[derive(Clone, Serialize)]
struct DappTabTitleEvent {
    tab_id: String,
    title: String,
}

#[derive(Clone, Serialize)]
struct DappNewWindowEvent {
    source_tab_id: String,
    url: String,
}

#[derive(Serialize)]
struct ProxyResponse {
    status: u16,
    body: String,
}

#[derive(Deserialize)]
struct ProxyRequestHeader {
    name: String,
    value: String,
}

#[derive(Deserialize)]
struct SecureSessionResponse {
    version: String,
    public_key_pem: String,
    api_token: Option<String>,
}

#[derive(Deserialize)]
struct BiometricWalletRequest {
    wallet_id: String,
    public_key: String,
}

#[derive(Deserialize)]
struct BiometricWalletStoreRequest {
    wallet_id: String,
    public_key: String,
    password: String,
}

#[derive(Serialize)]
struct BiometricWalletStatus {
    supported: bool,
    configured: bool,
    reason: Option<String>,
}

#[derive(Clone)]
struct BiometricWalletAccounts {
    primary: String,
}

fn biometric_wallet_accounts(
    wallet_id: &str,
    public_key: &str,
) -> Result<BiometricWalletAccounts, String> {
    let wallet_id = wallet_id.trim();
    let public_key = public_key.trim();
    if wallet_id.len() != 32 || !wallet_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid wallet id".to_string());
    }
    if !is_likely_solana_pubkey(public_key) {
        return Err("invalid wallet public key".to_string());
    }
    Ok(BiometricWalletAccounts {
        primary: format!("solana:{public_key}"),
    })
}

#[cfg(target_os = "macos")]
fn biometric_error_message(error: security_framework::base::Error) -> String {
    let code = error.code();
    match code {
        -128 => "Touch ID 已取消".to_string(),
        -25300 => "还没有为这个钱包启用 Touch ID".to_string(),
        -25293 => "Touch ID 验证失败或无权读取 Keychain 凭据".to_string(),
        _ => format!("macOS Keychain 错误: {code}"),
    }
}

#[cfg(target_os = "macos")]
fn biometric_local_auth_error_message(code: objc2_foundation::NSInteger) -> String {
    match code {
        -1 => "Touch ID 验证失败".to_string(),
        -2 => "Touch ID 已取消".to_string(),
        -3 => "Touch ID 已切换到密码输入".to_string(),
        -4 => "Touch ID 被系统中断".to_string(),
        -5 => "macOS 未设置登录密码，无法使用 Touch ID".to_string(),
        -6 => "这台 Mac 不支持 Touch ID".to_string(),
        -7 => "还没有在 macOS 中录入 Touch ID 指纹".to_string(),
        -8 => "Touch ID 已锁定，请先用系统密码解锁 Touch ID".to_string(),
        -9 => "Touch ID 验证已被应用取消".to_string(),
        -10 => "Touch ID 验证上下文已失效".to_string(),
        -1004 => "Touch ID 当前不允许弹出交互窗口".to_string(),
        _ => format!("macOS Touch ID 错误: {code}"),
    }
}

#[cfg(target_os = "macos")]
fn biometric_touch_id_available() -> Result<(), String> {
    use objc2_local_authentication::{LAContext, LAPolicy};

    let context = unsafe { LAContext::new() };
    unsafe {
        context
            .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
            .map_err(|error| biometric_local_auth_error_message(error.code()))
    }
}

#[cfg(target_os = "macos")]
fn biometric_touch_id_authenticate() -> Result<(), String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::mpsc;

    let context = unsafe { LAContext::new() };
    unsafe {
        context
            .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
            .map_err(|error| biometric_local_auth_error_message(error.code()))?;
    }

    let reason = NSString::from_str("使用 Touch ID 解锁 FnzSafe 钱包密码");
    let (tx, rx) = mpsc::channel();
    let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
        let result = if success.as_bool() {
            Ok(())
        } else if error.is_null() {
            Err(-1)
        } else {
            Err(unsafe { (&*error).code() })
        };
        let _ = tx.send(result);
    });

    unsafe {
        context.evaluatePolicy_localizedReason_reply(
            LAPolicy::DeviceOwnerAuthenticationWithBiometrics,
            &reason,
            &reply,
        );
    }

    rx.recv()
        .map_err(|_| "Touch ID 验证未完成".to_string())?
        .map_err(biometric_local_auth_error_message)
}

#[cfg(target_os = "macos")]
mod biometric_wallet_keychain {
    use super::{biometric_error_message, BIOMETRIC_WALLET_PASSWORD_SERVICE};
    use security_framework::{
        item::{ItemClass, ItemSearchOptions},
        passwords::{
            delete_generic_password, generic_password, set_generic_password, PasswordOptions,
        },
    };

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    fn exists(service: &str, account: &str) -> Result<bool, String> {
        let mut query = ItemSearchOptions::new();
        query
            .class(ItemClass::generic_password())
            .service(service)
            .account(account)
            .load_attributes(true);
        match query.search() {
            Ok(items) => Ok(!items.is_empty()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
            Err(error) => Err(biometric_error_message(error)),
        }
    }

    pub fn configured(primary_account: &str) -> Result<bool, String> {
        exists(BIOMETRIC_WALLET_PASSWORD_SERVICE, primary_account)
    }

    pub fn store(primary_account: &str, password: &str) -> Result<(), String> {
        let _ = delete_generic_password(BIOMETRIC_WALLET_PASSWORD_SERVICE, primary_account);
        set_generic_password(
            BIOMETRIC_WALLET_PASSWORD_SERVICE,
            primary_account,
            password.as_bytes(),
        )
        .map_err(biometric_error_message)?;
        if !configured(primary_account)? {
            return Err("Touch ID 凭据保存后无法在 Keychain 中确认".to_string());
        }
        Ok(())
    }

    pub fn load(primary_account: &str) -> Result<String, String> {
        let options = PasswordOptions::new_generic_password(
            BIOMETRIC_WALLET_PASSWORD_SERVICE,
            primary_account,
        );
        let password = generic_password(options).map_err(biometric_error_message)?;
        String::from_utf8(password)
            .map_err(|_| "Keychain 凭据不是有效的 UTF-8 钱包密码".to_string())
    }

    pub fn delete(primary_account: &str) -> Result<(), String> {
        match delete_generic_password(BIOMETRIC_WALLET_PASSWORD_SERVICE, primary_account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(biometric_error_message(error)),
        }
    }
}

#[tauri::command]
fn biometric_wallet_status(req: BiometricWalletRequest) -> Result<BiometricWalletStatus, String> {
    let accounts = biometric_wallet_accounts(&req.wallet_id, &req.public_key)?;
    #[cfg(target_os = "macos")]
    {
        let supported = biometric_touch_id_available();
        let configured = biometric_wallet_keychain::configured(&accounts.primary)?;
        Ok(BiometricWalletStatus {
            supported: supported.is_ok(),
            configured: configured && supported.is_ok(),
            reason: supported.err(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = accounts;
        Ok(BiometricWalletStatus {
            supported: false,
            configured: false,
            reason: Some("Touch ID 只支持 macOS 桌面客户端".to_string()),
        })
    }
}

#[tauri::command]
fn biometric_wallet_store_password(req: BiometricWalletStoreRequest) -> Result<(), String> {
    let accounts = biometric_wallet_accounts(&req.wallet_id, &req.public_key)?;
    if req.password.is_empty() {
        return Err("wallet password is required".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        biometric_wallet_keychain::store(&accounts.primary, &req.password)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = accounts;
        Err("Touch ID 只支持 macOS 桌面客户端".to_string())
    }
}

#[tauri::command]
fn biometric_wallet_get_password(req: BiometricWalletRequest) -> Result<String, String> {
    let accounts = biometric_wallet_accounts(&req.wallet_id, &req.public_key)?;
    #[cfg(target_os = "macos")]
    {
        biometric_touch_id_authenticate()?;
        biometric_wallet_keychain::load(&accounts.primary)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = accounts;
        Err("Touch ID 只支持 macOS 桌面客户端".to_string())
    }
}

#[tauri::command]
fn biometric_wallet_delete_password(req: BiometricWalletRequest) -> Result<(), String> {
    let accounts = biometric_wallet_accounts(&req.wallet_id, &req.public_key)?;
    #[cfg(target_os = "macos")]
    {
        biometric_wallet_keychain::delete(&accounts.primary)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = accounts;
        Ok(())
    }
}

fn encrypt_secure_body(body: &str, public_key_pem: &str) -> Result<String, String> {
    if public_key_pem.len() > MAX_SECURE_PUBLIC_KEY_PEM_BYTES {
        return Err("invalid secure API public key: PEM is too large".to_string());
    }
    let mut public_key_der = [0_u8; 1024];
    let (label, public_key_der) =
        pem_rfc7468::decode(public_key_pem.as_bytes(), &mut public_key_der)
            .map_err(|e| format!("invalid secure API public key PEM: {}", e))?;
    if label != "PUBLIC KEY" {
        return Err("invalid secure API public key PEM label".to_string());
    }
    let public_key = PublicEncryptingKey::from_der(public_key_der)
        .map_err(|e| format!("invalid secure API public key: {}", e))?;
    if public_key.key_size_bits() != 2048 {
        return Err("invalid secure API public key size".to_string());
    }
    let public_key = OaepPublicEncryptingKey::new(public_key)
        .map_err(|_| "failed to initialize secure API public key".to_string())?;
    let mut rng = OsRng;
    let mut aes_key = Zeroizing::new([0_u8; 32]);
    rng.fill_bytes(&mut *aes_key);
    let mut iv = [0_u8; 12];
    rng.fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new_from_slice(&*aes_key)
        .map_err(|_| "failed to initialize request encryption")?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&iv), body.as_bytes())
        .map_err(|_| "failed to encrypt request body")?;
    let mut encrypted_key = vec![0_u8; public_key.ciphertext_size()];
    let encrypted_key_len = public_key
        .encrypt(&OAEP_SHA256_MGF1SHA256, &*aes_key, &mut encrypted_key, None)
        .map_err(|_| "failed to encrypt request key".to_string())?
        .len();
    encrypted_key.truncate(encrypted_key_len);

    Ok(json!({
      "version": 1,
      "encrypted_key": BASE64.encode(encrypted_key),
      "iv": BASE64.encode(iv),
      "ciphertext": BASE64.encode(ciphertext),
    })
    .to_string())
}

fn proxied_api_path_requires_token(path: &str) -> bool {
    !matches!(path.trim_matches('/'), "health" | "secure/session")
}

fn proxied_api_path_is_long_running_program_operation(path: &str) -> bool {
    matches!(
        path.trim_matches('/'),
        "program/deploy" | "program/upgrade" | "squads/program/prepare-upgrade-buffer"
    )
}

async fn fetch_secure_session(
    client: &reqwest::Client,
    api_port: u16,
) -> Result<SecureSessionResponse, String> {
    let session_url = format!("http://127.0.0.1:{api_port}/api/secure/session");
    let session_resp = client
        .get(session_url)
        .send()
        .await
        .map_err(|e| format!("failed to initialize secure API session: {}", e))?;
    if !session_resp.status().is_success() {
        return Err(format!(
            "failed to initialize secure API session: HTTP {}",
            session_resp.status().as_u16()
        ));
    }
    let session = session_resp
        .json::<SecureSessionResponse>()
        .await
        .map_err(|e| format!("invalid secure API session: {}", e))?;
    if session.version != SECURE_BODY_VERSION {
        return Err("unsupported secure API session version".to_string());
    }
    Ok(session)
}

/// HTTP from Rust → avoids WKWebView `fetch` URL issues with localhost /api.
#[tauri::command]
async fn proxy_api_request(
    process: tauri::State<'_, DesktopApiProcess>,
    method: String,
    path: String,
    headers: Option<Vec<ProxyRequestHeader>>,
    body: Option<String>,
    secure_proxy: Option<bool>,
) -> Result<ProxyResponse, String> {
    let path = path.trim_start_matches('/');
    if path.is_empty()
        || path.contains("://")
        || path.contains('\\')
        || path.split('/').any(|part| part == "..")
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.'))
    {
        return Err("invalid API path".to_string());
    }
    if let Some(b) = body.as_ref() {
        if b.len() > MAX_PROXY_BODY_BYTES {
            return Err("request body too large".to_string());
        }
    }
    let api_port = process.port();
    let url = format!("http://127.0.0.1:{api_port}/api/{path}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(
            PROGRAM_DEPLOY_PROXY_TIMEOUT_SECS,
        ))
        .build()
        .map_err(|e| e.to_string())?;

    let method_upper = method.to_uppercase();
    let secure_proxy = secure_proxy.unwrap_or(false);
    let mut req = match method_upper.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "PATCH" => client.patch(&url),
        _ => return Err(format!("unsupported HTTP method: {}", method)),
    };
    if proxied_api_path_is_long_running_program_operation(path) {
        req = req.timeout(std::time::Duration::from_secs(
            MAX_PROGRAM_OPERATION_PROXY_TIMEOUT_SECS,
        ));
    }

    req = req.header("Content-Type", "application/json");
    req = req.header("Origin", "tauri://localhost");
    if let Some(headers) = headers {
        for header in headers {
            let name = header.name.to_ascii_lowercase();
            if matches!(name.as_str(), "content-type" | SECURE_BODY_HEADER) {
                req = req.header(name, header.value);
            }
        }
    }
    let mut session = None;
    if proxied_api_path_requires_token(path) {
        let mut token_attached = false;
        if let Ok(token) = std::env::var("FNZERO_SAFE_API_TOKEN")
            .or_else(|_| std::env::var("SOL_SAFEKEY_API_TOKEN"))
        {
            let token = token.trim().to_string();
            if !token.is_empty() {
                req = req.header("X-Fnzero-Safe-Token", token);
                token_attached = true;
            }
        }
        if !token_attached {
            session = Some(fetch_secure_session(&client, api_port).await?);
            let token = session
                .as_ref()
                .and_then(|session| session.api_token.as_deref())
                .ok_or_else(|| {
                    "secure API session did not provide a local API token".to_string()
                })?;
            req = req.header("X-Fnzero-Safe-Token", token);
        }
    }
    if let Some(b) = body {
        if secure_proxy && matches!(method_upper.as_str(), "POST" | "PUT" | "PATCH") {
            let b = Zeroizing::new(b);
            if session.is_none() {
                session = Some(fetch_secure_session(&client, api_port).await?);
            }
            let session = session.as_ref().expect("secure session is initialized");
            let encrypted_body = encrypt_secure_body(&b, &session.public_key_pem)?;
            req = req.header(SECURE_BODY_HEADER, SECURE_BODY_VERSION);
            req = req.body(encrypted_body);
        } else {
            req = req.body(b);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(ProxyResponse { status, body })
}

fn is_allowed_external_https_url(url: &str) -> bool {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") || trimmed.len() > 2048 {
        return false;
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let Some(rest) = trimmed.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() || host.starts_with('.') || host.ends_with('.') || host.contains('@') {
        return false;
    }
    true
}

fn spawn_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to open external browser: {error}"))
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to open external browser: {error}"))
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to open external browser: {error}"))
    }
}

fn reveal_file_in_system_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to reveal download file: {error}"))
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to reveal download file: {error}"))
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let directory = path.parent().unwrap_or_else(|| Path::new("/"));
        std::process::Command::new("xdg-open")
            .arg(directory)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to open download directory: {error}"))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn allowed_dapp(app_id: &str) -> Option<AllowedDapp> {
    match app_id.trim().to_ascii_lowercase().as_str() {
        "jupiter" => Some(AllowedDapp {
            id: "jupiter",
            name: "Jupiter",
        }),
        "pumpfun" => Some(AllowedDapp {
            id: "pumpfun",
            name: "pump.fun",
        }),
        "raydium" => Some(AllowedDapp {
            id: "raydium",
            name: "Raydium",
        }),
        "meteora" => Some(AllowedDapp {
            id: "meteora",
            name: "Meteora",
        }),
        "orca" => Some(AllowedDapp {
            id: "orca",
            name: "Orca",
        }),
        "drift" => Some(AllowedDapp {
            id: "drift",
            name: "Drift",
        }),
        "kamino" => Some(AllowedDapp {
            id: "kamino",
            name: "Kamino",
        }),
        "tensor" => Some(AllowedDapp {
            id: "tensor",
            name: "Tensor",
        }),
        "magiceden" => Some(AllowedDapp {
            id: "magiceden",
            name: "Magic Eden",
        }),
        "sanctum" => Some(AllowedDapp {
            id: "sanctum",
            name: "Sanctum",
        }),
        _ => None,
    }
}

fn dapp_tab_label(tab_id: &str) -> Result<String, String> {
    let trimmed = tab_id.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("invalid dapp tab id".to_string());
    }
    Ok(format!("{DAPP_TAB_LABEL_PREFIX}{trimmed}"))
}

fn dapp_tab_id_from_label(label: &str) -> Option<String> {
    label
        .strip_prefix(DAPP_TAB_LABEL_PREFIX)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn dapp_browser_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    data_dir.push("dapp-browser-profile");
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("failed to create dapp browser profile directory: {error}"))?;
    Ok(data_dir)
}

fn is_safe_browser_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "https" => url.host_str().is_some_and(|host| {
            !host.is_empty()
                && !host.starts_with('.')
                && !host.ends_with('.')
                && !host.contains('@')
        }),
        "http" => url
            .host_str()
            .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1")),
        _ => false,
    }
}

fn is_safe_dapp_webview_navigation_url(url: &tauri::Url) -> bool {
    if is_safe_browser_url(url) {
        return true;
    }

    matches!(url.scheme(), "about" | "blob" | "data")
}

fn is_allowed_connected_dapp_navigation_url(dapp: &AllowedDapp, url: &tauri::Url) -> bool {
    is_allowed_dapp_url(dapp, url) || matches!(url.scheme(), "about" | "blob")
}

fn parse_dapp_browser_url(raw_url: &str) -> Result<tauri::Url, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return Err("invalid dapp URL".to_string());
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("invalid dapp URL".to_string());
    }
    let url = trimmed
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid dapp URL: {error}"))?;
    if !is_safe_browser_url(&url) {
        return Err(
            "only https URLs or localhost http URLs can be opened in DApp tabs".to_string(),
        );
    }
    Ok(url)
}

fn host_matches_domain(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

fn is_allowed_dapp_url(dapp: &AllowedDapp, url: &tauri::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(|value| value.to_ascii_lowercase()) else {
        return false;
    };
    match dapp.id {
        "jupiter" => host_matches_domain(&host, "jup.ag"),
        "pumpfun" => host_matches_domain(&host, "pump.fun"),
        "raydium" => host_matches_domain(&host, "raydium.io"),
        "meteora" => host_matches_domain(&host, "meteora.ag"),
        "orca" => host_matches_domain(&host, "orca.so"),
        "drift" => host_matches_domain(&host, "drift.trade"),
        "kamino" => host_matches_domain(&host, "kamino.finance"),
        "tensor" => host_matches_domain(&host, "tensor.trade"),
        "magiceden" => host_matches_domain(&host, "magiceden.io"),
        "sanctum" => host_matches_domain(&host, "sanctum.so"),
        _ => false,
    }
}

fn dapp_webview_bounds(x: f64, y: f64, width: f64, height: f64) -> Result<Rect, String> {
    if !(width.is_finite() && height.is_finite() && x.is_finite() && y.is_finite())
        || width < 40.0
        || height < 40.0
        || width > 10000.0
        || height > 10000.0
    {
        return Err("invalid dapp tab bounds".to_string());
    }
    Ok(Rect {
        position: Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(width, height)),
    })
}

fn is_likely_solana_pubkey(value: &str) -> bool {
    let trimmed = value.trim();
    (32..=44).contains(&trimmed.len())
        && trimmed
            .bytes()
            .all(|b| matches!(b, b'1'..=b'9' | b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z' | b'a'..=b'k' | b'm'..=b'z'))
}

fn validate_dapp_method(method: &str) -> Result<String, String> {
    let normalized = method.trim();
    match normalized {
        "signTransaction"
        | "signAllTransactions"
        | "signAndSendTransaction"
        | "sendTransaction"
        | "signMessage" => Ok(normalized.to_string()),
        _ => Err("unsupported dapp signing method".to_string()),
    }
}

fn validate_transaction_format(format: &str) -> Result<String, String> {
    let normalized = format.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "legacy" | "versioned" | "v0" | "auto" => Ok(normalized),
        _ => Err("unsupported transaction format".to_string()),
    }
}

fn validate_dapp_transaction_base64(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 {
        return Err("invalid transaction payload".to_string());
    }
    if BASE64.decode(trimmed).is_err() {
        return Err("transaction payload is not valid base64".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_dapp_message_base64(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 24 * 1024 {
        return Err("invalid message payload".to_string());
    }
    let bytes = BASE64
        .decode(trimmed)
        .map_err(|_| "message payload is not valid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > 16 * 1024 {
        return Err("invalid message payload".to_string());
    }
    Ok(trimmed.to_string())
}

fn dapp_request_id() -> String {
    let mut random = [0_u8; 8];
    OsRng.fill_bytes(&mut random);
    format!("dapp-{}-{}", now_ms(), BASE64.encode(random)).replace(['+', '/', '='], "")
}

fn deep_link_query_param(url: &tauri::Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn validate_short_deep_link_text(
    value: &str,
    field: &str,
    max_len: usize,
) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_len || trimmed.chars().any(|ch| ch.is_control()) {
        return Err(format!("invalid {field}"));
    }
    Ok(trimmed.to_string())
}

fn validate_dapp_network(network: &str) -> Result<String, String> {
    let trimmed = network.trim();
    if trimmed.is_empty() || trimmed.len() > 256 || trimmed.chars().any(|ch| ch.is_control()) {
        return Err("invalid network".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_deep_link_request_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 128
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':'))
    {
        return Err("invalid request_id".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_known_program_label(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 48
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '.' | '-' | '_' | '/'))
    {
        return Err("invalid known_program label".to_string());
    }
    Ok(trimmed.to_string())
}

fn parse_known_program(value: &str) -> Result<DappKnownProgram, String> {
    let Some((program_id, label)) = value.split_once(':') else {
        return Err("known_program must use program_id:label".to_string());
    };
    let program_id = validate_short_deep_link_text(program_id, "known_program program_id", 64)?;
    if !is_likely_solana_pubkey(&program_id) {
        return Err("known_program program_id is invalid".to_string());
    }
    let label = validate_known_program_label(label)?;
    Ok(DappKnownProgram { program_id, label })
}

fn deep_link_known_programs(url: &tauri::Url) -> Result<Vec<DappKnownProgram>, String> {
    let mut programs = Vec::new();
    for (_, value) in url.query_pairs().filter(|(key, _)| key == "known_program") {
        if programs.len() >= 16 {
            return Err("too many known_program entries".to_string());
        }
        let program = parse_known_program(&value)?;
        if !programs
            .iter()
            .any(|existing: &DappKnownProgram| existing.program_id == program.program_id)
        {
            programs.push(program);
        }
    }
    Ok(programs)
}

fn validate_deep_link_app_url(value: &str) -> Result<tauri::Url, String> {
    let url = parse_dapp_browser_url(value)?;
    if url.scheme() != "https" && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
    {
        return Err("deep link app_url must be https or localhost http".to_string());
    }
    Ok(url)
}

fn related_callback_host(app_host: &str, callback_host: &str) -> bool {
    app_host == callback_host
        || callback_host.ends_with(&format!(".{app_host}"))
        || app_host.ends_with(&format!(".{callback_host}"))
}

fn validate_deep_link_callback_url(
    callback_url: Option<String>,
    app_url: &tauri::Url,
) -> Result<Option<String>, String> {
    let Some(callback_url) = callback_url else {
        return Ok(None);
    };
    let trimmed = callback_url.trim();
    let callback = trimmed
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid callback_url: {error}"))?;
    let callback_is_local_http = callback.scheme() == "http"
        && matches!(callback.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if callback.scheme() != "https" && !callback_is_local_http {
        return Err("callback_url must be a valid https or localhost URL".to_string());
    }
    let app_host = app_url
        .host_str()
        .ok_or_else(|| "app_url host is required".to_string())?
        .to_ascii_lowercase();
    let callback_host = callback
        .host_str()
        .ok_or_else(|| "callback_url host is required".to_string())?
        .to_ascii_lowercase();
    if !related_callback_host(&app_host, &callback_host) {
        return Err("callback_url must belong to the same site as app_url".to_string());
    }
    Ok(Some(trimmed.to_string()))
}

fn is_sign_deep_link(url: &tauri::Url) -> bool {
    if url.scheme() != "fnzsafe" {
        return false;
    }
    let host_is_sign = url.host_str().is_some_and(|host| host == "sign");
    let path_is_sign = url.path().trim_matches('/') == "sign";
    host_is_sign || path_is_sign
}

fn is_connect_deep_link(url: &tauri::Url) -> bool {
    if url.scheme() != "fnzsafe" {
        return false;
    }
    let host_is_connect = url.host_str().is_some_and(|host| host == "connect");
    let path_is_connect = url.path().trim_matches('/') == "connect";
    host_is_connect || path_is_connect
}

fn parse_connect_deep_link(url: &tauri::Url) -> Result<DappConnectRequestEvent, String> {
    if !is_connect_deep_link(url) {
        return Err("unsupported fnzsafe connect deep link".to_string());
    }
    let network = validate_dapp_network(
        deep_link_query_param(url, "network")
            .as_deref()
            .unwrap_or("mainnet"),
    )?;
    let app_url = validate_deep_link_app_url(
        deep_link_query_param(url, "app_url")
            .as_deref()
            .ok_or_else(|| "app_url is required".to_string())?,
    )?;
    let app_url_string = app_url.as_str().to_string();
    let app_name = deep_link_query_param(url, "app_name")
        .map(|value| validate_short_deep_link_text(&value, "app_name", 80))
        .transpose()?
        .unwrap_or_else(|| {
            app_url
                .host_str()
                .map(|host| host.to_string())
                .unwrap_or_else(|| "FnzSafe Web".to_string())
        });
    let request_id = deep_link_query_param(url, "request_id")
        .map(|value| validate_deep_link_request_id(&value))
        .transpose()?
        .unwrap_or_else(dapp_request_id);
    let callback_url = validate_deep_link_callback_url(
        Some(
            deep_link_query_param(url, "callback_url")
                .ok_or_else(|| "callback_url is required".to_string())?,
        ),
        &app_url,
    )?
    .ok_or_else(|| "callback_url is required".to_string())?;

    Ok(DappConnectRequestEvent {
        request_id,
        app_id: "fnzsafe-deep-link".to_string(),
        app_name,
        app_url: app_url_string,
        network,
        callback_url,
        created_at_ms: now_ms(),
    })
}

fn parse_sign_deep_link(url: &tauri::Url) -> Result<DappSignRequestEvent, String> {
    if !is_sign_deep_link(url) {
        return Err("unsupported fnzsafe deep link".to_string());
    }

    let method = validate_dapp_method(
        deep_link_query_param(url, "method")
            .as_deref()
            .ok_or_else(|| "method is required".to_string())?,
    )?;
    let wallet_public_key = validate_short_deep_link_text(
        deep_link_query_param(url, "wallet_public_key")
            .as_deref()
            .ok_or_else(|| "wallet_public_key is required".to_string())?,
        "wallet_public_key",
        64,
    )?;
    if !is_likely_solana_pubkey(&wallet_public_key) {
        return Err("invalid wallet public key".to_string());
    }
    let network = validate_dapp_network(
        deep_link_query_param(url, "network")
            .as_deref()
            .unwrap_or("mainnet"),
    )?;
    let app_url = validate_deep_link_app_url(
        deep_link_query_param(url, "app_url")
            .as_deref()
            .ok_or_else(|| "app_url is required".to_string())?,
    )?;
    let app_url_string = app_url.as_str().to_string();
    let app_name = deep_link_query_param(url, "app_name")
        .map(|value| validate_short_deep_link_text(&value, "app_name", 80))
        .transpose()?
        .unwrap_or_else(|| {
            app_url
                .host_str()
                .map(|host| host.to_string())
                .unwrap_or_else(|| "FnzSafe Web".to_string())
        });
    let request_purpose = deep_link_query_param(url, "request_purpose")
        .map(|value| validate_short_deep_link_text(&value, "request_purpose", 80))
        .transpose()?;
    let request_id = deep_link_query_param(url, "request_id")
        .map(|value| validate_deep_link_request_id(&value))
        .transpose()?
        .unwrap_or_else(dapp_request_id);
    let callback_url =
        validate_deep_link_callback_url(deep_link_query_param(url, "callback_url"), &app_url)?;

    let (transaction_base64, transaction_format, message_base64) = if method == "signMessage" {
        let message_base64 = validate_dapp_message_base64(
            deep_link_query_param(url, "message_base64")
                .as_deref()
                .ok_or_else(|| "message payload is required".to_string())?,
        )?;
        ("".to_string(), "message".to_string(), Some(message_base64))
    } else {
        let transaction_base64 = validate_dapp_transaction_base64(
            deep_link_query_param(url, "transaction_base64")
                .as_deref()
                .ok_or_else(|| "transaction payload is required".to_string())?,
        )?;
        let transaction_format = validate_transaction_format(
            deep_link_query_param(url, "transaction_format")
                .as_deref()
                .unwrap_or("auto"),
        )?;
        (transaction_base64, transaction_format, None)
    };

    Ok(DappSignRequestEvent {
        request_id,
        app_id: "fnzsafe-deep-link".to_string(),
        app_name,
        app_url: app_url_string,
        request_purpose,
        method,
        wallet_public_key,
        network,
        transaction_base64,
        transaction_format,
        message_base64,
        callback_url,
        known_programs: deep_link_known_programs(url)?,
        created_at_ms: now_ms(),
    })
}

fn enqueue_dapp_sign_request(
    app: &tauri::AppHandle,
    state: &DappBridgeState,
    webview_label: String,
    event: DappSignRequestEvent,
) -> Result<(), String> {
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "dapp request lock poisoned".to_string())?;
    requests.retain(|_, pending| {
        now_ms().saturating_sub(pending.event.created_at_ms) <= DAPP_REQUEST_TTL_MS
            && pending.result.is_none()
    });
    if requests.contains_key(&event.request_id) {
        return Err("dapp signing request id is already pending".to_string());
    }
    requests.insert(
        event.request_id.clone(),
        DappPendingRequest {
            webview_label,
            event: event.clone(),
            result: None,
        },
    );
    drop(requests);

    app.emit_to("main", DAPP_SIGN_REQUEST_EVENT, event)
        .map_err(|error| format!("failed to notify main window: {error}"))
}

fn enqueue_dapp_connect_request(
    app: &tauri::AppHandle,
    state: &DappBridgeState,
    event: DappConnectRequestEvent,
) -> Result<(), String> {
    let mut requests = state
        .connect_requests
        .lock()
        .map_err(|_| "dapp connect request lock poisoned".to_string())?;
    requests.retain(|_, pending| {
        now_ms().saturating_sub(pending.event.created_at_ms) <= DAPP_REQUEST_TTL_MS
            && pending.result.is_none()
    });
    if requests.contains_key(&event.request_id) {
        return Err("dapp connect request id is already pending".to_string());
    }
    requests.insert(
        event.request_id.clone(),
        DappPendingConnectRequest {
            event: event.clone(),
            result: None,
        },
    );
    drop(requests);

    app.emit_to("main", DAPP_CONNECT_REQUEST_EVENT, event)
        .map_err(|error| format!("failed to notify main window: {error}"))
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn append_dapp_result_to_callback_url(
    callback_url: &str,
    request_id: &str,
    result: &DappSignResult,
) -> Result<String, String> {
    let mut url = callback_url
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid callback_url: {error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("request_id", request_id);
        query.append_pair("approved", if result.approved { "true" } else { "false" });
        if let Some(error) = result.error.as_deref() {
            query.append_pair("error", error);
        }
        if let Some(public_key) = result.public_key.as_deref() {
            query.append_pair("public_key", public_key);
        }
        if let Some(signature) = result.signature.as_deref() {
            query.append_pair("signature", signature);
        }
        if let Some(raw_transaction) = result.raw_transaction.as_deref() {
            query.append_pair("raw_transaction", raw_transaction);
        }
        if let Some(recent_blockhash) = result.recent_blockhash.as_deref() {
            query.append_pair("recent_blockhash", recent_blockhash);
        }
    }
    Ok(url.to_string())
}

fn handle_sign_deep_link(app: &tauri::AppHandle, url: &tauri::Url) -> Result<(), String> {
    let event = parse_sign_deep_link(url)?;
    focus_main_window(app);
    let state = app.state::<DappBridgeState>();
    enqueue_dapp_sign_request(app, state.inner(), "deep-link".to_string(), event)
}

fn handle_connect_deep_link(app: &tauri::AppHandle, url: &tauri::Url) -> Result<(), String> {
    let event = parse_connect_deep_link(url)?;
    focus_main_window(app);
    let state = app.state::<DappBridgeState>();
    enqueue_dapp_connect_request(app, state.inner(), event)
}

fn handle_fnzsafe_deep_link(app: &tauri::AppHandle, url: &tauri::Url) -> Result<(), String> {
    if is_connect_deep_link(url) {
        handle_connect_deep_link(app, url)
    } else {
        handle_sign_deep_link(app, url)
    }
}

fn handle_current_fnzsafe_deep_links(app: &tauri::AppHandle) {
    match app.deep_link().get_current() {
        Ok(Some(urls)) => {
            for url in urls {
                if let Err(error) = handle_fnzsafe_deep_link(app, &url) {
                    log::warn!("ignored startup fnzsafe deep link: {error}");
                }
            }
        }
        Ok(None) => {}
        Err(error) => {
            log::warn!("failed to read startup fnzsafe deep link: {error}");
        }
    }
}

fn dapp_provider_script(
    dapp: &AllowedDapp,
    wallet_public_key: &str,
    network: &str,
) -> Result<String, String> {
    let wallet_public_key = serde_json::to_string(wallet_public_key).map_err(|e| e.to_string())?;
    let network = serde_json::to_string(network).map_err(|e| e.to_string())?;
    let app_id = serde_json::to_string(dapp.id).map_err(|e| e.to_string())?;
    let app_name = serde_json::to_string(dapp.name).map_err(|e| e.to_string())?;
    let wallet_name = serde_json::to_string(DAPP_WALLET_NAME).map_err(|e| e.to_string())?;
    let wallet_icon = serde_json::to_string(&format!(
        "data:image/png;base64,{}",
        BASE64.encode(include_bytes!("../icons/dapp-wallet-icon.png"))
    ))
    .map_err(|e| e.to_string())?;
    Ok(format!(
        r#"
(function () {{
  const walletPublicKey = {wallet_public_key};
  const network = {network};
  const appId = {app_id};
  const appName = {app_name};
  const walletName = {wallet_name};
  const walletIcon = {wallet_icon};
  const listeners = new Map();
  let connected = true;

  function sleep(ms) {{ return new Promise((resolve) => setTimeout(resolve, ms)); }}
	  function tauriInvoke(command, args) {{
	    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
	    if (typeof invoke !== "function") {{
	      throw new Error("FnzSafe bridge is unavailable");
	    }}
	    return invoke(command, args || {{}});
	  }}
  function bytesToBase64(bytes) {{
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    for (let i = 0; i < view.length; i += 0x8000) {{
      binary += String.fromCharCode.apply(null, Array.from(view.subarray(i, i + 0x8000)));
    }}
    return btoa(binary);
  }}
  function base64ToBytes(base64) {{
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }}
  function base58Decode(value) {{
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const bytes = [0];
    for (const char of String(value)) {{
      const carryIndex = alphabet.indexOf(char);
      if (carryIndex < 0) throw new Error("Invalid base58 value");
      let carry = carryIndex;
      for (let i = 0; i < bytes.length; i += 1) {{
        carry += bytes[i] * 58;
        bytes[i] = carry & 0xff;
        carry >>= 8;
      }}
      while (carry > 0) {{
        bytes.push(carry & 0xff);
        carry >>= 8;
      }}
    }}
    for (const char of String(value)) {{
      if (char === "1") bytes.push(0);
      else break;
    }}
    return new Uint8Array(bytes.reverse());
  }}
  function setAutoConnectHints() {{
    try {{
      window.localStorage.setItem("walletName", walletName);
      window.localStorage.setItem("solana-wallet-adapter-wallet", walletName);
      window.localStorage.setItem("recentWallet", walletName);
      window.localStorage.setItem("recentWalletName", walletName);
    }} catch (_) {{}}
  }}
  function announceConnected() {{
    if (!connected) return;
    setAutoConnectHints();
    try {{ emit("connect", publicKey); }} catch (_) {{}}
    try {{ emitWallet("change", {{ accounts: standardWallet.accounts, features: standardWallet.features }}); }} catch (_) {{}}
    try {{ window.dispatchEvent(new Event("solana#initialized")); }} catch (_) {{}}
  }}
  function transactionFormat(transaction) {{
    if (transaction && (transaction.version !== undefined || transaction.message?.addressTableLookups)) return "versioned";
    return "legacy";
  }}
  function bytesView(value) {{
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }}
  function serializeTransaction(transaction) {{
    if (!transaction || typeof transaction.serialize !== "function") {{
      throw new Error("Invalid Solana transaction");
    }}
    try {{
      return transaction.serialize({{ requireAllSignatures: false, verifySignatures: false }});
    }} catch (_) {{
      return transaction.serialize();
    }}
  }}
  function transactionPayload(transaction) {{
    const view = bytesView(transaction);
    if (view) return {{ base64: bytesToBase64(view), format: "auto" }};
    return {{
      base64: bytesToBase64(serializeTransaction(transaction)),
      format: transactionFormat(transaction),
    }};
  }}
  function hydrateSignedTransaction(original, rawTransaction) {{
    const bytes = base64ToBytes(rawTransaction);
    if (bytesView(original)) return bytes;
    if (original?.constructor && typeof original.constructor.deserialize === "function") {{
      return original.constructor.deserialize(bytes);
    }}
    if (original?.constructor && typeof original.constructor.from === "function") {{
      return original.constructor.from(bytes);
    }}
    return bytes;
  }}
  async function requestSignature(method, transaction) {{
    const payload = transactionPayload(transaction);
    const requestId = await tauriInvoke("dapp_submit_sign_request", {{
      method,
      transactionBase64: payload.base64,
      transactionFormat: payload.format,
    }});
    const started = Date.now();
    while (Date.now() - started < 180000) {{
      const poll = await tauriInvoke("dapp_poll_sign_request", {{ requestId }});
      if (poll.status === "approved") return poll.result || {{}};
      if (poll.status === "rejected") throw new Error(poll.result?.error || "User rejected the request");
      if (poll.status === "expired") throw new Error("FnzSafe signing request expired");
      await sleep(500);
    }}
    throw new Error("FnzSafe signing request timed out");
  }}
  async function requestMessageSignature(message) {{
    let messageBytes;
    if (message instanceof Uint8Array) {{
      messageBytes = message;
    }} else if (message instanceof ArrayBuffer) {{
      messageBytes = new Uint8Array(message);
    }} else if (ArrayBuffer.isView(message)) {{
      messageBytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    }} else if (typeof message === "string") {{
      messageBytes = new TextEncoder().encode(message);
    }} else {{
      throw new Error("Invalid Solana message");
    }}
    const requestId = await tauriInvoke("dapp_submit_sign_request", {{
      method: "signMessage",
      messageBase64: bytesToBase64(messageBytes),
    }});
    const started = Date.now();
    while (Date.now() - started < 180000) {{
      const poll = await tauriInvoke("dapp_poll_sign_request", {{ requestId }});
      if (poll.status === "approved") return poll.result || {{}};
      if (poll.status === "rejected") throw new Error(poll.result?.error || "User rejected the request");
      if (poll.status === "expired") throw new Error("FnzSafe signing request expired");
      await sleep(500);
    }}
    throw new Error("FnzSafe signing request timed out");
  }}
  function emit(event, value) {{
    const handlers = listeners.get(event);
    if (!handlers) return;
    handlers.forEach((handler) => {{
      try {{ handler(value); }} catch (_) {{}}
    }});
  }}
  const publicKey = {{
    toBase58: () => walletPublicKey,
    toString: () => walletPublicKey,
    toBytes: () => base58Decode(walletPublicKey),
    toBuffer: () => base58Decode(walletPublicKey),
    equals: (other) => String(other?.toBase58 ? other.toBase58() : other) === walletPublicKey,
  }};
  const account = {{
    address: walletPublicKey,
    publicKey: base58Decode(walletPublicKey),
    chains: ["solana:mainnet", "solana:devnet", "solana:testnet"],
    features: [
      "standard:connect",
      "standard:disconnect",
	      "standard:events",
	      "solana:signTransaction",
	      "solana:signAndSendTransaction",
	      "solana:signMessage"
	    ],
    label: walletName,
  }};
  const walletListeners = new Map();
  function walletOn(event, handler) {{
    if (!walletListeners.has(event)) walletListeners.set(event, new Set());
    walletListeners.get(event).add(handler);
    return () => walletListeners.get(event)?.delete(handler);
  }}
  function emitWallet(event, value) {{
    walletListeners.get(event)?.forEach((handler) => {{
      try {{ handler(value); }} catch (_) {{}}
    }});
  }}
  const provider = {{
    isPhantom: true,
    isSolflare: true,
    isSolSafeKey: true,
    appId,
    appName,
    network,
    get publicKey() {{ return connected ? publicKey : null; }},
    get isConnected() {{ return connected; }},
    async connect() {{
      connected = true;
      emit("connect", publicKey);
      emitWallet("change", {{ accounts: standardWallet.accounts }});
      return {{ publicKey }};
    }},
    async disconnect() {{
      connected = false;
      emit("disconnect");
      emitWallet("change", {{ accounts: standardWallet.accounts }});
    }},
    on(event, handler) {{
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return this;
    }},
    off(event, handler) {{
      listeners.get(event)?.delete(handler);
      return this;
    }},
    removeListener(event, handler) {{
      return this.off(event, handler);
    }},
    async request(args) {{
      const method = typeof args === "string" ? args : args?.method;
      const params = typeof args === "string" ? undefined : args?.params;
      if (method === "connect") return this.connect(params);
      if (method === "disconnect") return this.disconnect();
      if (method === "signTransaction") return this.signTransaction(params?.transaction || params?.[0] || params);
      if (method === "signAllTransactions") return this.signAllTransactions(params?.transactions || params?.[0] || params);
      if (method === "signMessage") return this.signMessage(params?.message ?? params?.[0] ?? params);
      if (method === "signAndSendTransaction") return this.signAndSendTransaction(params?.transaction || params?.[0] || params);
      throw new Error("Unsupported FnzSafe provider method: " + method);
    }},
    async signTransaction(transaction) {{
      const result = await requestSignature("signTransaction", transaction);
      if (!result.raw_transaction) throw new Error("FnzSafe did not return a signed transaction");
      return hydrateSignedTransaction(transaction, result.raw_transaction);
    }},
    async signAllTransactions(transactions) {{
      const signed = [];
      for (const transaction of transactions || []) {{
        signed.push(await this.signTransaction(transaction));
      }}
      return signed;
    }},
    async signAndSendTransaction(input) {{
      const transaction = input?.transaction || input;
      const result = await requestSignature("signAndSendTransaction", transaction);
      if (!result.signature) throw new Error("FnzSafe did not return a transaction signature");
      return {{ signature: result.signature }};
    }},
    async sendTransaction(transaction, connection, options) {{
      if (connection && typeof connection.sendRawTransaction === "function") {{
        const signedTransaction = await this.signTransaction(transaction);
        const raw = bytesView(signedTransaction) || serializeTransaction(signedTransaction);
        return connection.sendRawTransaction(raw, options || {{}});
      }}
      const result = await requestSignature("sendTransaction", transaction);
      if (!result.signature) throw new Error("FnzSafe did not return a transaction signature");
      return result.signature;
    }},
    async signMessage(message) {{
      const result = await requestMessageSignature(message);
      if (!result.signature) throw new Error("FnzSafe did not return a message signature");
      return base58Decode(result.signature);
    }},
  }};
  const standardWallet = {{
    version: "1.0.0",
    name: walletName,
    icon: walletIcon,
    chains: ["solana:mainnet", "solana:devnet", "solana:testnet"],
    get accounts() {{ return connected ? [account] : []; }},
    features: {{
      "standard:connect": {{
        version: "1.0.0",
        connect: async () => {{
          connected = true;
          emit("connect", publicKey);
          emitWallet("change", {{ accounts: standardWallet.accounts }});
          return {{ accounts: standardWallet.accounts }};
        }},
      }},
      "standard:disconnect": {{
        version: "1.0.0",
        disconnect: async () => {{
          connected = false;
          emit("disconnect");
          emitWallet("change", {{ accounts: standardWallet.accounts }});
        }},
      }},
      "standard:events": {{
        version: "1.0.0",
        on: walletOn,
      }},
	      "solana:signTransaction": {{
	        version: "1.0.0",
	        supportedTransactionVersions: ["legacy", 0],
	        signTransaction: async (...inputs) => {{
          const signed = [];
          for (const input of inputs) {{
            let resolved = false;
            const payload = transactionPayload(input.transaction ?? input);
            const requestId = await tauriInvoke("dapp_submit_sign_request", {{
              method: "signTransaction",
              transactionBase64: payload.base64,
              transactionFormat: payload.format,
            }});
            const started = Date.now();
            while (Date.now() - started < 180000) {{
              const poll = await tauriInvoke("dapp_poll_sign_request", {{ requestId }});
              if (poll.status === "approved") {{
                if (!poll.result?.raw_transaction) throw new Error("FnzSafe did not return a signed transaction");
                signed.push({{ signedTransaction: base64ToBytes(poll.result.raw_transaction) }});
                resolved = true;
                break;
              }}
              if (poll.status === "rejected") throw new Error(poll.result?.error || "User rejected the request");
              if (poll.status === "expired") throw new Error("FnzSafe signing request expired");
              await sleep(500);
            }}
            if (!resolved) throw new Error("FnzSafe signing request timed out");
          }}
	          return signed;
	        }},
	      }},
	      "solana:signAndSendTransaction": {{
	        version: "1.0.0",
	        supportedTransactionVersions: ["legacy", 0],
	        signAndSendTransaction: async (...inputs) => {{
	          const signed = [];
	          for (const input of inputs) {{
	            let resolved = false;
	            const payload = transactionPayload(input.transaction ?? input);
	            const requestId = await tauriInvoke("dapp_submit_sign_request", {{
	              method: "signAndSendTransaction",
	              transactionBase64: payload.base64,
	              transactionFormat: payload.format,
	            }});
	            const started = Date.now();
	            while (Date.now() - started < 180000) {{
	              const poll = await tauriInvoke("dapp_poll_sign_request", {{ requestId }});
	              if (poll.status === "approved") {{
	                if (!poll.result?.signature) throw new Error("FnzSafe did not return a transaction signature");
	                signed.push({{ signature: base58Decode(poll.result.signature) }});
	                resolved = true;
	                break;
	              }}
	              if (poll.status === "rejected") throw new Error(poll.result?.error || "User rejected the request");
	              if (poll.status === "expired") throw new Error("FnzSafe signing request expired");
	              await sleep(500);
	            }}
	            if (!resolved) throw new Error("FnzSafe signing request timed out");
	          }}
	          return signed;
	        }},
	      }},
	      "solana:signMessage": {{
        version: "1.0.0",
        signMessage: async (...inputs) => {{
          const signed = [];
          for (const input of inputs) {{
            const message = input?.message || input;
            const result = await requestMessageSignature(message);
            if (!result.signature) throw new Error("FnzSafe did not return a message signature");
            const messageBytes = message instanceof Uint8Array
              ? message
              : message instanceof ArrayBuffer
                ? new Uint8Array(message)
                : ArrayBuffer.isView(message)
                  ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
                  : new TextEncoder().encode(String(message || ""));
            signed.push({{ signedMessage: messageBytes, signature: base58Decode(result.signature) }});
          }}
          return signed;
        }},
      }},
    }},
  }};
  function isFnzSafeEntry(entry) {{
    const maybeWallet = entry?.wallet || entry?.adapter?.wallet || entry?.adapter || entry;
    return (
      maybeWallet === standardWallet ||
      maybeWallet?.name === walletName ||
      maybeWallet?.label === walletName ||
      entry?.__fnzeroWallet === true
    );
  }}
  function moveFnzeroFirst(list) {{
    try {{
      if (!Array.isArray(list)) return;
      const index = list.findIndex(isFnzSafeEntry);
      if (index > 0) list.unshift(list.splice(index, 1)[0]);
    }} catch (_) {{}}
  }}
  const fnzeroWalletRegistrar = Object.assign(({{ register }}) => register(standardWallet), {{ __fnzeroWallet: true }});
  function prioritizeFnzSafes(api) {{
    try {{
      const wallets = window.navigator.wallets || (window.navigator.wallets = []);
      const existing = wallets.findIndex(isFnzSafeEntry);
      if (existing >= 0) wallets.splice(existing, 1);
      wallets.unshift(fnzeroWalletRegistrar);
    }} catch (_) {{}}
    try {{
      if (api && typeof api.get === "function") moveFnzeroFirst(api.get());
    }} catch (_) {{}}
  }}
  let fnzeroExpandAttemptedAt = 0;
  let fnzeroDomPrioritizePending = false;
  function visibleElement(element) {{
    try {{
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }} catch (_) {{
      return false;
    }}
  }}
  function walletText(element) {{
    return String(element?.textContent || "").replace(/\s+/g, " ").trim();
  }}
  function textLooksLikeWalletOption(text) {{
    return /FnzSafe|Solflare|Phantom|Backpack|OKX|Binance|Magic Eden|SquadsX|Coinbase|Glow|Slope|Torus|Ledger|Wallet/i.test(text);
  }}
  function elementLooksLikeWalletItem(element) {{
    if (!element || element.nodeType !== 1 || !visibleElement(element)) return false;
    const text = walletText(element);
    if (!textLooksLikeWalletOption(text)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 180 && rect.height >= 36 && rect.height <= 180;
  }}
  function walletOptionItem(element) {{
    if (!element || element.nodeType !== 1 || !walletText(element).includes(walletName)) return null;
    let current = element.closest("button, [role='button'], a, li, [data-testid], [class*='wallet'], [class*='Wallet']") || element;
    for (let depth = 0; current && current !== document.body && depth < 8; depth += 1, current = current.parentElement) {{
      const parent = current.parentElement;
      if (!parent || !elementLooksLikeWalletItem(current)) continue;
      const walletItems = Array.from(parent.children).filter(elementLooksLikeWalletItem);
      if (walletItems.length >= 2 && walletItems.includes(current)) return current;
    }}
    return null;
  }}
  function walletListItemsFor(item) {{
    const parent = item?.parentElement;
    if (!parent) return [];
    return Array.from(parent.children).filter(elementLooksLikeWalletItem);
  }}
  function maybeExpandAllWallets() {{
    const now = Date.now();
    if (now - fnzeroExpandAttemptedAt < 4000) return;
    const controls = Array.from(document.querySelectorAll("button, [role='button'], a"));
    const allWallets = controls.find((element) => /^All Wallets$/i.test(walletText(element)) && visibleElement(element));
    if (!allWallets) return;
    fnzeroExpandAttemptedAt = now;
    allWallets.click();
  }}
  function prioritizeFnzSafeDom() {{
    try {{
      const matches = Array.from(document.querySelectorAll("button, [role='button'], a, li, [data-testid], [class*='wallet'], [class*='Wallet']"))
        .map(walletOptionItem)
        .filter(Boolean);
      if (matches.length === 0) {{
        maybeExpandAllWallets();
        return;
      }}
      for (const option of matches) {{
        const walletItems = walletListItemsFor(option);
        const firstWalletItem = walletItems[0];
        if (!firstWalletItem || firstWalletItem === option) continue;
        option.parentElement.insertBefore(option, firstWalletItem);
      }}
    }} catch (_) {{}}
  }}
  function schedulePrioritizeFnzSafeDom() {{
    if (fnzeroDomPrioritizePending) return;
    fnzeroDomPrioritizePending = true;
    window.requestAnimationFrame(() => {{
      fnzeroDomPrioritizePending = false;
      prioritizeFnzSafeDom();
    }});
  }}
  function installFnzSafeDomPrioritizer() {{
    try {{
      prioritizeFnzSafeDom();
      const observer = new MutationObserver(() => {{
        schedulePrioritizeFnzSafeDom();
      }});
      observer.observe(document.documentElement, {{ childList: true, subtree: true }});
    }} catch (_) {{}}
  }}
  function registerStandardWallet(wallet) {{
    const callback = (api) => {{
      if (!api || typeof api.register !== "function") return;
      api.register(wallet);
      prioritizeFnzSafes(api);
      window.setTimeout(announceConnected, 0);
      window.setTimeout(announceConnected, 250);
    }};
    try {{
      const event = new Event("wallet-standard:register-wallet", {{
        bubbles: false,
        cancelable: false,
        composed: false,
      }});
      Object.defineProperty(event, "detail", {{ value: callback }});
      window.dispatchEvent(event);
    }} catch (_) {{}}
    try {{
      window.addEventListener("wallet-standard:app-ready", (event) => callback(event.detail));
    }} catch (_) {{}}
    try {{
      const wallets = window.navigator.wallets || (window.navigator.wallets = []);
      const existing = wallets.findIndex(isFnzSafeEntry);
      if (existing >= 0) wallets.splice(existing, 1);
      wallets.unshift(fnzeroWalletRegistrar);
    }} catch (_) {{}}
  }}
  setAutoConnectHints();
  Object.defineProperty(window, "solana", {{ value: provider, configurable: true }});
  window.phantom = window.phantom || {{}};
  Object.defineProperty(window.phantom, "solana", {{ value: provider, configurable: true }});
  Object.defineProperty(window, "solflare", {{ value: provider, configurable: true }});
  Object.defineProperty(window, "fnzeroWallet", {{ value: provider, configurable: true }});
  registerStandardWallet(standardWallet);
  installFnzSafeDomPrioritizer();
  [0, 250, 750, 1500, 3000].forEach((delay) => window.setTimeout(prioritizeFnzSafes, delay));
  [0, 250, 750, 1500, 3000].forEach((delay) => window.setTimeout(prioritizeFnzSafeDom, delay));
  [0, 250, 750, 1500, 3000].forEach((delay) => window.setTimeout(announceConnected, delay));
}})();
"#
    ))
}

/// Open a URL in the system default browser (not the Tauri webview).
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if !is_allowed_external_https_url(&url) {
        return Err("only https URLs can be opened externally".to_string());
    }
    spawn_system_browser(&url)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn dapp_open_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, DappBridgeState>,
    tab_id: String,
    url: String,
    app_id: Option<String>,
    wallet_public_key: Option<String>,
    network: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = dapp_tab_label(&tab_id)?;
    let url = parse_dapp_browser_url(&url)?;
    let dapp = app_id.as_deref().and_then(allowed_dapp);
    if let Some(dapp) = dapp.as_ref() {
        if !is_allowed_dapp_url(dapp, &url) {
            return Err("dapp tab URL does not match the selected DApp".to_string());
        }
    }

    let wallet_public_key = match (dapp.as_ref(), wallet_public_key) {
        (Some(_), Some(value)) => {
            let trimmed = value.trim().to_string();
            if !is_likely_solana_pubkey(&trimmed) {
                return Err("invalid wallet public key".to_string());
            }
            Some(trimmed)
        }
        (Some(_), None) => {
            return Err("wallet public key is required for connected DApp tabs".to_string())
        }
        (None, _) => None,
    };
    let network = validate_dapp_network(&network)?;

    if let Some(existing) = app.get_webview(&label) {
        let _ = existing.close();
    }
    state
        .sessions
        .lock()
        .map_err(|_| "dapp session lock poisoned".to_string())?
        .remove(&label);

    let main_window = app
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let bounds = dapp_webview_bounds(x, y, width, height)?;
    let tab_id_for_nav = tab_id.trim().to_string();
    let tab_id_for_title = tab_id_for_nav.clone();
    let tab_id_for_new_window = tab_id_for_nav.clone();
    let dapp_for_nav = dapp.clone();
    let app_for_nav = app.clone();
    let app_for_title = app.clone();
    let app_for_new_window = app.clone();
    let data_directory = dapp_browser_data_directory(&app)?;
    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url.clone()))
        .data_directory(data_directory)
        .on_navigation(move |target_url| {
            let allowed = match dapp_for_nav.as_ref() {
                Some(dapp) => is_allowed_connected_dapp_navigation_url(dapp, target_url),
                None => is_safe_dapp_webview_navigation_url(target_url),
            };
            if is_safe_browser_url(target_url) {
                let _ = app_for_nav.emit_to(
                    "main",
                    DAPP_TAB_URL_EVENT,
                    DappTabUrlEvent {
                        tab_id: tab_id_for_nav.clone(),
                        url: target_url.as_str().to_string(),
                        loaded: false,
                    },
                );
            }
            allowed
        })
        .on_page_load({
            let app = app.clone();
            let tab_id = tab_id.trim().to_string();
            move |_webview, payload| {
                if !is_safe_browser_url(payload.url()) {
                    return;
                }
                let _ = app.emit_to(
                    "main",
                    DAPP_TAB_URL_EVENT,
                    DappTabUrlEvent {
                        tab_id: tab_id.clone(),
                        url: payload.url().to_string(),
                        loaded: true,
                    },
                );
            }
        })
        .on_document_title_changed(move |_webview, title| {
            let title = title.trim().chars().take(120).collect::<String>();
            if !title.is_empty() {
                let _ = app_for_title.emit_to(
                    "main",
                    DAPP_TAB_TITLE_EVENT,
                    DappTabTitleEvent {
                        tab_id: tab_id_for_title.clone(),
                        title,
                    },
                );
            }
        })
        .on_new_window(move |target_url, _features| {
            if is_safe_browser_url(&target_url) {
                let _ = app_for_new_window.emit_to(
                    "main",
                    DAPP_NEW_WINDOW_EVENT,
                    DappNewWindowEvent {
                        source_tab_id: tab_id_for_new_window.clone(),
                        url: target_url.as_str().to_string(),
                    },
                );
            }
            tauri::webview::NewWindowResponse::Deny
        });

    if let (Some(dapp), Some(wallet_public_key)) = (dapp.as_ref(), wallet_public_key.as_ref()) {
        let init_script = dapp_provider_script(dapp, wallet_public_key, &network)?;
        builder = builder.initialization_script(&init_script);
    }

    let webview = main_window
        .add_child(builder, bounds.position, bounds.size)
        .map_err(|error| format!("failed to open dapp tab: {error}"))?;
    webview
        .set_bounds(bounds)
        .map_err(|error| format!("failed to position dapp tab: {error}"))?;
    webview
        .hide()
        .map_err(|error| format!("failed to hide loading dapp tab: {error}"))?;

    if let (Some(dapp), Some(wallet_public_key)) = (dapp, wallet_public_key) {
        state
            .sessions
            .lock()
            .map_err(|_| "dapp session lock poisoned".to_string())?
            .insert(
                label,
                DappSession {
                    app_id: dapp.id.to_string(),
                    app_name: dapp.name.to_string(),
                    url: url.as_str().to_string(),
                    wallet_public_key,
                    network,
                    opened_at_ms: now_ms(),
                },
            );
    }
    Ok(())
}

#[tauri::command]
fn dapp_navigate_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, DappBridgeState>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let label = dapp_tab_label(&tab_id)?;
    let url = parse_dapp_browser_url(&url)?;
    let dapp_session = state
        .sessions
        .lock()
        .map_err(|_| "dapp session lock poisoned".to_string())?
        .get(&label)
        .cloned();
    if let Some(session) = dapp_session.as_ref() {
        let dapp = allowed_dapp(&session.app_id).ok_or_else(|| "unsupported dapp".to_string())?;
        if !is_allowed_dapp_url(&dapp, &url) {
            return Err(
                "connected DApp tabs can only navigate inside their DApp domain".to_string(),
            );
        }
    }
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "dapp tab is not open".to_string())?;
    webview
        .navigate(url)
        .map_err(|error| format!("failed to navigate dapp tab: {error}"))?;
    Ok(())
}

#[tauri::command]
fn dapp_set_active_tab(
    app: tauri::AppHandle,
    tab_id: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let active_label = tab_id.as_deref().map(dapp_tab_label).transpose()?;
    let bounds = if active_label.is_some() {
        Some(dapp_webview_bounds(x, y, width, height)?)
    } else {
        None
    };
    for (label, webview) in app.webviews() {
        if !label.starts_with(DAPP_TAB_LABEL_PREFIX) {
            continue;
        }
        if active_label.as_deref() == Some(label.as_str()) {
            if let Some(bounds) = bounds {
                webview
                    .set_bounds(bounds)
                    .map_err(|error| format!("failed to position dapp tab: {error}"))?;
            }
            webview
                .show()
                .map_err(|error| format!("failed to show dapp tab: {error}"))?;
        } else {
            let _ = webview.hide();
        }
    }
    Ok(())
}

#[tauri::command]
fn dapp_close_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, DappBridgeState>,
    tab_id: String,
) -> Result<(), String> {
    let label = dapp_tab_label(&tab_id)?;
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|error| format!("failed to close dapp tab: {error}"))?;
    }
    state
        .sessions
        .lock()
        .map_err(|_| "dapp session lock poisoned".to_string())?
        .remove(&label);
    Ok(())
}

#[tauri::command]
fn dapp_submit_sign_request(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, DappBridgeState>,
    method: String,
    transaction_base64: Option<String>,
    transaction_format: Option<String>,
    message_base64: Option<String>,
) -> Result<String, String> {
    let webview_label = webview.label().to_string();
    let Some(_tab_id) = dapp_tab_id_from_label(&webview_label) else {
        return Err("dapp signing requests are only accepted from dapp tabs".to_string());
    };
    let method = validate_dapp_method(&method)?;
    let (transaction_base64, transaction_format, message_base64) = if method == "signMessage" {
        let message_base64 = validate_dapp_message_base64(
            message_base64
                .as_deref()
                .ok_or_else(|| "message payload is required".to_string())?,
        )?;
        ("".to_string(), "message".to_string(), Some(message_base64))
    } else {
        let transaction_base64 = validate_dapp_transaction_base64(
            transaction_base64
                .as_deref()
                .ok_or_else(|| "transaction payload is required".to_string())?,
        )?;
        let transaction_format =
            validate_transaction_format(transaction_format.as_deref().unwrap_or("auto"))?;
        (transaction_base64, transaction_format, None)
    };
    let session = state
        .sessions
        .lock()
        .map_err(|_| "dapp session lock poisoned".to_string())?
        .get(&webview_label)
        .cloned()
        .ok_or_else(|| "no active dapp session for this tab".to_string())?;
    if now_ms().saturating_sub(session.opened_at_ms) > 12 * 60 * 60 * 1000 {
        return Err("dapp session expired".to_string());
    }

    let request_id = dapp_request_id();
    let event = DappSignRequestEvent {
        request_id: request_id.clone(),
        app_id: session.app_id,
        app_name: session.app_name,
        app_url: session.url,
        request_purpose: None,
        method,
        wallet_public_key: session.wallet_public_key,
        network: session.network,
        transaction_base64,
        transaction_format,
        message_base64,
        callback_url: None,
        known_programs: Vec::new(),
        created_at_ms: now_ms(),
    };

    enqueue_dapp_sign_request(&app, state.inner(), webview_label, event)?;
    Ok(request_id)
}

#[tauri::command]
fn dapp_poll_sign_request(
    webview: tauri::Webview,
    state: tauri::State<'_, DappBridgeState>,
    request_id: String,
) -> Result<DappPollResponse, String> {
    let webview_label = webview.label().to_string();
    if dapp_tab_id_from_label(&webview_label).is_none() {
        return Err("dapp signing requests are only polled from dapp tabs".to_string());
    }
    let request_id = request_id.trim();
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "dapp request lock poisoned".to_string())?;
    let Some(pending) = requests.get(request_id) else {
        return Ok(DappPollResponse {
            status: "expired",
            result: None,
        });
    };
    if pending.webview_label != webview_label {
        return Err("dapp signing request does not belong to this tab".to_string());
    }
    if now_ms().saturating_sub(pending.event.created_at_ms) > DAPP_REQUEST_TTL_MS {
        requests.remove(request_id);
        return Ok(DappPollResponse {
            status: "expired",
            result: None,
        });
    }
    if let Some(result) = pending.result.clone() {
        requests.remove(request_id);
        return Ok(DappPollResponse {
            status: if result.approved {
                "approved"
            } else {
                "rejected"
            },
            result: Some(result),
        });
    }
    Ok(DappPollResponse {
        status: "pending",
        result: None,
    })
}

#[tauri::command]
fn dapp_pending_sign_request(
    state: tauri::State<'_, DappBridgeState>,
) -> Result<Option<DappSignRequestEvent>, String> {
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "dapp request lock poisoned".to_string())?;
    requests.retain(|_, pending| {
        now_ms().saturating_sub(pending.event.created_at_ms) <= DAPP_REQUEST_TTL_MS
            && pending.result.is_none()
    });
    Ok(requests
        .values()
        .map(|pending| pending.event.clone())
        .min_by_key(|event| event.created_at_ms))
}

#[tauri::command]
fn dapp_pending_connect_request(
    state: tauri::State<'_, DappBridgeState>,
) -> Result<Option<DappConnectRequestEvent>, String> {
    let mut requests = state
        .connect_requests
        .lock()
        .map_err(|_| "dapp connect request lock poisoned".to_string())?;
    requests.retain(|_, pending| {
        now_ms().saturating_sub(pending.event.created_at_ms) <= DAPP_REQUEST_TTL_MS
            && pending.result.is_none()
    });
    Ok(requests
        .values()
        .map(|pending| pending.event.clone())
        .min_by_key(|event| event.created_at_ms))
}

#[tauri::command]
fn resolve_dapp_sign_request(
    state: tauri::State<'_, DappBridgeState>,
    request_id: String,
    result: DappSignResult,
) -> Result<(), String> {
    let request_id = request_id.trim();
    let mut callback_target = None;
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "dapp request lock poisoned".to_string())?;
    let pending = requests
        .get_mut(request_id)
        .ok_or_else(|| "dapp signing request is no longer pending".to_string())?;
    if now_ms().saturating_sub(pending.event.created_at_ms) > DAPP_REQUEST_TTL_MS {
        requests.remove(request_id);
        return Err("dapp signing request expired".to_string());
    }
    if let Some(callback_url) = pending.event.callback_url.as_deref() {
        callback_target = Some(append_dapp_result_to_callback_url(
            callback_url,
            request_id,
            &result,
        )?);
    }
    pending.result = Some(result);
    drop(requests);

    if let Some(callback_target) = callback_target {
        spawn_system_browser(&callback_target)?;
    }
    Ok(())
}

#[tauri::command]
fn resolve_dapp_connect_request(
    state: tauri::State<'_, DappBridgeState>,
    request_id: String,
    result: DappSignResult,
) -> Result<(), String> {
    let request_id = request_id.trim();
    let mut requests = state
        .connect_requests
        .lock()
        .map_err(|_| "dapp connect request lock poisoned".to_string())?;
    let pending = requests
        .get_mut(request_id)
        .ok_or_else(|| "dapp connect request is no longer pending".to_string())?;
    if now_ms().saturating_sub(pending.event.created_at_ms) > DAPP_REQUEST_TTL_MS {
        requests.remove(request_id);
        return Err("dapp connect request expired".to_string());
    }
    let callback_target =
        append_dapp_result_to_callback_url(&pending.event.callback_url, request_id, &result)?;
    pending.result = Some(result);
    drop(requests);

    spawn_system_browser(&callback_target)?;
    Ok(())
}

#[tauri::command]
fn pick_source_directory() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("Select Solana Program Source Directory")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string()))
}

fn safe_download_filename(filename: &str) -> Result<String, String> {
    let trimmed = filename.trim();
    if trimmed.is_empty()
        || trimmed.len() > 160
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(|ch| ch.is_control())
    {
        return Err("invalid download filename".to_string());
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
    {
        return Err(
            "download filename may only contain letters, numbers, dots, dashes, and underscores"
                .to_string(),
        );
    }
    Ok(trimmed.to_string())
}

fn downloads_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME directory is unavailable".to_string())?;
    Ok(home.join("Downloads"))
}

fn non_overwriting_path(directory: &Path, filename: &str) -> PathBuf {
    let candidate = directory.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(filename);
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..10_000 {
        let next_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem}-{index}.{extension}"),
            _ => format!("{stem}-{index}"),
        };
        let next_path = directory.join(next_name);
        if !next_path.exists() {
            return next_path;
        }
    }
    directory.join(format!("{stem}-{}", uuid_like_timestamp()))
}

fn uuid_like_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "now".to_string())
}

#[tauri::command]
fn save_download_file(filename: String, content: String) -> Result<String, String> {
    if content.len() > MAX_DOWNLOAD_FILE_BYTES {
        return Err("download file is too large".to_string());
    }
    let filename = safe_download_filename(&filename)?;
    let directory = downloads_dir()?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create Downloads directory: {error}"))?;
    let path = non_overwriting_path(&directory, &filename);
    std::fs::write(&path, content.as_bytes())
        .map_err(|error| format!("failed to write download file: {error}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn open_download_file_location(path: String) -> Result<(), String> {
    let raw_path = PathBuf::from(path.trim());
    if !raw_path.is_absolute() {
        return Err("download path must be absolute".to_string());
    }
    let downloads = downloads_dir()?;
    let canonical_downloads = downloads
        .canonicalize()
        .map_err(|error| format!("failed to read Downloads directory: {error}"))?;
    let canonical_path = raw_path
        .canonicalize()
        .map_err(|error| format!("download file is unavailable: {error}"))?;
    if !canonical_path.starts_with(&canonical_downloads) {
        return Err("can only open files saved under Downloads".to_string());
    }
    reveal_file_in_system_file_manager(&canonical_path)
}

fn desktop_api_binary_name() -> String {
    if cfg!(windows) {
        format!("{DESKTOP_API_BIN_NAME}.exe")
    } else {
        DESKTOP_API_BIN_NAME.to_string()
    }
}

fn api_port_is_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(180)).is_ok()
}

fn first_available_api_port(start_port: u16, attempts: u16) -> Result<u16, String> {
    for offset in 0..attempts {
        let Some(port) = start_port.checked_add(offset) else {
            break;
        };
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        if TcpListener::bind(addr).is_ok() {
            return Ok(port);
        }
    }
    Err(format!(
        "本地后端端口不可用：已检查 {}-{}",
        start_port,
        start_port.saturating_add(attempts.saturating_sub(1))
    ))
}

fn repository_root_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = env::current_exe() {
        candidates.extend(exe.ancestors().map(Path::to_path_buf));
    }
    candidates.extend(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .map(Path::to_path_buf),
    );

    candidates
        .into_iter()
        .filter(|path| path.join("Cargo.toml").is_file() && path.join("apps/desktop").is_dir())
        .fold(Vec::<PathBuf>::new(), |mut unique, path| {
            if !unique.iter().any(|item| item == &path) {
                unique.push(path);
            }
            unique
        })
}

fn stable_app_support_dir(app: &tauri::App) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = env::var("HOME") {
            let home = home.trim();
            if !home.is_empty() {
                return PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("FnzSafe");
            }
        }
    }

    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| env::temp_dir().join("FnzSafe"))
}

fn prelaunch_app_support_dir() -> PathBuf {
    for key in ["FNZERO_SAFE_DB_PATH", "SOL_SAFEKEY_DB_PATH"] {
        if let Ok(path) = env::var(key) {
            let path = PathBuf::from(path.trim());
            if let Some(parent) = path.parent().filter(|_| !path.as_os_str().is_empty()) {
                return parent.to_path_buf();
            }
        }
    }

    #[cfg(target_os = "macos")]
    if let Ok(home) = env::var("HOME") {
        let home = home.trim();
        if !home.is_empty() {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("FnzSafe");
        }
    }

    #[cfg(target_os = "windows")]
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        let local_app_data = local_app_data.trim();
        if !local_app_data.is_empty() {
            return PathBuf::from(local_app_data).join("FnzSafe");
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(data_home) = env::var("XDG_DATA_HOME") {
            let data_home = data_home.trim();
            if !data_home.is_empty() {
                return PathBuf::from(data_home).join("FnzSafe");
            }
        }
        if let Ok(home) = env::var("HOME") {
            let home = home.trim();
            if !home.is_empty() {
                return PathBuf::from(home)
                    .join(".local")
                    .join("share")
                    .join("FnzSafe");
            }
        }
    }

    env::temp_dir().join("FnzSafe")
}

fn set_private_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

fn migrate_wallet_database_if_needed(target: &Path, sources: &[PathBuf]) {
    if target.exists() {
        return;
    }
    let Some(source) = sources.iter().find(|source| {
        source != &target
            && std::fs::metadata(source)
                .map(|metadata| metadata.is_file() && metadata.len() > 0)
                .unwrap_or(false)
    }) else {
        return;
    };
    if let Some(parent) = target.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::warn!("failed to create wallet data directory: {error}");
            return;
        }
    }
    match std::fs::copy(source, target) {
        Ok(_) => {
            set_private_file_permissions(target);
            log::info!(
                "migrated wallet database from {} to {}",
                source.display(),
                target.display()
            );
        }
        Err(error) => {
            log::warn!(
                "failed to migrate wallet database from {} to {}: {error}",
                source.display(),
                target.display()
            );
        }
    }
}

fn preferred_wallet_database_path(app: &tauri::App) -> PathBuf {
    if let Ok(path) = env::var("FNZERO_SAFE_DB_PATH") {
        let path = path.trim();
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    if let Ok(path) = env::var("SOL_SAFEKEY_DB_PATH") {
        let path = path.trim();
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }

    let app_support = stable_app_support_dir(app);
    let target = app_support.join("fnzero-safe.sqlite3");
    let mut migration_sources = vec![app_support.join("sol-safekey.sqlite3")];
    for root in repository_root_candidates() {
        migration_sources.push(root.join("apps/desktop/data/fnzero-safe.sqlite3"));
        migration_sources.push(root.join("apps/desktop/data/sol-safekey.sqlite3"));
        migration_sources.push(root.join("crates/desktop-api/data/fnzero-safe.sqlite3"));
        migration_sources.push(root.join("crates/desktop-api/data/sol-safekey.sqlite3"));
        migration_sources.push(root.join("data/fnzero-safe.sqlite3"));
        migration_sources.push(root.join("data/sol-safekey.sqlite3"));
    }

    migrate_wallet_database_if_needed(&target, &migration_sources);
    target
}

fn desktop_api_binary_candidates(app: &tauri::App) -> Vec<PathBuf> {
    let binary_name = desktop_api_binary_name();
    let mut candidates = Vec::new();

    if let Ok(path) = env::var("FNZERO_SAFE_DESKTOP_API_BIN") {
        let path = path.trim();
        if !path.is_empty() {
            candidates.push(PathBuf::from(path));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(&binary_name));
        candidates.push(resource_dir.join("bin").join(&binary_name));
    }

    if let Ok(exe) = env::current_exe() {
        for ancestor in exe.ancestors() {
            candidates.push(ancestor.join(&binary_name));
            candidates.push(ancestor.join("build-cache/release").join(&binary_name));
            candidates.push(ancestor.join("target/release").join(&binary_name));
        }
    }

    for root in repository_root_candidates() {
        candidates.push(root.join("build-cache/release").join(&binary_name));
        candidates.push(root.join("target/release").join(&binary_name));
    }

    candidates.into_iter().filter(|path| path.is_file()).fold(
        Vec::<PathBuf>::new(),
        |mut unique, path| {
            if !unique.iter().any(|item| item == &path) {
                unique.push(path);
            }
            unique
        },
    )
}

fn start_desktop_api_if_needed(
    app: &tauri::App,
    process: &DesktopApiProcess,
) -> Result<(), String> {
    if cfg!(debug_assertions) && api_port_is_open(FNZERO_SAFE_API_PORT) {
        process.set_port(FNZERO_SAFE_API_PORT);
        log::info!(
            "using externally managed desktop API at 127.0.0.1:{} in debug mode",
            FNZERO_SAFE_API_PORT
        );
        return Ok(());
    }

    let api_port = first_available_api_port(FNZERO_SAFE_API_PORT, FNZERO_SAFE_API_PORT_ATTEMPTS)?;
    process.set_port(api_port);

    let binary = desktop_api_binary_candidates(app)
        .into_iter()
        .next()
        .ok_or_else(|| {
            format!(
                "未找到本地后端程序 {DESKTOP_API_BIN_NAME}，请先运行 npm run desktop:build 或 npm run desktop:dev"
            )
        })?;
    let database_path = preferred_wallet_database_path(app);
    if let Some(parent) = database_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建钱包数据目录失败: {error}"))?;
    }

    let mut command = Command::new(&binary);
    command
        .env("FNZERO_SAFE_DB_PATH", &database_path)
        .env("PORT", api_port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(parent) = binary.parent() {
        command.current_dir(parent);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("启动本地后端失败: {error}"))?;
    let child_pid = child.id();
    {
        let mut guard = process
            .child
            .lock()
            .map_err(|_| "本地后端进程状态锁已损坏".to_string())?;
        *guard = Some(child);
    }
    if let Err(error) = write_managed_pid_file(&process.pid_file, &binary, child_pid) {
        if let Ok(mut guard) = process.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        return Err(error);
    }

    for _ in 0..40 {
        {
            let mut guard = process
                .child
                .lock()
                .map_err(|_| "本地后端进程状态锁已损坏".to_string())?;
            if let Some(child) = guard.as_mut() {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|error| format!("检查本地后端进程失败: {error}"))?
                {
                    guard.take();
                    remove_owned_pid_file(&process.pid_file, child_pid);
                    return Err(format!("本地后端启动后提前退出: {status}"));
                }
            }
        }
        if api_port_is_open(api_port) {
            log::info!(
                "started local desktop API at 127.0.0.1:{} with database {}",
                api_port,
                database_path.display()
            );
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    if let Ok(mut guard) = process.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    remove_owned_pid_file(&process.pid_file, child_pid);
    Err(format!("本地后端已启动但端口 {api_port} 尚未就绪"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pid_dir = prelaunch_app_support_dir();
    let desktop_api_pid_file = pid_dir.join(DESKTOP_API_PID_FILE_NAME);

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::Builder::new().build())
        .manage(DappBridgeState::default())
        .manage(DesktopApiProcess::new(desktop_api_pid_file.clone()))
        .invoke_handler(tauri::generate_handler![
            proxy_api_request,
            open_external_url,
            dapp_open_tab,
            dapp_navigate_tab,
            dapp_set_active_tab,
            dapp_close_tab,
            dapp_submit_sign_request,
            dapp_poll_sign_request,
            dapp_pending_sign_request,
            dapp_pending_connect_request,
            resolve_dapp_sign_request,
            resolve_dapp_connect_request,
            biometric_wallet_status,
            biometric_wallet_store_password,
            biometric_wallet_get_password,
            biometric_wallet_delete_password,
            pick_source_directory,
            save_download_file,
            open_download_file_location
        ])
        .setup(move |app| {
            if !cfg!(debug_assertions) {
                if let Err(error) = terminate_recorded_process(&desktop_api_pid_file) {
                    log::warn!("failed to stop recorded desktop API process: {error}");
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            if let Err(error) =
                start_desktop_api_if_needed(app, app.state::<DesktopApiProcess>().inner())
            {
                log::warn!("failed to start local desktop API: {error}");
            }
            app.deep_link().on_open_url({
                let app = app.handle().clone();
                move |event| {
                    for url in event.urls() {
                        if let Err(error) = handle_fnzsafe_deep_link(&app, &url) {
                            log::warn!("ignored fnzsafe deep link: {error}");
                        }
                    }
                }
            });
            handle_current_fnzsafe_deep_links(app.handle());
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            if let Err(error) = app.deep_link().register_all() {
                log::warn!("failed to register fnzsafe deep link scheme: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::{
        encoding::{AsDer, PublicKeyX509Der},
        rsa::{KeySize, OaepPrivateDecryptingKey, PrivateDecryptingKey},
    };

    #[test]
    fn secure_body_envelope_round_trips_with_backend_key_format() {
        let private_key = PrivateDecryptingKey::generate(KeySize::Rsa2048).unwrap();
        let public_key = private_key.public_key();
        let public_key_der = AsDer::<PublicKeyX509Der<'static>>::as_der(&public_key).unwrap();
        let public_key_pem = pem_rfc7468::encode_string(
            "PUBLIC KEY",
            pem_rfc7468::LineEnding::LF,
            public_key_der.as_ref(),
        )
        .unwrap();
        assert!(public_key_pem.starts_with("-----BEGIN PUBLIC KEY-----\n"));
        assert!(public_key_pem.ends_with("-----END PUBLIC KEY-----\n"));

        let body = r#"{"password":"not-a-real-password","value":42}"#;
        let envelope: serde_json::Value =
            serde_json::from_str(&encrypt_secure_body(body, &public_key_pem).unwrap()).unwrap();
        assert_eq!(envelope["version"].as_u64(), Some(1));

        let encrypted_key = BASE64
            .decode(envelope["encrypted_key"].as_str().unwrap())
            .unwrap();
        let iv = BASE64.decode(envelope["iv"].as_str().unwrap()).unwrap();
        let ciphertext = BASE64
            .decode(envelope["ciphertext"].as_str().unwrap())
            .unwrap();

        let private_key = OaepPrivateDecryptingKey::new(private_key).unwrap();
        let mut decrypted_key = Zeroizing::new(vec![0_u8; private_key.min_output_size()]);
        let aes_key_len = private_key
            .decrypt(
                &OAEP_SHA256_MGF1SHA256,
                &encrypted_key,
                decrypted_key.as_mut_slice(),
                None,
            )
            .unwrap()
            .len();
        assert_eq!(aes_key_len, 32);

        let cipher = Aes256Gcm::new_from_slice(&decrypted_key[..aes_key_len]).unwrap();
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(Nonce::from_slice(&iv), ciphertext.as_ref())
                .unwrap(),
        );
        assert_eq!(plaintext.as_slice(), body.as_bytes());
    }

    #[test]
    fn only_program_write_operations_receive_the_extended_proxy_timeout() {
        assert!(proxied_api_path_is_long_running_program_operation(
            "program/deploy"
        ));
        assert!(proxied_api_path_is_long_running_program_operation(
            "/program/upgrade/"
        ));
        assert!(proxied_api_path_is_long_running_program_operation(
            "squads/program/prepare-upgrade-buffer"
        ));
        assert!(!proxied_api_path_is_long_running_program_operation(
            "program/info"
        ));
    }

    #[test]
    fn api_port_selection_skips_an_occupied_port() {
        let listener = (0..16)
            .find_map(|_| {
                let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
                (listener.local_addr().ok()?.port() <= u16::MAX - 32).then_some(listener)
            })
            .expect("failed to reserve a suitable test port");
        let occupied_port = listener.local_addr().unwrap().port();
        let selected = first_available_api_port(occupied_port, 32).unwrap();
        assert_ne!(selected, occupied_port);
        assert!(selected > occupied_port);
    }

    #[test]
    fn managed_pid_record_requires_the_recorded_executable() {
        let executable = env::current_exe().unwrap();
        let matching = ManagedProcessPidRecord {
            pid: std::process::id(),
            executable: executable.to_string_lossy().to_string(),
        };
        assert!(managed_process_matches(&matching));

        let mismatched = ManagedProcessPidRecord {
            executable: "/tmp/not-fnzsafe".to_string(),
            ..matching
        };
        assert!(!managed_process_matches(&mismatched));
    }

    #[test]
    fn windows_executable_path_normalization_handles_verbatim_prefix_and_case() {
        assert_eq!(
            normalize_windows_executable_path(r"\\?\C:\Program Files\FnzSafe\api.exe"),
            normalize_windows_executable_path(r"c:/program files/fnzsafe/API.exe")
        );
        assert_eq!(
            normalize_windows_executable_path(r"\\?\UNC\server\share\api.exe"),
            normalize_windows_executable_path(r"\\server\share\API.exe")
        );
    }

    #[cfg(unix)]
    #[test]
    fn recorded_process_can_be_terminated_after_identity_check() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let record = ManagedProcessPidRecord {
            pid: child.id(),
            executable: "/bin/sleep".to_string(),
        };
        if !managed_process_matches(&record) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("spawned process did not match its recorded executable");
        }
        terminate_managed_process(&record).unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success());
        assert!(managed_process_command(record.pid).is_none());
    }

    #[test]
    fn secure_body_rejects_non_spki_pem_label() {
        let invalid_pem = "-----BEGIN RSA PUBLIC KEY-----\nAA==\n-----END RSA PUBLIC KEY-----\n";
        let error = encrypt_secure_body("{}", invalid_pem).unwrap_err();
        assert_eq!(error, "invalid secure API public key PEM label");
    }

    #[test]
    fn external_url_guard_accepts_only_structural_https_urls() {
        assert!(is_allowed_external_https_url(
            "https://solscan.io/tx/abc?cluster=devnet"
        ));
        assert!(!is_allowed_external_https_url("http://solscan.io/tx/abc"));
        assert!(!is_allowed_external_https_url("https://"));
        assert!(!is_allowed_external_https_url("https://@example.com"));
        assert!(!is_allowed_external_https_url(
            "https://user:pass@example.com"
        ));
        assert!(!is_allowed_external_https_url("https://.example.com"));
        assert!(!is_allowed_external_https_url("https://example.com."));
        assert!(!is_allowed_external_https_url("https://example.com\n.evil"));
    }

    #[test]
    fn biometric_wallet_account_is_stable_for_public_key() {
        let public_key = "11111111111111111111111111111111";
        let accounts =
            biometric_wallet_accounts("0123456789abcdef0123456789abcdef", public_key).unwrap();

        assert_eq!(accounts.primary, format!("solana:{public_key}"));
    }

    #[test]
    fn connected_dapp_navigation_stays_on_selected_domain() {
        let pumpfun = allowed_dapp("pumpfun").unwrap();
        let same_domain = "https://pump.fun/coin/example".parse().unwrap();
        let subdomain = "https://frontend-api.pump.fun/".parse().unwrap();
        let other_https = "https://example.com/".parse().unwrap();

        assert!(is_allowed_connected_dapp_navigation_url(
            &pumpfun,
            &same_domain
        ));
        assert!(is_allowed_connected_dapp_navigation_url(
            &pumpfun, &subdomain
        ));
        assert!(!is_allowed_connected_dapp_navigation_url(
            &pumpfun,
            &other_https
        ));
    }

    #[test]
    fn connected_dapp_navigation_rejects_data_pages() {
        let pumpfun = allowed_dapp("pumpfun").unwrap();
        let about_blank = "about:blank".parse().unwrap();
        let blob_page = "blob:https://pump.fun/example".parse().unwrap();
        let data_page = "data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4="
            .parse()
            .unwrap();

        assert!(is_allowed_connected_dapp_navigation_url(
            &pumpfun,
            &about_blank
        ));
        assert!(is_allowed_connected_dapp_navigation_url(
            &pumpfun, &blob_page
        ));
        assert!(!is_allowed_connected_dapp_navigation_url(
            &pumpfun, &data_page
        ));
    }

    #[test]
    fn sign_deep_link_parses_host_action() {
        let url = "fnzsafe://sign?method=signMessage&wallet_public_key=11111111111111111111111111111111&network=devnet&message_base64=aGVsbG8=&app_name=Example%20DApp&app_url=https%3A%2F%2Fexample.com%2F&request_purpose=login&callback_url=https%3A%2F%2Fexample.com%2Fwallet%2Fcallback"
            .parse::<tauri::Url>()
            .unwrap();

        let request = parse_sign_deep_link(&url).unwrap();
        assert_eq!(request.app_id, "fnzsafe-deep-link");
        assert_eq!(request.app_name, "Example DApp");
        assert_eq!(request.request_purpose.as_deref(), Some("login"));
        assert_eq!(request.method, "signMessage");
        assert_eq!(request.network, "devnet");
        assert_eq!(request.message_base64.as_deref(), Some("aGVsbG8="));
        assert_eq!(
            request.callback_url.as_deref(),
            Some("https://example.com/wallet/callback")
        );
    }

    #[test]
    fn sign_deep_link_allows_localhost_callback_for_local_development() {
        let url = "fnzsafe://sign?method=signMessage&wallet_public_key=11111111111111111111111111111111&network=devnet&message_base64=aGVsbG8=&app_name=Local%20DApp&app_url=http%3A%2F%2Flocalhost%3A5174%2F&callback_url=http%3A%2F%2Flocalhost%3A5174%2Fwallet%2Fcallback"
            .parse::<tauri::Url>()
            .unwrap();

        let request = parse_sign_deep_link(&url).unwrap();
        assert_eq!(
            request.callback_url.as_deref(),
            Some("http://localhost:5174/wallet/callback")
        );
    }

    #[test]
    fn connect_deep_link_parses_localhost_callback() {
        let url = "fnzsafe://connect?network=devnet&app_name=Example%20DApp&app_url=http%3A%2F%2Flocalhost%3A5174%2F&callback_url=http%3A%2F%2Flocalhost%3A5174%2Fwallet%2Fcallback&request_id=req-1"
            .parse::<tauri::Url>()
            .unwrap();

        let request = parse_connect_deep_link(&url).unwrap();
        assert_eq!(request.request_id, "req-1");
        assert_eq!(request.app_name, "Example DApp");
        assert_eq!(request.network, "devnet");
        assert_eq!(
            request.callback_url,
            "http://localhost:5174/wallet/callback"
        );
    }

    #[test]
    fn sign_deep_link_parses_path_action_and_transaction() {
        let url = "fnzsafe:///sign?method=signTransaction&wallet_public_key=11111111111111111111111111111111&transaction_base64=AQID&transaction_format=v0&app_url=https%3A%2F%2Fdapp.example%2F"
            .parse::<tauri::Url>()
            .unwrap();

        let request = parse_sign_deep_link(&url).unwrap();
        assert_eq!(request.app_name, "dapp.example");
        assert_eq!(request.method, "signTransaction");
        assert_eq!(request.network, "mainnet");
        assert_eq!(request.transaction_base64, "AQID");
        assert_eq!(request.transaction_format, "v0");
        assert!(request.message_base64.is_none());
    }

    #[test]
    fn sign_deep_link_rejects_cross_site_callback() {
        let url = "fnzsafe://sign?method=signMessage&wallet_public_key=11111111111111111111111111111111&message_base64=aGVsbG8=&app_url=https%3A%2F%2Fexample.com%2F&callback_url=https%3A%2F%2Fevil.example%2Fcallback"
            .parse::<tauri::Url>()
            .unwrap();

        let error = parse_sign_deep_link(&url).unwrap_err();
        assert_eq!(
            error,
            "callback_url must belong to the same site as app_url"
        );
    }

    #[test]
    fn callback_url_appends_dapp_result() {
        let result = DappSignResult {
            approved: true,
            error: None,
            public_key: Some("11111111111111111111111111111111".to_string()),
            signature: Some("sig123".to_string()),
            raw_transaction: None,
            recent_blockhash: Some("hash123".to_string()),
        };

        let callback = append_dapp_result_to_callback_url(
            "https://fnzero.dev/callback?source=wallet",
            "req-1",
            &result,
        )
        .unwrap();
        assert!(callback.starts_with("https://fnzero.dev/callback?"));
        assert!(callback.contains("source=wallet"));
        assert!(callback.contains("request_id=req-1"));
        assert!(callback.contains("approved=true"));
        assert!(callback.contains("public_key=11111111111111111111111111111111"));
        assert!(callback.contains("signature=sig123"));
        assert!(callback.contains("recent_blockhash=hash123"));
    }
}
