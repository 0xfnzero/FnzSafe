use fnzero_safe::{KeyManager, KeystoreVersion};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;

const DEFAULT_DATABASE_PATH: &str = "data/fnzero-safe.sqlite3";
const LEGACY_DATABASE_PATH: &str = "data/sol-safekey.sqlite3";
const DATABASE_PATH_ENV: &str = "FNZERO_SAFE_DB_PATH";
const LEGACY_DATABASE_PATH_ENV: &str = "SOL_SAFEKEY_DB_PATH";
const MAX_NONCE_ACCOUNTS_PER_OWNER_NETWORK: usize = 100;

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SavedWallet {
    pub id: String,
    pub name: String,
    pub public_key: String,
    pub keystore_json: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Serialize)]
pub struct WalletSummary {
    pub id: String,
    pub name: String,
    pub public_key: String,
    pub evm_address: Option<String>,
    pub evm_wallet_id: Option<String>,
    pub evm_derivation_path: Option<String>,
    pub secret_type: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub keystore_version: String,
}

#[derive(Clone, Serialize)]
pub struct NonceAccountRecord {
    pub id: String,
    pub wallet_id: Option<String>,
    pub owner: String,
    pub network: String,
    pub nonce_account: String,
    pub signature: String,
    pub created_at: u64,
}

#[derive(Clone, Serialize)]
pub struct WalletTokenAssetRecord {
    pub owner: String,
    pub network: String,
    pub account: String,
    pub mint: String,
    pub amount: String,
    pub ui_amount_string: String,
    pub decimals: u8,
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub logo_uri: Option<String>,
    pub updated_at: u64,
}

#[derive(Clone, Serialize)]
pub struct TokenMetadataRecord {
    pub network: String,
    pub mint: String,
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub logo_uri: Option<String>,
    pub updated_at: u64,
}

#[derive(Clone, Serialize)]
pub struct WalletAssetsRecord {
    pub owner: String,
    pub network: String,
    pub sol_balance: f64,
    pub tokens: Vec<WalletTokenAssetRecord>,
    pub updated_at: u64,
}

#[derive(Clone, Serialize)]
pub struct ProgramDeploymentRecord {
    pub genesis_hash: String,
    pub program_id: String,
    pub program_sha256: String,
    pub program_len: usize,
    pub max_data_len: usize,
    pub upgrade_authority: String,
    pub buffer_address: String,
    pub status: String,
    pub create_signature: Option<String>,
    pub create_last_valid_block_height: Option<u64>,
    pub last_write_signature: Option<String>,
    pub last_write_chunk_index: Option<usize>,
    pub last_write_last_valid_block_height: Option<u64>,
    pub completed_writes: usize,
    pub deploy_signature: Option<String>,
    pub deploy_last_valid_block_height: Option<u64>,
    pub attempt_evidence_version: u32,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Serialize)]
pub struct ProgramDeploymentAttemptRecord {
    pub genesis_hash: String,
    pub program_id: String,
    pub stage: String,
    pub buffer_address: String,
    pub chunk_index: Option<usize>,
    pub signature: String,
    pub last_valid_block_height: u64,
    pub status: String,
    pub created_at: u64,
    pub updated_at: u64,
}

pub const PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER: &str = "create_buffer";
pub const PROGRAM_DEPLOYMENT_STAGE_WRITE: &str = "write";
pub const PROGRAM_DEPLOYMENT_STAGE_DEPLOY: &str = "deploy";
pub const PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED: &str = "signed";
pub const PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED: &str = "confirmed";
pub const PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION: &str = "requires_reconciliation";
pub const PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED: &str = "finalized";
pub const PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED_FAILED: &str = "finalized_failed";
pub const PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT: &str = "expired_absent";
pub const PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION: u32 = 1;
pub const PROGRAM_DEPLOYMENT_STATUS_FINALIZED: &str = "finalized";

impl From<SavedWallet> for WalletSummary {
    fn from(wallet: SavedWallet) -> Self {
        let document = serde_json::from_str::<serde_json::Value>(&wallet.keystore_json).ok();
        let root_secret_type = document
            .as_ref()
            .filter(|value| value.get("version").and_then(serde_json::Value::as_u64) == Some(3))
            .and_then(|value| value.get("secret_type"))
            .and_then(serde_json::Value::as_str)
            .filter(|value| *value == "mnemonic")
            .map(ToOwned::to_owned);
        let metadata = document
            .as_ref()
            .and_then(|value| value.get("metadata"))
            .cloned();
        let metadata_string = |key: &str| {
            metadata
                .as_ref()
                .and_then(|value| value.get(key))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        };
        let keystore_version = match KeyManager::keystore_version(&wallet.keystore_json) {
            Ok(KeystoreVersion::V3) => "v3",
            Ok(KeystoreVersion::V2) => "v2",
            Ok(KeystoreVersion::LegacyV1) => "legacy_v1",
            Err(_) => "unknown",
        }
        .to_string();
        Self {
            id: wallet.id,
            name: wallet.name,
            public_key: wallet.public_key,
            evm_address: metadata_string("evm_address"),
            evm_wallet_id: metadata_string("evm_wallet_id"),
            evm_derivation_path: metadata_string("evm_derivation_path"),
            secret_type: root_secret_type.unwrap_or_else(|| {
                if metadata_string("encrypted_mnemonic").is_some() {
                    "mnemonic".to_string()
                } else {
                    "private_key".to_string()
                }
            }),
            created_at: wallet.created_at,
            updated_at: wallet.updated_at,
            keystore_version,
        }
    }
}

fn now_unix_secs() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| format!("系统时间错误: {}", e))
}

fn fallback_wallet_name(public_key: &str) -> String {
    if public_key.len() > 12 {
        format!(
            "Wallet {}...{}",
            &public_key[..4],
            &public_key[public_key.len() - 4..]
        )
    } else {
        "Wallet".to_string()
    }
}

fn normalize_wallet_name(name: Option<String>, public_key: &str) -> String {
    name.as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| fallback_wallet_name(public_key))
}

fn ensure_data_dir() -> Result<(), String> {
    let database_path = database_path();
    if let Some(parent) = database_path.parent() {
        #[cfg(unix)]
        {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .map_err(|e| format!("创建数据目录失败: {}", e))?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {}", e))?;
    }
    Ok(())
}

fn database_path() -> PathBuf {
    if let Ok(path) = std::env::var(DATABASE_PATH_ENV) {
        return PathBuf::from(path);
    }
    if let Ok(path) = std::env::var(LEGACY_DATABASE_PATH_ENV) {
        return PathBuf::from(path);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let default_path = manifest_dir.join(DEFAULT_DATABASE_PATH);
    let legacy_path = manifest_dir.join(LEGACY_DATABASE_PATH);
    if !default_path.exists() && legacy_path.exists() {
        legacy_path
    } else {
        default_path
    }
}

fn open_connection() -> Result<Connection, String> {
    ensure_data_dir()?;
    let database_path = database_path();
    let conn = Connection::open(&database_path).map_err(|e| format!("打开数据库失败: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&database_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置数据库权限失败: {}", e))?;
    }
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("初始化数据库失败: {}", e))?;
    conn.pragma_update(None, "secure_delete", "ON")
        .map_err(|e| format!("初始化数据库安全删除失败: {}", e))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("初始化数据库失败: {}", e))?;
    init_schema(&conn)?;
    Ok(conn)
}

pub fn checkpoint_sensitive_rewrite() -> Result<(), String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let conn = open_connection()?;
    let (busy, log_frames, checkpointed_frames) = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| format!("清理敏感数据库 WAL 失败: {error}"))?;
    if busy != 0 || log_frames != checkpointed_frames {
        return Err(format!(
            "敏感数据库 WAL 尚有未清理页（busy={busy}, log={log_frames}, checkpointed={checkpointed_frames}）"
        ));
    }
    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| format!("检查数据库列失败: {}", e))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("检查数据库列失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("检查数据库列失败: {}", e))?;
    if !columns.iter().any(|name| name == column) {
        conn.execute(
            &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, definition),
            [],
        )
        .map_err(|e| format!("迁移数据库列失败: {}", e))?;
    }
    Ok(())
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS wallets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            public_key TEXT NOT NULL UNIQUE,
            keystore_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS nonce_accounts (
            id TEXT PRIMARY KEY,
            wallet_id TEXT,
            owner TEXT NOT NULL,
            network TEXT NOT NULL,
            nonce_account TEXT NOT NULL UNIQUE,
            signature TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(wallet_id) REFERENCES wallets(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_nonce_accounts_owner_network
            ON nonce_accounts(owner, network, created_at DESC);

        CREATE TABLE IF NOT EXISTS wallet_assets (
            owner TEXT NOT NULL,
            network TEXT NOT NULL,
            sol_balance REAL NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(owner, network)
        );

        CREATE TABLE IF NOT EXISTS wallet_token_assets (
            owner TEXT NOT NULL,
            network TEXT NOT NULL,
            account TEXT NOT NULL,
            mint TEXT NOT NULL,
            amount TEXT NOT NULL,
            ui_amount_string TEXT NOT NULL,
            decimals INTEGER NOT NULL,
            name TEXT,
            symbol TEXT,
            logo_uri TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(owner, network, account),
            FOREIGN KEY(owner, network) REFERENCES wallet_assets(owner, network) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_wallet_token_assets_owner_network_mint
            ON wallet_token_assets(owner, network, mint);

        CREATE TABLE IF NOT EXISTS token_metadata (
            network TEXT NOT NULL,
            mint TEXT NOT NULL,
            name TEXT,
            symbol TEXT,
            logo_uri TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(network, mint)
        );

        CREATE TABLE IF NOT EXISTS program_deployment_journal (
            genesis_hash TEXT NOT NULL,
            program_id TEXT NOT NULL,
            program_sha256 TEXT NOT NULL,
            program_len INTEGER NOT NULL,
            max_data_len INTEGER NOT NULL,
            upgrade_authority TEXT NOT NULL,
            buffer_address TEXT NOT NULL,
            status TEXT NOT NULL,
            create_signature TEXT,
            create_last_valid_block_height INTEGER,
            last_write_signature TEXT,
            last_write_chunk_index INTEGER,
            last_write_last_valid_block_height INTEGER,
            completed_writes INTEGER NOT NULL DEFAULT 0,
            deploy_signature TEXT,
            deploy_last_valid_block_height INTEGER,
            attempt_evidence_version INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(genesis_hash, program_id)
        );

        CREATE TABLE IF NOT EXISTS program_deployment_attempts (
            genesis_hash TEXT NOT NULL,
            program_id TEXT NOT NULL,
            stage TEXT NOT NULL,
            buffer_address TEXT NOT NULL,
            chunk_index INTEGER,
            signature TEXT NOT NULL,
            last_valid_block_height INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(genesis_hash, program_id, signature),
            FOREIGN KEY(genesis_hash, program_id)
                REFERENCES program_deployment_journal(genesis_hash, program_id)
                ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_program_deployment_attempts_active
            ON program_deployment_attempts(genesis_hash, program_id, status, stage, chunk_index);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_program_deployment_attempts_one_unresolved
            ON program_deployment_attempts(
                genesis_hash, program_id, stage, COALESCE(chunk_index, -1)
            )
            WHERE status <> 'expired_absent';

        "#,
    )
    .map_err(|e| format!("初始化数据库表失败: {}", e))?;
    ensure_column(conn, "wallet_token_assets", "name", "TEXT")?;
    ensure_column(conn, "wallet_token_assets", "symbol", "TEXT")?;
    ensure_column(conn, "wallet_token_assets", "logo_uri", "TEXT")?;
    ensure_column(
        conn,
        "program_deployment_journal",
        "create_last_valid_block_height",
        "INTEGER",
    )?;
    ensure_column(
        conn,
        "program_deployment_journal",
        "last_write_chunk_index",
        "INTEGER",
    )?;
    ensure_column(
        conn,
        "program_deployment_journal",
        "revision",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        conn,
        "program_deployment_journal",
        "last_write_last_valid_block_height",
        "INTEGER",
    )?;
    ensure_column(
        conn,
        "program_deployment_journal",
        "deploy_last_valid_block_height",
        "INTEGER",
    )?;
    ensure_column(
        conn,
        "program_deployment_journal",
        "attempt_evidence_version",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    conn.execute_batch(
        "INSERT OR IGNORE INTO program_deployment_attempts (
            genesis_hash, program_id, stage, buffer_address, chunk_index, signature,
            last_valid_block_height, status, created_at, updated_at
         )
         SELECT genesis_hash, program_id, 'create_buffer', buffer_address, NULL,
                create_signature, create_last_valid_block_height,
                CASE
                    WHEN status IN ('create_buffer_signed') THEN 'signed'
                    WHEN status IN ('create_buffer_requires_reconciliation')
                        THEN 'requires_reconciliation'
                    ELSE 'finalized'
                END,
                created_at, updated_at
           FROM program_deployment_journal
          WHERE create_signature IS NOT NULL
            AND create_last_valid_block_height IS NOT NULL;

         INSERT OR IGNORE INTO program_deployment_attempts (
            genesis_hash, program_id, stage, buffer_address, chunk_index, signature,
            last_valid_block_height, status, created_at, updated_at
         )
         SELECT genesis_hash, program_id, 'write', buffer_address,
                last_write_chunk_index, last_write_signature,
                last_write_last_valid_block_height,
                CASE
                    WHEN status = 'write_signed' THEN 'signed'
                    WHEN status = 'write_confirmed' THEN 'confirmed'
                    WHEN status = 'write_requires_reconciliation'
                        THEN 'requires_reconciliation'
                    ELSE 'finalized'
                END,
                created_at, updated_at
           FROM program_deployment_journal
          WHERE last_write_signature IS NOT NULL
            AND last_write_chunk_index IS NOT NULL
            AND last_write_last_valid_block_height IS NOT NULL;

         INSERT OR IGNORE INTO program_deployment_attempts (
            genesis_hash, program_id, stage, buffer_address, chunk_index, signature,
            last_valid_block_height, status, created_at, updated_at
         )
         SELECT genesis_hash, program_id, 'deploy', buffer_address, NULL,
                deploy_signature, deploy_last_valid_block_height,
                CASE
                    WHEN status = 'deploy_signed' THEN 'signed'
                    WHEN status = 'deploy_requires_reconciliation'
                        THEN 'requires_reconciliation'
                    ELSE 'finalized'
                END,
                created_at, updated_at
           FROM program_deployment_journal
          WHERE deploy_signature IS NOT NULL
            AND deploy_last_valid_block_height IS NOT NULL;",
    )
    .map_err(|error| format!("迁移部署 attempt 证据失败: {error}"))?;
    Ok(())
}

fn row_to_wallet(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedWallet> {
    Ok(SavedWallet {
        id: row.get(0)?,
        name: row.get(1)?,
        public_key: row.get(2)?,
        keystore_json: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn row_to_nonce(row: &rusqlite::Row<'_>) -> rusqlite::Result<NonceAccountRecord> {
    Ok(NonceAccountRecord {
        id: row.get(0)?,
        wallet_id: row.get(1)?,
        owner: row.get(2)?,
        network: row.get(3)?,
        nonce_account: row.get(4)?,
        signature: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn row_to_token_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<WalletTokenAssetRecord> {
    Ok(WalletTokenAssetRecord {
        owner: row.get(0)?,
        network: row.get(1)?,
        account: row.get(2)?,
        mint: row.get(3)?,
        amount: row.get(4)?,
        ui_amount_string: row.get(5)?,
        decimals: row.get(6)?,
        name: row.get(7)?,
        symbol: row.get(8)?,
        logo_uri: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn row_to_token_metadata(row: &rusqlite::Row<'_>) -> rusqlite::Result<TokenMetadataRecord> {
    Ok(TokenMetadataRecord {
        network: row.get(0)?,
        mint: row.get(1)?,
        name: row.get(2)?,
        symbol: row.get(3)?,
        logo_uri: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn row_to_program_deployment(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProgramDeploymentRecord> {
    Ok(ProgramDeploymentRecord {
        genesis_hash: row.get(0)?,
        program_id: row.get(1)?,
        program_sha256: row.get(2)?,
        program_len: row.get(3)?,
        max_data_len: row.get(4)?,
        upgrade_authority: row.get(5)?,
        buffer_address: row.get(6)?,
        status: row.get(7)?,
        create_signature: row.get(8)?,
        create_last_valid_block_height: row.get(9)?,
        last_write_signature: row.get(10)?,
        last_write_chunk_index: row.get(11)?,
        last_write_last_valid_block_height: row.get(12)?,
        completed_writes: row.get(13)?,
        deploy_signature: row.get(14)?,
        deploy_last_valid_block_height: row.get(15)?,
        attempt_evidence_version: row.get(16)?,
        revision: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

fn row_to_program_deployment_attempt(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ProgramDeploymentAttemptRecord> {
    Ok(ProgramDeploymentAttemptRecord {
        genesis_hash: row.get(0)?,
        program_id: row.get(1)?,
        stage: row.get(2)?,
        buffer_address: row.get(3)?,
        chunk_index: row.get(4)?,
        signature: row.get(5)?,
        last_valid_block_height: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

const PROGRAM_DEPLOYMENT_SELECT: &str =
    "SELECT genesis_hash, program_id, program_sha256, program_len, max_data_len, \
     upgrade_authority, buffer_address, status, create_signature, \
     create_last_valid_block_height, last_write_signature, last_write_chunk_index, \
     last_write_last_valid_block_height, completed_writes, deploy_signature, \
     deploy_last_valid_block_height, attempt_evidence_version, revision, created_at, updated_at \
     FROM program_deployment_journal WHERE genesis_hash = ?1 AND program_id = ?2";

const PROGRAM_DEPLOYMENT_ATTEMPT_SELECT: &str =
    "SELECT genesis_hash, program_id, stage, buffer_address, chunk_index, signature, \
     last_valid_block_height, status, created_at, updated_at \
     FROM program_deployment_attempts";

pub fn find_program_deployment(
    genesis_hash: &str,
    program_id: &str,
) -> Result<Option<ProgramDeploymentRecord>, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库读锁已损坏".to_string())?;
    let conn = open_connection()?;
    conn.query_row(
        PROGRAM_DEPLOYMENT_SELECT,
        params![genesis_hash, program_id],
        row_to_program_deployment,
    )
    .optional()
    .map_err(|error| format!("读取部署 journal 失败: {error}"))
}

pub fn load_active_program_deployment_attempts(
    genesis_hash: &str,
    program_id: &str,
) -> Result<Vec<ProgramDeploymentAttemptRecord>, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库读锁已损坏".to_string())?;
    let conn = open_connection()?;
    load_active_program_deployment_attempts_with_connection(&conn, genesis_hash, program_id)
}

pub fn load_program_deployment_attempts(
    genesis_hash: &str,
    program_id: &str,
) -> Result<Vec<ProgramDeploymentAttemptRecord>, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库读锁已损坏".to_string())?;
    let conn = open_connection()?;
    load_program_deployment_attempts_with_connection(&conn, genesis_hash, program_id)
}

pub fn load_program_deployment_snapshot(
    genesis_hash: &str,
    program_id: &str,
) -> Result<
    (
        Option<ProgramDeploymentRecord>,
        Vec<ProgramDeploymentAttemptRecord>,
    ),
    String,
> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库读锁已损坏".to_string())?;
    let conn = open_connection()?;
    let record = conn
        .query_row(
            PROGRAM_DEPLOYMENT_SELECT,
            params![genesis_hash, program_id],
            row_to_program_deployment,
        )
        .optional()
        .map_err(|error| format!("读取部署 journal 失败: {error}"))?;
    let attempts = if record.is_some() {
        load_program_deployment_attempts_with_connection(&conn, genesis_hash, program_id)?
    } else {
        Vec::new()
    };
    Ok((record, attempts))
}

fn load_program_deployment_attempts_with_connection(
    conn: &Connection,
    genesis_hash: &str,
    program_id: &str,
) -> Result<Vec<ProgramDeploymentAttemptRecord>, String> {
    let sql = format!(
        "{PROGRAM_DEPLOYMENT_ATTEMPT_SELECT} \
         WHERE genesis_hash = ?1 AND program_id = ?2 \
         ORDER BY stage, COALESCE(chunk_index, -1), created_at, signature"
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("准备读取部署 attempt 失败: {error}"))?;
    let rows = statement
        .query_map(
            params![genesis_hash, program_id],
            row_to_program_deployment_attempt,
        )
        .map_err(|error| format!("读取部署 attempt 失败: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析部署 attempt 失败: {error}"))
}

fn load_active_program_deployment_attempts_with_connection(
    conn: &Connection,
    genesis_hash: &str,
    program_id: &str,
) -> Result<Vec<ProgramDeploymentAttemptRecord>, String> {
    let sql = format!(
        "{PROGRAM_DEPLOYMENT_ATTEMPT_SELECT} \
         WHERE genesis_hash = ?1 AND program_id = ?2 \
           AND status IN (?3, ?4, ?5) \
         ORDER BY stage, COALESCE(chunk_index, -1), created_at, signature"
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("准备读取部署 attempt 失败: {error}"))?;
    let rows = statement
        .query_map(
            params![
                genesis_hash,
                program_id,
                PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
                PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED,
                PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION,
            ],
            row_to_program_deployment_attempt,
        )
        .map_err(|error| format!("读取部署 attempt 失败: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析部署 attempt 失败: {error}"))
}

pub fn reserve_program_deployment(
    mut record: ProgramDeploymentRecord,
) -> Result<(ProgramDeploymentRecord, bool), String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    reserve_program_deployment_with_connection(&mut conn, &mut record)
}

pub fn reserve_program_deployment_with_attempt(
    mut record: ProgramDeploymentRecord,
    mut attempt: ProgramDeploymentAttemptRecord,
) -> Result<(ProgramDeploymentRecord, bool), String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    reserve_program_deployment_with_attempt_with_connection(&mut conn, &mut record, &mut attempt)
}

pub fn replace_inactive_program_deployment_with_attempt(
    mut record: ProgramDeploymentRecord,
    mut attempt: ProgramDeploymentAttemptRecord,
) -> Result<ProgramDeploymentRecord, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    replace_inactive_program_deployment_with_attempt_with_connection(
        &mut conn,
        &mut record,
        &mut attempt,
    )
}

fn reserve_program_deployment_with_connection(
    conn: &mut Connection,
    record: &mut ProgramDeploymentRecord,
) -> Result<(ProgramDeploymentRecord, bool), String> {
    reserve_program_deployment_with_optional_attempt(conn, record, None)
}

fn reserve_program_deployment_with_attempt_with_connection(
    conn: &mut Connection,
    record: &mut ProgramDeploymentRecord,
    attempt: &mut ProgramDeploymentAttemptRecord,
) -> Result<(ProgramDeploymentRecord, bool), String> {
    if attempt.stage != PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER
        || attempt.chunk_index.is_some()
        || attempt.status != PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED
        || record.attempt_evidence_version != PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION
    {
        return Err(
            "初始部署 attempt 必须是 signed create_buffer 且不得包含 chunk index".to_string(),
        );
    }
    validate_program_deployment_attempt_binding(record, attempt, false)?;
    reserve_program_deployment_with_optional_attempt(conn, record, Some(attempt))
}

fn replace_inactive_program_deployment_with_attempt_with_connection(
    conn: &mut Connection,
    record: &mut ProgramDeploymentRecord,
    attempt: &mut ProgramDeploymentAttemptRecord,
) -> Result<ProgramDeploymentRecord, String> {
    if attempt.stage != PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER
        || attempt.chunk_index.is_some()
        || attempt.status != PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED
        || record.attempt_evidence_version != PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION
    {
        return Err(
            "替换部署记录时，新 attempt 必须是 signed create_buffer 且不得包含 chunk index"
                .to_string(),
        );
    }
    validate_program_deployment_attempt_binding(record, attempt, false)?;
    let now = now_unix_secs()?;
    record.created_at = now;
    record.updated_at = now;
    attempt.created_at = now;
    attempt.updated_at = now;
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开始替换部署 journal 事务失败: {error}"))?;
    let existing = transaction
        .query_row(
            PROGRAM_DEPLOYMENT_SELECT,
            params![record.genesis_hash, record.program_id],
            row_to_program_deployment,
        )
        .optional()
        .map_err(|error| format!("读取旧部署 journal 失败: {error}"))?
        .ok_or_else(|| "旧部署 journal 不存在，无法替换".to_string())?;
    if existing.status == PROGRAM_DEPLOYMENT_STATUS_FINALIZED {
        return Err("旧部署 journal 已 finalized，拒绝替换".to_string());
    }
    transaction
        .execute(
            "DELETE FROM program_deployment_attempts WHERE genesis_hash = ?1 AND program_id = ?2",
            params![record.genesis_hash, record.program_id],
        )
        .map_err(|error| format!("删除旧部署 attempts 失败: {error}"))?;
    transaction
        .execute(
            "DELETE FROM program_deployment_journal WHERE genesis_hash = ?1 AND program_id = ?2",
            params![record.genesis_hash, record.program_id],
        )
        .map_err(|error| format!("删除旧部署 journal 失败: {error}"))?;
    insert_program_deployment_journal(&transaction, record)?;
    insert_program_deployment_attempt(&transaction, attempt)?;
    let stored = transaction
        .query_row(
            PROGRAM_DEPLOYMENT_SELECT,
            params![record.genesis_hash, record.program_id],
            row_to_program_deployment,
        )
        .map_err(|error| format!("回读新部署 journal 失败: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交替换部署 journal 失败: {error}"))?;
    Ok(stored)
}

fn reserve_program_deployment_with_optional_attempt(
    conn: &mut Connection,
    record: &mut ProgramDeploymentRecord,
    mut attempt: Option<&mut ProgramDeploymentAttemptRecord>,
) -> Result<(ProgramDeploymentRecord, bool), String> {
    let now = now_unix_secs()?;
    record.created_at = now;
    record.updated_at = now;
    if let Some(attempt) = attempt.as_deref_mut() {
        attempt.created_at = now;
        attempt.updated_at = now;
    }
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开始部署 journal 事务失败: {error}"))?;
    let inserted =
        insert_program_deployment_journal_with_conflict(&transaction, record, true)? == 1;
    if inserted {
        if let Some(attempt) = attempt.as_deref() {
            insert_program_deployment_attempt(&transaction, attempt)?;
        }
    }
    let stored = transaction
        .query_row(
            PROGRAM_DEPLOYMENT_SELECT,
            params![record.genesis_hash, record.program_id],
            row_to_program_deployment,
        )
        .map_err(|error| format!("回读部署 journal 失败: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交部署 journal 失败: {error}"))?;
    Ok((stored, inserted))
}

fn insert_program_deployment_journal(
    conn: &Connection,
    record: &ProgramDeploymentRecord,
) -> Result<(), String> {
    let inserted = insert_program_deployment_journal_with_conflict(conn, record, false)?;
    if inserted != 1 {
        return Err("写入部署 journal 失败：未插入记录".to_string());
    }
    Ok(())
}

fn insert_program_deployment_journal_with_conflict(
    conn: &Connection,
    record: &ProgramDeploymentRecord,
    ignore_conflict: bool,
) -> Result<usize, String> {
    let sql = if ignore_conflict {
        "INSERT INTO program_deployment_journal (\
            genesis_hash, program_id, program_sha256, program_len, max_data_len, \
            upgrade_authority, buffer_address, status, create_signature, \
            create_last_valid_block_height, last_write_signature, last_write_chunk_index, \
            last_write_last_valid_block_height, completed_writes, deploy_signature, \
            deploy_last_valid_block_height, attempt_evidence_version, revision, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20) \
         ON CONFLICT(genesis_hash, program_id) DO NOTHING"
    } else {
        "INSERT INTO program_deployment_journal (\
            genesis_hash, program_id, program_sha256, program_len, max_data_len, \
            upgrade_authority, buffer_address, status, create_signature, \
            create_last_valid_block_height, last_write_signature, last_write_chunk_index, \
            last_write_last_valid_block_height, completed_writes, deploy_signature, \
            deploy_last_valid_block_height, attempt_evidence_version, revision, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"
    };
    conn.execute(
        sql,
        params![
            record.genesis_hash,
            record.program_id,
            record.program_sha256,
            record.program_len,
            record.max_data_len,
            record.upgrade_authority,
            record.buffer_address,
            record.status,
            record.create_signature,
            record.create_last_valid_block_height,
            record.last_write_signature,
            record.last_write_chunk_index,
            record.last_write_last_valid_block_height,
            record.completed_writes,
            record.deploy_signature,
            record.deploy_last_valid_block_height,
            record.attempt_evidence_version,
            record.revision,
            record.created_at,
            record.updated_at,
        ],
    )
    .map_err(|error| format!("写入部署 journal 失败: {error}"))
}

fn deployment_attempt_stage_and_chunk_are_valid(stage: &str, chunk_index: Option<usize>) -> bool {
    match stage {
        PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER | PROGRAM_DEPLOYMENT_STAGE_DEPLOY => {
            chunk_index.is_none()
        }
        PROGRAM_DEPLOYMENT_STAGE_WRITE => chunk_index.is_some(),
        _ => false,
    }
}

fn deployment_attempt_status_is_known(status: &str) -> bool {
    matches!(
        status,
        PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED
            | PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED
            | PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION
            | PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED
            | PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED_FAILED
            | PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT
    )
}

fn validate_program_deployment_attempt_binding(
    record: &ProgramDeploymentRecord,
    attempt: &ProgramDeploymentAttemptRecord,
    allow_different_buffer: bool,
) -> Result<(), String> {
    if attempt.genesis_hash != record.genesis_hash || attempt.program_id != record.program_id {
        return Err("部署 attempt 与 journal 的网络或 Program ID 不一致".to_string());
    }
    if !allow_different_buffer && attempt.buffer_address != record.buffer_address {
        return Err("部署 attempt 与 journal 的 Buffer 地址不一致".to_string());
    }
    if attempt.signature.trim().is_empty() {
        return Err("部署 attempt 缺少签名".to_string());
    }
    if !deployment_attempt_stage_and_chunk_are_valid(&attempt.stage, attempt.chunk_index) {
        return Err("部署 attempt 的 stage 与 chunk index 组合无效".to_string());
    }
    if !deployment_attempt_status_is_known(&attempt.status) {
        return Err("部署 attempt 状态无效".to_string());
    }
    Ok(())
}

fn insert_program_deployment_attempt(
    transaction: &rusqlite::Transaction<'_>,
    attempt: &ProgramDeploymentAttemptRecord,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO program_deployment_attempts (\
                genesis_hash, program_id, stage, buffer_address, chunk_index, signature, \
                last_valid_block_height, status, created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                attempt.genesis_hash,
                attempt.program_id,
                attempt.stage,
                attempt.buffer_address,
                attempt.chunk_index,
                attempt.signature,
                attempt.last_valid_block_height,
                attempt.status,
                attempt.created_at,
                attempt.updated_at,
            ],
        )
        .map_err(|error| format!("写入部署 attempt 失败: {error}"))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn update_program_deployment_progress(
    record: &ProgramDeploymentRecord,
    status: &str,
    create_signature: Option<&str>,
    create_last_valid_block_height: Option<u64>,
    last_write_signature: Option<&str>,
    last_write_chunk_index: Option<usize>,
    last_write_last_valid_block_height: Option<u64>,
    completed_writes: usize,
    deploy_signature: Option<&str>,
    deploy_last_valid_block_height: Option<u64>,
) -> Result<ProgramDeploymentRecord, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    update_program_deployment_progress_with_connection(
        &mut conn,
        record,
        status,
        create_signature,
        create_last_valid_block_height,
        last_write_signature,
        last_write_chunk_index,
        last_write_last_valid_block_height,
        completed_writes,
        deploy_signature,
        deploy_last_valid_block_height,
    )
}

#[allow(clippy::too_many_arguments)]
fn update_program_deployment_progress_with_connection(
    conn: &mut Connection,
    record: &ProgramDeploymentRecord,
    status: &str,
    create_signature: Option<&str>,
    create_last_valid_block_height: Option<u64>,
    last_write_signature: Option<&str>,
    last_write_chunk_index: Option<usize>,
    last_write_last_valid_block_height: Option<u64>,
    completed_writes: usize,
    deploy_signature: Option<&str>,
    deploy_last_valid_block_height: Option<u64>,
) -> Result<ProgramDeploymentRecord, String> {
    let now = now_unix_secs()?;
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开始更新部署 journal 事务失败: {error}"))?;
    let stored = update_program_deployment_progress_in_transaction(
        &transaction,
        record,
        status,
        create_signature,
        create_last_valid_block_height,
        last_write_signature,
        last_write_chunk_index,
        last_write_last_valid_block_height,
        completed_writes,
        deploy_signature,
        deploy_last_valid_block_height,
        now,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("提交部署 journal 更新失败: {error}"))?;
    Ok(stored)
}

#[allow(clippy::too_many_arguments)]
fn update_program_deployment_progress_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    record: &ProgramDeploymentRecord,
    status: &str,
    create_signature: Option<&str>,
    create_last_valid_block_height: Option<u64>,
    last_write_signature: Option<&str>,
    last_write_chunk_index: Option<usize>,
    last_write_last_valid_block_height: Option<u64>,
    completed_writes: usize,
    deploy_signature: Option<&str>,
    deploy_last_valid_block_height: Option<u64>,
    now: u64,
) -> Result<ProgramDeploymentRecord, String> {
    let updated = transaction
        .execute(
            "UPDATE program_deployment_journal SET \
                status = ?3, \
                create_signature = COALESCE(?4, create_signature), \
                create_last_valid_block_height = COALESCE(?5, create_last_valid_block_height), \
                last_write_signature = COALESCE(?6, last_write_signature), \
                last_write_chunk_index = COALESCE(?7, last_write_chunk_index), \
                last_write_last_valid_block_height = COALESCE(?8, last_write_last_valid_block_height), \
                completed_writes = ?9, \
                deploy_signature = COALESCE(?10, deploy_signature), \
                deploy_last_valid_block_height = COALESCE(?11, deploy_last_valid_block_height), \
                updated_at = ?12, \
                revision = revision + 1 \
             WHERE genesis_hash = ?1 AND program_id = ?2 \
               AND revision = ?13 AND completed_writes <= ?9 \
               AND program_sha256 = ?14 AND program_len = ?15 \
               AND max_data_len = ?16 AND upgrade_authority = ?17 \
               AND buffer_address = ?18",
            params![
                record.genesis_hash,
                record.program_id,
                status,
                create_signature,
                create_last_valid_block_height,
                last_write_signature,
                last_write_chunk_index,
                last_write_last_valid_block_height,
                completed_writes,
                deploy_signature,
                deploy_last_valid_block_height,
                now,
                record.revision,
                record.program_sha256,
                record.program_len,
                record.max_data_len,
                record.upgrade_authority,
                record.buffer_address,
            ],
        )
        .map_err(|error| format!("更新部署 journal 失败: {error}"))?;
    if updated != 1 {
        return Err("部署 journal 已被另一请求更新、记录不存在或完成进度试图倒退".to_string());
    }
    let stored = transaction
        .query_row(
            PROGRAM_DEPLOYMENT_SELECT,
            params![record.genesis_hash, record.program_id],
            row_to_program_deployment,
        )
        .map_err(|error| format!("回读部署 journal 失败: {error}"))?;
    Ok(stored)
}

fn deployment_attempt_transition_is_valid(current: &str, next: &str) -> bool {
    match current {
        PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED => matches!(
            next,
            PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED
                | PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION
                | PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED
                | PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED_FAILED
                | PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT
        ),
        PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED => matches!(
            next,
            PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION
                | PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED
                | PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED_FAILED
                | PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT
        ),
        PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION => matches!(
            next,
            PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED
                | PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED_FAILED
                | PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT
        ),
        _ => false,
    }
}

#[allow(clippy::type_complexity)]
fn deployment_attempt_journal_evidence(
    attempt: &ProgramDeploymentAttemptRecord,
) -> (
    Option<&str>,
    Option<u64>,
    Option<&str>,
    Option<usize>,
    Option<u64>,
    Option<&str>,
    Option<u64>,
) {
    match attempt.stage.as_str() {
        PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER => (
            Some(attempt.signature.as_str()),
            Some(attempt.last_valid_block_height),
            None,
            None,
            None,
            None,
            None,
        ),
        PROGRAM_DEPLOYMENT_STAGE_WRITE => (
            None,
            None,
            Some(attempt.signature.as_str()),
            attempt.chunk_index,
            Some(attempt.last_valid_block_height),
            None,
            None,
        ),
        PROGRAM_DEPLOYMENT_STAGE_DEPLOY => (
            None,
            None,
            None,
            None,
            None,
            Some(attempt.signature.as_str()),
            Some(attempt.last_valid_block_height),
        ),
        _ => (None, None, None, None, None, None, None),
    }
}

pub fn begin_program_deployment_attempt(
    record: &ProgramDeploymentRecord,
    mut attempt: ProgramDeploymentAttemptRecord,
    journal_status: &str,
    completed_writes: usize,
) -> Result<ProgramDeploymentRecord, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    begin_program_deployment_attempt_with_connection(
        &mut conn,
        record,
        &mut attempt,
        journal_status,
        completed_writes,
    )
}

fn begin_program_deployment_attempt_with_connection(
    conn: &mut Connection,
    record: &ProgramDeploymentRecord,
    attempt: &mut ProgramDeploymentAttemptRecord,
    journal_status: &str,
    completed_writes: usize,
) -> Result<ProgramDeploymentRecord, String> {
    if !matches!(
        attempt.stage.as_str(),
        PROGRAM_DEPLOYMENT_STAGE_WRITE | PROGRAM_DEPLOYMENT_STAGE_DEPLOY
    ) || attempt.status != PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED
        || record.attempt_evidence_version != PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION
    {
        return Err("新部署 attempt 必须是 signed write 或 deploy".to_string());
    }
    validate_program_deployment_attempt_binding(record, attempt, false)?;
    let now = now_unix_secs()?;
    attempt.created_at = now;
    attempt.updated_at = now;
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开始部署 attempt 事务失败: {error}"))?;
    insert_program_deployment_attempt(&transaction, attempt)?;
    let (
        create_signature,
        create_last_valid_block_height,
        last_write_signature,
        last_write_chunk_index,
        last_write_last_valid_block_height,
        deploy_signature,
        deploy_last_valid_block_height,
    ) = deployment_attempt_journal_evidence(attempt);
    let stored = update_program_deployment_progress_in_transaction(
        &transaction,
        record,
        journal_status,
        create_signature,
        create_last_valid_block_height,
        last_write_signature,
        last_write_chunk_index,
        last_write_last_valid_block_height,
        completed_writes,
        deploy_signature,
        deploy_last_valid_block_height,
        now,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("提交部署 attempt 失败: {error}"))?;
    Ok(stored)
}

pub fn transition_program_deployment_attempt(
    record: &ProgramDeploymentRecord,
    signature: &str,
    expected_attempt_status: &str,
    next_attempt_status: &str,
    journal_status: &str,
    completed_writes: usize,
) -> Result<ProgramDeploymentRecord, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    transition_program_deployment_attempt_with_connection(
        &mut conn,
        record,
        signature,
        expected_attempt_status,
        next_attempt_status,
        journal_status,
        completed_writes,
    )
}

#[allow(clippy::too_many_arguments)]
fn transition_program_deployment_attempt_with_connection(
    conn: &mut Connection,
    record: &ProgramDeploymentRecord,
    signature: &str,
    expected_attempt_status: &str,
    next_attempt_status: &str,
    journal_status: &str,
    completed_writes: usize,
) -> Result<ProgramDeploymentRecord, String> {
    if !deployment_attempt_transition_is_valid(expected_attempt_status, next_attempt_status) {
        return Err(format!(
            "无效的部署 attempt 状态迁移: {expected_attempt_status} -> {next_attempt_status}"
        ));
    }
    let now = now_unix_secs()?;
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开始迁移部署 attempt 事务失败: {error}"))?;
    let select = format!(
        "{PROGRAM_DEPLOYMENT_ATTEMPT_SELECT} \
         WHERE genesis_hash = ?1 AND program_id = ?2 AND signature = ?3"
    );
    let attempt = transaction
        .query_row(
            &select,
            params![record.genesis_hash, record.program_id, signature],
            row_to_program_deployment_attempt,
        )
        .optional()
        .map_err(|error| format!("读取待迁移部署 attempt 失败: {error}"))?
        .ok_or_else(|| "待迁移的部署 attempt 不存在".to_string())?;
    validate_program_deployment_attempt_binding(record, &attempt, false)?;
    let updated_attempt = transaction
        .execute(
            "UPDATE program_deployment_attempts \
                SET status = ?4, updated_at = ?5 \
              WHERE genesis_hash = ?1 AND program_id = ?2 AND signature = ?3 \
                AND status = ?6",
            params![
                record.genesis_hash,
                record.program_id,
                signature,
                next_attempt_status,
                now,
                expected_attempt_status,
            ],
        )
        .map_err(|error| format!("迁移部署 attempt 失败: {error}"))?;
    if updated_attempt != 1 {
        return Err("部署 attempt 已被另一请求更新或当前状态不匹配".to_string());
    }
    let (
        create_signature,
        create_last_valid_block_height,
        last_write_signature,
        last_write_chunk_index,
        last_write_last_valid_block_height,
        deploy_signature,
        deploy_last_valid_block_height,
    ) = deployment_attempt_journal_evidence(&attempt);
    let stored = update_program_deployment_progress_in_transaction(
        &transaction,
        record,
        journal_status,
        create_signature,
        create_last_valid_block_height,
        last_write_signature,
        last_write_chunk_index,
        last_write_last_valid_block_height,
        completed_writes,
        deploy_signature,
        deploy_last_valid_block_height,
        now,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("提交部署 attempt 状态迁移失败: {error}"))?;
    Ok(stored)
}

pub fn rotate_program_deployment_create_attempt(
    record: &ProgramDeploymentRecord,
    mut attempt: ProgramDeploymentAttemptRecord,
    journal_status: &str,
) -> Result<ProgramDeploymentRecord, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    rotate_program_deployment_create_attempt_with_connection(
        &mut conn,
        record,
        &mut attempt,
        journal_status,
    )
}

pub fn promote_program_deployment_attempt_evidence(
    record: &ProgramDeploymentRecord,
    journal_status: &str,
    completed_writes: usize,
) -> Result<ProgramDeploymentRecord, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    promote_program_deployment_attempt_evidence_with_connection(
        &mut conn,
        record,
        journal_status,
        completed_writes,
    )
}

fn promote_program_deployment_attempt_evidence_with_connection(
    conn: &mut Connection,
    record: &ProgramDeploymentRecord,
    journal_status: &str,
    completed_writes: usize,
) -> Result<ProgramDeploymentRecord, String> {
    let now = now_unix_secs()?;
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开始升级部署 attempt 证据事务失败: {error}"))?;
    let updated = transaction
        .execute(
            "UPDATE program_deployment_journal \
                SET status = ?3, completed_writes = ?4, \
                    attempt_evidence_version = ?5, updated_at = ?6, \
                    revision = revision + 1 \
              WHERE genesis_hash = ?1 AND program_id = ?2 AND revision = ?7 \
                AND attempt_evidence_version = 0 AND completed_writes <= ?4 \
                AND program_sha256 = ?8 AND program_len = ?9 \
                AND max_data_len = ?10 AND upgrade_authority = ?11 \
                AND buffer_address = ?12",
            params![
                record.genesis_hash,
                record.program_id,
                journal_status,
                completed_writes,
                PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION,
                now,
                record.revision,
                record.program_sha256,
                record.program_len,
                record.max_data_len,
                record.upgrade_authority,
                record.buffer_address,
            ],
        )
        .map_err(|error| format!("升级部署 attempt 证据失败: {error}"))?;
    if updated != 1 {
        return Err("部署 attempt 证据版本已变化、journal 已更新或 finalized 进度倒退".to_string());
    }
    let stored = transaction
        .query_row(
            PROGRAM_DEPLOYMENT_SELECT,
            params![record.genesis_hash, record.program_id],
            row_to_program_deployment,
        )
        .map_err(|error| format!("回读升级后的部署 journal 失败: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交部署 attempt 证据升级失败: {error}"))?;
    Ok(stored)
}

fn rotate_program_deployment_create_attempt_with_connection(
    conn: &mut Connection,
    record: &ProgramDeploymentRecord,
    attempt: &mut ProgramDeploymentAttemptRecord,
    journal_status: &str,
) -> Result<ProgramDeploymentRecord, String> {
    if attempt.stage != PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER
        || attempt.chunk_index.is_some()
        || attempt.status != PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED
        || attempt.buffer_address == record.buffer_address
    {
        return Err("Buffer 轮换必须使用不同地址的 signed create_buffer attempt".to_string());
    }
    validate_program_deployment_attempt_binding(record, attempt, true)?;
    let now = now_unix_secs()?;
    attempt.created_at = now;
    attempt.updated_at = now;
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开始轮换 Buffer 事务失败: {error}"))?;
    let updated = transaction
        .execute(
            "UPDATE program_deployment_journal \
                SET buffer_address = ?3, status = ?4, create_signature = ?5, \
                    create_last_valid_block_height = ?6, last_write_signature = NULL, \
                    last_write_chunk_index = NULL, \
                    last_write_last_valid_block_height = NULL, completed_writes = 0, \
                    deploy_signature = NULL, deploy_last_valid_block_height = NULL, \
                    attempt_evidence_version = ?7, updated_at = ?8, revision = revision + 1 \
              WHERE genesis_hash = ?1 AND program_id = ?2 AND revision = ?9 \
                AND completed_writes = 0 \
                AND program_sha256 = ?10 AND program_len = ?11 \
                AND max_data_len = ?12 AND upgrade_authority = ?13 \
                AND buffer_address = ?14 \
                AND EXISTS (\
                    SELECT 1 FROM program_deployment_attempts prior \
                     WHERE prior.genesis_hash = ?1 AND prior.program_id = ?2 \
                       AND prior.stage = 'create_buffer' \
                       AND prior.status = 'expired_absent'\
                ) \
                AND NOT EXISTS (\
                    SELECT 1 FROM program_deployment_attempts prior \
                     WHERE prior.genesis_hash = ?1 AND prior.program_id = ?2 \
                       AND (prior.stage IN ('write', 'deploy') \
                            OR (prior.stage = 'create_buffer' \
                                AND prior.status <> 'expired_absent'))\
                )",
            params![
                record.genesis_hash,
                record.program_id,
                attempt.buffer_address,
                journal_status,
                attempt.signature,
                attempt.last_valid_block_height,
                PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION,
                now,
                record.revision,
                record.program_sha256,
                record.program_len,
                record.max_data_len,
                record.upgrade_authority,
                record.buffer_address,
            ],
        )
        .map_err(|error| format!("轮换部署 Buffer 失败: {error}"))?;
    if updated != 1 {
        return Err(
            "Buffer 轮换被拒绝：journal 已变化、旧创建未证明过期，或已有 write/deploy 证据"
                .to_string(),
        );
    }
    insert_program_deployment_attempt(&transaction, attempt)?;
    let stored = transaction
        .query_row(
            PROGRAM_DEPLOYMENT_SELECT,
            params![record.genesis_hash, record.program_id],
            row_to_program_deployment,
        )
        .map_err(|error| format!("回读轮换后的部署 journal 失败: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交 Buffer 轮换失败: {error}"))?;
    Ok(stored)
}

pub fn load() -> Result<Vec<SavedWallet>, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库读锁已损坏".to_string())?;
    let conn = open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, public_key, keystore_json, created_at, updated_at \
             FROM wallets ORDER BY updated_at DESC, created_at DESC",
        )
        .map_err(|e| format!("读取钱包列表失败: {}", e))?;
    let rows = stmt
        .query_map([], row_to_wallet)
        .map_err(|e| format!("读取钱包列表失败: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取钱包列表失败: {}", e))
}

pub fn list_summaries() -> Result<Vec<WalletSummary>, String> {
    Ok(load()?.into_iter().map(WalletSummary::from).collect())
}

pub fn find(wallet_id: &str) -> Result<SavedWallet, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库读锁已损坏".to_string())?;
    let conn = open_connection()?;
    conn.query_row(
        "SELECT id, name, public_key, keystore_json, created_at, updated_at FROM wallets WHERE id = ?1",
        params![wallet_id],
        row_to_wallet,
    )
    .optional()
    .map_err(|e| format!("读取钱包失败: {}", e))?
    .ok_or_else(|| "未找到已保存钱包".to_string())
}

pub fn upsert(
    keystore_json: String,
    public_key: String,
    name: Option<String>,
) -> Result<SavedWallet, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let conn = open_connection()?;
    let now = now_unix_secs()?;
    let name = normalize_wallet_name(name, &public_key);
    let existing: Option<SavedWallet> = conn
        .query_row(
            "SELECT id, name, public_key, keystore_json, created_at, updated_at FROM wallets WHERE public_key = ?1",
            params![public_key],
            row_to_wallet,
        )
        .optional()
        .map_err(|e| format!("读取钱包失败: {}", e))?;

    let wallet = if let Some(mut wallet) = existing {
        wallet.name = name;
        wallet.keystore_json = keystore_json;
        wallet.updated_at = now;
        conn.execute(
            "UPDATE wallets SET name = ?1, keystore_json = ?2, updated_at = ?3 WHERE id = ?4",
            params![
                wallet.name,
                wallet.keystore_json,
                wallet.updated_at,
                wallet.id
            ],
        )
        .map_err(|e| format!("保存钱包失败: {}", e))?;
        wallet
    } else {
        let wallet = SavedWallet {
            id: Uuid::new_v4().simple().to_string(),
            name,
            public_key,
            keystore_json,
            created_at: now,
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO wallets (id, name, public_key, keystore_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                wallet.id,
                wallet.name,
                wallet.public_key,
                wallet.keystore_json,
                wallet.created_at,
                wallet.updated_at,
            ],
        )
        .map_err(|e| format!("保存钱包失败: {}", e))?;
        wallet
    };

    Ok(wallet)
}

pub fn update_metadata(
    wallet_id: &str,
    name: &str,
    keystore_json: String,
) -> Result<SavedWallet, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let name = name.trim();
    if name.is_empty() {
        return Err("钱包名称不能为空".to_string());
    }

    let conn = open_connection()?;
    let now = now_unix_secs()?;
    let updated = conn
        .execute(
            "UPDATE wallets SET name = ?1, keystore_json = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, keystore_json, now, wallet_id],
        )
        .map_err(|e| format!("更新钱包失败: {}", e))?;
    if updated == 0 {
        return Err("未找到已保存钱包".to_string());
    }
    conn.query_row(
        "SELECT id, name, public_key, keystore_json, created_at, updated_at FROM wallets WHERE id = ?1",
        params![wallet_id],
        row_to_wallet,
    )
    .map_err(|e| format!("读取钱包失败: {}", e))
}

/// Replaces only encrypted wallet material while preserving the wallet identity and creation time.
/// The compare-and-swap guard prevents a concurrent rename or rewrite from being silently lost.
pub fn replace_keystore_atomically(
    wallet_id: &str,
    expected_public_key: &str,
    expected_keystore_json: &str,
    keystore_json: String,
) -> Result<SavedWallet, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    let now = now_unix_secs()?;
    replace_keystore_atomically_with_connection(
        &mut conn,
        wallet_id,
        expected_public_key,
        expected_keystore_json,
        keystore_json,
        now,
    )
}

fn replace_keystore_atomically_with_connection(
    conn: &mut Connection,
    wallet_id: &str,
    expected_public_key: &str,
    expected_keystore_json: &str,
    keystore_json: String,
    now: u64,
) -> Result<SavedWallet, String> {
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开始钱包改密事务失败: {error}"))?;
    let updated = transaction
        .execute(
            "UPDATE wallets SET keystore_json = ?1, updated_at = ?2 \
             WHERE id = ?3 AND public_key = ?4 AND keystore_json = ?5",
            params![
                keystore_json,
                now,
                wallet_id,
                expected_public_key,
                expected_keystore_json
            ],
        )
        .map_err(|error| format!("原子更新钱包密文失败: {error}"))?;
    if updated != 1 {
        return Err("钱包已被其它操作修改，请刷新后重试".to_string());
    }
    let wallet = transaction
        .query_row(
            "SELECT id, name, public_key, keystore_json, created_at, updated_at FROM wallets WHERE id = ?1",
            params![wallet_id],
            row_to_wallet,
        )
        .map_err(|error| format!("回读改密后的钱包失败: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交钱包改密事务失败: {error}"))?;
    Ok(wallet)
}

pub fn delete(wallet_id: &str) -> Result<(), String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let conn = open_connection()?;
    let deleted = conn
        .execute("DELETE FROM wallets WHERE id = ?1", params![wallet_id])
        .map_err(|e| format!("删除钱包失败: {}", e))?;
    if deleted == 0 {
        return Err("未找到已保存钱包".to_string());
    }
    Ok(())
}

pub fn add_nonce_account(
    wallet_id: Option<&str>,
    owner: &str,
    network: &str,
    nonce_account: &str,
    signature: &str,
) -> Result<NonceAccountRecord, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let conn = open_connection()?;
    let now = now_unix_secs()?;
    let record = NonceAccountRecord {
        id: Uuid::new_v4().simple().to_string(),
        wallet_id: wallet_id.map(ToOwned::to_owned),
        owner: owner.to_string(),
        network: network.to_string(),
        nonce_account: nonce_account.to_string(),
        signature: signature.to_string(),
        created_at: now,
    };
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO nonce_accounts \
             (id, wallet_id, owner, network, nonce_account, signature, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                record.id,
                record.wallet_id,
                record.owner,
                record.network,
                record.nonce_account,
                record.signature,
                record.created_at,
            ],
        )
        .map_err(|e| format!("保存 Nonce 账户失败: {}", e))?;
    if inserted == 0 {
        return conn
            .query_row(
                "SELECT id, wallet_id, owner, network, nonce_account, signature, created_at \
                 FROM nonce_accounts WHERE nonce_account = ?1",
                params![nonce_account],
                row_to_nonce,
            )
            .map_err(|e| format!("读取已保存 Nonce 账户失败: {}", e));
    }
    conn.execute(
        "DELETE FROM nonce_accounts
         WHERE owner = ?1 AND network = ?2 AND id NOT IN (
             SELECT id FROM nonce_accounts
             WHERE owner = ?1 AND network = ?2
             ORDER BY created_at DESC
             LIMIT ?3
         )",
        params![owner, network, MAX_NONCE_ACCOUNTS_PER_OWNER_NETWORK as i64],
    )
    .map_err(|e| format!("清理旧 Nonce 账户失败: {}", e))?;
    Ok(record)
}

pub fn list_nonce_accounts(owner: &str, network: &str) -> Result<Vec<NonceAccountRecord>, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库读锁已损坏".to_string())?;
    let conn = open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, wallet_id, owner, network, nonce_account, signature, created_at \
             FROM nonce_accounts WHERE owner = ?1 AND network = ?2 ORDER BY created_at DESC LIMIT ?3",
        )
        .map_err(|e| format!("读取 Nonce 账户列表失败: {}", e))?;
    let rows = stmt
        .query_map(
            params![owner, network, MAX_NONCE_ACCOUNTS_PER_OWNER_NETWORK as i64],
            row_to_nonce,
        )
        .map_err(|e| format!("读取 Nonce 账户列表失败: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取 Nonce 账户列表失败: {}", e))
}

pub fn get_wallet_assets(owner: &str, network: &str) -> Result<Option<WalletAssetsRecord>, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库读锁已损坏".to_string())?;
    let conn = open_connection()?;
    let header = conn
        .query_row(
            "SELECT sol_balance, updated_at FROM wallet_assets WHERE owner = ?1 AND network = ?2",
            params![owner, network],
            |row| Ok((row.get::<_, f64>(0)?, row.get::<_, u64>(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取钱包资产缓存失败: {}", e))?;
    let Some((sol_balance, updated_at)) = header else {
        return Ok(None);
    };

    let mut stmt = conn
        .prepare(
            "SELECT owner, network, account, mint, amount, ui_amount_string, decimals, name, symbol, logo_uri, updated_at \
             FROM wallet_token_assets \
             WHERE owner = ?1 AND network = ?2 \
             ORDER BY LENGTH(amount) DESC, amount DESC, mint ASC, account ASC",
        )
        .map_err(|e| format!("读取 Token 资产缓存失败: {}", e))?;
    let rows = stmt
        .query_map(params![owner, network], row_to_token_asset)
        .map_err(|e| format!("读取 Token 资产缓存失败: {}", e))?;
    let tokens = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取 Token 资产缓存失败: {}", e))?;

    Ok(Some(WalletAssetsRecord {
        owner: owner.to_string(),
        network: network.to_string(),
        sol_balance,
        tokens,
        updated_at,
    }))
}

pub fn save_wallet_assets(
    owner: &str,
    network: &str,
    sol_balance: f64,
    tokens: &[WalletTokenAssetRecord],
) -> Result<u64, String> {
    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    let now = now_unix_secs()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("保存钱包资产缓存失败: {}", e))?;
    tx.execute(
        "INSERT INTO wallet_assets (owner, network, sol_balance, updated_at) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(owner, network) DO UPDATE SET \
         sol_balance = excluded.sol_balance, updated_at = excluded.updated_at",
        params![owner, network, sol_balance, now],
    )
    .map_err(|e| format!("保存钱包资产缓存失败: {}", e))?;
    tx.execute(
        "DELETE FROM wallet_token_assets WHERE owner = ?1 AND network = ?2",
        params![owner, network],
    )
    .map_err(|e| format!("清理 Token 资产缓存失败: {}", e))?;
    for token in tokens {
        tx.execute(
            "INSERT INTO wallet_token_assets \
             (owner, network, account, mint, amount, ui_amount_string, decimals, name, symbol, logo_uri, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                owner,
                network,
                token.account,
                token.mint,
                token.amount,
                token.ui_amount_string,
                token.decimals,
                token.name,
                token.symbol,
                token.logo_uri,
                now,
            ],
        )
        .map_err(|e| format!("保存 Token 资产缓存失败: {}", e))?;
    }
    tx.commit()
        .map_err(|e| format!("提交钱包资产缓存失败: {}", e))?;
    Ok(now)
}

pub fn get_token_metadata(
    network: &str,
    mints: &[String],
) -> Result<Vec<TokenMetadataRecord>, String> {
    if mints.is_empty() {
        return Ok(Vec::new());
    }

    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库读锁已损坏".to_string())?;
    let conn = open_connection()?;
    let mut stmt = conn
        .prepare(
            "SELECT network, mint, name, symbol, logo_uri, updated_at \
             FROM token_metadata WHERE network = ?1 AND mint = ?2",
        )
        .map_err(|e| format!("读取 Token 元数据缓存失败: {}", e))?;
    let mut records = Vec::new();
    for mint in mints {
        if let Some(record) = stmt
            .query_row(params![network, mint], row_to_token_metadata)
            .optional()
            .map_err(|e| format!("读取 Token 元数据缓存失败: {}", e))?
        {
            records.push(record);
        }
    }
    Ok(records)
}

pub fn save_token_metadata(network: &str, records: &[TokenMetadataRecord]) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }

    let _guard = store_lock()
        .lock()
        .map_err(|_| "数据库写锁已损坏".to_string())?;
    let mut conn = open_connection()?;
    let now = now_unix_secs()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("保存 Token 元数据缓存失败: {}", e))?;
    for record in records {
        tx.execute(
            "INSERT INTO token_metadata (network, mint, name, symbol, logo_uri, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(network, mint) DO UPDATE SET \
             name = COALESCE(excluded.name, token_metadata.name), \
             symbol = COALESCE(excluded.symbol, token_metadata.symbol), \
             logo_uri = COALESCE(excluded.logo_uri, token_metadata.logo_uri), \
             updated_at = excluded.updated_at",
            params![
                network,
                record.mint,
                record.name,
                record.symbol,
                record.logo_uri,
                now,
            ],
        )
        .map_err(|e| format!("保存 Token 元数据缓存失败: {}", e))?;
    }
    tx.commit()
        .map_err(|e| format!("提交 Token 元数据缓存失败: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_keystore_replacement_preserves_identity_and_rejects_stale_ciphertext() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO wallets (id, name, public_key, keystore_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params!["wallet-id", "Primary", "solana-address", "old-ciphertext", 10_u64, 10_u64],
        )
        .unwrap();

        let replaced = replace_keystore_atomically_with_connection(
            &mut conn,
            "wallet-id",
            "solana-address",
            "old-ciphertext",
            "new-ciphertext".to_string(),
            20,
        )
        .unwrap();
        assert_eq!(replaced.id, "wallet-id");
        assert_eq!(replaced.name, "Primary");
        assert_eq!(replaced.public_key, "solana-address");
        assert_eq!(replaced.keystore_json, "new-ciphertext");
        assert_eq!(replaced.created_at, 10);
        assert_eq!(replaced.updated_at, 20);

        assert!(replace_keystore_atomically_with_connection(
            &mut conn,
            "wallet-id",
            "solana-address",
            "old-ciphertext",
            "stale-overwrite".to_string(),
            30,
        )
        .is_err());
        let stored = conn
            .query_row(
                "SELECT id, name, public_key, keystore_json, created_at, updated_at FROM wallets WHERE id = ?1",
                ["wallet-id"],
                row_to_wallet,
            )
            .unwrap();
        assert_eq!(stored.keystore_json, "new-ciphertext");
        assert_eq!(stored.updated_at, 20);
    }

    #[test]
    fn wallet_summary_includes_universal_wallet_accounts() {
        let wallet = SavedWallet {
            id: "wallet-id".to_string(),
            name: "Primary".to_string(),
            public_key: "solana-address".to_string(),
            keystore_json: serde_json::json!({
                "metadata": {
                    "evm_address": "0x1234567890abcdef1234567890abcdef12345678",
                    "evm_wallet_id": "evm-1234567890abcdef1234567890abcdef12345678",
                    "evm_derivation_path": "m/44'/60'/0'/0/0"
                }
            })
            .to_string(),
            created_at: 1,
            updated_at: 2,
        };

        let summary = WalletSummary::from(wallet);

        assert_eq!(
            summary.evm_address.as_deref(),
            Some("0x1234567890abcdef1234567890abcdef12345678")
        );
        assert_eq!(
            summary.evm_wallet_id.as_deref(),
            Some("evm-1234567890abcdef1234567890abcdef12345678")
        );
        assert_eq!(
            summary.evm_derivation_path.as_deref(),
            Some("m/44'/60'/0'/0/0")
        );
        assert_eq!(summary.secret_type, "private_key");
    }

    #[test]
    fn wallet_summary_identifies_v3_mnemonic_keystore() {
        let keystore_json = KeyManager::mnemonic_to_encrypted_json(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "m/44'/501'/0'/0'",
            "strong-password",
        )
        .unwrap();
        let public_key = serde_json::from_str::<serde_json::Value>(&keystore_json).unwrap()
            ["public_key"]
            .as_str()
            .unwrap()
            .to_string();
        let summary = WalletSummary::from(SavedWallet {
            id: "wallet-id".to_string(),
            name: "Seed Wallet".to_string(),
            public_key,
            keystore_json,
            created_at: 1,
            updated_at: 2,
        });

        assert_eq!(summary.keystore_version, "v3");
        assert_eq!(summary.secret_type, "mnemonic");
    }

    fn deployment_record(buffer_address: &str, program_sha256: &str) -> ProgramDeploymentRecord {
        ProgramDeploymentRecord {
            genesis_hash: "devnet-genesis".to_string(),
            program_id: "program-id".to_string(),
            program_sha256: program_sha256.to_string(),
            program_len: 1024,
            max_data_len: 2048,
            upgrade_authority: "upgrade-authority".to_string(),
            buffer_address: buffer_address.to_string(),
            status: "create_buffer_signed".to_string(),
            create_signature: Some("create-signature".to_string()),
            create_last_valid_block_height: Some(42),
            last_write_signature: None,
            last_write_chunk_index: None,
            last_write_last_valid_block_height: None,
            completed_writes: 0,
            deploy_signature: None,
            deploy_last_valid_block_height: None,
            attempt_evidence_version: PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION,
            revision: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn deployment_attempt(
        stage: &str,
        buffer_address: &str,
        chunk_index: Option<usize>,
        signature: &str,
        last_valid_block_height: u64,
    ) -> ProgramDeploymentAttemptRecord {
        ProgramDeploymentAttemptRecord {
            genesis_hash: "devnet-genesis".to_string(),
            program_id: "program-id".to_string(),
            stage: stage.to_string(),
            buffer_address: buffer_address.to_string(),
            chunk_index,
            signature: signature.to_string(),
            last_valid_block_height,
            status: PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED.to_string(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn deployment_reservation_is_first_writer_wins() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        let mut first = deployment_record("buffer-a", "artifact-a");
        let (stored_first, inserted_first) =
            reserve_program_deployment_with_connection(&mut conn, &mut first).unwrap();
        assert!(inserted_first);
        assert_eq!(stored_first.buffer_address, "buffer-a");

        let mut competing = deployment_record("buffer-b", "artifact-b");
        let (stored_competing, inserted_competing) =
            reserve_program_deployment_with_connection(&mut conn, &mut competing).unwrap();
        assert!(!inserted_competing);
        assert_eq!(stored_competing.buffer_address, "buffer-a");
        assert_eq!(stored_competing.program_sha256, "artifact-a");
        assert_eq!(
            stored_competing.create_signature.as_deref(),
            Some("create-signature")
        );
    }

    #[test]
    fn deployment_reservation_persists_create_attempt_atomically() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        let mut record = deployment_record("buffer-a", "artifact-a");
        let mut attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-a",
            None,
            "create-signature",
            42,
        );
        let (stored, inserted) = reserve_program_deployment_with_attempt_with_connection(
            &mut conn,
            &mut record,
            &mut attempt,
        )
        .unwrap();
        assert!(inserted);
        assert_eq!(stored.revision, 0);

        let active = load_active_program_deployment_attempts_with_connection(
            &conn,
            "devnet-genesis",
            "program-id",
        )
        .unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].signature, "create-signature");
        assert_eq!(active[0].last_valid_block_height, 42);

        let mut competing = deployment_record("buffer-b", "artifact-b");
        competing.create_signature = Some("competing-create".to_string());
        let mut competing_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-b",
            None,
            "competing-create",
            43,
        );
        let (winner, inserted) = reserve_program_deployment_with_attempt_with_connection(
            &mut conn,
            &mut competing,
            &mut competing_attempt,
        )
        .unwrap();
        assert!(!inserted);
        assert_eq!(winner.buffer_address, "buffer-a");
        let competing_count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM program_deployment_attempts WHERE signature = ?1",
                ["competing-create"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(competing_count, 0);
    }

    #[test]
    fn inactive_deployment_can_be_replaced_for_redeploy() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        let mut old = deployment_record("buffer-old", "artifact-old");
        old.status = "create_buffer_requires_reconciliation".to_string();
        let mut old_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-old",
            None,
            "old-create",
            42,
        );
        let (old, _) = reserve_program_deployment_with_attempt_with_connection(
            &mut conn,
            &mut old,
            &mut old_attempt,
        )
        .unwrap();
        let old = transition_program_deployment_attempt_with_connection(
            &mut conn,
            &old,
            "old-create",
            PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
            PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT,
            "create_buffer_requires_reconciliation",
            0,
        )
        .unwrap();

        let mut next = deployment_record("buffer-new", "artifact-new");
        next.status = "create_buffer_signed".to_string();
        let mut next_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-new",
            None,
            "new-create",
            84,
        );
        let replaced = replace_inactive_program_deployment_with_attempt_with_connection(
            &mut conn,
            &mut next,
            &mut next_attempt,
        )
        .unwrap();
        assert_eq!(old.program_id, replaced.program_id);
        assert_eq!(replaced.buffer_address, "buffer-new");
        assert_eq!(replaced.program_sha256, "artifact-new");

        let attempts =
            load_program_deployment_attempts_with_connection(&conn, "devnet-genesis", "program-id")
                .unwrap();
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].signature, "new-create");
    }

    #[test]
    fn non_finalized_deployment_can_be_replaced_for_redeploy() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        let mut active = deployment_record("buffer-active", "artifact-old");
        let mut active_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-active",
            None,
            "active-create",
            42,
        );
        let (_active, _) = reserve_program_deployment_with_attempt_with_connection(
            &mut conn,
            &mut active,
            &mut active_attempt,
        )
        .unwrap();

        let mut next = deployment_record("buffer-new", "artifact-new");
        let mut next_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-new",
            None,
            "new-create",
            84,
        );
        let replaced = replace_inactive_program_deployment_with_attempt_with_connection(
            &mut conn,
            &mut next,
            &mut next_attempt,
        )
        .unwrap();
        assert_eq!(replaced.buffer_address, "buffer-new");
        let active_count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM program_deployment_attempts WHERE signature = ?1",
                ["active-create"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_count, 0);

        conn.execute(
            "UPDATE program_deployment_journal SET status = ?1 WHERE genesis_hash = ?2 AND program_id = ?3",
            params![PROGRAM_DEPLOYMENT_STATUS_FINALIZED, "devnet-genesis", "program-id"],
        )
        .unwrap();
        assert!(
            replace_inactive_program_deployment_with_attempt_with_connection(
                &mut conn,
                &mut next,
                &mut next_attempt,
            )
            .is_err()
        );
    }

    #[test]
    fn stale_journal_revision_rolls_back_new_attempt() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut record = deployment_record("buffer-a", "artifact-a");
        record.status = "buffer_ready".to_string();
        let (record, _) =
            reserve_program_deployment_with_connection(&mut conn, &mut record).unwrap();

        let mut first_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_WRITE,
            "buffer-a",
            Some(0),
            "write-0",
            84,
        );
        let updated = begin_program_deployment_attempt_with_connection(
            &mut conn,
            &record,
            &mut first_attempt,
            "write_signed",
            0,
        )
        .unwrap();
        assert_eq!(updated.revision, 1);

        let mut stale_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_WRITE,
            "buffer-a",
            Some(1),
            "write-stale",
            85,
        );
        assert!(begin_program_deployment_attempt_with_connection(
            &mut conn,
            &record,
            &mut stale_attempt,
            "write_signed",
            0,
        )
        .is_err());
        let stale_count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM program_deployment_attempts WHERE signature = ?1",
                ["write-stale"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale_count, 0);
    }

    #[test]
    fn attempt_transition_updates_exact_signature_and_preserves_finalized_progress() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut record = deployment_record("buffer-a", "artifact-a");
        record.status = "buffer_ready".to_string();
        let (record, _) =
            reserve_program_deployment_with_connection(&mut conn, &mut record).unwrap();
        let mut attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_WRITE,
            "buffer-a",
            Some(2),
            "write-2",
            84,
        );
        let signed = begin_program_deployment_attempt_with_connection(
            &mut conn,
            &record,
            &mut attempt,
            "write_signed",
            1,
        )
        .unwrap();
        let confirmed = transition_program_deployment_attempt_with_connection(
            &mut conn,
            &signed,
            "write-2",
            PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
            PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED,
            "write_confirmed",
            1,
        )
        .unwrap();
        assert_eq!(confirmed.completed_writes, 1);
        assert_eq!(confirmed.revision, 2);

        assert!(transition_program_deployment_attempt_with_connection(
            &mut conn,
            &confirmed,
            "write-2",
            PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
            PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED,
            "buffer_ready",
            2,
        )
        .is_err());
        let finalized = transition_program_deployment_attempt_with_connection(
            &mut conn,
            &confirmed,
            "write-2",
            PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED,
            PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED,
            "buffer_ready",
            2,
        )
        .unwrap();
        assert_eq!(finalized.completed_writes, 2);
        assert!(load_active_program_deployment_attempts_with_connection(
            &conn,
            "devnet-genesis",
            "program-id"
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn active_attempt_query_keeps_non_contiguous_chunks() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut record = deployment_record("buffer-a", "artifact-a");
        record.status = "buffer_ready".to_string();
        let (mut record, _) =
            reserve_program_deployment_with_connection(&mut conn, &mut record).unwrap();
        for (index, signature) in [(0, "write-0"), (3, "write-3")] {
            let mut attempt = deployment_attempt(
                PROGRAM_DEPLOYMENT_STAGE_WRITE,
                "buffer-a",
                Some(index),
                signature,
                84 + index as u64,
            );
            record = begin_program_deployment_attempt_with_connection(
                &mut conn,
                &record,
                &mut attempt,
                "write_signed",
                0,
            )
            .unwrap();
        }
        let active = load_active_program_deployment_attempts_with_connection(
            &conn,
            "devnet-genesis",
            "program-id",
        )
        .unwrap();
        assert_eq!(
            active
                .iter()
                .map(|attempt| attempt.chunk_index)
                .collect::<Vec<_>>(),
            vec![Some(0), Some(3)]
        );
    }

    #[test]
    fn create_rotation_requires_expired_create_and_no_write_or_deploy_evidence() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut record = deployment_record("buffer-a", "artifact-a");
        let mut create_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-a",
            None,
            "create-signature",
            42,
        );
        let (record, _) = reserve_program_deployment_with_attempt_with_connection(
            &mut conn,
            &mut record,
            &mut create_attempt,
        )
        .unwrap();
        let expired = transition_program_deployment_attempt_with_connection(
            &mut conn,
            &record,
            "create-signature",
            PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
            PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT,
            "create_buffer_requires_reconciliation",
            0,
        )
        .unwrap();
        let mut rotated_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-b",
            None,
            "create-rotated",
            84,
        );
        let rotated = rotate_program_deployment_create_attempt_with_connection(
            &mut conn,
            &expired,
            &mut rotated_attempt,
            "create_buffer_signed",
        )
        .unwrap();
        assert_eq!(rotated.buffer_address, "buffer-b");
        assert_eq!(rotated.create_signature.as_deref(), Some("create-rotated"));

        let mut stale_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-c",
            None,
            "create-stale",
            85,
        );
        assert!(rotate_program_deployment_create_attempt_with_connection(
            &mut conn,
            &expired,
            &mut stale_attempt,
            "create_buffer_signed",
        )
        .is_err());

        let rotated_expired = transition_program_deployment_attempt_with_connection(
            &mut conn,
            &rotated,
            "create-rotated",
            PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
            PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT,
            "create_buffer_requires_reconciliation",
            0,
        )
        .unwrap();
        conn.execute(
            "UPDATE program_deployment_journal \
             SET upgrade_authority = 'tampered-authority' \
             WHERE genesis_hash = ?1 AND program_id = ?2",
            params![rotated_expired.genesis_hash, rotated_expired.program_id],
        )
        .unwrap();
        let mut tampered_rotation = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-c",
            None,
            "create-after-tamper",
            126,
        );
        assert!(rotate_program_deployment_create_attempt_with_connection(
            &mut conn,
            &rotated_expired,
            &mut tampered_rotation,
            "create_buffer_signed",
        )
        .is_err());
        let tampered_attempt_count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM program_deployment_attempts WHERE signature = ?1",
                ["create-after-tamper"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tampered_attempt_count, 0);
    }

    #[test]
    fn create_rotation_rejects_any_prior_write_evidence() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut record = deployment_record("buffer-a", "artifact-a");
        let mut create_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-a",
            None,
            "create-signature",
            42,
        );
        let (record, _) = reserve_program_deployment_with_attempt_with_connection(
            &mut conn,
            &mut record,
            &mut create_attempt,
        )
        .unwrap();
        let mut write_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_WRITE,
            "buffer-a",
            Some(0),
            "write-0",
            84,
        );
        let with_write = begin_program_deployment_attempt_with_connection(
            &mut conn,
            &record,
            &mut write_attempt,
            "write_signed",
            0,
        )
        .unwrap();
        let expired = transition_program_deployment_attempt_with_connection(
            &mut conn,
            &with_write,
            "create-signature",
            PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
            PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT,
            "create_buffer_requires_reconciliation",
            0,
        )
        .unwrap();
        let mut rotated_attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            "buffer-b",
            None,
            "create-rotated",
            85,
        );
        assert!(rotate_program_deployment_create_attempt_with_connection(
            &mut conn,
            &expired,
            &mut rotated_attempt,
            "create_buffer_signed",
        )
        .is_err());
    }

    #[test]
    fn deployment_progress_update_is_atomic_and_preserves_prior_signatures() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut record = deployment_record("buffer-a", "artifact-a");
        let (record, _) =
            reserve_program_deployment_with_connection(&mut conn, &mut record).unwrap();

        let updated = update_program_deployment_progress_with_connection(
            &mut conn,
            &record,
            "write_confirmed",
            None,
            None,
            Some("write-signature"),
            Some(3),
            Some(84),
            3,
            None,
            None,
        )
        .unwrap();
        assert_eq!(updated.status, "write_confirmed");
        assert_eq!(
            updated.create_signature.as_deref(),
            Some("create-signature")
        );
        assert_eq!(updated.create_last_valid_block_height, Some(42));
        assert_eq!(
            updated.last_write_signature.as_deref(),
            Some("write-signature")
        );
        assert_eq!(updated.completed_writes, 3);
        assert_eq!(updated.last_write_chunk_index, Some(3));
        assert_eq!(updated.last_write_last_valid_block_height, Some(84));
        assert_eq!(updated.revision, 1);

        let finalized = update_program_deployment_progress_with_connection(
            &mut conn,
            &updated,
            "finalized",
            None,
            None,
            None,
            None,
            None,
            4,
            Some("deploy-signature"),
            Some(126),
        )
        .unwrap();
        assert_eq!(
            finalized.last_write_signature.as_deref(),
            Some("write-signature")
        );
        assert_eq!(
            finalized.deploy_signature.as_deref(),
            Some("deploy-signature")
        );
        assert_eq!(finalized.completed_writes, 4);
        assert_eq!(finalized.deploy_last_valid_block_height, Some(126));
        assert_eq!(finalized.revision, 2);
    }

    #[test]
    fn deployment_progress_rejects_stale_revision_and_count_regression() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut record = deployment_record("buffer-a", "artifact-a");
        let (record, _) =
            reserve_program_deployment_with_connection(&mut conn, &mut record).unwrap();

        let first = update_program_deployment_progress_with_connection(
            &mut conn,
            &record,
            "write_signed",
            None,
            None,
            Some("first-write"),
            Some(0),
            Some(84),
            1,
            None,
            None,
        )
        .unwrap();
        assert_eq!(first.revision, 1);

        assert!(update_program_deployment_progress_with_connection(
            &mut conn,
            &record,
            "write_signed",
            None,
            None,
            Some("stale-write"),
            Some(1),
            Some(85),
            2,
            None,
            None,
        )
        .is_err());
        assert!(update_program_deployment_progress_with_connection(
            &mut conn,
            &first,
            "buffer_ready",
            None,
            None,
            None,
            None,
            None,
            0,
            None,
            None,
        )
        .is_err());

        let stored = conn
            .query_row(
                PROGRAM_DEPLOYMENT_SELECT,
                params!["devnet-genesis", "program-id"],
                row_to_program_deployment,
            )
            .unwrap();
        assert_eq!(stored.revision, 1);
        assert_eq!(stored.completed_writes, 1);
        assert_eq!(stored.last_write_signature.as_deref(), Some("first-write"));
    }

    #[test]
    fn deployment_progress_cas_rejects_immutable_intent_tampering() {
        for (column, tampered_value) in [
            ("program_sha256", "tampered-artifact"),
            ("upgrade_authority", "tampered-upgrade"),
            ("buffer_address", "tampered-buffer"),
        ] {
            let mut conn = Connection::open_in_memory().unwrap();
            init_schema(&conn).unwrap();
            let mut record = deployment_record("buffer-a", "artifact-a");
            let (record, _) =
                reserve_program_deployment_with_connection(&mut conn, &mut record).unwrap();
            conn.execute(
                &format!(
                    "UPDATE program_deployment_journal SET {column} = ?1 \
                     WHERE genesis_hash = ?2 AND program_id = ?3"
                ),
                params![tampered_value, record.genesis_hash, record.program_id],
            )
            .unwrap();

            assert!(update_program_deployment_progress_with_connection(
                &mut conn,
                &record,
                "write_signed",
                None,
                None,
                Some("write-signature"),
                Some(0),
                Some(84),
                1,
                None,
                None,
            )
            .is_err());
            let current = conn
                .query_row(
                    PROGRAM_DEPLOYMENT_SELECT,
                    params![record.genesis_hash, record.program_id],
                    row_to_program_deployment,
                )
                .unwrap();
            assert_eq!(current.revision, record.revision);
            assert_eq!(current.status, record.status);
        }
    }

    #[test]
    fn deployment_attempt_insert_rolls_back_when_immutable_intent_changed() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut record = deployment_record("buffer-a", "artifact-a");
        record.status = "buffer_ready".to_string();
        let (record, _) =
            reserve_program_deployment_with_connection(&mut conn, &mut record).unwrap();
        conn.execute(
            "UPDATE program_deployment_journal SET program_sha256 = 'tampered-artifact' \
             WHERE genesis_hash = ?1 AND program_id = ?2",
            params![record.genesis_hash, record.program_id],
        )
        .unwrap();
        let mut attempt = deployment_attempt(
            PROGRAM_DEPLOYMENT_STAGE_WRITE,
            "buffer-a",
            Some(0),
            "write-after-tamper",
            84,
        );

        assert!(begin_program_deployment_attempt_with_connection(
            &mut conn,
            &record,
            &mut attempt,
            "write_signed",
            0,
        )
        .is_err());
        let attempt_count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM program_deployment_attempts WHERE signature = ?1",
                ["write-after-tamper"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempt_count, 0);
    }

    #[test]
    fn legacy_attempt_evidence_promotion_is_cas_and_monotonic() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut record = deployment_record("buffer-a", "artifact-a");
        record.attempt_evidence_version = 0;
        record.completed_writes = 2;
        let (record, _) =
            reserve_program_deployment_with_connection(&mut conn, &mut record).unwrap();

        assert!(promote_program_deployment_attempt_evidence_with_connection(
            &mut conn,
            &record,
            "buffer_ready",
            1,
        )
        .is_err());
        let promoted = promote_program_deployment_attempt_evidence_with_connection(
            &mut conn,
            &record,
            "buffer_ready",
            2,
        )
        .unwrap();
        assert_eq!(
            promoted.attempt_evidence_version,
            PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION
        );
        assert_eq!(promoted.revision, 1);
        assert!(promote_program_deployment_attempt_evidence_with_connection(
            &mut conn,
            &record,
            "buffer_ready",
            2,
        )
        .is_err());
    }

    #[test]
    fn attempt_evidence_promotion_rejects_immutable_intent_tampering() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut record = deployment_record("buffer-a", "artifact-a");
        record.attempt_evidence_version = 0;
        let (record, _) =
            reserve_program_deployment_with_connection(&mut conn, &mut record).unwrap();
        conn.execute(
            "UPDATE program_deployment_journal SET program_sha256 = 'tampered-artifact' \
             WHERE genesis_hash = ?1 AND program_id = ?2",
            params![record.genesis_hash, record.program_id],
        )
        .unwrap();

        assert!(promote_program_deployment_attempt_evidence_with_connection(
            &mut conn,
            &record,
            "buffer_ready",
            0,
        )
        .is_err());
        let current = conn
            .query_row(
                PROGRAM_DEPLOYMENT_SELECT,
                params![record.genesis_hash, record.program_id],
                row_to_program_deployment,
            )
            .unwrap();
        assert_eq!(current.revision, record.revision);
        assert_eq!(current.attempt_evidence_version, 0);
    }

    #[test]
    fn deployment_journal_schema_adds_reconciliation_evidence_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE program_deployment_journal (\
                genesis_hash TEXT NOT NULL, program_id TEXT NOT NULL, \
                program_sha256 TEXT NOT NULL, program_len INTEGER NOT NULL, \
                max_data_len INTEGER NOT NULL, upgrade_authority TEXT NOT NULL, \
                buffer_address TEXT NOT NULL, status TEXT NOT NULL, create_signature TEXT, \
                create_last_valid_block_height INTEGER, last_write_signature TEXT, \
                completed_writes INTEGER NOT NULL DEFAULT 0, deploy_signature TEXT, \
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, \
                PRIMARY KEY(genesis_hash, program_id));",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO program_deployment_journal (\
                genesis_hash, program_id, program_sha256, program_len, max_data_len, \
                upgrade_authority, buffer_address, status, create_signature, \
                create_last_valid_block_height, last_write_signature, completed_writes, \
                deploy_signature, created_at, updated_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, 0, NULL, 1, 1)",
            params![
                "legacy-genesis",
                "legacy-program",
                "legacy-artifact",
                1024,
                2048,
                "legacy-authority",
                "legacy-buffer",
                "create_buffer_requires_reconciliation",
                "legacy-create-signature",
                42,
            ],
        )
        .unwrap();

        init_schema(&conn).unwrap();
        let columns = conn
            .prepare("PRAGMA table_info(program_deployment_journal)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for expected in [
            "last_write_chunk_index",
            "last_write_last_valid_block_height",
            "deploy_last_valid_block_height",
            "attempt_evidence_version",
            "revision",
        ] {
            assert!(columns.iter().any(|column| column == expected));
        }
        let evidence_version: u32 = conn
            .query_row(
                "SELECT attempt_evidence_version FROM program_deployment_journal \
                 WHERE genesis_hash = ?1 AND program_id = ?2",
                params!["legacy-genesis", "legacy-program"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(evidence_version, 0);
        let attempts = load_program_deployment_attempts_with_connection(
            &conn,
            "legacy-genesis",
            "legacy-program",
        )
        .unwrap();
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].stage, PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER);
        assert_eq!(
            attempts[0].status,
            PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION
        );
        let unique_index_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' \
                 AND name = 'idx_program_deployment_attempts_one_unresolved'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(unique_index_sql.contains("WHERE status <> 'expired_absent'"));
    }
}
