use bitcoin::{Address, Network};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

const SETTINGS_SCHEMA_VERSION: i64 = 1;
const MAX_ENABLED_EVM_CHAINS: usize = 128;
const MAX_SETTING_COLLECTION_ITEMS: usize = 512;
const MAX_SETTING_JSON_BYTES: usize = 512 * 1024;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

pub struct AppStore {
    database_path: PathBuf,
}

impl AppStore {
    pub fn new(database_path: PathBuf) -> Result<Self, String> {
        let store = Self { database_path };
        let connection = store.open()?;
        initialize_schema(&connection)?;
        Ok(store)
    }

    fn open(&self) -> Result<Connection, String> {
        open_database(&self.database_path)
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    pub auto_lock_minutes: Option<u32>,
    pub enabled_evm_chain_ids: Vec<u64>,
    pub show_testnets: bool,
    pub transaction_debug_details: bool,
    pub default_solana_network: String,
    pub default_evm_chain_id: Option<u64>,
    pub migration_version: u32,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            auto_lock_minutes: Some(15),
            enabled_evm_chain_ids: Vec::new(),
            show_testnets: false,
            transaction_debug_details: false,
            default_solana_network: "mainnet".to_string(),
            default_evm_chain_id: None,
            migration_version: SETTINGS_SCHEMA_VERSION as u32,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySettingsImport {
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub solana_network: Option<String>,
    #[serde(default)]
    pub solana_rpc_profiles: Option<Value>,
    #[serde(default)]
    pub custom_evm_networks: Option<Value>,
    #[serde(default)]
    pub current_evm_chain_id: Option<u64>,
    #[serde(default)]
    pub download_history: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub preferences: AppPreferences,
    pub theme: Option<String>,
    pub solana_rpc_profiles: Option<Value>,
    pub custom_evm_networks: Option<Value>,
    pub download_history: Option<Value>,
    pub schema_version: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBookEntry {
    pub id: String,
    pub label: String,
    pub chain: String,
    pub network: String,
    pub address: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBookEntryInput {
    pub id: Option<String>,
    pub label: String,
    pub chain: String,
    pub network: String,
    pub address: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DappPermission {
    pub origin: String,
    pub wallet_id: String,
    pub wallet_public_key: String,
    pub network: String,
    pub app_name: String,
    pub first_authorized_at_ms: i64,
    pub last_used_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DappPermissionInput {
    pub origin: String,
    pub wallet_id: String,
    pub wallet_public_key: String,
    pub network: String,
    pub app_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedDiagnostics {
    pub app_version: String,
    pub runtime: String,
    pub database_path: String,
    pub settings_schema_version: u32,
    pub address_book_entries: usize,
    pub dapp_permissions: usize,
    pub generated_at_ms: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn random_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 8];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}-{}-{}", now_ms(), u64::from_le_bytes(bytes))
}

fn sanitized_database_path(path: &Path) -> String {
    let filename = path
        .file_name()
        .map(|value| value.to_string_lossy())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "database.sqlite3".into());
    format!("<app-data>/{filename}")
}

fn open_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create app database directory: {error}"))?;
    }
    let connection =
        Connection::open(path).map_err(|error| format!("failed to open app database: {error}"))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("failed to enable app WAL mode: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("failed to enable app foreign keys: {error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("failed to set app database timeout: {error}"))?;
    Ok(connection)
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS address_book_entries (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                chain TEXT NOT NULL,
                network TEXT NOT NULL,
                address TEXT NOT NULL,
                normalized_address TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                UNIQUE(chain, network, normalized_address)
            );
            CREATE INDEX IF NOT EXISTS address_book_search_idx
                ON address_book_entries(label, chain, network, normalized_address);
            CREATE TABLE IF NOT EXISTS dapp_permissions (
                origin TEXT NOT NULL,
                wallet_id TEXT NOT NULL,
                wallet_public_key TEXT NOT NULL DEFAULT '',
                network TEXT NOT NULL,
                app_name TEXT NOT NULL,
                first_authorized_at_ms INTEGER NOT NULL,
                last_used_at_ms INTEGER NOT NULL,
                PRIMARY KEY(origin, wallet_id, network)
            );
            "#,
        )
        .map_err(|error| format!("failed to initialize app settings schema: {error}"))?;
    let has_wallet_public_key = connection
        .prepare("PRAGMA table_info(dapp_permissions)")
        .and_then(|mut statement| {
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
            columns.collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("failed to inspect DApp permission schema: {error}"))?
        .iter()
        .any(|column| column == "wallet_public_key");
    if !has_wallet_public_key {
        connection
            .execute(
                "ALTER TABLE dapp_permissions ADD COLUMN wallet_public_key TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| format!("failed to migrate DApp permission schema: {error}"))?;
    }
    Ok(())
}

fn setting_value(connection: &Connection, key: &str) -> Result<Option<Value>, String> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("failed to read app setting {key}: {error}"))?;
    raw.map(|value| {
        serde_json::from_str(&value)
            .map_err(|error| format!("failed to decode app setting {key}: {error}"))
    })
    .transpose()
}

fn put_setting(connection: &Connection, key: &str, value: &Value) -> Result<(), String> {
    let encoded = serde_json::to_string(value)
        .map_err(|error| format!("failed to encode app setting {key}: {error}"))?;
    connection
        .execute(
            "INSERT INTO app_settings (key, value_json, updated_at_ms) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
            params![key, encoded, now_ms()],
        )
        .map_err(|error| format!("failed to save app setting {key}: {error}"))?;
    Ok(())
}

fn load_snapshot(connection: &Connection) -> Result<SettingsSnapshot, String> {
    let preferences = setting_value(connection, "preferences")?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("failed to decode preferences: {error}"))?
        .unwrap_or_default();
    Ok(SettingsSnapshot {
        preferences,
        theme: setting_value(connection, "theme")?
            .and_then(|value| value.as_str().map(ToOwned::to_owned)),
        solana_rpc_profiles: setting_value(connection, "solana_rpc_profiles")?,
        custom_evm_networks: setting_value(connection, "custom_evm_networks")?,
        download_history: setting_value(connection, "download_history")?,
        schema_version: SETTINGS_SCHEMA_VERSION as u32,
    })
}

fn clipped(value: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err("value is empty, too long, or contains control characters".to_string());
    }
    Ok(value.to_string())
}

fn normalize_chain(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "solana" | "sol" => Ok("solana".to_string()),
        "evm" | "ethereum" | "eth" => Ok("evm".to_string()),
        "bitcoin" | "btc" => Ok("bitcoin".to_string()),
        "tron" | "trx" => Ok("tron".to_string()),
        _ => Err("unsupported address chain".to_string()),
    }
}

fn normalize_address(chain: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    if chain == "evm" {
        if value.len() != 42
            || !value.starts_with("0x")
            || !value[2..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err("invalid EVM address".to_string());
        }
        return Ok(value.to_ascii_lowercase());
    }
    if chain == "bitcoin" {
        let address = Address::from_str(value)
            .map_err(|_| "invalid Bitcoin address".to_string())?
            .require_network(Network::Bitcoin)
            .map_err(|_| "Bitcoin address is not for mainnet".to_string())?;
        return Ok(address.to_string());
    }
    if chain == "tron" {
        let decoded = bs58::decode(value)
            .with_check(None)
            .into_vec()
            .map_err(|_| "invalid TRON address checksum".to_string())?;
        if decoded.len() != 21 || decoded.first() != Some(&0x41) {
            return Err("invalid TRON mainnet address".to_string());
        }
        return Ok(value.to_string());
    }
    if bs58::decode(value)
        .into_vec()
        .map(|decoded| decoded.len() != 32)
        .unwrap_or(true)
    {
        return Err("invalid Solana address".to_string());
    }
    Ok(value.to_string())
}

fn normalize_address_network(chain: &str, value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if chain == "solana" {
        return matches!(value.as_str(), "mainnet" | "devnet" | "testnet")
            .then_some(value)
            .ok_or_else(|| "invalid Solana network".to_string());
    }
    if chain == "bitcoin" {
        return (value == "bip122:000000000019d6689c085ae165831e93")
            .then_some(value)
            .ok_or_else(|| "invalid Bitcoin network".to_string());
    }
    if chain == "tron" {
        return (value == "tron:728126428")
            .then_some(value)
            .ok_or_else(|| "invalid TRON network".to_string());
    }
    if value.starts_with('0') || !value.chars().all(|character| character.is_ascii_digit()) {
        return Err("invalid EVM chain ID".to_string());
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|chain_id| (1..=MAX_SAFE_JS_INTEGER).contains(chain_id))
        .map(|chain_id| chain_id.to_string())
        .ok_or_else(|| "invalid EVM chain ID".to_string())
}

pub(crate) fn normalize_dapp_origin(value: &str) -> Result<String, String> {
    let url = value
        .trim()
        .parse::<tauri::Url>()
        .map_err(|_| "invalid DApp origin".to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "DApp origin has no host".to_string())?;
    let local_http = url.scheme() == "http"
        && matches!(
            host.to_ascii_lowercase().as_str(),
            "localhost" | "127.0.0.1" | "::1"
        );
    if (url.scheme() != "https" && !local_http)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("DApp origin must use HTTPS or loopback HTTP without credentials".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

fn normalize_theme(value: &str) -> Option<String> {
    let theme = value.trim();
    matches!(theme, "light" | "dark" | "deep-sea").then(|| theme.to_string())
}

fn validate_preferences(preferences: &AppPreferences) -> Result<(), String> {
    if preferences.migration_version != SETTINGS_SCHEMA_VERSION as u32 {
        return Err("invalid settings migration version".to_string());
    }
    if !matches!(
        preferences.auto_lock_minutes,
        None | Some(1 | 5 | 15 | 30 | 60)
    ) {
        return Err("invalid auto-lock interval".to_string());
    }
    if !matches!(
        preferences.default_solana_network.as_str(),
        "mainnet" | "devnet" | "testnet"
    ) {
        return Err("invalid default Solana network".to_string());
    }
    if preferences.enabled_evm_chain_ids.len() > MAX_ENABLED_EVM_CHAINS
        || preferences
            .enabled_evm_chain_ids
            .iter()
            .any(|chain_id| !(1..=MAX_SAFE_JS_INTEGER).contains(chain_id))
        || preferences
            .enabled_evm_chain_ids
            .iter()
            .collect::<HashSet<_>>()
            .len()
            != preferences.enabled_evm_chain_ids.len()
        || preferences
            .default_evm_chain_id
            .is_some_and(|chain_id| !(1..=MAX_SAFE_JS_INTEGER).contains(&chain_id))
    {
        return Err("invalid enabled EVM networks".to_string());
    }
    Ok(())
}

fn normalize_preferences(mut preferences: AppPreferences) -> Result<AppPreferences, String> {
    preferences.migration_version = SETTINGS_SCHEMA_VERSION as u32;
    validate_preferences(&preferences)?;
    Ok(preferences)
}

fn validate_collection_setting(name: &str, value: &Value) -> Result<(), String> {
    let Value::Array(items) = value else {
        return Err(format!("{name} must be an array"));
    };
    if items.len() > MAX_SETTING_COLLECTION_ITEMS {
        return Err(format!("{name} contains too many entries"));
    }
    let encoded =
        serde_json::to_vec(value).map_err(|error| format!("failed to encode {name}: {error}"))?;
    if encoded.len() > MAX_SETTING_JSON_BYTES {
        return Err(format!("{name} exceeds the storage limit"));
    }
    Ok(())
}

fn valid_legacy_collection(value: Option<Value>) -> Option<Value> {
    value.filter(|item| validate_collection_setting("legacy setting", item).is_ok())
}

#[tauri::command]
pub fn settings_get(store: tauri::State<'_, AppStore>) -> Result<SettingsSnapshot, String> {
    let connection = store.open()?;
    initialize_schema(&connection)?;
    load_snapshot(&connection)
}

#[tauri::command]
pub fn settings_update(
    store: tauri::State<'_, AppStore>,
    preferences: AppPreferences,
    theme: Option<String>,
    solana_rpc_profiles: Option<Value>,
    custom_evm_networks: Option<Value>,
    download_history: Option<Value>,
) -> Result<SettingsSnapshot, String> {
    let preferences = normalize_preferences(preferences)?;
    for (name, value) in [
        ("Solana RPC profiles", solana_rpc_profiles.as_ref()),
        ("custom EVM networks", custom_evm_networks.as_ref()),
        ("download history", download_history.as_ref()),
    ] {
        if let Some(value) = value {
            validate_collection_setting(name, value)?;
        }
    }
    let mut connection = store.open()?;
    initialize_schema(&connection)?;
    let theme = theme
        .map(|value| normalize_theme(&value).ok_or_else(|| "invalid app theme".to_string()))
        .transpose()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin settings update: {error}"))?;
    put_setting(
        &transaction,
        "preferences",
        &serde_json::to_value(preferences).map_err(|error| error.to_string())?,
    )?;
    if let Some(theme) = theme {
        put_setting(&transaction, "theme", &Value::String(theme))?;
    }
    for (key, value) in [
        ("solana_rpc_profiles", solana_rpc_profiles),
        ("custom_evm_networks", custom_evm_networks),
        ("download_history", download_history),
    ] {
        if let Some(value) = value {
            put_setting(&transaction, key, &value)?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit settings update: {error}"))?;
    load_snapshot(&connection)
}

#[tauri::command]
pub fn settings_import_legacy(
    store: tauri::State<'_, AppStore>,
    legacy: LegacySettingsImport,
) -> Result<SettingsSnapshot, String> {
    let mut connection = store.open()?;
    initialize_schema(&connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin settings migration: {error}"))?;
    if setting_value(&transaction, "preferences")?.is_none() {
        let mut preferences = AppPreferences::default();
        if let Some(network) = legacy.solana_network.as_deref() {
            if matches!(network, "mainnet" | "devnet" | "testnet") {
                preferences.default_solana_network = network.to_string();
            }
        }
        preferences.default_evm_chain_id = legacy
            .current_evm_chain_id
            .filter(|id| (1..=MAX_SAFE_JS_INTEGER).contains(id));
        put_setting(
            &transaction,
            "preferences",
            &serde_json::to_value(preferences).map_err(|error| error.to_string())?,
        )?;
    }
    for (key, value) in [
        (
            "theme",
            legacy
                .theme
                .as_deref()
                .and_then(normalize_theme)
                .map(Value::String),
        ),
        (
            "solana_rpc_profiles",
            valid_legacy_collection(legacy.solana_rpc_profiles),
        ),
        (
            "custom_evm_networks",
            valid_legacy_collection(legacy.custom_evm_networks),
        ),
        (
            "download_history",
            valid_legacy_collection(legacy.download_history),
        ),
    ] {
        if let Some(value) = value {
            if setting_value(&transaction, key)?.is_none() {
                put_setting(&transaction, key, &value)?;
            }
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit settings migration: {error}"))?;
    load_snapshot(&connection)
}

#[tauri::command]
pub fn address_book_list(
    store: tauri::State<'_, AppStore>,
) -> Result<Vec<AddressBookEntry>, String> {
    let connection = store.open()?;
    initialize_schema(&connection)?;
    let mut statement = connection
        .prepare("SELECT id, label, chain, network, address, created_at_ms, updated_at_ms FROM address_book_entries ORDER BY label COLLATE NOCASE, updated_at_ms DESC")
        .map_err(|error| format!("failed to prepare address book query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(AddressBookEntry {
                id: row.get(0)?,
                label: row.get(1)?,
                chain: row.get(2)?,
                network: row.get(3)?,
                address: row.get(4)?,
                created_at_ms: row.get(5)?,
                updated_at_ms: row.get(6)?,
            })
        })
        .map_err(|error| format!("failed to query address book: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read address book: {error}"))
}

#[tauri::command]
pub fn address_book_upsert(
    store: tauri::State<'_, AppStore>,
    entry: AddressBookEntryInput,
) -> Result<AddressBookEntry, String> {
    let label = clipped(&entry.label, 80)?;
    let chain = normalize_chain(&entry.chain)?;
    let network = normalize_address_network(&chain, &entry.network)?;
    let normalized_address = normalize_address(&chain, &entry.address)?;
    let address = if chain == "evm" {
        normalized_address.clone()
    } else {
        entry.address.trim().to_string()
    };
    let id = entry
        .id
        .map(|value| clipped(&value, 120))
        .transpose()?
        .unwrap_or_else(|| random_id("address"));
    let timestamp = now_ms();
    let connection = store.open()?;
    initialize_schema(&connection)?;
    connection.execute(
        "INSERT INTO address_book_entries (id, label, chain, network, address, normalized_address, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ON CONFLICT(id) DO UPDATE SET label=excluded.label, chain=excluded.chain, network=excluded.network, address=excluded.address, normalized_address=excluded.normalized_address, updated_at_ms=excluded.updated_at_ms",
        params![id, label, chain, network, address, normalized_address, timestamp],
    ).map_err(|error| {
        if error.to_string().contains("UNIQUE constraint failed") { "address already exists for this network".to_string() } else { format!("failed to save address book entry: {error}") }
    })?;
    connection.query_row(
        "SELECT id, label, chain, network, address, created_at_ms, updated_at_ms FROM address_book_entries WHERE id=?1", [&id],
        |row| Ok(AddressBookEntry { id: row.get(0)?, label: row.get(1)?, chain: row.get(2)?, network: row.get(3)?, address: row.get(4)?, created_at_ms: row.get(5)?, updated_at_ms: row.get(6)? })
    ).map_err(|error| format!("failed to read saved address: {error}"))
}

#[tauri::command]
pub fn address_book_delete(store: tauri::State<'_, AppStore>, id: String) -> Result<bool, String> {
    let id = clipped(&id, 120)?;
    let connection = store.open()?;
    Ok(connection
        .execute("DELETE FROM address_book_entries WHERE id=?1", [id])
        .map_err(|error| format!("failed to delete address book entry: {error}"))?
        > 0)
}

#[tauri::command]
pub fn dapp_permissions_list(
    store: tauri::State<'_, AppStore>,
) -> Result<Vec<DappPermission>, String> {
    let connection = store.open()?;
    initialize_schema(&connection)?;
    let mut statement = connection.prepare("SELECT origin, wallet_id, wallet_public_key, network, app_name, first_authorized_at_ms, last_used_at_ms FROM dapp_permissions ORDER BY last_used_at_ms DESC")
        .map_err(|error| format!("failed to prepare DApp permission query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(DappPermission {
                origin: row.get(0)?,
                wallet_id: row.get(1)?,
                wallet_public_key: row.get(2)?,
                network: row.get(3)?,
                app_name: row.get(4)?,
                first_authorized_at_ms: row.get(5)?,
                last_used_at_ms: row.get(6)?,
            })
        })
        .map_err(|error| format!("failed to query DApp permissions: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read DApp permissions: {error}"))
}

fn ensure_dapp_permission_identity(
    connection: &Connection,
    origin: &str,
    wallet_id: &str,
    wallet_public_key: &str,
    network: &str,
) -> Result<(), String> {
    let existing_public_key = connection
        .query_row(
            "SELECT wallet_public_key FROM dapp_permissions WHERE origin=?1 AND wallet_id=?2 AND network=?3",
            params![origin, wallet_id, network],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to validate DApp permission identity: {error}"))?;
    if existing_public_key
        .as_deref()
        .is_some_and(|stored| !stored.is_empty() && stored != wallet_public_key)
    {
        return Err("DApp permission wallet identity does not match".to_string());
    }
    Ok(())
}

fn upsert_dapp_permission(
    connection: &Connection,
    permission: &DappPermission,
) -> Result<(), String> {
    let changed = connection
        .execute(
            r#"
            INSERT INTO dapp_permissions (
                origin, wallet_id, wallet_public_key, network, app_name,
                first_authorized_at_ms, last_used_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(origin, wallet_id, network) DO UPDATE SET
                wallet_public_key = excluded.wallet_public_key,
                app_name = excluded.app_name,
                last_used_at_ms = excluded.last_used_at_ms
            WHERE dapp_permissions.wallet_public_key = ''
               OR dapp_permissions.wallet_public_key = excluded.wallet_public_key
            "#,
            params![
                permission.origin,
                permission.wallet_id,
                permission.wallet_public_key,
                permission.network,
                permission.app_name,
                permission.first_authorized_at_ms,
                permission.last_used_at_ms,
            ],
        )
        .map_err(|error| format!("failed to grant DApp permission: {error}"))?;
    if changed != 1 {
        return Err("DApp permission wallet identity does not match".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn dapp_permission_grant(
    store: tauri::State<'_, AppStore>,
    permission: DappPermissionInput,
) -> Result<DappPermission, String> {
    let origin = normalize_dapp_origin(&permission.origin)?;
    let wallet_id = clipped(&permission.wallet_id, 160)?;
    let wallet_public_key = clipped(&permission.wallet_public_key, 160)?;
    let network = clipped(&permission.network, 80)?.to_ascii_lowercase();
    let app_name = clipped(&permission.app_name, 120)?;
    let timestamp = now_ms();
    let connection = store.open()?;
    initialize_schema(&connection)?;
    let record = DappPermission {
        origin,
        wallet_id,
        wallet_public_key,
        network,
        app_name,
        first_authorized_at_ms: timestamp,
        last_used_at_ms: timestamp,
    };
    upsert_dapp_permission(&connection, &record)?;
    connection.query_row("SELECT origin, wallet_id, wallet_public_key, network, app_name, first_authorized_at_ms, last_used_at_ms FROM dapp_permissions WHERE origin=?1 AND wallet_id=?2 AND network=?3", params![record.origin, record.wallet_id, record.network], |row| Ok(DappPermission { origin: row.get(0)?, wallet_id: row.get(1)?, wallet_public_key: row.get(2)?, network: row.get(3)?, app_name: row.get(4)?, first_authorized_at_ms: row.get(5)?, last_used_at_ms: row.get(6)? }))
        .map_err(|error| format!("failed to read DApp permission: {error}"))
}

pub(crate) fn revoke_dapp_permission_for_identity(
    store: &AppStore,
    origin: &str,
    wallet_id: &str,
    wallet_public_key: &str,
    network: &str,
) -> Result<bool, String> {
    let origin = normalize_dapp_origin(origin)?;
    let wallet_id = clipped(wallet_id, 160)?;
    let wallet_public_key = clipped(wallet_public_key, 160)?;
    let network = network.trim().to_ascii_lowercase();
    let connection = store.open()?;
    initialize_schema(&connection)?;
    ensure_dapp_permission_identity(
        &connection,
        &origin,
        &wallet_id,
        &wallet_public_key,
        &network,
    )?;
    Ok(connection
        .execute(
            "DELETE FROM dapp_permissions WHERE origin=?1 AND wallet_id=?2 AND network=?3",
            params![origin, wallet_id, network],
        )
        .map_err(|error| format!("failed to revoke DApp permission: {error}"))?
        > 0)
}

#[tauri::command]
pub fn dapp_permission_revoke(
    store: tauri::State<'_, AppStore>,
    origin: String,
    wallet_id: String,
    network: String,
) -> Result<bool, String> {
    revoke_dapp_permission(store.inner(), &origin, &wallet_id, &network)
}

pub(crate) fn revoke_dapp_permission(
    store: &AppStore,
    origin: &str,
    wallet_id: &str,
    network: &str,
) -> Result<bool, String> {
    let origin = normalize_dapp_origin(origin)?;
    let connection = store.open()?;
    initialize_schema(&connection)?;
    Ok(connection
        .execute(
            "DELETE FROM dapp_permissions WHERE origin=?1 AND wallet_id=?2 AND network=?3",
            params![
                origin,
                wallet_id.trim(),
                network.trim().to_ascii_lowercase()
            ],
        )
        .map_err(|error| format!("failed to revoke DApp permission: {error}"))?
        > 0)
}

pub(crate) fn revoke_dapp_permissions_for_wallet(
    store: &AppStore,
    wallet_id: &str,
    legacy_public_key: &str,
) -> Result<usize, String> {
    let wallet_id = clipped(wallet_id, 160)?;
    let legacy_public_key = clipped(legacy_public_key, 160)?;
    let connection = store.open()?;
    initialize_schema(&connection)?;
    let mismatched: Option<String> = connection
        .query_row(
            "SELECT wallet_public_key FROM dapp_permissions WHERE wallet_id=?1 AND wallet_public_key<>'' AND wallet_public_key<>?2 LIMIT 1",
            params![wallet_id, legacy_public_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("failed to validate wallet DApp permissions: {error}"))?;
    if mismatched.is_some() {
        return Err("DApp permission wallet identity does not match".to_string());
    }
    connection
        .execute(
            "DELETE FROM dapp_permissions WHERE wallet_id=?1 OR wallet_id=?2",
            params![wallet_id, legacy_public_key],
        )
        .map_err(|error| format!("failed to revoke wallet DApp permissions: {error}"))
}

#[cfg(test)]
fn has_dapp_permission(
    store: &AppStore,
    origin: &str,
    wallet_id: &str,
    network: &str,
) -> Result<bool, String> {
    let origin = normalize_dapp_origin(origin)?;
    let connection = store.open()?;
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM dapp_permissions WHERE origin=?1 AND wallet_id=?2 AND network=?3",
            params![origin, wallet_id, network.to_ascii_lowercase()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(exists.is_some())
}

#[tauri::command]
pub fn settings_diagnostics(
    store: tauri::State<'_, AppStore>,
) -> Result<SanitizedDiagnostics, String> {
    let connection = store.open()?;
    initialize_schema(&connection)?;
    let address_book_entries = connection
        .query_row("SELECT COUNT(*) FROM address_book_entries", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| error.to_string())? as usize;
    let dapp_permissions = connection
        .query_row("SELECT COUNT(*) FROM dapp_permissions", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| error.to_string())? as usize;
    Ok(SanitizedDiagnostics {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        runtime: "Tauri CEF".to_string(),
        database_path: sanitized_database_path(store.database_path()),
        settings_schema_version: SETTINGS_SCHEMA_VERSION as u32,
        address_book_entries,
        dapp_permissions,
        generated_at_ms: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_and_legacy_migration_are_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let store = AppStore::new(directory.path().join("app.sqlite3")).unwrap();
        initialize_schema(&store.open().unwrap()).unwrap();
        let connection = store.open().unwrap();
        let snapshot = load_snapshot(&connection).unwrap();
        assert_eq!(snapshot.preferences.auto_lock_minutes, Some(15));
    }

    #[test]
    fn normalizes_addresses_and_origins() {
        assert_eq!(
            normalize_address("evm", "0x00000000000000000000000000000000000000AA").unwrap(),
            "0x00000000000000000000000000000000000000aa"
        );
        assert_eq!(
            normalize_dapp_origin("https://EXAMPLE.com/path?q=1").unwrap(),
            "https://example.com"
        );
        assert_eq!(
            normalize_dapp_origin("http://localhost:3840/path").unwrap(),
            "http://localhost:3840"
        );
        assert!(normalize_dapp_origin("http://example.com").is_err());
        assert!(normalize_dapp_origin("https://user:secret@example.com").is_err());
        assert!(normalize_address("solana", "not an address").is_err());
        assert_eq!(
            normalize_address("solana", "11111111111111111111111111111111").unwrap(),
            "11111111111111111111111111111111"
        );
        assert!(normalize_address("solana", "111111111111111111111111111111111").is_err());
        assert_eq!(
            normalize_address("bitcoin", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu").unwrap(),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
        );
        assert!(
            normalize_address("bitcoin", "tb1qfm7w7u5x3rhw73myhw55aj60m4q0zj5g6c7rjl").is_err()
        );
        assert_eq!(
            normalize_address("tron", "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC").unwrap(),
            "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC"
        );
        assert!(normalize_address("tron", "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HD").is_err());
        assert_eq!(
            normalize_address_network("solana", " DEVNET ").unwrap(),
            "devnet"
        );
        assert!(normalize_address_network("solana", "localnet").is_err());
        assert_eq!(normalize_address_network("evm", "10").unwrap(), "10");
        assert!(normalize_address_network("evm", "01").is_err());
        assert!(normalize_address_network("evm", "0").is_err());
        assert!(normalize_address_network("evm", "9007199254740992").is_err());
        assert_eq!(
            normalize_address_network("bitcoin", "bip122:000000000019d6689c085ae165831e93")
                .unwrap(),
            "bip122:000000000019d6689c085ae165831e93"
        );
        assert_eq!(
            normalize_address_network("tron", "tron:728126428").unwrap(),
            "tron:728126428"
        );
        assert_eq!(normalize_theme(" dark ").as_deref(), Some("dark"));
        assert!(normalize_theme("system").is_none());
        let duplicate_preferences = AppPreferences {
            enabled_evm_chain_ids: vec![1, 1],
            ..AppPreferences::default()
        };
        assert!(validate_preferences(&duplicate_preferences).is_err());
        let valid_preferences = AppPreferences {
            enabled_evm_chain_ids: vec![1, 10],
            ..AppPreferences::default()
        };
        assert!(validate_preferences(&valid_preferences).is_ok());
        let unsafe_integer_preferences = AppPreferences {
            enabled_evm_chain_ids: vec![MAX_SAFE_JS_INTEGER + 1],
            default_evm_chain_id: Some(MAX_SAFE_JS_INTEGER + 1),
            ..AppPreferences::default()
        };
        assert!(validate_preferences(&unsafe_integer_preferences).is_err());
        let stale_preferences = AppPreferences {
            migration_version: SETTINGS_SCHEMA_VERSION.saturating_sub(1) as u32,
            ..AppPreferences::default()
        };
        assert!(validate_preferences(&stale_preferences).is_err());
        assert_eq!(
            normalize_preferences(stale_preferences)
                .unwrap()
                .migration_version,
            SETTINGS_SCHEMA_VERSION as u32
        );
        assert!(validate_collection_setting("test", &serde_json::json!({})).is_err());
        assert!(validate_collection_setting("test", &serde_json::json!([])).is_ok());
        assert_eq!(
            sanitized_database_path(Path::new("/Users/private/FnzSafe/wallets.sqlite3")),
            "<app-data>/wallets.sqlite3"
        );
    }

    #[test]
    fn permission_upsert_cannot_replace_a_bound_wallet_identity() {
        let connection = Connection::open_in_memory().unwrap();
        initialize_schema(&connection).unwrap();
        let permission = |wallet_public_key: &str, at: i64| DappPermission {
            origin: "https://app.example".to_string(),
            wallet_id: "wallet-a".to_string(),
            wallet_public_key: wallet_public_key.to_string(),
            network: "mainnet".to_string(),
            app_name: "App".to_string(),
            first_authorized_at_ms: at,
            last_used_at_ms: at,
        };

        upsert_dapp_permission(&connection, &permission("public-key-a", 10)).unwrap();
        assert!(upsert_dapp_permission(&connection, &permission("public-key-b", 20)).is_err());
        upsert_dapp_permission(&connection, &permission("public-key-a", 30)).unwrap();

        let stored: (String, i64, i64) = connection
            .query_row(
                "SELECT wallet_public_key, first_authorized_at_ms, last_used_at_ms FROM dapp_permissions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored, ("public-key-a".to_string(), 10, 30));
    }

    #[test]
    fn permission_matching_is_exact_and_revoke_removes_only_target() {
        let directory = tempfile::tempdir().unwrap();
        let store = AppStore::new(directory.path().join("app.sqlite3")).unwrap();
        let connection = store.open().unwrap();
        let at = now_ms();
        connection
            .execute(
                "INSERT INTO dapp_permissions (origin, wallet_id, network, app_name, first_authorized_at_ms, last_used_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params!["https://app.example", "wallet-a", "mainnet", "App", at],
            )
            .unwrap();
        assert!(
            has_dapp_permission(&store, "https://app.example/page", "wallet-a", "mainnet").unwrap()
        );
        assert!(
            !has_dapp_permission(&store, "https://app.example", "wallet-b", "mainnet").unwrap()
        );
        connection
            .execute(
                "DELETE FROM dapp_permissions WHERE origin=?1 AND wallet_id=?2 AND network=?3",
                params!["https://app.example", "wallet-a", "mainnet"],
            )
            .unwrap();
        assert!(
            !has_dapp_permission(&store, "https://app.example", "wallet-a", "mainnet").unwrap()
        );
    }

    #[test]
    fn wallet_permission_revoke_removes_stable_and_legacy_identities() {
        let directory = tempfile::tempdir().unwrap();
        let store = AppStore::new(directory.path().join("app.sqlite3")).unwrap();
        let connection = store.open().unwrap();
        let at = now_ms();
        for wallet_id in ["wallet-id", "wallet-public-key", "other-wallet"] {
            connection
                .execute(
                    "INSERT INTO dapp_permissions (origin, wallet_id, network, app_name, first_authorized_at_ms, last_used_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    params!["https://app.example", wallet_id, "mainnet", "App", at],
                )
                .unwrap();
        }
        assert_eq!(
            revoke_dapp_permissions_for_wallet(&store, "wallet-id", "wallet-public-key").unwrap(),
            2
        );
        assert!(
            has_dapp_permission(&store, "https://app.example", "other-wallet", "mainnet").unwrap()
        );
    }

    #[test]
    fn permission_identity_mismatch_does_not_revoke() {
        let directory = tempfile::tempdir().unwrap();
        let store = AppStore::new(directory.path().join("app.sqlite3")).unwrap();
        let connection = store.open().unwrap();
        let at = now_ms();
        connection
            .execute(
                "INSERT INTO dapp_permissions (origin, wallet_id, wallet_public_key, network, app_name, first_authorized_at_ms, last_used_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params!["https://app.example", "wallet-id", "wallet-public-key", "mainnet", "App", at],
            )
            .unwrap();

        assert!(revoke_dapp_permission_for_identity(
            &store,
            "https://app.example",
            "wallet-id",
            "different-public-key",
            "mainnet",
        )
        .is_err());
        assert!(
            has_dapp_permission(&store, "https://app.example", "wallet-id", "mainnet",).unwrap()
        );
    }

    #[test]
    fn legacy_permission_schema_is_upgraded_without_losing_rows() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("app.sqlite3");
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE dapp_permissions (origin TEXT NOT NULL, wallet_id TEXT NOT NULL, network TEXT NOT NULL, app_name TEXT NOT NULL, first_authorized_at_ms INTEGER NOT NULL, last_used_at_ms INTEGER NOT NULL, PRIMARY KEY(origin, wallet_id, network));\
                 INSERT INTO dapp_permissions VALUES ('https://app.example', 'legacy-key', 'mainnet', 'App', 1, 1);",
            )
            .unwrap();
        drop(connection);

        let store = AppStore::new(database_path).unwrap();
        let connection = store.open().unwrap();
        let migrated_key: String = connection
            .query_row(
                "SELECT wallet_public_key FROM dapp_permissions WHERE wallet_id='legacy-key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(migrated_key.is_empty());
    }
}
