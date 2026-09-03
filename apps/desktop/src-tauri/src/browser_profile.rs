use aes::Aes128;
#[cfg(target_os = "windows")]
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
#[cfg(target_os = "windows")]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use pbkdf2::pbkdf2_hmac;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    ops::Deref,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc,
    time::Duration,
};
use tauri::webview::Cookie;
use tauri::{Manager, WebviewUrl};
use tempfile::TempDir;
use zeroize::{Zeroize, Zeroizing};

const BROWSER_CREDENTIAL_SERVICE: &str = "dev.fnzero-safe.browser.credentials.v1";
const BROWSER_CREDENTIALS_FILE: &str = "browser-credentials.json";
const CHROME_EPOCH_OFFSET_SECONDS: i64 = 11_644_473_600;
const MAX_IMPORT_COOKIES: usize = 100_000;
const MAX_IMPORT_PASSWORDS: usize = 20_000;
const MAX_IMPORT_HISTORY: usize = 10_000;
const CEF_COOKIE_BATCH_SIZE: usize = 500;
const CEF_COOKIE_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Deserialize)]
pub struct ChromeImportRequest {
    pub profile_id: String,
    #[serde(default)]
    pub cookies: bool,
    #[serde(default)]
    pub passwords: bool,
    #[serde(default)]
    pub history: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChromeProfileInfo {
    pub id: String,
    pub name: String,
    pub chrome_name: String,
    pub has_cookies: bool,
    pub has_passwords: bool,
    pub has_history: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct BrowserHistoryEntry {
    pub url: String,
    pub title: String,
    pub visited_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChromeImportResult {
    pub cookies_imported: usize,
    pub passwords_imported: usize,
    pub history_imported: usize,
    pub cookies_skipped: usize,
    pub passwords_skipped: usize,
    pub history: Vec<BrowserHistoryEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredBrowserCredential {
    id: String,
    origin: String,
    username: String,
    updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protected_password: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BrowserCredentialSummary {
    pub id: String,
    pub origin: String,
    pub username: String,
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct BrowserAutofillResult {
    pub filled: bool,
    pub origin: String,
    pub username: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct BrowserContact {
    #[serde(default)]
    full_name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    address: String,
}

#[derive(Clone, Debug)]
struct ImportedCookie {
    host: String,
    name: String,
    value: String,
    path: String,
    expires_at: Option<i64>,
    secure: bool,
    http_only: bool,
    same_site: i64,
}

impl Drop for ImportedCookie {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Debug)]
struct ImportedPassword {
    origin: String,
    username: String,
    password: String,
    updated_at_ms: u64,
}

impl Drop for ImportedPassword {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn chrome_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or_else(|| "HOME is unavailable".to_string())?;
        Ok(PathBuf::from(home).join("Library/Application Support/Google/Chrome"))
    }
    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
        Ok(PathBuf::from(local_app_data).join("Google/Chrome/User Data"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Chrome import is currently supported on macOS and Windows".to_string())
    }
}

fn safe_profile_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 80
        || value.contains('/')
        || value.contains('\\')
        || value == "."
        || value == ".."
        || value.chars().any(char::is_control)
    {
        return Err("invalid Chrome profile".to_string());
    }
    Ok(value.to_string())
}

fn profile_path(profile_id: &str) -> Result<PathBuf, String> {
    let root = chrome_root()?;
    let profile_id = safe_profile_id(profile_id)?;
    let path = root.join(profile_id);
    if !path.is_dir() {
        return Err("Chrome profile is unavailable".to_string());
    }
    Ok(path)
}

fn profile_cookie_path(profile: &Path) -> PathBuf {
    let network = profile.join("Network/Cookies");
    if network.is_file() {
        network
    } else {
        profile.join("Cookies")
    }
}

#[tauri::command]
pub fn browser_chrome_profiles() -> Result<Vec<ChromeProfileInfo>, String> {
    let root = chrome_root()?;
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let local_state = fs::read(root.join("Local State"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let info_cache = local_state
        .as_ref()
        .and_then(|value| value.pointer("/profile/info_cache"))
        .and_then(serde_json::Value::as_object);
    let mut profiles = Vec::new();
    for entry in
        fs::read_dir(&root).map_err(|error| format!("failed to read Chrome profiles: {error}"))?
    {
        let entry = entry.map_err(|error| format!("failed to read Chrome profile: {error}"))?;
        let id = entry.file_name().to_string_lossy().to_string();
        if id != "Default" && !id.starts_with("Profile ") {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let has_cookies = profile_cookie_path(&path).is_file();
        let has_passwords = path.join("Login Data").is_file();
        let has_history = path.join("History").is_file();
        if !(has_cookies || has_passwords || has_history) {
            continue;
        }
        let cached = info_cache.and_then(|cache| cache.get(&id));
        let name = cached
            .and_then(|value| value.get("name"))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&id)
            .to_string();
        let chrome_name = cached
            .and_then(|value| value.get("user_name"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        profiles.push(ChromeProfileInfo {
            id,
            name,
            chrome_name,
            has_cookies,
            has_passwords,
            has_history,
        });
    }
    profiles.sort_by_key(|profile| {
        if profile.id == "Default" {
            String::new()
        } else {
            profile.id.clone()
        }
    });
    Ok(profiles)
}

struct ChromeDatabase {
    connection: Connection,
    _snapshot: Option<TempDir>,
}

impl Deref for ChromeDatabase {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

fn configure_chrome_database(
    connection: &Connection,
    busy_timeout: Duration,
) -> rusqlite::Result<()> {
    connection.busy_timeout(busy_timeout)?;
    connection.query_row("SELECT COUNT(*) FROM sqlite_master", [], |_| Ok(()))
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn copy_chrome_database_snapshot(path: &Path) -> Result<ChromeDatabase, String> {
    let mut last_error = None;
    for _ in 0..3 {
        let snapshot = tempfile::Builder::new()
            .prefix("fnzsafe-chrome-import-")
            .tempdir()
            .map_err(|error| format!("failed to create Chrome database snapshot: {error}"))?;
        let file_name = path
            .file_name()
            .ok_or_else(|| "invalid Chrome database path".to_string())?;
        let snapshot_path = snapshot.path().join(file_name);
        if let Err(error) = fs::copy(path, &snapshot_path) {
            last_error = Some(format!("failed to copy Chrome database: {error}"));
            continue;
        }
        let mut companion_error = None;
        for suffix in ["-journal", "-wal", "-shm"] {
            let source = path_with_suffix(path, suffix);
            if source.is_file() {
                let destination = path_with_suffix(&snapshot_path, suffix);
                if let Err(error) = fs::copy(&source, destination) {
                    companion_error =
                        Some(format!("failed to copy Chrome database {suffix}: {error}"));
                    break;
                }
            }
        }
        if let Some(error) = companion_error {
            last_error = Some(error);
            continue;
        }
        match Connection::open(&snapshot_path).and_then(|connection| {
            configure_chrome_database(&connection, Duration::from_secs(2))?;
            Ok(connection)
        }) {
            Ok(connection) => {
                return Ok(ChromeDatabase {
                    connection,
                    _snapshot: Some(snapshot),
                });
            }
            Err(error) => {
                last_error = Some(format!("failed to open Chrome database snapshot: {error}"))
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(last_error.unwrap_or_else(|| "failed to snapshot Chrome database".to_string()))
}

fn open_chrome_database(path: &Path) -> Result<ChromeDatabase, String> {
    let direct = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    );
    match direct.and_then(|connection| {
        configure_chrome_database(&connection, Duration::from_millis(300))?;
        Ok(connection)
    }) {
        Ok(connection) => Ok(ChromeDatabase {
            connection,
            _snapshot: None,
        }),
        Err(direct_error) => copy_chrome_database_snapshot(path).map_err(|snapshot_error| {
            format!(
                "failed to read {} while Chrome is running ({direct_error}); {snapshot_error}",
                path.display()
            )
        }),
    }
}

#[cfg(target_os = "macos")]
fn chrome_secret() -> Result<Vec<u8>, String> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    generic_password(PasswordOptions::new_generic_password(
        "Chrome Safe Storage",
        "Chrome",
    ))
    .map_err(|error| format!("failed to read Chrome Safe Storage from Keychain: {error}"))
}

#[cfg(target_os = "windows")]
pub(crate) fn dpapi_unprotect(value: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!(
            "Windows DPAPI failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}

#[cfg(target_os = "windows")]
pub(crate) fn dpapi_protect(value: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!(
            "Windows DPAPI failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}

#[cfg(target_os = "windows")]
fn chrome_secret() -> Result<Vec<u8>, String> {
    let state = fs::read(chrome_root()?.join("Local State"))
        .map_err(|error| format!("failed to read Chrome Local State: {error}"))?;
    let state: serde_json::Value = serde_json::from_slice(&state)
        .map_err(|error| format!("invalid Chrome Local State: {error}"))?;
    let encrypted = state
        .pointer("/os_crypt/encrypted_key")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Chrome encryption key is unavailable".to_string())?;
    let encrypted = BASE64
        .decode(encrypted)
        .map_err(|error| format!("invalid Chrome encryption key: {error}"))?;
    let encrypted = encrypted.strip_prefix(b"DPAPI").unwrap_or(&encrypted);
    dpapi_unprotect(encrypted)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn chrome_secret() -> Result<Vec<u8>, String> {
    Err("Chrome decryption is currently supported on macOS and Windows".to_string())
}

#[cfg(target_os = "macos")]
fn decrypt_chrome_value(
    encrypted: &[u8],
    secret: &[u8],
    host: Option<&str>,
) -> Result<Vec<u8>, String> {
    if encrypted.is_empty() {
        return Ok(Vec::new());
    }
    let payload = encrypted
        .strip_prefix(b"v10")
        .or_else(|| encrypted.strip_prefix(b"v11"))
        .ok_or_else(|| "unsupported Chrome encrypted value".to_string())?;
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(secret, b"saltysalt", 1003, &mut key);
    let mut plaintext = cbc::Decryptor::<Aes128>::new_from_slices(&key, &[b' '; 16])
        .map_err(|_| "failed to initialize Chrome decryption".to_string())?
        .decrypt_padded_vec_mut::<Pkcs7>(payload)
        .map_err(|_| "failed to decrypt Chrome value".to_string())?;
    if let Some(host) = host {
        if plaintext.len() >= 32 {
            let expected = Sha256::digest(host.as_bytes());
            if plaintext[..32] == expected[..] {
                plaintext.drain(..32);
            }
        }
    }
    Ok(plaintext)
}

#[cfg(target_os = "windows")]
fn decrypt_chrome_value(
    encrypted: &[u8],
    secret: &[u8],
    _host: Option<&str>,
) -> Result<Vec<u8>, String> {
    if encrypted.is_empty() {
        return Ok(Vec::new());
    }
    if encrypted.starts_with(b"v10") || encrypted.starts_with(b"v11") {
        if encrypted.len() < 3 + 12 + 16 {
            return Err("invalid Chrome encrypted value".to_string());
        }
        let nonce = Nonce::from_slice(&encrypted[3..15]);
        return Aes256Gcm::new_from_slice(secret)
            .map_err(|_| "invalid Chrome encryption key".to_string())?
            .decrypt(nonce, &encrypted[15..])
            .map_err(|_| "failed to decrypt Chrome value".to_string());
    }
    if encrypted.starts_with(b"v20") {
        return Err(
            "Chrome App-Bound Encryption cannot be imported by this Windows user session"
                .to_string(),
        );
    }
    dpapi_unprotect(encrypted)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn decrypt_chrome_value(
    _encrypted: &[u8],
    _secret: &[u8],
    _host: Option<&str>,
) -> Result<Vec<u8>, String> {
    Err("Chrome decryption is currently supported on macOS and Windows".to_string())
}

fn read_cookies(profile: &Path, secret: &[u8]) -> Result<(Vec<ImportedCookie>, usize), String> {
    let connection = open_chrome_database(&profile_cookie_path(profile))?;
    let has_partition_key = connection
        .prepare("PRAGMA table_info(cookies)")
        .and_then(|mut statement| {
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
            for column in columns {
                if column.as_deref() == Ok("top_frame_site_key") {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .map_err(|error| format!("failed to inspect Chrome cookies: {error}"))?;
    let query = if has_partition_key {
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE top_frame_site_key = '' ORDER BY last_access_utc DESC LIMIT ?1"
    } else {
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies ORDER BY last_access_utc DESC LIMIT ?1"
    };
    let mut skipped = if has_partition_key {
        connection
            .query_row(
                "SELECT COUNT(*) FROM cookies WHERE top_frame_site_key != ''",
                [],
                |row| row.get::<_, usize>(0),
            )
            .unwrap_or_default()
    } else {
        0
    };
    let mut statement = connection
        .prepare(query)
        .map_err(|error| format!("failed to read Chrome cookies: {error}"))?;
    let rows = statement
        .query_map([MAX_IMPORT_COOKIES as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|error| format!("failed to query Chrome cookies: {error}"))?;
    let mut cookies = Vec::new();
    let now_unix = time::OffsetDateTime::now_utc().unix_timestamp();
    for row in rows {
        let Ok((host, name, value, encrypted, path, expires, secure, http_only, same_site)) = row
        else {
            skipped += 1;
            continue;
        };
        let expires_at = if expires > 0 {
            Some(expires / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS)
        } else {
            None
        };
        if expires_at.is_some_and(|expires_at| expires_at <= now_unix) {
            skipped += 1;
            continue;
        }
        let value = if value.is_empty() {
            match decrypt_chrome_value(&encrypted, secret, Some(&host)).and_then(|bytes| {
                String::from_utf8(bytes).map_err(|_| "cookie is not UTF-8".to_string())
            }) {
                Ok(value) => value,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            }
        } else {
            value
        };
        if name.is_empty() || host.is_empty() {
            skipped += 1;
            continue;
        }
        cookies.push(ImportedCookie {
            host,
            name,
            value,
            path,
            expires_at,
            secure: secure != 0,
            http_only: http_only != 0,
            same_site,
        });
    }
    Ok((cookies, skipped))
}

fn url_origin(value: &str) -> Option<String> {
    let url = value.parse::<tauri::Url>().ok()?;
    let host = url.host_str()?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!(
        "{}://{}{}",
        url.scheme(),
        host.to_ascii_lowercase(),
        port
    ))
}

fn read_passwords(profile: &Path, secret: &[u8]) -> Result<(Vec<ImportedPassword>, usize), String> {
    let connection = open_chrome_database(&profile.join("Login Data"))?;
    let mut statement = connection.prepare(
        "SELECT origin_url, username_value, password_value, date_last_used FROM logins WHERE length(password_value) > 0 ORDER BY date_last_used DESC LIMIT ?1"
    ).map_err(|error| format!("failed to read Chrome passwords: {error}"))?;
    let rows = statement
        .query_map([MAX_IMPORT_PASSWORDS as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| format!("failed to query Chrome passwords: {error}"))?;
    let mut passwords = Vec::new();
    let mut skipped = 0;
    for row in rows {
        let Ok((origin_url, username, encrypted, updated)) = row else {
            skipped += 1;
            continue;
        };
        let Some(origin) = url_origin(&origin_url) else {
            skipped += 1;
            continue;
        };
        let Ok(password) = decrypt_chrome_value(&encrypted, secret, None).and_then(|bytes| {
            String::from_utf8(bytes).map_err(|_| "password is not UTF-8".to_string())
        }) else {
            skipped += 1;
            continue;
        };
        if password.is_empty() {
            skipped += 1;
            continue;
        }
        let updated_at_ms = if updated > 0 {
            ((updated / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS).max(0) as u64) * 1000
        } else {
            now_ms()
        };
        passwords.push(ImportedPassword {
            origin,
            username,
            password,
            updated_at_ms,
        });
    }
    Ok((passwords, skipped))
}

fn read_history(profile: &Path) -> Result<Vec<BrowserHistoryEntry>, String> {
    let connection = open_chrome_database(&profile.join("History"))?;
    let mut statement = connection.prepare(
        "SELECT url, title, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?1"
    ).map_err(|error| format!("failed to read Chrome history: {error}"))?;
    let rows = statement
        .query_map([MAX_IMPORT_HISTORY as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| format!("failed to query Chrome history: {error}"))?;
    let mut history = Vec::new();
    for (url, title, visited) in rows.flatten() {
        if url_origin(&url).is_none() {
            continue;
        }
        let visited_at_ms =
            ((visited / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS).max(0) as u64) * 1000;
        history.push(BrowserHistoryEntry {
            url,
            title,
            visited_at_ms,
        });
    }
    Ok(history)
}

fn credentials_path(app: &crate::DesktopAppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve browser data directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create browser data directory: {error}"))?;
    Ok(directory.join(BROWSER_CREDENTIALS_FILE))
}

fn load_credentials(app: &crate::DesktopAppHandle) -> Result<Vec<StoredBrowserCredential>, String> {
    let path = credentials_path(app)?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("failed to read browser credentials: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid browser credential metadata: {error}"))
}

fn save_credentials(
    app: &crate::DesktopAppHandle,
    credentials: &[StoredBrowserCredential],
) -> Result<(), String> {
    let path = credentials_path(app)?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(credentials)
        .map_err(|error| format!("failed to encode browser credentials: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("failed to save browser credentials: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to protect browser credentials: {error}"))?;
        fs::rename(&temporary, &path)
            .map_err(|error| format!("failed to replace browser credentials: {error}"))
    }
    #[cfg(windows)]
    {
        let bytes = fs::read(&temporary)
            .map_err(|error| format!("failed to finalize browser credentials: {error}"))?;
        fs::write(&path, bytes)
            .map_err(|error| format!("failed to replace browser credentials: {error}"))?;
        let _ = fs::remove_file(&temporary);
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        fs::rename(&temporary, &path)
            .map_err(|error| format!("failed to replace browser credentials: {error}"))
    }
}

fn credential_id(origin: &str, username: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{origin}\0{username}").as_bytes())
    )
}

#[cfg(target_os = "macos")]
fn store_password(id: &str, password: &str) -> Result<Option<String>, String> {
    use security_framework::passwords::{delete_generic_password, set_generic_password};
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    if let Err(error) = delete_generic_password(BROWSER_CREDENTIAL_SERVICE, id) {
        if error.code() != ERR_SEC_ITEM_NOT_FOUND {
            return Err(format!(
                "failed to replace browser password in Keychain: {error}"
            ));
        }
    }
    set_generic_password(BROWSER_CREDENTIAL_SERVICE, id, password.as_bytes())
        .map_err(|error| format!("failed to save browser password in Keychain: {error}"))?;
    Ok(None)
}

#[cfg(target_os = "macos")]
fn load_password(credential: &StoredBrowserCredential) -> Result<String, String> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    let value = generic_password(PasswordOptions::new_generic_password(
        BROWSER_CREDENTIAL_SERVICE,
        &credential.id,
    ))
    .map_err(|error| format!("failed to read browser password from Keychain: {error}"))?;
    String::from_utf8(value).map_err(|_| "browser password is not UTF-8".to_string())
}

#[cfg(target_os = "macos")]
fn delete_password(credential: &StoredBrowserCredential) -> Result<(), String> {
    use security_framework::passwords::delete_generic_password;
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    match delete_generic_password(BROWSER_CREDENTIAL_SERVICE, &credential.id) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(error) => Err(format!(
            "failed to delete browser password from Keychain: {error}"
        )),
    }
}

#[cfg(target_os = "windows")]
fn store_password(_id: &str, password: &str) -> Result<Option<String>, String> {
    Ok(Some(BASE64.encode(dpapi_protect(password.as_bytes())?)))
}

#[cfg(target_os = "windows")]
fn load_password(credential: &StoredBrowserCredential) -> Result<String, String> {
    let protected = credential
        .protected_password
        .as_deref()
        .ok_or_else(|| "browser password is unavailable".to_string())?;
    let protected = BASE64
        .decode(protected)
        .map_err(|error| format!("invalid browser password: {error}"))?;
    String::from_utf8(dpapi_unprotect(&protected)?)
        .map_err(|_| "browser password is not UTF-8".to_string())
}

#[cfg(target_os = "windows")]
fn delete_password(_credential: &StoredBrowserCredential) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn store_password(_id: &str, _password: &str) -> Result<Option<String>, String> {
    Err("browser password storage is unsupported".to_string())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn load_password(_credential: &StoredBrowserCredential) -> Result<String, String> {
    Err("browser password storage is unsupported".to_string())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn delete_password(_credential: &StoredBrowserCredential) -> Result<(), String> {
    Ok(())
}

struct PasswordSecretBackup {
    credential: StoredBrowserCredential,
    password: Option<Zeroizing<String>>,
}

fn backup_password_secret(
    credential: Option<&StoredBrowserCredential>,
    id: &str,
) -> Result<PasswordSecretBackup, String> {
    let credential = credential
        .cloned()
        .unwrap_or_else(|| StoredBrowserCredential {
            id: id.to_string(),
            origin: String::new(),
            username: String::new(),
            updated_at_ms: 0,
            protected_password: None,
        });
    let password = if credential.origin.is_empty() {
        None
    } else {
        Some(Zeroizing::new(load_password(&credential)?))
    };
    Ok(PasswordSecretBackup {
        credential,
        password,
    })
}

fn restore_password_secrets(backups: &[PasswordSecretBackup]) -> Result<(), String> {
    let mut first_error = None;
    for backup in backups.iter().rev() {
        let result = match backup.password.as_deref() {
            Some(password) => store_password(&backup.credential.id, password).map(|_| ()),
            None => delete_password(&backup.credential),
        };
        if first_error.is_none() {
            first_error = result.err();
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn rollback_error(primary: String, rollback: Result<(), String>) -> String {
    match rollback {
        Ok(()) => primary,
        Err(error) => format!("{primary}; credential rollback failed: {error}"),
    }
}

fn import_passwords(
    app: &crate::DesktopAppHandle,
    imported: Vec<ImportedPassword>,
) -> Result<usize, String> {
    let mut stored = load_credentials(app)?;
    let mut seen = HashSet::new();
    let imported = imported
        .into_iter()
        .filter(|password| seen.insert(credential_id(&password.origin, &password.username)))
        .collect::<Vec<_>>();
    let mut backups = Vec::with_capacity(imported.len());
    let mut count = 0;
    for password in imported {
        let id = credential_id(&password.origin, &password.username);
        let existing = stored.iter().find(|item| item.id == id);
        let backup = backup_password_secret(existing, &id)?;
        backups.push(backup);
        let protected_password = store_password(&id, &password.password)
            .map_err(|error| rollback_error(error, restore_password_secrets(&backups)))?;
        let record = StoredBrowserCredential {
            id: id.clone(),
            origin: password.origin.clone(),
            username: password.username.clone(),
            updated_at_ms: password.updated_at_ms,
            protected_password,
        };
        if let Some(existing) = stored.iter_mut().find(|item| item.id == id) {
            *existing = record;
        } else {
            stored.push(record);
        }
        count += 1;
    }
    stored.sort_by_key(|item| std::cmp::Reverse(item.updated_at_ms));
    save_credentials(app, &stored)
        .map_err(|error| rollback_error(error, restore_password_secrets(&backups)))?;
    Ok(count)
}

#[derive(Debug, Eq, Hash, PartialEq)]
struct CookieFingerprint {
    domain: String,
    name: String,
    path: String,
    value: String,
}

fn normalized_cookie_domain(domain: &str) -> String {
    domain.trim_start_matches('.').to_ascii_lowercase()
}

fn cookie_fingerprint(cookie: &Cookie<'_>) -> Option<CookieFingerprint> {
    Some(CookieFingerprint {
        domain: normalized_cookie_domain(cookie.domain()?),
        name: cookie.name().to_string(),
        path: cookie.path().unwrap_or("/").to_string(),
        value: cookie.value().to_string(),
    })
}

fn imported_cookie_fingerprint(cookie: &ImportedCookie) -> CookieFingerprint {
    CookieFingerprint {
        domain: normalized_cookie_domain(&cookie.host),
        name: cookie.name.clone(),
        path: if cookie.path.is_empty() {
            "/".to_string()
        } else {
            cookie.path.clone()
        },
        value: cookie.value.clone(),
    }
}

fn imported_cookie_cdp_param(imported: &ImportedCookie) -> serde_json::Value {
    let mut value = serde_json::json!({
        "name": imported.name,
        "value": imported.value,
        "domain": imported.host,
        "path": if imported.path.is_empty() { "/" } else { &imported.path },
        "secure": imported.secure,
        "httpOnly": imported.http_only,
    });
    let object = value
        .as_object_mut()
        .expect("cookie CDP parameters are always an object");
    if let Some(expires_at) = imported.expires_at {
        object.insert("expires".to_string(), serde_json::json!(expires_at));
    }
    let same_site = match imported.same_site {
        0 => Some("None"),
        1 => Some("Lax"),
        2 => Some("Strict"),
        _ => None,
    };
    if let Some(same_site) = same_site {
        object.insert("sameSite".to_string(), serde_json::json!(same_site));
    }
    value
}

fn missing_imported_cookies(
    expected: &[ImportedCookie],
    actual: Vec<Cookie<'static>>,
) -> Vec<ImportedCookie> {
    let actual = actual
        .iter()
        .filter_map(cookie_fingerprint)
        .collect::<HashSet<_>>();
    expected
        .iter()
        .filter(|cookie| !actual.contains(&imported_cookie_fingerprint(cookie)))
        .cloned()
        .collect()
}

fn set_chromium_cookies(
    webview: &crate::DesktopWebview,
    cookies: &[ImportedCookie],
    first_message_id: i32,
    results: &mpsc::Receiver<(i32, bool)>,
) -> Result<(), String> {
    for (batch_index, batch) in cookies.chunks(CEF_COOKIE_BATCH_SIZE).enumerate() {
        let message_id = first_message_id.saturating_add(batch_index as i32);
        let message = serde_json::json!({
            "id": message_id,
            "method": "Network.setCookies",
            "params": {
                "cookies": batch.iter().map(imported_cookie_cdp_param).collect::<Vec<_>>()
            }
        });
        let message = serde_json::to_vec(&message)
            .map_err(|error| format!("failed to encode Chromium cookie import: {error}"))?;
        webview
            .send_dev_tools_message(&message)
            .map_err(|error| format!("failed to send Chromium cookie import: {error}"))?;

        loop {
            let (completed_id, success) = results
                .recv_timeout(CEF_COOKIE_COMMAND_TIMEOUT)
                .map_err(|_| "Chromium did not confirm the cookie import in time".to_string())?;
            if completed_id != message_id {
                continue;
            }
            if !success {
                return Err("Chromium rejected a cookie import batch".to_string());
            }
            break;
        }
    }
    Ok(())
}

fn set_imported_cookies(
    app: &crate::DesktopAppHandle,
    cookies: Vec<ImportedCookie>,
) -> Result<usize, String> {
    let temporary_label = format!("dapp-cookie-import-{}", now_ms());
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let builder = tauri::WebviewBuilder::new(
        temporary_label,
        WebviewUrl::External(
            "about:blank"
                .parse()
                .map_err(|error| format!("invalid import webview URL: {error}"))?,
        ),
    )
    .data_directory(super::dapp_browser_data_directory(app)?);
    let webview = window
        .add_child(
            builder,
            tauri::LogicalPosition::new(-10_000.0, -10_000.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| format!("failed to create cookie import webview: {error}"))?;
    let _ = webview.hide();

    let result = (|| {
        let (result_tx, result_rx) = mpsc::channel::<(i32, bool)>();
        webview
            .on_dev_tools_protocol(move |protocol| {
                if let tauri::CefDevToolsProtocol::MethodResult {
                    message_id,
                    success,
                    ..
                } = protocol
                {
                    let _ = result_tx.send((message_id, success));
                }
            })
            .map_err(|error| format!("failed to observe Chromium cookie import: {error}"))?;

        set_chromium_cookies(&webview, &cookies, 1_000_000, &result_rx)?;

        let actual = webview
            .cookies()
            .map_err(|error| format!("failed to verify imported Chrome cookies: {error}"))?;
        let missing = missing_imported_cookies(&cookies, actual);
        if missing.is_empty() {
            return Ok(cookies.len());
        }

        set_chromium_cookies(&webview, &missing, 2_000_000, &result_rx)?;
        let actual = webview
            .cookies()
            .map_err(|error| format!("failed to verify retried Chrome cookies: {error}"))?;
        let still_missing = missing_imported_cookies(&missing, actual);
        Ok(cookies.len().saturating_sub(still_missing.len()))
    })();
    let _ = webview.close();
    result
}

#[tauri::command]
pub async fn browser_import_chrome(
    app: crate::DesktopAppHandle,
    request: ChromeImportRequest,
) -> Result<ChromeImportResult, String> {
    if !(request.cookies || request.passwords || request.history) {
        return Err("select at least one data type".to_string());
    }
    let profile = profile_path(&request.profile_id)?;
    let needs_secret = request.cookies || request.passwords;
    let secret = Zeroizing::new(if needs_secret {
        chrome_secret()?
    } else {
        Vec::new()
    });
    let (cookies, mut cookies_skipped) = if request.cookies {
        read_cookies(&profile, &secret)?
    } else {
        (Vec::new(), 0)
    };
    let (passwords, passwords_skipped) = if request.passwords {
        read_passwords(&profile, &secret)?
    } else {
        (Vec::new(), 0)
    };
    let history = if request.history {
        read_history(&profile)?
    } else {
        Vec::new()
    };
    let cookie_count = cookies.len();
    let cookies_imported = if request.cookies {
        set_imported_cookies(&app, cookies)?
    } else {
        0
    };
    cookies_skipped += cookie_count.saturating_sub(cookies_imported);
    let passwords_imported = import_passwords(&app, passwords)?;
    Ok(ChromeImportResult {
        cookies_imported,
        passwords_imported,
        history_imported: history.len(),
        cookies_skipped,
        passwords_skipped,
        history,
    })
}

#[tauri::command]
pub fn browser_passwords_list(
    app: crate::DesktopAppHandle,
) -> Result<Vec<BrowserCredentialSummary>, String> {
    Ok(load_credentials(&app)?
        .into_iter()
        .map(|credential| BrowserCredentialSummary {
            id: credential.id,
            origin: credential.origin,
            username: credential.username,
            updated_at_ms: credential.updated_at_ms,
        })
        .collect())
}

#[tauri::command]
pub fn browser_password_delete(
    app: crate::DesktopAppHandle,
    credential_id: String,
) -> Result<(), String> {
    let mut credentials = load_credentials(&app)?;
    let original = credentials.clone();
    let position = credentials
        .iter()
        .position(|item| item.id == credential_id)
        .ok_or_else(|| "browser password was not found".to_string())?;
    let credential = credentials.remove(position);
    let backup = backup_password_secret(Some(&credential), &credential.id)?;
    save_credentials(&app, &credentials)?;
    if let Err(error) = delete_password(&credential) {
        let secret_rollback = restore_password_secrets(&[backup]);
        let metadata_rollback = save_credentials(&app, &original);
        return Err(rollback_error(
            rollback_error(error, secret_rollback),
            metadata_rollback,
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn browser_passwords_clear(app: crate::DesktopAppHandle) -> Result<(), String> {
    let credentials = load_credentials(&app)?;
    let backups = credentials
        .iter()
        .map(|credential| backup_password_secret(Some(credential), &credential.id))
        .collect::<Result<Vec<_>, _>>()?;
    save_credentials(&app, &[])?;
    for credential in &credentials {
        if let Err(error) = delete_password(credential) {
            let secret_rollback = restore_password_secrets(&backups);
            let metadata_rollback = save_credentials(&app, &credentials);
            return Err(rollback_error(
                rollback_error(error, secret_rollback),
                metadata_rollback,
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_autofill(
    app: crate::DesktopAppHandle,
    tab_id: String,
) -> Result<BrowserAutofillResult, String> {
    let label = super::dapp_tab_label(&tab_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser tab is not open".to_string())?;
    let url = webview
        .url()
        .map_err(|error| format!("failed to read browser URL: {error}"))?;
    let origin = url_origin(url.as_str())
        .ok_or_else(|| "current page cannot use password autofill".to_string())?;
    let credential = load_credentials(&app)?
        .into_iter()
        .filter(|item| item.origin == origin)
        .max_by_key(|item| item.updated_at_ms);
    let Some(credential) = credential else {
        return Ok(BrowserAutofillResult {
            filled: false,
            origin,
            username: None,
        });
    };
    let password = load_password(&credential)?;
    let username_json =
        serde_json::to_string(&credential.username).map_err(|error| error.to_string())?;
    let password_json = serde_json::to_string(&password).map_err(|error| error.to_string())?;
    let script = format!(
        r#"
(() => {{
  const visible = (el) => !el.disabled && el.getClientRects().length > 0;
  const password = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
  if (!password) return;
  const scope = password.closest('form') || document;
  const username = Array.from(scope.querySelectorAll('input')).find((el) =>
    visible(el) && el !== password && (el.autocomplete === 'username' || el.type === 'email' || /user|email|login|account/i.test(`${{el.name}} ${{el.id}}`))
  );
  const setValue = (el, value) => {{
    if (!el) return;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(el, value);
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }};
  setValue(username, {username_json});
  setValue(password, {password_json});
}})();
"#
    );
    webview
        .eval(&script)
        .map_err(|error| format!("failed to autofill current page: {error}"))?;
    Ok(BrowserAutofillResult {
        filled: true,
        origin,
        username: Some(credential.username),
    })
}

#[tauri::command]
pub fn browser_tab_action(
    app: crate::DesktopAppHandle,
    tab_id: String,
    action: String,
    value: Option<String>,
) -> Result<(), String> {
    let label = super::dapp_tab_label(&tab_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser tab is not open".to_string())?;
    match action.as_str() {
        "print" => {
            #[cfg(target_os = "macos")]
            {
                webview
                    .print()
                    .map_err(|error| format!("failed to print page: {error}"))?;
            }
            #[cfg(not(target_os = "macos"))]
            {
                webview
                    .eval("window.print()")
                    .map_err(|error| format!("failed to print page: {error}"))?;
            }
        }
        "zoom" => {
            let zoom = value
                .as_deref()
                .ok_or_else(|| "zoom value is required".to_string())?
                .parse::<f64>()
                .map_err(|_| "invalid zoom value".to_string())?;
            if !(0.25..=5.0).contains(&zoom) {
                return Err("zoom must be between 25% and 500%".to_string());
            }
            webview
                .set_zoom(zoom)
                .map_err(|error| format!("failed to set zoom: {error}"))?;
        }
        "devtools" => webview.open_devtools(),
        "back" => webview
            .eval("history.back()")
            .map_err(|error| format!("failed to navigate back: {error}"))?,
        "forward" => webview
            .eval("history.forward()")
            .map_err(|error| format!("failed to navigate forward: {error}"))?,
        "reload" => webview
            .reload()
            .map_err(|error| format!("failed to reload page: {error}"))?,
        "find" | "find-backward" => {
            let query = value.unwrap_or_default();
            if query.is_empty() || query.chars().count() > 500 {
                return Err("invalid find query".to_string());
            }
            let query = serde_json::to_string(&query).map_err(|error| error.to_string())?;
            let backwards = action == "find-backward";
            webview
                .eval(format!(
                    "window.find({query}, false, {backwards}, true, false, true, false)"
                ))
                .map_err(|error| format!("failed to find in page: {error}"))?;
        }
        "clear-data" => webview
            .clear_all_browsing_data()
            .map_err(|error| format!("failed to clear browser data: {error}"))?,
        "autofill-contact" => {
            let contact: BrowserContact = serde_json::from_str(value.as_deref().unwrap_or("{}"))
                .map_err(|error| format!("invalid contact data: {error}"))?;
            if [
                &contact.full_name,
                &contact.email,
                &contact.phone,
                &contact.address,
            ]
            .iter()
            .any(|item| item.chars().count() > 500)
            {
                return Err("contact field is too long".to_string());
            }
            let contact = serde_json::to_string(&contact).map_err(|error| error.to_string())?;
            webview.eval(format!(r#"
(() => {{
  const data = {contact};
  const visible = (el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0;
  const setValue = (el, value) => {{
    if (!el || !value || String(el.value || '').trim()) return;
    const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }};
  for (const el of document.querySelectorAll('input, textarea')) {{
    if (!visible(el) || el.type === 'password') continue;
    const hint = `${{el.autocomplete}} ${{el.name}} ${{el.id}} ${{el.placeholder}}`.toLowerCase();
    if (/email/.test(hint) || el.type === 'email') setValue(el, data.email);
    else if (/tel|phone|mobile/.test(hint) || el.type === 'tel') setValue(el, data.phone);
    else if (/street-address|address-line|address/.test(hint)) setValue(el, data.address);
    else if (/^name$|full.?name|given-name/.test(hint)) setValue(el, data.full_name);
  }}
}})();
"#)).map_err(|error| format!("failed to autofill contact information: {error}"))?;
        }
        _ => return Err("unsupported browser action".to_string()),
    }
    Ok(())
}

#[tauri::command]
pub fn browser_take_screenshot() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let Some(path) = rfd::FileDialog::new()
            .set_title("Save browser screenshot")
            .set_file_name("FnzSafe-browser.png")
            .save_file()
        else {
            return Ok("cancelled".to_string());
        };
        Command::new("screencapture")
            .args(["-i", path.to_string_lossy().as_ref()])
            .spawn()
            .map_err(|error| format!("failed to start screenshot tool: {error}"))?;
        Ok(path.to_string_lossy().to_string())
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg("ms-screenclip:")
            .spawn()
            .map_err(|error| format!("failed to start Windows screen capture: {error}"))?;
        Ok("clipboard".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("screen capture is currently supported on macOS and Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_ids_cannot_escape_chrome_root() {
        assert!(safe_profile_id("Default").is_ok());
        assert!(safe_profile_id("Profile 12").is_ok());
        assert!(safe_profile_id("../Default").is_err());
        assert!(safe_profile_id("Profile/1").is_err());
    }

    #[test]
    fn chrome_origins_are_normalized() {
        assert_eq!(
            url_origin("https://X.com/login?a=1").as_deref(),
            Some("https://x.com")
        );
        assert_eq!(
            url_origin("https://example.com:8443/a").as_deref(),
            Some("https://example.com:8443")
        );
        assert!(url_origin("file:///tmp/a").is_none());
    }

    #[test]
    fn cookie_verification_accepts_platform_domain_normalization() {
        let imported = ImportedCookie {
            host: ".Example.COM".to_string(),
            name: "session".to_string(),
            value: "verified-value".to_string(),
            path: "/".to_string(),
            expires_at: None,
            secure: true,
            http_only: true,
            same_site: 0,
        };
        let stored = Cookie::build(("session", "verified-value"))
            .domain("example.com")
            .path("/")
            .secure(true)
            .http_only(true)
            .build();

        assert!(missing_imported_cookies(&[imported], vec![stored]).is_empty());
    }

    #[test]
    fn cookie_verification_rejects_mismatched_values() {
        let imported = ImportedCookie {
            host: ".example.com".to_string(),
            name: "session".to_string(),
            value: "expected".to_string(),
            path: "/".to_string(),
            expires_at: None,
            secure: true,
            http_only: true,
            same_site: 0,
        };
        let stored = Cookie::build(("session", "different"))
            .domain(".example.com")
            .path("/")
            .build();

        assert_eq!(missing_imported_cookies(&[imported], vec![stored]).len(), 1);
    }

    #[test]
    fn chromium_cookie_import_preserves_session_attributes() {
        let imported = ImportedCookie {
            host: ".example.com".to_string(),
            name: "session".to_string(),
            value: "opaque-value".to_string(),
            path: "/account".to_string(),
            expires_at: Some(2_000_000_000),
            secure: true,
            http_only: true,
            same_site: 2,
        };

        let value = imported_cookie_cdp_param(&imported);
        assert_eq!(value["domain"], ".example.com");
        assert_eq!(value["path"], "/account");
        assert_eq!(value["expires"], 2_000_000_000_i64);
        assert_eq!(value["secure"], true);
        assert_eq!(value["httpOnly"], true);
        assert_eq!(value["sameSite"], "Strict");
    }

    #[test]
    fn chromium_cookie_import_keeps_unspecified_same_site_unset() {
        let imported = ImportedCookie {
            host: "example.com".to_string(),
            name: "session".to_string(),
            value: "opaque-value".to_string(),
            path: String::new(),
            expires_at: None,
            secure: false,
            http_only: false,
            same_site: -1,
        };

        let value = imported_cookie_cdp_param(&imported);
        assert_eq!(value["path"], "/");
        assert!(value.get("expires").is_none());
        assert!(value.get("sameSite").is_none());
    }

    #[test]
    fn locked_chrome_database_is_read_from_a_snapshot() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("History");
        let source = Connection::open(&path).expect("source database");
        source
            .execute_batch(
                "PRAGMA journal_mode = DELETE;
                 CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL);
                 INSERT INTO urls (url) VALUES ('https://example.com');
                 BEGIN EXCLUSIVE;
                 INSERT INTO urls (url) VALUES ('https://uncommitted.example');",
            )
            .expect("lock source database");

        let snapshot = open_chrome_database(&path).expect("snapshot locked database");
        let count = snapshot
            .query_row("SELECT COUNT(*) FROM urls", [], |row| row.get::<_, i64>(0))
            .expect("read snapshot");

        assert_eq!(count, 1);
        source
            .execute_batch("ROLLBACK")
            .expect("release source lock");
    }
}
