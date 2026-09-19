use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use aws_lc_rs::rsa::{OaepPublicEncryptingKey, PublicEncryptingKey, OAEP_SHA256_MGF1SHA256};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::Write;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU16, Ordering},
    Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, WebviewBuilder,
    WebviewUrl,
};
use tauri_plugin_deep_link::DeepLinkExt;
use zeroize::{Zeroize, Zeroizing};

mod app_store;
mod browser_profile;
mod research_store;
mod secure_input;

type DesktopRuntime = tauri::Cef;
type DesktopApp = tauri::App<DesktopRuntime>;
type DesktopAppHandle = tauri::AppHandle<DesktopRuntime>;
type DesktopWebview = tauri::Webview<DesktopRuntime>;

/// Must match `DEFAULT_API_PORT` in `src/lib/api.ts`
const FNZERO_SAFE_API_PORT: u16 = 3841;
const FNZERO_SAFE_API_PORT_ATTEMPTS: u16 = 32;
const SOLANA_MAX_ACCOUNT_DATA_BYTES: usize = 10 * 1024 * 1024;
const UPGRADEABLE_LOADER_PROGRAMDATA_METADATA_BYTES: usize = 45;
const MAX_PROGRAM_SO_BYTES: usize =
    SOLANA_MAX_ACCOUNT_DATA_BYTES - UPGRADEABLE_LOADER_PROGRAMDATA_METADATA_BYTES;
const MAX_PROGRAM_SO_BASE64_BYTES: usize = MAX_PROGRAM_SO_BYTES.div_ceil(3) * 4;
const MAX_PROXY_BODY_BYTES: usize = MAX_PROGRAM_SO_BASE64_BYTES + 1024 * 1024;
const MAX_DOWNLOAD_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SECURE_PUBLIC_KEY_PEM_BYTES: usize = 2 * 1024;
const MAX_SIGNAL_TRANSLATION_BYTES: usize = 16 * 1024;
const MAX_SIGNAL_TRANSLATION_RESPONSE_BYTES: usize = 256 * 1024;
const PROGRAM_DEPLOY_PROXY_TIMEOUT_SECS: u64 = 60 * 60;
const MAX_PROGRAM_OPERATION_PROXY_TIMEOUT_SECS: u64 = 24 * 60 * 60;
const SECURE_BODY_HEADER: &str = "x-fnzero-safe-secure-body";
const SECURE_BODY_VERSION: &str = "1";
const DAPP_TAB_LABEL_PREFIX: &str = "dapp-tab-";
const DAPP_SIGN_REQUEST_EVENT: &str = "dapp://sign-request";
const DAPP_TAB_URL_EVENT: &str = "dapp://tab-url";
const DAPP_TAB_TITLE_EVENT: &str = "dapp://tab-title";
const DAPP_NEW_WINDOW_EVENT: &str = "dapp://new-window";
const DAPP_TAB_TEXT_EVENT: &str = "dapp://tab-text";
const DAPP_FOMO_ALERTS_EVENT: &str = "dapp://fomo-alerts";
const DAPP_FOMO_AUTH_EVENT: &str = "dapp://fomo-auth";
const DAPP_FOMO_STREAM_EVENT: &str = "dapp://fomo-stream";
const DAPP_FOMO_PROFILE_EVENT: &str = "dapp://fomo-profile";
const FOMO_ALERTS_TAB_ID: &str = "twitter-fomo-alerts";
const TWITTER_CAPTURE_TAB_ID: &str = "twitter-signal-capture";
const DAPP_DOWNLOAD_EVENT: &str = "dapp://download";
const DAPP_CONNECT_REQUEST_EVENT: &str = "dapp://connect-request";
const DAPP_REQUEST_TTL_MS: u64 = 3 * 60 * 1000;
const MAX_PENDING_DAPP_REQUESTS: usize = 64;
const DAPP_WALLET_NAME: &str = "FnzSafe";
const DESKTOP_API_BIN_NAME: &str = "fnzero-safe-desktop-api";
const LEGACY_DESKTOP_APP_PID_FILE_NAME: &str = "desktop.pid";
const DESKTOP_APP_PID_FILE_NAME: &str = "desktop-app.pid";
const DESKTOP_API_PID_FILE_NAME: &str = "desktop-api.pid";
#[cfg(target_os = "macos")]
// v6 items were created by ad-hoc-signed builds and can display a macOS
// password prompt when a later build only checks whether they exist. Keep the
// encrypted wallet database compatible, but start a clean Keychain namespace
// for builds that have a stable signing identity.
const BIOMETRIC_WALLET_PASSWORD_SERVICE: &str = "dev.fnzero-safe.wallet.password.v7";

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
    wallet_family: String,
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
    wallet_family: String,
    wallet_public_key: String,
    network: String,
    transaction_base64: String,
    transaction_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload_json: Option<String>,
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
    wallet_family: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    wallet_public_key: Option<String>,
    network: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    callback_url: Option<String>,
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
    webview_label: Option<String>,
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

struct DappBridgeState {
    paused: AtomicBool,
    webview_visibility: Mutex<()>,
    active_tab_label: Mutex<Option<String>>,
    sessions: Mutex<HashMap<String, DappSession>>,
    requests: Mutex<HashMap<String, DappPendingRequest>>,
    connect_requests: Mutex<HashMap<String, DappPendingConnectRequest>>,
}

impl Default for DappBridgeState {
    fn default() -> Self {
        Self {
            // The frontend cannot know whether saved wallets exist until its
            // initial API request completes. Keep native DApp surfaces closed
            // until that wallet security state has been resolved explicitly.
            paused: AtomicBool::new(true),
            webview_visibility: Mutex::new(()),
            active_tab_label: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
            connect_requests: Mutex::new(HashMap::new()),
        }
    }
}

fn ensure_dapp_connections_active(state: &DappBridgeState) -> Result<(), String> {
    if state.paused.load(Ordering::Acquire) {
        Err("dapp connections are paused while the application is locked".to_string())
    } else {
        Ok(())
    }
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
    api_token: Zeroizing<String>,
}

fn generate_desktop_api_token() -> String {
    let mut bytes = [0_u8; 32];
    let token = {
        OsRng.fill_bytes(&mut bytes);
        BASE64.encode(bytes)
    };
    bytes.zeroize();
    token
}

impl DesktopApiProcess {
    fn new(pid_file: PathBuf) -> Self {
        let api_token = env::var("FNZERO_SAFE_API_TOKEN")
            .or_else(|_| env::var("SOL_SAFEKEY_API_TOKEN"))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(generate_desktop_api_token);
        #[cfg(not(test))]
        for name in ["FNZERO_SAFE_API_TOKEN", "SOL_SAFEKEY_API_TOKEN"] {
            env::remove_var(name);
        }
        Self {
            child: Mutex::new(None),
            port: AtomicU16::new(FNZERO_SAFE_API_PORT),
            pid_file,
            api_token: Zeroizing::new(api_token),
        }
    }

    fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::Relaxed);
    }

    fn api_token(&self) -> &str {
        self.api_token.as_str()
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

#[derive(Clone, Debug, Serialize)]
struct DappTabTextEvent {
    tab_id: String,
    request_id: String,
    url: String,
    text: String,
    tweets: Vec<DappCapturedTweet>,
    profile: Option<DappCapturedTwitterProfile>,
    authenticated: Option<bool>,
    backfill_complete: bool,
    captured_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DappSubmitPageTextRequest {
    request_id: String,
    text: String,
    tweets: Option<Vec<DappCapturedTweet>>,
    profile: Option<DappCapturedTwitterProfile>,
    authenticated: Option<bool>,
    #[serde(default)]
    backfill_complete: bool,
    url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DappCapturedTwitterProfile {
    #[serde(default)]
    handle: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    bio: Option<String>,
    #[serde(default)]
    followers_label: Option<String>,
    #[serde(default)]
    following_label: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    joined_label: Option<String>,
    #[serde(default)]
    verified: bool,
    #[serde(default)]
    followed_by_viewer: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DappCapturedTweetLink {
    target: String,
    display: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DappCapturedTweet {
    #[serde(default)]
    tweet_id: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    author_name: String,
    #[serde(default)]
    author_handle: String,
    #[serde(default)]
    avatar_url: Option<String>,
    text: String,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    links: Vec<DappCapturedTweetLink>,
}

#[derive(Clone, Debug, Deserialize)]
struct DappSubmitFomoAlertsRequest {
    url: String,
    alerts: Vec<DappCapturedFomoAlert>,
}

#[derive(Clone, Debug, Deserialize)]
struct DappSubmitFomoAuthRequest {
    url: String,
    authenticated: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct DappSubmitFomoStreamRequest {
    url: String,
    status: String,
    #[serde(default)]
    activity_source: Option<String>,
    #[serde(default)]
    observed_item_count: Option<u32>,
    #[serde(default)]
    normalized_alert_count: Option<u32>,
    #[serde(default)]
    observed_types: Option<String>,
    #[serde(default)]
    last_activity_at_ms: Option<u64>,
    #[serde(default)]
    retry_at_ms: Option<u64>,
    #[serde(default)]
    attempt: u32,
}

#[derive(Clone, Debug, Deserialize)]
struct DappSubmitFomoProfileRequest {
    request_id: String,
    requested_handle: String,
    url: String,
    status_code: u16,
    #[serde(default)]
    profile: Option<DappCapturedFomoProfile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DappCapturedFomoProfile {
    user_handle: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    profile_picture_url: Option<String>,
    followers: u64,
    #[serde(default)]
    following: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
struct DappCapturedFomoAlert {
    id: String,
    event_type: String,
    network_id: String,
    token_address: String,
    #[serde(default)]
    ticker: Option<String>,
    #[serde(default)]
    user_handle: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    profile_picture_url: Option<String>,
    #[serde(default)]
    follower_count: Option<u64>,
    #[serde(default)]
    trade_id: Option<String>,
    #[serde(default)]
    usd_amount: Option<f64>,
    #[serde(default)]
    market_cap: Option<f64>,
    #[serde(default)]
    trader_count: Option<u32>,
    #[serde(default)]
    thesis: Option<String>,
    #[serde(default)]
    thesis_id: Option<String>,
    created_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
struct DappFomoAlertEventItem {
    id: String,
    event_type: String,
    chain: String,
    token_address: String,
    ticker: Option<String>,
    user_handle: Option<String>,
    display_name: Option<String>,
    profile_picture_url: Option<String>,
    follower_count: Option<u64>,
    trade_id: Option<String>,
    usd_amount: Option<f64>,
    market_cap: Option<f64>,
    trader_count: Option<u32>,
    thesis: Option<String>,
    thesis_id: Option<String>,
    source_url: String,
    created_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
struct DappFomoAlertsEvent {
    tab_id: String,
    alerts: Vec<DappFomoAlertEventItem>,
    captured_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
struct DappFomoAuthEvent {
    tab_id: String,
    authenticated: bool,
    url: String,
    captured_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
struct DappFomoStreamEvent {
    tab_id: String,
    status: String,
    last_activity_at_ms: Option<u64>,
    retry_at_ms: Option<u64>,
    attempt: u32,
    captured_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
struct DappFomoProfileEvent {
    request_id: String,
    requested_handle: String,
    status_code: u16,
    profile: Option<DappCapturedFomoProfile>,
    captured_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
struct DappDownloadEvent {
    tab_id: String,
    url: String,
    path: String,
    status: &'static str,
}

#[derive(Serialize)]
struct ProxyResponse {
    status: u16,
    body: String,
}

#[derive(Deserialize)]
struct SignalTranslationRequest {
    text: String,
    target_language: String,
}

#[derive(Serialize)]
struct SignalTranslationResponse {
    translated_text: String,
    source_language: Option<String>,
}

#[derive(Deserialize)]
struct ProxyRequestHeader {
    name: String,
    value: String,
}

#[derive(Deserialize)]
struct ProxyRequestQuery {
    name: String,
    value: String,
}

#[derive(Deserialize)]
struct SecureSessionResponse {
    version: String,
    public_key_pem: String,
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

impl Drop for BiometricWalletStoreRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
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
    const ERR_SEC_AUTH_FAILED: i32 = -25293;
    const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

    fn exists(service: &str, account: &str) -> Result<bool, String> {
        let mut query = ItemSearchOptions::new();
        query
            .class(ItemClass::generic_password())
            .service(service)
            .account(account)
            .load_attributes(true)
            // Status checks run while the wallet list is loading. An older
            // ad-hoc-signed build may own this item, so never let a metadata
            // lookup display a macOS password prompt during application start.
            .skip_authenticated_items(true);
        match query.search() {
            Ok(items) => Ok(!items.is_empty()),
            Err(error)
                if matches!(
                    error.code(),
                    ERR_SEC_ITEM_NOT_FOUND | ERR_SEC_AUTH_FAILED | ERR_SEC_INTERACTION_NOT_ALLOWED
                ) =>
            {
                Ok(false)
            }
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

#[derive(Serialize)]
struct BiometricUnlockAllBody<'a> {
    password: &'a str,
}

fn response_reports_wrong_wallet_password(response: &ProxyResponse) -> bool {
    response.status == 401
        && serde_json::from_str::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|body| {
                body.get("error")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .as_deref()
            == Some("钱包密码错误")
}

#[tauri::command]
async fn biometric_wallet_unlock_all(
    process: tauri::State<'_, DesktopApiProcess>,
    req: BiometricWalletRequest,
) -> Result<ProxyResponse, String> {
    let accounts = biometric_wallet_accounts(&req.wallet_id, &req.public_key)?;
    #[cfg(target_os = "macos")]
    {
        biometric_touch_id_authenticate()?;
        let password = Zeroizing::new(biometric_wallet_keychain::load(&accounts.primary)?);
        let body = Zeroizing::new(
            serde_json::to_string(&BiometricUnlockAllBody {
                password: password.as_str(),
            })
            .map_err(|error| format!("failed to encode biometric unlock request: {error}"))?,
        );
        let response = proxy_api_request_inner(
            process.inner(),
            "POST".to_string(),
            "wallets/unlock-all".to_string(),
            None,
            None,
            Some(body),
            Some(true),
        )
        .await?;
        if response_reports_wrong_wallet_password(&response) {
            biometric_wallet_keychain::delete(&accounts.primary).map_err(|error| {
                format!("Touch ID 中保存的钱包密码已失效，且无法删除旧凭据: {error}")
            })?;
        }
        Ok(response)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = process;
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

fn local_api_url(
    api_port: u16,
    path: &str,
    query: Option<&[ProxyRequestQuery]>,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&format!("http://127.0.0.1:{api_port}/api/{path}"))
        .map_err(|error| format!("invalid local API URL: {error}"))?;
    if let Some(query) = query {
        let mut query_pairs = url.query_pairs_mut();
        for pair in query {
            query_pairs.append_pair(&pair.name, &pair.value);
        }
    }
    Ok(url.to_string())
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
    query: Option<Vec<ProxyRequestQuery>>,
    headers: Option<Vec<ProxyRequestHeader>>,
    body: Option<String>,
    secure_proxy: Option<bool>,
) -> Result<ProxyResponse, String> {
    proxy_api_request_inner(
        process.inner(),
        method,
        path,
        query,
        headers,
        body.map(Zeroizing::new),
        secure_proxy,
    )
    .await
}

async fn proxy_api_request_inner(
    process: &DesktopApiProcess,
    method: String,
    path: String,
    query: Option<Vec<ProxyRequestQuery>>,
    headers: Option<Vec<ProxyRequestHeader>>,
    body: Option<Zeroizing<String>>,
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
    let url = local_api_url(api_port, path, query.as_deref())?;

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
        req = req.header("X-Fnzero-Safe-Token", process.api_token());
    }
    if let Some(b) = body {
        if secure_proxy && matches!(method_upper.as_str(), "POST" | "PUT" | "PATCH") {
            if session.is_none() {
                session = Some(fetch_secure_session(&client, api_port).await?);
            }
            let session = session.as_ref().expect("secure session is initialized");
            let encrypted_body = encrypt_secure_body(&b, &session.public_key_pem)?;
            req = req.header(SECURE_BODY_HEADER, SECURE_BODY_VERSION);
            req = req.body(encrypted_body);
        } else {
            req = req.body(b.to_string());
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(ProxyResponse { status, body })
}

fn parse_google_translation(
    payload: &serde_json::Value,
) -> Result<SignalTranslationResponse, String> {
    let translated_text = payload
        .get(0)
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|segment| segment.get(0).and_then(serde_json::Value::as_str))
        .collect::<String>()
        .trim()
        .to_string();
    if translated_text.is_empty() {
        return Err("Google Translate returned an empty translation".to_string());
    }
    let source_language = payload
        .get(2)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 16)
        .map(str::to_string);
    Ok(SignalTranslationResponse {
        translated_text,
        source_language,
    })
}

#[tauri::command]
async fn translate_signal_text(
    request: SignalTranslationRequest,
) -> Result<SignalTranslationResponse, String> {
    let text = request.text.trim();
    if text.is_empty()
        || text.len() > MAX_SIGNAL_TRANSLATION_BYTES
        || text.chars().count() > 4_000
        || text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err("invalid translation text".to_string());
    }
    let target_language = match request.target_language.as_str() {
        "zh-CN" => "zh-CN",
        "en" => "en",
        _ => return Err("unsupported translation language".to_string()),
    };
    let mut url = reqwest::Url::parse("https://translate.googleapis.com/translate_a/single")
        .map_err(|error| format!("failed to build Google Translate URL: {error}"))?;
    url.query_pairs_mut()
        .append_pair("client", "gtx")
        .append_pair("sl", "auto")
        .append_pair("tl", target_language)
        .append_pair("dt", "t");
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
        )
        .build()
        .map_err(|error| format!("failed to initialize Google Translate: {error}"))?
        .post(url)
        .header("Accept", "application/json")
        .header("Accept-Language", "en-US,en;q=0.9")
        .form(&[("q", text)])
        .send()
        .await
        .map_err(|error| format!("Google Translate request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Google Translate returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("failed to read Google Translate response: {error}"))?;
    if body.len() > MAX_SIGNAL_TRANSLATION_RESPONSE_BYTES {
        return Err("Google Translate response is too large".to_string());
    }
    let payload: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| format!("invalid Google Translate response: {error}"))?;
    let translation = parse_google_translation(&payload)?;
    log::info!(
        "translated signal text with Google (target={target_language}, input_bytes={}, output_bytes={})",
        text.len(),
        translation.translated_text.len()
    );
    Ok(translation)
}

fn raw_url_has_authority_credentials(value: &str) -> bool {
    value
        .split_once("://")
        .map(|(_, value)| value.split(['/', '?', '#']).next().unwrap_or_default())
        .is_some_and(|authority| authority.contains('@'))
}

fn url_has_authority_credentials(url: &tauri::Url) -> bool {
    !url.username().is_empty() || url.password().is_some()
}

fn is_allowed_external_https_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.len() > 2_048
        || trimmed.chars().any(char::is_whitespace)
        || raw_url_has_authority_credentials(trimmed)
    {
        return false;
    }
    let Ok(parsed) = tauri::Url::parse(trimmed) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    parsed.scheme() == "https"
        && !url_has_authority_credentials(&parsed)
        && !host.starts_with('.')
        && !host.ends_with('.')
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
        std::process::Command::new("explorer.exe")
            .arg(url)
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

fn spawn_google_chrome(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .args(["-a", "Google Chrome", url])
            .status()
            .map_err(|error| format!("failed to open Google Chrome: {error}"))?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "Google Chrome is not available".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        let mut candidates = vec![PathBuf::from("chrome.exe")];
        for root in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
            if let Some(path) = env::var_os(root) {
                candidates.push(PathBuf::from(path).join("Google/Chrome/Application/chrome.exe"));
            }
        }
        for executable in candidates {
            if std::process::Command::new(executable)
                .arg(url)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("Google Chrome is not available".to_string())
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        for executable in ["google-chrome", "google-chrome-stable"] {
            if std::process::Command::new(executable)
                .arg(url)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("Google Chrome is not available".to_string())
    }
}

fn spawn_telegram_link(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|error| format!("failed to open Telegram: {error}"))?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "Telegram is not available".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("explorer.exe")
            .arg(url)
            .status()
            .map_err(|error| format!("failed to open Telegram: {error}"))?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "Telegram is not available".to_string())
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(url)
            .status()
            .map_err(|error| format!("failed to open Telegram: {error}"))?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "Telegram is not available".to_string())
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

fn dapp_browser_data_directory(app: &DesktopAppHandle) -> Result<PathBuf, String> {
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
    if url_has_authority_credentials(url) {
        return false;
    }
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

    matches!(url.scheme(), "about" | "blob")
}

fn dapp_session_request_url(tracked_session_url: &str) -> Option<tauri::Url> {
    tracked_session_url.parse().ok().filter(is_safe_browser_url)
}

fn update_dapp_session_navigation(session: &mut DappSession, url: &tauri::Url) {
    session.url = url.to_string();
    if !session.app_id.starts_with("web:") {
        return;
    }
    if let Some(host) = url.host_str() {
        session.app_id = format!("web:{host}");
        session.app_name = host.to_string();
    }
}

fn is_fomo_auth_popup_url(url: &tauri::Url) -> bool {
    if url.scheme() == "about" && url.path() == "blank" {
        return true;
    }
    if url_has_authority_credentials(url) || url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    host == "accounts.google.com"
        || host == "appleid.apple.com"
        || host == "privy.io"
        || host.ends_with(".privy.io")
}

fn is_valid_telegram_token(value: &str, allow_dash: bool) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'_' || (allow_dash && byte == b'-')
        })
}

fn is_valid_telegram_post(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn telegram_deep_link(url: &tauri::Url) -> Option<String> {
    if url.as_str().len() > 2_048 || url_has_authority_credentials(url) {
        return None;
    }
    if url.scheme() == "tg" {
        if !matches!(url.path(), "" | "/") || url.fragment().is_some() {
            return None;
        }
        let route = url.host_str()?.to_ascii_lowercase();
        let mut domain = None;
        let mut invite = None;
        let mut post = None;
        for (key, value) in url.query_pairs() {
            let slot = match key.as_ref() {
                "domain" => &mut domain,
                "invite" => &mut invite,
                "post" => &mut post,
                _ => return None,
            };
            if slot.replace(value.into_owned()).is_some() {
                return None;
            }
        }
        return match route.as_str() {
            "join" if domain.is_none() && post.is_none() => invite
                .filter(|value| is_valid_telegram_token(value, true))
                .map(|value| format!("tg://join?invite={value}")),
            "resolve" if invite.is_none() => {
                let domain = domain.filter(|value| is_valid_telegram_token(value, false))?;
                match post {
                    Some(post) if is_valid_telegram_post(&post) => {
                        Some(format!("tg://resolve?domain={domain}&post={post}"))
                    }
                    None => Some(format!("tg://resolve?domain={domain}")),
                    _ => None,
                }
            }
            _ => None,
        };
    }
    if url.scheme() != "https" || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "t.me" | "telegram.me" | "www.t.me" | "www.telegram.me"
    ) {
        return None;
    }
    let segments = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    match segments.as_slice() {
        [invite] if invite.starts_with('+') => invite
            .strip_prefix('+')
            .filter(|value| is_valid_telegram_token(value, true))
            .map(|value| format!("tg://join?invite={value}")),
        [route, invite] if route.eq_ignore_ascii_case("joinchat") => {
            is_valid_telegram_token(invite, true).then(|| format!("tg://join?invite={invite}"))
        }
        [route, domain] if route.eq_ignore_ascii_case("s") => {
            is_valid_telegram_token(domain, false).then(|| format!("tg://resolve?domain={domain}"))
        }
        [route, domain, post]
            if route.eq_ignore_ascii_case("s")
                && is_valid_telegram_token(domain, false)
                && is_valid_telegram_post(post) =>
        {
            Some(format!("tg://resolve?domain={domain}&post={post}"))
        }
        [domain] if is_valid_telegram_token(domain, false) => {
            Some(format!("tg://resolve?domain={domain}"))
        }
        [domain, post]
            if is_valid_telegram_token(domain, false) && is_valid_telegram_post(post) =>
        {
            Some(format!("tg://resolve?domain={domain}&post={post}"))
        }
        _ => None,
    }
}

fn open_telegram_target(url: &tauri::Url) -> bool {
    let Some(native_url) = telegram_deep_link(url) else {
        return false;
    };
    let fallback_url = (url.scheme() == "https").then(|| url.to_string());
    std::thread::spawn(move || {
        if spawn_telegram_link(&native_url).is_err() {
            if let Some(fallback_url) = fallback_url {
                let _ = spawn_system_browser(&fallback_url);
            }
        }
    });
    true
}

fn is_allowed_connected_dapp_navigation_url(dapp: &AllowedDapp, url: &tauri::Url) -> bool {
    is_allowed_dapp_url(dapp, url) || matches!(url.scheme(), "about" | "blob")
}

fn parse_dapp_browser_url(raw_url: &str) -> Result<tauri::Url, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return Err("invalid dapp URL".to_string());
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace())
        || raw_url_has_authority_credentials(trimmed)
    {
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
    if url.scheme() != "https" || !is_safe_browser_url(url) {
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

fn is_likely_evm_address(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() == 42
        && trimmed.starts_with("0x")
        && trimmed[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_dapp_wallet_family(
    value: Option<&str>,
    has_allowlisted_dapp: bool,
) -> Result<String, String> {
    let family = value
        .unwrap_or(if has_allowlisted_dapp { "solana" } else { "" })
        .trim();
    match family {
        "solana" | "evm" => Ok(family.to_string()),
        _ => Err("unsupported dapp wallet family".to_string()),
    }
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

fn validate_evm_dapp_method(method: &str) -> Result<String, String> {
    let normalized = method.trim();
    match normalized {
        "personal_sign"
        | "eth_sign"
        | "eth_signTypedData"
        | "eth_signTypedData_v4"
        | "eth_sendTransaction"
        | "eth_signTransaction" => Ok(normalized.to_string()),
        _ => Err("unsupported EVM dapp signing method".to_string()),
    }
}

fn validate_evm_payload_json(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 128 * 1024 {
        return Err("invalid EVM dapp payload".to_string());
    }
    let parsed: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|_| "EVM dapp payload is not valid JSON".to_string())?;
    if !parsed.is_array() && !parsed.is_object() {
        return Err("EVM dapp payload must be a JSON array or object".to_string());
    }
    Ok(trimmed.to_string())
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
    app_host == callback_host || callback_host.ends_with(&format!(".{app_host}"))
}

fn validate_deep_link_callback_url(
    callback_url: Option<String>,
    app_url: &tauri::Url,
) -> Result<Option<String>, String> {
    let Some(callback_url) = callback_url else {
        return Ok(None);
    };
    let trimmed = callback_url.trim();
    if trimmed.len() > 2_048
        || trimmed.chars().any(char::is_whitespace)
        || raw_url_has_authority_credentials(trimmed)
    {
        return Err("callback_url is invalid or too long".to_string());
    }
    let callback = trimmed
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid callback_url: {error}"))?;
    let callback_is_local_http = callback.scheme() == "http"
        && matches!(callback.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if (callback.scheme() != "https" && !callback_is_local_http)
        || url_has_authority_credentials(&callback)
    {
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

fn validate_deep_link_wallet_family(value: Option<&str>) -> Result<String, String> {
    validate_dapp_wallet_family(value.or(Some("solana")), false)
}

fn validate_deep_link_evm_network(network: &str) -> Result<String, String> {
    let network = validate_dapp_network(network)?;
    let chain_id = network
        .strip_prefix("eip155:")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "EVM deep link network must use eip155:<chainId>".to_string())?;
    Ok(format!("eip155:{chain_id}"))
}

fn validate_deep_link_payload_json(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 24 * 1024 {
        return Err("invalid EVM deep link payload".to_string());
    }
    validate_evm_payload_json(trimmed)
}

fn parse_connect_deep_link(url: &tauri::Url) -> Result<DappConnectRequestEvent, String> {
    if !is_connect_deep_link(url) {
        return Err("unsupported fnzsafe connect deep link".to_string());
    }
    let wallet_family_param = deep_link_query_param(url, "wallet_family")
        .or_else(|| deep_link_query_param(url, "family"));
    let wallet_family = validate_deep_link_wallet_family(wallet_family_param.as_deref())?;
    let network = if wallet_family == "evm" {
        validate_deep_link_evm_network(
            deep_link_query_param(url, "network")
                .as_deref()
                .unwrap_or("eip155:1"),
        )?
    } else {
        validate_dapp_network(
            deep_link_query_param(url, "network")
                .as_deref()
                .unwrap_or("mainnet"),
        )?
    };
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
    let wallet_public_key = deep_link_query_param(url, "wallet_public_key")
        .map(|value| {
            let address = validate_short_deep_link_text(&value, "wallet_public_key", 64)?;
            if wallet_family == "evm" {
                if !is_likely_evm_address(&address) {
                    return Err("invalid EVM wallet address".to_string());
                }
            } else if !is_likely_solana_pubkey(&address) {
                return Err("invalid wallet public key".to_string());
            }
            Ok(address)
        })
        .transpose()?;

    Ok(DappConnectRequestEvent {
        request_id,
        app_id: "fnzsafe-deep-link".to_string(),
        app_name,
        app_url: app_url_string,
        wallet_family,
        wallet_public_key,
        network,
        callback_url: Some(callback_url),
        created_at_ms: now_ms(),
    })
}

fn parse_sign_deep_link(url: &tauri::Url) -> Result<DappSignRequestEvent, String> {
    if !is_sign_deep_link(url) {
        return Err("unsupported fnzsafe deep link".to_string());
    }

    let wallet_family_param = deep_link_query_param(url, "wallet_family")
        .or_else(|| deep_link_query_param(url, "family"));
    let wallet_family = validate_deep_link_wallet_family(wallet_family_param.as_deref())?;
    let method_raw = deep_link_query_param(url, "method")
        .ok_or_else(|| "method is required".to_string())?;
    let wallet_public_key = validate_short_deep_link_text(
        deep_link_query_param(url, "wallet_public_key")
            .as_deref()
            .ok_or_else(|| "wallet_public_key is required".to_string())?,
        "wallet_public_key",
        64,
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

    if wallet_family == "evm" {
        if !is_likely_evm_address(&wallet_public_key) {
            return Err("invalid EVM wallet address".to_string());
        }
        let method = validate_evm_dapp_method(&method_raw)?;
        let network = validate_deep_link_evm_network(
            deep_link_query_param(url, "network")
                .as_deref()
                .unwrap_or("eip155:1"),
        )?;
        let payload_json = validate_deep_link_payload_json(
            deep_link_query_param(url, "payload_json")
                .as_deref()
                .ok_or_else(|| "EVM deep link payload is required".to_string())?,
        )?;
        return Ok(DappSignRequestEvent {
            request_id,
            app_id: "fnzsafe-deep-link".to_string(),
            app_name,
            app_url: app_url_string,
            request_purpose,
            method,
            wallet_family,
            wallet_public_key,
            network,
            transaction_base64: String::new(),
            transaction_format: "evm-json".to_string(),
            message_base64: None,
            payload_json: Some(payload_json),
            callback_url,
            known_programs: Vec::new(),
            created_at_ms: now_ms(),
        });
    }

    if !is_likely_solana_pubkey(&wallet_public_key) {
        return Err("invalid wallet public key".to_string());
    }
    let method = validate_dapp_method(&method_raw)?;
    let network = validate_dapp_network(
        deep_link_query_param(url, "network")
            .as_deref()
            .unwrap_or("mainnet"),
    )?;
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
        wallet_family,
        wallet_public_key,
        network,
        transaction_base64,
        transaction_format,
        message_base64,
        payload_json: None,
        callback_url,
        known_programs: deep_link_known_programs(url)?,
        created_at_ms: now_ms(),
    })
}

fn prune_expired_dapp_sign_requests(
    requests: &mut HashMap<String, DappPendingRequest>,
    current_time_ms: u64,
) {
    requests.retain(|_, pending| {
        current_time_ms.saturating_sub(pending.event.created_at_ms) <= DAPP_REQUEST_TTL_MS
    });
}

fn prune_expired_dapp_connect_requests(
    requests: &mut HashMap<String, DappPendingConnectRequest>,
    current_time_ms: u64,
) {
    requests.retain(|_, pending| {
        current_time_ms.saturating_sub(pending.event.created_at_ms) <= DAPP_REQUEST_TTL_MS
    });
}

fn enqueue_dapp_sign_request(
    app: &DesktopAppHandle,
    state: &DappBridgeState,
    webview_label: String,
    event: DappSignRequestEvent,
) -> Result<(), String> {
    ensure_dapp_connections_active(state)?;
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "dapp request lock poisoned".to_string())?;
    ensure_dapp_connections_active(state)?;
    prune_expired_dapp_sign_requests(&mut requests, now_ms());
    if requests
        .values()
        .filter(|pending| pending.result.is_none())
        .count()
        >= MAX_PENDING_DAPP_REQUESTS
    {
        return Err("too many pending dapp signing requests".to_string());
    }
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

    let request_id = event.request_id.clone();
    if let Err(error) = app.emit_to("main", DAPP_SIGN_REQUEST_EVENT, event) {
        log::warn!("failed to notify main window about dapp signing request {request_id}: {error}");
        state
            .requests
            .lock()
            .map_err(|_| "dapp request lock poisoned during notification rollback".to_string())?
            .remove(&request_id);
        return Err(format!("failed to notify main window: {error}"));
    }
    log::info!("queued dapp signing request {request_id} and notified the main window");
    Ok(())
}

fn enqueue_dapp_connect_request(
    app: &DesktopAppHandle,
    state: &DappBridgeState,
    webview_label: Option<String>,
    event: DappConnectRequestEvent,
) -> Result<(), String> {
    ensure_dapp_connections_active(state)?;
    let mut requests = state
        .connect_requests
        .lock()
        .map_err(|_| "dapp connect request lock poisoned".to_string())?;
    ensure_dapp_connections_active(state)?;
    prune_expired_dapp_connect_requests(&mut requests, now_ms());
    if requests
        .values()
        .filter(|pending| pending.result.is_none())
        .count()
        >= MAX_PENDING_DAPP_REQUESTS
    {
        return Err("too many pending dapp connection requests".to_string());
    }
    if requests.contains_key(&event.request_id) {
        return Err("dapp connect request id is already pending".to_string());
    }
    requests.insert(
        event.request_id.clone(),
        DappPendingConnectRequest {
            webview_label,
            event: event.clone(),
            result: None,
        },
    );
    drop(requests);

    let request_id = event.request_id.clone();
    if let Err(error) = app.emit_to("main", DAPP_CONNECT_REQUEST_EVENT, event) {
        log::warn!("failed to notify main window about dapp connect request {request_id}: {error}");
        state
            .connect_requests
            .lock()
            .map_err(|_| {
                "dapp connect request lock poisoned during notification rollback".to_string()
            })?
            .remove(&request_id);
        return Err(format!("failed to notify main window: {error}"));
    }
    log::info!("queued dapp connect request {request_id} and notified the main window");
    Ok(())
}

fn focus_main_window(app: &DesktopAppHandle) {
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

fn handle_sign_deep_link(app: &DesktopAppHandle, url: &tauri::Url) -> Result<(), String> {
    let event = parse_sign_deep_link(url)?;
    focus_main_window(app);
    let state = app.state::<DappBridgeState>();
    enqueue_dapp_sign_request(app, state.inner(), "deep-link".to_string(), event)
}

fn handle_connect_deep_link(app: &DesktopAppHandle, url: &tauri::Url) -> Result<(), String> {
    let event = parse_connect_deep_link(url)?;
    focus_main_window(app);
    let state = app.state::<DappBridgeState>();
    enqueue_dapp_connect_request(app, state.inner(), None, event)
}

fn handle_fnzsafe_deep_link(app: &DesktopAppHandle, url: &tauri::Url) -> Result<(), String> {
    if is_connect_deep_link(url) {
        handle_connect_deep_link(app, url)
    } else {
        handle_sign_deep_link(app, url)
    }
}

fn handle_current_fnzsafe_deep_links(app: &DesktopAppHandle) {
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

fn solana_dapp_provider_script(
    app_id: &str,
    app_name: &str,
    wallet_public_key: &str,
    network: &str,
) -> Result<String, String> {
    let wallet_public_key = serde_json::to_string(wallet_public_key).map_err(|e| e.to_string())?;
    let network = serde_json::to_string(network).map_err(|e| e.to_string())?;
    let app_id = serde_json::to_string(app_id).map_err(|e| e.to_string())?;
    let app_name = serde_json::to_string(app_name).map_err(|e| e.to_string())?;
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
	  let connected = false;
	  let connectionPromise = null;

  function sleep(ms) {{ return new Promise((resolve) => setTimeout(resolve, ms)); }}
	  function tauriInvoke(command, args) {{
	    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
	    if (typeof invoke !== "function") {{
	      throw new Error("FnzSafe bridge is unavailable");
	    }}
		    return invoke(command, args || {{}});
		  }}
	  async function requestConnection() {{
	    if (connected) return {{ publicKey }};
	    if (connectionPromise) return connectionPromise;
	    connectionPromise = (async () => {{
	      const requestId = await tauriInvoke("dapp_submit_connect_request");
	      const started = Date.now();
	      while (Date.now() - started < 180000) {{
	        const poll = await tauriInvoke("dapp_poll_connect_request", {{ requestId }});
	        if (poll.status === "approved") {{
	          if (String(poll.result?.public_key || "") !== walletPublicKey) {{
	            throw new Error("FnzSafe returned a different wallet account");
	          }}
	          connected = true;
	          setAutoConnectHints();
	          emit("connect", publicKey);
	          emitWallet("change", {{ accounts: standardWallet.accounts }});
	          return {{ publicKey }};
	        }}
	        if (poll.status === "rejected") throw new Error(poll.result?.error || "User rejected the request");
	        if (poll.status === "expired") throw new Error("FnzSafe connection request expired");
	        await sleep(500);
	      }}
	      throw new Error("FnzSafe connection request timed out");
	    }})();
	    try {{
	      return await connectionPromise;
	    }} finally {{
	      connectionPromise = null;
	    }}
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
	      return requestConnection();
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
	      if (!connected) await requestConnection();
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
	      if (!connected) await requestConnection();
	      const transaction = input?.transaction || input;
      const result = await requestSignature("signAndSendTransaction", transaction);
      if (!result.signature) throw new Error("FnzSafe did not return a transaction signature");
      return {{ signature: result.signature }};
    }},
	    async sendTransaction(transaction, connection, options) {{
	      if (!connected) await requestConnection();
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
	      if (!connected) await requestConnection();
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
	          await requestConnection();
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
	          if (!connected) await requestConnection();
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
	          if (!connected) await requestConnection();
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
	          if (!connected) await requestConnection();
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
	  try {{ window.dispatchEvent(new Event("solana#initialized")); }} catch (_) {{}}
	  registerStandardWallet(standardWallet);
  installFnzSafeDomPrioritizer();
  [0, 250, 750, 1500, 3000].forEach((delay) => window.setTimeout(prioritizeFnzSafes, delay));
  [0, 250, 750, 1500, 3000].forEach((delay) => window.setTimeout(prioritizeFnzSafeDom, delay));
  [0, 250, 750, 1500, 3000].forEach((delay) => window.setTimeout(announceConnected, delay));
}})();
"#
    ))
}

fn evm_dapp_provider_script(wallet_address: &str, network: &str) -> Result<String, String> {
    if !is_likely_evm_address(wallet_address) {
        return Err("invalid EVM wallet address".to_string());
    }
    let chain_id = network
        .strip_prefix("eip155:")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "invalid EVM dapp network".to_string())?;
    let wallet_address = serde_json::to_string(wallet_address).map_err(|e| e.to_string())?;
    let chain_id_hex =
        serde_json::to_string(&format!("0x{chain_id:x}")).map_err(|e| e.to_string())?;
    let chain_id_decimal =
        serde_json::to_string(&chain_id.to_string()).map_err(|e| e.to_string())?;
    let wallet_name = serde_json::to_string(DAPP_WALLET_NAME).map_err(|e| e.to_string())?;
    let wallet_icon = serde_json::to_string(&format!(
        "data:image/png;base64,{}",
        BASE64.encode(include_bytes!("../icons/dapp-wallet-icon.png"))
    ))
    .map_err(|e| e.to_string())?;
    let script = r#"
(function () {
  if (window.__FNZSAFE_EVM_PROVIDER__) return;
  const walletAddress = __WALLET_ADDRESS__;
  const chainId = __CHAIN_ID_HEX__;
  const networkVersion = __CHAIN_ID_DECIMAL__;
  const walletName = __WALLET_NAME__;
  const walletIcon = __WALLET_ICON__;
  const listeners = new Map();
  let connected = false;
  let connectionPromise = null;

  function providerError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  function emit(event, value) {
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const handler of Array.from(handlers)) {
      try { handler(value); } catch (_) {}
    }
  }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function tauriInvoke(command, args) {
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") throw providerError(4900, "FnzSafe bridge is unavailable");
    return invoke(command, args || {});
  }
  async function requestSignature(method, params) {
    const requestId = await tauriInvoke("dapp_submit_sign_request", {
      method,
      payloadJson: JSON.stringify({ method, params: params ?? [] }),
    });
    const started = Date.now();
    while (Date.now() - started < 180000) {
      const poll = await tauriInvoke("dapp_poll_sign_request", { requestId });
      if (poll.status === "approved") {
        if (method === "eth_signTransaction") {
          if (!poll.result?.raw_transaction) throw providerError(-32603, "FnzSafe did not return a signed transaction");
          return poll.result.raw_transaction;
        }
        if (!poll.result?.signature) throw providerError(-32603, "FnzSafe did not return a signature");
        return poll.result.signature;
      }
      if (poll.status === "rejected") {
        throw providerError(4001, poll.result?.error || "User rejected the request");
      }
      if (poll.status === "expired") throw providerError(4001, "FnzSafe signing request expired");
      await sleep(500);
    }
    throw providerError(4900, "FnzSafe signing request timed out");
  }
  async function requestConnection() {
    if (connected) return [walletAddress];
    if (connectionPromise) return connectionPromise;
    connectionPromise = (async () => {
      const requestId = await tauriInvoke("dapp_submit_connect_request");
      const started = Date.now();
      while (Date.now() - started < 180000) {
        const poll = await tauriInvoke("dapp_poll_connect_request", { requestId });
        if (poll.status === "approved") {
          const approvedAddress = String(poll.result?.public_key || "");
          if (approvedAddress.toLowerCase() !== walletAddress.toLowerCase()) {
            throw providerError(-32603, "FnzSafe returned a different wallet account");
          }
          connected = true;
          emit("connect", { chainId });
          emit("accountsChanged", [walletAddress]);
          return [walletAddress];
        }
        if (poll.status === "rejected") {
          throw providerError(4001, poll.result?.error || "User rejected the request");
        }
        if (poll.status === "expired") throw providerError(4001, "FnzSafe connection request expired");
        await sleep(500);
      }
      throw providerError(4900, "FnzSafe connection request timed out");
    })();
    try {
      return await connectionPromise;
    } finally {
      connectionPromise = null;
    }
  }
  const provider = {
    isFnzSafe: true,
    isConnected: () => connected,
    get chainId() { return chainId; },
    get networkVersion() { return networkVersion; },
    get selectedAddress() { return connected ? walletAddress : null; },
    async request(args) {
      if (!args || typeof args.method !== "string") throw providerError(-32600, "Invalid EIP-1193 request");
      const method = args.method;
      const params = args.params ?? [];
      switch (method) {
        case "eth_chainId": return chainId;
        case "net_version": return networkVersion;
        case "eth_accounts": return connected ? [walletAddress] : [];
        case "eth_coinbase": return connected ? walletAddress : null;
        case "eth_requestAccounts": return requestConnection();
        case "wallet_requestPermissions":
          await requestConnection();
          return [{ parentCapability: "eth_accounts" }];
        case "wallet_getPermissions":
          return connected ? [{ parentCapability: "eth_accounts" }] : [];
        case "wallet_switchEthereumChain": {
          const requested = String(params?.[0]?.chainId || "").toLowerCase();
          if (requested === chainId.toLowerCase()) return null;
          throw providerError(4902, "Switch the active EVM network in FnzSafe first");
        }
        case "wallet_addEthereumChain": {
          const requested = String(params?.[0]?.chainId || "").toLowerCase();
          if (requested === chainId.toLowerCase()) return null;
          throw providerError(4200, "Add the network in FnzSafe settings first");
        }
        case "personal_sign":
        case "eth_sign":
        case "eth_signTypedData":
        case "eth_signTypedData_v4":
        case "eth_sendTransaction":
        case "eth_signTransaction":
          if (!connected) await requestConnection();
          return requestSignature(method, params);
        default:
          throw providerError(4200, "Unsupported FnzSafe provider method: " + method);
      }
    },
    enable() { return this.request({ method: "eth_requestAccounts" }); },
    send(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === "string") {
        return this.request({ method: methodOrPayload, params: paramsOrCallback || [] });
      }
      const promise = this.request(methodOrPayload || {});
      if (typeof paramsOrCallback === "function") {
        promise.then(
          (result) => paramsOrCallback(null, { id: methodOrPayload?.id, jsonrpc: "2.0", result }),
          (error) => paramsOrCallback(error, null),
        );
      }
      return promise;
    },
    sendAsync(payload, callback) {
      this.request(payload || {}).then(
        (result) => callback(null, { id: payload?.id, jsonrpc: "2.0", result }),
        (error) => callback(error, null),
      );
    },
    on(event, handler) {
      if (typeof handler !== "function") return this;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return this;
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
      return this;
    },
    off(event, handler) { return this.removeListener(event, handler); },
  };
  provider.providers = [provider];
  const providerInfo = Object.freeze({
    uuid: "6fdd35f3-8306-4c49-8c52-9f6c73c86e8a",
    name: walletName,
    icon: walletIcon,
    rdns: "dev.fnzero.safe",
  });
  const providerDetail = Object.freeze({ info: providerInfo, provider });
  function announceProvider() {
    try {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: providerDetail }));
    } catch (_) {}
  }
  try {
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  } catch (_) {
    try { window.ethereum = provider; } catch (_) {}
  }
  Object.defineProperty(window, "fnzsafe", { value: provider, configurable: true });
  Object.defineProperty(window, "__FNZSAFE_EVM_PROVIDER__", { value: provider, configurable: false });
  window.addEventListener("eip6963:requestProvider", announceProvider);
  announceProvider();
  [0, 100, 500, 1500, 3000].forEach((delay) => window.setTimeout(announceProvider, delay));
  try { window.dispatchEvent(new Event("ethereum#initialized")); } catch (_) {}
})();
"#;
    Ok(script
        .replace("__WALLET_ADDRESS__", &wallet_address)
        .replace("__CHAIN_ID_HEX__", &chain_id_hex)
        .replace("__CHAIN_ID_DECIMAL__", &chain_id_decimal)
        .replace("__WALLET_NAME__", &wallet_name)
        .replace("__WALLET_ICON__", &wallet_icon))
}

fn fomo_alert_capture_script() -> &'static str {
    r#"
(function () {
  const host = window.location.hostname.toLowerCase();
  if ((host !== "fomo.family" && !host.endsWith(".fomo.family")) || window.__FNZSAFE_FOMO_ALERT_CAPTURE__) return;
  window.__FNZSAFE_FOMO_ALERT_CAPTURE__ = true;

  const alertTypes = new Set([
    "swap_buy", "swap_sell", "transfer_in", "transfer_out", "multi_user_buy", "multi_user_sell", "thesis_created",
  ]);
  const pending = new Map();
  const submittedAlertIds = new Set();
  let flushTimer = null;
  let authState = null;
  let loginTriggered = false;
  let authDomTimer = null;
  let fomoAuthorization = "";
  let fomoSupportedChains = "";
  const streamSockets = new Set();
  let streamSocketObserved = false;
  const recoveryStorageKey = "__fnzsafe_fomo_stream_recovery_attempt";
  let recoveryTimer = null;
  let recoveryAttempt = 0;
  let lastStreamActivityAt = 0;
  let lastStreamReportAt = 0;
  let lastStreamReportSignature = "";
  let streamReportRetryTimer = null;
  let feedPollInFlight = false;

  try {
    recoveryAttempt = Math.min(16, Math.max(0, Number.parseInt(sessionStorage.getItem(recoveryStorageKey) || "0", 10) || 0));
  } catch (_) {}

  const clean = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
  const finite = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const timestamp = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value < 1e12 ? value * 1000 : value));
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : Date.now();
  };

  const hasOpenStreamSocket = () => Array.from(streamSockets).some((socket) =>
    socket && socket.readyState === 1
  );

  const isFomoStreamUrl = (value) => {
    try {
      const url = new URL(String(value || ""), window.location.href);
      return (url.protocol === "ws:" || url.protocol === "wss:")
        && (url.hostname === "fomo.family" || url.hostname.endsWith(".fomo.family"));
    } catch (_) {
      return false;
    }
  };

  async function reportStream(status, retryAt = 0, force = false, activitySource = "", telemetry = null) {
    const now = Date.now();
    const signature = `${status}:${retryAt || 0}:${recoveryAttempt}:${activitySource}:${telemetry?.observedItemCount ?? ""}:${telemetry?.normalizedAlertCount ?? ""}:${telemetry?.observedTypes ?? ""}`;
    if (!force && signature === lastStreamReportSignature && now - lastStreamReportAt < 30_000) return;
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") {
      if (streamReportRetryTimer === null) {
        streamReportRetryTimer = window.setTimeout(() => {
          streamReportRetryTimer = null;
          void reportStream(status, retryAt, true);
        }, 500);
      }
      return;
    }
    try {
      await invoke("dapp_submit_fomo_stream", {
        payload: {
          status,
          url: window.location.href,
          activity_source: activitySource || null,
          observed_item_count: telemetry?.observedItemCount ?? null,
          normalized_alert_count: telemetry?.normalizedAlertCount ?? null,
          observed_types: telemetry?.observedTypes || null,
          last_activity_at_ms: lastStreamActivityAt || null,
          retry_at_ms: retryAt || null,
          attempt: recoveryAttempt,
        },
      });
      lastStreamReportSignature = signature;
      lastStreamReportAt = now;
    } catch (_) {}
  }

  function cancelRecovery() {
    if (recoveryTimer !== null) {
      window.clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
  }

  function markStreamActivity(healthyStream = true, activitySource = "trading_data") {
    lastStreamActivityAt = Date.now();
    if (healthyStream) {
      cancelRecovery();
      if (recoveryAttempt !== 0) {
        recoveryAttempt = 0;
        try { sessionStorage.removeItem(recoveryStorageKey); } catch (_) {}
      }
    }
    if (healthyStream || !streamSocketObserved) void reportStream("connected", 0, false, activitySource);
  }

  function scheduleStreamRecovery(force = false) {
    if (!navigator.onLine) {
      cancelRecovery();
      void reportStream("offline", 0, true);
      return;
    }
    if (!streamSocketObserved || (!force && hasOpenStreamSocket()) || recoveryTimer !== null) return;
    const baseDelay = Math.min(300_000, 15_000 * (2 ** Math.min(recoveryAttempt, 5)));
    const delay = Math.min(300_000, Math.round(baseDelay * (1 + Math.random() * 0.2)));
    const retryAt = Date.now() + delay;
    void reportStream("reconnecting", retryAt, true);
    recoveryTimer = window.setTimeout(() => {
      recoveryTimer = null;
      if (!navigator.onLine) {
        void reportStream("offline", 0, true);
        return;
      }
      if (!force && hasOpenStreamSocket()) {
        void reportStream("connected", 0, true);
        return;
      }
      recoveryAttempt = Math.min(16, recoveryAttempt + 1);
      try { sessionStorage.setItem(recoveryStorageKey, String(recoveryAttempt)); } catch (_) {}
      window.location.reload();
    }, delay);
  }

  async function reportAuth(authenticated) {
    if (authState === authenticated) return;
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") {
      window.setTimeout(() => reportAuth(authenticated), 500);
      return;
    }
    try {
      await invoke("dapp_submit_fomo_auth", { payload: { authenticated, url: window.location.href } });
      authState = authenticated;
    } catch (_) {}
  }

  function detectAuthUi() {
    authDomTimer = null;
    const buttons = Array.from(document.querySelectorAll("button"));
    const text = (element) => String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const buttonLabels = buttons.map(text);
    const loginModalOpen = buttonLabels.some((label) =>
      label === "Continue with Apple" || label === "Continue with Google"
    );
    if (loginModalOpen) {
      void reportAuth(false);
      return;
    }
    const loginButton = buttons.find((button) => text(button) === "Login");
    if (loginButton) {
      void reportAuth(false);
      if (window.location.pathname === "/" && !loginTriggered) {
        loginTriggered = true;
        loginButton.click();
      }
      return;
    }
    const alertsButton = buttons.find((button) => text(button) === "Alerts");
    if (alertsButton && window.location.pathname.startsWith("/tokens/")) {
      void reportAuth(true);
    }
  }

  function scheduleAuthUiCheck() {
    if (authDomTimer !== null) return;
    authDomTimer = window.setTimeout(detectAuthUi, 50);
  }

  function normalizeAlert(value) {
    const item = record(value);
    if (!item) return null;
    const rawEventType = clean(item.type, 32);
    const eventType = rawEventType === "thesis" ? "thesis_created" : rawEventType;
    const id = clean(item.id, 128);
    const body = record(item.body) || {};
    const comment = record(item.comment) || {};
    const networkId = clean(String(item.networkId ?? body.networkId ?? ""), 32);
    const tokenAddress = clean(item.tokenAddress ?? body.tokenAddress, 128);
    if (!id || !alertTypes.has(eventType) || !networkId || !tokenAddress) return null;

    const topTraders = Array.isArray(body.topTraders) ? body.topTraders : [];
    const topTrader = record(topTraders[0]) || {};
    const traderProfile = record(item.user) || record(topTrader.user) || record(topTrader.profile) || {};
    const traderCount = finite(body.uniqueTraders);
    const thesis = eventType === "thesis_created"
      ? clean(comment.comment ?? body.comment ?? body.thesis ?? item.thesis, 4000)
      : "";
    if (eventType === "thesis_created" && !thesis) return null;
    const followerCount = finite(
      item.followers ?? body.followers ?? topTrader.followers ?? traderProfile.followers
    );
    return {
      id,
      event_type: eventType,
      network_id: networkId,
      token_address: tokenAddress,
      ticker: clean(item.ticker ?? body.ticker, 32) || null,
      user_handle: clean(item.userHandle ?? body.userHandle ?? topTrader.userHandle, 80) || null,
      display_name: clean(item.displayName ?? body.displayName ?? topTrader.displayName, 120) || null,
      profile_picture_url: clean(item.profilePictureLink ?? body.userImageUrl ?? body.profilePictureLink ?? topTrader.profilePictureLink, 2048) || null,
      follower_count: followerCount === null ? null : Math.floor(followerCount),
      trade_id: clean(item.tradeId, 128) || null,
      usd_amount: finite(item.usdAmount ?? body.totalVolume),
      market_cap: finite(item.fdv ?? item.marketCap ?? body.fdv ?? body.marketCap),
      trader_count: traderCount === null ? null : Math.max(1, Math.floor(traderCount)),
      thesis: thesis || null,
      thesis_id: eventType === "thesis_created"
        ? clean(comment.commentId ?? comment.id ?? body.commentId ?? item.commentId ?? id, 128) || null
        : null,
      created_at_ms: timestamp(item.createdAt),
    };
  }

  function collectAlerts(value, depth = 0) {
    if (depth > 5 || value == null) return [];
    if (typeof value === "string" && value.length <= 2_000_000) {
      try { return collectAlerts(JSON.parse(value), depth + 1); } catch (_) { return []; }
    }
    if (Array.isArray(value)) return value.slice(0, 500).flatMap((item) => collectAlerts(item, depth + 1));
    const item = record(value);
    if (!item) return [];
    const alert = normalizeAlert(item);
    if (alert) return [alert];
    return ["responseObject", "items", "payload", "data", "pages", "events", "feed", "result"]
      .flatMap((key) => collectAlerts(item[key], depth + 1));
  }

  function inspectAlertPayload(value, depth = 0, stats = { observedItemCount: 0, observedTypes: new Set() }) {
    if (depth > 5 || value == null) return stats;
    if (typeof value === "string" && value.length <= 2_000_000) {
      try { return inspectAlertPayload(JSON.parse(value), depth + 1, stats); } catch (_) { return stats; }
    }
    if (Array.isArray(value)) {
      value.slice(0, 500).forEach((item) => inspectAlertPayload(item, depth + 1, stats));
      return stats;
    }
    const item = record(value);
    if (!item) return stats;
    const type = clean(item.type, 32);
    if (clean(item.id, 128) && type) {
      stats.observedItemCount += 1;
      stats.observedTypes.add(type);
      return stats;
    }
    ["responseObject", "items", "payload", "data", "pages", "events", "feed", "result"]
      .forEach((key) => inspectAlertPayload(item[key], depth + 1, stats));
    return stats;
  }

  function alertPayloadTelemetry(value) {
    const stats = inspectAlertPayload(value);
    return {
      observedItemCount: Math.min(10_000, stats.observedItemCount),
      normalizedAlertCount: collectAlerts(value).length,
      observedTypes: Array.from(stats.observedTypes).sort().slice(0, 20).join(",").slice(0, 512),
    };
  }

  async function flush() {
    flushTimer = null;
    if (pending.size === 0) return;
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") {
      flushTimer = window.setTimeout(flush, 1000);
      return;
    }
    const alerts = Array.from(pending.values()).slice(0, 200);
    alerts.forEach((alert) => pending.delete(alert.id));
    try {
      await invoke("dapp_submit_fomo_alerts", { payload: { alerts, url: window.location.href } });
      for (const alert of alerts) {
        submittedAlertIds.add(alert.id);
        if (submittedAlertIds.size > 2_000) {
          const oldest = submittedAlertIds.values().next().value;
          if (oldest) submittedAlertIds.delete(oldest);
        }
      }
    } catch (_) {
      alerts.forEach((alert) => pending.set(alert.id, alert));
      flushTimer = window.setTimeout(flush, 2000);
    }
  }

  function enqueue(value) {
    for (const alert of collectAlerts(value)) {
      if (!submittedAlertIds.has(alert.id)) pending.set(alert.id, alert);
    }
    if (pending.size > 0 && flushTimer === null) flushTimer = window.setTimeout(flush, 50);
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = async function (...args) {
      const response = await nativeFetch.apply(this, args);
      try {
        const requestUrl = typeof args[0] === "string" || args[0] instanceof URL
          ? new URL(String(args[0]), window.location.href)
          : new URL(args[0]?.url || "", window.location.href);
        if (requestUrl.hostname === "prod-api.fomo.family") {
          const headers = new Headers(
            args[1]?.headers || (typeof Request !== "undefined" && args[0] instanceof Request ? args[0].headers : undefined),
          );
          const authorization = headers.get("Authorization") || "";
          if (/^Bearer\s+\S+$/i.test(authorization) && authorization.length <= 8_192) {
            const authorizationChanged = fomoAuthorization !== authorization;
            fomoAuthorization = authorization;
            if (authorizationChanged) window.setTimeout(() => void pollLatestFomoFeed(), 0);
          }
          const supportedChains = headers.get("X-Supported-Chains") || "";
          if (supportedChains.length <= 2_048) fomoSupportedChains = supportedChains;
        }
        if (requestUrl.hostname === "prod-api.fomo.family" && (
          requestUrl.pathname === "/feed/tradingActivity" || requestUrl.pathname === "/feed"
        )) {
          if (response.status === 401 || response.status === 403) void reportAuth(false);
          else if (response.ok) {
            void reportAuth(true);
            response.clone().json().then((payload) => {
              const telemetry = alertPayloadTelemetry(payload);
              markStreamActivity(false, "feed_response");
              void reportStream("connected", 0, true, "feed_response", telemetry);
              enqueue(payload);
            }).catch(() => {});
          }
        }
      } catch (_) {}
      return response;
    };

    window.addEventListener("__fnzsafe_fomo_profile_request", async (event) => {
      const detail = event?.detail || {};
      const requestId = clean(detail.requestId, 100);
      const requestedHandle = clean(detail.handle, 40).replace(/^@+/, "").toLowerCase();
      if (!requestId || !/^[a-z0-9_]{1,40}$/i.test(requestedHandle)) return;
      const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== "function") return;
      let statusCode = 0;
      let profile = null;
      try {
        if (!fomoAuthorization) throw new Error("Fomo authorization is not ready");
        const headers = { Authorization: fomoAuthorization, Accept: "application/json" };
        if (fomoSupportedChains) headers["X-Supported-Chains"] = fomoSupportedChains;
        const response = await nativeFetch(
          `https://prod-api.fomo.family/v2/users/userHandle/${encodeURIComponent(requestedHandle)}`,
          { method: "GET", credentials: "include", headers, signal: AbortSignal.timeout(15_000) },
        );
        statusCode = response.status;
        const payload = await response.json().catch(() => null);
        const user = record(payload?.responseObject);
        if (response.ok && user) {
          const followers = finite(user.followers);
          if (followers !== null) {
            profile = {
              user_handle: clean(user.userHandle, 40),
              display_name: clean(user.displayName, 120) || null,
              profile_picture_url: clean(user.profilePictureLink, 2048) || null,
              followers: Math.floor(followers),
              following: finite(user.following) === null ? null : Math.floor(finite(user.following)),
            };
          }
        }
      } catch (_) {}
      try {
        await invoke("dapp_submit_fomo_profile", {
          payload: {
            request_id: requestId,
            requested_handle: requestedHandle,
            url: window.location.href,
            status_code: statusCode,
            profile,
          },
        });
      } catch (_) {}
    });

    async function pollLatestFomoFeed() {
      if (feedPollInFlight || !navigator.onLine || !fomoAuthorization) return;
      feedPollInFlight = true;
      try {
        const headers = { Authorization: fomoAuthorization, Accept: "application/json" };
        if (fomoSupportedChains) headers["X-Supported-Chains"] = fomoSupportedChains;
        const response = await nativeFetch(
          "https://prod-api.fomo.family/feed/tradingActivity?limit=50",
          { method: "GET", credentials: "include", headers, signal: AbortSignal.timeout(15_000) },
        );
        if (response.status === 401 || response.status === 403) {
          void reportAuth(false);
        } else if (response.ok) {
          void reportAuth(true);
          const payload = await response.json().catch(() => null);
          const telemetry = alertPayloadTelemetry(payload);
          markStreamActivity(false, "feed_poll");
          void reportStream("connected", 0, true, "feed_poll", telemetry);
          enqueue(payload);
        }
      } catch (_) {
        if (!navigator.onLine) void reportStream("offline", 0, true);
      } finally {
        feedPollInFlight = false;
      }
    }

    window.setInterval(() => void pollLatestFomoFeed(), 60_000);
  }

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === "function") {
    class FomoCaptureWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        const isFomoStream = isFomoStreamUrl(url);
        if (isFomoStream) {
          streamSocketObserved = true;
          streamSockets.add(this);
          void reportStream("connecting");
          this.addEventListener("open", () => {
            cancelRecovery();
            lastStreamActivityAt = Date.now();
            void reportStream("connected", 0, true, "socket_open");
          });
          this.addEventListener("close", () => {
            streamSockets.delete(this);
            if (hasOpenStreamSocket()) void reportStream("connected", 0, true);
            else scheduleStreamRecovery(false);
          });
          this.addEventListener("error", () => scheduleStreamRecovery(true));
        }
        this.addEventListener("message", async (event) => {
          try {
            let payload = event.data;
            if (payload instanceof Blob) payload = await payload.text();
            else if (payload instanceof ArrayBuffer) payload = new TextDecoder().decode(payload);
            if (typeof payload !== "string" || payload.length > 2_000_000) return;
            const message = JSON.parse(payload);
            if (message?.type === "data" && message?.topicType === "trading_activity") {
              markStreamActivity(true, "trading_data");
              void reportAuth(true);
              enqueue(message.payload);
            }
          } catch (_) {}
        });
      }
    }
    Object.defineProperty(window, "WebSocket", { value: FomoCaptureWebSocket, configurable: true, writable: true });
  }

  window.addEventListener("offline", () => {
    cancelRecovery();
    void reportStream("offline", 0, true);
  });
  window.addEventListener("online", () => scheduleStreamRecovery(true));
  window.addEventListener("pageshow", () => {
    if (streamSocketObserved && !hasOpenStreamSocket()) scheduleStreamRecovery(false);
  });
  window.setTimeout(() => {
    if (streamSocketObserved && !hasOpenStreamSocket()) scheduleStreamRecovery(false);
  }, 30_000);
  window.setInterval(() => {
    if (!navigator.onLine) {
      void reportStream("offline");
      return;
    }
    if (hasOpenStreamSocket() && lastStreamActivityAt > 0 && Date.now() - lastStreamActivityAt > 180_000) {
      scheduleStreamRecovery(true);
    }
  }, 30_000);
  void reportStream(navigator.onLine ? "connecting" : "offline", 0, true);

  try {
    const observer = new MutationObserver(scheduleAuthUiCheck);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scheduleAuthUiCheck, { once: true });
  [0, 250, 750, 1500, 3000].forEach((delay) => window.setTimeout(scheduleAuthUiCheck, delay));
})();
"#
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
fn open_url_in_chrome(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if !is_allowed_external_https_url(&url) {
        return Err("only https URLs can be opened in Chrome".to_string());
    }
    spawn_google_chrome(&url)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn dapp_open_tab(
    app: DesktopAppHandle,
    state: tauri::State<'_, DappBridgeState>,
    tab_id: String,
    url: String,
    app_id: Option<String>,
    wallet_public_key: Option<String>,
    wallet_family: Option<String>,
    network: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    hidden: Option<bool>,
) -> Result<(), String> {
    ensure_dapp_connections_active(state.inner())?;
    let keep_running_in_background = tab_id.trim() == FOMO_ALERTS_TAB_ID;
    let label = dapp_tab_label(&tab_id)?;
    let url = parse_dapp_browser_url(&url)?;
    let dapp = app_id.as_deref().and_then(allowed_dapp);
    let wallet_family = if wallet_public_key.is_some() || dapp.is_some() {
        validate_dapp_wallet_family(wallet_family.as_deref(), dapp.is_some())?
    } else {
        String::new()
    };
    if let Some(dapp) = dapp.as_ref() {
        if !is_allowed_dapp_url(dapp, &url) {
            return Err("dapp tab URL does not match the selected DApp".to_string());
        }
    }

    let wallet_public_key = match wallet_public_key {
        Some(value) => {
            let trimmed = value.trim().to_string();
            let valid = if wallet_family == "evm" {
                is_likely_evm_address(&trimmed)
            } else {
                is_likely_solana_pubkey(&trimmed)
            };
            if !valid {
                return Err(format!("invalid {wallet_family} wallet address"));
            }
            Some(trimmed)
        }
        None if wallet_family.is_empty() => None,
        None => return Err("wallet address is required for connected DApp tabs".to_string()),
    };
    let network = validate_dapp_network(&network)?;
    if wallet_family == "evm"
        && network
            .strip_prefix("eip155:")
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .is_none()
    {
        return Err("invalid EVM dapp network".to_string());
    }
    let app_id = dapp
        .as_ref()
        .map(|value| value.id.to_string())
        .unwrap_or_else(|| format!("web:{}", url.host_str().unwrap_or("dapp")));
    let app_name = dapp
        .as_ref()
        .map(|value| value.name.to_string())
        .unwrap_or_else(|| url.host_str().unwrap_or("DApp").to_string());

    let main_window = app
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let bounds = dapp_webview_bounds(x, y, width, height)?;
    let tab_id_for_nav = tab_id.trim().to_string();
    let tab_id_for_title = tab_id_for_nav.clone();
    let tab_id_for_new_window = tab_id_for_nav.clone();
    let dapp_for_nav = dapp.clone();
    let allow_any_safe_navigation = dapp.is_none() && !wallet_family.is_empty();
    let app_for_nav = app.clone();
    let label_for_nav = label.clone();
    let app_for_title = app.clone();
    let app_for_new_window = app.clone();
    let app_for_download = app.clone();
    let tab_id_for_download = tab_id_for_nav.clone();
    let label_for_page_load = label.clone();
    let data_directory = dapp_browser_data_directory(&app)?;
    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url.clone()))
        .data_directory(data_directory)
        .on_navigation(move |target_url| {
            if open_telegram_target(target_url) {
                return false;
            }
            let allowed = match dapp_for_nav.as_ref() {
                Some(dapp) => is_allowed_connected_dapp_navigation_url(dapp, target_url),
                None if allow_any_safe_navigation => {
                    is_safe_dapp_webview_navigation_url(target_url)
                }
                None => false,
            };
            if is_safe_browser_url(target_url) {
                if allowed {
                    let state = app_for_nav.state::<DappBridgeState>();
                    if let Ok(mut sessions) = state.sessions.lock() {
                        if let Some(session) = sessions.get_mut(&label_for_nav) {
                            update_dapp_session_navigation(session, target_url);
                        }
                    };
                }
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
                let state = app.state::<DappBridgeState>();
                if let Ok(mut sessions) = state.sessions.lock() {
                    if let Some(session) = sessions.get_mut(&label_for_page_load) {
                        update_dapp_session_navigation(session, payload.url());
                    }
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
            if open_telegram_target(&target_url) {
                return tauri::webview::NewWindowResponse::Deny;
            }
            if tab_id_for_new_window == FOMO_ALERTS_TAB_ID && is_fomo_auth_popup_url(&target_url) {
                return tauri::webview::NewWindowResponse::Allow;
            }
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
        })
        .on_download(move |_webview, event| {
            match event {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    let _ = app_for_download.emit_to(
                        "main",
                        DAPP_DOWNLOAD_EVENT,
                        DappDownloadEvent {
                            tab_id: tab_id_for_download.clone(),
                            url: url.to_string(),
                            path: destination.to_string_lossy().to_string(),
                            status: "started",
                        },
                    );
                }
                tauri::webview::DownloadEvent::Finished { url, path, success } => {
                    let _ = app_for_download.emit_to(
                        "main",
                        DAPP_DOWNLOAD_EVENT,
                        DappDownloadEvent {
                            tab_id: tab_id_for_download.clone(),
                            url: url.to_string(),
                            path: path
                                .as_deref()
                                .map(|value| value.to_string_lossy().to_string())
                                .unwrap_or_default(),
                            status: if success { "completed" } else { "failed" },
                        },
                    );
                }
                _ => {}
            }
            true
        });

    builder = builder.initialization_script(fomo_alert_capture_script());
    if let Some(wallet_public_key) = wallet_public_key.as_ref() {
        let init_script = if wallet_family == "evm" {
            evm_dapp_provider_script(wallet_public_key, &network)?
        } else {
            solana_dapp_provider_script(&app_id, &app_name, wallet_public_key, &network)?
        };
        builder = builder.initialization_script(&init_script);
    }

    let _visibility = state
        .webview_visibility
        .lock()
        .map_err(|_| "dapp webview visibility lock poisoned".to_string())?;
    ensure_dapp_connections_active(state.inner())?;
    if let Some(existing) = app.get_webview(&label) {
        existing
            .close()
            .map_err(|error| format!("failed to replace dapp tab: {error}"))?;
    }
    let session_registered = wallet_public_key.is_some();
    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "dapp session lock poisoned".to_string())?;
        sessions.remove(&label);
        if let Some(wallet_public_key) = wallet_public_key.clone() {
            // Initialization scripts can call the bridge while add_child is still
            // loading the first document, so the session must exist beforehand.
            sessions.insert(
                label.clone(),
                DappSession {
                    app_id: app_id.clone(),
                    app_name: app_name.clone(),
                    url: url.as_str().to_string(),
                    wallet_family: wallet_family.clone(),
                    wallet_public_key,
                    network: network.clone(),
                    opened_at_ms: now_ms(),
                },
            );
            log::info!(
                "registered dapp session for {label}: family={wallet_family}, network={network}"
            );
        }
    }

    let open_result = (|| -> Result<(), String> {
        ensure_dapp_connections_active(state.inner())?;
        let webview = main_window
            .add_child(builder, bounds.position, bounds.size)
            .map_err(|error| format!("failed to open dapp tab: {error}"))?;
        webview
            .set_bounds(bounds)
            .map_err(|error| format!("failed to position dapp tab: {error}"))?;
        if hidden.unwrap_or(false) && !keep_running_in_background {
            webview
                .hide()
                .map_err(|error| format!("failed to hide dapp tab: {error}"))?;
        } else {
            webview
                .show()
                .map_err(|error| format!("failed to show dapp tab: {error}"))?;
            raise_embedded_webview(&webview)?;
        }
        Ok(())
    })();
    if let Err(error) = open_result {
        if session_registered {
            state
                .sessions
                .lock()
                .map_err(|_| "dapp session lock poisoned during open rollback".to_string())?
                .remove(&label);
        }
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
async fn dapp_navigate_tab(
    app: DesktopAppHandle,
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
        if session.wallet_family == "solana" {
            if allowed_dapp(&session.app_id)
                .as_ref()
                .is_some_and(|dapp| !is_allowed_dapp_url(dapp, &url))
            {
                return Err(
                    "connected Solana DApp tabs can only navigate inside their DApp domain"
                        .to_string(),
                );
            }
        }
    }
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "dapp tab is not open".to_string())?;
    let _visibility = state
        .webview_visibility
        .lock()
        .map_err(|_| "dapp webview visibility lock poisoned".to_string())?;
    ensure_dapp_connections_active(state.inner())?;
    webview
        .navigate(url)
        .map_err(|error| format!("failed to navigate dapp tab: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn dapp_reload_tab(
    app: DesktopAppHandle,
    state: tauri::State<'_, DappBridgeState>,
    tab_id: String,
) -> Result<(), String> {
    let label = dapp_tab_label(&tab_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "dapp tab is not open".to_string())?;
    let _visibility = state
        .webview_visibility
        .lock()
        .map_err(|_| "dapp webview visibility lock poisoned".to_string())?;
    ensure_dapp_connections_active(state.inner())?;
    webview
        .reload()
        .map_err(|error| format!("failed to reload dapp tab: {error}"))?;
    Ok(())
}

fn raise_embedded_webview(webview: &DesktopWebview) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2_app_kit::{NSView, NSWindowOrderingMode};
        use tauri_runtime_cef::cef::{ImplBrowser, ImplBrowserHost};

        webview
            .with_webview(move |platform_webview| {
                let browser = platform_webview.browser();
                let Some(host) = browser.host() else {
                    return;
                };
                let handle = host.window_handle();
                let Some(view) = (unsafe { Retained::<NSView>::retain(handle.cast()) }) else {
                    return;
                };
                let Some(parent) = (unsafe { view.superview() }) else {
                    return;
                };
                parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Above, None);
            })
            .map_err(|error| format!("failed to raise dapp tab: {error}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        use tauri_runtime_cef::cef::{ImplBrowser, ImplBrowserHost};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };

        webview
            .with_webview(|platform_webview| {
                let browser = platform_webview.browser();
                let Some(host) = browser.host() else {
                    return;
                };
                let hwnd = host.window_handle();
                unsafe {
                    let _ = SetWindowPos(
                        hwnd.0.cast(),
                        HWND_TOP,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            })
            .map_err(|error| format!("failed to raise dapp tab: {error}"))?;
    }

    Ok(())
}

#[tauri::command]
async fn dapp_set_active_tab(
    app: DesktopAppHandle,
    state: tauri::State<'_, DappBridgeState>,
    tab_id: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let _visibility = state
        .webview_visibility
        .lock()
        .map_err(|_| "dapp webview visibility lock poisoned".to_string())?;
    ensure_dapp_connections_active(state.inner())?;
    let active_label = tab_id.as_deref().map(dapp_tab_label).transpose()?;
    let fomo_background_label = dapp_tab_label(FOMO_ALERTS_TAB_ID)?;
    let fomo_background_bounds = dapp_webview_bounds(-20_000.0, -20_000.0, 1_280.0, 900.0)?;
    let bounds = if active_label.is_some() {
        Some(dapp_webview_bounds(x, y, width, height)?)
    } else {
        None
    };
    let mut active_tab_label = state
        .active_tab_label
        .lock()
        .map_err(|_| "active dapp tab lock poisoned".to_string())?;
    let previous_active_label = active_tab_label.clone();
    *active_tab_label = active_label.clone();
    let result = (|| {
        let mut active_webview = None;
        for (label, webview) in app.webviews() {
            if !label.starts_with(DAPP_TAB_LABEL_PREFIX) {
                continue;
            }
            if active_label.as_deref() == Some(label.as_str()) {
                active_webview = Some(webview);
            } else if label == fomo_background_label {
                let _ = webview.set_bounds(fomo_background_bounds);
                let _ = webview.show();
            } else {
                let _ = webview.hide();
            }
        }

        if let Some(webview) = active_webview {
            webview
                .show()
                .map_err(|error| format!("failed to show dapp tab: {error}"))?;
            if let Some(bounds) = bounds {
                webview
                    .set_bounds(bounds)
                    .map_err(|error| format!("failed to position dapp tab: {error}"))?;
            }
            raise_embedded_webview(&webview)?;
        }
        Ok(())
    })();
    if result.is_err() {
        *active_tab_label = previous_active_label;
    }
    result
}

#[tauri::command]
async fn dapp_close_tab(
    app: DesktopAppHandle,
    state: tauri::State<'_, DappBridgeState>,
    tab_id: String,
) -> Result<(), String> {
    let label = dapp_tab_label(&tab_id)?;
    let _visibility = state
        .webview_visibility
        .lock()
        .map_err(|_| "dapp webview visibility lock poisoned".to_string())?;
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
#[allow(clippy::too_many_arguments)] // Tauri maps these named parameters directly from the browser IPC request.
async fn dapp_request_tab_text(
    app: DesktopAppHandle,
    state: tauri::State<'_, DappBridgeState>,
    tab_id: String,
    request_id: String,
    advance: Option<bool>,
    background: Option<bool>,
    latest_only: Option<bool>,
    resume_backfill: Option<bool>,
) -> Result<(), String> {
    let latest_only = latest_only.unwrap_or(false);
    let resume_backfill = resume_backfill.unwrap_or(false);
    if request_id.is_empty()
        || request_id.len() > 100
        || !request_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err("invalid page text request id".to_string());
    }
    let label = dapp_tab_label(&tab_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "dapp tab is not open".to_string())?;
    let run_in_background = background.unwrap_or(false);
    let original_bounds = run_in_background.then(|| webview.bounds().ok()).flatten();
    {
        let _visibility = state
            .webview_visibility
            .lock()
            .map_err(|_| "dapp webview visibility lock poisoned".to_string())?;
        ensure_dapp_connections_active(state.inner())?;
        if run_in_background {
            let staging_bounds = Rect {
                position: Position::Logical(LogicalPosition::new(-20_000.0, -20_000.0)),
                size: Size::Logical(LogicalSize::new(1_280.0, 900.0)),
            };
            webview
                .set_bounds(staging_bounds)
                .map_err(|error| format!("failed to stage background dapp page scan: {error}"))?;
            if let Err(error) = webview.show() {
                if let Some(bounds) = original_bounds {
                    let _ = webview.set_bounds(bounds);
                }
                return Err(format!("failed to show background dapp page scan: {error}"));
            }
        }
    }
    if run_in_background {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let scan_result = async {
    let should_advance = advance.unwrap_or(false);
    let advance = if should_advance { "true" } else { "false" };
    let manage_twitter_home = tab_id.trim() == TWITTER_CAPTURE_TAB_ID;
    let request_id_json = serde_json::to_string(&request_id)
        .map_err(|error| format!("failed to encode page text request id: {error}"))?;
    let initialize_script = format!(
        r#"
(function () {{
  try {{
    const requestId = {request_id_json};
    const isTwitter = /(^|\.)((x)|(twitter))\.com$/i.test(window.location.hostname);
    const clean = (value, limit) => String(value || "").trim().slice(0, limit);
    const detectTwitterAuth = () => {{
      if (!isTwitter) return null;
      const path = window.location.pathname.toLowerCase();
      if (path === "/login" || path.startsWith("/i/flow/login")) return false;
      if (document.querySelector("[data-testid='SideNav_AccountSwitcher_Button']")) return true;
      if (document.querySelector("a[data-testid='AppTabBar_Home_Link']") && document.querySelector("a[href='/compose/post'], [data-testid='SideNav_NewTweet_Button']")) return true;
      if (document.querySelector("a[href='/login'], [data-testid='loginButton']")) return false;
      return null;
    }};
    const absoluteTwitterStatusUrl = (href) => {{
      try {{
        const url = new URL(href, window.location.origin);
        if (!/(^|\.)((x)|(twitter))\.com$/i.test(url.hostname)) return "";
        const match = url.pathname.match(/^\/([A-Za-z0-9_]{{1,15}})\/status\/(\d+)/);
        return match ? `${{url.origin}}/${{match[1]}}/status/${{match[2]}}` : "";
      }} catch (_) {{
        return "";
      }}
    }};
    const serializeTweetText = (root) => {{
      const links = [];
      const readNode = (current) => {{
        if (current.nodeType === Node.TEXT_NODE) return current.nodeValue || "";
        if (!(current instanceof HTMLElement)) return "";
        if (current.getAttribute("aria-hidden") === "true") return "";
        if (current.tagName === "BR") return "\n";
        if (current.tagName === "IMG") return current.getAttribute("alt") || "";

        const childText = Array.from(current.childNodes).map(readNode).join("");
        if (current.tagName !== "A") return childText;
        const display = childText.trim();
        if (!display || /^[@#$]/.test(display)) return childText;
        const candidates = [
          current.getAttribute("data-expanded-url"),
          current.getAttribute("title"),
          current.getAttribute("href"),
        ];
        for (const candidate of candidates) {{
          if (!candidate) continue;
          if (!/^(?:https?:\/\/|www\.|[A-Za-z0-9-]+\.[A-Za-z]{{2,}}(?:\/|$))/i.test(candidate)) continue;
          try {{
            const target = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${{candidate}}`);
            if (/^https?:$/.test(target.protocol)) {{
              const displayUrl = display
                .replace(/\s+/g, "")
                .replace(/(?:\u2026|\.{{3}})$/u, "");
              if (/^(?:https?:\/\/|www\.|[A-Za-z0-9-]+\.[A-Za-z]{{2,}}(?:\/|$))/i.test(displayUrl)) {{
                links.push({{ target: target.href, display: displayUrl }});
              }}
              return target.href;
            }}
          }} catch (_) {{}}
        }}
        return childText;
      }};
      const text = readNode(root)
        .replace(/\u00a0/g, " ")
        .replace(/[\u200b-\u200d\ufeff]/gi, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{{3,}}/g, "\n\n")
        .trim();
      return {{ text, links }};
    }};

    const collectProfile = () => {{
      if (!isTwitter) return null;
      const pathMatch = window.location.pathname.match(/^\/([A-Za-z0-9_]{{1,15}})\/?$/);
      if (!pathMatch) return null;
      const handle = pathMatch[1].toLowerCase();
      const reserved = new Set(["home", "explore", "search", "notifications", "messages", "settings", "compose", "i"]);
      if (reserved.has(handle)) return null;
      const root = document.querySelector("main [data-testid='primaryColumn']") || document.querySelector("main") || document.body;
      const userName = root.querySelector("[data-testid='UserName']");
      if (!userName) return null;
      const nameLines = clean(userName.innerText || userName.textContent, 160)
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const displayName = nameLines.find((line) => !line.startsWith("@")) || "";
      const profileLinks = Array.from(root.querySelectorAll("a[href]"));
      const linkForPath = (suffixes) => profileLinks.find((link) => {{
        try {{
          const path = new URL(link.getAttribute("href") || "", window.location.origin).pathname.replace(/\/$/, "").toLowerCase();
          return suffixes.some((suffix) => path === `/${{handle}}/${{suffix}}`);
        }} catch (_) {{
          return false;
        }}
      }});
      const followersLink = linkForPath(["followers", "verified_followers"]);
      const followingLink = linkForPath(["following"]);
      const avatar = root.querySelector(`a[href='/${{handle}}/photo'] img[src]`) ||
        root.querySelector("[data-testid^='UserAvatar-Container-'] img[src]");
      const websiteNode = root.querySelector("[data-testid='UserUrl'] a[href]") || root.querySelector("[data-testid='UserUrl']");
      return {{
        handle,
        display_name: clean(displayName, 80),
        avatar_url: clean(avatar?.currentSrc || avatar?.getAttribute("src"), 2048) || null,
        bio: clean(root.querySelector("[data-testid='UserDescription']")?.innerText, 400) || null,
        followers_label: clean(followersLink?.innerText || followersLink?.textContent, 80) || null,
        following_label: clean(followingLink?.innerText || followingLink?.textContent, 80) || null,
        location: clean(root.querySelector("[data-testid='UserLocation']")?.innerText, 120) || null,
        website: clean(websiteNode?.innerText || websiteNode?.textContent, 512) || null,
        joined_label: clean(root.querySelector("[data-testid='UserJoinDate']")?.innerText, 120) || null,
        verified: Boolean(userName.querySelector("[data-testid='icon-verified'], svg[aria-label*='Verified'], svg[aria-label*='认证']")),
        followed_by_viewer: Boolean(root.querySelector("button[data-testid$='-unfollow'], [role='button'][data-testid$='-unfollow']")),
      }};
    }};

    const cutoffMs = Date.now() - (3 * 24 * 60 * 60 * 1000);
    const scan = {{ requestId, isTwitter, manageTwitterHome: {manage_twitter_home}, latestOnly: {latest_only}, cutoffMs, oldTweetKeys: new Set(), reachedCutoff: false, reachedEnd: false, stalledEndPasses: 0, lastProgressKey: "", collectedTweets: new Map(), avatarByHandle: new Map(), latestNodes: [], profile: collectProfile(), detectTwitterAuth }};
    const prepareTwitterHomeTimeline = () => {{
      if (!scan.isTwitter || !scan.manageTwitterHome || window.location.pathname.toLowerCase() !== "/home") return false;
      const primary = document.querySelector("main [data-testid='primaryColumn']") || document.querySelector("main");
      if (!primary) return false;
      const tabList = primary.querySelector("[role='tablist']");
      const tabs = tabList ? Array.from(tabList.querySelectorAll("[role='tab']")) : [];
      const followingLabels = new Set(["following", "正在关注", "关注", "フォロー中", "팔로우 중"]);
      const followingTab = tabs.find((tab) => followingLabels.has(clean(tab.innerText || tab.textContent, 80).toLowerCase())) ||
        (tabs.length === 2 ? tabs[1] : null);
      if (followingTab instanceof HTMLElement && followingTab.getAttribute("aria-selected") !== "true") {{
        followingTab.click();
        window.scrollTo({{ top: 0, left: 0, behavior: "auto" }});
        return true;
      }}

      const newPostsPattern = /^(?:(?:show|see|view|load)(?:\s+\d+)?\s+(?:new\s+)?posts?|(?:显示|查看|加载)(?:\s*\d+\s*条?)?\s*(?:新)?(?:推文|帖子))$/iu;
      const controls = Array.from(primary.querySelectorAll("button, [role='button']"));
      const newPostsControl = controls.find((control) => {{
        const label = clean(control.getAttribute("aria-label") || control.innerText || control.textContent, 80)
          .replace(/\s+/gu, " ")
          .trim();
        if (!newPostsPattern.test(label)) return false;
        const bounds = control.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      }});
      if (newPostsControl instanceof HTMLElement) {{
        newPostsControl.click();
        window.scrollTo({{ top: 0, left: 0, behavior: "auto" }});
        return true;
      }}
      return false;
    }};
    const expandTweetTexts = () => {{
      if (!isTwitter) return;
      const tweetNodes = Array.from(document.querySelectorAll("article[data-testid='tweet'], [data-testid='tweet']"));
      for (const node of tweetNodes) {{
        const control = node.querySelector("[data-testid='tweet-text-show-more-link']");
        if (!(control instanceof HTMLElement)) continue;
        if (control.closest("a[href]") || (control.tagName !== "BUTTON" && control.getAttribute("role") !== "button")) continue;
        const bounds = control.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) control.click();
      }}
    }};
    const collectTweets = () => {{
      const tweetNodes = isTwitter
        ? Array.from(document.querySelectorAll("article[data-testid='tweet'], [data-testid='tweet']"))
        : [];
      for (const node of tweetNodes) {{
        if (scan.collectedTweets.size >= 1000) break;
        const time = node.querySelector("time[datetime]");
        const publishedAt = clean(time?.getAttribute("datetime"), 64);
        const publishedAtMs = Date.parse(publishedAt);
        if (Number.isFinite(publishedAtMs) && publishedAtMs < scan.cutoffMs) {{
          scan.oldTweetKeys.add(`${{publishedAt}}:${{clean(node.innerText || node.textContent, 160)}}`);
          if (scan.oldTweetKeys.size >= 3) scan.reachedCutoff = true;
          continue;
        }}
        const statusAnchors = Array.from(node.querySelectorAll("a[href*='/status/']"));
        const statusAnchor = time?.closest("a[href*='/status/']") ||
          statusAnchors.find((anchor) => absoluteTwitterStatusUrl(anchor.getAttribute("href") || ""));
        const sourceUrl = absoluteTwitterStatusUrl(statusAnchor?.getAttribute("href") || "");
        const statusMatch = sourceUrl.match(/^https?:\/\/[^/]+\/([A-Za-z0-9_]{{1,15}})\/status\/(\d+)/i);
        const authorHandle = clean(statusMatch?.[1], 15).toLowerCase();
        const textNode = node.querySelector("[data-testid='tweetText']");
        const serialized = textNode ? serializeTweetText(textNode) : null;
        const text = clean(
          serialized
            ? serialized.text
            : node.innerText || node.textContent || "",
          4000,
        );
        if (!text) continue;
        const userName = node.querySelector("[data-testid='User-Name']");
        const author = clean(userName?.innerText || userName?.textContent || "", 160);
        const authorName = clean(
          author.split(/\n+/).find((line) => line.trim() && !line.trim().startsWith("@") && line.trim() !== "·") || "",
          80,
        );
        const avatar = node.querySelector("[data-testid='Tweet-User-Avatar'] img[src]") ||
          node.querySelector("img[src*='pbs.twimg.com/profile_images/']");
        const avatarUrl = clean(avatar?.currentSrc || avatar?.getAttribute("src"), 2048);
        if (authorHandle && avatarUrl) scan.avatarByHandle.set(authorHandle, avatarUrl);
        const tweet = {{
          tweet_id: clean(statusMatch?.[2], 32),
          author,
          author_name: authorName,
          author_handle: authorHandle,
          avatar_url: avatarUrl || scan.avatarByHandle.get(authorHandle) || null,
          text,
          links: serialized?.links || [],
          source_url: sourceUrl || null,
          published_at: publishedAt || null,
        }};
        const key = tweet.source_url || tweet.tweet_id || `${{tweet.author_handle}}:${{tweet.text}}`;
        const previous = scan.collectedTweets.get(key);
        if (!previous || tweet.text.length > previous.text.length) scan.collectedTweets.set(key, tweet);
      }}
      scan.latestNodes = tweetNodes;
      const root = document.documentElement;
      const atBottom = window.scrollY + Math.max(window.innerHeight || 0, 600) >= root.scrollHeight - 8;
      const progressKey = `${{scan.collectedTweets.size}}:${{root.scrollHeight}}`;
      scan.stalledEndPasses = atBottom && progressKey === scan.lastProgressKey
        ? scan.stalledEndPasses + 1
        : 0;
      scan.lastProgressKey = progressKey;
      if (scan.stalledEndPasses >= 5) scan.reachedEnd = true;
    }};
    scan.expandTweetTexts = expandTweetTexts;
    scan.collectTweets = collectTweets;
    scan.collectProfile = collectProfile;
    scan.prepareTwitterHomeTimeline = prepareTwitterHomeTimeline;
    window.__FNZERO_TWEET_SCAN__ = scan;
    if ({advance} && isTwitter && !{resume_backfill}) window.scrollTo({{ top: 0, left: 0, behavior: "auto" }});
    if ({advance}) prepareTwitterHomeTimeline();
    if (!{advance}) {{
      expandTweetTexts();
      collectTweets();
    }}
  }} catch (_) {{}}
}})();
"#,
    );
    webview
        .eval(&initialize_script)
        .map_err(|error| format!("failed to initialize dapp page scan: {error}"))?;
    tokio::time::sleep(Duration::from_millis(if manage_twitter_home {
        900
    } else {
        300
    }))
    .await;

    if should_advance {
        // Hidden Chromium pages throttle JavaScript timers. Pace the traversal
        // from Rust so scanning remains bounded while the monitor tab is shown.
        let total_passes = if latest_only { 8 } else { 45 };
        for pass in 1..total_passes {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let should_scroll = if pass < total_passes - 1 {
                "true"
            } else {
                "false"
            };
            let step_script = format!(
                r#"
(function () {{
  try {{
    const scan = window.__FNZERO_TWEET_SCAN__;
    if (!scan || scan.requestId !== {request_id_json}) return;
    if (scan.prepareTwitterHomeTimeline()) {{
      scan.collectedTweets.clear();
      scan.oldTweetKeys.clear();
      scan.reachedCutoff = false;
      scan.reachedEnd = false;
      return;
    }}
    scan.expandTweetTexts();
    scan.collectTweets();
    if ({should_scroll} && scan.isTwitter && !scan.reachedCutoff && scan.collectedTweets.size < 1000) {{
      const viewport = Math.max(window.innerHeight || 0, 600);
      window.scrollBy({{ top: Math.floor(viewport * 1.8), left: 0, behavior: "auto" }});
    }}
  }} catch (_) {{}}
}})();
"#,
            );
            webview
                .eval(&step_script)
                .map_err(|error| format!("failed to advance dapp page scan: {error}"))?;
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    let submit_script = format!(
        r#"
(async function () {{
  try {{
    const scan = window.__FNZERO_TWEET_SCAN__;
    if (!scan || scan.requestId !== {request_id_json}) return;
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") return;
    const clean = (value, limit) => String(value || "").trim().slice(0, limit);
    scan.collectTweets();
    scan.profile = scan.collectProfile();
    const capturedAtMs = Date.now();
    const tweets = Array.from(scan.collectedTweets.values())
      .filter((tweet) => {{
        const publishedAtMs = Date.parse(tweet.published_at || "");
        return Number.isFinite(publishedAtMs) && publishedAtMs >= scan.cutoffMs && publishedAtMs <= capturedAtMs;
      }})
      .sort((left, right) => Date.parse(right.published_at || 0) - Date.parse(left.published_at || 0))
      .map((tweet) => tweet.avatar_url || !tweet.author_handle
        ? tweet
        : {{ ...tweet, avatar_url: scan.avatarByHandle.get(tweet.author_handle) || null }})
      .slice(0, 1000);
    const readableNodes = tweets.length > 0 || scan.isTwitter
      ? []
      : scan.latestNodes.length > 0
        ? scan.latestNodes
        : Array.from(document.querySelectorAll("main, body")).slice(0, 1);
    const text = tweets.length > 0
      ? tweets.map((tweet) => tweet.text).join("\n\n").slice(0, 250000)
      : readableNodes
        .map((node) => clean(node.innerText || node.textContent || "", 250000))
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 250000);
    await invoke("dapp_submit_page_text", {{ payload: {{
      requestId: scan.requestId,
      text,
      tweets,
      profile: scan.profile,
      authenticated: scan.detectTwitterAuth(),
      backfillComplete: Boolean(scan.latestOnly || scan.reachedCutoff || scan.reachedEnd || scan.collectedTweets.size >= 1000),
      url: window.location.href,
    }} }});
    if (window.__FNZERO_TWEET_SCAN__?.requestId === scan.requestId) {{
      delete window.__FNZERO_TWEET_SCAN__;
    }}
  }} catch (_) {{}}
}})();
"#,
    );
    webview
        .eval(&submit_script)
        .map_err(|error| format!("failed to submit dapp page scan: {error}"))?;
        Ok::<(), String>(())
    }
    .await;

    if run_in_background {
        let _visibility = state
            .webview_visibility
            .lock()
            .map_err(|_| "dapp webview visibility lock poisoned".to_string())?;
        let active_tab_label = state
            .active_tab_label
            .lock()
            .map_err(|_| "active dapp tab lock poisoned".to_string())?;
        let became_active = active_tab_label.as_deref() == Some(label.as_str());
        if !became_active {
            let _ = webview.hide();
        }
        if let Some(bounds) = original_bounds {
            let _ = webview.set_bounds(bounds);
        }
    }
    scan_result
}

fn normalize_twitter_status_url(value: &str) -> Option<String> {
    if value.len() > 2_048 {
        return None;
    }
    let mut parsed = tauri::Url::parse(value.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let is_twitter = host == "x.com"
        || host.ends_with(".x.com")
        || host == "twitter.com"
        || host.ends_with(".twitter.com");
    let segments = parsed.path_segments()?.collect::<Vec<_>>();
    let has_status_id = segments.windows(2).any(|pair| {
        pair[0].eq_ignore_ascii_case("status")
            && !pair[1].is_empty()
            && pair[1].chars().all(|character| character.is_ascii_digit())
    });
    if !is_twitter || !has_status_id {
        return None;
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.to_string())
}

#[tauri::command]
fn dapp_submit_page_text(
    webview: DesktopWebview,
    app: DesktopAppHandle,
    payload: DappSubmitPageTextRequest,
) -> Result<(), String> {
    let DappSubmitPageTextRequest {
        request_id,
        text,
        tweets,
        profile,
        authenticated,
        backfill_complete,
        url,
    } = payload;
    if request_id.is_empty()
        || request_id.len() > 100
        || !request_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err("invalid page text request id".to_string());
    }
    let webview_label = webview.label().to_string();
    let tab_id = dapp_tab_id_from_label(&webview_label)
        .ok_or_else(|| "page text can only be submitted from dapp tabs".to_string())?;
    let parsed_url = parse_dapp_browser_url(&url)?;
    if !is_safe_browser_url(&parsed_url) {
        return Err("unsafe dapp page URL".to_string());
    }
    let clipped_text = text.chars().take(250_000).collect::<String>();
    let clipped_tweets = tweets
        .unwrap_or_default()
        .into_iter()
        .take(1_000)
        .filter_map(|tweet| {
            let text = tweet.text.trim().chars().take(4_000).collect::<String>();
            if text.is_empty() {
                return None;
            }
            let author_handle = tweet
                .author_handle
                .trim()
                .trim_start_matches('@')
                .chars()
                .take(15)
                .collect::<String>()
                .to_ascii_lowercase();
            let author_handle = if author_handle
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || value == '_')
            {
                author_handle
            } else {
                String::new()
            };
            let source_url = tweet
                .source_url
                .and_then(|value| normalize_twitter_status_url(&value));
            let avatar_url = tweet.avatar_url.and_then(|value| {
                let parsed = tauri::Url::parse(value.trim()).ok()?;
                let host = parsed.host_str()?.to_ascii_lowercase();
                let is_x_image = parsed.scheme() == "https"
                    && (host == "pbs.twimg.com" || host.ends_with(".pbs.twimg.com"));
                (is_x_image && parsed.as_str().len() <= 2_048).then(|| parsed.to_string())
            });
            let links = tweet
                .links
                .into_iter()
                .take(32)
                .filter_map(|link| {
                    let parsed = tauri::Url::parse(link.target.trim()).ok()?;
                    if !matches!(parsed.scheme(), "http" | "https") || parsed.as_str().len() > 2_048
                    {
                        return None;
                    }
                    let display = link.display.trim().chars().take(512).collect::<String>();
                    (!display.is_empty()).then(|| DappCapturedTweetLink {
                        target: parsed.to_string(),
                        display,
                    })
                })
                .collect();
            Some(DappCapturedTweet {
                tweet_id: tweet
                    .tweet_id
                    .trim()
                    .chars()
                    .filter(char::is_ascii_digit)
                    .take(32)
                    .collect(),
                author: tweet.author.trim().chars().take(160).collect(),
                author_name: tweet.author_name.trim().chars().take(80).collect(),
                author_handle,
                avatar_url,
                text,
                source_url,
                published_at: tweet
                    .published_at
                    .map(|value| value.trim().chars().take(64).collect())
                    .filter(|value: &String| !value.is_empty()),
                links,
            })
        })
        .collect::<Vec<_>>();
    let clipped_profile = profile.and_then(|profile| {
        let handle = profile
            .handle
            .trim()
            .trim_start_matches('@')
            .chars()
            .take(15)
            .collect::<String>()
            .to_ascii_lowercase();
        if handle.is_empty()
            || !handle
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || value == '_')
        {
            return None;
        }
        let avatar_url = profile.avatar_url.and_then(|value| {
            let parsed = tauri::Url::parse(value.trim()).ok()?;
            let host = parsed.host_str()?.to_ascii_lowercase();
            let is_x_image = parsed.scheme() == "https"
                && (host == "pbs.twimg.com" || host.ends_with(".pbs.twimg.com"));
            (is_x_image && parsed.as_str().len() <= 2_048).then(|| parsed.to_string())
        });
        let optional_text = |value: Option<String>, limit: usize| {
            value
                .map(|item| item.trim().chars().take(limit).collect::<String>())
                .filter(|item| !item.is_empty())
        };
        Some(DappCapturedTwitterProfile {
            handle,
            display_name: profile.display_name.trim().chars().take(80).collect(),
            avatar_url,
            bio: optional_text(profile.bio, 400),
            followers_label: optional_text(profile.followers_label, 80),
            following_label: optional_text(profile.following_label, 80),
            location: optional_text(profile.location, 120),
            website: optional_text(profile.website, 512),
            joined_label: optional_text(profile.joined_label, 120),
            verified: profile.verified,
            followed_by_viewer: profile.followed_by_viewer,
        })
    });
    app.emit_to(
        "main",
        DAPP_TAB_TEXT_EVENT,
        DappTabTextEvent {
            tab_id,
            request_id,
            url: parsed_url.as_str().to_string(),
            text: clipped_text,
            tweets: clipped_tweets,
            profile: clipped_profile,
            authenticated,
            backfill_complete,
            captured_at_ms: now_ms(),
        },
    )
    .map_err(|error| format!("failed to emit dapp page text: {error}"))?;
    Ok(())
}

fn fomo_network(network_id: &str) -> Option<(&'static str, &'static str, bool)> {
    match network_id.trim().to_ascii_lowercase().as_str() {
        "1399811149" | "solana" => Some(("Solana", "solana", true)),
        "1" | "ethereum" => Some(("Ethereum", "ethereum", false)),
        "56" | "bnb" => Some(("BSC", "bnb", false)),
        "8453" | "base" => Some(("Base", "base", false)),
        "10143" | "monad" => Some(("Monad", "monad", false)),
        "4663" | "robinhood" => Some(("Robinhood", "robinhood", false)),
        "1337" | "hyperliquid" => Some(("HyperEVM", "hyperliquid", false)),
        _ => None,
    }
}

fn is_likely_evm_token_address(value: &str) -> bool {
    value.len() == 42
        && value.starts_with("0x")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validated_fomo_optional_text(
    value: Option<String>,
    limit: usize,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().chars().take(limit + 1).collect::<String>();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > limit
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err("invalid Fomo alert text field".to_string());
    }
    Ok(Some(value))
}

fn is_fomo_https_url(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    url.scheme() == "https" && (host == "fomo.family" || host.ends_with(".fomo.family"))
}

fn normalized_fomo_handle(value: &str) -> Option<String> {
    let handle = value.trim().trim_start_matches('@').to_ascii_lowercase();
    (!handle.is_empty()
        && handle.len() <= 40
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'))
    .then_some(handle)
}

fn validated_fomo_alert(input: DappCapturedFomoAlert) -> Result<DappFomoAlertEventItem, String> {
    let id = input.id.trim().to_string();
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err("invalid Fomo alert ID".to_string());
    }
    let event_type = input.event_type.trim().to_ascii_lowercase();
    if !matches!(
        event_type.as_str(),
        "swap_buy"
            | "swap_sell"
            | "transfer_in"
            | "transfer_out"
            | "multi_user_buy"
            | "multi_user_sell"
            | "thesis_created"
    ) {
        return Err("unsupported Fomo alert type".to_string());
    }
    let (chain, network_slug, is_solana) = fomo_network(&input.network_id)
        .ok_or_else(|| "unsupported Fomo alert network".to_string())?;
    let token_address = input.token_address.trim().to_string();
    let valid_token_address = if is_solana {
        is_likely_solana_pubkey(&token_address)
    } else {
        is_likely_evm_token_address(&token_address)
    };
    if !valid_token_address {
        return Err("invalid Fomo alert token address".to_string());
    }
    let validate_amount = |value: Option<f64>| {
        value
            .map(|amount| {
                (amount.is_finite() && (0.0..=1.0e18).contains(&amount))
                    .then_some(amount)
                    .ok_or_else(|| "invalid Fomo alert amount".to_string())
            })
            .transpose()
    };
    let created_at_ms = input.created_at_ms;
    if created_at_ms < 1_500_000_000_000 || created_at_ms > now_ms().saturating_add(86_400_000) {
        return Err("invalid Fomo alert timestamp".to_string());
    }
    let profile_picture_url = validated_fomo_optional_text(input.profile_picture_url, 2_048)?
        .map(|value| {
            let parsed = tauri::Url::parse(&value)
                .map_err(|_| "invalid Fomo profile image URL".to_string())?;
            if parsed.scheme() != "https"
                || parsed.host_str().is_none()
                || url_has_authority_credentials(&parsed)
            {
                return Err("invalid Fomo profile image URL".to_string());
            }
            Ok(parsed.to_string())
        })
        .transpose()?;
    let user_handle = validated_fomo_optional_text(input.user_handle, 80)?
        .map(|value| {
            normalized_fomo_handle(&value).ok_or_else(|| "invalid Fomo user handle".to_string())
        })
        .transpose()?;
    let trade_id = validated_fomo_optional_text(input.trade_id, 128)?;
    if trade_id.as_deref().is_some_and(|value| {
        !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }) {
        return Err("invalid Fomo trade ID".to_string());
    }
    let thesis = validated_fomo_optional_text(input.thesis, 4_000)?;
    let thesis_id = validated_fomo_optional_text(input.thesis_id, 128)?;
    if event_type == "thesis_created" && thesis.is_none() {
        return Err("Fomo thesis text is required".to_string());
    }
    if thesis_id.as_deref().is_some_and(|value| {
        !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    }) {
        return Err("invalid Fomo thesis ID".to_string());
    }
    let mut source_url = tauri::Url::parse(&format!(
        "https://fomo.family/tokens/{network_slug}/{token_address}"
    ))
    .map_err(|error| format!("failed to build Fomo source URL: {error}"))?;
    if event_type == "thesis_created" {
        source_url
            .query_pairs_mut()
            .append_pair("thesisId", thesis_id.as_deref().unwrap_or(&id))
            .append_pair("eventType", &event_type);
    } else {
        source_url
            .query_pairs_mut()
            .append_pair(
                if trade_id.is_some() {
                    "tradeId"
                } else {
                    "alertId"
                },
                trade_id.as_deref().unwrap_or(&id),
            )
            .append_pair("eventType", &event_type);
    }

    Ok(DappFomoAlertEventItem {
        id,
        event_type,
        chain: chain.to_string(),
        token_address,
        ticker: validated_fomo_optional_text(input.ticker, 32)?,
        user_handle,
        display_name: validated_fomo_optional_text(input.display_name, 120)?,
        profile_picture_url,
        follower_count: input.follower_count.filter(|count| *count <= 1_000_000_000),
        trade_id,
        usd_amount: validate_amount(input.usd_amount)?,
        market_cap: validate_amount(input.market_cap)?,
        trader_count: input
            .trader_count
            .filter(|count| *count > 0 && *count <= 100_000),
        thesis,
        thesis_id,
        source_url: source_url.to_string(),
        created_at_ms,
    })
}

fn format_fomo_usd(value: Option<f64>) -> Option<String> {
    let value = value?;
    let (scaled, suffix, decimals) = if value >= 1_000_000_000_000.0 {
        (value / 1_000_000_000_000.0, "T", 1)
    } else if value >= 1_000_000_000.0 {
        (value / 1_000_000_000.0, "B", 1)
    } else if value >= 1_000_000.0 {
        (value / 1_000_000.0, "M", 1)
    } else if value >= 1_000.0 {
        (value / 1_000.0, "K", 1)
    } else {
        (value, "", 2)
    };
    let mut formatted = format!("{scaled:.decimals$}");
    while formatted.contains('.') && formatted.ends_with('0') {
        formatted.pop();
    }
    if formatted.ends_with('.') {
        formatted.pop();
    }
    Some(format!("{formatted}{suffix}"))
}

fn fomo_alert_research_text(alert: &DappFomoAlertEventItem) -> String {
    if alert.event_type == "thesis_created" {
        return alert.thesis.clone().unwrap_or_default();
    }
    let action = match alert.event_type.as_str() {
        "swap_buy" | "multi_user_buy" => "Buy",
        "swap_sell" | "multi_user_sell" => "Sell",
        "transfer_in" => "Transfer in",
        _ => "Transfer out",
    };
    let mut parts = Vec::new();
    if alert.event_type.starts_with("multi_user_") {
        if let Some(count) = alert.trader_count {
            parts.push(format!("{count} traders:"));
        }
    }
    parts.push(action.to_string());
    if let Some(amount) = format_fomo_usd(alert.usd_amount) {
        parts.push(format!("${amount}"));
    }
    parts.push(
        alert
            .ticker
            .as_deref()
            .map(|ticker| format!("${}", ticker.trim_start_matches('$').to_ascii_uppercase()))
            .unwrap_or_else(|| "token".to_string()),
    );
    if let Some(market_cap) = format_fomo_usd(alert.market_cap) {
        parts.push(format!("at ${market_cap} market cap"));
    }
    parts.push(format!("on {}", alert.chain));
    parts.join(" ")
}

fn fomo_research_ingest_request(
    alerts: &[DappFomoAlertEventItem],
    captured_at_ms: u64,
) -> research_store::ResearchIngestRequest {
    let signals = alerts
        .iter()
        .map(|alert| research_store::ResearchSignalInput {
            tweet_id: None,
            author_handle: alert
                .user_handle
                .clone()
                .unwrap_or_else(|| "fomo_alerts".to_string()),
            text: fomo_alert_research_text(alert),
            chain: alert.chain.clone(),
            contract_address: Some(alert.token_address.clone()),
            token_symbols: alert
                .ticker
                .as_deref()
                .map(|ticker| {
                    vec![format!(
                        "${}",
                        ticker.trim_start_matches('$').to_ascii_uppercase()
                    )]
                })
                .unwrap_or_default(),
            source_url: Some(alert.source_url.clone()),
            published_at: None,
            detected_at_ms: i64::try_from(alert.created_at_ms).ok(),
        })
        .collect();
    research_store::ResearchIngestRequest {
        source_url: String::new(),
        captured_at_ms: i64::try_from(captured_at_ms).unwrap_or(i64::MAX),
        kols: Vec::new(),
        tweets: Vec::new(),
        signals,
        backfill_complete: false,
    }
}

fn validated_fomo_alert_batch(
    inputs: Vec<DappCapturedFomoAlert>,
) -> (Vec<DappFomoAlertEventItem>, Vec<String>) {
    let mut alerts = Vec::with_capacity(inputs.len());
    let mut errors = Vec::new();
    for input in inputs {
        match validated_fomo_alert(input) {
            Ok(alert) => alerts.push(alert),
            Err(error) => errors.push(error),
        }
    }
    (alerts, errors)
}

#[tauri::command]
fn dapp_submit_fomo_alerts(
    webview: DesktopWebview,
    app: DesktopAppHandle,
    research_store: tauri::State<'_, research_store::ResearchStore>,
    payload: DappSubmitFomoAlertsRequest,
) -> Result<(), String> {
    let webview_label = webview.label().to_string();
    let tab_id = dapp_tab_id_from_label(&webview_label)
        .ok_or_else(|| "Fomo alerts can only be submitted from dapp tabs".to_string())?;
    if tab_id != FOMO_ALERTS_TAB_ID {
        return Err("Fomo alerts can only be submitted from the Fomo Alerts tab".to_string());
    }
    let page_url = parse_dapp_browser_url(&payload.url)?;
    if !is_fomo_https_url(&page_url) {
        return Err("Fomo alerts can only be submitted by fomo.family".to_string());
    }
    if payload.alerts.len() > 200 {
        return Err("too many Fomo alerts in one submission".to_string());
    }
    let submitted_count = payload.alerts.len();
    let (alerts, validation_errors) = validated_fomo_alert_batch(payload.alerts);
    for error in &validation_errors {
        log::warn!("ignored invalid Fomo alert: {error}");
    }
    if !validation_errors.is_empty() {
        log::warn!(
            "ignored {} of {submitted_count} Fomo alerts in one submission",
            validation_errors.len()
        );
    }
    if alerts.is_empty() {
        return Ok(());
    }
    let alert_count = alerts.len();
    let newest_created_at_ms = alerts.iter().map(|alert| alert.created_at_ms).max();
    log::info!(
        "received {alert_count} Fomo alerts (newest_created_at_ms={newest_created_at_ms:?})"
    );
    let captured_at_ms = now_ms();
    let ingest_request = fomo_research_ingest_request(&alerts, captured_at_ms);
    if let Err(error) = research_store.ingest_request(&ingest_request) {
        log::error!("failed to persist {alert_count} Fomo alerts: {error}");
    }
    app.emit_to(
        "main",
        DAPP_FOMO_ALERTS_EVENT,
        DappFomoAlertsEvent {
            tab_id,
            alerts,
            captured_at_ms,
        },
    )
    .map_err(|error| format!("failed to emit Fomo alerts: {error}"))?;
    Ok(())
}

#[tauri::command]
fn dapp_submit_fomo_auth(
    webview: DesktopWebview,
    app: DesktopAppHandle,
    payload: DappSubmitFomoAuthRequest,
) -> Result<(), String> {
    let webview_label = webview.label().to_string();
    let tab_id = dapp_tab_id_from_label(&webview_label)
        .ok_or_else(|| "Fomo auth can only be submitted from dapp tabs".to_string())?;
    if tab_id != FOMO_ALERTS_TAB_ID {
        return Err("Fomo auth can only be submitted from the Fomo Alerts tab".to_string());
    }
    let page_url = parse_dapp_browser_url(&payload.url)?;
    if !is_fomo_https_url(&page_url) {
        return Err("Fomo auth can only be submitted by fomo.family".to_string());
    }
    log::info!(
        "received Fomo auth status (authenticated={}, path={})",
        payload.authenticated,
        page_url.path()
    );
    app.emit_to(
        "main",
        DAPP_FOMO_AUTH_EVENT,
        DappFomoAuthEvent {
            tab_id,
            authenticated: payload.authenticated,
            url: page_url.to_string(),
            captured_at_ms: now_ms(),
        },
    )
    .map_err(|error| format!("failed to emit Fomo auth status: {error}"))?;
    Ok(())
}

fn validated_fomo_stream_event(
    payload: DappSubmitFomoStreamRequest,
    captured_at_ms: u64,
) -> Result<DappFomoStreamEvent, String> {
    let page_url = parse_dapp_browser_url(&payload.url)?;
    if !is_fomo_https_url(&page_url) {
        return Err("Fomo stream status can only be submitted by fomo.family".to_string());
    }
    if !matches!(
        payload.status.as_str(),
        "connecting" | "connected" | "reconnecting" | "offline"
    ) {
        return Err("invalid Fomo stream status".to_string());
    }
    if payload.attempt > 16 {
        return Err("invalid Fomo stream recovery attempt".to_string());
    }
    let last_activity_at_ms = payload
        .last_activity_at_ms
        .filter(|timestamp| *timestamp <= captured_at_ms.saturating_add(60_000));
    let retry_at_ms = payload.retry_at_ms.filter(|timestamp| {
        *timestamp >= captured_at_ms.saturating_sub(60_000)
            && *timestamp <= captured_at_ms.saturating_add(6 * 60_000)
    });
    Ok(DappFomoStreamEvent {
        tab_id: FOMO_ALERTS_TAB_ID.to_string(),
        status: payload.status,
        last_activity_at_ms,
        retry_at_ms,
        attempt: payload.attempt,
        captured_at_ms,
    })
}

#[tauri::command]
fn dapp_submit_fomo_stream(
    webview: DesktopWebview,
    app: DesktopAppHandle,
    payload: DappSubmitFomoStreamRequest,
) -> Result<(), String> {
    let webview_label = webview.label().to_string();
    let tab_id = dapp_tab_id_from_label(&webview_label)
        .ok_or_else(|| "Fomo stream status can only be submitted from dapp tabs".to_string())?;
    if tab_id != FOMO_ALERTS_TAB_ID {
        return Err(
            "Fomo stream status can only be submitted from the Fomo Alerts tab".to_string(),
        );
    }
    let captured_at_ms = now_ms();
    let activity_source_value = payload.activity_source.clone();
    let activity_source = activity_source_value
        .as_deref()
        .filter(|source| {
            matches!(
                *source,
                "feed_response" | "feed_poll" | "socket_open" | "trading_data"
            )
        })
        .unwrap_or("unspecified")
        .to_string();
    let observed_item_count = payload.observed_item_count.filter(|count| *count <= 10_000);
    let normalized_alert_count = payload
        .normalized_alert_count
        .filter(|count| *count <= 10_000);
    let observed_types_value = payload.observed_types.clone();
    let observed_types = observed_types_value.as_deref().filter(|types| {
        types.len() <= 512
            && types.chars().all(|character| {
                character.is_ascii_lowercase() || character == '_' || character == ','
            })
    });
    let event = validated_fomo_stream_event(payload, captured_at_ms)?;
    log::info!(
        "received Fomo stream status (status={}, source={}, observed_items={:?}, normalized_alerts={:?}, observed_types={:?}, last_activity_at_ms={:?}, attempt={})",
        event.status,
        activity_source,
        observed_item_count,
        normalized_alert_count,
        observed_types,
        event.last_activity_at_ms,
        event.attempt
    );
    app.emit_to("main", DAPP_FOMO_STREAM_EVENT, event)
        .map_err(|error| format!("failed to emit Fomo stream status: {error}"))?;
    Ok(())
}

#[tauri::command]
fn dapp_request_fomo_profile(
    app: DesktopAppHandle,
    request_id: String,
    handle: String,
) -> Result<(), String> {
    if request_id.is_empty()
        || request_id.len() > 100
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid Fomo profile request ID".to_string());
    }
    let handle =
        normalized_fomo_handle(&handle).ok_or_else(|| "invalid Fomo profile handle".to_string())?;
    let label = dapp_tab_label(FOMO_ALERTS_TAB_ID)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "Fomo Alerts tab is not open".to_string())?;
    let detail = json!({ "requestId": request_id, "handle": handle });
    let script = format!(
        "window.dispatchEvent(new CustomEvent('__fnzsafe_fomo_profile_request', {{ detail: {} }}));",
        detail
    );
    webview
        .eval(&script)
        .map_err(|error| format!("failed to request Fomo profile: {error}"))
}

#[tauri::command]
fn dapp_submit_fomo_profile(
    webview: DesktopWebview,
    app: DesktopAppHandle,
    payload: DappSubmitFomoProfileRequest,
) -> Result<(), String> {
    let webview_label = webview.label().to_string();
    let tab_id = dapp_tab_id_from_label(&webview_label)
        .ok_or_else(|| "Fomo profiles can only be submitted from dapp tabs".to_string())?;
    if tab_id != FOMO_ALERTS_TAB_ID {
        return Err("Fomo profiles can only be submitted from the Fomo Alerts tab".to_string());
    }
    let page_url = parse_dapp_browser_url(&payload.url)?;
    if !is_fomo_https_url(&page_url) {
        return Err("Fomo profiles can only be submitted by fomo.family".to_string());
    }
    if payload.request_id.is_empty()
        || payload.request_id.len() > 100
        || !payload
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid Fomo profile request ID".to_string());
    }
    let requested_handle = normalized_fomo_handle(&payload.requested_handle)
        .ok_or_else(|| "invalid requested Fomo profile handle".to_string())?;
    let profile = payload
        .profile
        .map(|profile| {
            let user_handle = normalized_fomo_handle(&profile.user_handle)
                .ok_or_else(|| "invalid Fomo profile handle".to_string())?;
            if user_handle != requested_handle || profile.followers > 1_000_000_000 {
                return Err("unexpected Fomo profile response".to_string());
            }
            let profile_picture_url =
                validated_fomo_optional_text(profile.profile_picture_url, 2_048)?
                    .map(|value| {
                        let parsed = tauri::Url::parse(&value)
                            .map_err(|_| "invalid Fomo profile image URL".to_string())?;
                        if parsed.scheme() != "https"
                            || parsed.host_str().is_none()
                            || url_has_authority_credentials(&parsed)
                        {
                            return Err("invalid Fomo profile image URL".to_string());
                        }
                        Ok(parsed.to_string())
                    })
                    .transpose()?;
            Ok(DappCapturedFomoProfile {
                user_handle,
                display_name: validated_fomo_optional_text(profile.display_name, 120)?,
                profile_picture_url,
                followers: profile.followers,
                following: profile.following.filter(|value| *value <= 1_000_000_000),
            })
        })
        .transpose()?;
    app.emit_to(
        "main",
        DAPP_FOMO_PROFILE_EVENT,
        DappFomoProfileEvent {
            request_id: payload.request_id,
            requested_handle,
            status_code: payload.status_code,
            profile,
            captured_at_ms: now_ms(),
        },
    )
    .map_err(|error| format!("failed to emit Fomo profile: {error}"))?;
    Ok(())
}

#[tauri::command]
fn dapp_submit_connect_request(
    webview: DesktopWebview,
    app: DesktopAppHandle,
    state: tauri::State<'_, DappBridgeState>,
) -> Result<String, String> {
    let webview_label = webview.label().to_string();
    log::info!("received dapp connect request from webview {webview_label}");
    if dapp_tab_id_from_label(&webview_label).is_none() {
        log::warn!("rejected dapp connect request from invalid webview label {webview_label}");
        return Err("dapp connection requests are only accepted from dapp tabs".to_string());
    }
    let session = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "dapp session lock poisoned".to_string())?;
        let Some(session) = sessions.get(&webview_label).cloned() else {
            log::warn!(
                "rejected dapp connect request from {webview_label}: no session is registered (active session count={})",
                sessions.len()
            );
            return Err("no active dapp session for this tab".to_string());
        };
        session
    };
    if session.wallet_family != "evm" && session.wallet_family != "solana" {
        log::warn!(
            "rejected dapp connect request from {webview_label}: unsupported wallet family {}",
            session.wallet_family
        );
        return Err("unsupported embedded wallet session".to_string());
    }
    if now_ms().saturating_sub(session.opened_at_ms) > 12 * 60 * 60 * 1000 {
        log::warn!("rejected dapp connect request from {webview_label}: session expired");
        return Err("dapp session expired".to_string());
    }
    // Reading webview.url() synchronously from a command invoked by that same
    // CEF renderer can deadlock. Navigation handlers already keep session.url
    // current and reject unsafe destinations, so use the tracked URL directly.
    let Some(current_url) = dapp_session_request_url(&session.url) else {
        log::warn!("rejected dapp connect request from {webview_label}: no safe tracked URL");
        return Err("dapp connection origin is unavailable".to_string());
    };
    let request_id = dapp_request_id();
    let request_origin = current_url.origin().ascii_serialization();
    let event = DappConnectRequestEvent {
        request_id: request_id.clone(),
        app_id: session.app_id,
        app_name: current_url
            .host_str()
            .unwrap_or(&session.app_name)
            .to_string(),
        app_url: current_url.to_string(),
        wallet_family: session.wallet_family,
        wallet_public_key: Some(session.wallet_public_key),
        network: session.network,
        callback_url: None,
        created_at_ms: now_ms(),
    };
    log::info!(
        "submitting dapp connect request {request_id} from {webview_label}: family={}, network={}, origin={request_origin}",
        event.wallet_family,
        event.network,
    );
    if let Err(error) =
        enqueue_dapp_connect_request(&app, state.inner(), Some(webview_label.clone()), event)
    {
        log::warn!("rejected dapp connect request {request_id} from {webview_label}: {error}");
        return Err(error);
    }
    Ok(request_id)
}

#[tauri::command]
fn dapp_poll_connect_request(
    webview: DesktopWebview,
    state: tauri::State<'_, DappBridgeState>,
    request_id: String,
) -> Result<DappPollResponse, String> {
    let webview_label = webview.label().to_string();
    if dapp_tab_id_from_label(&webview_label).is_none() {
        return Err("dapp connection requests are only polled from dapp tabs".to_string());
    }
    let request_id = request_id.trim();
    let mut requests = state
        .connect_requests
        .lock()
        .map_err(|_| "dapp connect request lock poisoned".to_string())?;
    let Some(pending) = requests.get(request_id) else {
        return Ok(DappPollResponse {
            status: "expired",
            result: None,
        });
    };
    if pending.webview_label.as_deref() != Some(webview_label.as_str()) {
        return Err("dapp connection request does not belong to this tab".to_string());
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
        log::info!(
            "dapp tab {webview_label} consumed connect request {request_id}: approved={}",
            result.approved,
        );
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
fn dapp_submit_sign_request(
    webview: DesktopWebview,
    app: DesktopAppHandle,
    state: tauri::State<'_, DappBridgeState>,
    method: String,
    transaction_base64: Option<String>,
    transaction_format: Option<String>,
    message_base64: Option<String>,
    payload_json: Option<String>,
) -> Result<String, String> {
    let webview_label = webview.label().to_string();
    log::info!("received dapp signing request from webview {webview_label}: method={method}");
    let Some(_tab_id) = dapp_tab_id_from_label(&webview_label) else {
        log::warn!("rejected dapp signing request from invalid webview label {webview_label}");
        return Err("dapp signing requests are only accepted from dapp tabs".to_string());
    };
    let session = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "dapp session lock poisoned".to_string())?;
        let Some(session) = sessions.get(&webview_label).cloned() else {
            log::warn!(
                "rejected dapp signing request from {webview_label}: no session is registered (active session count={})",
                sessions.len()
            );
            return Err("no active dapp session for this tab".to_string());
        };
        session
    };
    if now_ms().saturating_sub(session.opened_at_ms) > 12 * 60 * 60 * 1000 {
        log::warn!("rejected dapp signing request from {webview_label}: session expired");
        return Err("dapp session expired".to_string());
    }
    let (method, transaction_base64, transaction_format, message_base64, payload_json) = if session
        .wallet_family
        == "evm"
    {
        let method = validate_evm_dapp_method(&method)?;
        let payload_json = validate_evm_payload_json(
            payload_json
                .as_deref()
                .ok_or_else(|| "EVM dapp payload is required".to_string())?,
        )?;
        (
            method,
            String::new(),
            "evm-json".to_string(),
            None,
            Some(payload_json),
        )
    } else {
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
        (
            method,
            transaction_base64,
            transaction_format,
            message_base64,
            None,
        )
    };
    // This command runs on the requesting renderer's IPC path. Synchronously
    // asking CEF for that same webview's URL can deadlock before the request is
    // queued, so use the URL maintained by the validated navigation handlers.
    let Some(current_url) = dapp_session_request_url(&session.url) else {
        log::warn!("rejected dapp signing request from {webview_label}: no safe tracked URL");
        return Err("dapp signing origin is unavailable".to_string());
    };
    let app_name = if session.wallet_family == "evm" || session.app_id.starts_with("web:") {
        current_url
            .host_str()
            .unwrap_or(&session.app_name)
            .to_string()
    } else {
        session.app_name
    };

    let request_id = dapp_request_id();
    let event = DappSignRequestEvent {
        request_id: request_id.clone(),
        app_id: session.app_id,
        app_name,
        app_url: current_url.to_string(),
        request_purpose: None,
        method,
        wallet_family: session.wallet_family,
        wallet_public_key: session.wallet_public_key,
        network: session.network,
        transaction_base64,
        transaction_format,
        message_base64,
        payload_json,
        callback_url: None,
        known_programs: Vec::new(),
        created_at_ms: now_ms(),
    };

    let request_origin = current_url.origin().ascii_serialization();
    log::info!(
        "submitting dapp signing request {request_id} from {webview_label}: method={}, family={}, network={}, origin={request_origin}",
        event.method,
        event.wallet_family,
        event.network,
    );
    if let Err(error) = enqueue_dapp_sign_request(&app, state.inner(), webview_label.clone(), event)
    {
        log::warn!("rejected dapp signing request {request_id} from {webview_label}: {error}");
        return Err(error);
    }
    Ok(request_id)
}

#[tauri::command]
fn dapp_poll_sign_request(
    webview: DesktopWebview,
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
        log::info!(
            "dapp tab {webview_label} consumed signing request {request_id}: approved={}",
            result.approved,
        );
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
    if state.paused.load(Ordering::Acquire) {
        return Ok(None);
    }
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "dapp request lock poisoned".to_string())?;
    prune_expired_dapp_sign_requests(&mut requests, now_ms());
    Ok(requests
        .values()
        .filter(|pending| pending.result.is_none())
        .map(|pending| pending.event.clone())
        .min_by_key(|event| event.created_at_ms))
}

#[tauri::command]
fn dapp_pending_connect_request(
    state: tauri::State<'_, DappBridgeState>,
) -> Result<Option<DappConnectRequestEvent>, String> {
    if state.paused.load(Ordering::Acquire) {
        return Ok(None);
    }
    let mut requests = state
        .connect_requests
        .lock()
        .map_err(|_| "dapp connect request lock poisoned".to_string())?;
    prune_expired_dapp_connect_requests(&mut requests, now_ms());
    Ok(requests
        .values()
        .filter(|pending| pending.result.is_none())
        .map(|pending| pending.event.clone())
        .min_by_key(|event| event.created_at_ms))
}

#[tauri::command]
fn resolve_dapp_sign_request(
    state: tauri::State<'_, DappBridgeState>,
    request_id: String,
    result: DappSignResult,
) -> Result<(), String> {
    ensure_dapp_connections_active(state.inner())?;
    let request_id = request_id.trim();
    let mut callback_target = None;
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "dapp request lock poisoned".to_string())?;
    ensure_dapp_connections_active(state.inner())?;
    let pending = requests
        .get_mut(request_id)
        .ok_or_else(|| "dapp signing request is no longer pending".to_string())?;
    if now_ms().saturating_sub(pending.event.created_at_ms) > DAPP_REQUEST_TTL_MS {
        requests.remove(request_id);
        return Err("dapp signing request expired".to_string());
    }
    ensure_dapp_result_pending(&pending.result, "dapp signing request")?;
    if let Some(callback_url) = pending.event.callback_url.as_deref() {
        callback_target = Some(append_dapp_result_to_callback_url(
            callback_url,
            request_id,
            &result,
        )?);
    }
    if let Some(callback_target) = callback_target.as_deref() {
        spawn_system_browser(callback_target)?;
    }
    pending.result = Some(result);
    log::info!("resolved dapp signing request {request_id}");
    Ok(())
}

#[tauri::command]
fn resolve_dapp_connect_request(
    state: tauri::State<'_, DappBridgeState>,
    request_id: String,
    result: DappSignResult,
) -> Result<(), String> {
    ensure_dapp_connections_active(state.inner())?;
    let request_id = request_id.trim();
    let mut requests = state
        .connect_requests
        .lock()
        .map_err(|_| "dapp connect request lock poisoned".to_string())?;
    ensure_dapp_connections_active(state.inner())?;
    let pending = requests
        .get_mut(request_id)
        .ok_or_else(|| "dapp connect request is no longer pending".to_string())?;
    if now_ms().saturating_sub(pending.event.created_at_ms) > DAPP_REQUEST_TTL_MS {
        requests.remove(request_id);
        return Err("dapp connect request expired".to_string());
    }
    ensure_dapp_result_pending(&pending.result, "dapp connect request")?;
    if result.approved {
        let approved_wallet = result
            .public_key
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "approved dapp connection must include a wallet address".to_string())?;
        if let Some(expected_wallet) = pending.event.wallet_public_key.as_deref() {
            let matches = if pending.event.wallet_family == "evm" {
                approved_wallet.eq_ignore_ascii_case(expected_wallet)
            } else {
                approved_wallet == expected_wallet
            };
            if !matches {
                return Err("approved wallet does not match the dapp session".to_string());
            }
        }
    }
    if let Some(callback_url) = pending.event.callback_url.as_deref() {
        let callback_target =
            append_dapp_result_to_callback_url(callback_url, request_id, &result)?;
        spawn_system_browser(&callback_target)?;
    }
    pending.result = Some(result);
    log::info!("resolved dapp connect request {request_id}");
    Ok(())
}

fn ensure_dapp_result_pending(
    result: &Option<DappSignResult>,
    request: &str,
) -> Result<(), String> {
    if result.is_some() {
        return Err(format!("{request} is already resolved"));
    }
    Ok(())
}

#[tauri::command]
fn dapp_pause_connections(
    app: DesktopAppHandle,
    state: tauri::State<'_, DappBridgeState>,
) -> Result<(), String> {
    let _visibility = state
        .webview_visibility
        .lock()
        .map_err(|_| "dapp webview visibility lock poisoned".to_string())?;
    pause_dapp_connections(state.inner())?;
    let mut first_error = None;
    for (label, webview) in app.webviews() {
        if label.starts_with(DAPP_TAB_LABEL_PREFIX) {
            if let Err(error) = webview.hide() {
                first_error.get_or_insert_with(|| error.to_string());
            }
        }
    }
    first_error
        .map(|error| Err(format!("failed to hide dapp tabs while locking: {error}")))
        .unwrap_or(Ok(()))
}

fn pause_dapp_connections(state: &DappBridgeState) -> Result<(), String> {
    state.paused.store(true, Ordering::Release);
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "dapp session lock poisoned".to_string())?;
    drop(sessions);
    state
        .requests
        .lock()
        .map_err(|_| "dapp request lock poisoned".to_string())?
        .clear();
    state
        .connect_requests
        .lock()
        .map_err(|_| "dapp connect request lock poisoned".to_string())?
        .clear();
    Ok(())
}

#[tauri::command]
fn dapp_resume_connections(
    app: DesktopAppHandle,
    state: tauri::State<'_, DappBridgeState>,
) -> Result<(), String> {
    let _visibility = state
        .webview_visibility
        .lock()
        .map_err(|_| "dapp webview visibility lock poisoned".to_string())?;
    let active_label = state
        .active_tab_label
        .lock()
        .map_err(|_| "active dapp tab lock poisoned".to_string())?
        .clone();
    let fomo_background_label = dapp_tab_label(FOMO_ALERTS_TAB_ID)?;
    let fomo_background_bounds = dapp_webview_bounds(-20_000.0, -20_000.0, 1_280.0, 900.0)?;
    let mut active_webview = None;
    for (label, webview) in app.webviews() {
        if !label.starts_with(DAPP_TAB_LABEL_PREFIX) {
            continue;
        }
        if active_label.as_deref() == Some(label.as_str()) {
            active_webview = Some(webview);
        } else if label == fomo_background_label {
            webview
                .set_bounds(fomo_background_bounds)
                .map_err(|error| format!("failed to position background dapp tab: {error}"))?;
            webview
                .show()
                .map_err(|error| format!("failed to restore background dapp tab: {error}"))?;
        } else {
            webview
                .hide()
                .map_err(|error| format!("failed to keep inactive dapp tab hidden: {error}"))?;
        }
    }
    if let Some(webview) = active_webview {
        webview
            .show()
            .map_err(|error| format!("failed to restore active dapp tab: {error}"))?;
        raise_embedded_webview(&webview)?;
    }
    state.paused.store(false, Ordering::Release);
    Ok(())
}

fn dapp_session_matches_permission(
    session: &DappSession,
    origin: &str,
    wallet_public_key: &str,
    network: &str,
) -> bool {
    app_store::normalize_dapp_origin(&session.url)
        .is_ok_and(|session_origin| session_origin == origin)
        && session.wallet_public_key == wallet_public_key
        && session.network.eq_ignore_ascii_case(network)
}

fn dapp_sign_request_matches_permission(
    request: &DappSignRequestEvent,
    origin: &str,
    wallet_public_key: &str,
    network: &str,
) -> bool {
    app_store::normalize_dapp_origin(&request.app_url)
        .is_ok_and(|request_origin| request_origin == origin)
        && request.wallet_public_key == wallet_public_key
        && request.network.eq_ignore_ascii_case(network)
}

fn dapp_connect_request_matches_permission(
    request: &DappConnectRequestEvent,
    origin: &str,
    wallet_public_key: &str,
    network: &str,
) -> bool {
    app_store::normalize_dapp_origin(&request.app_url)
        .is_ok_and(|request_origin| request_origin == origin)
        && request
            .wallet_public_key
            .as_deref()
            .is_none_or(|requested| {
                if request.wallet_family == "evm" {
                    requested.eq_ignore_ascii_case(wallet_public_key)
                } else {
                    requested == wallet_public_key
                }
            })
        && request.network.eq_ignore_ascii_case(network)
}

#[tauri::command]
fn dapp_disconnect_connection(
    state: tauri::State<'_, DappBridgeState>,
    store: tauri::State<'_, app_store::AppStore>,
    origin: String,
    wallet_public_key: String,
    wallet_id: String,
    network: String,
) -> Result<bool, String> {
    let origin = app_store::normalize_dapp_origin(&origin)?;
    let wallet_public_key = wallet_public_key.trim();
    let network = network.trim();
    if wallet_public_key.is_empty() || network.is_empty() {
        return Err("wallet and network are required".to_string());
    }

    disconnect_dapp_connection_state(state.inner(), &origin, wallet_public_key, network, || {
        app_store::revoke_dapp_permission_for_identity(
            store.inner(),
            &origin,
            &wallet_id,
            wallet_public_key,
            network,
        )
    })
}

fn disconnect_dapp_connection_state<ResultValue>(
    state: &DappBridgeState,
    origin: &str,
    wallet_public_key: &str,
    network: &str,
    persist_revoke: impl FnOnce() -> Result<ResultValue, String>,
) -> Result<ResultValue, String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "dapp session lock poisoned".to_string())?;
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "dapp request lock poisoned".to_string())?;
    let mut connect_requests = state
        .connect_requests
        .lock()
        .map_err(|_| "dapp connect request lock poisoned".to_string())?;
    let removed_labels = sessions
        .iter()
        .filter(|(_, session)| {
            dapp_session_matches_permission(session, origin, wallet_public_key, network)
        })
        .map(|(label, _)| label.clone())
        .collect::<HashSet<_>>();

    let result = persist_revoke()?;
    sessions.retain(|label, _| !removed_labels.contains(label));
    requests.retain(|_, pending| {
        !removed_labels.contains(&pending.webview_label)
            && !dapp_sign_request_matches_permission(
                &pending.event,
                origin,
                wallet_public_key,
                network,
            )
    });
    connect_requests.retain(|_, pending| {
        !dapp_connect_request_matches_permission(&pending.event, origin, wallet_public_key, network)
    });
    Ok(result)
}

#[tauri::command]
fn dapp_disconnect_wallet(
    state: tauri::State<'_, DappBridgeState>,
    store: tauri::State<'_, app_store::AppStore>,
    wallet_id: String,
    wallet_public_key: String,
) -> Result<usize, String> {
    disconnect_dapp_wallet_state(state.inner(), &wallet_public_key, || {
        app_store::revoke_dapp_permissions_for_wallet(
            store.inner(),
            &wallet_id,
            wallet_public_key.trim(),
        )
    })
}

fn disconnect_dapp_wallet_state<ResultValue>(
    state: &DappBridgeState,
    wallet_public_key: &str,
    persist_revoke: impl FnOnce() -> Result<ResultValue, String>,
) -> Result<ResultValue, String> {
    let wallet_public_key = wallet_public_key.trim();
    if wallet_public_key.is_empty() {
        return Err("wallet public key is required".to_string());
    }
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "dapp session lock poisoned".to_string())?;
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "dapp request lock poisoned".to_string())?;
    let removed_labels = sessions
        .iter()
        .filter(|(_, session)| session.wallet_public_key == wallet_public_key)
        .map(|(label, _)| label.clone())
        .collect::<HashSet<_>>();

    let result = persist_revoke()?;
    sessions.retain(|label, _| !removed_labels.contains(label));
    requests.retain(|_, pending| {
        !removed_labels.contains(&pending.webview_label)
            && pending.event.wallet_public_key != wallet_public_key
    });
    Ok(result)
}

#[tauri::command]
fn open_developer_tools(app: DesktopAppHandle) -> Result<(), String> {
    let webview = app
        .get_webview("main")
        .ok_or_else(|| "main webview is unavailable".to_string())?;
    webview.open_devtools();
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
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "user profile directory is unavailable".to_string())?;
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME directory is unavailable".to_string())?;
    Ok(home.join("Downloads"))
}

fn numbered_download_path(directory: &Path, filename: &str, index: usize) -> PathBuf {
    if index == 0 {
        return directory.join(filename);
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(filename);
    let extension = path.extension().and_then(|value| value.to_str());
    let next_name = match extension {
        Some(extension) if !extension.is_empty() => format!("{stem}-{index}.{extension}"),
        _ => format!("{stem}-{index}"),
    };
    directory.join(next_name)
}

fn write_new_download(directory: &Path, filename: &str, content: &[u8]) -> Result<PathBuf, String> {
    for index in 0..10_000 {
        let path = numbered_download_path(directory, filename, index);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(content) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(format!("failed to write download file: {error}"));
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("failed to create download file: {error}")),
        }
    }
    Err("too many files use this download name".to_string())
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
    let path = write_new_download(&directory, &filename, content.as_bytes())?;
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

fn stable_app_support_dir(app: &DesktopApp) -> PathBuf {
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

fn preferred_wallet_database_path(app: &DesktopApp) -> PathBuf {
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

fn preferred_research_database_path(app: &DesktopApp) -> PathBuf {
    if let Ok(path) = env::var("FNZERO_SAFE_RESEARCH_DB_PATH") {
        let path = path.trim();
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    stable_app_support_dir(app).join("twitter-research.sqlite3")
}

fn desktop_api_binary_candidates(app: &DesktopApp) -> Vec<PathBuf> {
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
            candidates.push(
                ancestor
                    .join("build-cache-fnzsafe/release")
                    .join(&binary_name),
            );
            candidates.push(ancestor.join("build-cache/release").join(&binary_name));
            candidates.push(ancestor.join("target/release").join(&binary_name));
        }
    }

    for root in repository_root_candidates() {
        candidates.push(root.join("build-cache-fnzsafe/release").join(&binary_name));
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
    app: &DesktopApp,
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
        .env("FNZERO_SAFE_API_TOKEN", process.api_token())
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

#[cfg(unix)]
fn disable_core_dumps() {
    let limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a valid `rlimit` and `setrlimit` does not retain the pointer.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } != 0 {
        eprintln!(
            "failed to disable desktop process core dumps: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(not(unix))]
fn disable_core_dumps() {}

#[tauri::cef_entry_point]
pub fn run() {
    disable_core_dumps();
    let pid_dir = prelaunch_app_support_dir();
    let legacy_desktop_app_pid_file = pid_dir.join(LEGACY_DESKTOP_APP_PID_FILE_NAME);
    let desktop_app_pid_file = pid_dir.join(DESKTOP_APP_PID_FILE_NAME);
    let desktop_api_pid_file = pid_dir.join(DESKTOP_API_PID_FILE_NAME);
    let current_pid = std::process::id();
    if let Err(error) = terminate_recorded_process(&legacy_desktop_app_pid_file) {
        eprintln!("failed to stop legacy recorded desktop app process: {error}");
    }
    if let Err(error) = terminate_recorded_process(&desktop_app_pid_file) {
        eprintln!("failed to stop recorded desktop app process: {error}");
    }
    match env::current_exe() {
        Ok(current_exe) => {
            if let Err(error) =
                write_managed_pid_file(&desktop_app_pid_file, &current_exe, current_pid)
            {
                eprintln!("failed to write desktop app PID file: {error}");
            }
        }
        Err(error) => {
            eprintln!("failed to resolve current desktop app executable: {error}");
        }
    }

    let run_result = tauri::Builder::<DesktopRuntime>::default()
        // CEF 151.3.12 crashes at address 0x10 when an Alloy-style webview
        // reports an SPA soft navigation (chromiumembedded/cef#4234). Neither
        // Chrome UI reading mode nor soft-navigation metrics are used here.
        .command_line_args([
            (
                "--disable-features",
                Some("ImmersiveReadAnything,SoftNavigationDetection"),
            ),
            ("--disable-background-timer-throttling", None),
            ("--disable-renderer-backgrounding", None),
            ("--disable-backgrounding-occluded-windows", None),
        ])
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::Builder::new().build())
        .manage(DappBridgeState::default())
        .manage(DesktopApiProcess::new(desktop_api_pid_file.clone()))
        .invoke_handler(tauri::generate_handler![
            proxy_api_request,
            translate_signal_text,
            open_external_url,
            open_url_in_chrome,
            dapp_open_tab,
            dapp_navigate_tab,
            dapp_reload_tab,
            dapp_set_active_tab,
            dapp_close_tab,
            dapp_request_tab_text,
            dapp_submit_page_text,
            dapp_submit_fomo_alerts,
            dapp_submit_fomo_auth,
            dapp_submit_fomo_stream,
            dapp_request_fomo_profile,
            dapp_submit_fomo_profile,
            browser_profile::browser_chrome_profiles,
            browser_profile::browser_import_chrome,
            browser_profile::browser_passwords_list,
            browser_profile::browser_password_delete,
            browser_profile::browser_passwords_clear,
            browser_profile::browser_autofill,
            browser_profile::browser_tab_action,
            browser_profile::browser_take_screenshot,
            app_store::settings_get,
            app_store::settings_update,
            app_store::settings_import_legacy,
            app_store::address_book_list,
            app_store::address_book_upsert,
            app_store::address_book_delete,
            app_store::dapp_permissions_list,
            app_store::dapp_permission_grant,
            app_store::dapp_permission_revoke,
            app_store::settings_diagnostics,
            research_store::research_ingest,
            research_store::research_list_defillama_rankings,
            research_store::research_put_defillama_rankings,
            research_store::research_resolve_tokens,
            research_store::research_scan_cursor,
            research_store::research_list_kols,
            research_store::research_list_signals,
            research_store::research_list_tokens,
            research_store::research_refresh_token_markets,
            research_store::research_clear_signals,
            research_store::research_remove_kol,
            research_store::research_query,
            research_store::research_ai_chat,
            research_store::research_ai_key_status,
            research_store::research_ai_key_store,
            research_store::research_ai_key_delete,
            dapp_submit_connect_request,
            dapp_poll_connect_request,
            dapp_submit_sign_request,
            dapp_poll_sign_request,
            dapp_pending_sign_request,
            dapp_pending_connect_request,
            resolve_dapp_sign_request,
            resolve_dapp_connect_request,
            dapp_pause_connections,
            dapp_resume_connections,
            dapp_disconnect_connection,
            dapp_disconnect_wallet,
            open_developer_tools,
            secure_input::set_secure_keyboard_input,
            biometric_wallet_status,
            biometric_wallet_store_password,
            biometric_wallet_unlock_all,
            biometric_wallet_delete_password,
            pick_source_directory,
            save_download_file,
            open_download_file_location
        ])
        .setup(move |app| {
            let wallet_database_path = preferred_wallet_database_path(app);
            let app_store = app_store::AppStore::new(wallet_database_path.clone())
                .map_err(std::io::Error::other)?;
            app.manage(app_store);
            let research_store = research_store::ResearchStore::new_with_legacy(
                preferred_research_database_path(app),
                Some(wallet_database_path),
            )
            .map_err(std::io::Error::other)?;
            app.manage(research_store);
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
                if let Some(main_webview) = app.get_webview("main") {
                    if main_webview.url().is_err() {
                        if let Some(dev_url) = app.config().build.dev_url.clone() {
                            main_webview.navigate(dev_url)?;
                        }
                    }
                }
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
        .run(tauri::generate_context!());
    remove_owned_pid_file(&desktop_app_pid_file, current_pid);
    run_result.expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::{
        encoding::{AsDer, PublicKeyX509Der},
        rsa::{KeySize, OaepPrivateDecryptingKey, PrivateDecryptingKey},
    };

    #[test]
    fn generated_desktop_api_tokens_are_random_256_bit_values() {
        let first = generate_desktop_api_token();
        let second = generate_desktop_api_token();
        assert_eq!(BASE64.decode(first.as_bytes()).unwrap().len(), 32);
        assert_eq!(BASE64.decode(second.as_bytes()).unwrap().len(), 32);
        assert_ne!(first, second);
    }

    #[test]
    fn desktop_api_process_keeps_one_nonempty_token_for_its_lifetime() {
        let process = DesktopApiProcess::new(PathBuf::from("unused-test-desktop-api.pid"));
        let first = process.api_token().to_string();
        assert!(!first.is_empty());
        assert_eq!(process.api_token(), first);
    }

    #[test]
    fn local_api_url_encodes_query_parameters_separately_from_the_path() {
        let query = [ProxyRequestQuery {
            name: "bitcoin_address_type".to_string(),
            value: "taproot & preferred".to_string(),
        }];
        let url = local_api_url(3841, "wallets/wallet-1/multichain-accounts", Some(&query))
            .expect("local API URL");

        assert_eq!(
            url,
            "http://127.0.0.1:3841/api/wallets/wallet-1/multichain-accounts?bitcoin_address_type=taproot+%26+preferred"
        );
    }

    #[test]
    fn biometric_unlock_command_and_permissions_stay_in_sync() {
        let permissions = include_str!("../permissions/biometric_wallet.toml");
        let capabilities = include_str!("../capabilities/default.json");
        assert!(permissions.contains("biometric_wallet_unlock_all"));
        assert!(!permissions.contains("biometric_wallet_get_password"));
        assert!(capabilities.contains("allow-biometric-wallet-unlock-all"));
        assert!(!capabilities.contains("allow-biometric-wallet-get-password"));
    }

    #[test]
    fn biometric_unlock_only_resets_credentials_for_a_wrong_wallet_password() {
        let wrong_password = ProxyResponse {
            status: 401,
            body: serde_json::json!({ "error": "钱包密码错误" }).to_string(),
        };
        assert!(response_reports_wrong_wallet_password(&wrong_password));

        for response in [
            ProxyResponse {
                status: 429,
                body: wrong_password.body.clone(),
            },
            ProxyResponse {
                status: 401,
                body: serde_json::json!({ "error": "部分历史钱包尚未统一密码" }).to_string(),
            },
            ProxyResponse {
                status: 401,
                body: "not-json".to_string(),
            },
        ] {
            assert!(!response_reports_wrong_wallet_password(&response));
        }
    }

    #[test]
    fn twitter_status_sources_require_web_urls_and_numeric_status_ids() {
        assert_eq!(
            normalize_twitter_status_url("https://X.com/User/status/123?ref=home#top").as_deref(),
            Some("https://x.com/User/status/123")
        );
        assert!(normalize_twitter_status_url("ftp://x.com/User/status/123").is_none());
        assert!(normalize_twitter_status_url("https://x.com/User/status/not-a-number").is_none());
        assert!(normalize_twitter_status_url("https://example.com/User/status/123").is_none());
    }

    #[test]
    fn google_translation_response_joins_text_segments() {
        let response = parse_google_translation(&json!([
            [
                ["该代币", "This token"],
                ["势头强劲。", "has strong momentum."]
            ],
            null,
            "en"
        ]))
        .unwrap();

        assert_eq!(response.translated_text, "该代币势头强劲。");
        assert_eq!(response.source_language.as_deref(), Some("en"));
        assert!(parse_google_translation(&json!([[], null, "en"])).is_err());
    }

    #[test]
    fn telegram_links_are_converted_to_native_app_routes() {
        let invite = "https://t.me/+Abc_123-xyz".parse::<tauri::Url>().unwrap();
        let channel = "https://t.me/fnzero/42".parse::<tauri::Url>().unwrap();
        let preview = "https://t.me/s/fnzero/42".parse::<tauri::Url>().unwrap();
        let native = "tg://resolve?domain=fnzero".parse::<tauri::Url>().unwrap();
        let unsafe_proxy = "tg://proxy?server=example.com&port=443"
            .parse::<tauri::Url>()
            .unwrap();
        let extra_parameter = "tg://resolve?domain=fnzero&start=secret"
            .parse::<tauri::Url>()
            .unwrap();
        let extra_path = "https://t.me/fnzero/42/extra"
            .parse::<tauri::Url>()
            .unwrap();
        let non_numeric_post = "https://t.me/fnzero/latest".parse::<tauri::Url>().unwrap();
        let query_parameter = "https://t.me/fnzero?start=secret"
            .parse::<tauri::Url>()
            .unwrap();
        let unrelated = "https://example.com/fnzero".parse::<tauri::Url>().unwrap();

        assert_eq!(
            telegram_deep_link(&invite).as_deref(),
            Some("tg://join?invite=Abc_123-xyz")
        );
        assert_eq!(
            telegram_deep_link(&channel).as_deref(),
            Some("tg://resolve?domain=fnzero&post=42")
        );
        assert_eq!(
            telegram_deep_link(&preview).as_deref(),
            Some("tg://resolve?domain=fnzero&post=42")
        );
        assert_eq!(telegram_deep_link(&native), Some(native.to_string()));
        assert!(telegram_deep_link(&unsafe_proxy).is_none());
        assert!(telegram_deep_link(&extra_parameter).is_none());
        assert!(telegram_deep_link(&extra_path).is_none());
        assert!(telegram_deep_link(&non_numeric_post).is_none());
        assert!(telegram_deep_link(&query_parameter).is_none());
        assert!(telegram_deep_link(&unrelated).is_none());
    }

    #[test]
    fn download_paths_are_numbered_without_overwriting_existing_files() {
        let directory = tempfile::tempdir().unwrap();
        let first = write_new_download(directory.path(), "report.json", b"first").unwrap();
        let second = write_new_download(directory.path(), "report.json", b"second").unwrap();

        assert_eq!(
            first.file_name().and_then(|value| value.to_str()),
            Some("report.json")
        );
        assert_eq!(
            second.file_name().and_then(|value| value.to_str()),
            Some("report-1.json")
        );
        assert_eq!(fs::read(first).unwrap(), b"first");
        assert_eq!(fs::read(second).unwrap(), b"second");
    }

    #[test]
    fn fomo_alert_validation_builds_a_scoped_source_url() {
        let alert = validated_fomo_alert(DappCapturedFomoAlert {
            id: "alert-1".to_string(),
            event_type: "swap_buy".to_string(),
            network_id: "4663".to_string(),
            token_address: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a".to_string(),
            ticker: Some("ZZZ".to_string()),
            user_handle: Some("chefjin".to_string()),
            display_name: None,
            profile_picture_url: None,
            follower_count: Some(12_300),
            trade_id: Some("trade-1".to_string()),
            usd_amount: Some(8_000.0),
            market_cap: Some(18_900_000.0),
            trader_count: None,
            thesis: None,
            thesis_id: None,
            created_at_ms: now_ms(),
        })
        .unwrap();

        assert_eq!(alert.chain, "Robinhood");
        assert_eq!(alert.event_type, "swap_buy");
        assert_eq!(alert.trade_id.as_deref(), Some("trade-1"));
        assert_eq!(alert.follower_count, Some(12_300));
        assert_eq!(
            alert.source_url,
            "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a?tradeId=trade-1&eventType=swap_buy"
        );

        let request = fomo_research_ingest_request(&[alert], now_ms());
        assert_eq!(request.signals.len(), 1);
        assert_eq!(
            request.signals[0].text,
            "Buy $8K $ZZZ at $18.9M market cap on Robinhood"
        );
        assert_eq!(request.signals[0].author_handle, "chefjin");
        assert_eq!(request.signals[0].token_symbols, ["$ZZZ"]);
    }

    #[test]
    fn fomo_thesis_validation_requires_text_and_builds_a_thesis_url() {
        let thesis = validated_fomo_alert(DappCapturedFomoAlert {
            id: "feed-42".to_string(),
            event_type: "thesis_created".to_string(),
            network_id: "4663".to_string(),
            token_address: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a".to_string(),
            ticker: Some("ZZZ".to_string()),
            user_handle: Some("Long_Fomo_Profile_Handle_123".to_string()),
            display_name: Some("Fomo Researcher".to_string()),
            profile_picture_url: None,
            follower_count: None,
            trade_id: None,
            usd_amount: None,
            market_cap: None,
            trader_count: None,
            thesis: Some("A bounded thesis\nwith\tmultiple lines".to_string()),
            thesis_id: Some("comment-42".to_string()),
            created_at_ms: now_ms(),
        })
        .unwrap();

        assert_eq!(thesis.event_type, "thesis_created");
        assert_eq!(
            thesis.thesis.as_deref(),
            Some("A bounded thesis\nwith\tmultiple lines")
        );
        assert_eq!(thesis.thesis_id.as_deref(), Some("comment-42"));
        assert_eq!(
            thesis.source_url,
            "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a?thesisId=comment-42&eventType=thesis_created"
        );
    }

    #[test]
    fn fomo_text_validation_allows_layout_whitespace_but_rejects_other_controls() {
        assert_eq!(
            validated_fomo_optional_text(Some("line one\nline two\tvalue".to_string()), 80)
                .unwrap()
                .as_deref(),
            Some("line one\nline two\tvalue")
        );
        assert!(validated_fomo_optional_text(Some("unsafe\u{0000}value".to_string()), 80).is_err());
    }

    #[test]
    fn fomo_alert_validation_rejects_unknown_types_and_bad_addresses() {
        let input = |event_type: &str, token_address: &str| DappCapturedFomoAlert {
            id: "alert-1".to_string(),
            event_type: event_type.to_string(),
            network_id: "4663".to_string(),
            token_address: token_address.to_string(),
            ticker: None,
            user_handle: None,
            display_name: None,
            profile_picture_url: None,
            follower_count: None,
            trade_id: None,
            usd_amount: None,
            market_cap: None,
            trader_count: None,
            thesis: None,
            thesis_id: None,
            created_at_ms: now_ms(),
        };

        assert!(validated_fomo_alert(input(
            "thesis",
            "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a"
        ))
        .is_err());
        assert!(validated_fomo_alert(input("swap_buy", "0x1234")).is_err());

        let (valid_alerts, errors) = validated_fomo_alert_batch(vec![
            input("swap_buy", "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a"),
            input("swap_buy", "0x1234"),
        ]);
        assert_eq!(valid_alerts.len(), 1);
        assert_eq!(errors.len(), 1);
    }

    #[test]
    fn fomo_auth_events_only_accept_https_fomo_hosts() {
        assert!(is_fomo_https_url(
            &tauri::Url::parse("https://fomo.family/").unwrap()
        ));
        assert!(is_fomo_https_url(
            &tauri::Url::parse("https://prod-api.fomo.family/feed/tradingActivity").unwrap()
        ));
        assert!(!is_fomo_https_url(
            &tauri::Url::parse("http://fomo.family/").unwrap()
        ));
        assert!(!is_fomo_https_url(
            &tauri::Url::parse("https://fomo.family.example.com/").unwrap()
        ));
    }

    #[test]
    fn fomo_stream_events_validate_status_and_bound_client_timestamps() {
        let captured_at_ms = 1_800_000;
        let event = validated_fomo_stream_event(
            DappSubmitFomoStreamRequest {
                url: "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a".to_string(),
                status: "reconnecting".to_string(),
                activity_source: None,
                observed_item_count: None,
                normalized_alert_count: None,
                observed_types: None,
                last_activity_at_ms: Some(captured_at_ms - 30_000),
                retry_at_ms: Some(captured_at_ms + 15_000),
                attempt: 2,
            },
            captured_at_ms,
        )
        .unwrap();

        assert_eq!(event.tab_id, FOMO_ALERTS_TAB_ID);
        assert_eq!(event.status, "reconnecting");
        assert_eq!(event.last_activity_at_ms, Some(captured_at_ms - 30_000));
        assert_eq!(event.retry_at_ms, Some(captured_at_ms + 15_000));
        assert_eq!(event.attempt, 2);

        assert!(validated_fomo_stream_event(
            DappSubmitFomoStreamRequest {
                url: "https://example.com/".to_string(),
                status: "connected".to_string(),
                activity_source: None,
                observed_item_count: None,
                normalized_alert_count: None,
                observed_types: None,
                last_activity_at_ms: None,
                retry_at_ms: None,
                attempt: 0,
            },
            captured_at_ms,
        )
        .is_err());
        assert!(validated_fomo_stream_event(
            DappSubmitFomoStreamRequest {
                url: "https://fomo.family/".to_string(),
                status: "healthy".to_string(),
                activity_source: None,
                observed_item_count: None,
                normalized_alert_count: None,
                observed_types: None,
                last_activity_at_ms: None,
                retry_at_ms: None,
                attempt: 0,
            },
            captured_at_ms,
        )
        .is_err());
    }

    #[test]
    fn fomo_profile_handles_are_normalized_without_using_x_limits() {
        assert_eq!(
            normalized_fomo_handle("@Long_Fomo_Profile_Handle_123"),
            Some("long_fomo_profile_handle_123".to_string())
        );
        assert_eq!(normalized_fomo_handle("bad-handle"), None);
        assert_eq!(normalized_fomo_handle(""), None);
    }

    #[test]
    fn fomo_auth_popups_are_limited_to_expected_providers() {
        for url in [
            "about:blank",
            "https://auth.privy.io/api/v1/oauth/init",
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://appleid.apple.com/auth/authorize",
        ] {
            assert!(is_fomo_auth_popup_url(&tauri::Url::parse(url).unwrap()));
        }
        for url in [
            "http://auth.privy.io/api/v1/oauth/init",
            "https://privy.io.example.com/",
            "https://accounts.google.com.example.com/",
            "https://example.com/",
        ] {
            assert!(!is_fomo_auth_popup_url(&tauri::Url::parse(url).unwrap()));
        }
    }

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
        assert!(parse_dapp_browser_url("https://@example.com").is_err());
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
        let credentialed = "https://user:pass@pump.fun/coin/example".parse().unwrap();
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
            &credentialed
        ));
        assert!(!is_allowed_connected_dapp_navigation_url(
            &pumpfun,
            &other_https
        ));
    }

    #[test]
    fn dapp_disconnect_matching_is_exact_for_origin_wallet_and_network() {
        let session = DappSession {
            app_id: "pumpfun".to_string(),
            app_name: "Pump.fun".to_string(),
            url: "https://pump.fun/coin/example?source=wallet".to_string(),
            wallet_family: "solana".to_string(),
            wallet_public_key: "wallet-a".to_string(),
            network: "mainnet".to_string(),
            opened_at_ms: now_ms(),
        };

        assert!(dapp_session_matches_permission(
            &session,
            "https://pump.fun",
            "wallet-a",
            "MAINNET"
        ));
        assert!(!dapp_session_matches_permission(
            &session,
            "https://example.com",
            "wallet-a",
            "mainnet"
        ));
        assert!(!dapp_session_matches_permission(
            &session,
            "https://pump.fun",
            "wallet-b",
            "mainnet"
        ));
        assert!(!dapp_session_matches_permission(
            &session,
            "https://pump.fun",
            "wallet-a",
            "devnet"
        ));

        let sign_request = DappSignRequestEvent {
            request_id: "sign-1".to_string(),
            app_id: "pumpfun".to_string(),
            app_name: "Pump.fun".to_string(),
            app_url: session.url.clone(),
            request_purpose: None,
            method: "signMessage".to_string(),
            wallet_family: "solana".to_string(),
            wallet_public_key: session.wallet_public_key.clone(),
            network: session.network.clone(),
            transaction_base64: String::new(),
            transaction_format: "message".to_string(),
            message_base64: Some("aGVsbG8=".to_string()),
            payload_json: None,
            callback_url: None,
            known_programs: Vec::new(),
            created_at_ms: now_ms(),
        };
        assert!(dapp_sign_request_matches_permission(
            &sign_request,
            "https://pump.fun",
            "wallet-a",
            "mainnet"
        ));
        assert!(!dapp_sign_request_matches_permission(
            &sign_request,
            "https://pump.fun",
            "wallet-b",
            "mainnet"
        ));

        let connect_request = DappConnectRequestEvent {
            request_id: "connect-1".to_string(),
            app_id: "fnzsafe-deep-link".to_string(),
            app_name: "Pump.fun".to_string(),
            app_url: session.url,
            wallet_family: "solana".to_string(),
            wallet_public_key: None,
            network: session.network,
            callback_url: Some("https://pump.fun/wallet/callback".to_string()),
            created_at_ms: now_ms(),
        };
        assert!(dapp_connect_request_matches_permission(
            &connect_request,
            "https://pump.fun",
            "wallet-a",
            "mainnet"
        ));
        assert!(!dapp_connect_request_matches_permission(
            &connect_request,
            "https://pump.fun",
            "wallet-a",
            "devnet"
        ));

        let evm_connect_request = DappConnectRequestEvent {
            wallet_family: "evm".to_string(),
            wallet_public_key: Some("0x1111111111111111111111111111111111111111".to_string()),
            network: "eip155:4663".to_string(),
            ..connect_request
        };
        assert!(dapp_connect_request_matches_permission(
            &evm_connect_request,
            "https://pump.fun",
            "0x1111111111111111111111111111111111111111",
            "EIP155:4663"
        ));
        assert!(!dapp_connect_request_matches_permission(
            &evm_connect_request,
            "https://pump.fun",
            "0x2222222222222222222222222222222222222222",
            "eip155:4663"
        ));
    }

    #[test]
    fn resolved_dapp_requests_cannot_be_completed_twice() {
        let resolved = Some(DappSignResult {
            approved: true,
            error: None,
            public_key: Some("wallet-a".to_string()),
            signature: None,
            raw_transaction: None,
            recent_blockhash: None,
        });
        assert!(ensure_dapp_result_pending(&None, "dapp request").is_ok());
        assert_eq!(
            ensure_dapp_result_pending(&resolved, "dapp request").unwrap_err(),
            "dapp request is already resolved"
        );
    }

    #[test]
    fn resolved_connect_result_survives_recovery_pruning_until_webview_consumes_it() {
        let current_time_ms = DAPP_REQUEST_TTL_MS + 10_000;
        let connect_event = |request_id: &str, created_at_ms: u64| DappConnectRequestEvent {
            request_id: request_id.to_string(),
            app_id: "web:app.uniswap.org".to_string(),
            app_name: "app.uniswap.org".to_string(),
            app_url: "https://app.uniswap.org/".to_string(),
            wallet_family: "evm".to_string(),
            wallet_public_key: Some("0x1111111111111111111111111111111111111111".to_string()),
            network: "eip155:4663".to_string(),
            callback_url: None,
            created_at_ms,
        };
        let mut requests = HashMap::from([
            (
                "approved".to_string(),
                DappPendingConnectRequest {
                    webview_label: Some("dapp-tab-uniswap".to_string()),
                    event: connect_event("approved", current_time_ms),
                    result: Some(DappSignResult {
                        approved: true,
                        error: None,
                        public_key: Some("0x1111111111111111111111111111111111111111".to_string()),
                        signature: None,
                        raw_transaction: None,
                        recent_blockhash: None,
                    }),
                },
            ),
            (
                "expired".to_string(),
                DappPendingConnectRequest {
                    webview_label: Some("dapp-tab-expired".to_string()),
                    event: connect_event("expired", 0),
                    result: None,
                },
            ),
        ]);

        prune_expired_dapp_connect_requests(&mut requests, current_time_ms);

        assert!(requests.contains_key("approved"));
        assert!(!requests.contains_key("expired"));
        assert_eq!(
            requests
                .values()
                .filter(|pending| pending.result.is_none())
                .count(),
            0
        );
    }

    #[test]
    fn wallet_disconnect_keeps_other_wallet_sessions() {
        let state = DappBridgeState::default();
        let session = |wallet_public_key: &str| DappSession {
            app_id: "pumpfun".to_string(),
            app_name: "Pump.fun".to_string(),
            url: "https://pump.fun".to_string(),
            wallet_family: "solana".to_string(),
            wallet_public_key: wallet_public_key.to_string(),
            network: "mainnet".to_string(),
            opened_at_ms: now_ms(),
        };
        {
            let mut sessions = state.sessions.lock().unwrap();
            sessions.insert("wallet-a-tab".to_string(), session("wallet-a"));
            sessions.insert("wallet-b-tab".to_string(), session("wallet-b"));
        }
        disconnect_dapp_wallet_state(&state, "wallet-a", || Ok(())).unwrap();
        let sessions = state.sessions.lock().unwrap();
        assert!(!sessions.contains_key("wallet-a-tab"));
        assert!(sessions.contains_key("wallet-b-tab"));
    }

    #[test]
    fn connection_disconnect_keeps_memory_state_when_permission_revoke_fails() {
        let state = DappBridgeState::default();
        state.sessions.lock().unwrap().insert(
            "wallet-a-tab".to_string(),
            DappSession {
                app_id: "pumpfun".to_string(),
                app_name: "Pump.fun".to_string(),
                url: "https://pump.fun".to_string(),
                wallet_family: "solana".to_string(),
                wallet_public_key: "wallet-a".to_string(),
                network: "mainnet".to_string(),
                opened_at_ms: now_ms(),
            },
        );

        let result = disconnect_dapp_connection_state(
            &state,
            "https://pump.fun",
            "wallet-a",
            "mainnet",
            || Err::<bool, _>("database unavailable".to_string()),
        );

        assert!(result.is_err());
        assert!(state.sessions.lock().unwrap().contains_key("wallet-a-tab"));
    }

    #[test]
    fn wallet_disconnect_keeps_memory_state_when_permission_revoke_fails() {
        let state = DappBridgeState::default();
        state.sessions.lock().unwrap().insert(
            "wallet-a-tab".to_string(),
            DappSession {
                app_id: "pumpfun".to_string(),
                app_name: "Pump.fun".to_string(),
                url: "https://pump.fun".to_string(),
                wallet_family: "solana".to_string(),
                wallet_public_key: "wallet-a".to_string(),
                network: "mainnet".to_string(),
                opened_at_ms: now_ms(),
            },
        );

        let result = disconnect_dapp_wallet_state(&state, "wallet-a", || {
            Err::<usize, _>("database unavailable".to_string())
        });

        assert!(result.is_err());
        assert!(state.sessions.lock().unwrap().contains_key("wallet-a-tab"));
    }

    #[test]
    fn paused_dapp_bridge_rejects_new_work_until_resumed() {
        let state = DappBridgeState::default();
        state.sessions.lock().unwrap().insert(
            "existing-tab".to_string(),
            DappSession {
                app_id: "pumpfun".to_string(),
                app_name: "Pump.fun".to_string(),
                url: "https://pump.fun".to_string(),
                wallet_family: "solana".to_string(),
                wallet_public_key: "wallet-a".to_string(),
                network: "mainnet".to_string(),
                opened_at_ms: now_ms(),
            },
        );
        assert!(ensure_dapp_connections_active(&state).is_err());
        state.paused.store(false, Ordering::Release);
        assert!(ensure_dapp_connections_active(&state).is_ok());
        pause_dapp_connections(&state).unwrap();
        assert!(ensure_dapp_connections_active(&state).is_err());
        assert!(state.sessions.lock().unwrap().contains_key("existing-tab"));
        state.paused.store(false, Ordering::Release);
        assert!(ensure_dapp_connections_active(&state).is_ok());
        assert!(state.sessions.lock().unwrap().contains_key("existing-tab"));
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
        assert!(!is_safe_dapp_webview_navigation_url(&data_page));
    }

    #[test]
    fn user_entered_dapp_navigation_accepts_safe_web_origins() {
        let uniswap = "https://app.uniswap.org/swap".parse().unwrap();
        let localhost = "http://localhost:3000/".parse().unwrap();
        let insecure_remote = "http://example.com/".parse().unwrap();

        assert!(is_safe_dapp_webview_navigation_url(&uniswap));
        assert!(is_safe_dapp_webview_navigation_url(&localhost));
        assert!(!is_safe_dapp_webview_navigation_url(&insecure_remote));
    }

    #[test]
    fn user_entered_dapp_session_tracks_the_current_origin() {
        let mut session = DappSession {
            app_id: "web:example.com".to_string(),
            app_name: "example.com".to_string(),
            url: "https://example.com/".to_string(),
            wallet_family: "solana".to_string(),
            wallet_public_key: "11111111111111111111111111111111".to_string(),
            network: "mainnet".to_string(),
            opened_at_ms: now_ms(),
        };
        let target = "https://app.uniswap.org/swap".parse().unwrap();

        update_dapp_session_navigation(&mut session, &target);

        assert_eq!(session.url, "https://app.uniswap.org/swap");
        assert_eq!(session.app_id, "web:app.uniswap.org");
        assert_eq!(session.app_name, "app.uniswap.org");
    }

    #[test]
    fn dapp_requests_use_validated_session_url_without_querying_cef() {
        let tracked_url = "https://app.uniswap.org/swap";

        assert_eq!(
            dapp_session_request_url(tracked_url).unwrap().as_str(),
            tracked_url
        );
        assert!(dapp_session_request_url("http://example.com/").is_none());
    }

    #[test]
    fn evm_provider_announces_fnzsafe_with_the_selected_chain() {
        let address = "0x1111111111111111111111111111111111111111";
        let script = evm_dapp_provider_script(address, "eip155:4663").unwrap();
        assert!(script.contains("eip6963:announceProvider"));
        assert!(script.contains("eip6963:requestProvider"));
        assert!(script.contains("Object.defineProperty(window, \"ethereum\""));
        assert!(script.contains(address));
        assert!(script.contains("0x1237"));
        assert!(script.contains("eth_requestAccounts"));
        assert!(script.contains("dapp_submit_connect_request"));
        assert!(script.contains("dapp_poll_connect_request"));
        assert!(script.contains("eth_sendTransaction"));
    }

    #[test]
    fn solana_provider_supports_user_entered_dapps_without_exposing_the_account() {
        let script = solana_dapp_provider_script(
            "web:example.com",
            "example.com",
            "11111111111111111111111111111111",
            "mainnet",
        )
        .unwrap();
        assert!(script.contains("web:example.com"));
        assert!(script.contains("let connected = false"));
        assert!(script.contains("dapp_submit_connect_request"));
        assert!(script.contains("dapp_poll_connect_request"));
        assert!(script.contains("wallet-standard:register-wallet"));
        assert!(script.contains("Object.defineProperty(window, \"solana\""));
        assert!(
            script
                .matches("if (!connected) await requestConnection();")
                .count()
                >= 7
        );
    }

    #[test]
    fn evm_provider_and_signing_payload_validation_reject_malformed_input() {
        assert!(evm_dapp_provider_script("not-an-address", "eip155:1").is_err());
        assert!(
            evm_dapp_provider_script("0x1111111111111111111111111111111111111111", "mainnet")
                .is_err()
        );
        assert!(validate_evm_dapp_method("eth_sendTransaction").is_ok());
        assert!(validate_evm_dapp_method("eth_sendRawTransaction").is_err());
        assert!(validate_evm_payload_json(r#"[{"from":"0x111"}]"#).is_ok());
        assert!(validate_evm_payload_json("not-json").is_err());
        assert!(validate_evm_payload_json("\"scalar\"").is_err());
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
        assert_eq!(request.wallet_family, "solana");
        assert_eq!(
            request.callback_url.as_deref(),
            Some("http://localhost:5174/wallet/callback")
        );
    }

    #[test]
    fn connect_deep_link_parses_evm_family_and_network() {
        let url = "fnzsafe://connect?wallet_family=evm&network=eip155:56&app_name=CoinBest&app_url=https%3A%2F%2Fcoinbest.example%2F&callback_url=https%3A%2F%2Fcoinbest.example%2Fwallet%2Fcallback&request_id=req-evm"
            .parse::<tauri::Url>()
            .unwrap();

        let request = parse_connect_deep_link(&url).unwrap();
        assert_eq!(request.wallet_family, "evm");
        assert_eq!(request.network, "eip155:56");
        assert_eq!(request.request_id, "req-evm");
    }

    #[test]
    fn sign_deep_link_parses_evm_personal_sign() {
        let payload = "%7B%22method%22%3A%22personal_sign%22%2C%22params%22%3A%5B%220x68656c6c6f%22%2C%220x1111111111111111111111111111111111111111%22%5D%7D";
        let url = format!(
            "fnzsafe://sign?wallet_family=evm&method=personal_sign&wallet_public_key=0x1111111111111111111111111111111111111111&network=eip155:1&payload_json={payload}&app_url=https%3A%2F%2Fexample.com%2F&callback_url=https%3A%2F%2Fexample.com%2Fwallet%2Fcallback"
        )
        .parse::<tauri::Url>()
        .unwrap();

        let request = parse_sign_deep_link(&url).unwrap();
        assert_eq!(request.wallet_family, "evm");
        assert_eq!(request.method, "personal_sign");
        assert_eq!(request.network, "eip155:1");
        assert_eq!(request.transaction_format, "evm-json");
        assert!(request
            .payload_json
            .as_deref()
            .unwrap_or_default()
            .contains("personal_sign"));
    }

    #[test]
    fn sign_deep_link_rejects_solana_method_for_evm_family() {
        let url = "fnzsafe://sign?wallet_family=evm&method=signMessage&wallet_public_key=0x1111111111111111111111111111111111111111&network=eip155:1&payload_json=%5B%5D&app_url=https%3A%2F%2Fexample.com%2F"
            .parse::<tauri::Url>()
            .unwrap();
        let error = parse_sign_deep_link(&url).unwrap_err();
        assert!(error.contains("unsupported EVM"));
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

        let app_url = "https://tenant.github.io/app".parse().unwrap();
        assert!(validate_deep_link_callback_url(
            Some("https://github.io/callback".to_string()),
            &app_url,
        )
        .is_err());
        assert!(validate_deep_link_callback_url(
            Some("https://user:secret@tenant.github.io/callback".to_string()),
            &app_url,
        )
        .is_err());
        assert!(validate_deep_link_callback_url(
            Some("https://@tenant.github.io/callback".to_string()),
            &app_url,
        )
        .is_err());
        assert_eq!(
            validate_deep_link_callback_url(
                Some("https://auth.tenant.github.io/callback".to_string()),
                &app_url,
            )
            .unwrap()
            .as_deref(),
            Some("https://auth.tenant.github.io/callback")
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
