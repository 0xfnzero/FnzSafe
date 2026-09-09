use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use aws_lc_rs::{
    encoding::{AsDer, PublicKeyX509Der},
    rsa::{KeySize, OaepPrivateDecryptingKey, PrivateDecryptingKey, OAEP_SHA256_MGF1SHA256},
};
use axum::extract::DefaultBodyLimit;
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Path, Request},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
    Engine as _,
};
use bip39::{Language, Mnemonic};
use fnzero_safe::solana_utils::{lamports_to_sol, SolanaClient};
use fnzero_safe::{KeyManager, KeystoreVersion};
use fnzero_safe_app_services as app_services;
use futures::{
    future::join_all,
    stream::{self, StreamExt},
    FutureExt,
};
use rand::{rngs::OsRng, RngCore};
use rust_embed::RustEmbed;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sol_trade_sdk::{
    common::{
        fast_fn::get_associated_token_address_with_program_id_fast_use_seed, GasFeeStrategy,
        SolanaRpcClient, TradeConfig,
    },
    constants::WSOL_TOKEN_ACCOUNT,
    instruction::utils::pumpswap,
    swqos::{SwqosConfig, SwqosRegion, SwqosType},
    trading::{
        core::params::{DexParamEnum, PumpFunParams, PumpSwapParams},
        factory::DexType,
    },
    SolanaTrade, TradeSellParams, TradeTokenType, TradingInfrastructure,
};
use solana_account_decoder_client_types::{
    token::{TokenAccountType, UiExtension},
    UiAccount, UiAccountData, UiAccountEncoding,
};
use solana_client::{
    client_error::{ClientError, ClientErrorKind},
    rpc_client::{GetConfirmedSignaturesForAddress2Config, RpcClient},
};
use solana_commitment_config::CommitmentConfig;
use solana_derivation_path::DerivationPath;
use solana_loader_v3_interface::{
    get_program_data_address,
    instruction::{self as loader_v3_instruction, MINIMUM_EXTEND_PROGRAM_BYTES},
    state::UpgradeableLoaderState,
};
use solana_rpc_client_api::{
    config::{RpcAccountInfoConfig, RpcSimulateTransactionConfig, RpcTransactionConfig},
    request::{Address as RpcAddress, RpcError, RpcResponseErrorData, TokenAccountsFilter},
    response::RpcKeyedAccount,
};
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::sanitize::Sanitize;
use solana_sdk::signature::Signer;
use solana_sdk::signature::{Keypair, Signature};
use solana_sdk::transaction::{Transaction, VersionedTransaction};
use solana_system_interface::MAX_PERMITTED_DATA_LENGTH;
use solana_transaction_status_client_types::{
    option_serializer::OptionSerializer, EncodedTransaction, TransactionStatus, UiInstruction,
    UiMessage, UiParsedInstruction, UiTransactionEncoding,
};
use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, SocketAddr};
use std::panic::AssertUnwindSafe;
use std::path::{Path as FsPath, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use zeroize::{Zeroize, Zeroizing};

mod automated_trade;
mod program_deploy;
mod program_source_build;
mod squads_v4;
mod wallet_session;
mod wallet_store;
use automated_trade::{AutomatedTokenSellIntent, AutomatedTradeReceipt, ReplayDecision};
use program_source_build::{
    display_program_source_build_command, execute_program_source_build, program_source_build_plans,
    program_source_keys_build_warning, ProgramSourceBuildPlan,
};
use squads_v4::{
    Member as SquadsMember, Multisig as SquadsMultisig, Permissions as SquadsPermissions,
    ProgramConfig as SquadsProgramConfig, Proposal as SquadsProposal,
    VaultTransaction as SquadsVaultTransaction,
};
use wallet_session::{wallet_session_vault, WalletSessionSecrets};
use wallet_store::TokenMetadataRecord;
use wallet_store::WalletAssetsRecord;
use wallet_store::WalletSummary;
use wallet_store::WalletTokenAssetRecord;

const API_TOKEN_HEADER: &str = "x-fnzero-safe-token";
const LEGACY_API_TOKEN_HEADER: &str = "x-sol-safekey-token";
const fn base64_encoded_len(byte_len: usize) -> usize {
    byte_len.saturating_add(2) / 3 * 4
}

const MAX_PROGRAM_SO_BYTES: usize =
    MAX_PERMITTED_DATA_LENGTH as usize - UpgradeableLoaderState::size_of_programdata_metadata();
const MAX_PROGRAM_SO_BASE64_BYTES: usize = base64_encoded_len(MAX_PROGRAM_SO_BYTES);
const MAX_PROGRAM_REQUEST_OVERHEAD_BYTES: usize = 1024 * 1024;
const MAX_JSON_BODY_BYTES: usize = MAX_PROGRAM_SO_BASE64_BYTES + MAX_PROGRAM_REQUEST_OVERHEAD_BYTES;
const MAX_SECURE_ENVELOPE_BYTES: usize = base64_encoded_len(MAX_JSON_BODY_BYTES + 16) + 16 * 1024;
const MAX_KEYSTORE_JSON_BYTES: usize = 128 * 1024;
const PROGRAMDATA_MINIMUM_EXTENSION_BYTES: usize = MINIMUM_EXTEND_PROGRAM_BYTES as usize;
const MAX_PROGRAM_IDL_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_GENERIC_PROGRAM_INSTRUCTION_DATA_BYTES: usize = 8 * 1024;
const MAX_EXTERNAL_SIGN_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_GENERIC_PROGRAM_INSTRUCTION_ACCOUNTS: usize = 64;
const MAX_GENERIC_PROGRAM_ADDITIONAL_SIGNERS: usize = 8;
const PROGRAM_WRITE_CHUNK_BYTES: usize = 800;
const SOLANA_TRANSACTION_PACKET_DATA_BYTES: usize = 1232;
const UPGRADEABLE_LOADER_ID: Pubkey =
    Pubkey::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
const ENABLE_EXTEND_PROGRAM_CHECKED_FEATURE_ID: Pubkey =
    Pubkey::from_str_const("2oMRZEDWT2tqtYMofhmmfQ8SsjqUFzT6sYXppQDavxwz");
const UPGRADEABLE_LOADER_ID_STR: &str = "BPFLoaderUpgradeab1e11111111111111111111111";
const SBF_VERIFY_BUSY_MESSAGE: &str = "SBF 验证容量已满，请等待当前验证结束后重试";
const PROGRAM_DEPLOY_BUSY_MESSAGE: &str =
    "已有 Program 部署正在进行；为避免重复部署，请等待其完成或进入恢复流程";
const PROGRAM_DEPLOY_RPC_TIMEOUT_SECS: u64 = 20;
const MAX_LABEL_CHARS: usize = 80;
const MAX_TEXT_FIELD_CHARS: usize = 512;
const MAX_TOKEN_DECIMALS: u8 = 18;
const DEFAULT_SLIPPAGE_BPS: u64 = 100;
const MAX_SLIPPAGE_BPS: u64 = 10_000;
const DEFAULT_SELL_PERCENT_BPS: u64 = 10_000;
const PUMPFUN_PARAM_RPC_ATTEMPTS: usize = 2;
const PUMPFUN_PARAM_RPC_TIMEOUT_MS: u64 = 1_500;
const PUMPFUN_PARAM_RETRY_DELAY_MS: u64 = 75;
const PUMP_SELL_SUBMIT_TIMEOUT_SECS: u64 = 8;
const MAX_NONCE_BATCH_COUNT: u8 = 20;
const MAX_WALLET_TRANSACTION_HISTORY: usize = 100;
const WALLET_SESSION_IDLE_TTL: Duration = Duration::from_secs(65 * 60);
const WALLET_SESSION_MAX_LIFETIME: Duration = Duration::from_secs(8 * 60 * 60);
const WALLET_SESSION_CLEANUP_INTERVAL: Duration = Duration::from_secs(15);
const PASSWORD_ATTEMPT_FREE_FAILURES: u32 = 3;
const PASSWORD_ATTEMPT_MAX_DELAY: Duration = Duration::from_secs(60);
const MAX_PASSWORD_BYTES: usize = 1024;
const PUMPFUN_UVA_DISCRIMINATOR: [u8; 8] = [86, 255, 112, 14, 102, 53, 154, 250];
const PUMPFUN_PROGRAM_ID: &str = "6EF8rrecthR5DkP5hnbZQGmVfRGhPUgAaoeS8QJmR5j";
const PUMPSWAP_PROGRAM_ID: &str = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WRAPPED_SOL_MINT: &str = "So11111111111111111111111111111111111111112";
const SOLANA_TOKEN_LOGO_URI: &str = "/token-icons/solana.png";
const LOCAL_TOKEN_METADATA: &[LocalTokenMetadata] = &[
    LocalTokenMetadata {
        mint: WRAPPED_SOL_MINT,
        name: "Wrapped SOL",
        symbol: "WSOL",
        logo_uri: SOLANA_TOKEN_LOGO_URI,
    },
    LocalTokenMetadata {
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        name: "USD Coin",
        symbol: "USDC",
        logo_uri: "/token-icons/usdc.png",
    },
    LocalTokenMetadata {
        mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        name: "USD Coin",
        symbol: "USDC",
        logo_uri: "/token-icons/usdc.png",
    },
    LocalTokenMetadata {
        mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        name: "USDT",
        symbol: "USDT",
        logo_uri: "/token-icons/usdt.png",
    },
    LocalTokenMetadata {
        mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        name: "Jupiter",
        symbol: "JUP",
        logo_uri: "/token-icons/jup.png",
    },
    LocalTokenMetadata {
        mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
        name: "Jito Staked SOL",
        symbol: "JitoSOL",
        logo_uri: "/token-icons/jitosol.png",
    },
    LocalTokenMetadata {
        mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
        name: "Marinade staked SOL",
        symbol: "mSOL",
        logo_uri: "/token-icons/msol.png",
    },
    LocalTokenMetadata {
        mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
        name: "Bonk",
        symbol: "BONK",
        logo_uri: "/token-icons/bonk.jpg",
    },
    LocalTokenMetadata {
        mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
        name: "Pyth Network",
        symbol: "PYTH",
        logo_uri: "/token-icons/pyth.png",
    },
    LocalTokenMetadata {
        mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
        name: "dogwifhat",
        symbol: "WIF",
        logo_uri: "/token-icons/wif.jpg",
    },
    LocalTokenMetadata {
        mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
        name: "Jito",
        symbol: "JTO",
        logo_uri: "/token-icons/jto.webp",
    },
];
const METAPLEX_TOKEN_METADATA_PROGRAM_ID: &str = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SPL_TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MAX_TOKEN_METADATA_URI_BYTES: usize = 256 * 1024;
const TOKEN_METADATA_BATCH_SIZE: usize = 100;
const TOKEN_METADATA_JSON_CONCURRENCY: usize = 4;
const TOKEN_METADATA_JSON_TIMEOUT_MS: u64 = 1_500;
const TOKEN_METADATA_CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const RPC_QUERY_TIMEOUT_SECS: u64 = 8;
const RPC_TRANSACTION_DETAIL_TIMEOUT_SECS: u64 = 2;
const ALLOW_SECRET_EXPORT_ENV: &str = "FNZERO_SAFE_ALLOW_SECRET_EXPORT";
const LEGACY_ALLOW_SECRET_EXPORT_ENV: &str = "SOL_SAFEKEY_ALLOW_SECRET_EXPORT";
const ALLOW_DIRECT_SECRET_INPUT_ENV: &str = "FNZERO_SAFE_ALLOW_DIRECT_SECRET_INPUT";
const LEGACY_ALLOW_DIRECT_SECRET_INPUT_ENV: &str = "SOL_SAFEKEY_ALLOW_DIRECT_SECRET_INPUT";
const DEFAULT_MNEMONIC_DERIVATION_PATH: &str = "m/44'/501'/0'/0'";
const ALLOWED_ORIGINS_ENV: &str = "FNZERO_SAFE_ALLOWED_ORIGINS";
const LEGACY_ALLOWED_ORIGINS_ENV: &str = "SOL_SAFEKEY_ALLOWED_ORIGINS";
const MAX_SECURITY_QUESTION_INDEX: usize = 7;
const SECURE_BODY_HEADER: &str = "x-fnzero-safe-secure-body";
const LEGACY_SECURE_BODY_HEADER: &str = "x-sol-safekey-secure-body";
const SECURE_BODY_VERSION: &str = "1";
const SECURE_MAX_ENCRYPTED_KEY_BYTES: usize = 1024;
const SECURE_OPTIONAL_API_PATHS: &[&str] = &["/api/health", "/api/secure/session"];
const FLASHBLOCK_SWQOS_API_TOKEN_ENV: &str = "FNZERO_SAFE_FLASHBLOCK_SWQOS_API_TOKEN";
const LEGACY_FLASHBLOCK_SWQOS_API_TOKEN_ENV: &str = "SOL_SAFEKEY_FLASHBLOCK_SWQOS_API_TOKEN";
const BLOCKRAZOR_SWQOS_API_TOKEN_ENV: &str = "FNZERO_SAFE_BLOCKRAZOR_SWQOS_API_TOKEN";
const LEGACY_BLOCKRAZOR_SWQOS_API_TOKEN_ENV: &str = "SOL_SAFEKEY_BLOCKRAZOR_SWQOS_API_TOKEN";
const ASTRALANE_SWQOS_API_TOKEN_ENV: &str = "FNZERO_SAFE_ASTRALANE_SWQOS_API_TOKEN";
const LEGACY_ASTRALANE_SWQOS_API_TOKEN_ENV: &str = "SOL_SAFEKEY_ASTRALANE_SWQOS_API_TOKEN";
const SPEEDLANDING_SWQOS_API_TOKEN_ENV: &str = "FNZERO_SAFE_SPEEDLANDING_SWQOS_API_TOKEN";
const LEGACY_SPEEDLANDING_SWQOS_API_TOKEN_ENV: &str = "SOL_SAFEKEY_SPEEDLANDING_SWQOS_API_TOKEN";
const DEFAULT_SWQOS_TIP_SOL: f64 = 0.0001;

static SECURE_BODY_KEYPAIR: OnceLock<SecureBodyKeyPair> = OnceLock::new();
static LOCAL_API_TOKEN: OnceLock<String> = OnceLock::new();
static PROGRAM_DEPLOY_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static PROGRAM_UPGRADE_PROGRESS: OnceLock<Arc<tokio::sync::Mutex<ProgramUpgradeProgress>>> =
    OnceLock::new();
static PROGRAM_SOURCE_BUILD_JOBS: OnceLock<
    Arc<tokio::sync::Mutex<HashMap<String, ProgramSourceBuildJob>>>,
> = OnceLock::new();
static SBF_VERIFY_LIMIT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
static KEYSTORE_TASK_LIMIT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
static PASSWORD_ATTEMPT_LIMITER: OnceLock<Mutex<PasswordAttemptState>> = OnceLock::new();

#[derive(Default)]
struct PasswordAttemptState {
    consecutive_failures: u32,
    blocked_until: Option<Instant>,
    in_flight: bool,
}

fn password_attempt_state() -> &'static Mutex<PasswordAttemptState> {
    PASSWORD_ATTEMPT_LIMITER.get_or_init(|| Mutex::new(PasswordAttemptState::default()))
}

fn password_attempt_delay(consecutive_failures: u32) -> Option<Duration> {
    if consecutive_failures <= PASSWORD_ATTEMPT_FREE_FAILURES {
        return None;
    }
    let exponent = consecutive_failures
        .saturating_sub(PASSWORD_ATTEMPT_FREE_FAILURES + 1)
        .min(6);
    Some(Duration::from_secs(1_u64 << exponent).min(PASSWORD_ATTEMPT_MAX_DELAY))
}

struct PasswordAttemptGuard {
    completed: bool,
}

impl PasswordAttemptGuard {
    fn succeeded(mut self) {
        record_password_attempt_success();
        self.completed = true;
    }

    fn failed(mut self) {
        record_password_attempt_failure();
        self.completed = true;
    }
}

impl Drop for PasswordAttemptGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        if let Ok(mut state) = password_attempt_state().lock() {
            state.in_flight = false;
        }
    }
}

fn begin_password_attempt() -> Result<PasswordAttemptGuard, ApiError> {
    let now = Instant::now();
    let mut state = password_attempt_state().lock().map_err(|_| ApiError {
        message: "密码尝试限制器不可用".to_string(),
    })?;
    if let Some(blocked_until) = state.blocked_until.filter(|deadline| *deadline > now) {
        let seconds = blocked_until
            .saturating_duration_since(now)
            .as_secs()
            .max(1);
        return Err(ApiError {
            message: format!("密码尝试过于频繁，请在 {seconds} 秒后重试"),
        });
    }
    if state.in_flight {
        return Err(ApiError {
            message: "密码尝试过于频繁，已有一次密码校验正在进行".to_string(),
        });
    }
    state.in_flight = true;
    Ok(PasswordAttemptGuard { completed: false })
}

fn record_password_attempt_failure() {
    let Ok(mut state) = password_attempt_state().lock() else {
        return;
    };
    state.consecutive_failures = state.consecutive_failures.saturating_add(1);
    state.in_flight = false;
    if let Some(delay) = password_attempt_delay(state.consecutive_failures) {
        state.blocked_until = Instant::now().checked_add(delay);
    }
}

fn record_password_attempt_success() {
    if let Ok(mut state) = password_attempt_state().lock() {
        *state = PasswordAttemptState::default();
    }
}

fn finish_password_attempt<T>(
    password_attempt: PasswordAttemptGuard,
    result: &Result<T, ApiError>,
) {
    match result {
        Ok(_) => password_attempt.succeeded(),
        Err(error)
            if error.message.contains("密码错误")
                || error.message.contains("当前密码无法解密")
                || error.message.starts_with("WrongPassword:") =>
        {
            password_attempt.failed();
        }
        Err(_) => drop(password_attempt),
    }
}

#[derive(Clone, Debug, Serialize)]
struct ProgramUpgradeProgress {
    active: bool,
    program_id: String,
    network: String,
    stage: String,
    message: String,
    write_completed: usize,
    write_total: usize,
    program_bytes: usize,
    buffer_address: Option<String>,
    last_signature: Option<String>,
    error: Option<String>,
    updated_at_ms: u64,
}

impl Default for ProgramUpgradeProgress {
    fn default() -> Self {
        Self {
            active: false,
            program_id: String::new(),
            network: String::new(),
            stage: "idle".to_string(),
            message: String::new(),
            write_completed: 0,
            write_total: 0,
            program_bytes: 0,
            buffer_address: None,
            last_signature: None,
            error: None,
            updated_at_ms: 0,
        }
    }
}

fn program_upgrade_progress_store() -> Arc<tokio::sync::Mutex<ProgramUpgradeProgress>> {
    PROGRAM_UPGRADE_PROGRESS
        .get_or_init(|| Arc::new(tokio::sync::Mutex::new(ProgramUpgradeProgress::default())))
        .clone()
}

fn now_unix_ms_lossy() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

async fn publish_program_upgrade_progress(update: impl FnOnce(&mut ProgramUpgradeProgress)) {
    let store = program_upgrade_progress_store();
    let mut progress = store.lock().await;
    update(&mut progress);
    progress.updated_at_ms = now_unix_ms_lossy();
}

async fn begin_program_upgrade_progress(
    program_id: &str,
    network: &str,
    program_bytes: usize,
    write_total: usize,
) {
    publish_program_upgrade_progress(|progress| {
        *progress = ProgramUpgradeProgress {
            active: true,
            program_id: program_id.to_string(),
            network: network.to_string(),
            stage: "preparing".to_string(),
            message: "正在校验升级参数与程序制品".to_string(),
            write_completed: 0,
            write_total,
            program_bytes,
            buffer_address: None,
            last_signature: None,
            error: None,
            updated_at_ms: 0,
        };
    })
    .await;
}

async fn finish_program_upgrade_progress(result: &Result<Json<UpgradeProgramResponse>, ApiError>) {
    match result {
        Ok(Json(response)) => {
            publish_program_upgrade_progress(|progress| {
                progress.active = false;
                progress.stage = "finalized".to_string();
                progress.message = "升级已完成并通过链上回读校验".to_string();
                progress.program_id = response.program_id.clone();
                progress.network = response.network.clone();
                progress.buffer_address = Some(response.buffer_address.clone());
                progress.last_signature = Some(response.upgrade_signature.clone());
                progress.write_completed = response.write_signatures.len();
                progress.write_total = response.write_signatures.len().max(progress.write_total);
                progress.program_bytes = response.program_bytes;
                progress.error = None;
            })
            .await;
        }
        Err(error) => {
            publish_program_upgrade_progress(|progress| {
                if !progress.active && progress.stage == "idle" {
                    return;
                }
                progress.active = false;
                progress.stage = "failed".to_string();
                progress.message = error.message.clone();
                progress.error = Some(error.message.clone());
            })
            .await;
        }
    }
}

fn official_swqos_configs() -> Vec<SwqosConfig> {
    let region = SwqosRegion::Frankfurt;
    let mut configs = Vec::new();
    if let Some(token) = configured_env_value(&[
        FLASHBLOCK_SWQOS_API_TOKEN_ENV,
        LEGACY_FLASHBLOCK_SWQOS_API_TOKEN_ENV,
    ]) {
        configs.push(SwqosConfig::FlashBlock(token, region.clone(), None));
    }
    if let Some(token) = configured_env_value(&[
        BLOCKRAZOR_SWQOS_API_TOKEN_ENV,
        LEGACY_BLOCKRAZOR_SWQOS_API_TOKEN_ENV,
    ]) {
        configs.push(SwqosConfig::BlockRazor(token, region.clone(), None, None));
    }
    if let Some(token) = configured_env_value(&[
        ASTRALANE_SWQOS_API_TOKEN_ENV,
        LEGACY_ASTRALANE_SWQOS_API_TOKEN_ENV,
    ]) {
        configs.push(SwqosConfig::Astralane(token, region.clone(), None, None));
    }
    if let Some(token) = configured_env_value(&[
        SPEEDLANDING_SWQOS_API_TOKEN_ENV,
        LEGACY_SPEEDLANDING_SWQOS_API_TOKEN_ENV,
    ]) {
        configs.push(SwqosConfig::Speedlanding(token, region, None));
    }
    configs
}

fn default_swqos_configs(rpc_url: &str) -> Vec<SwqosConfig> {
    let mut configs = official_swqos_configs();
    configs.push(SwqosConfig::Default(rpc_url.to_string()));
    configs
}

fn swqos_only_sell_client(
    client: &SolanaTrade,
    payer: Arc<Keypair>,
    use_seed: bool,
) -> Result<SolanaTrade, ApiError> {
    let swqos_clients = client
        .infrastructure
        .swqos_clients
        .iter()
        .filter(|swqos| !matches!(swqos.get_swqos_type(), SwqosType::Default))
        .cloned()
        .collect::<Vec<_>>();
    if swqos_clients.is_empty() {
        return Err(ApiError {
            message: "未初始化可用 SWQOS 通道，已按配置禁止 RPC 卖出".to_string(),
        });
    }

    let labels = swqos_clients
        .iter()
        .map(|swqos| swqos.get_swqos_type().as_str())
        .collect::<Vec<_>>();
    tracing::info!("Pump sell SWQOS-only channels: {}", labels.join(", "));

    let infrastructure = TradingInfrastructure {
        rpc: client.infrastructure.rpc.clone(),
        swqos_clients: Arc::new(swqos_clients),
        config: client.infrastructure.config.clone(),
        max_sender_concurrency: client.infrastructure.max_sender_concurrency,
        effective_core_ids: client.infrastructure.effective_core_ids.clone(),
    };
    let mut sell_client =
        SolanaTrade::from_infrastructure(payer, Arc::new(infrastructure), use_seed);
    sell_client.log_enabled = false;
    sell_client.check_min_tip = false;
    Ok(sell_client)
}

struct SecureBodyKeyPair {
    private_key: OaepPrivateDecryptingKey,
    public_key_pem: String,
}

fn secure_body_keypair() -> &'static SecureBodyKeyPair {
    SECURE_BODY_KEYPAIR.get_or_init(|| {
        let private_key = PrivateDecryptingKey::generate(KeySize::Rsa2048)
            .expect("failed to generate request encryption key");
        let public_key = private_key.public_key();
        let public_key_der = AsDer::<PublicKeyX509Der<'static>>::as_der(&public_key)
            .expect("failed to encode request encryption public key");
        let public_key_pem = pem_rfc7468::encode_string(
            "PUBLIC KEY",
            pem_rfc7468::LineEnding::LF,
            public_key_der.as_ref(),
        )
        .expect("failed to encode request encryption public key PEM");
        let private_key = OaepPrivateDecryptingKey::new(private_key)
            .expect("failed to initialize request decryption key");

        SecureBodyKeyPair {
            private_key,
            public_key_pem,
        }
    })
}

fn local_api_token() -> &'static str {
    LOCAL_API_TOKEN.get_or_init(|| {
        let configured = configured_api_token();
        #[cfg(not(test))]
        for name in ["FNZERO_SAFE_API_TOKEN", "SOL_SAFEKEY_API_TOKEN"] {
            std::env::remove_var(name);
        }
        configured.unwrap_or_else(|| {
            let mut bytes = [0u8; 32];
            OsRng.fill_bytes(&mut bytes);
            let token = URL_SAFE_NO_PAD.encode(bytes);
            bytes.zeroize();
            token
        })
    })
}

fn configured_api_token() -> Option<String> {
    configured_env_value(&["FNZERO_SAFE_API_TOKEN", "SOL_SAFEKEY_API_TOKEN"])
}

fn configured_env_value(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn configured_env_flag(names: &[&str]) -> bool {
    names.iter().any(|name| {
        std::env::var(name)
            .ok()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
    })
}

fn is_optional_api_path(path: &str) -> bool {
    SECURE_OPTIONAL_API_PATHS
        .iter()
        .any(|optional| path == *optional || path.strip_suffix('/') == Some(*optional))
}

fn secure_body_required(method: &Method, path: &str) -> bool {
    matches!(method, &Method::POST | &Method::PUT | &Method::PATCH)
        && path.starts_with("/api/")
        && !is_optional_api_path(path)
}

#[derive(Serialize)]
struct SecureSessionResponse {
    version: &'static str,
    algorithm: &'static str,
    public_key_pem: String,
}

#[derive(Deserialize)]
struct SecureBodyEnvelope {
    version: u8,
    encrypted_key: String,
    iv: String,
    ciphertext: String,
}

struct SensitiveBodyBytes(Vec<u8>);

impl SensitiveBodyBytes {
    fn len(&self) -> usize {
        self.0.len()
    }
}

impl AsRef<[u8]> for SensitiveBodyBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SensitiveBodyBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

// Helper function to safely create keypair from base58 string
fn keypair_from_base58_safe(private_key: &str) -> Result<Keypair, String> {
    let mut bytes = bs58::decode(private_key)
        .into_vec()
        .map_err(|e| format!("无效的私钥格式: {}", e))?;
    let result = Keypair::try_from(bytes.as_slice()).map_err(|e| format!("无效的私钥格式: {}", e));
    bytes.zeroize();
    result
}

fn migrate_legacy_saved_wallet_keystore(
    wallet: &wallet_store::SavedWallet,
    keypair: &Keypair,
    password: &str,
) -> Result<wallet_store::SavedWallet, ApiError> {
    let public_key = keypair.pubkey().to_string();
    if public_key != wallet.public_key {
        return Err(ApiError {
            message: "Legacy 钱包迁移失败: 解密地址与保存记录不一致".to_string(),
        });
    }

    let migrated =
        reencrypt_saved_wallet_material(wallet, password, password).map_err(|error| ApiError {
            message: format!("Legacy 钱包迁移失败: {}", error.message),
        })?;
    let updated = wallet_store::replace_keystore_atomically(
        &wallet.id,
        &public_key,
        &wallet.keystore_json,
        migrated,
    )
    .map_err(|error| ApiError {
        message: format!("Legacy 钱包迁移失败: {error}"),
    })?;
    if updated.id != wallet.id || updated.public_key != wallet.public_key {
        return Err(ApiError {
            message: "Legacy 钱包迁移失败: 保存后的钱包身份发生变化".to_string(),
        });
    }
    checkpoint_sensitive_rewrite_best_effort("Legacy wallet auto-migration", &wallet.id);
    Ok(updated)
}

fn checkpoint_sensitive_rewrite_best_effort(operation: &str, wallet_id: &str) {
    if let Err(error) = wallet_store::checkpoint_sensitive_rewrite() {
        tracing::warn!(
            "{} for {} committed but could not truncate WAL: {}",
            operation,
            wallet_id,
            error
        );
    }
}

fn keypair_from_saved_wallet_with_password(
    wallet_id: &str,
    password: &str,
    unlock_label: &str,
) -> Result<(Keypair, wallet_store::SavedWallet), ApiError> {
    validate_wallet_id(wallet_id)?;
    let wallet = wallet_store::find(wallet_id).map_err(|message| ApiError { message })?;
    let version =
        KeyManager::keystore_version(&wallet.keystore_json).map_err(|error| ApiError {
            message: format!("{unlock_label}解锁失败: {error}"),
        })?;
    let password_attempt = begin_password_attempt()?;
    let keypair_result = match version {
        KeystoreVersion::V2 => {
            KeyManager::keypair_from_encrypted_json_v2(&wallet.keystore_json, password)
        }
        KeystoreVersion::V3 => {
            KeyManager::keypair_from_encrypted_json(&wallet.keystore_json, password)
        }
        KeystoreVersion::LegacyV1 => {
            KeyManager::keypair_from_encrypted_json(&wallet.keystore_json, password)
        }
    };
    let keypair = match keypair_result {
        Ok(keypair) => {
            password_attempt.succeeded();
            keypair
        }
        Err(_) => {
            password_attempt.failed();
            return Err(ApiError {
                message: format!("{unlock_label}密码错误"),
            });
        }
    };

    if keypair.pubkey().to_string() != wallet.public_key {
        return Err(ApiError {
            message: format!(
                "{unlock_label}解锁失败: keystore 实际解出的钱包地址与已保存记录不一致"
            ),
        });
    }

    let wallet = if version == KeystoreVersion::LegacyV1 {
        migrate_legacy_saved_wallet_keystore(&wallet, &keypair, password)?
    } else {
        wallet
    };

    Ok((keypair, wallet))
}

fn cache_saved_wallet_session(
    wallet: &wallet_store::SavedWallet,
    keypair: &Keypair,
    evm_private_key: Option<&[u8]>,
    password: &str,
) -> Result<(), ApiError> {
    let mut keypair_bytes = Zeroizing::new(keypair.to_bytes());
    let mnemonic =
        verified_mnemonic_from_keystore_json(&wallet.keystore_json, password, &keypair.pubkey())?;
    let secrets = WalletSessionSecrets::new(
        keypair_bytes.as_ref(),
        evm_private_key,
        mnemonic.as_deref().map(String::as_str),
    )
    .map_err(|message| ApiError { message })?;
    wallet_session_vault()
        .unlock(
            &wallet.id,
            &wallet.public_key,
            &secrets,
            WALLET_SESSION_IDLE_TTL,
            WALLET_SESSION_MAX_LIFETIME,
        )
        .map_err(|message| ApiError { message })?;
    keypair_bytes.zeroize();
    Ok(())
}

fn evm_private_key_from_saved_wallet(
    wallet: &wallet_store::SavedWallet,
    password: &str,
) -> Result<Option<Zeroizing<Vec<u8>>>, ApiError> {
    let Some(evm_keystore_json) =
        keystore_metadata_value(&wallet.keystore_json, "evm_keystore_json")
    else {
        return Ok(None);
    };
    let (evm_wallet, private_key) =
        app_services::evm_wallet_unlock_private_key(app_services::EvmUnlockWalletRequest {
            keystore_json: evm_keystore_json,
            password: password.to_string(),
        })
        .map_err(api_error_from_app_service)?;
    validate_universal_evm_identity(&wallet.keystore_json, &evm_wallet)?;
    Ok(Some(private_key))
}

fn unlock_saved_wallet_for_session(
    wallet_id: &str,
    password: &str,
    unlock_label: &str,
) -> Result<(Keypair, wallet_store::SavedWallet), ApiError> {
    let (keypair, wallet) =
        keypair_from_saved_wallet_with_password(wallet_id, password, unlock_label)?;
    let evm_private_key = evm_private_key_from_saved_wallet(&wallet, password)?;
    cache_saved_wallet_session(
        &wallet,
        &keypair,
        evm_private_key.as_ref().map(|key| key.as_slice()),
        password,
    )?;
    Ok((keypair, wallet))
}

fn require_unified_password_for_existing_wallets(
    password: &str,
    excluded_public_key: Option<&str>,
) -> Result<(), ApiError> {
    let wallets = wallet_store::load().map_err(|message| ApiError { message })?;
    let candidates = wallets.into_iter().filter(|wallet| {
        !excluded_public_key.is_some_and(|public_key| public_key == wallet.public_key)
    });
    let mut candidates = candidates.peekable();
    if candidates.peek().is_none() {
        return Ok(());
    }
    let password_attempt = begin_password_attempt()?;
    for wallet in candidates {
        let keypair = match KeyManager::keypair_from_encrypted_json(&wallet.keystore_json, password)
        {
            Ok(keypair) => keypair,
            Err(_) => {
                password_attempt.failed();
                return Err(ApiError {
                    message: "新钱包必须使用现有的 FnzSafe 统一钱包密码".to_string(),
                });
            }
        };
        if keypair.pubkey().to_string() != wallet.public_key {
            return Err(ApiError {
                message: "钱包密文与保存的地址不一致".to_string(),
            });
        }
        if evm_private_key_from_saved_wallet(&wallet, password).is_err() {
            password_attempt.failed();
            return Err(ApiError {
                message: "新钱包必须使用现有的 FnzSafe 统一钱包密码".to_string(),
            });
        }
    }
    password_attempt.succeeded();
    Ok(())
}

fn keypair_from_saved_wallet_session(wallet_id: &str) -> Result<Keypair, ApiError> {
    validate_wallet_id(wallet_id)?;
    let wallet = wallet_store::find(wallet_id).map_err(|message| ApiError { message })?;
    let secrets = wallet_session_vault()
        .decrypt(wallet_id, &wallet.public_key)
        .map_err(|message| ApiError { message })?;
    let keypair = Keypair::try_from(secrets.solana_keypair()).map_err(|_| ApiError {
        message: "钱包会话中的密钥材料无效，已锁定钱包，请重新解锁".to_string(),
    })?;
    if keypair.pubkey().to_string() != wallet.public_key {
        let _ = wallet_session_vault().lock(wallet_id);
        return Err(ApiError {
            message: "钱包会话与保存的钱包地址不一致，已锁定钱包，请重新解锁".to_string(),
        });
    }
    Ok(keypair)
}

fn evm_private_key_from_saved_wallet_session(
    wallet_id: &str,
    expected_evm_address: &str,
) -> Result<Zeroizing<Vec<u8>>, ApiError> {
    validate_wallet_id(wallet_id)?;
    let wallet = wallet_store::find(wallet_id).map_err(|message| ApiError { message })?;
    let saved_evm_address = keystore_metadata_value(&wallet.keystore_json, "evm_address")
        .ok_or_else(|| ApiError {
            message: "这个钱包没有 EVM 派生账户".to_string(),
        })?;
    if !saved_evm_address.eq_ignore_ascii_case(expected_evm_address.trim()) {
        return Err(ApiError {
            message: "EVM 交易地址与所选钱包不一致".to_string(),
        });
    }
    let secrets = wallet_session_vault()
        .decrypt(wallet_id, &wallet.public_key)
        .map_err(|message| ApiError { message })?;
    let Some(evm_private_key) = secrets.evm_private_key() else {
        let _ = wallet_session_vault().lock(wallet_id);
        return Err(ApiError {
            message: "钱包会话缺少 EVM 签名密钥，已锁定钱包，请重新解锁".to_string(),
        });
    };
    Ok(Zeroizing::new(evm_private_key.to_vec()))
}

#[derive(Deserialize, Default)]
struct WalletAuthRequest {
    #[serde(default)]
    wallet_id: Option<String>,
    #[serde(default)]
    private_key: Option<String>,
    #[serde(default)]
    secret_key: Option<String>,
    #[serde(default)]
    keystore_json: Option<String>,
    #[serde(default)]
    encrypted_key: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

impl WalletAuthRequest {
    fn keypair(&self) -> Result<Keypair, ApiError> {
        if let Some(id) = self
            .wallet_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Some(password) = self
                .password
                .as_deref()
                .filter(|password| !password.is_empty())
            {
                let (keypair, _) = unlock_saved_wallet_for_session(id, password, "钱包")?;
                return Ok(keypair);
            }
            return keypair_from_saved_wallet_session(id);
        }

        if let Some(encrypted_key) = self
            .encrypted_key
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            require_direct_secret_input_enabled()?;
            let password = self.required_password("使用加密私钥时需要提供密码")?;
            let secret =
                KeyManager::decrypt_with_password(encrypted_key, password).map_err(|e| {
                    ApiError {
                        message: format!("解密失败: {}", e),
                    }
                })?;
            return keypair_from_base58_safe(&secret).map_err(|message| ApiError { message });
        }

        if let Some(keystore_json) = self
            .keystore_json
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let password = self.required_password("使用 keystore 时需要提供密码")?;
            return KeyManager::keypair_from_encrypted_json(keystore_json, password).map_err(|e| {
                ApiError {
                    message: format!("keystore 解密失败: {}", e),
                }
            });
        }

        let private_key = self
            .private_key
            .as_deref()
            .or(self.secret_key.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError {
                message: "需要提供私钥、加密私钥、keystore 或已保存钱包".to_string(),
            })?;
        require_direct_secret_input_enabled()?;
        keypair_from_base58_safe(private_key).map_err(|message| ApiError { message })
    }

    fn public_key(&self) -> Result<String, ApiError> {
        if self
            .wallet_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some()
        {
            return self.keypair().map(|keypair| keypair.pubkey().to_string());
        }

        Ok(self.keypair()?.pubkey().to_string())
    }

    fn required_password(&self, message: &str) -> Result<&str, ApiError> {
        self.password
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError {
                message: message.to_string(),
            })
    }

    fn clear_secrets(&mut self) {
        for value in [
            &mut self.private_key,
            &mut self.secret_key,
            &mut self.keystore_json,
            &mut self.encrypted_key,
            &mut self.password,
        ] {
            if let Some(secret) = value.as_mut() {
                secret.zeroize();
            }
            *value = None;
        }
    }
}

impl Drop for WalletAuthRequest {
    fn drop(&mut self) {
        self.clear_secrets();
    }
}

#[derive(Clone, Debug)]
struct DecimalAmount(String);

impl DecimalAmount {
    fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for DecimalAmount {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        match value {
            Value::String(value) => Ok(Self(value)),
            Value::Number(value) => Ok(Self(value.to_string())),
            _ => Err(serde::de::Error::custom("amount must be a decimal value")),
        }
    }
}

fn parse_decimal_to_units(amount: &str, decimals: u8, field: &str) -> Result<u64, ApiError> {
    let amount = amount.trim();
    if amount.is_empty() || amount.starts_with(['+', '-']) {
        return Err(ApiError {
            message: format!("{} 必须是大于 0 的有效十进制数字", field),
        });
    }

    let mut parts = amount.split('.');
    let whole_part = parts.next().unwrap_or_default();
    let fractional_part = parts.next();
    if parts.next().is_some() || (whole_part.is_empty() && fractional_part.unwrap_or("").is_empty())
    {
        return Err(ApiError {
            message: format!("{} 必须是大于 0 的有效十进制数字", field),
        });
    }
    if !whole_part.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(ApiError {
            message: format!("{} 必须是大于 0 的有效十进制数字", field),
        });
    }

    let scale = 10_u64
        .checked_pow(decimals as u32)
        .ok_or_else(|| ApiError {
            message: format!("{}精度超出有效范围", field),
        })?;
    let mut whole_units = 0_u64;
    for ch in whole_part.bytes() {
        whole_units = whole_units
            .checked_mul(10)
            .and_then(|value| value.checked_add((ch - b'0') as u64))
            .ok_or_else(|| ApiError {
                message: format!("{}超出有效范围", field),
            })?;
    }
    let mut units = whole_units.checked_mul(scale).ok_or_else(|| ApiError {
        message: format!("{}超出有效范围", field),
    })?;

    if let Some(fractional_part) = fractional_part {
        if !fractional_part.chars().all(|ch| ch.is_ascii_digit()) {
            return Err(ApiError {
                message: format!("{} 必须是大于 0 的有效十进制数字", field),
            });
        }
        let decimals = decimals as usize;
        let used_fractional = if fractional_part.len() > decimals {
            let (used, extra) = fractional_part.split_at(decimals);
            if extra.bytes().any(|ch| ch != b'0') {
                return Err(ApiError {
                    message: format!("{}最多支持 {} 位小数", field, decimals),
                });
            }
            used
        } else {
            fractional_part
        };

        let mut fractional_units = 0_u64;
        for ch in used_fractional.bytes() {
            fractional_units = fractional_units
                .checked_mul(10)
                .and_then(|value| value.checked_add((ch - b'0') as u64))
                .ok_or_else(|| ApiError {
                    message: format!("{}超出有效范围", field),
                })?;
        }
        for _ in used_fractional.len()..decimals {
            fractional_units = fractional_units.checked_mul(10).ok_or_else(|| ApiError {
                message: format!("{}超出有效范围", field),
            })?;
        }
        units = units
            .checked_add(fractional_units)
            .ok_or_else(|| ApiError {
                message: format!("{}超出有效范围", field),
            })?;
    }

    if units == 0 {
        return Err(ApiError {
            message: format!("{}必须至少为最小单位", field),
        });
    }

    Ok(units)
}

fn sol_to_lamports(amount: &DecimalAmount) -> Result<u64, ApiError> {
    parse_decimal_to_units(amount.as_str(), 9, "金额")
}

fn token_amount_to_raw(amount: &DecimalAmount, decimals: u8) -> Result<u64, ApiError> {
    if decimals > MAX_TOKEN_DECIMALS {
        return Err(ApiError {
            message: format!("代币精度不能超过 {}", MAX_TOKEN_DECIMALS),
        });
    }
    parse_decimal_to_units(amount.as_str(), decimals, "代币数量")
}

fn require_nonempty(value: &str, field: &str) -> Result<(), ApiError> {
    if value.is_empty() {
        Err(ApiError {
            message: format!("{}不能为空", field),
        })
    } else {
        Ok(())
    }
}

fn validate_password(value: &str, field: &str) -> Result<(), ApiError> {
    require_nonempty(value, field)?;
    if value.len() > MAX_PASSWORD_BYTES {
        return Err(ApiError {
            message: format!("{field}长度不能超过 {MAX_PASSWORD_BYTES} 字节"),
        });
    }
    Ok(())
}

fn validate_text_len(value: &str, field: &str, max_chars: usize) -> Result<(), ApiError> {
    if value.chars().count() <= max_chars {
        Ok(())
    } else {
        Err(ApiError {
            message: format!("{}长度不能超过 {} 个字符", field, max_chars),
        })
    }
}

fn validate_optional_label(value: Option<String>, field: &str) -> Result<Option<String>, ApiError> {
    match value {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                validate_text_len(trimmed, field, MAX_LABEL_CHARS)?;
                Ok(Some(trimmed.to_string()))
            }
        }
        None => Ok(None),
    }
}

fn keystore_metadata_value(keystore_json: &str, key: &str) -> Option<String> {
    let data: Value = serde_json::from_str(keystore_json).ok()?;
    data.get("metadata")
        .and_then(|metadata| metadata.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn keystore_metadata_name(keystore_json: &str) -> Option<String> {
    keystore_metadata_value(keystore_json, "name")
}

fn keystore_metadata_encrypted_mnemonic(keystore_json: &str) -> Option<String> {
    keystore_metadata_value(keystore_json, "encrypted_mnemonic")
}

fn verified_mnemonic_from_keystore_json(
    keystore_json: &str,
    password: &str,
    expected_public_key: &Pubkey,
) -> Result<Option<Zeroizing<String>>, ApiError> {
    if KeyManager::keystore_version(keystore_json).map_err(|message| ApiError { message })?
        == KeystoreVersion::V3
    {
        return KeyManager::mnemonic_from_encrypted_json(keystore_json, password)
            .map(Some)
            .map_err(|message| ApiError { message });
    }
    let Some(encrypted) = keystore_metadata_encrypted_mnemonic(keystore_json) else {
        return Ok(None);
    };
    let decrypted = Zeroizing::new(
        KeyManager::decrypt_secret_with_password(&encrypted, password)
            .map_err(|message| ApiError { message })?,
    );
    let mnemonic = Zeroizing::new(normalize_mnemonic_phrase(&decrypted)?);
    let derivation_path = keystore_metadata_value(keystore_json, "mnemonic_derivation_path")
        .ok_or_else(|| ApiError {
            message: "旧助记词 keystore 缺少 Solana 派生路径，无法验证钱包身份".to_string(),
        })?;
    let derived = KeyManager::keypair_from_mnemonic(&mnemonic, &derivation_path)
        .map_err(|message| ApiError { message })?;
    if derived.pubkey() != *expected_public_key {
        return Err(ApiError {
            message: "助记词与 Solana keystore 公钥不匹配".to_string(),
        });
    }
    Ok(Some(mnemonic))
}

fn with_keystore_metadata_extra(
    keystore_json: &str,
    name: Option<&str>,
    encrypted_mnemonic: Option<&str>,
    derivation_path: Option<&str>,
) -> Result<String, ApiError> {
    let mut data: Value = serde_json::from_str(keystore_json).map_err(|_| ApiError {
        message: "Invalid JSON format".to_string(),
    })?;
    let Some(object) = data.as_object_mut() else {
        return Err(ApiError {
            message: "Invalid JSON format".to_string(),
        });
    };
    let mut metadata = object
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    metadata.insert("app".to_string(), Value::String("fnzero-safe".to_string()));
    metadata.insert("version".to_string(), Value::Number(1.into()));

    if let Some(name) = name.map(str::trim).filter(|value| !value.is_empty()) {
        metadata.insert("name".to_string(), Value::String(name.to_string()));
    } else {
        metadata.remove("name");
    }

    if let Some(encrypted_mnemonic) = encrypted_mnemonic
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        metadata.insert(
            "encrypted_mnemonic".to_string(),
            Value::String(encrypted_mnemonic.to_string()),
        );
    }
    if let Some(derivation_path) = derivation_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        metadata.insert(
            "mnemonic_derivation_path".to_string(),
            Value::String(derivation_path.to_string()),
        );
    }

    metadata.remove("tag");

    object.insert("metadata".to_string(), Value::Object(metadata));
    serde_json::to_string(&data).map_err(|e| ApiError {
        message: format!("序列化 Keystore 失败: {}", e),
    })
}

fn with_keystore_metadata(keystore_json: &str, name: Option<&str>) -> Result<String, ApiError> {
    with_keystore_metadata_extra(keystore_json, name, None, None)
}

fn preserve_keystore_metadata(source_json: &str, target_json: &str) -> Result<String, ApiError> {
    let source: Value = serde_json::from_str(source_json).map_err(|_| ApiError {
        message: "Invalid source Keystore JSON".to_string(),
    })?;
    let Some(metadata) = source.get("metadata").and_then(Value::as_object) else {
        return Ok(target_json.to_string());
    };
    let mut target: Value = serde_json::from_str(target_json).map_err(|_| ApiError {
        message: "Invalid target Keystore JSON".to_string(),
    })?;
    let target_object = target.as_object_mut().ok_or_else(|| ApiError {
        message: "Invalid target Keystore JSON".to_string(),
    })?;
    target_object.insert("metadata".to_string(), Value::Object(metadata.clone()));
    serde_json::to_string(&target).map_err(|error| ApiError {
        message: format!("序列化 Keystore metadata 失败: {error}"),
    })
}

fn with_universal_wallet_metadata(
    keystore_json: &str,
    evm_wallet: &app_services::EvmWalletSummary,
    evm_keystore_json: &str,
) -> Result<String, ApiError> {
    let mut data: Value = serde_json::from_str(keystore_json).map_err(|_| ApiError {
        message: "Invalid JSON format".to_string(),
    })?;
    let metadata = data
        .as_object_mut()
        .and_then(|object| object.get_mut("metadata"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| ApiError {
            message: "Keystore metadata is missing".to_string(),
        })?;
    metadata.insert(
        "wallet_kind".to_string(),
        Value::String("universal".to_string()),
    );
    metadata.insert(
        "evm_address".to_string(),
        Value::String(evm_wallet.address.clone()),
    );
    metadata.insert(
        "evm_wallet_id".to_string(),
        Value::String(evm_wallet.id.clone()),
    );
    if let Some(path) = evm_wallet.derivation_path.as_deref() {
        metadata.insert(
            "evm_derivation_path".to_string(),
            Value::String(path.to_string()),
        );
    }
    metadata.insert(
        "evm_keystore_json".to_string(),
        Value::String(evm_keystore_json.to_string()),
    );
    serde_json::to_string(&data).map_err(|error| ApiError {
        message: format!("序列化统一钱包 Keystore 失败: {error}"),
    })
}

fn validate_universal_evm_identity(
    universal_keystore_json: &str,
    evm_wallet: &app_services::EvmWalletSummary,
) -> Result<(), ApiError> {
    if keystore_metadata_value(universal_keystore_json, "wallet_kind").as_deref()
        != Some("universal")
    {
        return Err(ApiError {
            message: "Wallet kind metadata is missing or invalid".to_string(),
        });
    }
    for (field, expected, actual) in [
        (
            "EVM address",
            keystore_metadata_value(universal_keystore_json, "evm_address"),
            &evm_wallet.address,
        ),
        (
            "EVM wallet ID",
            keystore_metadata_value(universal_keystore_json, "evm_wallet_id"),
            &evm_wallet.id,
        ),
    ] {
        let expected = expected.ok_or_else(|| ApiError {
            message: format!("{field} metadata is missing"),
        })?;
        if !expected.eq_ignore_ascii_case(actual) {
            return Err(ApiError {
                message: format!("{field} metadata does not match the encrypted EVM account"),
            });
        }
    }
    Ok(())
}

fn validate_universal_evm_mnemonic_identity(
    universal_keystore_json: &str,
    evm_wallet: &app_services::EvmWalletSummary,
    mnemonic: &str,
) -> Result<(), ApiError> {
    validate_universal_evm_identity(universal_keystore_json, evm_wallet)?;
    let expected_address = app_services::evm_wallet_address_from_mnemonic(
        mnemonic,
        evm_wallet.derivation_path.as_deref(),
    )
    .map_err(api_error_from_app_service)?;
    if !expected_address.eq_ignore_ascii_case(&evm_wallet.address) {
        return Err(ApiError {
            message: "内嵌 EVM 钱包不是由此 Keystore 的助记词派生".to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod universal_wallet_tests {
    use super::*;

    const TEST_MNEMONIC: &str = "test test test test test test test test test test test junk";
    const TEST_PASSWORD: &str = "universal-wallet-test-password";

    #[test]
    fn derives_and_unlocks_solana_and_evm_accounts_from_one_mnemonic() {
        let solana_path_label = normalize_mnemonic_derivation_path(None).unwrap();
        let solana_keypair =
            keypair_from_mnemonic_phrase(TEST_MNEMONIC, &solana_path_label).unwrap();
        let solana_keystore =
            KeyManager::keypair_to_encrypted_json(&solana_keypair, TEST_PASSWORD).unwrap();
        let solana_keystore = with_keystore_metadata_extra(
            &solana_keystore,
            Some("Primary"),
            Some("encrypted-mnemonic"),
            Some(&solana_path_label),
        )
        .unwrap();
        let evm =
            app_services::evm_wallet_import_mnemonic(app_services::EvmImportMnemonicRequest {
                name: "Primary".to_string(),
                mnemonic: TEST_MNEMONIC.to_string(),
                derivation_path: None,
                password: TEST_PASSWORD.to_string(),
            })
            .unwrap();

        assert_eq!(
            evm.wallet.address,
            "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
        );
        assert_eq!(
            evm.wallet.derivation_path.as_deref(),
            Some("m/44'/60'/0'/0/0")
        );

        let universal_keystore =
            with_universal_wallet_metadata(&solana_keystore, &evm.wallet, &evm.keystore_json)
                .unwrap();
        let unlocked_solana =
            KeyManager::keypair_from_encrypted_json(&universal_keystore, TEST_PASSWORD).unwrap();
        assert_eq!(unlocked_solana.pubkey(), solana_keypair.pubkey());

        let saved_evm_keystore =
            keystore_metadata_value(&universal_keystore, "evm_keystore_json").unwrap();
        let unlocked_evm = app_services::evm_wallet_unlock(app_services::EvmUnlockWalletRequest {
            keystore_json: saved_evm_keystore,
            password: TEST_PASSWORD.to_string(),
        })
        .unwrap();
        assert_eq!(unlocked_evm, evm.wallet);
        assert_eq!(
            keystore_metadata_value(&universal_keystore, "wallet_kind").as_deref(),
            Some("universal")
        );
        validate_universal_evm_identity(&universal_keystore, &unlocked_evm).unwrap();

        const OTHER_MNEMONIC: &str =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        assert!(validate_universal_evm_mnemonic_identity(
            &universal_keystore,
            &unlocked_evm,
            OTHER_MNEMONIC,
        )
        .is_err());

        let mut tampered: Value = serde_json::from_str(&universal_keystore).unwrap();
        tampered["metadata"]["evm_address"] =
            Value::String("0x0000000000000000000000000000000000000000".to_string());
        assert!(validate_universal_evm_identity(&tampered.to_string(), &unlocked_evm).is_err());

        for field in ["evm_address", "evm_wallet_id", "wallet_kind"] {
            let mut missing: Value = serde_json::from_str(&universal_keystore).unwrap();
            missing["metadata"].as_object_mut().unwrap().remove(field);
            assert!(validate_universal_evm_identity(&missing.to_string(), &unlocked_evm).is_err());
        }
    }
}

fn normalize_mnemonic_phrase(phrase: &str) -> Result<String, ApiError> {
    let normalized = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Err(ApiError {
            message: "请输入助记词".to_string(),
        });
    }
    let word_count = normalized.split_whitespace().count();
    if !matches!(word_count, 12 | 15 | 18 | 21 | 24) {
        return Err(ApiError {
            message: "助记词必须是 12、15、18、21 或 24 个单词".to_string(),
        });
    }
    Mnemonic::parse_in_normalized(Language::English, &normalized).map_err(|_| ApiError {
        message: "助记词校验失败，请检查单词和顺序".to_string(),
    })?;
    Ok(normalized)
}

fn normalize_mnemonic_derivation_path(value: Option<&str>) -> Result<String, ApiError> {
    let path = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_MNEMONIC_DERIVATION_PATH);
    DerivationPath::from_absolute_path_str(path).map_err(|error| ApiError {
        message: format!("派生路径无效: {error}"),
    })?;
    Ok(path.to_string())
}

fn keypair_from_mnemonic_phrase(
    mnemonic: &str,
    derivation_path: &str,
) -> Result<Keypair, ApiError> {
    KeyManager::keypair_from_mnemonic(mnemonic, derivation_path)
        .map_err(|message| ApiError { message })
}

fn validate_wallet_id(wallet_id: &str) -> Result<(), ApiError> {
    if wallet_id.len() == 32 && wallet_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(ApiError {
            message: "无效的钱包 ID".to_string(),
        })
    }
}

fn normalize_slippage_bps(slippage: Option<u64>) -> Result<u64, ApiError> {
    let slippage = slippage.unwrap_or(DEFAULT_SLIPPAGE_BPS);
    if slippage <= MAX_SLIPPAGE_BPS {
        Ok(slippage)
    } else {
        Err(ApiError {
            message: "滑点不能超过 100%".to_string(),
        })
    }
}

fn normalize_sell_percent_bps(sell_percent: Option<u64>) -> Result<Option<u64>, ApiError> {
    match sell_percent {
        Some(value) if (1..=10_000).contains(&value) => Ok(Some(value)),
        Some(_) => Err(ApiError {
            message: "卖出比例必须大于 0 且不能超过 100%".to_string(),
        }),
        None => Ok(None),
    }
}

fn token_amount_from_sell_percent(
    token_balance: u64,
    sell_percent_bps: u64,
) -> Result<u64, ApiError> {
    let raw_amount = if sell_percent_bps == DEFAULT_SELL_PERCENT_BPS {
        token_balance
    } else {
        ((token_balance as u128)
            .checked_mul(sell_percent_bps as u128)
            .ok_or_else(|| ApiError {
                message: "卖出数量超出有效范围".to_string(),
            })?
            / DEFAULT_SELL_PERCENT_BPS as u128) as u64
    };
    if raw_amount == 0 {
        Err(ApiError {
            message: "按当前比例计算后的卖出数量小于最小单位".to_string(),
        })
    } else {
        Ok(raw_amount)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PumpSellTokenAccountKind {
    StandardAta,
    SeedAccount,
}

impl PumpSellTokenAccountKind {
    fn label(self) -> &'static str {
        match self {
            Self::StandardAta => "standard_ata",
            Self::SeedAccount => "seed_account",
        }
    }

    fn use_seed(self) -> bool {
        matches!(self, Self::SeedAccount)
    }
}

#[derive(Clone, Debug)]
struct PumpSellTokenAccountBalance {
    kind: PumpSellTokenAccountKind,
    account: Pubkey,
    token_program: Pubkey,
    raw_amount: u64,
    decimals: u8,
}

fn mint_token_program_for_sell(rpc_client: &RpcClient, mint: &Pubkey) -> Result<Pubkey, ApiError> {
    let token_2022_program = Pubkey::from_str(SPL_TOKEN_2022_PROGRAM_ID).map_err(|e| ApiError {
        message: format!("Token-2022 程序地址解析失败: {}", e),
    })?;
    if mint.to_string().ends_with("pump") {
        return Ok(token_2022_program);
    }

    let account = rpc_client.get_account(mint).map_err(|e| ApiError {
        message: format!("查询 Token Mint 账户失败: {}", e),
    })?;
    let spl_token_program = Pubkey::from_str(SPL_TOKEN_PROGRAM_ID).map_err(|e| ApiError {
        message: format!("Token 程序地址解析失败: {}", e),
    })?;
    if account.owner == spl_token_program || account.owner == token_2022_program {
        Ok(account.owner)
    } else {
        Err(ApiError {
            message: format!(
                "Mint {} 的 owner 不是 SPL Token 或 Token-2022 程序: {}",
                mint, account.owner
            ),
        })
    }
}

fn is_missing_token_account_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("accountnotfound")
        || lower.contains("could not find account")
        || lower.contains("account not found")
        || lower.contains("invalid param: could not find")
}

fn token_account_balance_for_sell(
    rpc_client: &RpcClient,
    account: &Pubkey,
) -> Result<Option<(u64, u8)>, ApiError> {
    match rpc_client.get_token_account_balance(account) {
        Ok(balance) => {
            let raw_amount = balance.amount.parse::<u64>().map_err(|_| ApiError {
                message: format!("解析卖出账户余额失败: {}", account),
            })?;
            Ok(Some((raw_amount, balance.decimals)))
        }
        Err(e) => {
            let message = e.to_string();
            if is_missing_token_account_error(&message) {
                Ok(None)
            } else {
                Err(ApiError {
                    message: format!("查询卖出账户余额失败 ({}): {}", account, message),
                })
            }
        }
    }
}

fn candidate_sell_token_account(
    rpc_client: &RpcClient,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
    kind: PumpSellTokenAccountKind,
) -> Result<Option<PumpSellTokenAccountBalance>, ApiError> {
    let account = get_associated_token_address_with_program_id_fast_use_seed(
        owner,
        mint,
        token_program,
        kind.use_seed(),
    );
    let Some((raw_amount, decimals)) = token_account_balance_for_sell(rpc_client, &account)? else {
        return Ok(None);
    };
    Ok(Some(PumpSellTokenAccountBalance {
        kind,
        account,
        token_program: *token_program,
        raw_amount,
        decimals,
    }))
}

fn sell_balance_overflow_error() -> ApiError {
    ApiError {
        message: "代币余额超出有效范围".to_string(),
    }
}

fn select_pump_sell_token_source(
    rpc_client: &RpcClient,
    mint: &Pubkey,
    owner: &Pubkey,
    human_amount: Option<&DecimalAmount>,
    sell_percent_bps: Option<u64>,
) -> Result<(PumpSellTokenAccountBalance, u64), ApiError> {
    let token_program = mint_token_program_for_sell(rpc_client, mint)?;
    let standard = candidate_sell_token_account(
        rpc_client,
        owner,
        mint,
        &token_program,
        PumpSellTokenAccountKind::StandardAta,
    )?;
    let seed = candidate_sell_token_account(
        rpc_client,
        owner,
        mint,
        &token_program,
        PumpSellTokenAccountKind::SeedAccount,
    )?;
    let mut candidates = [standard, seed]
        .into_iter()
        .flatten()
        .filter(|candidate| candidate.raw_amount > 0)
        .collect::<Vec<_>>();

    candidates.sort_by_key(|candidate| match candidate.kind {
        PumpSellTokenAccountKind::StandardAta => 0_u8,
        PumpSellTokenAccountKind::SeedAccount => 1_u8,
    });

    if candidates.is_empty() {
        let standard_account = get_associated_token_address_with_program_id_fast_use_seed(
            owner,
            mint,
            &token_program,
            false,
        );
        let seed_account = get_associated_token_address_with_program_id_fast_use_seed(
            owner,
            mint,
            &token_program,
            true,
        );
        return Err(ApiError {
            message: format!(
                "未找到可卖出的标准 ATA 或 seed token account 余额。standard ATA: {}; seed account: {}; token program: {}",
                standard_account, seed_account, token_program
            ),
        });
    }

    let total_balance = candidates.iter().try_fold(0_u64, |total, candidate| {
        total
            .checked_add(candidate.raw_amount)
            .ok_or_else(sell_balance_overflow_error)
    })?;

    if let Some(human_amount) = human_amount {
        let decimals = candidates[0].decimals;
        let raw_amount = token_amount_to_raw(human_amount, decimals)?;
        if let Some(candidate) = candidates
            .iter()
            .find(|candidate| {
                candidate.kind == PumpSellTokenAccountKind::StandardAta
                    && candidate.raw_amount >= raw_amount
            })
            .cloned()
        {
            return Ok((candidate, raw_amount));
        }
        if let Some(candidate) = candidates
            .iter()
            .find(|candidate| {
                candidate.kind == PumpSellTokenAccountKind::SeedAccount
                    && candidate.raw_amount >= raw_amount
            })
            .cloned()
        {
            return Ok((candidate, raw_amount));
        }
        if raw_amount <= total_balance {
            return Err(ApiError {
                message: "卖出数量分散在标准 ATA 和 seed token account 中，当前单笔卖出不能跨账户扣款；请按单个账户余额分次卖出或先合并账户".to_string(),
            });
        }
        return Err(ApiError {
            message: format!(
                "卖出数量超过余额，可用余额: {}",
                total_balance as f64 / 10_f64.powi(decimals as i32)
            ),
        });
    }

    let sell_percent_bps = sell_percent_bps.unwrap_or(DEFAULT_SELL_PERCENT_BPS);
    let selected = if candidates.len() == 1 {
        candidates.remove(0)
    } else {
        let selected = candidates
            .iter()
            .max_by_key(|candidate| candidate.raw_amount)
            .cloned()
            .expect("non-empty candidates");
        tracing::warn!(
            "Sell balance for mint {} is split across standard/seed accounts; selected {} {} balance={} for percent sell",
            mint,
            selected.kind.label(),
            selected.account,
            selected.raw_amount
        );
        selected
    };
    let raw_amount = token_amount_from_sell_percent(selected.raw_amount, sell_percent_bps)?;
    Ok((selected, raw_amount))
}

fn pda_from_seed(program_id: &str, seed: &[u8], owner: &Pubkey) -> Result<Pubkey, ApiError> {
    let program = Pubkey::from_str(program_id).map_err(|e| ApiError {
        message: format!("解析程序地址失败: {}", e),
    })?;
    Pubkey::try_find_program_address(&[seed, owner.as_ref()], &program)
        .map(|(pubkey, _)| pubkey)
        .ok_or_else(|| ApiError {
            message: "推导返现账户失败".to_string(),
        })
}

fn read_u64_le(data: &[u8], offset: usize) -> Option<u64> {
    data.get(offset..offset + 8)
        .and_then(|slice| slice.try_into().ok())
        .map(u64::from_le_bytes)
}

fn cashback_amount_from_uva_data(data: &[u8], stable: bool) -> Option<u64> {
    if data.len() < 8 || data[0..8] != PUMPFUN_UVA_DISCRIMINATOR {
        return None;
    }
    let earned_offset = if stable { 73 } else { 57 };
    let claimed_offset = if stable { 81 } else { 65 };
    let earned = read_u64_le(data, earned_offset)?;
    let claimed = read_u64_le(data, claimed_offset)?;
    Some(earned.saturating_sub(claimed))
}

fn cashback_info(
    rpc_client: &RpcClient,
    owner: &Pubkey,
    dex_type: DexType,
) -> Result<(Pubkey, u64, String), ApiError> {
    let (program_id, stable, asset) = match dex_type {
        DexType::PumpFun => (PUMPFUN_PROGRAM_ID, false, "SOL"),
        DexType::PumpSwap => (PUMPSWAP_PROGRAM_ID, false, "WSOL"),
        _ => {
            return Err(ApiError {
                message: "不支持的返现类型".to_string(),
            });
        }
    };
    let uva = pda_from_seed(program_id, b"user_volume_accumulator", owner)?;
    let amount = match rpc_client.get_account(&uva) {
        Ok(account) => cashback_amount_from_uva_data(&account.data, stable).unwrap_or(0),
        Err(_) => 0,
    };
    Ok((uva, amount, asset.to_string()))
}

async fn execute_cashback_claim(
    keypair: Keypair,
    rpc_url: &str,
    dex_type: DexType,
) -> Result<String, ApiError> {
    let payer = Arc::new(keypair);
    let commitment = CommitmentConfig::confirmed();
    let swqos_configs = default_swqos_configs(rpc_url);
    let trade_config = TradeConfig::builder(rpc_url.to_string(), swqos_configs, commitment)
        .create_wsol_ata_on_startup(false)
        .use_seed_optimize(false)
        .check_min_tip(false)
        .log_enabled(false)
        .swqos_cores_from_end(false)
        .mev_protection(false)
        .build();
    let client = SolanaTrade::new(payer, trade_config).await;
    match dex_type {
        DexType::PumpFun => client.claim_cashback_pumpfun().await,
        DexType::PumpSwap => client.claim_cashback_pumpswap().await,
        _ => Err(anyhow::anyhow!("unsupported cashback type")),
    }
    .map_err(|e| ApiError {
        message: format!("领取返现失败: {}", e),
    })
}

fn require_secret_export_enabled() -> Result<(), ApiError> {
    if configured_env_flag(&[ALLOW_SECRET_EXPORT_ENV, LEGACY_ALLOW_SECRET_EXPORT_ENV]) {
        Ok(())
    } else {
        Err(ApiError {
            message: format!(
                "明文密钥导出仅允许桌面端或已验证的本机页面；如确需其它 Web 调试，请显式设置 {}=true",
                ALLOW_SECRET_EXPORT_ENV
            ),
        })
    }
}

fn header_has_valid_local_api_token(headers: &HeaderMap) -> bool {
    local_api_token_from_headers(headers)
        .map(|provided| constant_time_eq(provided, local_api_token()))
        .unwrap_or(false)
}

fn local_api_token_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(API_TOKEN_HEADER)
        .or_else(|| headers.get(LEGACY_API_TOKEN_HEADER))
        .and_then(|value| value.to_str().ok())
}

fn header_origin_is_tauri(headers: &HeaderMap) -> bool {
    headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .and_then(normalized_origin)
        .is_some_and(|origin| origin == "tauri://localhost")
}

fn header_origin_or_referer_is_local(headers: &HeaderMap) -> bool {
    headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(is_allowed_local_origin)
        .unwrap_or_else(|| {
            headers
                .get("referer")
                .and_then(|value| value.to_str().ok())
                .map(is_allowed_local_origin)
                .unwrap_or(false)
        })
}

fn require_secret_export_enabled_or_tauri(headers: &HeaderMap) -> Result<(), ApiError> {
    if configured_env_flag(&[ALLOW_SECRET_EXPORT_ENV, LEGACY_ALLOW_SECRET_EXPORT_ENV]) {
        return Ok(());
    }
    if header_origin_is_tauri(headers)
        || (header_has_valid_local_api_token(headers) && header_origin_or_referer_is_local(headers))
    {
        Ok(())
    } else {
        require_secret_export_enabled()
    }
}

fn require_direct_secret_input_enabled() -> Result<(), ApiError> {
    if configured_env_flag(&[
        ALLOW_DIRECT_SECRET_INPUT_ENV,
        LEGACY_ALLOW_DIRECT_SECRET_INPUT_ENV,
    ]) {
        Ok(())
    } else {
        Err(ApiError {
            message: format!(
                "Web 直接提交明文私钥或加密私钥已禁用；请导入 keystore 后选择钱包，或显式设置 {}=true 进行本机调试",
                ALLOW_DIRECT_SECRET_INPUT_ENV
            ),
        })
    }
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "unknown panic".to_string()
}

async fn catch_panics(request: Request, next: Next) -> Response {
    match AssertUnwindSafe(next.run(request)).catch_unwind().await {
        Ok(response) => response,
        Err(panic_payload) => {
            let message = panic_message(panic_payload.as_ref());
            tracing::error!("HTTP handler panic: {}", message);
            let body = Json(json!({ "error": format!("服务执行异常: {}", message) }));
            (StatusCode::INTERNAL_SERVER_ERROR, body).into_response()
        }
    }
}

fn normalized_origin(value: &str) -> Option<String> {
    let Ok(uri) = value.parse::<Uri>() else {
        return None;
    };
    let scheme = uri.scheme_str()?;
    let host = uri.host()?;
    let default_port = match scheme {
        "http" => Some(80),
        "https" => Some(443),
        "tauri" => None,
        _ => None,
    };
    let port = uri.port_u16();
    let port_part = match (port, default_port) {
        (Some(port), Some(default_port)) if port == default_port => String::new(),
        (Some(port), _) => format!(":{}", port),
        _ => String::new(),
    };
    Some(format!("{}://{}{}", scheme, host, port_part))
}

fn configured_allowed_origins() -> Vec<String> {
    configured_env_value(&[ALLOWED_ORIGINS_ENV, LEGACY_ALLOWED_ORIGINS_ENV])
        .map(|value| {
            value
                .split(',')
                .filter_map(|item| normalized_origin(item.trim()))
                .collect()
        })
        .unwrap_or_default()
}

fn is_allowed_local_origin(value: &str) -> bool {
    let Some(origin) = normalized_origin(value) else {
        return false;
    };
    let host = origin
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split(':').next())
        .unwrap_or("");
    if host == "127.0.0.1" || host == "localhost" || host == "tauri.localhost" {
        return true;
    }
    if origin == "tauri://localhost" {
        return true;
    }
    configured_allowed_origins()
        .iter()
        .any(|allowed| constant_time_eq(allowed, &origin))
}

async fn require_local_origin(headers: HeaderMap, request: Request, next: Next) -> Response {
    if request.uri().path().starts_with("/api/")
        && !matches!(
            request.method(),
            &Method::GET | &Method::HEAD | &Method::OPTIONS
        )
    {
        let allowed = headers
            .get("origin")
            .and_then(|value| value.to_str().ok())
            .map(is_allowed_local_origin)
            .unwrap_or_else(|| {
                headers
                    .get("referer")
                    .and_then(|value| value.to_str().ok())
                    .map(is_allowed_local_origin)
                    .unwrap_or(false)
            });
        if !allowed {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": format!(
                        "拒绝非本机页面发起的本地 API 请求；如需允许自己的 HTTPS 页面访问本机 API，请设置 {}=https://你的域名",
                        ALLOWED_ORIGINS_ENV
                    )
                })),
            )
                .into_response();
        }
    }

    next.run(request).await
}

async fn require_api_token(headers: HeaderMap, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if !path.starts_with("/api/")
        || request.method() == Method::OPTIONS
        || is_optional_api_path(path)
    {
        return next.run(request).await;
    }

    let expected = local_api_token();

    let provided = local_api_token_from_headers(&headers);
    if !provided
        .map(|provided| constant_time_eq(provided, expected))
        .unwrap_or(false)
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "缺少或无效的本地 API token" })),
        )
            .into_response();
    }

    next.run(request).await
}

async fn decrypt_secure_body(headers: HeaderMap, request: Request, next: Next) -> Response {
    let secure_required = secure_body_required(request.method(), request.uri().path());
    let is_secure = headers
        .get(SECURE_BODY_HEADER)
        .or_else(|| headers.get(LEGACY_SECURE_BODY_HEADER))
        .and_then(|value| value.to_str().ok())
        == Some(SECURE_BODY_VERSION);

    if !is_secure {
        if secure_required {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "变更类 API 请求必须使用加密请求体" })),
            )
                .into_response();
        }
        return next.run(request).await;
    }

    if !matches!(
        request.method(),
        &Method::POST | &Method::PUT | &Method::PATCH
    ) {
        return next.run(request).await;
    }

    match decrypt_secure_request(request).await {
        Ok(request) => next.run(request).await,
        Err(err) => err.into_response(),
    }
}

async fn decrypt_secure_request(request: Request) -> Result<Request, ApiError> {
    let (mut parts, body) = request.into_parts();
    let encrypted_body = to_bytes(body, MAX_SECURE_ENVELOPE_BYTES)
        .await
        .map_err(|e| ApiError {
            message: format!("读取加密请求失败: {}", e),
        })?;
    let envelope: SecureBodyEnvelope =
        serde_json::from_slice(&encrypted_body).map_err(|_| ApiError {
            message: "无效的加密请求格式".to_string(),
        })?;

    if envelope.version != 1 {
        return Err(ApiError {
            message: "不支持的加密请求版本".to_string(),
        });
    }

    let encrypted_key = BASE64
        .decode(envelope.encrypted_key.as_bytes())
        .map_err(|_| ApiError {
            message: "无效的加密请求密钥".to_string(),
        })?;
    if encrypted_key.len() > SECURE_MAX_ENCRYPTED_KEY_BYTES {
        return Err(ApiError {
            message: "加密请求密钥过大".to_string(),
        });
    }

    let iv = BASE64
        .decode(envelope.iv.as_bytes())
        .map_err(|_| ApiError {
            message: "无效的加密请求 IV".to_string(),
        })?;
    if iv.len() != 12 {
        return Err(ApiError {
            message: "无效的加密请求 IV 长度".to_string(),
        });
    }

    let ciphertext = BASE64
        .decode(envelope.ciphertext.as_bytes())
        .map_err(|_| ApiError {
            message: "无效的加密请求正文".to_string(),
        })?;

    let secure_keypair = secure_body_keypair();
    let mut decrypted_key =
        Zeroizing::new(vec![0_u8; secure_keypair.private_key.min_output_size()]);
    let aes_key_len = secure_keypair
        .private_key
        .decrypt(
            &OAEP_SHA256_MGF1SHA256,
            &encrypted_key,
            decrypted_key.as_mut_slice(),
            None,
        )
        .map_err(|_| ApiError {
            message: "解密请求密钥失败".to_string(),
        })?
        .len();
    if aes_key_len != 32 {
        return Err(ApiError {
            message: "无效的请求密钥长度".to_string(),
        });
    }

    let cipher =
        Aes256Gcm::new_from_slice(&decrypted_key[..aes_key_len]).map_err(|_| ApiError {
            message: "初始化请求解密失败".to_string(),
        })?;
    let plaintext = SensitiveBodyBytes(
        cipher
            .decrypt(Nonce::from_slice(&iv), ciphertext.as_ref())
            .map_err(|_| ApiError {
                message: "解密请求正文失败".to_string(),
            })?,
    );
    if plaintext.len() > MAX_JSON_BODY_BYTES {
        return Err(ApiError {
            message: "请求正文过大".to_string(),
        });
    }

    parts.headers.remove(SECURE_BODY_HEADER);
    parts.headers.remove(LEGACY_SECURE_BODY_HEADER);
    parts
        .headers
        .insert("content-type", HeaderValue::from_static("application/json"));
    parts.headers.insert(
        "content-length",
        HeaderValue::from_str(&plaintext.len().to_string()).map_err(|e| ApiError {
            message: format!("更新请求长度失败: {}", e),
        })?,
    );

    Ok(Request::from_parts(
        parts,
        Body::from(Bytes::from_owner(plaintext)),
    ))
}

async fn add_security_headers(request: Request, next: Next) -> Response {
    let is_api = request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
    );
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    if is_api {
        headers.insert(
            "cache-control",
            HeaderValue::from_static("no-store, max-age=0"),
        );
    }
    response
}

fn validate_keystore_size(keystore_json: &str) -> Result<(), ApiError> {
    if keystore_json.len() <= MAX_KEYSTORE_JSON_BYTES {
        Ok(())
    } else {
        Err(ApiError {
            message: "Keystore 文件过大".to_string(),
        })
    }
}

fn validate_program_binary(program: &[u8]) -> Result<(), ApiError> {
    if program.is_empty() {
        return Err(ApiError {
            message: "Program .so 文件不能为空".to_string(),
        });
    }
    if program.len() > MAX_PROGRAM_SO_BYTES {
        return Err(ApiError {
            message: format!(
                "Program .so 文件过大：最大支持 {} bytes（Solana 账户上限扣除 ProgramData 元数据）",
                MAX_PROGRAM_SO_BYTES
            ),
        });
    }
    if program.len() < 4 || &program[0..4] != b"\x7fELF" {
        return Err(ApiError {
            message: "无效的 Program .so 文件".to_string(),
        });
    }
    Ok(())
}

fn decode_program_binary_base64(encoded: &str) -> Result<Vec<u8>, ApiError> {
    let encoded = encoded.trim();
    if encoded.len() > MAX_PROGRAM_SO_BASE64_BYTES {
        return Err(ApiError {
            message: format!(
                "Program .so base64 过大，编码后不能超过 {} bytes",
                MAX_PROGRAM_SO_BASE64_BYTES
            ),
        });
    }
    let program = BASE64.decode(encoded.as_bytes()).map_err(|_| ApiError {
        message: "无效的 Program .so base64".to_string(),
    })?;
    validate_program_binary(&program)?;
    Ok(program)
}

async fn verify_program_binary_offline(program: Vec<u8>) -> Result<Vec<u8>, ApiError> {
    let permit = SBF_VERIFY_LIMIT
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError {
            message: SBF_VERIFY_BUSY_MESSAGE.to_string(),
        })?;
    tokio::task::spawn_blocking(move || {
        let result = program_deploy::verify_sbf_elf(&program);
        drop(permit);
        result.map(|()| program)
    })
    .await
    .map_err(|error| ApiError {
        message: format!("SBF 验证任务异常终止: {error}"),
    })?
    .map_err(|message| ApiError { message })
}

async fn run_keystore_task<T, F>(task: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ApiError> + Send + 'static,
{
    let permit = KEYSTORE_TASK_LIMIT
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError {
            message: "Keystore 密钥派生并发控制已关闭".to_string(),
        })?;
    tokio::task::spawn_blocking(move || {
        let result = task();
        drop(permit);
        result
    })
    .await
    .map_err(|error| ApiError {
        message: format!("Keystore 密钥派生任务异常终止: {error}"),
    })?
}

fn sign_and_send(
    client: &RpcClient,
    instructions: Vec<solana_sdk::instruction::Instruction>,
    signers: &[&Keypair],
    payer: &Pubkey,
) -> Result<String, ApiError> {
    let blockhash = client.get_latest_blockhash().map_err(|e| ApiError {
        message: format!("获取 blockhash 失败: {}", e),
    })?;
    let tx = Transaction::new_signed_with_payer(&instructions, Some(payer), signers, blockhash);
    client
        .send_and_confirm_transaction(&tx)
        .map(|signature| signature.to_string())
        .map_err(|e| ApiError {
            message: format!("提交交易失败: {}", e),
        })
}

async fn wait_for_signature_commitment(
    client: &RpcClient,
    signature: &Signature,
    timeout: Duration,
    action: &str,
    commitment: CommitmentConfig,
    commitment_label: &str,
) -> Result<u64, ApiError> {
    let deadline = Instant::now() + timeout;
    let mut last_rpc_error = None;

    loop {
        match client.get_signature_statuses_with_history(&[*signature]) {
            Ok(response) => {
                if let Some(status) = response.value.into_iter().next().flatten() {
                    if status.satisfies_commitment(commitment) {
                        if let Some(error) = status.err.as_ref() {
                            return Err(ApiError {
                                message: format!(
                                    "{}交易 {} 已在目标确认级别执行失败，不能盲目重试: {}",
                                    action, signature, error
                                ),
                            });
                        }
                        return Ok(status.slot);
                    }
                }
            }
            Err(error) => last_rpc_error = Some(error.to_string()),
        }

        if Instant::now() >= deadline {
            let detail = last_rpc_error
                .map(|error| format!("；最后一次 RPC 错误: {error}"))
                .unwrap_or_default();
            return Err(ApiError {
                message: format!(
                    "{}交易 {} 已提交，但未能在超时前确认 {}{}。请先按该签名核对链上状态，不能盲目重试",
                    action, signature, commitment_label, detail
                ),
            });
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn send_error_is_preflight_rejection(error: &ClientError) -> bool {
    matches!(
        error.kind(),
        ClientErrorKind::RpcError(RpcError::RpcResponseError {
            data: RpcResponseErrorData::SendTransactionPreflightFailure(_),
            ..
        })
    )
}

async fn submit_signed_transaction_once(
    client: &RpcClient,
    transaction: &Transaction,
    action: &str,
    context: &str,
    commitment: CommitmentConfig,
    commitment_label: &str,
    timeout: Duration,
) -> Result<(Signature, u64), ApiError> {
    let local_signature = *transaction.signatures.first().ok_or_else(|| ApiError {
        message: format!("{action}交易缺少本地签名；{context}"),
    })?;
    if local_signature == Signature::default() {
        return Err(ApiError {
            message: format!("{action}交易尚未签名；{context}"),
        });
    }

    let send_error = match client.send_transaction(transaction) {
        Ok(rpc_signature) => {
            if rpc_signature != local_signature {
                return Err(ApiError {
                    message: format!(
                        "{action} RPC 返回签名 {rpc_signature}，但本地确定签名为 {local_signature}；{context}"
                    ),
                });
            }
            None
        }
        Err(error) if send_error_is_preflight_rejection(&error) => {
            return Err(ApiError {
                message: format!(
                    "{action}交易在 RPC 预检模拟阶段失败，未提交到链上: {error}；{context}"
                ),
            });
        }
        Err(error) => Some(error.to_string()),
    };

    let wait_timeout = if send_error.is_some() {
        timeout.min(Duration::from_secs(10))
    } else {
        timeout
    };
    match wait_for_signature_commitment(
        client,
        &local_signature,
        wait_timeout,
        action,
        commitment,
        commitment_label,
    )
    .await
    {
        Ok(slot) => Ok((local_signature, slot)),
        Err(wait_error) => {
            let send_detail = send_error
                .map(|error| format!("；首次提交 RPC 错误: {error}"))
                .unwrap_or_default();
            Err(ApiError {
                message: format!(
                    "{}{}；{}；本地确定签名: {}。不得自动重签或盲目重试",
                    wait_error.message, send_detail, context, local_signature
                ),
            })
        }
    }
}

async fn submit_signed_versioned_transaction_once(
    client: &RpcClient,
    transaction: &VersionedTransaction,
    action: &str,
    context: &str,
    commitment: CommitmentConfig,
    commitment_label: &str,
    timeout: Duration,
) -> Result<(Signature, u64), ApiError> {
    let local_signature = *transaction.signatures.first().ok_or_else(|| ApiError {
        message: format!("{action}交易缺少本地签名；{context}"),
    })?;
    if local_signature == Signature::default() {
        return Err(ApiError {
            message: format!("{action}交易尚未签名；{context}"),
        });
    }

    let send_error = match client.send_transaction(transaction) {
        Ok(rpc_signature) => {
            if rpc_signature != local_signature {
                return Err(ApiError {
                    message: format!(
                        "{action} RPC 返回签名 {rpc_signature}，但本地确定签名为 {local_signature}；{context}"
                    ),
                });
            }
            None
        }
        Err(error) if send_error_is_preflight_rejection(&error) => {
            return Err(ApiError {
                message: format!(
                    "{action}交易在 RPC 预检模拟阶段失败，未提交到链上: {error}；{context}"
                ),
            });
        }
        Err(error) => Some(error.to_string()),
    };

    let wait_timeout = if send_error.is_some() {
        timeout.min(Duration::from_secs(10))
    } else {
        timeout
    };
    match wait_for_signature_commitment(
        client,
        &local_signature,
        wait_timeout,
        action,
        commitment,
        commitment_label,
    )
    .await
    {
        Ok(slot) => Ok((local_signature, slot)),
        Err(wait_error) => {
            let send_detail = send_error
                .map(|error| format!("；首次提交 RPC 错误: {error}"))
                .unwrap_or_default();
            Err(ApiError {
                message: format!(
                    "{}{}；{}；本地确定签名: {}。不得自动重签或盲目重试",
                    wait_error.message, send_detail, context, local_signature
                ),
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn sign_and_send_with_commitment(
    client: &RpcClient,
    instructions: Vec<solana_sdk::instruction::Instruction>,
    signers: &[&Keypair],
    payer: &Pubkey,
    action: &str,
    commitment: CommitmentConfig,
    commitment_label: &str,
    timeout: Duration,
) -> Result<(String, u64), ApiError> {
    let (blockhash, _) = client
        .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
        .map_err(|error| ApiError {
            message: format!("获取 {action} blockhash 失败: {error}"),
        })?;
    let transaction =
        Transaction::new_signed_with_payer(&instructions, Some(payer), signers, blockhash);
    let context = format!("{action}；payer={payer}");
    let (signature, slot) = submit_signed_transaction_once(
        client,
        &transaction,
        action,
        &context,
        commitment,
        commitment_label,
        timeout,
    )
    .await?;
    Ok((signature.to_string(), slot))
}

fn estimate_instruction_fee(
    client: &RpcClient,
    instructions: &[solana_sdk::instruction::Instruction],
    payer: &Pubkey,
    recent_blockhash: &solana_sdk::hash::Hash,
    stage: &str,
) -> Result<u64, ApiError> {
    let message = Message::new_with_blockhash(instructions, Some(payer), recent_blockhash);
    client
        .get_fee_for_message(&message)
        .map_err(|error| ApiError {
            message: format!("估算 {stage} 交易费失败: {error}"),
        })
}

fn simulate_program_deployment_transaction(
    client: &RpcClient,
    transaction: &Transaction,
    stage: &str,
) -> Result<(), ApiError> {
    transaction.sanitize().map_err(|error| ApiError {
        message: format!("{stage} 交易结构校验失败: {error:?}"),
    })?;
    let response = client
        .simulate_transaction_with_config(
            transaction,
            RpcSimulateTransactionConfig {
                sig_verify: true,
                replace_recent_blockhash: false,
                commitment: Some(CommitmentConfig::confirmed()),
                encoding: Some(UiTransactionEncoding::Base64),
                accounts: None,
                min_context_slot: None,
                inner_instructions: false,
            },
        )
        .map_err(|error| ApiError {
            message: format!("{stage} 交易模拟 RPC 失败: {error}"),
        })?;
    if let Some(error) = response.value.err {
        return Err(ApiError {
            message: format!("{stage} 交易模拟失败: {error}"),
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn wait_for_finalized_deployment_readback(
    client: &RpcClient,
    program_id: &Pubkey,
    programdata_address: &Pubkey,
    expected_upgrade_authority: &Pubkey,
    expected_program: &[u8],
    max_data_len: usize,
    minimum_slot: u64,
) -> Result<program_deploy::DeploymentReadback, ApiError> {
    let deadline = Instant::now() + Duration::from_secs(20);

    loop {
        let pending_reason = match client.get_multiple_accounts_with_commitment(
            &[*program_id, *programdata_address],
            CommitmentConfig::finalized(),
        ) {
            Ok(response) if response.context.slot >= minimum_slot => {
                let mut accounts = response.value.into_iter();
                match (accounts.next().flatten(), accounts.next().flatten()) {
                    (Some(program), Some(programdata)) => {
                        return program_deploy::verify_deployment_readback(
                            program_id,
                            expected_upgrade_authority,
                            expected_program,
                            max_data_len,
                            &program.owner,
                            program.executable,
                            &program.data,
                            &programdata.owner,
                            &programdata.data,
                        )
                        .map_err(|message| ApiError { message });
                    }
                    _ => "finalized Program 或 ProgramData 尚不可见".to_string(),
                }
            }
            Ok(response) => format!(
                "finalized 账户读取 slot {} 早于部署 slot {}",
                response.context.slot, minimum_slot
            ),
            Err(error) => format!("finalized 回读 RPC 失败: {error}"),
        };

        if Instant::now() >= deadline {
            return Err(ApiError {
                message: format!("部署已 finalized，但链上回读校验超时: {pending_reason}"),
            });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn network_name(network: Option<&str>) -> String {
    rpc_selector(network)
        .map(|selector| selector.network)
        .unwrap_or_else(|_| "mainnet".to_string())
}

fn rpc_client_for(network: Option<&str>) -> Result<(RpcClient, String), ApiError> {
    let selector = rpc_selector(network)?;
    let rpc_url = selector.url;
    let network = selector.network;
    Ok((
        RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed()),
        network,
    ))
}

fn rpc_query_client_for_timeout(
    network: Option<&str>,
    timeout_secs: u64,
) -> Result<(RpcClient, String), ApiError> {
    let selector = rpc_selector(network)?;
    let rpc_url = selector.url.clone();
    let network = selector.network.clone();
    Ok((
        RpcClient::new_with_timeout_and_commitment(
            rpc_url,
            Duration::from_secs(timeout_secs),
            CommitmentConfig::confirmed(),
        ),
        network,
    ))
}

fn rpc_query_client_for_url(url: String, timeout_secs: u64) -> RpcClient {
    RpcClient::new_with_timeout_and_commitment(
        url,
        Duration::from_secs(timeout_secs),
        CommitmentConfig::confirmed(),
    )
}

fn is_retryable_rpc_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("error sending request")
        || message.contains("timed out")
        || message.contains("timeout")
        || message.contains("超时")
        || message.contains("connection rate limits exceeded")
        || message.contains("too many requests")
        || message.contains("429")
        || message.contains("econnreset")
        || message.contains("connection reset")
        || message.contains("connection refused")
        || message.contains("temporarily unavailable")
        || message.contains("service unavailable")
        || message.contains("502")
        || message.contains("503")
        || message.contains("504")
}

fn is_retryable_api_error(error: &ApiError) -> bool {
    is_retryable_rpc_message(&error.message)
}

fn dedupe_rpc_urls(urls: Vec<String>) -> Vec<String> {
    let mut seen = HashMap::new();
    let mut deduped = Vec::new();
    for url in urls {
        let url = url.trim().trim_end_matches('/').to_string();
        if url.is_empty() || seen.contains_key(&url) {
            continue;
        }
        seen.insert(url.clone(), true);
        deduped.push(url);
    }
    deduped
}

fn fallback_rpc_urls(selector: &RpcSelector) -> Vec<String> {
    let mut urls = vec![selector.url.clone()];
    match selector.network.as_str() {
        "devnet" => urls.push(DEVNET_RPC_URL.to_string()),
        "testnet" => {
            urls.push(PUBLICNODE_TESTNET_RPC_URL.to_string());
            urls.push(TESTNET_RPC_URL.to_string());
        }
        _ => {
            urls.push(PUBLICNODE_MAINNET_RPC_URL.to_string());
            urls.push(DEFAULT_RPC_URL.to_string());
        }
    }
    dedupe_rpc_urls(urls)
}

fn rpc_failure_summary(errors: &[(String, String)]) -> String {
    if errors.is_empty() {
        return "没有可用的 RPC 节点".to_string();
    }
    errors
        .iter()
        .map(|(url, error)| format!("{}: {}", url, error))
        .collect::<Vec<_>>()
        .join("; ")
}

fn token_mint_info_from_rpc(
    client: &RpcClient,
    mint: &Pubkey,
) -> Result<solana_account_decoder_client_types::token::UiTokenAmount, ApiError> {
    let supply = client.get_token_supply(mint).map_err(|e| ApiError {
        message: format!("查询 Token Mint 信息失败: {}", e),
    })?;
    if supply.decimals > MAX_TOKEN_DECIMALS {
        return Err(ApiError {
            message: format!("Token 精度不能超过 {}", MAX_TOKEN_DECIMALS),
        });
    }
    Ok(supply)
}

fn parse_token_account(
    keyed_account: RpcKeyedAccount,
) -> Option<(
    String,
    solana_account_decoder_client_types::token::UiTokenAccount,
)> {
    let UiAccountData::Json(parsed_account) = keyed_account.account.data else {
        return None;
    };
    let Ok(TokenAccountType::Account(token_account)) =
        serde_json::from_value::<TokenAccountType>(parsed_account.parsed)
    else {
        return None;
    };
    Some((keyed_account.pubkey, token_account))
}

fn token_accounts_by_program(
    client: &RpcClient,
    owner: &Pubkey,
    program_id: Pubkey,
) -> Result<
    Vec<(
        String,
        solana_account_decoder_client_types::token::UiTokenAccount,
    )>,
    ApiError,
> {
    let filter = TokenAccountsFilter::ProgramId(
        RpcAddress::from_str(&program_id.to_string()).map_err(|e| ApiError {
            message: format!("Token 程序地址解析失败: {}", e),
        })?,
    );
    let accounts = client
        .get_token_accounts_by_owner(owner, filter)
        .map_err(|e| ApiError {
            message: format!("查询 Token 账户失败: {}", e),
        })?;
    Ok(accounts
        .into_iter()
        .filter_map(parse_token_account)
        .collect())
}

fn all_owner_token_accounts(
    client: &RpcClient,
    owner: &Pubkey,
) -> Result<
    Vec<(
        String,
        solana_account_decoder_client_types::token::UiTokenAccount,
    )>,
    ApiError,
> {
    let token_program = Pubkey::from_str(SPL_TOKEN_PROGRAM_ID).map_err(|e| ApiError {
        message: format!("Token 程序地址解析失败: {}", e),
    })?;
    let token_2022_program = Pubkey::from_str(SPL_TOKEN_2022_PROGRAM_ID).map_err(|e| ApiError {
        message: format!("Token-2022 程序地址解析失败: {}", e),
    })?;
    let token_accounts = token_accounts_by_program(client, owner, token_program);
    let token_2022_accounts = token_accounts_by_program(client, owner, token_2022_program);

    match (token_accounts, token_2022_accounts) {
        (Ok(mut accounts), Ok(mut token_2022_accounts)) => {
            accounts.append(&mut token_2022_accounts);
            Ok(accounts)
        }
        (Ok(_), Err(err)) if is_retryable_api_error(&err) => Err(ApiError {
            message: format!("查询 Token 账户失败: Token-2022: {}", err.message),
        }),
        (Err(err), Ok(_)) if is_retryable_api_error(&err) => Err(ApiError {
            message: format!("查询 Token 账户失败: SPL Token: {}", err.message),
        }),
        (Ok(accounts), Err(err)) => {
            tracing::warn!(
                "Token-2022 account query failed; returning SPL Token accounts only: {}",
                err.message
            );
            Ok(accounts)
        }
        (Err(err), Ok(accounts)) => {
            tracing::warn!(
                "SPL Token account query failed; returning Token-2022 accounts only: {}",
                err.message
            );
            Ok(accounts)
        }
        (Err(token_err), Err(token_2022_err)) => Err(ApiError {
            message: format!(
                "查询 Token 账户失败: SPL Token: {}; Token-2022: {}",
                token_err.message, token_2022_err.message
            ),
        }),
    }
}

#[derive(Clone, Default)]
struct TokenMetadata {
    name: Option<String>,
    symbol: Option<String>,
    logo_uri: Option<String>,
    metadata_uri: Option<String>,
}

#[derive(Clone, Copy)]
struct LocalTokenMetadata {
    mint: &'static str,
    name: &'static str,
    symbol: &'static str,
    logo_uri: &'static str,
}

impl LocalTokenMetadata {
    fn into_token_metadata(self) -> TokenMetadata {
        TokenMetadata {
            name: Some(self.name.to_string()),
            symbol: Some(self.symbol.to_string()),
            logo_uri: Some(self.logo_uri.to_string()),
            metadata_uri: None,
        }
    }
}

impl TokenMetadata {
    fn merge_missing(&mut self, other: TokenMetadata) {
        if self.name.is_none() {
            self.name = other.name;
        }
        if self.symbol.is_none() {
            self.symbol = other.symbol;
        }
        if self.logo_uri.is_none() {
            self.logo_uri = other.logo_uri;
        }
        if self.metadata_uri.is_none() {
            self.metadata_uri = other.metadata_uri;
        }
    }
}

fn now_unix_secs_lossy() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn normalize_token_metadata(mint: &str, mut metadata: TokenMetadata) -> TokenMetadata {
    if let Some(local_metadata) = local_token_metadata(mint) {
        metadata.name = Some(local_metadata.name.to_string());
        metadata.symbol = Some(local_metadata.symbol.to_string());
        metadata.logo_uri = Some(local_metadata.logo_uri.to_string());
    }
    metadata
}

fn local_token_metadata(mint: &str) -> Option<LocalTokenMetadata> {
    LOCAL_TOKEN_METADATA
        .iter()
        .copied()
        .find(|metadata| metadata.mint == mint)
}

fn clean_metadata_string(value: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(value)
        .trim_matches(char::from(0))
        .trim()
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn clean_json_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn has_token_identity(metadata: &TokenMetadata) -> bool {
    metadata.name.is_some() && metadata.symbol.is_some()
}

fn read_metadata_string(data: &[u8], offset: &mut usize) -> Option<String> {
    let len_bytes = data.get(*offset..(*offset + 4))?;
    let len = u32::from_le_bytes(len_bytes.try_into().ok()?) as usize;
    *offset += 4;
    let value = data.get(*offset..(*offset + len))?;
    *offset += len;
    clean_metadata_string(value)
}

fn normalize_metadata_uri(value: &str) -> Option<String> {
    let value = value.trim();
    if value.starts_with("http://") || value.starts_with("https://") {
        Some(value.to_string())
    } else {
        value
            .strip_prefix("ipfs://")
            .map(|path| format!("https://ipfs.io/ipfs/{}", path.trim_start_matches("ipfs/")))
    }
}

fn logo_uri_from_value(value: &Value) -> Option<String> {
    ["image", "image_uri", "logo_uri"]
        .iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .and_then(normalize_metadata_uri)
}

async fn fetch_token_json_metadata(uri: &str) -> TokenMetadata {
    let Some(uri) = normalize_metadata_uri(uri) else {
        return TokenMetadata::default();
    };
    let Some(response) = reqwest::Client::new()
        .get(uri.as_str())
        .timeout(std::time::Duration::from_millis(
            TOKEN_METADATA_JSON_TIMEOUT_MS,
        ))
        .send()
        .await
        .ok()
    else {
        return TokenMetadata::default();
    };
    if !response.status().is_success() {
        return TokenMetadata::default();
    }
    let Some(bytes) = response.bytes().await.ok() else {
        return TokenMetadata::default();
    };
    if bytes.len() > MAX_TOKEN_METADATA_URI_BYTES {
        return TokenMetadata::default();
    }
    let Some(value) = serde_json::from_slice::<Value>(&bytes).ok() else {
        return TokenMetadata::default();
    };

    TokenMetadata {
        name: clean_json_string(value.get("name")),
        symbol: clean_json_string(value.get("symbol")),
        logo_uri: logo_uri_from_value(&value),
        metadata_uri: None,
    }
}

async fn enrich_token_metadata_uri(metadata: &mut TokenMetadata, uri: Option<&str>) {
    if let Some(uri) = uri {
        metadata.merge_missing(fetch_token_json_metadata(uri.trim()).await);
    }
}

async fn token_2022_metadata_from_account(
    account: solana_account_decoder_client_types::UiAccount,
) -> TokenMetadata {
    let UiAccountData::Json(parsed_account) = account.data else {
        return TokenMetadata::default();
    };
    let Ok(TokenAccountType::Mint(mint)) =
        serde_json::from_value::<TokenAccountType>(parsed_account.parsed)
    else {
        return TokenMetadata::default();
    };

    for extension in mint.extensions {
        if let UiExtension::TokenMetadata(token_metadata) = extension {
            let mut metadata = TokenMetadata {
                name: clean_metadata_string(token_metadata.name.as_bytes()),
                symbol: clean_metadata_string(token_metadata.symbol.as_bytes()),
                logo_uri: None,
                metadata_uri: normalize_metadata_uri(token_metadata.uri.as_str()),
            };
            if !has_token_identity(&metadata) && metadata.metadata_uri.is_none() {
                enrich_token_metadata_uri(&mut metadata, Some(token_metadata.uri.as_str())).await;
            }
            return metadata;
        }
    }

    TokenMetadata::default()
}

fn should_try_metaplex_metadata(
    account: Option<&solana_account_decoder_client_types::UiAccount>,
) -> bool {
    match account {
        Some(account) => account.owner == SPL_TOKEN_PROGRAM_ID,
        None => true,
    }
}

async fn fetch_metaplex_token_metadata(client: &RpcClient, mint_pubkey: &Pubkey) -> TokenMetadata {
    let Ok(program_id) = Pubkey::from_str(METAPLEX_TOKEN_METADATA_PROGRAM_ID) else {
        return TokenMetadata::default();
    };
    let Some((metadata_pubkey, _)) = Pubkey::try_find_program_address(
        &[b"metadata", program_id.as_ref(), mint_pubkey.as_ref()],
        &program_id,
    ) else {
        return TokenMetadata::default();
    };
    let Ok(account) = client.get_account(&metadata_pubkey) else {
        return TokenMetadata::default();
    };

    // Metaplex Metadata V1 layout: key(1), update_authority(32), mint(32), then Data(name, symbol, uri).
    let mut offset = 1 + 32 + 32;
    let name = read_metadata_string(&account.data, &mut offset);
    let symbol = read_metadata_string(&account.data, &mut offset);
    let metadata_uri = read_metadata_string(&account.data, &mut offset);

    let mut metadata = TokenMetadata {
        name,
        symbol,
        logo_uri: None,
        metadata_uri: metadata_uri.as_deref().and_then(normalize_metadata_uri),
    };
    if !has_token_identity(&metadata) && metadata.metadata_uri.is_none() {
        enrich_token_metadata_uri(&mut metadata, metadata_uri.as_deref()).await;
    }
    metadata
}

async fn enrich_token_json_metadata_map(metadata_by_mint: &mut HashMap<String, TokenMetadata>) {
    let pending = metadata_by_mint
        .iter()
        .filter_map(|(mint, metadata)| {
            if metadata.logo_uri.is_none() || !has_token_identity(metadata) {
                metadata
                    .metadata_uri
                    .as_ref()
                    .map(|uri| (mint.clone(), uri.clone()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    let logos = stream::iter(pending)
        .map(|(mint, uri)| async move {
            let metadata = fetch_token_json_metadata(&uri).await;
            (mint, metadata)
        })
        .buffer_unordered(TOKEN_METADATA_JSON_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    for (mint, json_metadata) in logos {
        if let Some(metadata) = metadata_by_mint.get_mut(&mint) {
            metadata.merge_missing(json_metadata);
        }
    }
}

async fn load_token_metadata_map(
    client: &RpcClient,
    mints: &[String],
) -> HashMap<String, TokenMetadata> {
    let mut metadata_by_mint: HashMap<String, TokenMetadata> = HashMap::new();
    let mut parsed_mints = Vec::new();
    for mint in mints {
        if let Ok(pubkey) = Pubkey::from_str(mint) {
            parsed_mints.push((mint.clone(), pubkey));
        }
    }

    for chunk in parsed_mints.chunks(TOKEN_METADATA_BATCH_SIZE) {
        let pubkeys: Vec<Pubkey> = chunk.iter().map(|(_, pubkey)| *pubkey).collect();
        let accounts = client
            .get_multiple_ui_accounts_with_config(
                &pubkeys,
                RpcAccountInfoConfig {
                    encoding: Some(UiAccountEncoding::JsonParsed),
                    commitment: Some(CommitmentConfig::confirmed()),
                    ..RpcAccountInfoConfig::default()
                },
            )
            .map(|response| response.value)
            .unwrap_or_default();

        for ((mint, pubkey), account) in chunk.iter().zip(accounts) {
            let metadata = match account.clone() {
                Some(account) => token_2022_metadata_from_account(account).await,
                None => TokenMetadata::default(),
            };
            if metadata.name.is_some() || metadata.symbol.is_some() || metadata.logo_uri.is_some() {
                metadata_by_mint.insert(mint.clone(), metadata);
            } else if should_try_metaplex_metadata(account.as_ref()) {
                metadata_by_mint.insert(
                    mint.clone(),
                    fetch_metaplex_token_metadata(client, pubkey).await,
                );
            } else {
                metadata_by_mint.insert(mint.clone(), metadata);
            }
        }
    }

    enrich_token_json_metadata_map(&mut metadata_by_mint).await;
    metadata_by_mint
}

fn token_metadata_from_cache_record(record: &TokenMetadataRecord) -> TokenMetadata {
    normalize_token_metadata(
        &record.mint,
        TokenMetadata {
            name: clean_cached_metadata_string(record.name.clone()),
            symbol: clean_cached_metadata_string(record.symbol.clone()),
            logo_uri: clean_cached_metadata_string(record.logo_uri.clone()),
            metadata_uri: None,
        },
    )
}

fn token_metadata_is_complete(metadata: &TokenMetadata) -> bool {
    has_token_identity(metadata) && metadata.logo_uri.is_some()
}

fn token_metadata_records(
    network: &str,
    metadata_by_mint: &HashMap<String, TokenMetadata>,
) -> Vec<TokenMetadataRecord> {
    metadata_by_mint
        .iter()
        .filter_map(|(mint, metadata)| {
            let metadata = normalize_token_metadata(mint, metadata.clone());
            if metadata.name.is_none() && metadata.symbol.is_none() && metadata.logo_uri.is_none() {
                return None;
            }
            Some(TokenMetadataRecord {
                network: network.to_string(),
                mint: mint.clone(),
                name: metadata.name,
                symbol: metadata.symbol,
                logo_uri: metadata.logo_uri,
                updated_at: 0,
            })
        })
        .collect()
}

fn merge_cached_token_metadata(
    network: &str,
    metadata_by_mint: &mut HashMap<String, TokenMetadata>,
    mints: &[String],
) -> Vec<String> {
    let mut missing_mints = Vec::new();
    let now = now_unix_secs_lossy();
    let cached_records = wallet_store::get_token_metadata(network, mints).unwrap_or_default();
    let mut cached_by_mint: HashMap<String, TokenMetadataRecord> = cached_records
        .into_iter()
        .map(|record| (record.mint.clone(), record))
        .collect();

    for mint in mints {
        if let Some(local_metadata) = local_token_metadata(mint) {
            metadata_by_mint.insert(mint.clone(), local_metadata.into_token_metadata());
            continue;
        }

        let Some(cached) = cached_by_mint.remove(mint) else {
            if metadata_by_mint
                .get(mint)
                .map(token_metadata_is_complete)
                .unwrap_or(false)
            {
                continue;
            }
            missing_mints.push(mint.clone());
            continue;
        };
        let cached_metadata = token_metadata_from_cache_record(&cached);
        metadata_by_mint
            .entry(mint.clone())
            .or_default()
            .merge_missing(cached_metadata.clone());
        let stale = now.saturating_sub(cached.updated_at) > TOKEN_METADATA_CACHE_TTL_SECS;
        if stale || !token_metadata_is_complete(&cached_metadata) {
            missing_mints.push(mint.clone());
        }
    }

    missing_mints
}

async fn load_missing_token_metadata(
    client: &RpcClient,
    network: &str,
    metadata_by_mint: &mut HashMap<String, TokenMetadata>,
    missing_mints: &[String],
) {
    if missing_mints.is_empty() {
        return;
    }

    let fresh_metadata_by_mint = load_token_metadata_map(client, missing_mints).await;
    if fresh_metadata_by_mint.is_empty() {
        return;
    }

    for (mint, metadata) in fresh_metadata_by_mint.iter() {
        metadata_by_mint
            .entry(mint.clone())
            .or_default()
            .merge_missing(normalize_token_metadata(mint, metadata.clone()));
    }

    let records = token_metadata_records(network, &fresh_metadata_by_mint);
    let _ = wallet_store::save_token_metadata(network, &records);
}

fn load_squads_multisig(client: &RpcClient, multisig: &Pubkey) -> Result<SquadsMultisig, ApiError> {
    let account = client.get_account(multisig).map_err(|e| ApiError {
        message: format!("读取 Squads 多签账户失败: {}", e),
    })?;
    if account.owner != squads_v4::SQUADS_PROGRAM_ID || account.executable {
        return Err(ApiError {
            message: format!(
                "{} 不是由 Squads v4 Program 持有的非 executable 多签账户",
                multisig
            ),
        });
    }
    let state = squads_v4::decode_account::<SquadsMultisig>(&account.data, "Multisig")
        .map_err(|message| ApiError { message })?;
    let (expected_multisig, expected_bump) = squads_v4::multisig_pda_with_bump(&state.create_key);
    if expected_multisig != *multisig || expected_bump != state.bump {
        return Err(ApiError {
            message: format!(
                "Squads 多签地址或 bump 与 create key 派生结果不一致；请求 {}，派生 {}",
                multisig, expected_multisig
            ),
        });
    }
    Ok(state)
}

fn load_squads_proposal(client: &RpcClient, proposal: &Pubkey) -> Result<SquadsProposal, ApiError> {
    let account = client.get_account(proposal).map_err(|e| ApiError {
        message: format!("读取 Squads 提案失败: {}", e),
    })?;
    squads_v4::decode_account::<SquadsProposal>(&account.data, "Proposal")
        .map_err(|message| ApiError { message })
}

fn load_squads_vault_transaction(
    client: &RpcClient,
    transaction: &Pubkey,
) -> Result<SquadsVaultTransaction, ApiError> {
    let account = client.get_account(transaction).map_err(|e| ApiError {
        message: format!("读取 Squads 交易账户失败: {}", e),
    })?;
    squads_v4::decode_account::<SquadsVaultTransaction>(&account.data, "VaultTransaction")
        .map_err(|message| ApiError { message })
}

fn load_squads_program_config(client: &RpcClient) -> Result<SquadsProgramConfig, ApiError> {
    let program_config = squads_v4::program_config_pda();
    let account = client.get_account(&program_config).map_err(|e| ApiError {
        message: format!("读取 Squads program config 失败: {}", e),
    })?;
    squads_v4::decode_account::<SquadsProgramConfig>(&account.data, "ProgramConfig")
        .map_err(|message| ApiError { message })
}

fn next_squads_transaction_index(multisig: &SquadsMultisig) -> Result<u64, ApiError> {
    multisig
        .transaction_index
        .checked_add(1)
        .ok_or_else(|| ApiError {
            message: "Squads transaction index 超出范围".to_string(),
        })
}

fn sign_and_send_single(
    client: &RpcClient,
    instruction: solana_sdk::instruction::Instruction,
    signer: &Keypair,
) -> Result<String, ApiError> {
    sign_and_send(client, vec![instruction], &[signer], &signer.pubkey())
}

fn require_squads_member(multisig: &SquadsMultisig, signer: &Pubkey) -> Result<(), ApiError> {
    if multisig.members.iter().any(|member| member.key == *signer) {
        Ok(())
    } else {
        Err(ApiError {
            message: format!("签名钱包 {} 不是该 Squads 多签成员", signer),
        })
    }
}

fn loader_upgrade_authority_from_programdata(data: &[u8]) -> Result<Pubkey, ApiError> {
    if data.len() < UpgradeableLoaderState::size_of_programdata_metadata() {
        return Err(ApiError {
            message: "ProgramData 账户长度不足".to_string(),
        });
    }
    let state: UpgradeableLoaderState =
        bincode::deserialize(&data[..UpgradeableLoaderState::size_of_programdata_metadata()])
            .map_err(|_| ApiError {
                message: "ProgramData loader state 解析失败".to_string(),
            })?;
    match state {
        UpgradeableLoaderState::ProgramData {
            upgrade_authority_address: Some(authority),
            ..
        } => Ok(authority),
        UpgradeableLoaderState::ProgramData {
            upgrade_authority_address: None,
            ..
        } => Err(ApiError {
            message: "ProgramData 没有 upgrade authority，无法升级".to_string(),
        }),
        _ => Err(ApiError {
            message: "账户不是 upgradeable-loader ProgramData".to_string(),
        }),
    }
}

fn require_program_upgrade_authority(
    client: &RpcClient,
    program_id: &Pubkey,
    expected_authority: &Pubkey,
) -> Result<Pubkey, ApiError> {
    let programdata_address = get_program_data_address(program_id);
    let response = client
        .get_multiple_accounts_with_commitment(
            &[*program_id, programdata_address],
            CommitmentConfig::confirmed(),
        )
        .map_err(|error| ApiError {
            message: format!("读取 Program upgrade authority 失败: {error}"),
        })?;
    let mut accounts = response.value.into_iter();
    let program_account = accounts.next().flatten().ok_or_else(|| ApiError {
        message: format!("Program {} 不存在", program_id),
    })?;
    let programdata_account = accounts.next().flatten().ok_or_else(|| ApiError {
        message: format!("ProgramData {} 不存在", programdata_address),
    })?;
    if program_account.owner != UPGRADEABLE_LOADER_ID
        || programdata_account.owner != UPGRADEABLE_LOADER_ID
        || !program_account.executable
    {
        return Err(ApiError {
            message: "目标 Program 不是 upgradeable loader 可升级程序".to_string(),
        });
    }
    let state: UpgradeableLoaderState =
        bincode::deserialize(&program_account.data).map_err(|_| ApiError {
            message: "Program loader state 解析失败".to_string(),
        })?;
    match state {
        UpgradeableLoaderState::Program {
            programdata_address: actual,
        } if actual == programdata_address => {}
        _ => {
            return Err(ApiError {
                message: "Program 指向的 ProgramData 与派生地址不一致".to_string(),
            })
        }
    }
    let authority = loader_upgrade_authority_from_programdata(&programdata_account.data)?;
    if authority != *expected_authority {
        return Err(ApiError {
            message: format!(
                "Program upgrade authority 为 {}，预期为 {}",
                authority, expected_authority
            ),
        });
    }
    Ok(programdata_address)
}

fn require_upgrade_buffer_authority(
    client: &RpcClient,
    buffer: &Pubkey,
    expected_authority: &Pubkey,
) -> Result<(), ApiError> {
    let account = client.get_account(buffer).map_err(|error| ApiError {
        message: format!("读取升级 Buffer {} 失败: {error}", buffer),
    })?;
    if account.owner != UPGRADEABLE_LOADER_ID || account.executable {
        return Err(ApiError {
            message: format!("{} 不是 upgradeable loader Buffer", buffer),
        });
    }
    let metadata_len = UpgradeableLoaderState::size_of_buffer_metadata();
    if account.data.len() < metadata_len {
        return Err(ApiError {
            message: "升级 Buffer 账户长度不足".to_string(),
        });
    }
    let state: UpgradeableLoaderState = bincode::deserialize(&account.data[..metadata_len])
        .map_err(|_| ApiError {
            message: "升级 Buffer loader state 解析失败".to_string(),
        })?;
    match state {
        UpgradeableLoaderState::Buffer {
            authority_address: Some(authority),
        } if authority == *expected_authority => Ok(()),
        UpgradeableLoaderState::Buffer {
            authority_address: Some(authority),
        } => Err(ApiError {
            message: format!(
                "升级 Buffer authority 为 {}，预期为 Squads vault {}",
                authority, expected_authority
            ),
        }),
        UpgradeableLoaderState::Buffer {
            authority_address: None,
        } => Err(ApiError {
            message: "升级 Buffer 没有 authority".to_string(),
        }),
        _ => Err(ApiError {
            message: "账户不是 upgradeable-loader Buffer".to_string(),
        }),
    }
}

struct PumpSellRoute {
    dex_type: DexType,
    extension_params: DexParamEnum,
    output_token_type: TradeTokenType,
    create_output_token_ata: bool,
}

impl PumpSellRoute {
    fn pumpfun(params: PumpFunParams) -> Self {
        Self {
            dex_type: DexType::PumpFun,
            extension_params: DexParamEnum::PumpFun(params.with_quote_mint(WSOL_TOKEN_ACCOUNT)),
            output_token_type: TradeTokenType::SOL,
            create_output_token_ata: false,
        }
    }

    fn pumpswap(params: PumpSwapParams) -> Self {
        Self {
            dex_type: DexType::PumpSwap,
            extension_params: DexParamEnum::PumpSwap(params),
            output_token_type: TradeTokenType::WSOL,
            create_output_token_ata: true,
        }
    }
}

struct PumpSellExecution {
    signature: String,
    dex_type: DexType,
    sold_raw_amount: u64,
    decimals: u8,
    source_account: String,
}

fn pump_sell_dex_value(dex_type: DexType) -> &'static str {
    match dex_type {
        DexType::PumpFun => "pumpfun",
        DexType::PumpSwap => "pumpswap",
        _ => "unknown",
    }
}

fn pump_sell_market_value(dex_type: DexType) -> &'static str {
    match dex_type {
        DexType::PumpFun => "inner",
        DexType::PumpSwap => "outer",
        _ => "unknown",
    }
}

fn is_retryable_rpc_read_error(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("error sending request")
        || message.contains("timed out")
        || message.contains("timeout")
        || message.contains("超时")
        || message.contains("connection rate limits exceeded")
        || message.contains("too many requests")
        || message.contains("429")
        || message.contains("econnreset")
        || message.contains("connection reset")
        || message.contains("connection refused")
        || message.contains("temporarily unavailable")
}

async fn pumpfun_params_from_mint_by_rpc(
    rpc: &SolanaRpcClient,
    mint: &Pubkey,
) -> Result<PumpFunParams, anyhow::Error> {
    let mut last_error = None;
    for attempt in 1..=PUMPFUN_PARAM_RPC_ATTEMPTS {
        let retry_error = match tokio::time::timeout(
            Duration::from_millis(PUMPFUN_PARAM_RPC_TIMEOUT_MS),
            PumpFunParams::from_mint_by_rpc(rpc, mint),
        )
        .await
        {
            Ok(Ok(params)) => return Ok(params),
            Ok(Err(error)) if is_retryable_rpc_read_error(&error) => error,
            Ok(Err(error)) => return Err(error),
            Err(_) => anyhow::anyhow!(
                "Pump.fun 参数读取超时 (timeout after {} ms)",
                PUMPFUN_PARAM_RPC_TIMEOUT_MS
            ),
        };

        tracing::warn!(
            "Pump.fun param read failed for mint {} on attempt {}/{}: {}",
            mint,
            attempt,
            PUMPFUN_PARAM_RPC_ATTEMPTS,
            retry_error
        );
        last_error = Some(retry_error);
        if attempt < PUMPFUN_PARAM_RPC_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(PUMPFUN_PARAM_RETRY_DELAY_MS)).await;
            continue;
        }
        break;
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Pump.fun 参数读取失败")))
}

async fn pumpswap_params_from_mint_by_rpc(
    rpc: &SolanaRpcClient,
    mint: &Pubkey,
) -> Result<PumpSwapParams, anyhow::Error> {
    let (pool_address, pool_data) = pumpswap::find_by_mint(rpc, mint).await?;
    PumpSwapParams::from_pool_data(rpc, &pool_address, &pool_data).await
}

async fn resolve_pump_sell_route(
    rpc: &SolanaRpcClient,
    mint: &Pubkey,
    requested_dex_type: DexType,
) -> Result<PumpSellRoute, ApiError> {
    match requested_dex_type {
        DexType::PumpFun => match pumpfun_params_from_mint_by_rpc(rpc, mint).await {
            Ok(params) => {
                if !params.bonding_curve.complete {
                    return Ok(PumpSellRoute::pumpfun(params));
                }

                match pumpswap_params_from_mint_by_rpc(rpc, mint).await {
                    Ok(pumpswap_params) => {
                        tracing::info!(
                            "Pump.fun bonding curve is complete; routing sell to PumpSwap for mint {}",
                            mint
                        );
                        Ok(PumpSellRoute::pumpswap(pumpswap_params))
                    }
                    Err(pumpswap_err) => Err(ApiError {
                        message: format!(
                            "该代币 Pump.fun bonding curve 已完成，但未找到可用 PumpSwap 池，无法自动外盘卖出: {}",
                            pumpswap_err
                        ),
                    }),
                }
            }
            Err(pumpfun_err) => match pumpswap_params_from_mint_by_rpc(rpc, mint).await {
                Ok(pumpswap_params) => {
                    tracing::info!(
                        "Pump.fun params failed for mint {}; routing sell to PumpSwap: {}",
                        mint,
                        pumpfun_err
                    );
                    Ok(PumpSellRoute::pumpswap(pumpswap_params))
                }
                Err(pumpswap_err) => {
                    let message = if is_retryable_rpc_read_error(&pumpfun_err) {
                        format!(
                            "RPC 节点暂时无法读取 Pump.fun 参数: {}；同时未找到 PumpSwap 池: {}。该代币可能仍在 Pump.fun 内盘，请稍后重试，或在网络设置中换用稳定的主网 RPC。",
                            pumpfun_err, pumpswap_err
                        )
                    } else {
                        format!(
                            "获取 Pump.fun 参数失败: {}；同时获取 PumpSwap 参数失败: {}。请确认代币还在 Pump.fun 内盘或已经迁移到 PumpSwap 外盘。",
                            pumpfun_err, pumpswap_err
                        )
                    };
                    Err(ApiError { message })
                }
            },
        },
        DexType::PumpSwap => pumpswap_params_from_mint_by_rpc(rpc, mint)
            .await
            .map(PumpSellRoute::pumpswap)
            .map_err(|e| ApiError {
                message: format!("获取 PumpSwap 参数失败: {}", e),
            }),
        _ => Err(ApiError {
            message: "不支持的交易类型".to_string(),
        }),
    }
}

async fn execute_pump_sell(
    keypair: Keypair,
    mint: String,
    rpc_url: &str,
    human_amount: Option<DecimalAmount>,
    sell_percent_bps: Option<u64>,
    slippage: u64,
    dex_type: DexType,
) -> Result<PumpSellExecution, ApiError> {
    let mint_pubkey = Pubkey::from_str(&mint).map_err(|_| ApiError {
        message: "无效的代币地址".to_string(),
    })?;
    let payer = Arc::new(keypair);
    let commitment = CommitmentConfig::confirmed();
    let rpc_client = RpcClient::new_with_timeout_and_commitment(
        rpc_url.to_string(),
        Duration::from_secs(RPC_QUERY_TIMEOUT_SECS),
        commitment,
    );
    let (sell_source, raw_amount) = select_pump_sell_token_source(
        &rpc_client,
        &mint_pubkey,
        &payer.pubkey(),
        human_amount.as_ref(),
        sell_percent_bps,
    )?;
    let use_seed = sell_source.kind.use_seed();
    let swqos_configs = default_swqos_configs(rpc_url);
    let init_trade_config = TradeConfig::builder(rpc_url.to_string(), swqos_configs, commitment)
        .create_wsol_ata_on_startup(false)
        .use_seed_optimize(use_seed)
        .check_min_tip(false)
        .log_enabled(false)
        .swqos_cores_from_end(false)
        .mev_protection(false)
        .build();
    let init_client = SolanaTrade::new(payer.clone(), init_trade_config).await;
    let client = swqos_only_sell_client(&init_client, payer.clone(), use_seed)?;

    let recent_blockhash = client
        .infrastructure
        .rpc
        .get_latest_blockhash()
        .await
        .map_err(|e| ApiError {
            message: format!("获取 blockhash 失败: {}", e),
        })?;
    let gas_fee_strategy = GasFeeStrategy::new();
    gas_fee_strategy.set_global_fee_strategy(
        150000,
        150000,
        500000,
        500000,
        DEFAULT_SWQOS_TIP_SOL,
        DEFAULT_SWQOS_TIP_SOL,
    );

    let route = resolve_pump_sell_route(&client.infrastructure.rpc, &mint_pubkey, dex_type).await?;
    let actual_dex_type = route.dex_type;
    tracing::info!(
        "Submitting pump sell mint={} requested_dex={} actual_dex={} raw_amount={} source_kind={} source_account={} source_balance={} decimals={} token_program={} use_seed={} slippage_bps={}",
        mint_pubkey,
        pump_sell_dex_value(dex_type),
        pump_sell_dex_value(actual_dex_type),
        raw_amount,
        sell_source.kind.label(),
        sell_source.account,
        sell_source.raw_amount,
        sell_source.decimals,
        sell_source.token_program,
        use_seed,
        slippage
    );

    let sell_params = TradeSellParams {
        dex_type: actual_dex_type,
        output_token_type: route.output_token_type,
        mint: mint_pubkey,
        input_token_amount: raw_amount,
        slippage_basis_points: Some(slippage),
        recent_blockhash: Some(recent_blockhash),
        with_tip: true,
        extension_params: route.extension_params,
        address_lookup_table_account: None,
        // Return once the transaction is submitted and a signature is available.
        // Waiting for confirmation inside this HTTP request can outlive the browser/proxy
        // connection and surfaces as ECONNRESET even though the sell was already submitted.
        wait_tx_confirmed: false,
        create_output_token_ata: route.create_output_token_ata,
        close_output_token_ata: false,
        close_mint_token_ata: false,
        durable_nonce: None,
        fixed_output_token_amount: None,
        gas_fee_strategy,
        simulate: false,
        wait_for_all_submits: false,
        grpc_recv_us: None,
    };

    let sell_result = tokio::time::timeout(
        Duration::from_secs(PUMP_SELL_SUBMIT_TIMEOUT_SECS),
        AssertUnwindSafe(client.sell(sell_params)).catch_unwind(),
    )
    .await
    .map_err(|_| {
        let message = format!(
            "卖出提交超时，{} 秒内没有拿到交易签名；请先刷新交易记录或链上浏览器确认是否已提交成功",
            PUMP_SELL_SUBMIT_TIMEOUT_SECS
        );
        tracing::warn!(
            "Pump sell submit timeout mint={} dex={} raw_amount={} after {}s",
            mint_pubkey,
            pump_sell_dex_value(actual_dex_type),
            raw_amount,
            PUMP_SELL_SUBMIT_TIMEOUT_SECS
        );
        ApiError { message }
    })?
    .map_err(|panic_payload| {
        let message = format!("卖出执行异常: {}", panic_message(panic_payload.as_ref()));
        tracing::error!(
            "Pump sell panic mint={} dex={} raw_amount={}: {}",
            mint_pubkey,
            pump_sell_dex_value(actual_dex_type),
            raw_amount,
            message
        );
        ApiError { message }
    })?;

    let (success, signatures, error, _latency_info) = sell_result.map_err(|e| {
        let message = format!("卖出失败: {}", e);
        tracing::warn!(
            "Pump sell failed mint={} dex={} raw_amount={}: {}",
            mint_pubkey,
            pump_sell_dex_value(actual_dex_type),
            raw_amount,
            message
        );
        ApiError { message }
    })?;
    if !success {
        let error_msg = error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "Unknown error".to_string());
        tracing::warn!(
            "Pump sell returned unsuccessful mint={} dex={} raw_amount={}: {}",
            mint_pubkey,
            pump_sell_dex_value(actual_dex_type),
            raw_amount,
            error_msg
        );
        return Err(ApiError {
            message: format!("卖出失败: {}", error_msg),
        });
    }

    let signature = signatures
        .first()
        .map(|sig| sig.to_string())
        .ok_or_else(|| ApiError {
            message: "卖出成功但未返回交易签名".to_string(),
        })?;

    Ok(PumpSellExecution {
        signature,
        dex_type: actual_dex_type,
        sold_raw_amount: raw_amount,
        decimals: sell_source.decimals,
        source_account: sell_source.account.to_string(),
    })
}

#[derive(RustEmbed)]
#[folder = "../../apps/desktop/out"]
struct Assets;

const DEFAULT_RPC_URL: &str = "https://api.mainnet-beta.solana.com";
const DEVNET_RPC_URL: &str = "https://api.devnet.solana.com";
const TESTNET_RPC_URL: &str = "https://api.testnet.solana.com";
const PUBLICNODE_MAINNET_RPC_URL: &str = "https://solana.publicnode.com";
const PUBLICNODE_TESTNET_RPC_URL: &str = "https://solana-testnet-rpc.publicnode.com";

#[cfg(unix)]
fn disable_core_dumps() {
    let limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a valid `rlimit` value and the call does not retain its pointer.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } != 0 {
        tracing::warn!(
            "failed to disable process core dumps: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(not(unix))]
fn disable_core_dumps() {}

fn start_wallet_session_cleanup() {
    tokio::spawn(async {
        let mut interval = tokio::time::interval(WALLET_SESSION_CLEANUP_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(message) = wallet_session_vault().purge_expired() {
                tracing::warn!("failed to purge expired wallet sessions: {message}");
            }
        }
    });
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "fnzero_safe_ui=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
    disable_core_dumps();
    start_wallet_session_cleanup();
    let _ = secure_body_keypair();
    let _ = local_api_token();

    let app = Router::new()
        // Health
        .route("/api/health", get(health))
        .route("/api/health/", get(health))
        .route("/api/chains", get(multichain_chains))
        .route("/api/chains/", get(multichain_chains))
        .route(
            "/api/chains/address/normalize",
            post(multichain_normalize_address),
        )
        .route(
            "/api/chains/address/normalize/",
            post(multichain_normalize_address),
        )
        .route(
            "/api/chains/account/derive",
            post(multichain_derive_account),
        )
        .route(
            "/api/chains/account/derive/",
            post(multichain_derive_account),
        )
        .route("/api/evm/chains", get(evm_chains))
        .route("/api/evm/chains/", get(evm_chains))
        .route("/api/evm/wallet/create", post(evm_wallet_create))
        .route("/api/evm/wallet/create/", post(evm_wallet_create))
        .route(
            "/api/evm/wallet/import-private-key",
            post(evm_wallet_import_private_key),
        )
        .route(
            "/api/evm/wallet/import-private-key/",
            post(evm_wallet_import_private_key),
        )
        .route(
            "/api/evm/wallet/import-mnemonic",
            post(evm_wallet_import_mnemonic),
        )
        .route(
            "/api/evm/wallet/import-mnemonic/",
            post(evm_wallet_import_mnemonic),
        )
        .route(
            "/api/evm/wallet/import-keystore",
            post(evm_wallet_import_keystore),
        )
        .route(
            "/api/evm/wallet/import-keystore/",
            post(evm_wallet_import_keystore),
        )
        .route("/api/evm/wallet/unlock", post(evm_wallet_unlock))
        .route("/api/evm/wallet/unlock/", post(evm_wallet_unlock))
        .route(
            "/api/evm/wallet/export",
            post(evm_wallet_export_private_key),
        )
        .route(
            "/api/evm/wallet/export/",
            post(evm_wallet_export_private_key),
        )
        .route("/api/evm/assets", post(evm_assets))
        .route("/api/evm/assets/", post(evm_assets))
        .route("/api/evm/payment/preview", post(evm_payment_preview))
        .route("/api/evm/payment/preview/", post(evm_payment_preview))
        .route("/api/evm/payment/submit", post(evm_payment_submit))
        .route("/api/evm/payment/submit/", post(evm_payment_submit))
        .route("/api/evm/transaction/status", post(evm_transaction_status))
        .route("/api/evm/transaction/status/", post(evm_transaction_status))
        .route("/api/evm/dapp/preview", post(evm_dapp_preview))
        .route("/api/evm/dapp/preview/", post(evm_dapp_preview))
        .route("/api/evm/dapp/submit", post(evm_dapp_submit))
        .route("/api/evm/dapp/submit/", post(evm_dapp_submit))
        .route("/api/secure/session", get(secure_session))
        .route("/api/secure/session/", get(secure_session))
        // Core Functions (1-3)
        .route("/api/keys/create", post(create_key))
        .route("/api/keys/create/", post(create_key))
        .route("/api/keys/encrypt", post(encrypt_key))
        .route("/api/keys/encrypt/", post(encrypt_key))
        .route("/api/keys/create-encrypted", post(create_encrypted_key))
        .route("/api/keys/create-encrypted/", post(create_encrypted_key))
        .route("/api/keys/decrypt", post(decrypt_key))
        .route("/api/keys/decrypt/", post(decrypt_key))
        .route("/api/keys/create-keystore", post(create_keystore))
        .route("/api/keys/create-keystore/", post(create_keystore))
        .route(
            "/api/keys/create-mnemonic-keystore",
            post(create_mnemonic_keystore),
        )
        .route(
            "/api/keys/create-mnemonic-keystore/",
            post(create_mnemonic_keystore),
        )
        .route(
            "/api/keys/import-mnemonic-keystore",
            post(import_mnemonic_keystore),
        )
        .route(
            "/api/keys/import-mnemonic-keystore/",
            post(import_mnemonic_keystore),
        )
        .route("/api/keys/import-keystore", post(import_keystore))
        .route("/api/keys/import-keystore/", post(import_keystore))
        .route("/api/wallets", get(list_wallets).post(save_keystore_wallet))
        .route(
            "/api/wallets/",
            get(list_wallets).post(save_keystore_wallet),
        )
        .route(
            "/api/wallets/create-universal",
            post(create_universal_wallet),
        )
        .route(
            "/api/wallets/create-universal/",
            post(create_universal_wallet),
        )
        .route(
            "/api/wallets/{wallet_id}",
            patch(rename_wallet).delete(delete_wallet),
        )
        .route(
            "/api/wallets/{wallet_id}/",
            patch(rename_wallet).delete(delete_wallet),
        )
        .route("/api/wallets/{wallet_id}/delete", post(delete_wallet_post))
        .route("/api/wallets/{wallet_id}/delete/", post(delete_wallet_post))
        .route("/api/wallets/{wallet_id}/export", post(export_wallet))
        .route("/api/wallets/{wallet_id}/export/", post(export_wallet))
        .route(
            "/api/wallets/{wallet_id}/verify-password",
            post(verify_wallet_password),
        )
        .route(
            "/api/wallets/{wallet_id}/verify-password/",
            post(verify_wallet_password),
        )
        .route("/api/wallets/unlock-all", post(unlock_all_wallets))
        .route("/api/wallets/unlock-all/", post(unlock_all_wallets))
        .route(
            "/api/wallets/{wallet_id}/session",
            get(wallet_session_status).delete(lock_wallet_session),
        )
        .route(
            "/api/wallets/{wallet_id}/session/",
            get(wallet_session_status).delete(lock_wallet_session),
        )
        .route(
            "/api/wallets/{wallet_id}/multichain-accounts",
            get(wallet_multichain_accounts),
        )
        .route(
            "/api/wallets/{wallet_id}/multichain-accounts/",
            get(wallet_multichain_accounts),
        )
        .route(
            "/api/wallets/{wallet_id}/bitcoin/balance",
            post(bitcoin_wallet_balance),
        )
        .route(
            "/api/wallets/{wallet_id}/bitcoin/send/preview",
            post(bitcoin_send_preview),
        )
        .route(
            "/api/wallets/{wallet_id}/bitcoin/send/submit",
            post(bitcoin_send_submit),
        )
        .route(
            "/api/wallets/{wallet_id}/tron/account",
            post(tron_wallet_account),
        )
        .route(
            "/api/wallets/{wallet_id}/tron/send/preview",
            post(tron_send_preview),
        )
        .route(
            "/api/wallets/{wallet_id}/tron/send/submit",
            post(tron_send_submit),
        )
        .route(
            "/api/wallet/session/lock-all",
            post(lock_all_wallet_sessions),
        )
        .route(
            "/api/wallet/session/lock-all/",
            post(lock_all_wallet_sessions),
        )
        .route(
            "/api/wallets/{wallet_id}/change-password",
            post(change_wallet_password),
        )
        .route(
            "/api/wallets/{wallet_id}/change-password/",
            post(change_wallet_password),
        )
        .route(
            "/api/wallets/{wallet_id}/adopt-unified-password",
            post(adopt_unified_wallet_password),
        )
        .route(
            "/api/wallets/{wallet_id}/migrate-keystore",
            post(migrate_wallet_keystore),
        )
        .route(
            "/api/wallets/{wallet_id}/migrate-keystore/",
            post(migrate_wallet_keystore),
        )
        .route(
            "/api/wallets/{wallet_id}/export-private-key",
            post(export_wallet_private_key),
        )
        .route(
            "/api/wallets/{wallet_id}/export-private-key/",
            post(export_wallet_private_key),
        )
        .route(
            "/api/wallets/{wallet_id}/export-mnemonic",
            post(export_wallet_mnemonic),
        )
        .route(
            "/api/wallets/{wallet_id}/export-mnemonic/",
            post(export_wallet_mnemonic),
        )
        .route(
            "/api/wallets/{wallet_id}/evm-keystore",
            post(unlock_saved_evm_wallet),
        )
        .route(
            "/api/wallets/{wallet_id}/evm-keystore/",
            post(unlock_saved_evm_wallet),
        )
        // Wallet Management (U, 7)
        .route("/api/wallet/balance", post(get_balance))
        .route("/api/wallet/balance/", post(get_balance))
        .route("/api/wallet/assets", post(get_assets))
        .route("/api/wallet/assets/", post(get_assets))
        .route("/api/wallet/transactions", post(get_wallet_transactions))
        .route("/api/wallet/transactions/", post(get_wallet_transactions))
        .route("/api/wallet/unlock", post(unlock_wallet))
        .route("/api/wallet/unlock/", post(unlock_wallet))
        .route("/api/wallet/get-pubkey", post(get_pubkey))
        .route("/api/wallet/get-pubkey/", post(get_pubkey))
        // SOL Operations (8)
        .route("/api/transfer/sol", post(transfer_sol))
        .route("/api/transfer/sol/", post(transfer_sol))
        // WSOL Operations (9-12)
        .route("/api/wsol/create-ata", post(create_wsol_ata))
        .route("/api/wsol/create-ata/", post(create_wsol_ata))
        .route("/api/wsol/wrap", post(wrap_sol))
        .route("/api/wsol/wrap/", post(wrap_sol))
        .route("/api/wsol/unwrap", post(unwrap_sol))
        .route("/api/wsol/unwrap/", post(unwrap_sol))
        .route("/api/wsol/close-ata", post(close_wsol_ata))
        .route("/api/wsol/close-ata/", post(close_wsol_ata))
        // 2FA Operations (4-6)
        .route("/api/2fa/setup", post(setup_2fa))
        .route("/api/2fa/setup/", post(setup_2fa))
        .route("/api/2fa/create-tfa", post(create_triple_factor_wallet))
        .route("/api/2fa/create-tfa/", post(create_triple_factor_wallet))
        .route("/api/2fa/unlock-tfa", post(unlock_triple_factor_wallet))
        .route("/api/2fa/unlock-tfa/", post(unlock_triple_factor_wallet))
        // Pump.fun Operations (15-18)
        .route("/api/pumpfun/sell", post(pumpfun_sell))
        .route("/api/pumpfun/sell/", post(pumpfun_sell))
        .route("/api/pumpfun/cashback-info", post(pumpfun_cashback_info))
        .route("/api/pumpfun/cashback-info/", post(pumpfun_cashback_info))
        .route("/api/pumpfun/cashback", post(pumpfun_cashback))
        .route("/api/pumpfun/cashback/", post(pumpfun_cashback))
        .route("/api/pumpswap/sell", post(pumpswap_sell))
        .route("/api/pumpswap/sell/", post(pumpswap_sell))
        .route("/api/automation/token/sell", post(automated_token_sell))
        .route("/api/automation/token/sell/", post(automated_token_sell))
        .route("/api/pumpswap/cashback-info", post(pumpswap_cashback_info))
        .route("/api/pumpswap/cashback-info/", post(pumpswap_cashback_info))
        .route("/api/pumpswap/cashback", post(pumpswap_cashback))
        .route("/api/pumpswap/cashback/", post(pumpswap_cashback))
        // Token Operations (13)
        .route("/api/token/mint-info", post(token_mint_info))
        .route("/api/token/mint-info/", post(token_mint_info))
        .route("/api/transfer/token", post(transfer_token))
        .route("/api/transfer/token/", post(transfer_token))
        // Nonce Operations (14)
        .route("/api/nonce/create", post(create_nonce_account))
        .route("/api/nonce/create/", post(create_nonce_account))
        .route("/api/nonce/list", post(list_nonce_accounts))
        .route("/api/nonce/list/", post(list_nonce_accounts))
        // Program Deployment
        .route("/api/program/deploy", post(deploy_generic_program))
        .route("/api/program/deploy/", post(deploy_generic_program))
        .route("/api/program/upgrade", post(upgrade_generic_program))
        .route("/api/program/upgrade/", post(upgrade_generic_program))
        .route(
            "/api/program/upgrade/progress",
            get(program_upgrade_progress),
        )
        .route(
            "/api/program/upgrade/progress/",
            get(program_upgrade_progress),
        )
        .route("/api/program/deploy-source", post(program_deploy_source))
        .route("/api/program/deploy-source/", post(program_deploy_source))
        .route(
            "/api/program/keypair-artifact",
            post(program_keypair_artifact),
        )
        .route(
            "/api/program/keypair-artifact/",
            post(program_keypair_artifact),
        )
        .route(
            "/api/program/generate-keypair",
            post(program_generate_keypair),
        )
        .route(
            "/api/program/generate-keypair/",
            post(program_generate_keypair),
        )
        .route(
            "/api/program/deploy-source/build/{job_id}",
            get(program_deploy_source_build_status),
        )
        .route(
            "/api/program/deploy-source/build/{job_id}/",
            get(program_deploy_source_build_status),
        )
        .route(
            "/api/program/deployment-journal",
            post(program_deployment_journal),
        )
        .route(
            "/api/program/deployment-journal/",
            post(program_deployment_journal),
        )
        .route(
            "/api/program/deployment-journal/by-program",
            post(program_deployment_journal_by_program),
        )
        .route(
            "/api/program/deployment-journal/by-program/",
            post(program_deployment_journal_by_program),
        )
        .route("/api/program/idl", post(program_idl))
        .route("/api/program/idl/", post(program_idl))
        .route("/api/program/invoke", post(program_invoke))
        .route("/api/program/invoke/", post(program_invoke))
        .route("/api/external-sign/sign", post(external_sign_sign))
        .route("/api/external-sign/sign/", post(external_sign_sign))
        .route("/api/external-sign/preview", post(external_sign_preview))
        .route("/api/external-sign/preview/", post(external_sign_preview))
        .route("/api/external-sign/message", post(external_sign_message))
        .route("/api/external-sign/message/", post(external_sign_message))
        .route("/api/external-sign/submit", post(external_sign_submit))
        .route("/api/external-sign/submit/", post(external_sign_submit))
        .route("/api/program/info", post(program_info))
        .route("/api/program/info/", post(program_info))
        .route("/api/program/derive-address", post(program_derive_address))
        .route("/api/program/derive-address/", post(program_derive_address))
        // Squads v4 multisig
        .route("/api/squads/create", post(squads_create))
        .route("/api/squads/create/", post(squads_create))
        .route("/api/squads/info", post(squads_info))
        .route("/api/squads/info/", post(squads_info))
        .route("/api/squads/proposals", post(squads_proposals))
        .route("/api/squads/proposals/", post(squads_proposals))
        .route(
            "/api/squads/proposal/sol-transfer",
            post(squads_sol_transfer_proposal),
        )
        .route(
            "/api/squads/proposal/sol-transfer/",
            post(squads_sol_transfer_proposal),
        )
        .route(
            "/api/squads/proposal/token-transfer",
            post(squads_token_transfer_proposal),
        )
        .route(
            "/api/squads/proposal/token-transfer/",
            post(squads_token_transfer_proposal),
        )
        .route(
            "/api/squads/program/prepare-upgrade-buffer",
            post(squads_prepare_upgrade_buffer),
        )
        .route(
            "/api/squads/program/prepare-upgrade-buffer/",
            post(squads_prepare_upgrade_buffer),
        )
        .route(
            "/api/squads/proposal/program-upgrade",
            post(squads_program_upgrade_proposal),
        )
        .route(
            "/api/squads/proposal/program-upgrade/",
            post(squads_program_upgrade_proposal),
        )
        .route(
            "/api/squads/proposal/approve",
            post(squads_proposal_approve),
        )
        .route(
            "/api/squads/proposal/approve/",
            post(squads_proposal_approve),
        )
        .route("/api/squads/proposal/reject", post(squads_proposal_reject))
        .route("/api/squads/proposal/reject/", post(squads_proposal_reject))
        .route(
            "/api/squads/proposal/execute",
            post(squads_proposal_execute),
        )
        .route(
            "/api/squads/proposal/execute/",
            post(squads_proposal_execute),
        )
        .route(
            "/api/squads/program/set-authority",
            post(squads_set_program_authority),
        )
        .route(
            "/api/squads/program/set-authority/",
            post(squads_set_program_authority),
        )
        .route_layer(middleware::from_fn(decrypt_secure_body))
        .route_layer(middleware::from_fn(require_api_token))
        .route_layer(middleware::from_fn(require_local_origin))
        .layer(DefaultBodyLimit::max(MAX_SECURE_ENVELOPE_BYTES))
        .layer(middleware::from_fn(add_security_headers))
        .layer(middleware::from_fn(catch_panics))
        .fallback(serve_assets);

    const DEFAULT_PORT: u16 = 3841;
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let host: IpAddr = host.parse()?;
    if !host.is_loopback() {
        anyhow::bail!(
            "FnzSafe API contains local-only wallet operations and must bind to a loopback address"
        );
    }
    let addr = SocketAddr::new(host, port);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("Server listening on http://{}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "service": "fnzero-safe",
        "version": env!("CARGO_PKG_VERSION"),
        "features": ["keys", "wallet", "faucet", "transfer", "wsol", "token", "nonce", "program", "squads-v4", "evm", "chain-catalog", "bitcoin-accounts", "tron-accounts"]
    }))
}

async fn secure_session() -> Result<Json<SecureSessionResponse>, ApiError> {
    // This key prevents sensitive JSON from appearing as plaintext in DevTools/request logs.
    // It is not an authentication boundary for JavaScript already running in this origin.
    Ok(Json(SecureSessionResponse {
        version: SECURE_BODY_VERSION,
        algorithm: "RSA-OAEP-256+A256GCM",
        public_key_pem: secure_body_keypair().public_key_pem.clone(),
    }))
}

#[cfg(test)]
mod password_security_tests {
    use super::*;

    #[test]
    fn password_attempt_backoff_is_bounded_and_exponential() {
        for failures in 0..=PASSWORD_ATTEMPT_FREE_FAILURES {
            assert_eq!(password_attempt_delay(failures), None);
        }
        assert_eq!(password_attempt_delay(4), Some(Duration::from_secs(1)));
        assert_eq!(password_attempt_delay(5), Some(Duration::from_secs(2)));
        assert_eq!(password_attempt_delay(9), Some(Duration::from_secs(32)));
        assert_eq!(password_attempt_delay(10), Some(PASSWORD_ATTEMPT_MAX_DELAY));
        assert_eq!(
            password_attempt_delay(u32::MAX),
            Some(PASSWORD_ATTEMPT_MAX_DELAY)
        );
    }

    #[test]
    fn wallet_passwords_have_a_bounded_utf8_byte_length() {
        assert!(validate_password(&"a".repeat(MAX_PASSWORD_BYTES), "密码").is_ok());
        assert!(validate_password(&"a".repeat(MAX_PASSWORD_BYTES + 1), "密码").is_err());
        assert!(validate_password(&"密".repeat(MAX_PASSWORD_BYTES / 3), "密码").is_ok());
        assert!(validate_password(&"密".repeat(MAX_PASSWORD_BYTES / 3 + 1), "密码").is_err());
    }

    #[test]
    fn password_attempt_backoff_errors_use_http_429() {
        let error = ApiError {
            message: "密码尝试过于频繁，请在 4 秒后重试".to_string(),
        };
        assert_eq!(error.status_code(), StatusCode::TOO_MANY_REQUESTS);
        let wrong_password = ApiError {
            message: "钱包密码错误".to_string(),
        };
        assert_eq!(wrong_password.status_code(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn secure_session_never_serializes_the_api_token() {
        let response = secure_session().await.unwrap().0;
        let value = serde_json::to_value(response).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert!(object.contains_key("version"));
        assert!(object.contains_key("algorithm"));
        assert!(object.contains_key("public_key_pem"));
        assert!(!object.contains_key("api_token"));
        assert!(!value.to_string().contains("api_token"));
    }
}

async fn evm_chains() -> Json<Vec<app_services::EvmChainConfig>> {
    Json(app_services::evm_builtin_chains())
}

async fn multichain_chains() -> Result<Json<Vec<app_services::MultiChainDescriptor>>, ApiError> {
    app_services::multichain_catalog()
        .map(Json)
        .map_err(api_error_from_app_service)
}

async fn multichain_normalize_address(
    Json(request): Json<app_services::MultiChainNormalizeAddressRequest>,
) -> Result<Json<app_services::MultiChainNormalizedAddress>, ApiError> {
    run_app_service_task(move || app_services::multichain_normalize_address(request))
        .await
        .map(Json)
}

async fn multichain_derive_account(
    Json(request): Json<app_services::MultiChainDeriveAccountRequest>,
) -> Result<Json<app_services::MultiChainDerivedAccount>, ApiError> {
    run_app_service_task(move || app_services::multichain_derive_account(request))
        .await
        .map(Json)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct WalletMultichainAccount {
    chain_id: String,
    family: String,
    chain_name: String,
    network: String,
    symbol: String,
    address: String,
    derivation_path: String,
    testnet: bool,
}

#[derive(Serialize)]
struct WalletMultichainAccountsResponse {
    accounts: Vec<WalletMultichainAccount>,
    mnemonic_backed: bool,
}

fn derive_wallet_multichain_accounts(
    mnemonic: &str,
) -> Result<Vec<WalletMultichainAccount>, ApiError> {
    let descriptors = app_services::multichain_catalog().map_err(api_error_from_app_service)?;
    descriptors
        .into_iter()
        .filter(|descriptor| {
            !descriptor.testnet && matches!(descriptor.family.as_str(), "bitcoin" | "tron")
        })
        .map(|descriptor| {
            let account = app_services::multichain_derive_account(
                app_services::MultiChainDeriveAccountRequest {
                    chain_id: descriptor.chain_id.to_string(),
                    mnemonic: mnemonic.to_string(),
                    derivation_path: None,
                },
            )
            .map_err(api_error_from_app_service)?;
            Ok(WalletMultichainAccount {
                chain_id: descriptor.chain_id.to_string(),
                family: descriptor.family.to_string(),
                chain_name: descriptor.name,
                network: descriptor.network,
                symbol: descriptor.native_asset.symbol,
                address: account.address,
                derivation_path: account.derivation_path,
                testnet: descriptor.testnet,
            })
        })
        .collect()
}

async fn wallet_multichain_accounts(
    Path(wallet_id): Path<String>,
) -> Result<Json<WalletMultichainAccountsResponse>, ApiError> {
    validate_wallet_id(&wallet_id)?;
    let wallet = wallet_store::find(&wallet_id).map_err(|message| ApiError { message })?;
    let secrets = wallet_session_vault()
        .decrypt(&wallet_id, &wallet.public_key)
        .map_err(|message| ApiError { message })?;
    let Some(value) = secrets.mnemonic() else {
        return Ok(Json(WalletMultichainAccountsResponse {
            accounts: Vec::new(),
            mnemonic_backed: false,
        }));
    };
    let mnemonic = Zeroizing::new(value.to_string());
    drop(secrets);
    let accounts = run_keystore_task(move || derive_wallet_multichain_accounts(&mnemonic)).await?;
    Ok(Json(WalletMultichainAccountsResponse {
        accounts,
        mnemonic_backed: true,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeChainAccountRequest {
    chain_id: String,
    address: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeChainSendRequest {
    chain_id: String,
    sender: String,
    recipient: String,
    amount_atomic: String,
    #[serde(default)]
    fee_rate_sat_vb: Option<f64>,
}

fn parse_atomic_amount(value: &str, symbol: &str) -> Result<u64, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ApiError {
            message: format!("{symbol} amount must be a positive integer in atomic units"),
        });
    }
    let amount = value.parse::<u64>().map_err(|_| ApiError {
        message: format!("{symbol} amount is outside the supported range"),
    })?;
    if amount == 0 {
        return Err(ApiError {
            message: format!("{symbol} amount must be greater than zero"),
        });
    }
    Ok(amount)
}

fn session_mnemonic(wallet_id: &str) -> Result<Zeroizing<String>, ApiError> {
    validate_wallet_id(wallet_id)?;
    let wallet = wallet_store::find(wallet_id).map_err(|message| ApiError { message })?;
    let secrets = wallet_session_vault()
        .decrypt(wallet_id, &wallet.public_key)
        .map_err(|message| ApiError { message })?;
    let mnemonic = secrets.mnemonic().ok_or_else(|| ApiError {
        message: "This wallet was not created from a mnemonic, so Bitcoin and TRON signing are unavailable"
            .to_string(),
    })?;
    Ok(Zeroizing::new(mnemonic.to_string()))
}

fn map_bitcoin_error(error: fnzero_safe_bitcoin_services::BitcoinServiceError) -> ApiError {
    ApiError {
        message: error.to_string(),
    }
}

fn map_tron_error(error: fnzero_safe_tron_services::TronServiceError) -> ApiError {
    ApiError {
        message: error.to_string(),
    }
}

fn verify_bitcoin_session_address(
    mnemonic: &str,
    chain_id: &str,
    claimed_address: &str,
) -> Result<(), ApiError> {
    let private_key = fnzero_safe_bitcoin_services::private_key_from_mnemonic(mnemonic, chain_id)
        .map_err(map_bitcoin_error)?;
    let expected =
        fnzero_safe_bitcoin_services::address_from_private_key(private_key.as_ref(), chain_id)
            .map_err(map_bitcoin_error)?;
    if expected != claimed_address.trim() {
        return Err(ApiError {
            message: "The selected Bitcoin address does not belong to this wallet".to_string(),
        });
    }
    Ok(())
}

fn verify_tron_session_address(mnemonic: &str, claimed_address: &str) -> Result<(), ApiError> {
    let private_key =
        fnzero_safe_tron_services::private_key_from_mnemonic(mnemonic).map_err(map_tron_error)?;
    let expected = fnzero_safe_tron_services::address_from_private_key(private_key.as_ref())
        .map_err(|error| ApiError {
            message: error.to_string(),
        })?;
    if expected != claimed_address.trim() {
        return Err(ApiError {
            message: "The selected TRON address does not belong to this wallet".to_string(),
        });
    }
    Ok(())
}

async fn bitcoin_wallet_balance(
    Path(wallet_id): Path<String>,
    Json(request): Json<NativeChainAccountRequest>,
) -> Result<Json<Value>, ApiError> {
    let mnemonic = session_mnemonic(&wallet_id)?;
    verify_bitcoin_session_address(&mnemonic, &request.chain_id, &request.address)?;
    let balance = fnzero_safe_bitcoin_services::fetch_balance(&request.chain_id, &request.address)
        .await
        .map_err(map_bitcoin_error)?;
    Ok(Json(json!({
        "chain_id": request.chain_id,
        "address": balance.address,
        "symbol": "BTC",
        "decimals": 8,
        "balance_atomic": balance.confirmed_sats.to_string(),
        "pending_atomic": balance.unconfirmed_sats.to_string(),
    })))
}

async fn bitcoin_send_preview(
    Path(wallet_id): Path<String>,
    Json(request): Json<NativeChainSendRequest>,
) -> Result<Json<Value>, ApiError> {
    if request.fee_rate_sat_vb.is_some() {
        return Err(ApiError {
            message: "Bitcoin preview does not accept a client-provided fee rate".to_string(),
        });
    }
    let mnemonic = session_mnemonic(&wallet_id)?;
    verify_bitcoin_session_address(&mnemonic, &request.chain_id, &request.sender)?;
    let amount_sats = parse_atomic_amount(&request.amount_atomic, "BTC")?;
    let preview = fnzero_safe_bitcoin_services::preview_transfer(
        &request.chain_id,
        &request.sender,
        &request.recipient,
        amount_sats,
    )
    .await
    .map_err(map_bitcoin_error)?;
    Ok(Json(json!({
        "chain_id": request.chain_id,
        "family": "bitcoin",
        "sender": preview.sender,
        "recipient": preview.recipient,
        "amount_atomic": preview.amount_sats.to_string(),
        "fee_atomic": preview.fee_sats.to_string(),
        "fee_rate_sat_vb": preview.fee_rate_sat_vb,
        "total_input_atomic": preview.total_input_sats.to_string(),
        "change_atomic": preview.change_sats.to_string(),
        "input_count": preview.input_count,
        "output_count": preview.output_count,
        "rbf": preview.rbf,
        "psbt_base64": preview.psbt_base64,
    })))
}

async fn bitcoin_send_submit(
    Path(wallet_id): Path<String>,
    Json(request): Json<NativeChainSendRequest>,
) -> Result<Json<Value>, ApiError> {
    let fee_rate = request.fee_rate_sat_vb.ok_or_else(|| ApiError {
        message: "Bitcoin submit requires the fee rate shown in the preview".to_string(),
    })?;
    let mnemonic = session_mnemonic(&wallet_id)?;
    verify_bitcoin_session_address(&mnemonic, &request.chain_id, &request.sender)?;
    let amount_sats = parse_atomic_amount(&request.amount_atomic, "BTC")?;
    let result = fnzero_safe_bitcoin_services::submit_transfer(
        &request.chain_id,
        &mnemonic,
        &request.sender,
        &request.recipient,
        amount_sats,
        fee_rate,
    )
    .await
    .map_err(map_bitcoin_error)?;
    Ok(Json(json!({
        "chain_id": request.chain_id,
        "status": "submitted",
        "transaction_id": result.txid,
    })))
}

async fn tron_wallet_account(
    Path(wallet_id): Path<String>,
    Json(request): Json<NativeChainAccountRequest>,
) -> Result<Json<Value>, ApiError> {
    let mnemonic = session_mnemonic(&wallet_id)?;
    verify_tron_session_address(&mnemonic, &request.address)?;
    let account = fnzero_safe_tron_services::fetch_account(&request.chain_id, &request.address)
        .await
        .map_err(map_tron_error)?;
    Ok(Json(json!({
        "chain_id": request.chain_id,
        "address": account.address,
        "symbol": "TRX",
        "decimals": 6,
        "balance_atomic": account.balance_sun.to_string(),
        "bandwidth_available": account.bandwidth_available.to_string(),
        "energy_available": account.energy_available.to_string(),
    })))
}

async fn tron_send_preview(
    Path(wallet_id): Path<String>,
    Json(request): Json<NativeChainSendRequest>,
) -> Result<Json<Value>, ApiError> {
    if request.fee_rate_sat_vb.is_some() {
        return Err(ApiError {
            message: "TRON preview does not accept Bitcoin fee fields".to_string(),
        });
    }
    let mnemonic = session_mnemonic(&wallet_id)?;
    verify_tron_session_address(&mnemonic, &request.sender)?;
    let amount_sun = parse_atomic_amount(&request.amount_atomic, "TRX")?;
    let preview = fnzero_safe_tron_services::preview_transfer(
        &request.chain_id,
        &request.sender,
        &request.recipient,
        amount_sun,
    )
    .await
    .map_err(map_tron_error)?;
    Ok(Json(json!({
        "chain_id": request.chain_id,
        "family": "tron",
        "sender": preview.sender,
        "recipient": preview.recipient,
        "amount_atomic": preview.amount_sun.to_string(),
        "fee_atomic": preview.estimated_max_fee_sun.to_string(),
        "transaction_id": preview.txid,
        "expiration_ms": preview.expiration_ms.to_string(),
        "estimated_bandwidth_bytes": preview.estimated_bandwidth_bytes.to_string(),
        "bandwidth_available": preview.bandwidth_available.to_string(),
        "bandwidth_price_sun": preview.bandwidth_price_sun.to_string(),
        "recipient_activated": preview.recipient_activated,
        "account_activation_fee_atomic": preview.account_activation_fee_sun.to_string(),
    })))
}

async fn tron_send_submit(
    Path(wallet_id): Path<String>,
    Json(request): Json<NativeChainSendRequest>,
) -> Result<Json<Value>, ApiError> {
    if request.fee_rate_sat_vb.is_some() {
        return Err(ApiError {
            message: "TRON submit does not accept Bitcoin fee fields".to_string(),
        });
    }
    let mnemonic = session_mnemonic(&wallet_id)?;
    verify_tron_session_address(&mnemonic, &request.sender)?;
    let amount_sun = parse_atomic_amount(&request.amount_atomic, "TRX")?;
    let result = fnzero_safe_tron_services::submit_transfer(
        &request.chain_id,
        &mnemonic,
        &request.sender,
        &request.recipient,
        amount_sun,
    )
    .await
    .map_err(map_tron_error)?;
    Ok(Json(json!({
        "chain_id": request.chain_id,
        "status": "submitted",
        "transaction_id": result.txid,
    })))
}

#[cfg(test)]
mod multichain_api_tests {
    use super::*;

    const TEST_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[tokio::test]
    async fn health_and_catalog_advertise_the_same_multichain_surface() {
        let health = health().await.0;
        let features = health["features"].as_array().unwrap();
        for feature in ["chain-catalog", "bitcoin-accounts", "tron-accounts"] {
            assert!(features.iter().any(|value| value == feature));
        }

        let catalog = multichain_chains().await.unwrap().0;
        assert_eq!(catalog.len(), 24);
        for family in ["solana", "evm", "bitcoin", "tron"] {
            assert!(catalog.iter().any(|chain| chain.family.as_str() == family));
        }
    }

    #[test]
    fn mnemonic_wallet_accounts_include_bitcoin_and_tron_mainnets() {
        let accounts = derive_wallet_multichain_accounts(TEST_MNEMONIC).unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].family, "bitcoin");
        assert!(accounts[0].address.starts_with("bc1"));
        assert_eq!(accounts[1].family, "tron");
        assert!(accounts[1].address.starts_with('T'));
        assert!(accounts.iter().all(|account| !account.testnet));
    }

    #[tokio::test]
    async fn account_routes_reach_non_evm_adapters() {
        let derived = multichain_derive_account(Json(
            app_services::MultiChainDeriveAccountRequest {
                chain_id: "tron:728126428".to_string(),
                mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".to_string(),
                derivation_path: None,
            },
        ))
        .await
        .unwrap()
        .0;
        let normalized =
            multichain_normalize_address(Json(app_services::MultiChainNormalizeAddressRequest {
                chain_id: derived.chain_id.to_string(),
                address: derived.address.clone(),
            }))
            .await
            .unwrap()
            .0;

        assert_eq!(normalized.account_id, derived.account_id);

        let error =
            multichain_normalize_address(Json(app_services::MultiChainNormalizeAddressRequest {
                chain_id: "cosmos:cosmoshub-4".to_string(),
                address: "cosmos1example".to_string(),
            }))
            .await
            .unwrap_err();
        assert_eq!(error.status_code(), StatusCode::BAD_REQUEST);

        let error =
            multichain_normalize_address(Json(app_services::MultiChainNormalizeAddressRequest {
                chain_id: "not-a-caip2-id".to_string(),
                address: "unused".to_string(),
            }))
            .await
            .unwrap_err();
        assert_eq!(error.status_code(), StatusCode::BAD_REQUEST);
        assert!(error.message.starts_with("InvalidChainId:"));
    }
}

async fn run_app_service_task<T, F>(task: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, app_services::AppServiceError> + Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| ApiError {
            message: format!("App service task terminated unexpectedly: {error}"),
        })?
        .map_err(api_error_from_app_service)
}

fn include_evm_history_by_default() -> bool {
    true
}

#[derive(Deserialize)]
struct DesktopEvmAssetQueryRequest {
    chain: app_services::EvmChainConfig,
    wallet_address: String,
    tokens: Vec<app_services::EvmTokenQuery>,
    #[serde(default = "include_evm_history_by_default")]
    include_history: bool,
}

async fn evm_wallet_create(
    Json(req): Json<app_services::EvmCreateWalletRequest>,
) -> Result<Json<app_services::EvmWalletKeystore>, ApiError> {
    run_app_service_task(move || app_services::evm_wallet_create(req))
        .await
        .map(Json)
}

async fn evm_wallet_import_private_key(
    Json(req): Json<app_services::EvmImportPrivateKeyRequest>,
) -> Result<Json<app_services::EvmWalletKeystore>, ApiError> {
    run_app_service_task(move || app_services::evm_wallet_import_private_key(req))
        .await
        .map(Json)
}

async fn evm_wallet_import_mnemonic(
    Json(req): Json<app_services::EvmImportMnemonicRequest>,
) -> Result<Json<app_services::EvmWalletKeystore>, ApiError> {
    run_app_service_task(move || app_services::evm_wallet_import_mnemonic(req))
        .await
        .map(Json)
}

async fn evm_wallet_import_keystore(
    Json(req): Json<app_services::EvmImportKeystoreRequest>,
) -> Result<Json<app_services::EvmWalletKeystore>, ApiError> {
    run_app_service_task(move || app_services::evm_wallet_import_keystore(req))
        .await
        .map(Json)
}

async fn evm_wallet_unlock(
    Json(req): Json<app_services::EvmUnlockWalletRequest>,
) -> Result<Json<app_services::EvmWalletSummary>, ApiError> {
    run_app_service_task(move || app_services::evm_wallet_unlock(req))
        .await
        .map(Json)
}

async fn evm_wallet_export_private_key(
    Json(req): Json<app_services::EvmExportPrivateKeyRequest>,
) -> Result<Json<app_services::EvmExportPrivateKeyResponse>, ApiError> {
    run_app_service_task(move || app_services::evm_wallet_export_private_key(req))
        .await
        .map(Json)
}

async fn evm_assets(
    Json(req): Json<DesktopEvmAssetQueryRequest>,
) -> Result<Json<app_services::EvmAssetSnapshot>, ApiError> {
    let include_history = req.include_history;
    let service_request = app_services::EvmAssetQueryRequest {
        chain: req.chain,
        wallet_address: req.wallet_address,
        tokens: req.tokens,
    };
    let snapshot = tokio::task::spawn_blocking(move || {
        if include_history {
            app_services::evm_load_asset_snapshot(service_request)
        } else {
            app_services::evm_load_asset_balances_snapshot(service_request)
        }
    })
    .await
    .map_err(|error| ApiError {
        message: format!("EVM asset task terminated unexpectedly: {error}"),
    })?
    .map_err(api_error_from_app_service)?;
    Ok(Json(snapshot))
}

async fn evm_payment_preview(
    Json(req): Json<app_services::EvmPaymentPreviewRequest>,
) -> Result<Json<app_services::EvmPaymentPreview>, ApiError> {
    run_app_service_task(move || app_services::evm_payment_preview(req))
        .await
        .map(Json)
}

#[derive(Deserialize)]
struct DesktopEvmPaymentSubmitRequest {
    #[serde(default)]
    wallet_id: Option<String>,
    #[serde(flatten)]
    request: app_services::EvmPaymentSubmitRequest,
}

async fn evm_payment_submit(
    Json(mut req): Json<DesktopEvmPaymentSubmitRequest>,
) -> Result<Json<app_services::EvmTransactionSubmitResult>, ApiError> {
    let wallet_id = req
        .wallet_id
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(wallet_id) = wallet_id {
        let expected_evm_address = req.request.wallet_address.clone();
        req.request.keystore_json.zeroize();
        req.request.password.zeroize();
        return run_app_service_task(move || {
            app_services::evm_payment_submit_with_private_key_loader(req.request, move || {
                evm_private_key_from_saved_wallet_session(&wallet_id, &expected_evm_address)
                    .map_err(|error| error.message)
            })
        })
        .await
        .map(Json);
    }
    run_app_service_task(move || app_services::evm_payment_submit(req.request))
        .await
        .map(Json)
}

async fn evm_transaction_status(
    Json(req): Json<app_services::EvmTransactionStatusRequest>,
) -> Result<Json<app_services::EvmTransactionStatus>, ApiError> {
    run_app_service_task(move || app_services::evm_transaction_status(req))
        .await
        .map(Json)
}

async fn evm_dapp_preview(
    Json(req): Json<app_services::EvmDappSignPreviewRequest>,
) -> Result<Json<app_services::EvmDappSignPreview>, ApiError> {
    run_app_service_task(move || app_services::evm_dapp_sign_preview(req))
        .await
        .map(Json)
}

#[derive(Deserialize)]
struct DesktopEvmDappSubmitRequest {
    #[serde(default)]
    wallet_id: Option<String>,
    #[serde(flatten)]
    request: app_services::EvmDappSignSubmitRequest,
}

async fn evm_dapp_submit(
    Json(mut req): Json<DesktopEvmDappSubmitRequest>,
) -> Result<Json<app_services::EvmDappSignSubmitResult>, ApiError> {
    let wallet_id = req
        .wallet_id
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(wallet_id) = wallet_id {
        let expected_evm_address = req.request.wallet_address.clone();
        req.request.keystore_json.zeroize();
        req.request.password.zeroize();
        return run_app_service_task(move || {
            app_services::evm_dapp_sign_submit_with_private_key_loader(req.request, move || {
                evm_private_key_from_saved_wallet_session(&wallet_id, &expected_evm_address)
                    .map_err(|error| error.message)
            })
        })
        .await
        .map(Json);
    }
    run_app_service_task(move || app_services::evm_dapp_sign_submit(req.request))
        .await
        .map(Json)
}

fn api_error_from_app_service(error: app_services::AppServiceError) -> ApiError {
    let mobile = error.to_mobile_error();
    ApiError {
        message: format!("{:?}: {}", mobile.code, mobile.message),
    }
}

// ============= Helper Functions =============

struct RpcSelector {
    network: String,
    url: String,
}

fn normalize_network_name(network: &str) -> Result<&'static str, ApiError> {
    match network {
        "mainnet" => Ok("mainnet"),
        "devnet" => Ok("devnet"),
        "testnet" => Ok("testnet"),
        _ => Err(ApiError {
            message: format!("不支持的 Solana 网络标签: {network}"),
        }),
    }
}

fn default_rpc_url_for(network: &str) -> &'static str {
    match network {
        "devnet" => DEVNET_RPC_URL,
        "testnet" => TESTNET_RPC_URL,
        _ => DEFAULT_RPC_URL,
    }
}

fn is_valid_rpc_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://")) && url.len() <= 512
}

fn parse_rpc_selector(value: &str) -> Result<RpcSelector, ApiError> {
    if let Some(rest) = value.strip_prefix("rpc:") {
        let (network, encoded_url) = rest.split_once(':').ok_or_else(|| ApiError {
            message: "无效的 RPC 配置".to_string(),
        })?;
        let network = normalize_network_name(network)?.to_string();
        let decoded_url = urlencoding::decode(encoded_url)
            .map_err(|_| ApiError {
                message: "无效的 RPC URL".to_string(),
            })?
            .trim()
            .trim_end_matches('/')
            .to_string();
        if !is_valid_rpc_url(&decoded_url) {
            return Err(ApiError {
                message: "RPC URL 必须使用 http 或 https".to_string(),
            });
        }
        return Ok(RpcSelector {
            network,
            url: decoded_url,
        });
    }

    let network = normalize_network_name(value)?.to_string();
    Ok(RpcSelector {
        url: default_rpc_url_for(&network).to_string(),
        network,
    })
}

fn rpc_selector(network: Option<&str>) -> Result<RpcSelector, ApiError> {
    parse_rpc_selector(network.unwrap_or("mainnet"))
}

fn get_rpc_url(network: Option<&str>) -> Result<String, ApiError> {
    rpc_selector(network).map(|selector| selector.url)
}

// ============= Core Functions (1-3) =============

// 1. Create Plaintext Key
#[derive(Deserialize)]
struct CreateKeyRequest {
    #[serde(default)]
    name: Option<String>,
}
#[derive(Serialize)]
struct CreateKeyResponse {
    public_key: String,
    secret_key: String,
    name: String,
}

impl Drop for CreateKeyResponse {
    fn drop(&mut self) {
        self.secret_key.zeroize();
    }
}

async fn create_key(
    Json(req): Json<CreateKeyRequest>,
) -> Result<Json<CreateKeyResponse>, ApiError> {
    require_secret_export_enabled()?;
    let name = validate_optional_label(req.name, "名称")?.unwrap_or_else(|| "default".to_string());
    let keypair = KeyManager::generate_keypair();
    Ok(Json(CreateKeyResponse {
        public_key: keypair.pubkey().to_string(),
        secret_key: keypair.to_base58_string(),
        name,
    }))
}

// 2. Create Encrypted Key / Encrypt Key
#[derive(Deserialize)]
struct EncryptKeyRequest {
    secret_key: String,
    password: String,
}

impl Drop for EncryptKeyRequest {
    fn drop(&mut self) {
        self.secret_key.zeroize();
        self.password.zeroize();
    }
}
#[derive(Serialize)]
struct EncryptKeyResponse {
    encrypted_key: String,
}

#[derive(Deserialize)]
struct CreateEncryptedKeyRequest {
    password: String,
}

impl Drop for CreateEncryptedKeyRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}
#[derive(Serialize)]
struct CreateEncryptedKeyResponse {
    public_key: String,
    encrypted_key: String,
}

async fn encrypt_key(
    Json(req): Json<EncryptKeyRequest>,
) -> Result<Json<EncryptKeyResponse>, ApiError> {
    require_direct_secret_input_enabled()?;
    require_nonempty(req.secret_key.trim(), "私钥")?;
    validate_password(req.password.as_str(), "密码")?;
    let encrypted = KeyManager::encrypt_with_password(&req.secret_key, &req.password)
        .map_err(|e| ApiError { message: e })?;
    Ok(Json(EncryptKeyResponse {
        encrypted_key: encrypted,
    }))
}

async fn create_encrypted_key(
    Json(req): Json<CreateEncryptedKeyRequest>,
) -> Result<Json<CreateEncryptedKeyResponse>, ApiError> {
    validate_password(req.password.as_str(), "密码")?;
    let keypair = KeyManager::generate_keypair();
    let private_key = keypair.to_base58_string();
    let encrypted = KeyManager::encrypt_with_password(&private_key, &req.password)
        .map_err(|e| ApiError { message: e })?;
    Ok(Json(CreateEncryptedKeyResponse {
        public_key: keypair.pubkey().to_string(),
        encrypted_key: encrypted,
    }))
}

// 3. Decrypt Key
#[derive(Deserialize)]
struct DecryptKeyRequest {
    encrypted_key: String,
    password: String,
}

impl Drop for DecryptKeyRequest {
    fn drop(&mut self) {
        self.encrypted_key.zeroize();
        self.password.zeroize();
    }
}
#[derive(Serialize)]
struct DecryptKeyResponse {
    secret_key: String,
}

impl Drop for DecryptKeyResponse {
    fn drop(&mut self) {
        self.secret_key.zeroize();
    }
}

async fn decrypt_key(
    Json(req): Json<DecryptKeyRequest>,
) -> Result<Json<DecryptKeyResponse>, ApiError> {
    require_secret_export_enabled()?;
    require_nonempty(req.encrypted_key.trim(), "加密私钥")?;
    validate_password(req.password.as_str(), "密码")?;
    let decrypted = KeyManager::decrypt_with_password(&req.encrypted_key, &req.password)
        .map_err(|e| ApiError { message: e })?;
    Ok(Json(DecryptKeyResponse {
        secret_key: decrypted,
    }))
}

// Create Keystore
#[derive(Deserialize)]
struct CreateKeystoreRequest {
    password: String,
    #[serde(default)]
    name: Option<String>,
}

impl Drop for CreateKeystoreRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}
#[derive(Serialize)]
struct CreateKeystoreResponse {
    keystore_json: String,
    public_key: String,
}

#[derive(Deserialize)]
struct CreateMnemonicKeystoreRequest {
    password: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    derivation_path: Option<String>,
}

impl Drop for CreateMnemonicKeystoreRequest {
    fn drop(&mut self) {
        self.password.zeroize();
        if let Some(path) = &mut self.derivation_path {
            path.zeroize();
        }
    }
}

#[derive(Serialize)]
struct CreateMnemonicKeystoreResponse {
    keystore_json: String,
    public_key: String,
    mnemonic: String,
    derivation_path: String,
}

impl Drop for CreateMnemonicKeystoreResponse {
    fn drop(&mut self) {
        self.mnemonic.zeroize();
    }
}

#[derive(Deserialize)]
struct ImportMnemonicKeystoreRequest {
    mnemonic: String,
    password: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    derivation_path: Option<String>,
}

impl Drop for ImportMnemonicKeystoreRequest {
    fn drop(&mut self) {
        self.mnemonic.zeroize();
        self.password.zeroize();
        if let Some(path) = &mut self.derivation_path {
            path.zeroize();
        }
    }
}

#[derive(Serialize)]
struct ImportMnemonicKeystoreResponse {
    keystore_json: String,
    public_key: String,
    derivation_path: String,
}

async fn create_keystore(
    Json(mut req): Json<CreateKeystoreRequest>,
) -> Result<Json<CreateKeystoreResponse>, ApiError> {
    validate_password(req.password.as_str(), "密码")?;
    let name = validate_optional_label(req.name.take(), "钱包名称")?;
    let response = run_keystore_task(move || {
        let keypair = KeyManager::generate_keypair();
        let keystore_json = KeyManager::keypair_to_encrypted_json(&keypair, &req.password)
            .map_err(|message| ApiError { message })?;
        let keystore_json = with_keystore_metadata(&keystore_json, name.as_deref())?;
        Ok(CreateKeystoreResponse {
            keystore_json,
            public_key: keypair.pubkey().to_string(),
        })
    })
    .await?;
    Ok(Json(response))
}

async fn create_mnemonic_keystore(
    Json(mut req): Json<CreateMnemonicKeystoreRequest>,
) -> Result<Json<CreateMnemonicKeystoreResponse>, ApiError> {
    validate_password(req.password.as_str(), "密码")?;
    let name = validate_optional_label(req.name.take(), "钱包名称")?;
    let derivation_path_label = normalize_mnemonic_derivation_path(req.derivation_path.as_deref())?;
    let response = run_keystore_task(move || {
        let mnemonic = Mnemonic::generate_in(Language::English, 12)
            .map_err(|error| ApiError {
                message: format!("生成助记词失败: {error}"),
            })?
            .to_string();
        let keypair = keypair_from_mnemonic_phrase(&mnemonic, &derivation_path_label)?;
        let keystore_json = KeyManager::mnemonic_to_encrypted_json(
            &mnemonic,
            &derivation_path_label,
            &req.password,
        )
        .map_err(|message| ApiError { message })?;
        let keystore_json = with_keystore_metadata_extra(
            &keystore_json,
            name.as_deref(),
            None,
            Some(&derivation_path_label),
        )?;
        Ok(CreateMnemonicKeystoreResponse {
            keystore_json,
            public_key: keypair.pubkey().to_string(),
            mnemonic,
            derivation_path: derivation_path_label,
        })
    })
    .await?;
    Ok(Json(response))
}

async fn import_mnemonic_keystore(
    Json(mut req): Json<ImportMnemonicKeystoreRequest>,
) -> Result<Json<ImportMnemonicKeystoreResponse>, ApiError> {
    validate_password(req.password.as_str(), "密码")?;
    let name = validate_optional_label(req.name.take(), "钱包名称")?;
    let mnemonic = Zeroizing::new(normalize_mnemonic_phrase(&req.mnemonic)?);
    let derivation_path_label = normalize_mnemonic_derivation_path(req.derivation_path.as_deref())?;
    let response = run_keystore_task(move || {
        let keypair = keypair_from_mnemonic_phrase(&mnemonic, &derivation_path_label)?;
        let keystore_json = KeyManager::mnemonic_to_encrypted_json(
            &mnemonic,
            &derivation_path_label,
            &req.password,
        )
        .map_err(|message| ApiError { message })?;
        let keystore_json = with_keystore_metadata_extra(
            &keystore_json,
            name.as_deref(),
            None,
            Some(&derivation_path_label),
        )?;
        Ok(ImportMnemonicKeystoreResponse {
            keystore_json,
            public_key: keypair.pubkey().to_string(),
            derivation_path: derivation_path_label,
        })
    })
    .await?;
    Ok(Json(response))
}

// Import Keystore
#[derive(Deserialize)]
struct ImportKeystoreRequest {
    keystore_json: String,
    password: String,
}

impl Drop for ImportKeystoreRequest {
    fn drop(&mut self) {
        self.keystore_json.zeroize();
        self.password.zeroize();
    }
}
#[derive(Serialize)]
struct ImportKeystoreResponse {
    public_key: String,
    unlocked: bool,
}

async fn import_keystore(
    Json(req): Json<ImportKeystoreRequest>,
) -> Result<Json<ImportKeystoreResponse>, ApiError> {
    validate_keystore_size(&req.keystore_json)?;
    validate_password(req.password.as_str(), "密码")?;
    let response = run_keystore_task(move || {
        let keypair = KeyManager::keypair_from_encrypted_json(&req.keystore_json, &req.password)
            .map_err(|message| ApiError { message })?;
        Ok(ImportKeystoreResponse {
            public_key: keypair.pubkey().to_string(),
            unlocked: true,
        })
    })
    .await?;
    Ok(Json(response))
}

// Saved Wallets
#[derive(Deserialize)]
struct SaveKeystoreWalletRequest {
    keystore_json: String,
    password: String,
    #[serde(default)]
    name: Option<String>,
}

impl Drop for SaveKeystoreWalletRequest {
    fn drop(&mut self) {
        self.keystore_json.zeroize();
        self.password.zeroize();
    }
}
#[derive(Serialize)]
struct SaveKeystoreWalletResponse {
    wallet: WalletSummary,
}

#[derive(Deserialize)]
struct CreateUniversalWalletRequest {
    name: String,
    password: String,
}

impl Drop for CreateUniversalWalletRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Serialize)]
struct CreateUniversalWalletResponse {
    wallet: WalletSummary,
    evm_wallet: app_services::EvmWalletSummary,
    mnemonic: String,
}

impl Drop for CreateUniversalWalletResponse {
    fn drop(&mut self) {
        self.mnemonic.zeroize();
    }
}
#[derive(Serialize)]
struct ListWalletsResponse {
    wallets: Vec<WalletSummary>,
}
#[derive(Deserialize)]
struct RenameWalletRequest {
    name: String,
}
#[derive(Deserialize)]
struct ExportWalletRequest {
    password: String,
    #[serde(default)]
    secret_type: Option<ExportKeystoreSecretType>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExportKeystoreSecretType {
    PrivateKey,
    Mnemonic,
}

impl Drop for ExportWalletRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Deserialize)]
struct MigrateWalletKeystoreRequest {
    current_password: String,
    new_password: String,
}

#[derive(Deserialize)]
struct VerifyWalletPasswordRequest {
    password: String,
}

impl Drop for VerifyWalletPasswordRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

#[derive(Serialize)]
struct VerifyWalletPasswordResponse {
    verified: bool,
    public_key: String,
    session_expires_in_seconds: u64,
}

#[derive(Serialize)]
struct UnlockAllWalletsResponse {
    verified: bool,
    unlocked_wallets: usize,
    session_expires_in_seconds: u64,
}

#[derive(Serialize)]
struct WalletSessionStatusResponse {
    wallet_id: String,
    public_key: String,
    unlocked: bool,
    expires_in_seconds: u64,
}

#[derive(Serialize)]
struct LockWalletSessionResponse {
    status: &'static str,
    locked_sessions: usize,
}

#[derive(Deserialize)]
struct ChangeWalletPasswordRequest {
    current_password: String,
    new_password: String,
}

impl Drop for ChangeWalletPasswordRequest {
    fn drop(&mut self) {
        self.current_password.zeroize();
        self.new_password.zeroize();
    }
}

impl Drop for MigrateWalletKeystoreRequest {
    fn drop(&mut self) {
        self.current_password.zeroize();
        self.new_password.zeroize();
    }
}
#[derive(Serialize)]
struct ExportWalletResponse {
    keystore_json: String,
}
#[derive(Serialize)]
struct ExportWalletPrivateKeyResponse {
    private_key: String,
}
impl Drop for ExportWalletPrivateKeyResponse {
    fn drop(&mut self) {
        self.private_key.zeroize();
    }
}
#[derive(Serialize)]
struct ExportWalletMnemonicResponse {
    mnemonic: String,
}
impl Drop for ExportWalletMnemonicResponse {
    fn drop(&mut self) {
        self.mnemonic.zeroize();
    }
}

#[derive(Deserialize)]
struct UnlockSavedEvmWalletRequest {
    password: String,
}

impl Drop for UnlockSavedEvmWalletRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

async fn create_universal_wallet(
    Json(mut req): Json<CreateUniversalWalletRequest>,
) -> Result<Json<CreateUniversalWalletResponse>, ApiError> {
    let name =
        validate_optional_label(Some(req.name.clone()), "钱包名称")?.ok_or_else(|| ApiError {
            message: "钱包名称不能为空".to_string(),
        })?;
    validate_password(req.password.as_str(), "密码")?;
    let password = Zeroizing::new(std::mem::take(&mut req.password));
    let (response, wallet_id, public_key, session_secrets) = run_keystore_task(move || {
        require_unified_password_for_existing_wallets(&password, None)?;
        let solana_derivation_path_label = normalize_mnemonic_derivation_path(None)?;
        let mnemonic = Mnemonic::generate_in(Language::English, 12)
            .map_err(|error| ApiError {
                message: format!("生成助记词失败: {error}"),
            })?
            .to_string();
        let solana_keypair =
            keypair_from_mnemonic_phrase(&mnemonic, &solana_derivation_path_label)?;
        let solana_keystore_json = KeyManager::mnemonic_to_encrypted_json(
            &mnemonic,
            &solana_derivation_path_label,
            &password,
        )
        .map_err(|message| ApiError { message })?;
        let solana_keystore_json = with_keystore_metadata_extra(
            &solana_keystore_json,
            Some(&name),
            None,
            Some(&solana_derivation_path_label),
        )?;
        let evm =
            app_services::evm_wallet_import_mnemonic(app_services::EvmImportMnemonicRequest {
                name: name.clone(),
                mnemonic: mnemonic.clone(),
                derivation_path: None,
                password: password.to_string(),
            })
            .map_err(api_error_from_app_service)?;
        let (unlocked_evm, evm_private_key) =
            app_services::evm_wallet_unlock_private_key(app_services::EvmUnlockWalletRequest {
                keystore_json: evm.keystore_json.clone(),
                password: password.to_string(),
            })
            .map_err(api_error_from_app_service)?;
        if unlocked_evm.address != evm.wallet.address {
            return Err(ApiError {
                message: "新建钱包的 EVM 密钥地址校验失败".to_string(),
            });
        }
        let universal_keystore_json =
            with_universal_wallet_metadata(&solana_keystore_json, &evm.wallet, &evm.keystore_json)?;
        let wallet = wallet_store::upsert(
            universal_keystore_json,
            solana_keypair.pubkey().to_string(),
            Some(name),
        )
        .map_err(|message| ApiError { message })?;
        let wallet_id = wallet.id.clone();
        let public_key = wallet.public_key.clone();
        let keypair_bytes = Zeroizing::new(solana_keypair.to_bytes());
        let session_secrets = WalletSessionSecrets::new(
            keypair_bytes.as_ref(),
            Some(evm_private_key.as_slice()),
            Some(&mnemonic),
        )
        .map_err(|message| ApiError { message })?;
        Ok((
            CreateUniversalWalletResponse {
                wallet: wallet.into(),
                evm_wallet: evm.wallet,
                mnemonic,
            },
            wallet_id,
            public_key,
            session_secrets,
        ))
    })
    .await?;
    wallet_session_vault()
        .unlock(
            &wallet_id,
            &public_key,
            &session_secrets,
            WALLET_SESSION_IDLE_TTL,
            WALLET_SESSION_MAX_LIFETIME,
        )
        .map_err(|message| ApiError { message })?;
    Ok(Json(response))
}

async fn list_wallets() -> Result<Json<ListWalletsResponse>, ApiError> {
    let wallets = wallet_store::list_summaries().map_err(|message| ApiError { message })?;
    Ok(Json(ListWalletsResponse { wallets }))
}

async fn unlock_saved_evm_wallet(
    Path(wallet_id): Path<String>,
    Json(req): Json<UnlockSavedEvmWalletRequest>,
) -> Result<Json<app_services::EvmWalletKeystore>, ApiError> {
    validate_wallet_id(&wallet_id)?;
    validate_password(&req.password, "密码")?;
    let (_, wallet) = unlock_saved_wallet_for_session(&wallet_id, &req.password, "钱包")?;
    let evm_keystore_json = keystore_metadata_value(&wallet.keystore_json, "evm_keystore_json")
        .ok_or_else(|| ApiError {
            message: "这个钱包没有 EVM 派生账户".to_string(),
        })?;
    let evm_wallet = app_services::evm_wallet_unlock(app_services::EvmUnlockWalletRequest {
        keystore_json: evm_keystore_json.clone(),
        password: req.password.clone(),
    })
    .map_err(api_error_from_app_service)?;
    validate_universal_evm_identity(&wallet.keystore_json, &evm_wallet)?;
    Ok(Json(app_services::EvmWalletKeystore {
        wallet: evm_wallet,
        keystore_json: evm_keystore_json,
    }))
}

async fn save_keystore_wallet(
    Json(mut req): Json<SaveKeystoreWalletRequest>,
) -> Result<Json<SaveKeystoreWalletResponse>, ApiError> {
    validate_keystore_size(&req.keystore_json)?;
    validate_password(req.password.as_str(), "密码")?;
    let request_name = validate_optional_label(req.name.take(), "钱包名称")?;
    let name = if request_name.is_some() {
        request_name
    } else {
        validate_optional_label(keystore_metadata_name(&req.keystore_json), "钱包名称")?
    };
    let (response, wallet_id, public_key, session_secrets) = run_keystore_task(move || {
        let version =
            KeyManager::keystore_version(&req.keystore_json).map_err(|error| ApiError {
                message: format!("keystore 格式校验失败: {error}"),
            })?;
        let keypair = KeyManager::keypair_from_encrypted_json(&req.keystore_json, &req.password)
            .map_err(|error| ApiError {
                message: format!("keystore 校验失败: {error}"),
            })?;
        require_unified_password_for_existing_wallets(
            &req.password,
            Some(&keypair.pubkey().to_string()),
        )?;
        let keystore_json = if version == KeystoreVersion::LegacyV1 {
            let migrated = KeyManager::keypair_to_encrypted_json(&keypair, &req.password).map_err(
                |error| ApiError {
                    message: format!("Legacy keystore 校验成功，但自动迁移为 v2 失败: {error}"),
                },
            )?;
            preserve_keystore_metadata(&req.keystore_json, &migrated)?
        } else {
            req.keystore_json.clone()
        };
        let mut keystore_json = with_keystore_metadata(&keystore_json, name.as_deref())?;
        let mut evm_private_key = None;
        let session_mnemonic =
            verified_mnemonic_from_keystore_json(&keystore_json, &req.password, &keypair.pubkey())
                .map_err(|error| ApiError {
                    message: format!("助记词 keystore 解密失败: {}", error.message),
                })?;
        if let Some(existing_evm_keystore) =
            keystore_metadata_value(&keystore_json, "evm_keystore_json")
        {
            let (evm_wallet, private_key) =
                app_services::evm_wallet_unlock_private_key(app_services::EvmUnlockWalletRequest {
                    keystore_json: existing_evm_keystore,
                    password: req.password.clone(),
                })
                .map_err(api_error_from_app_service)?;
            if let Some(mnemonic) = session_mnemonic.as_deref() {
                validate_universal_evm_mnemonic_identity(&keystore_json, &evm_wallet, mnemonic)?;
            } else {
                validate_universal_evm_identity(&keystore_json, &evm_wallet)?;
            }
            evm_private_key = Some(private_key);
        } else if let Some(mnemonic) = session_mnemonic.as_deref() {
            let wallet_name = name
                .clone()
                .or_else(|| keystore_metadata_name(&keystore_json))
                .unwrap_or_else(|| "Wallet".to_string());
            let evm =
                app_services::evm_wallet_import_mnemonic(app_services::EvmImportMnemonicRequest {
                    name: wallet_name,
                    mnemonic: mnemonic.to_string(),
                    derivation_path: keystore_metadata_value(&keystore_json, "evm_derivation_path"),
                    password: req.password.clone(),
                })
                .map_err(api_error_from_app_service)?;
            let (unlocked_evm, private_key) =
                app_services::evm_wallet_unlock_private_key(app_services::EvmUnlockWalletRequest {
                    keystore_json: evm.keystore_json.clone(),
                    password: req.password.clone(),
                })
                .map_err(api_error_from_app_service)?;
            if unlocked_evm.address != evm.wallet.address {
                return Err(ApiError {
                    message: "助记词派生的 EVM 钱包地址校验失败".to_string(),
                });
            }
            keystore_json =
                with_universal_wallet_metadata(&keystore_json, &evm.wallet, &evm.keystore_json)?;
            evm_private_key = Some(private_key);
        }
        let wallet = wallet_store::upsert(keystore_json, keypair.pubkey().to_string(), name)
            .map_err(|message| ApiError { message })?;
        let wallet_id = wallet.id.clone();
        let public_key = wallet.public_key.clone();
        let keypair_bytes = Zeroizing::new(keypair.to_bytes());
        let session_secrets = WalletSessionSecrets::new(
            keypair_bytes.as_ref(),
            evm_private_key.as_ref().map(|key| key.as_slice()),
            session_mnemonic.as_deref().map(String::as_str),
        )
        .map_err(|message| ApiError { message })?;
        Ok((
            SaveKeystoreWalletResponse {
                wallet: wallet.into(),
            },
            wallet_id,
            public_key,
            session_secrets,
        ))
    })
    .await?;
    wallet_session_vault()
        .unlock(
            &wallet_id,
            &public_key,
            &session_secrets,
            WALLET_SESSION_IDLE_TTL,
            WALLET_SESSION_MAX_LIFETIME,
        )
        .map_err(|message| ApiError { message })?;
    Ok(Json(response))
}

async fn rename_wallet(
    Path(wallet_id): Path<String>,
    Json(req): Json<RenameWalletRequest>,
) -> Result<Json<SaveKeystoreWalletResponse>, ApiError> {
    validate_wallet_id(&wallet_id)?;
    validate_text_len(req.name.trim(), "钱包名称", MAX_LABEL_CHARS)?;
    let name = req.name.trim();
    if name.is_empty() {
        return Err(ApiError {
            message: "钱包名称不能为空".to_string(),
        });
    }
    let stored = wallet_store::find(&wallet_id).map_err(|message| ApiError { message })?;
    let keystore_json = with_keystore_metadata(&stored.keystore_json, Some(name))?;
    let wallet = wallet_store::update_metadata(&wallet_id, name, keystore_json)
        .map_err(|message| ApiError { message })?;
    Ok(Json(SaveKeystoreWalletResponse {
        wallet: wallet.into(),
    }))
}

async fn delete_wallet(
    Path(_wallet_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    Err(ApiError {
        message: "DELETE 请求不再用于钱包删除；请使用 POST /api/wallets/{wallet_id}/delete"
            .to_string(),
    })
}

async fn delete_wallet_post(
    Path(wallet_id): Path<String>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !req.as_object().is_some_and(|body| body.is_empty()) {
        return Err(ApiError {
            message: "删除钱包请求体必须为空对象".to_string(),
        });
    }

    validate_wallet_id(&wallet_id)?;
    wallet_session_vault()
        .lock(&wallet_id)
        .map_err(|message| ApiError { message })?;
    wallet_store::delete(&wallet_id).map_err(|message| ApiError { message })?;
    Ok(Json(json!({ "status": "success" })))
}

fn export_private_key_keystore(
    wallet: &wallet_store::SavedWallet,
    keypair: &Keypair,
    password: &str,
) -> Result<String, ApiError> {
    let base = KeyManager::keypair_to_encrypted_json(keypair, password)
        .map_err(|message| ApiError { message })?;
    let mut converted = preserve_keystore_metadata(&wallet.keystore_json, &base)?;
    let mut document: Value = serde_json::from_str(&converted).map_err(|error| ApiError {
        message: format!("导出的私钥 Keystore 格式无效: {error}"),
    })?;
    let metadata = document
        .as_object_mut()
        .and_then(|object| object.get_mut("metadata"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| ApiError {
            message: "导出的私钥 Keystore 缺少 metadata".to_string(),
        })?;

    metadata.remove("encrypted_mnemonic");
    metadata.remove("mnemonic_derivation_path");

    if let Some(evm_keystore_json) = metadata
        .get("evm_keystore_json")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    {
        let existing_evm = app_services::evm_wallet_unlock(app_services::EvmUnlockWalletRequest {
            keystore_json: evm_keystore_json.clone(),
            password: password.to_string(),
        })
        .map_err(api_error_from_app_service)?;
        validate_universal_evm_identity(&wallet.keystore_json, &existing_evm)?;
        let exported =
            app_services::evm_wallet_export_private_key(app_services::EvmExportPrivateKeyRequest {
                keystore_json: evm_keystore_json,
                password: password.to_string(),
            })
            .map_err(api_error_from_app_service)?;
        let private_key = Zeroizing::new(exported.private_key_hex);
        let reencrypted =
            app_services::evm_wallet_import_private_key(app_services::EvmImportPrivateKeyRequest {
                name: wallet.name.clone(),
                private_key_hex: private_key.to_string(),
                password: password.to_string(),
            })
            .map_err(api_error_from_app_service)?;
        if !existing_evm
            .address
            .eq_ignore_ascii_case(&reencrypted.wallet.address)
        {
            return Err(ApiError {
                message: "导出私钥 Keystore 时 EVM 钱包地址发生变化".to_string(),
            });
        }
        metadata.insert(
            "evm_address".to_string(),
            Value::String(reencrypted.wallet.address.clone()),
        );
        metadata.insert(
            "evm_wallet_id".to_string(),
            Value::String(reencrypted.wallet.id.clone()),
        );
        metadata.insert(
            "evm_keystore_json".to_string(),
            Value::String(reencrypted.keystore_json),
        );
        metadata.remove("evm_derivation_path");
    } else {
        for key in [
            "wallet_kind",
            "evm_address",
            "evm_wallet_id",
            "evm_derivation_path",
        ] {
            metadata.remove(key);
        }
    }

    converted = serde_json::to_string(&document).map_err(|error| ApiError {
        message: format!("序列化私钥 Keystore 失败: {error}"),
    })?;
    converted = with_keystore_metadata(&converted, Some(&wallet.name))?;
    let verified = KeyManager::keypair_from_encrypted_json(&converted, password)
        .map_err(|message| ApiError { message })?;
    if verified.pubkey() != keypair.pubkey() {
        return Err(ApiError {
            message: "导出的私钥 Keystore 钱包地址校验失败".to_string(),
        });
    }
    Ok(converted)
}

fn export_saved_wallet_keystore(
    wallet: &wallet_store::SavedWallet,
    keypair: &Keypair,
    password: &str,
    secret_type: ExportKeystoreSecretType,
) -> Result<String, ApiError> {
    match secret_type {
        ExportKeystoreSecretType::PrivateKey => {
            export_private_key_keystore(wallet, keypair, password)
        }
        ExportKeystoreSecretType::Mnemonic => {
            let keystore_json = reencrypt_saved_wallet_material(wallet, password, password)?;
            if KeyManager::keystore_version(&keystore_json)
                .map_err(|message| ApiError { message })?
                != KeystoreVersion::V3
            {
                return Err(ApiError {
                    message: "这是私钥 keystore，没有保存助记词，无法导出助记词 keystore。"
                        .to_string(),
                });
            }
            with_keystore_metadata(&keystore_json, Some(&wallet.name))
        }
    }
}

async fn export_wallet(
    Path(wallet_id): Path<String>,
    Json(req): Json<ExportWalletRequest>,
) -> Result<Json<ExportWalletResponse>, ApiError> {
    validate_wallet_id(&wallet_id)?;
    validate_password(&req.password, "导出钱包密码")?;
    let (keypair, wallet) =
        keypair_from_saved_wallet_with_password(&wallet_id, &req.password, "钱包")?;
    let keystore_json = match req.secret_type {
        Some(secret_type) => {
            export_saved_wallet_keystore(&wallet, &keypair, &req.password, secret_type)?
        }
        None => with_keystore_metadata(&wallet.keystore_json, Some(&wallet.name))?,
    };
    Ok(Json(ExportWalletResponse { keystore_json }))
}

async fn verify_wallet_password(
    Path(wallet_id): Path<String>,
    Json(mut req): Json<VerifyWalletPasswordRequest>,
) -> Result<Json<VerifyWalletPasswordResponse>, ApiError> {
    validate_wallet_id(&wallet_id)?;
    validate_password(&req.password, "钱包密码")?;
    let password = Zeroizing::new(std::mem::take(&mut req.password));
    let wallet_id_for_unlock = wallet_id.clone();
    let (public_key, session_secrets) = run_keystore_task(move || {
        let (keypair, wallet) =
            keypair_from_saved_wallet_with_password(&wallet_id_for_unlock, &password, "钱包")?;
        let public_key = keypair.pubkey().to_string();
        let keypair_bytes = Zeroizing::new(keypair.to_bytes());
        let evm_private_key = evm_private_key_from_saved_wallet(&wallet, &password)?;
        let mnemonic = verified_mnemonic_from_keystore_json(
            &wallet.keystore_json,
            &password,
            &keypair.pubkey(),
        )?;
        let session_secrets = WalletSessionSecrets::new(
            keypair_bytes.as_ref(),
            evm_private_key.as_ref().map(|key| key.as_slice()),
            mnemonic.as_deref().map(String::as_str),
        )
        .map_err(|message| ApiError { message })?;
        Ok((public_key, session_secrets))
    })
    .await?;
    wallet_session_vault()
        .unlock(
            &wallet_id,
            &public_key,
            &session_secrets,
            WALLET_SESSION_IDLE_TTL,
            WALLET_SESSION_MAX_LIFETIME,
        )
        .map_err(|message| ApiError { message })?;
    Ok(Json(VerifyWalletPasswordResponse {
        verified: true,
        public_key,
        session_expires_in_seconds: WALLET_SESSION_IDLE_TTL.as_secs(),
    }))
}

async fn unlock_all_wallets(
    request: Json<VerifyWalletPasswordRequest>,
) -> Result<Json<UnlockAllWalletsResponse>, ApiError> {
    let password_attempt = begin_password_attempt()?;
    let result = unlock_all_wallets_inner(request).await;
    if result.is_ok() {
        password_attempt.succeeded();
    } else {
        password_attempt.failed();
    }
    result
}

type LegacyKeystoreMigration = (String, String, String, String);

struct PreparedSavedWalletUnlock {
    wallet_id: String,
    public_key: String,
    secrets: WalletSessionSecrets,
    legacy_migration: Option<LegacyKeystoreMigration>,
}

#[derive(Debug)]
enum PrepareSavedWalletUnlockError {
    PasswordMismatch,
    Integrity(ApiError),
}

fn prepare_saved_wallet_unlock(
    wallet: wallet_store::SavedWallet,
    password: &str,
) -> Result<PreparedSavedWalletUnlock, PrepareSavedWalletUnlockError> {
    let version = KeyManager::keystore_version(&wallet.keystore_json).map_err(|_| {
        PrepareSavedWalletUnlockError::Integrity(ApiError {
            message: "钱包 Keystore 格式无效".to_string(),
        })
    })?;
    let keypair = KeyManager::keypair_from_encrypted_json(&wallet.keystore_json, password)
        .map_err(|_| PrepareSavedWalletUnlockError::PasswordMismatch)?;
    if keypair.pubkey().to_string() != wallet.public_key {
        return Err(PrepareSavedWalletUnlockError::Integrity(ApiError {
            message: "钱包密文与保存的地址不一致".to_string(),
        }));
    }
    let evm_private_key = evm_private_key_from_saved_wallet(&wallet, password)
        .map_err(|_| PrepareSavedWalletUnlockError::PasswordMismatch)?;
    let mnemonic =
        verified_mnemonic_from_keystore_json(&wallet.keystore_json, password, &keypair.pubkey())
            .map_err(PrepareSavedWalletUnlockError::Integrity)?;
    let keypair_bytes = Zeroizing::new(keypair.to_bytes());
    let secrets = WalletSessionSecrets::new(
        keypair_bytes.as_ref(),
        evm_private_key.as_ref().map(|key| key.as_slice()),
        mnemonic.as_deref().map(String::as_str),
    )
    .map_err(|message| PrepareSavedWalletUnlockError::Integrity(ApiError { message }))?;
    let legacy_migration = if version == KeystoreVersion::LegacyV1 {
        let migrated = reencrypt_saved_wallet_material(&wallet, password, password)
            .map_err(PrepareSavedWalletUnlockError::Integrity)?;
        Some((
            wallet.id.clone(),
            wallet.public_key.clone(),
            wallet.keystore_json.clone(),
            migrated,
        ))
    } else {
        None
    };
    Ok(PreparedSavedWalletUnlock {
        wallet_id: wallet.id,
        public_key: wallet.public_key,
        secrets,
        legacy_migration,
    })
}

async fn unlock_all_wallets_inner(
    Json(mut req): Json<VerifyWalletPasswordRequest>,
) -> Result<Json<UnlockAllWalletsResponse>, ApiError> {
    validate_password(&req.password, "FnzSafe 钱包密码")?;
    let password = Zeroizing::new(std::mem::take(&mut req.password));
    let wallets = wallet_store::load().map_err(|message| ApiError { message })?;
    if wallets.is_empty() {
        return Err(ApiError {
            message: "还没有可解锁的钱包".to_string(),
        });
    }

    // Derive every session before mutating the vault. This keeps unlock all-or-nothing
    // when an older wallet still uses a different password.
    let unlocked = run_keystore_task(move || {
        let mut sessions = Vec::with_capacity(wallets.len());
        let mut legacy_migrations = Vec::new();
        let mut password_mismatches = 0_usize;
        for wallet in wallets {
            match prepare_saved_wallet_unlock(wallet, &password) {
                Ok(prepared) => {
                    if let Some(migration) = prepared.legacy_migration {
                        legacy_migrations.push(migration);
                    }
                    sessions.push((prepared.wallet_id, prepared.public_key, prepared.secrets));
                }
                Err(PrepareSavedWalletUnlockError::PasswordMismatch) => {
                    password_mismatches = password_mismatches.saturating_add(1);
                }
                Err(PrepareSavedWalletUnlockError::Integrity(error)) => return Err(error),
            }
        }
        if password_mismatches > 0 {
            return Err(ApiError {
                message: if sessions.is_empty() {
                    "钱包密码错误".to_string()
                } else {
                    "部分历史钱包尚未统一密码，请先完成密码迁移".to_string()
                },
            });
        }
        if !legacy_migrations.is_empty() {
            wallet_store::replace_all_keystores_atomically(legacy_migrations)
                .map_err(|message| ApiError { message })?;
            checkpoint_sensitive_rewrite_best_effort(
                "Legacy wallet migration during global unlock",
                "all-wallets",
            );
        }
        Ok(sessions)
    })
    .await?;

    let unlocked_wallets = unlocked.len();
    for (wallet_id, public_key, secrets) in unlocked {
        if let Err(message) = wallet_session_vault().unlock(
            &wallet_id,
            &public_key,
            &secrets,
            WALLET_SESSION_IDLE_TTL,
            WALLET_SESSION_MAX_LIFETIME,
        ) {
            let _ = wallet_session_vault().lock_all();
            return Err(ApiError { message });
        }
    }
    Ok(Json(UnlockAllWalletsResponse {
        verified: true,
        unlocked_wallets,
        session_expires_in_seconds: WALLET_SESSION_IDLE_TTL.as_secs(),
    }))
}

async fn wallet_session_status(
    Path(wallet_id): Path<String>,
) -> Result<Json<WalletSessionStatusResponse>, ApiError> {
    validate_wallet_id(&wallet_id)?;
    let wallet = wallet_store::find(&wallet_id).map_err(|message| ApiError { message })?;
    let status = wallet_session_vault()
        .status(&wallet_id)
        .map_err(|message| ApiError { message })?
        .filter(|status| status.identity == wallet.public_key);
    Ok(Json(WalletSessionStatusResponse {
        wallet_id,
        public_key: wallet.public_key,
        unlocked: status.is_some(),
        expires_in_seconds: status.map(|item| item.expires_in_seconds).unwrap_or(0),
    }))
}

async fn lock_wallet_session(
    Path(wallet_id): Path<String>,
) -> Result<Json<LockWalletSessionResponse>, ApiError> {
    validate_wallet_id(&wallet_id)?;
    let locked = wallet_session_vault()
        .lock(&wallet_id)
        .map_err(|message| ApiError { message })?;
    Ok(Json(LockWalletSessionResponse {
        status: "locked",
        locked_sessions: usize::from(locked),
    }))
}

async fn lock_all_wallet_sessions(
    Json(body): Json<serde_json::Value>,
) -> Result<Json<LockWalletSessionResponse>, ApiError> {
    if !body.as_object().is_some_and(|value| value.is_empty()) {
        return Err(ApiError {
            message: "锁定全部钱包的请求体必须为空对象".to_string(),
        });
    }
    let locked_sessions = wallet_session_vault()
        .lock_all()
        .map_err(|message| ApiError { message })?;
    Ok(Json(LockWalletSessionResponse {
        status: "locked",
        locked_sessions,
    }))
}

fn reencrypt_saved_wallet_material(
    wallet: &wallet_store::SavedWallet,
    current_password: &str,
    new_password: &str,
) -> Result<String, ApiError> {
    let keypair = KeyManager::keypair_from_encrypted_json(&wallet.keystore_json, current_password)
        .map_err(|_| ApiError {
            message: "当前钱包密码错误".to_string(),
        })?;
    if keypair.pubkey().to_string() != wallet.public_key {
        return Err(ApiError {
            message: "钱包密文与保存的地址不一致".to_string(),
        });
    }

    let old_document: Value =
        serde_json::from_str(&wallet.keystore_json).map_err(|error| ApiError {
            message: format!("钱包 Keystore 格式无效: {error}"),
        })?;
    let mut metadata = old_document
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mnemonic = verified_mnemonic_from_keystore_json(
        &wallet.keystore_json,
        current_password,
        &keypair.pubkey(),
    )
    .map_err(|_| ApiError {
        message: "当前密码无法解密或验证钱包助记词".to_string(),
    })?;
    let mnemonic_derivation_path = old_document
        .get("derivation_path")
        .and_then(Value::as_str)
        .or_else(|| {
            metadata
                .get("mnemonic_derivation_path")
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned);
    if mnemonic.is_some() {
        metadata.remove("encrypted_mnemonic");
    }

    if let Some(old_evm_keystore) = metadata
        .get("evm_keystore_json")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    {
        let old_evm_wallet =
            app_services::evm_wallet_unlock(app_services::EvmUnlockWalletRequest {
                keystore_json: old_evm_keystore.clone(),
                password: current_password.to_string(),
            })
            .map_err(api_error_from_app_service)?;
        if let Some(mnemonic) = mnemonic.as_deref() {
            validate_universal_evm_mnemonic_identity(
                &wallet.keystore_json,
                &old_evm_wallet,
                mnemonic,
            )?;
        } else {
            validate_universal_evm_identity(&wallet.keystore_json, &old_evm_wallet)?;
        }
        let expected_address = old_evm_wallet.address.to_ascii_lowercase();
        let reencrypted = if let Some(mnemonic) = mnemonic.as_deref() {
            app_services::evm_wallet_import_mnemonic(app_services::EvmImportMnemonicRequest {
                name: wallet.name.clone(),
                mnemonic: mnemonic.to_string(),
                derivation_path: metadata
                    .get("evm_derivation_path")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                password: new_password.to_string(),
            })
            .map_err(api_error_from_app_service)?
        } else {
            let exported = app_services::evm_wallet_export_private_key(
                app_services::EvmExportPrivateKeyRequest {
                    keystore_json: old_evm_keystore,
                    password: current_password.to_string(),
                },
            )
            .map_err(api_error_from_app_service)?;
            let private_key = Zeroizing::new(exported.private_key_hex);
            app_services::evm_wallet_import_private_key(app_services::EvmImportPrivateKeyRequest {
                name: wallet.name.clone(),
                private_key_hex: private_key.to_string(),
                password: new_password.to_string(),
            })
            .map_err(api_error_from_app_service)?
        };
        if expected_address != reencrypted.wallet.address.to_ascii_lowercase() {
            return Err(ApiError {
                message: "EVM 钱包地址在改密过程中发生变化".to_string(),
            });
        }
        metadata.insert(
            "evm_keystore_json".to_string(),
            Value::String(reencrypted.keystore_json),
        );
    }

    let new_keystore = if let Some(mnemonic) = mnemonic.as_deref() {
        let derivation_path = mnemonic_derivation_path
            .as_deref()
            .ok_or_else(|| ApiError {
                message: "助记词 keystore 缺少 Solana 派生路径".to_string(),
            })?;
        KeyManager::mnemonic_to_encrypted_json(mnemonic, derivation_path, new_password)
            .map_err(|message| ApiError { message })?
    } else {
        KeyManager::keypair_to_encrypted_json(&keypair, new_password)
            .map_err(|message| ApiError { message })?
    };
    let mut new_document: Value =
        serde_json::from_str(&new_keystore).map_err(|error| ApiError {
            message: format!("新 Keystore 格式无效: {error}"),
        })?;
    let object = new_document.as_object_mut().ok_or_else(|| ApiError {
        message: "新 Keystore 格式无效".to_string(),
    })?;
    object.insert("metadata".to_string(), Value::Object(metadata));
    let new_keystore = serde_json::to_string(&new_document).map_err(|error| ApiError {
        message: format!("序列化新 Keystore 失败: {error}"),
    })?;

    let verified = KeyManager::keypair_from_encrypted_json(&new_keystore, new_password)
        .map_err(|message| ApiError { message })?;
    if verified.pubkey().to_string() != wallet.public_key {
        return Err(ApiError {
            message: "改密后的钱包地址校验失败".to_string(),
        });
    }
    Ok(new_keystore)
}

#[cfg(test)]
mod wallet_password_change_tests {
    use super::*;
    use solana_sdk::signature::Keypair;

    const OLD_PASSWORD: &str = "old-password-123";
    const NEW_PASSWORD: &str = "new-password-456";
    const MNEMONIC: &str = "test test test test test test test test test test test junk";

    fn saved_wallet(keystore_json: String, keypair: &Keypair) -> wallet_store::SavedWallet {
        wallet_store::SavedWallet {
            id: "stable-wallet-id".to_string(),
            name: "Primary".to_string(),
            public_key: keypair.pubkey().to_string(),
            keystore_json,
            created_at: 11,
            updated_at: 22,
        }
    }

    #[test]
    fn mnemonic_wallet_exports_importable_private_key_and_mnemonic_keystores() {
        let solana_path = normalize_mnemonic_derivation_path(None).unwrap();
        let keypair = keypair_from_mnemonic_phrase(MNEMONIC, &solana_path).unwrap();
        let solana_keystore =
            KeyManager::mnemonic_to_encrypted_json(MNEMONIC, &solana_path, OLD_PASSWORD).unwrap();
        let solana_keystore = with_keystore_metadata_extra(
            &solana_keystore,
            Some("Primary"),
            None,
            Some(&solana_path),
        )
        .unwrap();
        let evm =
            app_services::evm_wallet_import_mnemonic(app_services::EvmImportMnemonicRequest {
                name: "Primary".to_string(),
                mnemonic: MNEMONIC.to_string(),
                derivation_path: None,
                password: OLD_PASSWORD.to_string(),
            })
            .unwrap();
        let universal =
            with_universal_wallet_metadata(&solana_keystore, &evm.wallet, &evm.keystore_json)
                .unwrap();
        let wallet = saved_wallet(universal, &keypair);

        let private_key_keystore = export_saved_wallet_keystore(
            &wallet,
            &keypair,
            OLD_PASSWORD,
            ExportKeystoreSecretType::PrivateKey,
        )
        .unwrap();
        assert_eq!(
            KeyManager::keystore_version(&private_key_keystore).unwrap(),
            KeystoreVersion::V2
        );
        assert_eq!(
            KeyManager::keypair_from_encrypted_json(&private_key_keystore, OLD_PASSWORD)
                .unwrap()
                .pubkey(),
            keypair.pubkey()
        );
        assert!(verified_mnemonic_from_keystore_json(
            &private_key_keystore,
            OLD_PASSWORD,
            &keypair.pubkey(),
        )
        .unwrap()
        .is_none());
        let private_evm_keystore =
            keystore_metadata_value(&private_key_keystore, "evm_keystore_json").unwrap();
        let private_evm_document: Value = serde_json::from_str(&private_evm_keystore).unwrap();
        assert_eq!(
            private_evm_document
                .get("secret_type")
                .and_then(Value::as_str),
            Some("private_key")
        );
        assert_eq!(
            app_services::evm_wallet_unlock(app_services::EvmUnlockWalletRequest {
                keystore_json: private_evm_keystore,
                password: OLD_PASSWORD.to_string(),
            })
            .unwrap()
            .address,
            evm.wallet.address
        );

        let mnemonic_keystore = export_saved_wallet_keystore(
            &wallet,
            &keypair,
            OLD_PASSWORD,
            ExportKeystoreSecretType::Mnemonic,
        )
        .unwrap();
        assert_eq!(
            KeyManager::keystore_version(&mnemonic_keystore).unwrap(),
            KeystoreVersion::V3
        );
        assert_eq!(
            KeyManager::mnemonic_from_encrypted_json(&mnemonic_keystore, OLD_PASSWORD)
                .unwrap()
                .as_str(),
            MNEMONIC
        );
        assert_eq!(
            KeyManager::keypair_from_encrypted_json(&mnemonic_keystore, OLD_PASSWORD)
                .unwrap()
                .pubkey(),
            keypair.pubkey()
        );
        let mnemonic_evm_keystore =
            keystore_metadata_value(&mnemonic_keystore, "evm_keystore_json").unwrap();
        let mnemonic_evm_document: Value = serde_json::from_str(&mnemonic_evm_keystore).unwrap();
        assert_eq!(
            mnemonic_evm_document
                .get("secret_type")
                .and_then(Value::as_str),
            Some("mnemonic")
        );
    }

    #[test]
    fn private_key_wallet_cannot_export_a_mnemonic_keystore() {
        let keypair = Keypair::new();
        let keystore = KeyManager::keypair_to_encrypted_json(&keypair, OLD_PASSWORD).unwrap();
        let wallet = saved_wallet(keystore, &keypair);

        let error = export_saved_wallet_keystore(
            &wallet,
            &keypair,
            OLD_PASSWORD,
            ExportKeystoreSecretType::Mnemonic,
        )
        .unwrap_err();
        assert!(error.message.contains("没有保存助记词"));
    }

    #[test]
    fn changes_standard_v2_password_without_changing_solana_identity() {
        let keypair = Keypair::new();
        let keystore = KeyManager::keypair_to_encrypted_json(&keypair, OLD_PASSWORD).unwrap();
        let wallet = saved_wallet(keystore, &keypair);
        let changed = reencrypt_saved_wallet_material(&wallet, OLD_PASSWORD, NEW_PASSWORD).unwrap();
        assert!(KeyManager::keypair_from_encrypted_json(&changed, OLD_PASSWORD).is_err());
        assert_eq!(
            KeyManager::keypair_from_encrypted_json(&changed, NEW_PASSWORD)
                .unwrap()
                .pubkey(),
            keypair.pubkey()
        );
        assert_eq!(wallet.id, "stable-wallet-id");
        assert_eq!(wallet.created_at, 11);
    }

    #[test]
    fn global_unlock_prepares_legacy_migration_before_creating_a_session() {
        let keypair = Keypair::new();
        let legacy_key = fnzero_safe::generate_encryption_key_simple(OLD_PASSWORD);
        let encrypted_private_key =
            fnzero_safe::encrypt_key(&keypair.to_base58_string(), &legacy_key).unwrap();
        let legacy = serde_json::json!({
            "version": 1,
            "public_key": keypair.pubkey().to_string(),
            "encrypted_private_key": encrypted_private_key,
            "metadata": { "name": "Primary" }
        })
        .to_string();
        let wallet = saved_wallet(legacy, &keypair);

        let prepared = prepare_saved_wallet_unlock(wallet.clone(), OLD_PASSWORD).unwrap();
        let migrated = prepared.legacy_migration.unwrap().3;
        assert_eq!(
            KeyManager::keystore_version(&migrated).unwrap(),
            KeystoreVersion::V2
        );
        assert_eq!(
            KeyManager::keypair_from_encrypted_json(&migrated, OLD_PASSWORD)
                .unwrap()
                .pubkey(),
            keypair.pubkey()
        );
        assert!(matches!(
            prepare_saved_wallet_unlock(wallet, "wrong-password"),
            Err(PrepareSavedWalletUnlockError::PasswordMismatch)
        ));
    }

    #[test]
    fn legacy_migration_preserves_mnemonic_and_universal_metadata() {
        let derivation_path = normalize_mnemonic_derivation_path(None).unwrap();
        let keypair = keypair_from_mnemonic_phrase(MNEMONIC, &derivation_path).unwrap();
        let legacy_key = fnzero_safe::generate_encryption_key_simple(OLD_PASSWORD);
        let encrypted_private_key =
            fnzero_safe::encrypt_key(&keypair.to_base58_string(), &legacy_key).unwrap();
        let encrypted_mnemonic =
            KeyManager::encrypt_secret_with_password(MNEMONIC, OLD_PASSWORD).unwrap();
        let legacy = serde_json::json!({
            "version": 1,
            "public_key": keypair.pubkey().to_string(),
            "encrypted_private_key": encrypted_private_key,
            "metadata": {
                "encrypted_mnemonic": encrypted_mnemonic,
                "mnemonic_derivation_path": derivation_path,
                "wallet_kind": "universal",
                "evm_wallet_id": "evm-wallet-id"
            }
        })
        .to_string();
        let migrated =
            KeyManager::migrate_encrypted_json_to_v2(&legacy, OLD_PASSWORD, OLD_PASSWORD).unwrap();
        let migrated = preserve_keystore_metadata(&legacy, &migrated).unwrap();

        assert_eq!(
            keystore_metadata_value(&migrated, "mnemonic_derivation_path").as_deref(),
            Some(DEFAULT_MNEMONIC_DERIVATION_PATH)
        );
        assert_eq!(
            keystore_metadata_value(&migrated, "wallet_kind").as_deref(),
            Some("universal")
        );
        assert_eq!(
            keystore_metadata_value(&migrated, "evm_wallet_id").as_deref(),
            Some("evm-wallet-id")
        );
        assert_eq!(
            verified_mnemonic_from_keystore_json(&migrated, OLD_PASSWORD, &keypair.pubkey())
                .unwrap()
                .unwrap()
                .as_str(),
            MNEMONIC
        );

        let wallet = saved_wallet(legacy, &keypair);
        let reencrypted =
            reencrypt_saved_wallet_material(&wallet, OLD_PASSWORD, NEW_PASSWORD).unwrap();
        assert_eq!(
            KeyManager::keystore_version(&reencrypted).unwrap(),
            KeystoreVersion::V3
        );
        assert_eq!(
            keystore_metadata_value(&reencrypted, "wallet_kind").as_deref(),
            Some("universal")
        );
        assert_eq!(
            KeyManager::mnemonic_from_encrypted_json(&reencrypted, NEW_PASSWORD)
                .unwrap()
                .as_str(),
            MNEMONIC
        );
    }

    #[test]
    fn reencrypts_saved_mnemonic_and_rejects_wrong_current_password() {
        let derivation_path_label = normalize_mnemonic_derivation_path(None).unwrap();
        let keypair = keypair_from_mnemonic_phrase(MNEMONIC, &derivation_path_label).unwrap();
        let encrypted_mnemonic =
            KeyManager::encrypt_secret_with_password(MNEMONIC, OLD_PASSWORD).unwrap();
        let base = KeyManager::keypair_to_encrypted_json(&keypair, OLD_PASSWORD).unwrap();
        let keystore = with_keystore_metadata_extra(
            &base,
            Some("Primary"),
            Some(&encrypted_mnemonic),
            Some(&derivation_path_label),
        )
        .unwrap();
        let wallet = saved_wallet(keystore, &keypair);
        assert!(reencrypt_saved_wallet_material(&wallet, "wrong-password", NEW_PASSWORD).is_err());
        let changed = reencrypt_saved_wallet_material(&wallet, OLD_PASSWORD, NEW_PASSWORD).unwrap();
        assert_eq!(
            KeyManager::keystore_version(&changed).unwrap(),
            KeystoreVersion::V3
        );
        assert!(KeyManager::mnemonic_from_encrypted_json(&changed, OLD_PASSWORD).is_err());
        assert_eq!(
            KeyManager::mnemonic_from_encrypted_json(&changed, NEW_PASSWORD)
                .unwrap()
                .as_str(),
            MNEMONIC
        );
        assert!(keystore_metadata_encrypted_mnemonic(&changed).is_none());
    }

    #[test]
    fn rejects_legacy_mnemonic_metadata_for_a_different_solana_key() {
        let keypair = Keypair::new();
        let encrypted_mnemonic =
            KeyManager::encrypt_secret_with_password(MNEMONIC, OLD_PASSWORD).unwrap();
        let base = KeyManager::keypair_to_encrypted_json(&keypair, OLD_PASSWORD).unwrap();
        let keystore = with_keystore_metadata_extra(
            &base,
            Some("Mismatched"),
            Some(&encrypted_mnemonic),
            Some(DEFAULT_MNEMONIC_DERIVATION_PATH),
        )
        .unwrap();

        let error =
            verified_mnemonic_from_keystore_json(&keystore, OLD_PASSWORD, &keypair.pubkey())
                .unwrap_err();
        assert!(error.message.contains("不匹配"));
    }

    #[test]
    fn atomically_prepares_all_universal_wallet_secrets_and_preserves_addresses() {
        let solana_path_label = normalize_mnemonic_derivation_path(None).unwrap();
        let solana_keypair = keypair_from_mnemonic_phrase(MNEMONIC, &solana_path_label).unwrap();
        let encrypted_mnemonic =
            KeyManager::encrypt_secret_with_password(MNEMONIC, OLD_PASSWORD).unwrap();
        let solana = KeyManager::keypair_to_encrypted_json(&solana_keypair, OLD_PASSWORD).unwrap();
        let solana = with_keystore_metadata_extra(
            &solana,
            Some("Primary"),
            Some(&encrypted_mnemonic),
            Some(&solana_path_label),
        )
        .unwrap();
        let evm =
            app_services::evm_wallet_import_mnemonic(app_services::EvmImportMnemonicRequest {
                name: "Primary".to_string(),
                mnemonic: MNEMONIC.to_string(),
                derivation_path: None,
                password: OLD_PASSWORD.to_string(),
            })
            .unwrap();
        let universal =
            with_universal_wallet_metadata(&solana, &evm.wallet, &evm.keystore_json).unwrap();
        let wallet = saved_wallet(universal, &solana_keypair);
        let changed = reencrypt_saved_wallet_material(&wallet, OLD_PASSWORD, NEW_PASSWORD).unwrap();

        assert_eq!(
            keystore_metadata_value(&changed, "evm_address"),
            Some(evm.wallet.address.clone())
        );
        assert_eq!(
            keystore_metadata_value(&changed, "evm_wallet_id"),
            Some(evm.wallet.id.clone())
        );
        let changed_evm = keystore_metadata_value(&changed, "evm_keystore_json").unwrap();
        assert!(
            app_services::evm_wallet_unlock(app_services::EvmUnlockWalletRequest {
                keystore_json: changed_evm.clone(),
                password: OLD_PASSWORD.to_string(),
            })
            .is_err()
        );
        let unlocked = app_services::evm_wallet_unlock(app_services::EvmUnlockWalletRequest {
            keystore_json: changed_evm,
            password: NEW_PASSWORD.to_string(),
        })
        .unwrap();
        assert_eq!(unlocked.address, evm.wallet.address);
    }

    #[test]
    fn universal_password_change_rejects_missing_evm_identity_metadata() {
        let solana_path_label = normalize_mnemonic_derivation_path(None).unwrap();
        let solana_keypair = keypair_from_mnemonic_phrase(MNEMONIC, &solana_path_label).unwrap();
        let encrypted_mnemonic =
            KeyManager::encrypt_secret_with_password(MNEMONIC, OLD_PASSWORD).unwrap();
        let solana = KeyManager::keypair_to_encrypted_json(&solana_keypair, OLD_PASSWORD).unwrap();
        let solana = with_keystore_metadata_extra(
            &solana,
            Some("Primary"),
            Some(&encrypted_mnemonic),
            Some(&solana_path_label),
        )
        .unwrap();
        let evm =
            app_services::evm_wallet_import_mnemonic(app_services::EvmImportMnemonicRequest {
                name: "Primary".to_string(),
                mnemonic: MNEMONIC.to_string(),
                derivation_path: None,
                password: OLD_PASSWORD.to_string(),
            })
            .unwrap();
        let universal =
            with_universal_wallet_metadata(&solana, &evm.wallet, &evm.keystore_json).unwrap();
        let mut document: Value = serde_json::from_str(&universal).unwrap();
        document["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("evm_address");
        let wallet = saved_wallet(serde_json::to_string(&document).unwrap(), &solana_keypair);

        assert!(reencrypt_saved_wallet_material(&wallet, OLD_PASSWORD, NEW_PASSWORD).is_err());
    }
}

async fn change_wallet_password(
    Path(wallet_id): Path<String>,
    Json(mut req): Json<ChangeWalletPasswordRequest>,
) -> Result<Json<SaveKeystoreWalletResponse>, ApiError> {
    validate_wallet_id(&wallet_id)?;
    validate_password(&req.current_password, "当前钱包密码")?;
    validate_password(&req.new_password, "新钱包密码")?;
    if req.new_password.chars().count() < 10 {
        return Err(ApiError {
            message: "新钱包密码至少需要 10 个字符".to_string(),
        });
    }
    if req.current_password == req.new_password {
        return Err(ApiError {
            message: "新密码不能与当前密码相同".to_string(),
        });
    }
    let current_password = Zeroizing::new(std::mem::take(&mut req.current_password));
    let new_password = Zeroizing::new(std::mem::take(&mut req.new_password));
    let wallets = wallet_store::load().map_err(|message| ApiError { message })?;
    if !wallets.iter().any(|wallet| wallet.id == wallet_id) {
        return Err(ApiError {
            message: "未找到已保存钱包".to_string(),
        });
    }
    let response_wallet_id = wallet_id.clone();
    let updated = run_keystore_task(move || {
        let password_attempt = begin_password_attempt()?;
        let result = (|| {
            let mut replacements = Vec::with_capacity(wallets.len());
            for wallet in wallets {
                let reencrypted =
                    reencrypt_saved_wallet_material(&wallet, &current_password, &new_password)?;
                replacements.push((
                    wallet.id,
                    wallet.public_key,
                    wallet.keystore_json,
                    reencrypted,
                ));
            }
            let updated = wallet_store::replace_all_keystores_atomically(replacements)
                .map_err(|message| ApiError { message })?;
            checkpoint_sensitive_rewrite_best_effort(
                "Unified wallet password change",
                "all-wallets",
            );
            updated
                .into_iter()
                .find(|wallet| wallet.id == response_wallet_id)
                .ok_or_else(|| ApiError {
                    message: "全局改密成功，但未找到请求的钱包".to_string(),
                })
        })();
        finish_password_attempt(password_attempt, &result);
        result
    })
    .await?;
    wallet_session_vault()
        .lock_all()
        .map_err(|message| ApiError { message })?;
    Ok(Json(SaveKeystoreWalletResponse {
        wallet: updated.into(),
    }))
}

async fn adopt_unified_wallet_password(
    Path(wallet_id): Path<String>,
    Json(mut req): Json<ChangeWalletPasswordRequest>,
) -> Result<Json<SaveKeystoreWalletResponse>, ApiError> {
    validate_wallet_id(&wallet_id)?;
    validate_password(&req.current_password, "历史钱包密码")?;
    validate_password(&req.new_password, "FnzSafe 统一钱包密码")?;
    let current_password = Zeroizing::new(std::mem::take(&mut req.current_password));
    let new_password = Zeroizing::new(std::mem::take(&mut req.new_password));
    let wallet = wallet_store::find(&wallet_id).map_err(|message| ApiError { message })?;
    let updated = run_keystore_task(move || {
        require_unified_password_for_existing_wallets(
            &new_password,
            Some(wallet.public_key.as_str()),
        )?;
        let password_attempt = begin_password_attempt()?;
        let result = (|| {
            let reencrypted =
                reencrypt_saved_wallet_material(&wallet, &current_password, &new_password)?;
            wallet_store::replace_keystore_atomically(
                &wallet.id,
                &wallet.public_key,
                &wallet.keystore_json,
                reencrypted,
            )
            .map_err(|message| ApiError { message })
        })();
        finish_password_attempt(password_attempt, &result);
        result
    })
    .await?;
    wallet_session_vault()
        .lock_all()
        .map_err(|message| ApiError { message })?;
    Ok(Json(SaveKeystoreWalletResponse {
        wallet: updated.into(),
    }))
}

async fn migrate_wallet_keystore(
    Path(wallet_id): Path<String>,
    Json(req): Json<MigrateWalletKeystoreRequest>,
) -> Result<Json<SaveKeystoreWalletResponse>, ApiError> {
    validate_wallet_id(&wallet_id)?;
    validate_password(&req.current_password, "当前钱包密码")?;
    validate_password(&req.new_password, "新钱包密码")?;
    let wallet = wallet_store::find(&wallet_id).map_err(|message| ApiError { message })?;
    let updated = run_keystore_task(move || {
        if KeyManager::keystore_version(&wallet.keystore_json).map_err(|error| ApiError {
            message: format!("Legacy keystore 迁移失败: {error}"),
        })? != KeystoreVersion::LegacyV1
        {
            return Err(ApiError {
                message: "只有 Legacy v1 keystore 需要执行迁移".to_string(),
            });
        }
        let password_attempt = begin_password_attempt()?;
        let result = (|| {
            let migrated =
                reencrypt_saved_wallet_material(&wallet, &req.current_password, &req.new_password)?;
            let updated = wallet_store::replace_keystore_atomically(
                &wallet.id,
                &wallet.public_key,
                &wallet.keystore_json,
                migrated,
            )
            .map_err(|message| ApiError { message })?;
            checkpoint_sensitive_rewrite_best_effort("Legacy wallet migration", &updated.id);
            Ok(updated)
        })();
        finish_password_attempt(password_attempt, &result);
        result
    })
    .await?;
    wallet_session_vault()
        .lock(&wallet_id)
        .map_err(|message| ApiError { message })?;
    Ok(Json(SaveKeystoreWalletResponse {
        wallet: updated.into(),
    }))
}

async fn export_wallet_private_key(
    headers: HeaderMap,
    Path(wallet_id): Path<String>,
    Json(req): Json<ExportWalletRequest>,
) -> Result<Json<ExportWalletPrivateKeyResponse>, ApiError> {
    require_secret_export_enabled_or_tauri(&headers)?;
    validate_wallet_id(&wallet_id)?;
    validate_password(&req.password, "导出私钥密码")?;
    let (keypair, _) = keypair_from_saved_wallet_with_password(&wallet_id, &req.password, "钱包")?;
    Ok(Json(ExportWalletPrivateKeyResponse {
        private_key: keypair.to_base58_string(),
    }))
}

async fn export_wallet_mnemonic(
    headers: HeaderMap,
    Path(wallet_id): Path<String>,
    Json(req): Json<ExportWalletRequest>,
) -> Result<Json<ExportWalletMnemonicResponse>, ApiError> {
    require_secret_export_enabled_or_tauri(&headers)?;
    validate_wallet_id(&wallet_id)?;
    validate_password(&req.password, "导出助记词密码")?;
    let (keypair, wallet) =
        keypair_from_saved_wallet_with_password(&wallet_id, &req.password, "钱包")?;
    let mnemonic = verified_mnemonic_from_keystore_json(
        &wallet.keystore_json,
        &req.password,
        &keypair.pubkey(),
    )?
    .ok_or_else(|| ApiError {
        message: "这是私钥 keystore，没有保存助记词，无法从私钥反推出助记词。".to_string(),
    })?;
    if mnemonic.split_whitespace().count() < 12 {
        return Err(ApiError {
            message: "助记词记录格式无效".to_string(),
        });
    }
    Ok(Json(ExportWalletMnemonicResponse {
        mnemonic: mnemonic.to_string(),
    }))
}

// ============= Wallet Management (U, 7) =============

// U. Unlock Wallet (same as import_keystore)
#[derive(Deserialize)]
struct UnlockWalletRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
}
#[derive(Serialize)]
struct UnlockWalletResponse {
    public_key: String,
    unlocked: bool,
}

async fn unlock_wallet(
    Json(req): Json<UnlockWalletRequest>,
) -> Result<Json<UnlockWalletResponse>, ApiError> {
    let keypair = req.wallet.keypair()?;
    Ok(Json(UnlockWalletResponse {
        public_key: keypair.pubkey().to_string(),
        unlocked: true,
    }))
}

// 7. Check SOL Balance
#[derive(Deserialize)]
struct GetBalanceRequest {
    address: String,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct GetBalanceResponse {
    balance: f64,
    address: String,
    network: String,
}

async fn get_balance(
    Json(req): Json<GetBalanceRequest>,
) -> Result<Json<GetBalanceResponse>, ApiError> {
    let pubkey = Pubkey::from_str(&req.address).map_err(|_| ApiError {
        message: "无效的地址".to_string(),
    })?;
    let selector = rpc_selector(req.network.as_deref())?;
    let mut errors = Vec::new();
    for rpc_url in fallback_rpc_urls(&selector) {
        let client = rpc_query_client_for_url(rpc_url.clone(), RPC_QUERY_TIMEOUT_SECS);
        match client.get_balance(&pubkey) {
            Ok(balance) => {
                return Ok(Json(GetBalanceResponse {
                    balance: lamports_to_sol(balance),
                    address: req.address,
                    network: selector.network.clone(),
                }));
            }
            Err(error) => {
                let message = format!("查询失败: {}", error);
                if !is_retryable_rpc_message(&message) {
                    return Err(ApiError { message });
                }
                tracing::warn!("SOL balance RPC read failed at {}: {}", rpc_url, message);
                errors.push((rpc_url, message));
            }
        }
    }

    Err(ApiError {
        message: format!(
            "所有 RPC 节点均无法查询余额: {}",
            rpc_failure_summary(&errors)
        ),
    })
}

#[derive(Deserialize)]
struct GetAssetsRequest {
    address: String,
    #[serde(default)]
    network: Option<String>,
    #[serde(default = "default_refresh_assets")]
    refresh: bool,
}

#[derive(Serialize)]
struct WalletTokenAsset {
    account: String,
    mint: String,
    amount: String,
    ui_amount_string: String,
    decimals: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    logo_uri: Option<String>,
}

#[derive(Serialize)]
struct GetAssetsResponse {
    address: String,
    network: String,
    sol_balance: f64,
    tokens: Vec<WalletTokenAsset>,
    cached: bool,
    updated_at: Option<u64>,
}

fn default_refresh_assets() -> bool {
    true
}

struct FreshWalletAssets {
    sol_balance: f64,
    tokens: Vec<WalletTokenAsset>,
    metadata_by_mint: HashMap<String, TokenMetadata>,
}

fn wallet_assets_response_from_cache(
    address: String,
    network: String,
    cached: WalletAssetsRecord,
) -> GetAssetsResponse {
    GetAssetsResponse {
        address,
        network,
        sol_balance: cached.sol_balance,
        tokens: cached
            .tokens
            .into_iter()
            .map(wallet_token_asset_from_record)
            .collect(),
        cached: true,
        updated_at: Some(cached.updated_at),
    }
}

fn wallet_token_asset_from_record(record: WalletTokenAssetRecord) -> WalletTokenAsset {
    let WalletTokenAssetRecord {
        account,
        mint,
        amount,
        ui_amount_string,
        decimals,
        name,
        symbol,
        logo_uri,
        ..
    } = record;
    let metadata = normalize_token_metadata(
        &mint,
        TokenMetadata {
            name,
            symbol,
            logo_uri,
            metadata_uri: None,
        },
    );
    WalletTokenAsset {
        account,
        mint,
        amount,
        ui_amount_string,
        decimals,
        name: metadata.name,
        symbol: metadata.symbol,
        logo_uri: metadata.logo_uri,
    }
}

fn clean_cached_metadata_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn cached_token_metadata_by_mint(
    tokens: &[WalletTokenAssetRecord],
) -> HashMap<String, TokenMetadata> {
    let mut metadata_by_mint = HashMap::new();
    for token in tokens {
        let metadata = TokenMetadata {
            name: clean_cached_metadata_string(token.name.clone()),
            symbol: clean_cached_metadata_string(token.symbol.clone()),
            logo_uri: clean_cached_metadata_string(token.logo_uri.clone()),
            metadata_uri: None,
        };
        if metadata.name.is_none() && metadata.symbol.is_none() && metadata.logo_uri.is_none() {
            continue;
        }
        let metadata = normalize_token_metadata(&token.mint, metadata);
        metadata_by_mint
            .entry(token.mint.clone())
            .or_insert_with(TokenMetadata::default)
            .merge_missing(metadata);
    }
    metadata_by_mint
}

async fn read_fresh_wallet_assets(
    client: &RpcClient,
    pubkey: &Pubkey,
    network: &str,
    cached_metadata_by_mint: &HashMap<String, TokenMetadata>,
) -> Result<FreshWalletAssets, ApiError> {
    let balance = client.get_balance(pubkey).map_err(|e| ApiError {
        message: format!("查询余额失败: {}", e),
    })?;

    let mut raw_tokens = Vec::new();
    let mut mints = Vec::new();
    let mut seen_mints = HashMap::new();
    for (account, token_account) in all_owner_token_accounts(client, pubkey)? {
        let token_amount = token_account.token_amount;
        if token_amount.amount == "0" {
            continue;
        }
        let ui_amount_string = token_amount.real_number_string_trimmed();
        if !seen_mints.contains_key(&token_account.mint) {
            seen_mints.insert(token_account.mint.clone(), true);
            mints.push(token_account.mint.clone());
        }
        raw_tokens.push((
            account,
            token_account.mint,
            token_amount.amount,
            ui_amount_string,
            token_amount.decimals,
        ));
    }
    let mut metadata_by_mint = cached_metadata_by_mint.clone();
    let missing_mints = merge_cached_token_metadata(network, &mut metadata_by_mint, &mints);
    load_missing_token_metadata(client, network, &mut metadata_by_mint, &missing_mints).await;
    let tokens: Vec<WalletTokenAsset> = raw_tokens
        .into_iter()
        .map(|(account, mint, amount, ui_amount_string, decimals)| {
            let mut metadata = metadata_by_mint.get(&mint).cloned().unwrap_or_default();
            if let Some(cached_metadata) = cached_metadata_by_mint.get(&mint) {
                metadata.merge_missing(cached_metadata.clone());
            }
            let metadata = normalize_token_metadata(&mint, metadata);
            WalletTokenAsset {
                account,
                mint,
                amount,
                ui_amount_string,
                decimals,
                name: metadata.name,
                symbol: metadata.symbol,
                logo_uri: metadata.logo_uri,
            }
        })
        .collect();

    Ok(FreshWalletAssets {
        sol_balance: lamports_to_sol(balance),
        tokens,
        metadata_by_mint,
    })
}

async fn get_assets(
    Json(req): Json<GetAssetsRequest>,
) -> Result<Json<GetAssetsResponse>, ApiError> {
    let pubkey = Pubkey::from_str(&req.address).map_err(|_| ApiError {
        message: "无效的地址".to_string(),
    })?;
    let selector = rpc_selector(req.network.as_deref())?;
    let network = selector.network.clone();
    let cached_assets = wallet_store::get_wallet_assets(&req.address, &network)
        .map_err(|message| ApiError { message })?;

    if !req.refresh {
        if let Some(cached) = cached_assets {
            return Ok(Json(wallet_assets_response_from_cache(
                req.address,
                network,
                cached,
            )));
        }

        return Ok(Json(GetAssetsResponse {
            address: req.address,
            network,
            sol_balance: 0.0,
            tokens: Vec::new(),
            cached: true,
            updated_at: None,
        }));
    }
    let cached_metadata_by_mint = cached_assets
        .as_ref()
        .map(|cached| cached_token_metadata_by_mint(&cached.tokens))
        .unwrap_or_default();

    let mut errors = Vec::new();
    let mut fresh_assets = None;
    for rpc_url in fallback_rpc_urls(&selector) {
        let client = rpc_query_client_for_url(rpc_url.clone(), RPC_QUERY_TIMEOUT_SECS);
        match read_fresh_wallet_assets(&client, &pubkey, &network, &cached_metadata_by_mint).await {
            Ok(assets) => {
                fresh_assets = Some(assets);
                break;
            }
            Err(error) if is_retryable_api_error(&error) => {
                tracing::warn!(
                    "Wallet assets RPC read failed at {}: {}",
                    rpc_url,
                    error.message
                );
                errors.push((rpc_url, error.message));
            }
            Err(error) => return Err(error),
        }
    }
    let Some(FreshWalletAssets {
        sol_balance,
        tokens,
        metadata_by_mint,
    }) = fresh_assets
    else {
        if let Some(cached) = cached_assets {
            tracing::warn!(
                "All wallet asset RPC reads failed for {} on {}; returning cached assets: {}",
                req.address,
                network,
                rpc_failure_summary(&errors)
            );
            return Ok(Json(wallet_assets_response_from_cache(
                req.address,
                network,
                cached,
            )));
        }
        return Err(ApiError {
            message: format!(
                "所有 RPC 节点均无法查询资产: {}",
                rpc_failure_summary(&errors)
            ),
        });
    };
    let cache_tokens: Vec<WalletTokenAssetRecord> = tokens
        .iter()
        .map(|token| WalletTokenAssetRecord {
            owner: req.address.clone(),
            network: network.clone(),
            account: token.account.clone(),
            mint: token.mint.clone(),
            amount: token.amount.clone(),
            ui_amount_string: token.ui_amount_string.clone(),
            decimals: token.decimals,
            name: token.name.clone(),
            symbol: token.symbol.clone(),
            logo_uri: token.logo_uri.clone(),
            updated_at: 0,
        })
        .collect();
    let metadata_records = token_metadata_records(&network, &metadata_by_mint);
    let _ = wallet_store::save_token_metadata(&network, &metadata_records);
    let updated_at =
        wallet_store::save_wallet_assets(&req.address, &network, sol_balance, &cache_tokens)
            .map_err(|message| ApiError { message })?;

    Ok(Json(GetAssetsResponse {
        address: req.address,
        network,
        sol_balance,
        tokens,
        cached: false,
        updated_at: Some(updated_at),
    }))
}

#[derive(Deserialize)]
struct WalletTransactionsRequest {
    address: String,
    #[serde(default)]
    network: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    before: Option<String>,
}

#[derive(Serialize)]
struct WalletTransactionChange {
    asset: String,
    mint: Option<String>,
    amount: String,
    ui_amount: String,
    direction: String,
    decimals: u8,
}

#[derive(Serialize)]
struct WalletTransactionRecord {
    signature: String,
    slot: u64,
    block_time: Option<i64>,
    confirmation_status: Option<String>,
    err: Option<Value>,
    memo: Option<String>,
    action: String,
    summary: String,
    counterparty: Option<String>,
    programs: Vec<String>,
    changes: Vec<WalletTransactionChange>,
}

fn ui_amount_from_raw_amount(amount: u128, decimals: u8) -> String {
    let raw = amount.to_string();
    if decimals == 0 {
        return raw;
    }
    let decimals = decimals as usize;
    let padded = if raw.len() <= decimals {
        format!("{}{}", "0".repeat(decimals + 1 - raw.len()), raw)
    } else {
        raw
    };
    let whole = &padded[..padded.len() - decimals];
    let fractional = padded[padded.len() - decimals..].trim_end_matches('0');
    if fractional.is_empty() {
        whole.to_string()
    } else {
        format!("{}.{}", whole, fractional)
    }
}

fn signed_ui_amount_from_raw(delta: i128, decimals: u8) -> String {
    let sign = if delta < 0 { "-" } else { "+" };
    format!(
        "{}{}",
        sign,
        ui_amount_from_raw_amount(delta.unsigned_abs(), decimals)
    )
}

fn add_change(
    changes: &mut Vec<WalletTransactionChange>,
    asset: &str,
    mint: Option<String>,
    delta: i128,
    decimals: u8,
) {
    if delta == 0 {
        return;
    }
    changes.push(WalletTransactionChange {
        asset: asset.to_string(),
        mint,
        amount: delta.to_string(),
        ui_amount: signed_ui_amount_from_raw(delta, decimals),
        direction: if delta > 0 { "in" } else { "out" }.to_string(),
        decimals,
    });
}

fn token_symbol_from_metadata(mint: &str, metadata: Option<&TokenMetadata>) -> String {
    let normalized = normalize_token_metadata(mint, metadata.cloned().unwrap_or_default());
    normalized
        .symbol
        .filter(|symbol| !symbol.trim().is_empty())
        .unwrap_or_else(|| mint.to_string())
}

fn option_serializer_vec<T>(value: &OptionSerializer<Vec<T>>) -> &[T] {
    match value.as_ref() {
        OptionSerializer::Some(items) => items.as_slice(),
        _ => &[],
    }
}

fn parsed_message_accounts_and_programs(
    transaction: &EncodedTransaction,
) -> (Vec<String>, Vec<String>) {
    let EncodedTransaction::Json(ui_transaction) = transaction else {
        return (Vec::new(), Vec::new());
    };
    match &ui_transaction.message {
        UiMessage::Parsed(message) => {
            let accounts = message
                .account_keys
                .iter()
                .map(|account| account.pubkey.clone())
                .collect::<Vec<_>>();
            let mut programs = Vec::new();
            for instruction in &message.instructions {
                match instruction {
                    UiInstruction::Parsed(UiParsedInstruction::Parsed(parsed)) => {
                        if !programs.contains(&parsed.program) {
                            programs.push(parsed.program.clone());
                        }
                    }
                    UiInstruction::Parsed(UiParsedInstruction::PartiallyDecoded(parsed)) => {
                        if !programs.contains(&parsed.program_id) {
                            programs.push(parsed.program_id.clone());
                        }
                    }
                    UiInstruction::Compiled(_) => {}
                }
            }
            (accounts, programs)
        }
        UiMessage::Raw(message) => {
            let accounts = message.account_keys.clone();
            let mut programs = Vec::new();
            for instruction in &message.instructions {
                if let Some(program_id) = accounts.get(instruction.program_id_index as usize) {
                    if !programs.contains(program_id) {
                        programs.push(program_id.clone());
                    }
                }
            }
            (accounts, programs)
        }
    }
}

fn transaction_counterparty(accounts: &[String], owner: &str) -> Option<String> {
    accounts
        .iter()
        .find(|account| {
            account.as_str() != owner && account.as_str() != "11111111111111111111111111111111"
        })
        .cloned()
}

fn fallback_program_label(programs: &[String]) -> String {
    if programs
        .iter()
        .any(|program| program.eq_ignore_ascii_case("jupiter"))
    {
        "Jupiter".to_string()
    } else if programs
        .iter()
        .any(|program| program.eq_ignore_ascii_case("spl-token"))
    {
        "SPL Token".to_string()
    } else if programs
        .iter()
        .any(|program| program.eq_ignore_ascii_case("system"))
    {
        "System Program".to_string()
    } else if let Some(program) = programs.first() {
        program.clone()
    } else {
        "Solana".to_string()
    }
}

fn summarize_transaction(
    changes: &[WalletTransactionChange],
    programs: &[String],
) -> (String, String) {
    let has_in = changes.iter().any(|change| change.direction == "in");
    let has_out = changes.iter().any(|change| change.direction == "out");
    if has_in && has_out {
        ("swap".to_string(), fallback_program_label(programs))
    } else if has_in {
        ("receive".to_string(), "Received".to_string())
    } else if has_out {
        ("send".to_string(), "Sent".to_string())
    } else if !programs.is_empty() {
        ("contract".to_string(), fallback_program_label(programs))
    } else {
        ("transaction".to_string(), "Transaction".to_string())
    }
}

async fn enrich_transaction_change_assets(
    client: &RpcClient,
    network: &str,
    transactions: &mut [WalletTransactionRecord],
) {
    let mut mints = Vec::new();
    let mut seen_mints = HashMap::new();
    for transaction in transactions.iter() {
        for change in transaction.changes.iter() {
            let Some(mint) = change.mint.as_deref() else {
                continue;
            };
            if mint == WRAPPED_SOL_MINT || !seen_mints.contains_key(mint) {
                seen_mints.insert(mint.to_string(), true);
                mints.push(mint.to_string());
            }
        }
    }
    if mints.is_empty() {
        return;
    }

    let mut metadata_by_mint = HashMap::new();
    let missing_mints = merge_cached_token_metadata(network, &mut metadata_by_mint, &mints);
    load_missing_token_metadata(client, network, &mut metadata_by_mint, &missing_mints).await;
    if metadata_by_mint.is_empty() {
        return;
    }

    for transaction in transactions.iter_mut() {
        for change in transaction.changes.iter_mut() {
            let Some(mint) = change.mint.as_ref() else {
                continue;
            };
            change.asset = token_symbol_from_metadata(mint, metadata_by_mint.get(mint));
        }
    }
}

fn parse_wallet_transaction_details(
    client: &RpcClient,
    signature: &Signature,
    owner: &Pubkey,
    token_metadata: &HashMap<String, TokenMetadata>,
) -> (Vec<WalletTransactionChange>, Option<String>, Vec<String>) {
    let tx = match client.get_transaction_with_config(
        signature,
        RpcTransactionConfig {
            encoding: Some(UiTransactionEncoding::JsonParsed),
            commitment: Some(CommitmentConfig::confirmed()),
            max_supported_transaction_version: Some(0),
        },
    ) {
        Ok(tx) => tx,
        Err(_) => return (Vec::new(), None, Vec::new()),
    };
    let (accounts, programs) = parsed_message_accounts_and_programs(&tx.transaction.transaction);
    let counterparty = transaction_counterparty(&accounts, &owner.to_string());
    let Some(meta) = tx.transaction.meta else {
        return (Vec::new(), counterparty, programs);
    };

    let mut changes = Vec::new();
    if let Some(owner_index) = accounts
        .iter()
        .position(|account| account == &owner.to_string())
    {
        if let (Some(pre), Some(post)) = (
            meta.pre_balances.get(owner_index),
            meta.post_balances.get(owner_index),
        ) {
            add_change(&mut changes, "SOL", None, *post as i128 - *pre as i128, 9);
        }
    }

    let mut token_deltas: HashMap<String, (i128, u8)> = HashMap::new();
    for token_balance in option_serializer_vec(&meta.pre_token_balances) {
        let is_owner = match token_balance.owner.as_ref() {
            OptionSerializer::Some(token_owner) => token_owner.as_str() == owner.to_string(),
            _ => false,
        };
        if !is_owner {
            continue;
        }
        let amount = token_balance
            .ui_token_amount
            .amount
            .parse::<i128>()
            .unwrap_or_default();
        let entry = token_deltas
            .entry(token_balance.mint.clone())
            .or_insert((0, token_balance.ui_token_amount.decimals));
        entry.0 -= amount;
        entry.1 = token_balance.ui_token_amount.decimals;
    }
    for token_balance in option_serializer_vec(&meta.post_token_balances) {
        let is_owner = match token_balance.owner.as_ref() {
            OptionSerializer::Some(token_owner) => token_owner.as_str() == owner.to_string(),
            _ => false,
        };
        if !is_owner {
            continue;
        }
        let amount = token_balance
            .ui_token_amount
            .amount
            .parse::<i128>()
            .unwrap_or_default();
        let entry = token_deltas
            .entry(token_balance.mint.clone())
            .or_insert((0, token_balance.ui_token_amount.decimals));
        entry.0 += amount;
        entry.1 = token_balance.ui_token_amount.decimals;
    }
    for (mint, (delta, decimals)) in token_deltas {
        let asset = token_symbol_from_metadata(&mint, token_metadata.get(&mint));
        add_change(&mut changes, &asset, Some(mint.clone()), delta, decimals);
    }

    (changes, counterparty, programs)
}

fn parse_wallet_transaction_details_with_timeout(
    network: Option<&str>,
    signature: Signature,
    owner: Pubkey,
    token_metadata: HashMap<String, TokenMetadata>,
) -> (Vec<WalletTransactionChange>, Option<String>, Vec<String>) {
    let Ok((client, _)) =
        rpc_query_client_for_timeout(network, RPC_TRANSACTION_DETAIL_TIMEOUT_SECS)
    else {
        return (Vec::new(), None, Vec::new());
    };
    parse_wallet_transaction_details(&client, &signature, &owner, &token_metadata)
}

#[derive(Serialize)]
struct WalletTransactionsResponse {
    address: String,
    network: String,
    limit: usize,
    before: Option<String>,
    next_before: Option<String>,
    has_more: bool,
    transactions: Vec<WalletTransactionRecord>,
}

async fn get_wallet_transactions(
    Json(req): Json<WalletTransactionsRequest>,
) -> Result<Json<WalletTransactionsResponse>, ApiError> {
    let pubkey = Pubkey::from_str(&req.address).map_err(|_| ApiError {
        message: "无效的地址".to_string(),
    })?;
    let limit = req
        .limit
        .unwrap_or(20)
        .clamp(1, MAX_WALLET_TRANSACTION_HISTORY);
    let before = req
        .before
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let before_signature = before
        .as_deref()
        .map(Signature::from_str)
        .transpose()
        .map_err(|_| ApiError {
            message: "无效的分页交易签名".to_string(),
        })?;
    let selector = rpc_selector(req.network.as_deref())?;
    let network = selector.network.clone();
    let mut errors = Vec::new();
    let mut signatures_with_client = None;
    for rpc_url in fallback_rpc_urls(&selector) {
        let client = rpc_query_client_for_url(rpc_url.clone(), RPC_QUERY_TIMEOUT_SECS);
        match client.get_signatures_for_address_with_config(
            &pubkey,
            GetConfirmedSignaturesForAddress2Config {
                before: before_signature,
                until: None,
                limit: Some(limit),
                commitment: Some(CommitmentConfig::confirmed()),
            },
        ) {
            Ok(signatures) => {
                signatures_with_client = Some((signatures, client));
                break;
            }
            Err(error) => {
                let message = format!("查询交易记录失败: {}", error);
                if !is_retryable_rpc_message(&message) {
                    return Err(ApiError { message });
                }
                tracing::warn!(
                    "Wallet transaction list RPC read failed at {}: {}",
                    rpc_url,
                    message
                );
                errors.push((rpc_url, message));
            }
        }
    }
    let Some((signatures, client)) = signatures_with_client else {
        return Err(ApiError {
            message: format!(
                "所有 RPC 节点均无法查询交易记录: {}",
                rpc_failure_summary(&errors)
            ),
        });
    };

    let has_more = signatures.len() >= limit;
    let request_network = req.network.clone();
    let cached_token_metadata = wallet_store::get_wallet_assets(&req.address, &network)
        .ok()
        .flatten()
        .map(|cached| cached_token_metadata_by_mint(&cached.tokens))
        .unwrap_or_default();
    let pending_transactions = signatures
        .into_iter()
        .take(MAX_WALLET_TRANSACTION_HISTORY)
        .map(|item| {
            let details = Signature::from_str(&item.signature).ok().map(|sig| {
                let owner = pubkey;
                let network = request_network.clone();
                let token_metadata = cached_token_metadata.clone();
                tokio::task::spawn_blocking(move || {
                    parse_wallet_transaction_details_with_timeout(
                        network.as_deref(),
                        sig,
                        owner,
                        token_metadata,
                    )
                })
            });
            (item, details)
        })
        .collect::<Vec<_>>();

    let mut transactions = join_all(pending_transactions.into_iter().map(
        |(item, details)| async move {
            let signature = item.signature.clone();
            let (changes, counterparty, programs) = match details {
                Some(details) => tokio::time::timeout(
                    Duration::from_secs(RPC_TRANSACTION_DETAIL_TIMEOUT_SECS + 1),
                    details,
                )
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_else(|| (Vec::new(), None, Vec::new())),
                None => (Vec::new(), None, Vec::new()),
            };
            let (action, summary) = summarize_transaction(&changes, &programs);
            WalletTransactionRecord {
                signature,
                slot: item.slot,
                block_time: item.block_time,
                confirmation_status: item
                    .confirmation_status
                    .map(|status| format!("{:?}", status)),
                err: item.err.map(|err| json!(err)),
                memo: item.memo,
                action,
                summary,
                counterparty,
                programs,
                changes,
            }
        },
    ))
    .await;
    enrich_transaction_change_assets(&client, &network, &mut transactions).await;
    let next_before = transactions.last().map(|item| item.signature.clone());

    Ok(Json(WalletTransactionsResponse {
        address: req.address,
        network,
        limit,
        before,
        next_before,
        has_more,
        transactions,
    }))
}

// Get Public Key from Secret Key
#[derive(Deserialize)]
struct GetPubkeyRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
}
#[derive(Serialize)]
struct GetPubkeyResponse {
    public_key: String,
}

async fn get_pubkey(
    Json(req): Json<GetPubkeyRequest>,
) -> Result<Json<GetPubkeyResponse>, ApiError> {
    Ok(Json(GetPubkeyResponse {
        public_key: req.wallet.public_key()?,
    }))
}

// ============= SOL Operations (8) =============

// 8. Transfer SOL
#[derive(Deserialize)]
struct TransferSolRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    to_address: String,
    amount: DecimalAmount,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct TransferSolResponse {
    signature: String,
    status: String,
}

async fn transfer_sol(
    Json(req): Json<TransferSolRequest>,
) -> Result<Json<TransferSolResponse>, ApiError> {
    let to_pubkey = Pubkey::from_str(&req.to_address).map_err(|_| ApiError {
        message: "无效的接收地址".to_string(),
    })?;

    let keypair = req.wallet.keypair()?;

    let amount_lamports = sol_to_lamports(&req.amount)?;
    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let client = SolanaClient::new(rpc_url.to_string());

    let signature = client
        .transfer_sol(&keypair, &to_pubkey, amount_lamports)
        .map_err(|e| ApiError {
            message: format!("转账失败: {}", e),
        })?;

    Ok(Json(TransferSolResponse {
        signature: signature.to_string(),
        status: "success".to_string(),
    }))
}

// ============= WSOL Operations (9-11) =============

// 9. Create WSOL ATA
#[derive(Deserialize)]
struct CreateWsolAtaRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct CreateWsolAtaResponse {
    signature: String,
    status: String,
}

async fn create_wsol_ata(
    Json(req): Json<CreateWsolAtaRequest>,
) -> Result<Json<CreateWsolAtaResponse>, ApiError> {
    let keypair = req.wallet.keypair()?;
    let mint = Pubkey::from_str(WRAPPED_SOL_MINT).map_err(|_| ApiError {
        message: "无效的 WSOL mint 地址".to_string(),
    })?;
    let (client, _) = rpc_client_for(req.network.as_deref())?;

    let instruction = squads_v4::create_associated_token_account_idempotent_ix(
        &keypair.pubkey(),
        &keypair.pubkey(),
        &mint,
    );
    let signature = sign_and_send_single(&client, instruction, &keypair)?;

    Ok(Json(CreateWsolAtaResponse {
        signature,
        status: "success".to_string(),
    }))
}

// 10. Wrap SOL
#[derive(Deserialize)]
struct WrapSolRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    amount: DecimalAmount,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct WrapSolResponse {
    signature: String,
    status: String,
}

async fn wrap_sol(Json(req): Json<WrapSolRequest>) -> Result<Json<WrapSolResponse>, ApiError> {
    let keypair = req.wallet.keypair()?;

    let amount_lamports = sol_to_lamports(&req.amount)?;
    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let client = SolanaClient::new(rpc_url.to_string());

    let signature = client
        .wrap_sol(&keypair, amount_lamports)
        .map_err(|e| ApiError {
            message: format!("封装失败: {}", e),
        })?;

    Ok(Json(WrapSolResponse {
        signature: signature.to_string(),
        status: "success".to_string(),
    }))
}

// 11. Unwrap SOL
#[derive(Deserialize)]
struct UnwrapSolRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct UnwrapSolResponse {
    signature: String,
    status: String,
}

async fn unwrap_sol(
    Json(req): Json<UnwrapSolRequest>,
) -> Result<Json<UnwrapSolResponse>, ApiError> {
    let keypair = req.wallet.keypair()?;

    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let client = SolanaClient::new(rpc_url.to_string());

    let signature = client.unwrap_sol(&keypair).map_err(|e| ApiError {
        message: format!("解封失败: {}", e),
    })?;

    Ok(Json(UnwrapSolResponse {
        signature: signature.to_string(),
        status: "success".to_string(),
    }))
}

// 12. Close WSOL ATA
#[derive(Deserialize)]
struct CloseWsolAtaRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct CloseWsolAtaResponse {
    signature: String,
    status: String,
}

async fn close_wsol_ata(
    Json(req): Json<CloseWsolAtaRequest>,
) -> Result<Json<CloseWsolAtaResponse>, ApiError> {
    let keypair = req.wallet.keypair()?;

    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let client = SolanaClient::new(rpc_url.to_string());

    // Close WSOL ATA by unwrapping all WSOL
    let signature = client.unwrap_sol(&keypair).map_err(|e| ApiError {
        message: format!("关闭 ATA 失败: {}", e),
    })?;

    Ok(Json(CloseWsolAtaResponse {
        signature: signature.to_string(),
        status: "success".to_string(),
    }))
}

// ============= Token Operations (13) =============

#[derive(Deserialize)]
struct TokenMintInfoRequest {
    mint: String,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Serialize)]
struct TokenMintInfoResponse {
    mint: String,
    network: String,
    decimals: u8,
    supply: String,
    ui_amount_string: String,
}

async fn token_mint_info(
    Json(req): Json<TokenMintInfoRequest>,
) -> Result<Json<TokenMintInfoResponse>, ApiError> {
    let mint = Pubkey::from_str(req.mint.trim()).map_err(|_| ApiError {
        message: "无效的 Token Mint 地址".to_string(),
    })?;
    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let supply = token_mint_info_from_rpc(&client, &mint)?;
    let ui_amount_string = supply.real_number_string_trimmed();

    Ok(Json(TokenMintInfoResponse {
        mint: mint.to_string(),
        network,
        decimals: supply.decimals,
        supply: supply.amount,
        ui_amount_string,
    }))
}

// 13. Transfer SPL Token
#[derive(Deserialize)]
struct TransferTokenRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    to_address: String,
    mint: String,
    amount: DecimalAmount,
    #[allow(dead_code)]
    #[serde(default)]
    decimals: Option<u8>,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct TransferTokenResponse {
    signature: String,
    status: String,
}

async fn transfer_token(
    Json(req): Json<TransferTokenRequest>,
) -> Result<Json<TransferTokenResponse>, ApiError> {
    let to_pubkey = Pubkey::from_str(&req.to_address).map_err(|_| ApiError {
        message: "无效的接收地址".to_string(),
    })?;
    let mint = Pubkey::from_str(&req.mint).map_err(|_| ApiError {
        message: "无效的mint地址".to_string(),
    })?;

    let keypair = req.wallet.keypair()?;

    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let rpc_client =
        RpcClient::new_with_commitment(rpc_url.to_string(), CommitmentConfig::confirmed());
    let client = SolanaClient::new(rpc_url.to_string());

    // Always trust on-chain mint decimals instead of user-submitted decimals.
    let mint_info = token_mint_info_from_rpc(&rpc_client, &mint)?;
    let token_amount = token_amount_to_raw(&req.amount, mint_info.decimals)?;

    let signature = client
        .transfer_token(&keypair, &to_pubkey, &mint, token_amount)
        .map_err(|e| ApiError {
            message: format!("转账失败: {}", e),
        })?;

    Ok(Json(TransferTokenResponse {
        signature: signature.to_string(),
        status: "success".to_string(),
    }))
}

// ============= Nonce Operations (14) =============

// 14. Create Nonce Account
#[derive(Deserialize)]
struct CreateNonceAccountRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    #[serde(default)]
    network: Option<String>,
    #[serde(default)]
    count: Option<u8>,
}
#[derive(Serialize)]
struct CreatedNonceAccount {
    nonce_account: String,
    signature: String,
    created_at: u64,
}
#[derive(Serialize)]
struct CreateNonceAccountResponse {
    nonce_accounts: Vec<CreatedNonceAccount>,
    nonce_account: String,
    signature: String,
    count: usize,
    status: String,
}

async fn create_nonce_account(
    Json(req): Json<CreateNonceAccountRequest>,
) -> Result<Json<CreateNonceAccountResponse>, ApiError> {
    let keypair = req.wallet.keypair()?;
    let owner = keypair.pubkey().to_string();
    let wallet_id = req
        .wallet
        .wallet_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let count = req.count.unwrap_or(1);
    if count == 0 || count > MAX_NONCE_BATCH_COUNT {
        return Err(ApiError {
            message: format!("Nonce 创建数量必须在 1-{} 之间", MAX_NONCE_BATCH_COUNT),
        });
    }

    let selector = rpc_selector(req.network.as_deref())?;
    let rpc_url = selector.url;
    let network = selector.network;
    let client = SolanaClient::new(rpc_url.to_string());

    let mut nonce_accounts = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let (nonce_account, signature) =
            client
                .create_nonce_account(&keypair)
                .map_err(|e| ApiError {
                    message: format!("创建失败: {}", e),
                })?;
        let record = wallet_store::add_nonce_account(
            wallet_id,
            &owner,
            &network,
            &nonce_account.to_string(),
            &signature.to_string(),
        )
        .map_err(|message| ApiError { message })?;
        nonce_accounts.push(CreatedNonceAccount {
            nonce_account: record.nonce_account,
            signature: record.signature,
            created_at: record.created_at,
        });
    }
    let first = nonce_accounts.first().ok_or_else(|| ApiError {
        message: "未创建 Nonce 账户".to_string(),
    })?;

    Ok(Json(CreateNonceAccountResponse {
        nonce_account: first.nonce_account.clone(),
        signature: first.signature.clone(),
        count: nonce_accounts.len(),
        nonce_accounts,
        status: "success".to_string(),
    }))
}

#[derive(Deserialize)]
struct ListNonceAccountsRequest {
    owner: String,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Serialize)]
struct ListNonceAccountsResponse {
    owner: String,
    network: String,
    nonce_accounts: Vec<wallet_store::NonceAccountRecord>,
}

async fn list_nonce_accounts(
    Json(req): Json<ListNonceAccountsRequest>,
) -> Result<Json<ListNonceAccountsResponse>, ApiError> {
    let owner = Pubkey::from_str(&req.owner).map_err(|_| ApiError {
        message: "无效的钱包地址".to_string(),
    })?;
    let network = network_name(req.network.as_deref()).to_string();
    let nonce_accounts = wallet_store::list_nonce_accounts(&owner.to_string(), &network)
        .map_err(|message| ApiError { message })?;
    Ok(Json(ListNonceAccountsResponse {
        owner: owner.to_string(),
        network,
        nonce_accounts,
    }))
}

// ============= Program Deployment =============

const DEPLOYMENT_STATUS_CREATE_BUFFER_SIGNED: &str = "create_buffer_signed";
const DEPLOYMENT_STATUS_CREATE_BUFFER_RECONCILE: &str = "create_buffer_requires_reconciliation";
const DEPLOYMENT_STATUS_BUFFER_READY: &str = "buffer_ready";
const DEPLOYMENT_STATUS_WRITE_SIGNED: &str = "write_signed";
const DEPLOYMENT_STATUS_WRITE_CONFIRMED: &str = "write_confirmed";
const DEPLOYMENT_STATUS_WRITE_RECONCILE: &str = "write_requires_reconciliation";
const DEPLOYMENT_STATUS_BUFFER_FINALIZED: &str = "buffer_finalized";
const DEPLOYMENT_STATUS_DEPLOY_SIGNED: &str = "deploy_signed";
const DEPLOYMENT_STATUS_DEPLOY_RECONCILE: &str = "deploy_requires_reconciliation";
const DEPLOYMENT_STATUS_DEPLOY_FINALIZED: &str = "deploy_finalized_pending_readback";
const DEPLOYMENT_STATUS_FINALIZED: &str = "finalized";

#[derive(Debug, PartialEq, Eq)]
enum DeploymentAttemptExpiryDecision {
    NotExpired,
    ExpiredAbsent {
        min_context_slot: u64,
    },
    HistoryContextTooOld {
        expiry_observation_slot: u64,
        history_context_slot: u64,
    },
    SeenButNotFinalized,
    FinalizedSucceeded,
    FinalizedFailed(String),
}

fn classify_deployment_attempt_expiry(
    finalized_block_height: u64,
    last_valid_block_height: u64,
    historical_status: Option<&TransactionStatus>,
    history_context_slot: u64,
    expiry_observation_slot: u64,
) -> DeploymentAttemptExpiryDecision {
    if finalized_block_height <= last_valid_block_height {
        return DeploymentAttemptExpiryDecision::NotExpired;
    }
    if history_context_slot < expiry_observation_slot {
        return DeploymentAttemptExpiryDecision::HistoryContextTooOld {
            expiry_observation_slot,
            history_context_slot,
        };
    }
    let Some(status) = historical_status else {
        return DeploymentAttemptExpiryDecision::ExpiredAbsent {
            min_context_slot: history_context_slot,
        };
    };
    if !status.satisfies_commitment(CommitmentConfig::finalized()) {
        return DeploymentAttemptExpiryDecision::SeenButNotFinalized;
    }
    match status.err.as_ref() {
        Some(error) => DeploymentAttemptExpiryDecision::FinalizedFailed(format!("{error:?}")),
        None => DeploymentAttemptExpiryDecision::FinalizedSucceeded,
    }
}

fn inspect_deployment_attempt_expiry(
    client: &RpcClient,
    attempt: &wallet_store::ProgramDeploymentAttemptRecord,
) -> Result<DeploymentAttemptExpiryDecision, ApiError> {
    let finalized_epoch_info = client
        .get_epoch_info_with_commitment(CommitmentConfig::finalized())
        .map_err(|error| {
            deployment_journal_error(format!(
                "读取 finalized epoch info 失败，无法判定签名 {} 是否过期: {error}",
                attempt.signature
            ))
        })?;
    let signature = Signature::from_str(attempt.signature.trim()).map_err(|_| {
        deployment_journal_error(format!(
            "attempt {} 包含无效签名，拒绝自动恢复",
            attempt.signature
        ))
    })?;
    if finalized_epoch_info.block_height <= attempt.last_valid_block_height {
        return Ok(DeploymentAttemptExpiryDecision::NotExpired);
    }
    let response = client
        .get_signature_statuses_with_history(&[signature])
        .map_err(|error| {
            deployment_journal_error(format!(
                "查询签名 {} 的完整历史失败，拒绝自动重试: {error}",
                attempt.signature
            ))
        })?;
    if response.value.len() != 1 {
        return Err(deployment_journal_error(format!(
            "签名 {} 的历史响应数量异常，拒绝自动重试",
            attempt.signature
        )));
    }
    Ok(classify_deployment_attempt_expiry(
        finalized_epoch_info.block_height,
        attempt.last_valid_block_height,
        response.value.first().and_then(Option::as_ref),
        response.context.slot,
        finalized_epoch_info.absolute_slot,
    ))
}

fn gate_expired_absent_with<F>(
    decision: DeploymentAttemptExpiryDecision,
    confirm_absent: F,
) -> Result<DeploymentAttemptExpiryDecision, ApiError>
where
    F: FnOnce(u64) -> Result<(), ApiError>,
{
    match decision {
        DeploymentAttemptExpiryDecision::ExpiredAbsent { min_context_slot } => {
            confirm_absent(min_context_slot)?;
            Ok(DeploymentAttemptExpiryDecision::ExpiredAbsent { min_context_slot })
        }
        other => Ok(other),
    }
}

fn finalized_recovery_account_config(min_context_slot: u64) -> RpcAccountInfoConfig {
    RpcAccountInfoConfig {
        encoding: Some(UiAccountEncoding::Base64Zstd),
        commitment: Some(CommitmentConfig::finalized()),
        data_slice: None,
        min_context_slot: Some(min_context_slot),
    }
}

fn decode_recovery_ui_account(address: &Pubkey, account: UiAccount) -> Result<Account, ApiError> {
    account.decode().ok_or_else(|| {
        deployment_journal_error(format!(
            "finalized 账户 {} 的 Base64Zstd 数据无法解码；拒绝将其视为不存在",
            address
        ))
    })
}

fn get_finalized_recovery_account(
    client: &RpcClient,
    address: &Pubkey,
    min_context_slot: u64,
) -> Result<Option<Account>, ApiError> {
    let response = client
        .get_ui_account_with_config(address, finalized_recovery_account_config(min_context_slot))
        .map_err(|error| {
            deployment_journal_error(format!(
                "在最小上下文 slot {} 二次读取 finalized 账户 {} 失败: {error}",
                min_context_slot, address
            ))
        })?;
    if response.context.slot < min_context_slot {
        return Err(deployment_journal_error(format!(
            "finalized 账户 {} 二次回读 slot {} 早于签名历史 slot {}",
            address, response.context.slot, min_context_slot
        )));
    }
    response
        .value
        .map(|account| decode_recovery_ui_account(address, account))
        .transpose()
}

fn get_finalized_recovery_accounts(
    client: &RpcClient,
    addresses: &[Pubkey],
    min_context_slot: u64,
) -> Result<Vec<Option<Account>>, ApiError> {
    let response = client
        .get_multiple_ui_accounts_with_config(
            addresses,
            finalized_recovery_account_config(min_context_slot),
        )
        .map_err(|error| {
            deployment_journal_error(format!(
                "在最小上下文 slot {} 二次读取 finalized 账户组失败: {error}",
                min_context_slot
            ))
        })?;
    if response.context.slot < min_context_slot {
        return Err(deployment_journal_error(format!(
            "finalized 账户组二次回读 slot {} 早于签名历史 slot {}",
            response.context.slot, min_context_slot
        )));
    }
    if response.value.len() != addresses.len() {
        return Err(deployment_journal_error(format!(
            "finalized 账户组二次回读返回 {} 项，预期 {} 项",
            response.value.len(),
            addresses.len()
        )));
    }
    response
        .value
        .into_iter()
        .zip(addresses)
        .map(|(account, address)| {
            account
                .map(|account| decode_recovery_ui_account(address, account))
                .transpose()
        })
        .collect()
}

fn confirm_create_buffer_attempt_still_absent(
    client: &RpcClient,
    buffer_address: &Pubkey,
    min_context_slot: u64,
) -> Result<(), ApiError> {
    if get_finalized_recovery_account(client, buffer_address, min_context_slot)?.is_some() {
        return Err(deployment_journal_error(format!(
            "Buffer {} 已在签名历史 slot {} 之后出现；保持 attempt 活动状态并中止本次恢复",
            buffer_address, min_context_slot
        )));
    }
    Ok(())
}

fn validate_write_attempt_recovery_snapshot(
    previous_plan: &program_deploy::BufferWritePlan,
    current_plan: &program_deploy::BufferWritePlan,
    chunk_index: usize,
) -> Result<(), ApiError> {
    if previous_plan != current_plan {
        return Err(deployment_journal_error(format!(
            "Buffer finalized 写入计划在 chunk {} 过期判定后已变化；保持 attempt 活动状态并中止本次恢复",
            chunk_index
        )));
    }
    if !current_plan.pending_chunk_indexes.contains(&chunk_index) {
        return Err(deployment_journal_error(format!(
            "Buffer chunk {} 已不再缺失；保持 attempt 活动状态并中止本次恢复",
            chunk_index
        )));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn confirm_write_attempt_still_absent(
    client: &RpcClient,
    buffer_address: &Pubkey,
    expected_authority: &Pubkey,
    expected_program: &[u8],
    previous_plan: &program_deploy::BufferWritePlan,
    chunk_index: usize,
    min_context_slot: u64,
) -> Result<(), ApiError> {
    let account = get_finalized_recovery_account(client, buffer_address, min_context_slot)?
        .ok_or_else(|| {
            deployment_journal_error(format!(
                "Buffer {} 在 write attempt 二次回读时不存在；拒绝自动重签 chunk {}",
                buffer_address, chunk_index
            ))
        })?;
    let current_plan = program_deploy::verify_resume_buffer(
        expected_authority,
        expected_program,
        PROGRAM_WRITE_CHUNK_BYTES,
        &account.owner,
        account.executable,
        &account.data,
    )
    .map_err(|error| {
        deployment_journal_error(format!(
            "Buffer {} 在 write attempt 二次回读时校验失败: {error}",
            buffer_address
        ))
    })?;
    validate_write_attempt_recovery_snapshot(previous_plan, &current_plan, chunk_index)
}

fn confirm_deploy_attempt_still_absent(
    client: &RpcClient,
    program_id: &Pubkey,
    programdata_address: &Pubkey,
    min_context_slot: u64,
) -> Result<(), ApiError> {
    let accounts = get_finalized_recovery_accounts(
        client,
        &[*program_id, *programdata_address],
        min_context_slot,
    )?;
    if accounts.iter().any(Option::is_some) {
        return Err(deployment_journal_error(format!(
            "Program {} 或 ProgramData {} 已在签名历史 slot {} 之后出现；保持 attempt 活动状态并中止本次恢复",
            program_id, programdata_address, min_context_slot
        )));
    }
    Ok(())
}

fn deployment_attempt_is_active(status: &str) -> bool {
    matches!(
        status,
        wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED
            | wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED
            | wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION
    )
}

fn deployment_attempt_is_blocking_terminal(status: &str) -> bool {
    matches!(
        status,
        wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED
            | wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED_FAILED
    )
}

fn new_program_deployment_attempt(
    record: &wallet_store::ProgramDeploymentRecord,
    stage: &str,
    chunk_index: Option<usize>,
    signature: &Signature,
    last_valid_block_height: u64,
) -> wallet_store::ProgramDeploymentAttemptRecord {
    wallet_store::ProgramDeploymentAttemptRecord {
        genesis_hash: record.genesis_hash.clone(),
        program_id: record.program_id.clone(),
        stage: stage.to_string(),
        buffer_address: record.buffer_address.clone(),
        chunk_index,
        signature: signature.to_string(),
        last_valid_block_height,
        status: wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED.to_string(),
        created_at: 0,
        updated_at: 0,
    }
}

fn validate_program_deployment_attempt_record(
    record: &wallet_store::ProgramDeploymentRecord,
    attempt: &wallet_store::ProgramDeploymentAttemptRecord,
) -> Result<(), ApiError> {
    let shape_is_valid = match attempt.stage.as_str() {
        wallet_store::PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER
        | wallet_store::PROGRAM_DEPLOYMENT_STAGE_DEPLOY => attempt.chunk_index.is_none(),
        wallet_store::PROGRAM_DEPLOYMENT_STAGE_WRITE => attempt.chunk_index.is_some(),
        _ => false,
    };
    let status_is_valid = deployment_attempt_is_active(&attempt.status)
        || deployment_attempt_is_blocking_terminal(&attempt.status)
        || attempt.status == wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT;
    let signature_is_valid = Signature::from_str(&attempt.signature).is_ok_and(|signature| {
        signature != Signature::default() && signature.to_string() == attempt.signature
    });
    let buffer_is_valid = Pubkey::from_str(&attempt.buffer_address).is_ok_and(|buffer| {
        buffer != Pubkey::default() && buffer.to_string() == attempt.buffer_address
    });
    if attempt.genesis_hash != record.genesis_hash
        || attempt.program_id != record.program_id
        || !shape_is_valid
        || !status_is_valid
        || (attempt.buffer_address != record.buffer_address
            && !(attempt.status == wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT
                && attempt.stage == wallet_store::PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER))
        || !signature_is_valid
        || !buffer_is_valid
        || attempt.last_valid_block_height == 0
        || attempt.created_at == 0
        || attempt.updated_at < attempt.created_at
    {
        return Err(deployment_journal_error(format!(
            "Program {} 包含无效或不一致的 attempt 证据 {}，拒绝继续",
            record.program_id, attempt.signature
        )));
    }
    Ok(())
}

fn begin_deployment_attempt(
    journal: &mut Option<wallet_store::ProgramDeploymentRecord>,
    attempt: wallet_store::ProgramDeploymentAttemptRecord,
    journal_status: &str,
    completed_writes: usize,
) -> Result<(), ApiError> {
    let current = journal.as_ref().ok_or_else(|| ApiError {
        message: "部署 journal 不存在，拒绝记录签名 attempt".to_string(),
    })?;
    let updated = wallet_store::begin_program_deployment_attempt(
        current,
        attempt,
        journal_status,
        completed_writes,
    )
    .map_err(|message| ApiError { message })?;
    *journal = Some(updated);
    Ok(())
}

fn transition_deployment_attempt(
    journal: &mut Option<wallet_store::ProgramDeploymentRecord>,
    signature: &str,
    expected_attempt_status: &str,
    next_attempt_status: &str,
    journal_status: &str,
    completed_writes: usize,
) -> Result<(), ApiError> {
    let current = journal.as_ref().ok_or_else(|| ApiError {
        message: "部署 journal 不存在，拒绝迁移签名 attempt".to_string(),
    })?;
    let updated = wallet_store::transition_program_deployment_attempt(
        current,
        signature,
        expected_attempt_status,
        next_attempt_status,
        journal_status,
        completed_writes,
    )
    .map_err(|message| ApiError { message })?;
    *journal = Some(updated);
    Ok(())
}

fn reconcile_absent_deployment_attempt<F>(
    client: &RpcClient,
    journal: &mut Option<wallet_store::ProgramDeploymentRecord>,
    attempt: &wallet_store::ProgramDeploymentAttemptRecord,
    journal_status: &str,
    completed_writes: usize,
    confirm_absent: F,
) -> Result<bool, ApiError>
where
    F: FnOnce(&RpcClient, u64) -> Result<(), ApiError>,
{
    let stage_context = attempt
        .chunk_index
        .map(|index| format!("{} chunk {}", attempt.stage, index))
        .unwrap_or_else(|| attempt.stage.clone());
    let decision = gate_expired_absent_with(
        inspect_deployment_attempt_expiry(client, attempt)?,
        |min_context_slot| confirm_absent(client, min_context_slot),
    )?;
    match decision {
        DeploymentAttemptExpiryDecision::ExpiredAbsent { .. } => {
            transition_deployment_attempt(
                journal,
                &attempt.signature,
                &attempt.status,
                wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT,
                journal_status,
                completed_writes,
            )?;
            Ok(true)
        }
        DeploymentAttemptExpiryDecision::FinalizedSucceeded => {
            transition_deployment_attempt(
                journal,
                &attempt.signature,
                &attempt.status,
                wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED,
                journal_status,
                completed_writes,
            )?;
            Err(deployment_journal_error(format!(
                "{} 签名 {} 已 finalized 成功，但对应业务状态缺失；已持久化冲突并禁止自动重签",
                stage_context, attempt.signature
            )))
        }
        DeploymentAttemptExpiryDecision::FinalizedFailed(error) => {
            transition_deployment_attempt(
                journal,
                &attempt.signature,
                &attempt.status,
                wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED_FAILED,
                journal_status,
                completed_writes,
            )?;
            Err(deployment_journal_error(format!(
                "{} 签名 {} 已 finalized 失败（{}）；已持久化终态，禁止自动重签",
                stage_context, attempt.signature, error
            )))
        }
        DeploymentAttemptExpiryDecision::NotExpired => Err(deployment_journal_error(format!(
            "{} 签名 {} 尚未越过 last valid block height {}，不得自动重签",
            stage_context, attempt.signature, attempt.last_valid_block_height
        ))),
        DeploymentAttemptExpiryDecision::HistoryContextTooOld {
            expiry_observation_slot,
            history_context_slot,
        } => Err(deployment_journal_error(format!(
            "{} 签名 {} 的历史上下文 slot {} 早于过期观测 slot {}；RPC 后端视图不一致，拒绝自动重签",
            stage_context, attempt.signature, history_context_slot, expiry_observation_slot
        ))),
        DeploymentAttemptExpiryDecision::SeenButNotFinalized => {
            Err(deployment_journal_error(format!(
                "{} 签名 {} 仍可在历史中观察到但尚未 finalized，不得自动重签",
                stage_context, attempt.signature
            )))
        }
    }
}

fn deployment_journal_error(message: impl Into<String>) -> ApiError {
    ApiError {
        message: format!("部署 journal 冲突: {}", message.into()),
    }
}

type DeploymentReceiptEvidence = (
    Option<u64>,
    Option<u32>,
    Vec<wallet_store::ProgramDeploymentAttemptRecord>,
);

fn load_deployment_receipt_evidence(
    journal: Option<&wallet_store::ProgramDeploymentRecord>,
) -> Result<DeploymentReceiptEvidence, ApiError> {
    let Some(record) = journal else {
        return Ok((None, None, Vec::new()));
    };
    let attempts =
        wallet_store::load_program_deployment_attempts(&record.genesis_hash, &record.program_id)
            .map_err(|message| ApiError { message })?;
    for attempt in &attempts {
        validate_program_deployment_attempt_record(record, attempt)?;
    }
    Ok((
        Some(record.revision),
        Some(record.attempt_evidence_version),
        attempts,
    ))
}

#[allow(clippy::too_many_arguments)]
fn validate_deployment_journal_binding(
    record: &wallet_store::ProgramDeploymentRecord,
    genesis_hash: &str,
    program_id: &Pubkey,
    program_sha256: &str,
    program_len: usize,
    max_data_len: usize,
    upgrade_authority: &Pubkey,
    requested_buffer: Option<&Pubkey>,
) -> Result<Pubkey, ApiError> {
    let expected_program_id = program_id.to_string();
    let expected_upgrade_authority = upgrade_authority.to_string();
    if record.genesis_hash != genesis_hash
        || record.program_id != expected_program_id
        || record.program_sha256 != program_sha256
        || record.program_len != program_len
        || record.max_data_len != max_data_len
        || record.upgrade_authority != expected_upgrade_authority
    {
        return Err(deployment_journal_error(format!(
            "Program {} 已有不同的部署意图，拒绝复用或覆盖；已记录 artifact={} len={} max_len={} upgrade_authority={}",
            program_id,
            record.program_sha256,
            record.program_len,
            record.max_data_len,
            record.upgrade_authority,
        )));
    }

    let stored_buffer = Pubkey::from_str(record.buffer_address.trim()).map_err(|_| {
        deployment_journal_error(format!(
            "Program {} 已记录无效 Buffer 地址 {}",
            program_id, record.buffer_address
        ))
    })?;
    if stored_buffer == Pubkey::default() || record.buffer_address != stored_buffer.to_string() {
        return Err(deployment_journal_error(format!(
            "Program {} 已记录非 canonical Buffer 地址 {}",
            program_id, record.buffer_address
        )));
    }
    if record.created_at == 0 || record.updated_at < record.created_at {
        return Err(deployment_journal_error(format!(
            "Program {} 的部署 journal 时间戳无效",
            program_id
        )));
    }
    if requested_buffer.is_some_and(|requested| requested != &stored_buffer) {
        return Err(deployment_journal_error(format!(
            "请求恢复的 Buffer 与已记录 Buffer {} 不一致",
            stored_buffer
        )));
    }
    Ok(stored_buffer)
}

fn deployment_status_is_known(status: &str) -> bool {
    matches!(
        status,
        DEPLOYMENT_STATUS_CREATE_BUFFER_SIGNED
            | DEPLOYMENT_STATUS_CREATE_BUFFER_RECONCILE
            | DEPLOYMENT_STATUS_BUFFER_READY
            | DEPLOYMENT_STATUS_WRITE_SIGNED
            | DEPLOYMENT_STATUS_WRITE_CONFIRMED
            | DEPLOYMENT_STATUS_WRITE_RECONCILE
            | DEPLOYMENT_STATUS_BUFFER_FINALIZED
            | DEPLOYMENT_STATUS_DEPLOY_SIGNED
            | DEPLOYMENT_STATUS_DEPLOY_RECONCILE
            | DEPLOYMENT_STATUS_DEPLOY_FINALIZED
            | DEPLOYMENT_STATUS_FINALIZED
    )
}

#[allow(clippy::too_many_arguments)]
fn update_deployment_journal(
    record: &wallet_store::ProgramDeploymentRecord,
    status: &str,
    create_signature: Option<&str>,
    create_last_valid_block_height: Option<u64>,
    last_write_signature: Option<&str>,
    last_write_chunk_index: Option<usize>,
    last_write_last_valid_block_height: Option<u64>,
    completed_writes: usize,
    deploy_signature: Option<&str>,
    deploy_last_valid_block_height: Option<u64>,
) -> Result<wallet_store::ProgramDeploymentRecord, ApiError> {
    wallet_store::update_program_deployment_progress(
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
    .map_err(|message| ApiError { message })
}

#[allow(clippy::too_many_arguments)]
fn transition_deployment_journal(
    journal: &mut Option<wallet_store::ProgramDeploymentRecord>,
    status: &str,
    create_signature: Option<&str>,
    create_last_valid_block_height: Option<u64>,
    last_write_signature: Option<&str>,
    last_write_chunk_index: Option<usize>,
    last_write_last_valid_block_height: Option<u64>,
    completed_writes: usize,
    deploy_signature: Option<&str>,
    deploy_last_valid_block_height: Option<u64>,
) -> Result<(), ApiError> {
    let current = journal.as_ref().ok_or_else(|| ApiError {
        message: "部署 journal 不存在，拒绝更新部署状态".to_string(),
    })?;
    let updated = update_deployment_journal(
        current,
        status,
        create_signature,
        create_last_valid_block_height,
        last_write_signature,
        last_write_chunk_index,
        last_write_last_valid_block_height,
        completed_writes,
        deploy_signature,
        deploy_last_valid_block_height,
    )?;
    *journal = Some(updated);
    Ok(())
}

#[cfg(test)]
mod deployment_journal_tests {
    use super::*;

    #[test]
    fn program_upgrade_requires_squads_member() {
        let signer = Pubkey::new_unique();
        let multisig = SquadsMultisig {
            create_key: Pubkey::new_unique(),
            config_authority: Pubkey::default(),
            threshold: 1,
            time_lock: 0,
            transaction_index: 0,
            stale_transaction_index: 0,
            rent_collector: None,
            bump: 0,
            members: vec![SquadsMember {
                key: signer,
                permissions: squads_v4::Permissions::all(),
            }],
        };
        assert!(require_squads_member(&multisig, &signer).is_ok());
        assert!(require_squads_member(&multisig, &Pubkey::new_unique()).is_err());
    }

    #[test]
    fn parses_programdata_upgrade_authority() {
        let authority = Pubkey::new_unique();
        let mut data = bincode::serialize(&UpgradeableLoaderState::ProgramData {
            slot: 42,
            upgrade_authority_address: Some(authority),
        })
        .unwrap();
        data.resize(UpgradeableLoaderState::size_of_programdata_metadata(), 0);
        assert_eq!(
            loader_upgrade_authority_from_programdata(&data).unwrap(),
            authority
        );

        let mut immutable = bincode::serialize(&UpgradeableLoaderState::ProgramData {
            slot: 42,
            upgrade_authority_address: None,
        })
        .unwrap();
        immutable.resize(UpgradeableLoaderState::size_of_programdata_metadata(), 0);
        assert!(loader_upgrade_authority_from_programdata(&immutable).is_err());
    }

    #[test]
    fn programdata_extension_plan_expands_to_required_program_size() {
        let metadata_len = UpgradeableLoaderState::size_of_programdata_metadata();
        let previous_capacity = 512 * 1024;
        let plan = programdata_extension_plan(metadata_len + previous_capacity, 600_000)
            .unwrap()
            .unwrap();
        assert_eq!(plan.previous_capacity, previous_capacity);
        assert_eq!(plan.additional_bytes, 81_920);
        assert_eq!(plan.new_capacity, 606_208);
    }

    #[test]
    fn programdata_extension_plan_uses_cluster_minimum_increment() {
        let metadata_len = UpgradeableLoaderState::size_of_programdata_metadata();
        let previous_capacity = 512 * 1024;
        let plan =
            programdata_extension_plan(metadata_len + previous_capacity, previous_capacity + 1)
                .unwrap()
                .unwrap();
        assert_eq!(
            plan.additional_bytes,
            PROGRAMDATA_MINIMUM_EXTENSION_BYTES as u32
        );
        assert_eq!(plan.new_capacity, previous_capacity + 10_240);
    }

    #[test]
    fn programdata_extension_plan_uses_one_transaction_for_large_extension() {
        let metadata_len = UpgradeableLoaderState::size_of_programdata_metadata();
        let previous_capacity = 1024 * 1024;
        let plan = programdata_extension_plan(
            metadata_len + previous_capacity,
            previous_capacity + 50_000,
        )
        .unwrap()
        .unwrap();
        assert_eq!(plan.additional_bytes, 51_200);
        assert_eq!(plan.new_capacity, previous_capacity + 51_200);
    }

    #[test]
    fn programdata_extension_plan_handles_existing_partial_capacity() {
        let metadata_len = UpgradeableLoaderState::size_of_programdata_metadata();
        let previous_capacity = 600_000;
        let plan =
            programdata_extension_plan(metadata_len + previous_capacity, previous_capacity + 1)
                .unwrap()
                .unwrap();
        assert_eq!(plan.previous_capacity, previous_capacity);
        assert_eq!(plan.additional_bytes, 10_240);
        assert_eq!(plan.new_capacity, previous_capacity + 10_240);
    }

    #[test]
    fn programdata_extension_plan_skips_sufficient_capacity() {
        let metadata_len = UpgradeableLoaderState::size_of_programdata_metadata();
        let existing_capacity = 512 * 1024;
        assert_eq!(
            programdata_extension_plan(metadata_len + existing_capacity, existing_capacity)
                .unwrap(),
            None
        );
    }

    #[test]
    fn programdata_extension_plan_uses_protocol_maximum_for_small_final_chunk() {
        let metadata_len = UpgradeableLoaderState::size_of_programdata_metadata();
        let max_account_len = MAX_PERMITTED_DATA_LENGTH as usize;
        let max_program_len = max_account_len - metadata_len;
        let plan = programdata_extension_plan(max_account_len - 4_760, max_program_len)
            .unwrap()
            .unwrap();
        assert_eq!(plan.additional_bytes, 4_760);
        assert_eq!(plan.new_account_len, max_account_len);
        assert_eq!(plan.new_capacity, max_program_len);
    }

    #[test]
    fn programdata_extension_plan_rejects_program_over_protocol_limit() {
        let metadata_len = UpgradeableLoaderState::size_of_programdata_metadata();
        let max_program_len = MAX_PERMITTED_DATA_LENGTH as usize - metadata_len;
        let error = programdata_extension_plan(metadata_len + 1, max_program_len + 1).unwrap_err();
        assert!(error.contains("超过 Solana Upgradeable Loader 上限"));
    }

    #[test]
    fn program_size_limit_is_derived_from_solana_protocol_constants() {
        assert_eq!(PROGRAMDATA_MINIMUM_EXTENSION_BYTES, 10_240);
        assert_eq!(MAX_PROGRAM_SO_BYTES, 10_485_715);
        assert_eq!(
            MAX_PROGRAM_SO_BYTES + UpgradeableLoaderState::size_of_programdata_metadata(),
            MAX_PERMITTED_DATA_LENGTH as usize
        );
    }

    #[test]
    fn preflight_rejection_is_known_not_to_have_been_submitted() {
        let simulation = serde_json::from_value(json!({ "err": null })).unwrap();
        let preflight_error =
            ClientError::from(ClientErrorKind::RpcError(RpcError::RpcResponseError {
                code: -32002,
                message: "Transaction simulation failed".to_string(),
                data: RpcResponseErrorData::SendTransactionPreflightFailure(simulation),
            }));
        assert!(send_error_is_preflight_rejection(&preflight_error));

        let ambiguous_error = ClientError::from(ClientErrorKind::RpcError(
            RpcError::RpcRequestError("connection reset".to_string()),
        ));
        assert!(!send_error_is_preflight_rejection(&ambiguous_error));
    }

    fn record(
        program_id: &Pubkey,
        authority: &Pubkey,
        buffer: &Pubkey,
    ) -> wallet_store::ProgramDeploymentRecord {
        wallet_store::ProgramDeploymentRecord {
            genesis_hash: "devnet-genesis".to_string(),
            program_id: program_id.to_string(),
            program_sha256: "11".repeat(32),
            program_len: 1024,
            max_data_len: 2048,
            upgrade_authority: authority.to_string(),
            buffer_address: buffer.to_string(),
            status: DEPLOYMENT_STATUS_BUFFER_READY.to_string(),
            create_signature: Some(Signature::new_unique().to_string()),
            create_last_valid_block_height: Some(42),
            last_write_signature: None,
            last_write_chunk_index: None,
            last_write_last_valid_block_height: None,
            completed_writes: 0,
            deploy_signature: None,
            deploy_last_valid_block_height: None,
            attempt_evidence_version: wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION,
            revision: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn journal_binding_accepts_only_the_recorded_deployment_intent() {
        let program_id = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let buffer = Pubkey::new_unique();
        let record = record(&program_id, &authority, &buffer);

        let stored_buffer = validate_deployment_journal_binding(
            &record,
            "devnet-genesis",
            &program_id,
            &"11".repeat(32),
            1024,
            2048,
            &authority,
            Some(&buffer),
        )
        .unwrap();
        assert_eq!(stored_buffer, buffer);

        assert!(validate_deployment_journal_binding(
            &record,
            "devnet-genesis",
            &program_id,
            &"22".repeat(32),
            1024,
            2048,
            &authority,
            Some(&buffer),
        )
        .is_err());
        assert!(validate_deployment_journal_binding(
            &record,
            "devnet-genesis",
            &program_id,
            &"11".repeat(32),
            1024,
            2048,
            &authority,
            Some(&Pubkey::new_unique()),
        )
        .is_err());
        let mut noncanonical_buffer = record.clone();
        noncanonical_buffer.buffer_address.push(' ');
        assert!(validate_deployment_journal_binding(
            &noncanonical_buffer,
            "devnet-genesis",
            &program_id,
            &"11".repeat(32),
            1024,
            2048,
            &authority,
            None,
        )
        .is_err());
        let mut zero_buffer = record.clone();
        zero_buffer.buffer_address = Pubkey::default().to_string();
        assert!(validate_deployment_journal_binding(
            &zero_buffer,
            "devnet-genesis",
            &program_id,
            &"11".repeat(32),
            1024,
            2048,
            &authority,
            None,
        )
        .is_err());
        let mut invalid_timestamps = record.clone();
        invalid_timestamps.updated_at = 0;
        assert!(validate_deployment_journal_binding(
            &invalid_timestamps,
            "devnet-genesis",
            &program_id,
            &"11".repeat(32),
            1024,
            2048,
            &authority,
            None,
        )
        .is_err());
    }

    #[test]
    fn journal_status_allowlist_rejects_unknown_states() {
        assert!(deployment_status_is_known(
            DEPLOYMENT_STATUS_CREATE_BUFFER_SIGNED
        ));
        assert!(deployment_status_is_known(
            DEPLOYMENT_STATUS_WRITE_CONFIRMED
        ));
        assert!(deployment_status_is_known(DEPLOYMENT_STATUS_FINALIZED));
        assert!(!deployment_status_is_known("retry_everything"));
    }

    #[test]
    fn expiry_classifier_requires_strict_finalized_height_and_absent_history() {
        assert_eq!(
            classify_deployment_attempt_expiry(41, 42, None, 100, 101),
            DeploymentAttemptExpiryDecision::NotExpired
        );
        assert_eq!(
            classify_deployment_attempt_expiry(42, 42, None, 101, 102),
            DeploymentAttemptExpiryDecision::NotExpired
        );
        assert_eq!(
            classify_deployment_attempt_expiry(43, 42, None, 102, 102),
            DeploymentAttemptExpiryDecision::ExpiredAbsent {
                min_context_slot: 102
            }
        );
    }

    #[test]
    fn expiry_classifier_rejects_history_older_than_expiry_observation() {
        let decision = classify_deployment_attempt_expiry(43, 42, None, 499, 500);
        assert_eq!(
            decision,
            DeploymentAttemptExpiryDecision::HistoryContextTooOld {
                expiry_observation_slot: 500,
                history_context_slot: 499,
            }
        );
        let gated = gate_expired_absent_with(decision, |_| {
            panic!("stale history must not reach business-state readback")
        })
        .unwrap();
        assert!(matches!(
            gated,
            DeploymentAttemptExpiryDecision::HistoryContextTooOld { .. }
        ));
    }

    #[test]
    fn expired_absent_gate_passes_exact_history_slot_once() {
        let observed_slot = std::cell::Cell::new(None);
        let decision = gate_expired_absent_with(
            DeploymentAttemptExpiryDecision::ExpiredAbsent {
                min_context_slot: 987,
            },
            |slot| {
                assert!(observed_slot.replace(Some(slot)).is_none());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(observed_slot.get(), Some(987));
        assert_eq!(
            decision,
            DeploymentAttemptExpiryDecision::ExpiredAbsent {
                min_context_slot: 987
            }
        );
    }

    #[test]
    fn expired_absent_gate_fails_before_authorizing_transition() {
        let transition_authorized = std::cell::Cell::new(false);
        let result = gate_expired_absent_with(
            DeploymentAttemptExpiryDecision::ExpiredAbsent {
                min_context_slot: 654,
            },
            |slot| {
                assert_eq!(slot, 654);
                Err(deployment_journal_error("二次业务回读已前进"))
            },
        );
        if result.is_ok() {
            transition_authorized.set(true);
        }
        assert!(result.is_err());
        assert!(!transition_authorized.get());

        let non_expired =
            gate_expired_absent_with(DeploymentAttemptExpiryDecision::NotExpired, |_| {
                panic!("non-expired decision must not run the absence callback")
            })
            .unwrap();
        assert_eq!(non_expired, DeploymentAttemptExpiryDecision::NotExpired);
    }

    #[test]
    fn recovery_account_config_is_finalized_and_history_slot_bound() {
        let config = finalized_recovery_account_config(321);
        assert_eq!(config.encoding, Some(UiAccountEncoding::Base64Zstd));
        assert_eq!(config.commitment, Some(CommitmentConfig::finalized()));
        assert_eq!(config.min_context_slot, Some(321));
        assert!(config.data_slice.is_none());
    }

    #[test]
    fn recovery_account_decode_failure_is_not_treated_as_absence() {
        let address = Pubkey::new_unique();
        let malformed = UiAccount {
            lamports: 1,
            data: UiAccountData::Binary(
                "not-valid-base64-zstd".to_string(),
                UiAccountEncoding::Base64Zstd,
            ),
            owner: Pubkey::new_unique().to_string(),
            executable: false,
            rent_epoch: 0,
            space: None,
        };
        let error = decode_recovery_ui_account(&address, malformed).unwrap_err();
        assert!(error.message.contains("拒绝将其视为不存在"));
    }

    #[test]
    fn write_recovery_requires_the_exact_chunk_and_unchanged_snapshot() {
        let initial = program_deploy::BufferWritePlan {
            completed_chunks: 1,
            pending_chunk_indexes: vec![1, 2],
        };
        let unchanged = program_deploy::BufferWritePlan {
            completed_chunks: 1,
            pending_chunk_indexes: vec![1, 2],
        };
        assert!(validate_write_attempt_recovery_snapshot(&initial, &unchanged, 2).is_ok());
        assert!(validate_write_attempt_recovery_snapshot(&initial, &unchanged, 0).is_err());

        let advanced_other_chunk = program_deploy::BufferWritePlan {
            completed_chunks: 2,
            pending_chunk_indexes: vec![2],
        };
        assert!(
            validate_write_attempt_recovery_snapshot(&initial, &advanced_other_chunk, 2).is_err()
        );

        let target_completed = program_deploy::BufferWritePlan {
            completed_chunks: 2,
            pending_chunk_indexes: vec![1],
        };
        assert!(validate_write_attempt_recovery_snapshot(&initial, &target_completed, 2).is_err());
    }

    #[test]
    fn expiry_classifier_blocks_every_observed_history_state() {
        let non_finalized = TransactionStatus {
            slot: 1,
            confirmations: Some(1),
            status: Ok(()),
            err: None,
            confirmation_status: None,
        };
        assert_eq!(
            classify_deployment_attempt_expiry(43, 42, Some(&non_finalized), 200, 199),
            DeploymentAttemptExpiryDecision::SeenButNotFinalized
        );

        let finalized_success = TransactionStatus {
            slot: 2,
            confirmations: None,
            status: Ok(()),
            err: None,
            confirmation_status: None,
        };
        assert_eq!(
            classify_deployment_attempt_expiry(43, 42, Some(&finalized_success), 201, 200),
            DeploymentAttemptExpiryDecision::FinalizedSucceeded
        );

        let transaction_error = solana_sdk::transaction::TransactionError::AccountNotFound;
        let finalized_failure = TransactionStatus {
            slot: 3,
            confirmations: None,
            status: Err(transaction_error.clone()),
            err: Some(transaction_error),
            confirmation_status: None,
        };
        assert_eq!(
            classify_deployment_attempt_expiry(43, 42, Some(&finalized_failure), 202, 201),
            DeploymentAttemptExpiryDecision::FinalizedFailed("AccountNotFound".to_string())
        );
    }

    #[test]
    fn malformed_attempt_evidence_is_rejected_before_recovery() {
        let program_id = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let buffer = Pubkey::new_unique();
        let record = record(&program_id, &authority, &buffer);
        let attempt = wallet_store::ProgramDeploymentAttemptRecord {
            genesis_hash: record.genesis_hash.clone(),
            program_id: record.program_id.clone(),
            stage: wallet_store::PROGRAM_DEPLOYMENT_STAGE_WRITE.to_string(),
            buffer_address: record.buffer_address.clone(),
            chunk_index: Some(0),
            signature: Signature::new_unique().to_string(),
            last_valid_block_height: 42,
            status: wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED.to_string(),
            created_at: 1,
            updated_at: 1,
        };
        assert!(validate_program_deployment_attempt_record(&record, &attempt).is_ok());

        let mut invalid_signature = attempt.clone();
        invalid_signature.signature = "not-a-signature".to_string();
        let mut default_signature = attempt.clone();
        default_signature.signature = Signature::default().to_string();
        let mut noncanonical_signature = attempt.clone();
        noncanonical_signature.signature.push(' ');
        let mut zero_buffer = attempt.clone();
        zero_buffer.buffer_address = Pubkey::default().to_string();
        let mut noncanonical_buffer = attempt.clone();
        noncanonical_buffer.buffer_address.push(' ');
        let mut zero_height = attempt.clone();
        zero_height.last_valid_block_height = 0;
        let mut zero_created_at = attempt.clone();
        zero_created_at.created_at = 0;
        let mut reversed_timestamps = attempt.clone();
        reversed_timestamps.updated_at = 0;
        for invalid in [
            invalid_signature,
            default_signature,
            noncanonical_signature,
            zero_buffer,
            noncanonical_buffer,
            zero_height,
            zero_created_at,
            reversed_timestamps,
        ] {
            assert!(validate_program_deployment_attempt_record(&record, &invalid).is_err());
        }
    }

    #[test]
    fn generic_deploy_request_rejects_unknown_policy_fields() {
        let request = serde_json::from_value::<DeployProgramRequest>(serde_json::json!({
            "program_keypair_json": "[]",
            "expected_program_id": Pubkey::new_unique().to_string(),
            "expected_upgrade_authority": Pubkey::new_unique().to_string(),
            "expected_genesis_hash": solana_sdk::hash::Hash::new_unique().to_string(),
            "expected_program_sha256": "11".repeat(32),
            "program_so_base64": "f0VMRg==",
            "network": "devnet",
            "require_authenticated_keystore": true
        }));

        assert!(request.is_err());
    }

    #[test]
    fn canonical_program_id_uses_generic_journal_rules() {
        let program_id = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let buffer = Pubkey::new_unique();
        let record = record(&program_id, &authority, &buffer);

        assert_eq!(
            validate_deployment_journal_binding(
                &record,
                "devnet-genesis",
                &program_id,
                &"11".repeat(32),
                1024,
                2048,
                &authority,
                Some(&buffer),
            )
            .unwrap(),
            buffer
        );
    }

    #[test]
    fn deployment_capacity_errors_have_retryable_http_statuses() {
        assert_eq!(
            ApiError {
                message: PROGRAM_DEPLOY_BUSY_MESSAGE.to_string(),
            }
            .status_code(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            ApiError {
                message: SBF_VERIFY_BUSY_MESSAGE.to_string(),
            }
            .status_code(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }
}

#[derive(Deserialize)]
struct ProgramDeploySourceRequest {
    source_dir: String,
    #[serde(default)]
    build: bool,
    #[serde(default)]
    confirm_untrusted_build: bool,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Serialize)]
struct ProgramDeploySourceResponse {
    source_dir: String,
    built: bool,
    build_status: Option<String>,
    build_job_id: Option<String>,
    build_error: Option<String>,
    build_command: Option<String>,
    build_template: Option<String>,
    build_stdout: Option<String>,
    build_stderr: Option<String>,
    program_so_path: Option<String>,
    program_so_name: Option<String>,
    program_so_base64: Option<String>,
    program_so_sha256: Option<String>,
    program_so_size: Option<usize>,
    program_keypair_path: Option<String>,
    expected_program_id: Option<String>,
    manifest_program_id: Option<String>,
    manifest_network: Option<String>,
    manifest_genesis_hash: Option<String>,
    manifest_upgrade_authority: Option<String>,
    manifest_owner_admin: Option<String>,
    manifest_operational_admin: Option<String>,
    build_available: bool,
    build_blocked_reason: Option<String>,
    source_validation_errors: Vec<String>,
    warnings: Vec<String>,
}

struct ProgramSourceArtifacts {
    program_so_path: Option<PathBuf>,
    program_so_name: Option<String>,
    program_so_base64: Option<String>,
    program_so_sha256: Option<String>,
    program_so_size: Option<usize>,
    program_keypair_path: Option<PathBuf>,
    expected_program_id: Option<String>,
    manifest_program_id: Option<String>,
    manifest_network: Option<String>,
    manifest_genesis_hash: Option<String>,
    manifest_upgrade_authority: Option<String>,
    manifest_owner_admin: Option<String>,
    manifest_operational_admin: Option<String>,
    source_validation_errors: Vec<String>,
    warnings: Vec<String>,
}

struct ProgramIdDeclaration {
    label: String,
    program_id: String,
}

#[derive(Clone)]
struct ProgramSourceBuildJob {
    source_dir: PathBuf,
    status: String,
    build_command: Option<String>,
    build_template: Option<String>,
    build_stdout: Option<String>,
    build_stderr: Option<String>,
    build_error: Option<String>,
    warnings: Vec<String>,
}

fn program_source_build_jobs(
) -> &'static Arc<tokio::sync::Mutex<HashMap<String, ProgramSourceBuildJob>>> {
    PROGRAM_SOURCE_BUILD_JOBS.get_or_init(|| Arc::new(tokio::sync::Mutex::new(HashMap::new())))
}

fn program_source_error(message: impl Into<String>) -> ApiError {
    ApiError {
        message: message.into(),
    }
}

fn canonical_child_path(root: &FsPath, path: &FsPath, label: &str) -> Result<PathBuf, ApiError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| program_source_error(format!("读取 {label} 路径失败: {error}")))?;
    if !canonical.starts_with(root) {
        return Err(program_source_error(format!("{label} 必须位于源码目录内")));
    }
    Ok(canonical)
}

fn read_text_file_limited(
    path: &FsPath,
    max_bytes: usize,
    label: &str,
) -> Result<String, ApiError> {
    let metadata = fs::metadata(path)
        .map_err(|error| program_source_error(format!("读取 {label} 元数据失败: {error}")))?;
    if !metadata.is_file() {
        return Err(program_source_error(format!("{label} 不是普通文件")));
    }
    if metadata.len() > max_bytes as u64 {
        return Err(program_source_error(format!("{label} 文件过大")));
    }
    fs::read_to_string(path)
        .map_err(|error| program_source_error(format!("读取 {label} 失败: {error}")))
}

fn read_bytes_file_limited(
    path: &FsPath,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, ApiError> {
    let metadata = fs::metadata(path)
        .map_err(|error| program_source_error(format!("读取 {label} 元数据失败: {error}")))?;
    if !metadata.is_file() {
        return Err(program_source_error(format!("{label} 不是普通文件")));
    }
    if metadata.len() == 0 || metadata.len() > max_bytes as u64 {
        return Err(program_source_error(format!("{label} 大小无效")));
    }
    fs::read(path).map_err(|error| program_source_error(format!("读取 {label} 失败: {error}")))
}

fn first_existing_path_owned(root: &FsPath, candidates: &[String]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(|relative| root.join(relative))
        .filter_map(|path| canonical_child_path(root, &path, "候选产物").ok())
        .find(|path| path.is_file())
}

fn first_json_file(root: &FsPath, directory: &FsPath) -> Option<PathBuf> {
    fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter_map(|path| canonical_child_path(root, &path, "JSON 产物").ok())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        })
        .min()
}

fn file_modified_time_key(path: &FsPath) -> SystemTime {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn newest_file(paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths.into_iter().max_by(|left, right| {
        file_modified_time_key(left)
            .cmp(&file_modified_time_key(right))
            .then_with(|| left.cmp(right))
    })
}

fn so_file_paths(root: &FsPath, directory: &FsPath) -> Vec<PathBuf> {
    fs::read_dir(directory)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .map(|entry| entry.path())
        .filter_map(|path| canonical_child_path(root, &path, ".so 产物").ok())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("so"))
        })
        .collect()
}

fn newest_existing_path_owned(root: &FsPath, candidates: &[String]) -> Option<PathBuf> {
    newest_file(
        candidates
            .iter()
            .map(|relative| root.join(relative))
            .filter_map(|path| canonical_child_path(root, &path, "候选产物").ok())
            .filter(|path| path.is_file())
            .collect(),
    )
}

fn newest_build_metadata_file(root: &FsPath, directory: &FsPath) -> Option<PathBuf> {
    newest_file(
        fs::read_dir(directory)
            .ok()?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter_map(|path| canonical_child_path(root, &path, "build metadata").ok())
            .filter(|path| {
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    return false;
                };
                path.is_file() && name.ends_with("-build.json")
            })
            .collect(),
    )
}

fn safe_artifact_stem(value: &str) -> Option<String> {
    let stem = value.trim().replace('-', "_");
    if stem.is_empty()
        || stem.len() > 128
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return None;
    }
    Some(stem)
}

fn artifact_stem_from_so_name(value: &str) -> Option<String> {
    let name = value.trim();
    let stem = name
        .strip_suffix(".so")
        .or_else(|| name.strip_suffix(".SO"))
        .or_else(|| {
            name.rsplit_once('.').and_then(|(stem, ext)| {
                if ext.eq_ignore_ascii_case("so") {
                    Some(stem)
                } else {
                    None
                }
            })
        })
        .unwrap_or(name);
    safe_artifact_stem(stem)
}

fn parse_quoted_toml_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        return rest
            .split_once('"')
            .map(|(value, _)| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
    trimmed
        .split('#')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_anchor_program_name(root: &FsPath) -> Option<String> {
    let anchor = fs::read_to_string(root.join("Anchor.toml")).ok()?;
    let mut in_programs_section = false;
    for line in anchor.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_programs_section = trimmed.starts_with("[programs.");
            continue;
        }
        if !in_programs_section || trimmed.starts_with('#') || !trimmed.contains('=') {
            continue;
        }
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        let Some(program_id) = parse_quoted_toml_value(value) else {
            continue;
        };
        if Pubkey::from_str(&program_id).is_ok() {
            if let Some(stem) = safe_artifact_stem(name) {
                return Some(stem);
            }
        }
    }
    None
}

fn parse_cargo_package_name(root: &FsPath) -> Option<String> {
    let cargo = fs::read_to_string(root.join("Cargo.toml")).ok()?;
    let mut in_package_section = false;
    for line in cargo.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_package_section = trimmed == "[package]";
            continue;
        }
        if !in_package_section || trimmed.starts_with('#') {
            continue;
        }
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name.trim() != "name" {
            continue;
        }
        let package_name = parse_quoted_toml_value(value)?;
        return safe_artifact_stem(&package_name);
    }
    None
}

fn detect_program_artifact_stem(root: &FsPath) -> Option<String> {
    parse_anchor_program_name(root).or_else(|| parse_cargo_package_name(root))
}

fn find_program_so_path(root: &FsPath, artifact_stem: Option<&str>) -> Option<PathBuf> {
    // Anchor's canonical deploy artifacts live under target/deploy/:
    //   target/deploy/<program_name>.so
    //   target/deploy/<program_name>-keypair.json
    // Prefer that pair so the .so and keypair stay in lockstep. Verifiable
    // builds are only a fallback when deploy output is missing.
    let mut deploy_candidates = Vec::new();
    let mut verifiable_candidates = Vec::new();
    if let Some(stem) = artifact_stem.and_then(safe_artifact_stem) {
        deploy_candidates.push(format!("target/deploy/{stem}.so"));
        verifiable_candidates.push(format!("target/verifiable/{stem}.so"));
    }
    newest_existing_path_owned(root, &deploy_candidates)
        .or_else(|| newest_file(so_file_paths(root, &root.join("target/deploy"))))
        .or_else(|| newest_existing_path_owned(root, &verifiable_candidates))
        .or_else(|| newest_file(so_file_paths(root, &root.join("target/verifiable"))))
}

fn find_program_keypair_path(root: &FsPath, artifact_stem: Option<&str>) -> Option<PathBuf> {
    // Prefer Anchor's build output under target/deploy/. Historical copies under
    // .keys/ are often stale and must not override the keypair that matches the
    // just-built .so / declare_id!.
    let mut deploy_candidates = Vec::new();
    let mut keys_candidates = Vec::new();
    if let Some(stem) = artifact_stem.and_then(safe_artifact_stem) {
        deploy_candidates.push(format!("target/deploy/{stem}-keypair.json"));
        keys_candidates.push(format!(".keys/{stem}-program-keypair.json"));
        keys_candidates.push(format!(".keys/{stem}-keypair.json"));
    }
    newest_existing_path_owned(root, &deploy_candidates)
        .or_else(|| first_json_file(root, &root.join("target/deploy")))
        .or_else(|| newest_existing_path_owned(root, &keys_candidates))
        .or_else(|| first_json_file(root, &root.join(".keys")))
}

fn find_program_idl_path(root: &FsPath, artifact_stem: Option<&str>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(stem) = artifact_stem.and_then(safe_artifact_stem) {
        candidates.push(format!("target/idl/{stem}.json"));
    }
    first_existing_path_owned(root, &candidates)
        .or_else(|| first_json_file(root, &root.join("target/idl")))
}

fn find_release_manifest_path(root: &FsPath) -> Option<PathBuf> {
    fs::read_dir(root.join("docs"))
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter_map(|path| canonical_child_path(root, &path, "release manifest").ok())
        .filter(|path| {
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                return false;
            };
            path.is_file()
                && name.contains("RELEASE_MANIFEST")
                && name.ends_with(".json")
                && !name.contains(".example.")
        })
        .min()
}

fn path_string(path: &FsPath) -> String {
    path.to_string_lossy().to_string()
}

fn json_pointer_string(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.starts_with("REPLACE_WITH_"))
        .map(ToOwned::to_owned)
}

fn anchor_program_id_declarations(
    root: &FsPath,
    artifact_stem: Option<&str>,
    network: Option<&str>,
) -> Vec<ProgramIdDeclaration> {
    let Ok(anchor) = fs::read_to_string(root.join("Anchor.toml")) else {
        return Vec::new();
    };
    let wanted_stem = artifact_stem.and_then(safe_artifact_stem);
    let wanted_network = network
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let mut current_programs_section: Option<String> = None;
    let mut declarations = Vec::new();
    for line in anchor.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let section = trimmed.trim_start_matches('[').trim_end_matches(']');
            current_programs_section = section
                .strip_prefix("programs.")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            continue;
        }
        let Some(section_network) = current_programs_section.as_ref() else {
            continue;
        };
        if let Some(wanted_network) = wanted_network.as_ref() {
            if section_network != wanted_network {
                continue;
            }
        }
        if trimmed.starts_with('#') || !trimmed.contains('=') {
            continue;
        }
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        let Some(program_name) = safe_artifact_stem(name.trim()) else {
            continue;
        };
        if let Some(wanted_stem) = wanted_stem.as_ref() {
            if &program_name != wanted_stem {
                continue;
            }
        }
        let Some(value) = parse_quoted_toml_value(value) else {
            continue;
        };
        declarations.push(ProgramIdDeclaration {
            label: format!("Anchor.toml [programs.{section_network}] {program_name}"),
            program_id: value,
        });
    }
    if declarations.is_empty() && wanted_network.is_some() {
        return anchor_program_id_declarations(root, artifact_stem, None);
    }
    declarations
}

fn parse_anchor_program_id(
    root: &FsPath,
    artifact_stem: Option<&str>,
    network: Option<&str>,
) -> Option<String> {
    anchor_program_id_declarations(root, artifact_stem, network)
        .into_iter()
        .next()
        .map(|declaration| declaration.program_id)
}

fn parse_idl_program_id(
    root: &FsPath,
    artifact_stem: Option<&str>,
) -> Result<Option<ProgramIdDeclaration>, ApiError> {
    let Some(idl_path) = find_program_idl_path(root, artifact_stem) else {
        return Ok(None);
    };
    let text = read_text_file_limited(&idl_path, MAX_PROGRAM_IDL_JSON_BYTES, "Anchor IDL")?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| program_source_error("Anchor IDL 不是有效 JSON"))?;
    let Some(program_id) = json_pointer_string(&value, "/address")
        .or_else(|| json_pointer_string(&value, "/metadata/address"))
    else {
        return Ok(None);
    };
    Ok(Some(ProgramIdDeclaration {
        label: format!("{} address", path_string(&idl_path)),
        program_id,
    }))
}

fn rust_declare_id_candidate_paths(root: &FsPath, artifact_stem: Option<&str>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(stem) = artifact_stem.and_then(safe_artifact_stem) {
        candidates.push(root.join(format!("programs/{stem}/src/lib.rs")));
    }
    candidates.push(root.join("src/lib.rs"));
    let exact_candidates: Vec<PathBuf> = candidates
        .into_iter()
        .filter_map(|path| canonical_child_path(root, &path, "Rust declare_id 源文件").ok())
        .filter(|path| path.is_file())
        .collect();
    if !exact_candidates.is_empty() {
        return exact_candidates;
    }
    newest_file(
        fs::read_dir(root.join("programs"))
            .ok()
            .into_iter()
            .flat_map(|entries| entries.filter_map(Result::ok))
            .map(|entry| entry.path().join("src/lib.rs"))
            .filter_map(|path| canonical_child_path(root, &path, "Rust declare_id 源文件").ok())
            .filter(|path| path.is_file())
            .collect(),
    )
    .into_iter()
    .collect()
}

fn parse_rust_declare_id_values(text: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut rest = text;
    while let Some(index) = rest.find("declare_id!") {
        rest = &rest[index + "declare_id!".len()..];
        let Some(open_quote) = rest.find('"') else {
            break;
        };
        rest = &rest[open_quote + 1..];
        let Some(close_quote) = rest.find('"') else {
            break;
        };
        let value = rest[..close_quote].trim();
        if !value.is_empty() {
            values.push(value.to_string());
        }
        rest = &rest[close_quote + 1..];
    }
    values
}

fn replace_rust_declare_id_values(text: &str, program_id: &str) -> (String, usize) {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    let mut replacements = 0usize;
    while let Some(index) = rest.find("declare_id!") {
        output.push_str(&rest[..index + "declare_id!".len()]);
        rest = &rest[index + "declare_id!".len()..];
        let Some(open_quote) = rest.find('"') else {
            output.push_str(rest);
            return (output, replacements);
        };
        output.push_str(&rest[..open_quote + 1]);
        rest = &rest[open_quote + 1..];
        let Some(close_quote) = rest.find('"') else {
            output.push_str(rest);
            return (output, replacements);
        };
        output.push_str(program_id);
        rest = &rest[close_quote..];
        replacements += 1;
    }
    output.push_str(rest);
    (output, replacements)
}

fn rust_declare_id_declarations(
    root: &FsPath,
    artifact_stem: Option<&str>,
) -> Result<Vec<ProgramIdDeclaration>, ApiError> {
    let mut declarations = Vec::new();
    for path in rust_declare_id_candidate_paths(root, artifact_stem) {
        let text = read_text_file_limited(&path, 512 * 1024, "Rust declare_id 源文件")?;
        for program_id in parse_rust_declare_id_values(&text) {
            declarations.push(ProgramIdDeclaration {
                label: format!("{} declare_id!", path_string(&path)),
                program_id,
            });
        }
    }
    Ok(declarations)
}

fn update_rust_declare_id_files(
    root: &FsPath,
    artifact_stem: Option<&str>,
    program_id: &str,
) -> Result<Vec<String>, ApiError> {
    let mut updated = Vec::new();
    for path in rust_declare_id_candidate_paths(root, artifact_stem) {
        let text = read_text_file_limited(&path, 512 * 1024, "Rust declare_id 源文件")?;
        let (next_text, replacements) = replace_rust_declare_id_values(&text, program_id);
        if replacements == 0 || next_text == text {
            continue;
        }
        fs::write(&path, next_text)
            .map_err(|error| program_source_error(format!("更新 declare_id! 失败: {error}")))?;
        updated.push(path_string(&path));
    }
    Ok(updated)
}

fn update_anchor_program_ids(
    root: &FsPath,
    artifact_stem: Option<&str>,
    program_id: &str,
) -> Result<Vec<String>, ApiError> {
    let anchor_path = root.join("Anchor.toml");
    if !anchor_path.is_file() {
        return Ok(Vec::new());
    }
    let text = read_text_file_limited(&anchor_path, 512 * 1024, "Anchor.toml")?;
    let wanted_stem = artifact_stem.and_then(safe_artifact_stem);
    let mut in_programs_section = false;
    let mut replacements = 0usize;
    let mut output = String::with_capacity(text.len());
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let section = trimmed.trim_start_matches('[').trim_end_matches(']');
            in_programs_section = section.starts_with("programs.");
            output.push_str(line);
            output.push('\n');
            continue;
        }
        if !in_programs_section || trimmed.starts_with('#') || !trimmed.contains('=') {
            output.push_str(line);
            output.push('\n');
            continue;
        }
        let Some((name, _value)) = trimmed.split_once('=') else {
            output.push_str(line);
            output.push('\n');
            continue;
        };
        let Some(program_name) = safe_artifact_stem(name.trim()) else {
            output.push_str(line);
            output.push('\n');
            continue;
        };
        if wanted_stem
            .as_ref()
            .is_some_and(|wanted_stem| wanted_stem != &program_name)
        {
            output.push_str(line);
            output.push('\n');
            continue;
        }
        let indent = line
            .chars()
            .take_while(|character| character.is_whitespace())
            .collect::<String>();
        output.push_str(&format!("{indent}{program_name} = \"{program_id}\"\n"));
        replacements += 1;
    }
    let output = if text.ends_with('\n') {
        output
    } else {
        output.trim_end_matches('\n').to_string()
    };
    if replacements == 0 || output == text {
        return Ok(Vec::new());
    }
    fs::write(&anchor_path, output)
        .map_err(|error| program_source_error(format!("更新 Anchor.toml 失败: {error}")))?;
    Ok(vec![path_string(&anchor_path)])
}

fn push_program_id_validation_error(
    errors: &mut Vec<String>,
    label: &str,
    source_program_id: &str,
    expected_program_id: &str,
) {
    if Pubkey::from_str(source_program_id).is_err() {
        errors.push(format!(
            "{label} 的 Program ID 不是有效 Solana 地址：{source_program_id}。请修正后重新编译。"
        ));
        return;
    }
    if source_program_id != expected_program_id {
        errors.push(format!(
            "源码/制品 Program ID 不一致：{label} 为 {source_program_id}，但当前 Program keypair 派生为 {expected_program_id}。请同步 declare_id!、Anchor.toml、IDL/编译产物后重新编译，或选择匹配的 Program keypair。"
        ));
    }
}

fn push_program_so_declared_id_validation_error(
    errors: &mut Vec<String>,
    label: &str,
    program_bytes: &[u8],
    expected_program_id: &str,
) {
    let Ok(expected_program_id) = Pubkey::from_str(expected_program_id) else {
        return;
    };
    if let Err(error) =
        program_deploy::require_anchor_declared_program_id(program_bytes, &expected_program_id)
    {
        errors.push(format!("{label}: {error}"));
    }
}

fn collect_source_validation_errors(
    root: &FsPath,
    artifact_stem: Option<&str>,
    network: Option<&str>,
    expected_program_id: Option<&str>,
    program_so: Option<(&str, &[u8])>,
) -> Result<Vec<String>, ApiError> {
    let Some(expected_program_id) = expected_program_id else {
        return Ok(Vec::new());
    };
    let mut errors = Vec::new();
    for declaration in anchor_program_id_declarations(root, artifact_stem, network) {
        push_program_id_validation_error(
            &mut errors,
            &declaration.label,
            &declaration.program_id,
            expected_program_id,
        );
    }
    if let Some(declaration) = parse_idl_program_id(root, artifact_stem)? {
        push_program_id_validation_error(
            &mut errors,
            &declaration.label,
            &declaration.program_id,
            expected_program_id,
        );
    }
    for declaration in rust_declare_id_declarations(root, artifact_stem)? {
        push_program_id_validation_error(
            &mut errors,
            &declaration.label,
            &declaration.program_id,
            expected_program_id,
        );
    }
    if let Some((label, program_bytes)) = program_so {
        push_program_so_declared_id_validation_error(
            &mut errors,
            label,
            program_bytes,
            expected_program_id,
        );
    }
    errors.sort();
    errors.dedup();
    Ok(errors)
}

fn collect_prebuild_source_validation_errors(
    root: &FsPath,
    artifact_stem: Option<&str>,
    network: Option<&str>,
    expected_program_id: Option<&str>,
) -> Result<Vec<String>, ApiError> {
    let Some(expected_program_id) = expected_program_id else {
        return Ok(Vec::new());
    };
    let mut errors = Vec::new();
    for declaration in anchor_program_id_declarations(root, artifact_stem, network) {
        push_program_id_validation_error(
            &mut errors,
            &declaration.label,
            &declaration.program_id,
            expected_program_id,
        );
    }
    for declaration in rust_declare_id_declarations(root, artifact_stem)? {
        push_program_id_validation_error(
            &mut errors,
            &declaration.label,
            &declaration.program_id,
            expected_program_id,
        );
    }
    errors.sort();
    errors.dedup();
    Ok(errors)
}

fn expected_program_id_from_keypair_path(path: &FsPath) -> Result<String, ApiError> {
    let mut json = read_text_file_limited(
        path,
        program_deploy::MAX_PROGRAM_KEYPAIR_JSON_BYTES,
        "Program keypair",
    )?;
    let keypair =
        program_deploy::parse_program_keypair_json(&json).map_err(program_source_error)?;
    json.zeroize();
    Ok(keypair.pubkey().to_string())
}

fn expected_program_id_from_source_keypair(
    root: &FsPath,
    artifact_stem: Option<&str>,
) -> Result<Option<String>, ApiError> {
    find_program_keypair_path(root, artifact_stem)
        .as_deref()
        .map(expected_program_id_from_keypair_path)
        .transpose()
}

fn source_validation_blocked_warning(error_count: usize) -> String {
    format!(
        "部署前一致性校验发现 {error_count} 个阻断问题，已停止部署。请复制错误信息修复后重新编译。"
    )
}

fn release_metadata_sha_and_len(
    root: &FsPath,
    artifact_stem: Option<&str>,
) -> Result<(Option<String>, Option<usize>), ApiError> {
    let mut candidates = Vec::new();
    if let Some(stem) = artifact_stem.and_then(safe_artifact_stem) {
        candidates.push(format!("target/verifiable/{stem}-build.json"));
    }
    let Some(metadata_path) = first_existing_path_owned(root, &candidates)
        .or_else(|| newest_build_metadata_file(root, &root.join("target/verifiable")))
    else {
        return Ok((None, None));
    };
    let text = read_text_file_limited(&metadata_path, 128 * 1024, "build metadata")?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| program_source_error("build metadata 不是有效 JSON"))?;
    let sha = json_pointer_string(&value, "/artifacts/program/sha256")
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(|value| value.to_ascii_lowercase());
    let len = value
        .pointer("/artifacts/program/length")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok());
    Ok((sha, len))
}

type ReleaseManifestValues = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn release_manifest_values(root: &FsPath) -> Result<ReleaseManifestValues, ApiError> {
    let Some(manifest_path) = find_release_manifest_path(root) else {
        return Ok((None, None, None, None, None));
    };
    let text = read_text_file_limited(&manifest_path, 512 * 1024, "release manifest")?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| program_source_error("release manifest 不是有效 JSON"))?;
    Ok((
        json_pointer_string(&value, "/target/network"),
        json_pointer_string(&value, "/target/genesis_hash"),
        json_pointer_string(&value, "/target/upgrade_authority"),
        json_pointer_string(&value, "/target/owner_admin"),
        json_pointer_string(&value, "/target/admin"),
    ))
}

fn load_program_source_artifacts(
    root: &FsPath,
    artifact_stem: Option<&str>,
    fallback_network: Option<&str>,
    warn_missing_artifacts: bool,
) -> Result<ProgramSourceArtifacts, ApiError> {
    let program_so_path = find_program_so_path(root, artifact_stem);
    let program_keypair_path = find_program_keypair_path(root, artifact_stem);
    let (metadata_sha, metadata_len) = release_metadata_sha_and_len(root, artifact_stem)?;
    let (
        mut manifest_network,
        manifest_genesis_hash,
        manifest_upgrade_authority,
        manifest_owner_admin,
        manifest_operational_admin,
    ) = release_manifest_values(root)?;
    if manifest_network.is_none() {
        manifest_network = fallback_network
            .map(str::trim)
            .filter(|value| matches!(*value, "mainnet" | "devnet" | "testnet"))
            .map(ToOwned::to_owned);
    }
    let manifest_program_id = parse_anchor_program_id(
        root,
        artifact_stem,
        manifest_network.as_deref().or(fallback_network),
    );

    let mut warnings = Vec::new();
    let mut expected_program_id = None;
    if let Some(path) = program_keypair_path.as_ref() {
        let mut json = read_text_file_limited(
            path,
            program_deploy::MAX_PROGRAM_KEYPAIR_JSON_BYTES,
            "Program keypair",
        )?;
        let keypair =
            program_deploy::parse_program_keypair_json(&json).map_err(program_source_error)?;
        json.zeroize();
        expected_program_id = Some(keypair.pubkey().to_string());
    } else if warn_missing_artifacts {
        warnings.push(
            "未找到 target/deploy/*-keypair.json（也未找到可用的 .keys/*.json 回退）".to_string(),
        );
    }

    let mut program_so_base64 = None;
    let mut program_so_sha256 = None;
    let mut program_so_size = None;
    let mut program_so_name = None;
    let mut program_so_validation: Option<(String, Vec<u8>)> = None;
    if let Some(path) = program_so_path.as_ref() {
        let bytes = read_bytes_file_limited(path, MAX_PROGRAM_SO_BYTES, ".so 文件")?;
        let actual_sha = program_deploy::sha256_hex(&bytes);
        let actual_len = bytes.len();
        if let Some(expected_sha) = metadata_sha.as_ref() {
            if expected_sha != &actual_sha {
                warnings.push(format!(
                    "build metadata SHA-256 为 {expected_sha}，但 .so 实际为 {actual_sha}"
                ));
            }
        }
        if let Some(expected_len) = metadata_len {
            if expected_len != actual_len {
                warnings.push(format!(
                    "build metadata 长度为 {expected_len}，但 .so 实际为 {actual_len}"
                ));
            }
        }
        program_so_base64 = Some(BASE64.encode(&bytes));
        program_so_sha256 = Some(actual_sha);
        program_so_size = Some(actual_len);
        program_so_validation = Some((path_string(path), bytes));
        program_so_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned);
    } else if warn_missing_artifacts {
        warnings.push(
            "未找到 target/deploy/<program>.so（也未找到 target/verifiable/*.so 回退）".to_string(),
        );
    }

    let source_validation_errors = collect_source_validation_errors(
        root,
        artifact_stem,
        manifest_network.as_deref().or(fallback_network),
        expected_program_id.as_deref(),
        program_so_validation
            .as_ref()
            .map(|(label, bytes)| (label.as_str(), bytes.as_slice())),
    )?;
    if warn_missing_artifacts && !source_validation_errors.is_empty() {
        warnings.push(source_validation_blocked_warning(
            source_validation_errors.len(),
        ));
    }

    Ok(ProgramSourceArtifacts {
        program_so_path,
        program_so_name,
        program_so_base64,
        program_so_sha256: program_so_sha256.clone(),
        program_so_size,
        program_keypair_path,
        expected_program_id,
        manifest_program_id,
        manifest_network,
        manifest_genesis_hash,
        manifest_upgrade_authority,
        manifest_owner_admin,
        manifest_operational_admin,
        source_validation_errors,
        warnings,
    })
}

fn next_program_source_build_job_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    format!("build-{millis}")
}

async fn start_program_source_build_job(
    source_dir: PathBuf,
    build_plans: Vec<ProgramSourceBuildPlan>,
    build_blocked_reason: Option<String>,
    artifact_stem: Option<String>,
    initial_warnings: Vec<String>,
) -> (String, Option<String>, Option<String>) {
    let job_id = next_program_source_build_job_id();
    let build_command = build_plans
        .first()
        .map(|plan| display_program_source_build_command(&source_dir, plan));
    let build_template = build_plans.first().map(|plan| plan.template.clone());
    let job = ProgramSourceBuildJob {
        source_dir: source_dir.clone(),
        status: "running".to_string(),
        build_command: build_command.clone(),
        build_template: build_template.clone(),
        build_stdout: None,
        build_stderr: None,
        build_error: None,
        warnings: initial_warnings,
    };
    program_source_build_jobs()
        .lock()
        .await
        .insert(job_id.clone(), job);

    let jobs = Arc::clone(program_source_build_jobs());
    let task_job_id = job_id.clone();
    tokio::spawn(async move {
        let result = execute_program_source_build(
            &source_dir,
            &build_plans,
            build_blocked_reason,
            artifact_stem.as_deref(),
            find_program_so_path,
        )
        .await;
        let mut jobs = jobs.lock().await;
        if let Some(job) = jobs.get_mut(&task_job_id) {
            match result {
                Ok(outcome) => {
                    job.status = "completed".to_string();
                    job.build_command = Some(outcome.command);
                    job.build_template = Some(outcome.template);
                    job.build_stdout = Some(outcome.stdout);
                    job.build_stderr = Some(outcome.stderr);
                    job.warnings.extend(outcome.warnings);
                }
                Err(error) => {
                    job.status = "failed".to_string();
                    job.build_error = Some(error.message);
                }
            }
        }
    });

    (job_id, build_command, build_template)
}

async fn program_deploy_source(
    Json(req): Json<ProgramDeploySourceRequest>,
) -> Result<Json<ProgramDeploySourceResponse>, ApiError> {
    let source_dir_raw = req.source_dir.trim();
    if source_dir_raw.is_empty() || source_dir_raw.len() > 4096 {
        return Err(program_source_error("源码目录路径无效"));
    }
    let source_dir = PathBuf::from(source_dir_raw)
        .canonicalize()
        .map_err(|error| program_source_error(format!("源码目录不存在或不可访问: {error}")))?;
    if !source_dir.is_dir() {
        return Err(program_source_error("源码目录不是目录"));
    }

    let (build_plans, build_blocked_reason) = program_source_build_plans(&source_dir);
    let build_available = !build_plans.is_empty();
    let mut build_command = build_plans.first().map(|plan| plan.display_command.clone());
    let mut build_template = build_plans.first().map(|plan| plan.template.clone());
    let artifact_stem = detect_program_artifact_stem(&source_dir);
    let built = false;
    let mut build_status = None;
    let mut build_job_id = None;
    let build_error = None;
    let build_stdout = None;
    let build_stderr = None;
    let mut build_warnings = Vec::new();
    if let Some(warning) = program_source_keys_build_warning(&source_dir) {
        build_warnings.push(warning);
    }
    if req.build {
        if !req.confirm_untrusted_build {
            return Err(program_source_error(
                "源码构建会执行所选目录中的项目脚本或 Makefile；请求必须显式确认 confirm_untrusted_build=true"
                    .to_string(),
            ));
        }
        build_warnings.push(
            "已确认执行所选源码目录的构建命令；仅应对可信或已审计源码使用自动构建".to_string(),
        );
        if build_plans.is_empty() {
            return Err(program_source_error(
                build_blocked_reason
                    .clone()
                    .unwrap_or_else(|| "当前源码目录不可自动编译".to_string()),
            ));
        }
        let expected_program_id =
            expected_program_id_from_source_keypair(&source_dir, artifact_stem.as_deref())?;
        let prebuild_validation_errors = collect_prebuild_source_validation_errors(
            &source_dir,
            artifact_stem.as_deref(),
            req.network.as_deref(),
            expected_program_id.as_deref(),
        )?;
        if !prebuild_validation_errors.is_empty() {
            let mut artifacts = load_program_source_artifacts(
                &source_dir,
                artifact_stem.as_deref(),
                req.network.as_deref(),
                true,
            )?;
            artifacts.source_validation_errors = prebuild_validation_errors;
            build_warnings.append(&mut artifacts.warnings);
            build_warnings.push(format!(
                "编译未启动：{}",
                source_validation_blocked_warning(artifacts.source_validation_errors.len())
            ));
            return Ok(Json(ProgramDeploySourceResponse {
                source_dir: path_string(&source_dir),
                built,
                build_status: Some("blocked".to_string()),
                build_job_id: None,
                build_error: None,
                build_command,
                build_template,
                build_stdout,
                build_stderr,
                program_so_path: artifacts
                    .program_so_path
                    .as_ref()
                    .map(|path| path_string(path)),
                program_so_name: artifacts.program_so_name,
                program_so_base64: artifacts.program_so_base64,
                program_so_sha256: artifacts.program_so_sha256,
                program_so_size: artifacts.program_so_size,
                program_keypair_path: artifacts
                    .program_keypair_path
                    .as_ref()
                    .map(|path| path_string(path)),
                expected_program_id: artifacts.expected_program_id.or(expected_program_id),
                manifest_program_id: artifacts.manifest_program_id,
                manifest_network: artifacts.manifest_network,
                manifest_genesis_hash: artifacts.manifest_genesis_hash,
                manifest_upgrade_authority: artifacts.manifest_upgrade_authority,
                manifest_owner_admin: artifacts.manifest_owner_admin,
                manifest_operational_admin: artifacts.manifest_operational_admin,
                build_available,
                build_blocked_reason,
                source_validation_errors: artifacts.source_validation_errors,
                warnings: build_warnings,
            }));
        }
        let (job_id, job_command, job_template) = start_program_source_build_job(
            source_dir.clone(),
            build_plans.clone(),
            build_blocked_reason.clone(),
            artifact_stem.clone(),
            build_warnings.clone(),
        )
        .await;
        build_command = job_command;
        build_template = job_template;
        build_status = Some("running".to_string());
        build_job_id = Some(job_id);
        build_warnings.push("编译已在后台开始，完成后会自动重新读取部署信息".to_string());
    }

    let mut artifacts = load_program_source_artifacts(
        &source_dir,
        artifact_stem.as_deref(),
        req.network.as_deref(),
        true,
    )?;
    build_warnings.append(&mut artifacts.warnings);

    Ok(Json(ProgramDeploySourceResponse {
        source_dir: path_string(&source_dir),
        built,
        build_status,
        build_job_id,
        build_error,
        build_command,
        build_template,
        build_stdout,
        build_stderr,
        program_so_path: artifacts
            .program_so_path
            .as_ref()
            .map(|path| path_string(path)),
        program_so_name: artifacts.program_so_name,
        program_so_base64: artifacts.program_so_base64,
        program_so_sha256: artifacts.program_so_sha256,
        program_so_size: artifacts.program_so_size,
        program_keypair_path: artifacts
            .program_keypair_path
            .as_ref()
            .map(|path| path_string(path)),
        expected_program_id: artifacts.expected_program_id,
        manifest_program_id: artifacts.manifest_program_id,
        manifest_network: artifacts.manifest_network,
        manifest_genesis_hash: artifacts.manifest_genesis_hash,
        manifest_upgrade_authority: artifacts.manifest_upgrade_authority,
        manifest_owner_admin: artifacts.manifest_owner_admin,
        manifest_operational_admin: artifacts.manifest_operational_admin,
        build_available,
        build_blocked_reason,
        source_validation_errors: artifacts.source_validation_errors,
        warnings: build_warnings,
    }))
}

#[derive(Deserialize)]
struct ProgramKeypairArtifactRequest {
    source_dir: String,
    #[serde(default)]
    artifact_stem: Option<String>,
    #[serde(default)]
    program_so_name: Option<String>,
}

#[derive(Serialize)]
struct ProgramKeypairArtifactResponse {
    source_dir: String,
    artifact_stem: Option<String>,
    program_keypair_path: Option<String>,
    expected_program_id: Option<String>,
    warnings: Vec<String>,
}

async fn program_keypair_artifact(
    Json(req): Json<ProgramKeypairArtifactRequest>,
) -> Result<Json<ProgramKeypairArtifactResponse>, ApiError> {
    let source_dir_raw = req.source_dir.trim();
    if source_dir_raw.is_empty() || source_dir_raw.len() > 4096 {
        return Err(program_source_error("源码目录路径无效"));
    }
    let source_dir = PathBuf::from(source_dir_raw)
        .canonicalize()
        .map_err(|error| program_source_error(format!("源码目录不存在或不可访问: {error}")))?;
    if !source_dir.is_dir() {
        return Err(program_source_error("源码目录不是目录"));
    }
    let artifact_stem = req
        .artifact_stem
        .as_deref()
        .and_then(safe_artifact_stem)
        .or_else(|| {
            req.program_so_name
                .as_deref()
                .and_then(artifact_stem_from_so_name)
        })
        .or_else(|| detect_program_artifact_stem(&source_dir));
    let mut warnings = Vec::new();
    let Some(program_keypair_path) =
        find_program_keypair_path(&source_dir, artifact_stem.as_deref())
    else {
        warnings.push(
            "未找到 target/deploy/<program>-keypair.json（也未找到可用的 .keys/*.json 回退）"
                .to_string(),
        );
        return Ok(Json(ProgramKeypairArtifactResponse {
            source_dir: path_string(&source_dir),
            artifact_stem,
            program_keypair_path: None,
            expected_program_id: None,
            warnings,
        }));
    };
    let mut json = read_text_file_limited(
        &program_keypair_path,
        program_deploy::MAX_PROGRAM_KEYPAIR_JSON_BYTES,
        "Program keypair",
    )?;
    let keypair =
        program_deploy::parse_program_keypair_json(&json).map_err(program_source_error)?;
    json.zeroize();
    Ok(Json(ProgramKeypairArtifactResponse {
        source_dir: path_string(&source_dir),
        artifact_stem,
        program_keypair_path: Some(path_string(&program_keypair_path)),
        expected_program_id: Some(keypair.pubkey().to_string()),
        warnings,
    }))
}

#[derive(Deserialize)]
struct ProgramGenerateKeypairRequest {
    source_dir: String,
    #[serde(default)]
    artifact_stem: Option<String>,
    #[serde(default)]
    program_so_name: Option<String>,
    #[serde(default)]
    update_source: bool,
}

#[derive(Serialize)]
struct ProgramGenerateKeypairResponse {
    source_dir: String,
    artifact_stem: String,
    program_keypair_path: String,
    backup_program_keypair_path: Option<String>,
    expected_program_id: String,
    updated_source_files: Vec<String>,
    warnings: Vec<String>,
}

async fn program_generate_keypair(
    Json(req): Json<ProgramGenerateKeypairRequest>,
) -> Result<Json<ProgramGenerateKeypairResponse>, ApiError> {
    let source_dir_raw = req.source_dir.trim();
    if source_dir_raw.is_empty() || source_dir_raw.len() > 4096 {
        return Err(program_source_error("源码目录路径无效"));
    }
    let source_dir = PathBuf::from(source_dir_raw)
        .canonicalize()
        .map_err(|error| program_source_error(format!("源码目录不存在或不可访问: {error}")))?;
    if !source_dir.is_dir() {
        return Err(program_source_error("源码目录不是目录"));
    }
    let artifact_stem = req
        .artifact_stem
        .as_deref()
        .and_then(safe_artifact_stem)
        .or_else(|| {
            req.program_so_name
                .as_deref()
                .and_then(artifact_stem_from_so_name)
        })
        .or_else(|| detect_program_artifact_stem(&source_dir))
        .ok_or_else(|| program_source_error("无法识别程序名称，请先编译或选择 .so 文件"))?;

    let keypair = Keypair::new();
    let program_id = keypair.pubkey().to_string();
    let deploy_dir = source_dir.join("target/deploy");
    fs::create_dir_all(&deploy_dir)
        .map_err(|error| program_source_error(format!("创建 target/deploy 失败: {error}")))?;
    let keypair_path = deploy_dir.join(format!("{artifact_stem}-keypair.json"));
    let backup_path = if keypair_path.exists() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let backup_path = deploy_dir.join(format!("{artifact_stem}-keypair.json.bak-{timestamp}"));
        fs::rename(&keypair_path, &backup_path).map_err(|error| {
            program_source_error(format!("备份旧 Program keypair 失败: {error}"))
        })?;
        Some(backup_path)
    } else {
        None
    };
    let keypair_json = serde_json::to_string(&keypair.to_bytes().to_vec())
        .map_err(|error| program_source_error(format!("序列化 Program keypair 失败: {error}")))?;
    fs::write(&keypair_path, keypair_json)
        .map_err(|error| program_source_error(format!("写入 Program keypair 失败: {error}")))?;

    let mut warnings = Vec::new();
    let mut updated_source_files = Vec::new();
    if req.update_source {
        let mut anchor_updates =
            update_anchor_program_ids(&source_dir, Some(&artifact_stem), &program_id)?;
        let mut rust_updates =
            update_rust_declare_id_files(&source_dir, Some(&artifact_stem), &program_id)?;
        updated_source_files.append(&mut anchor_updates);
        updated_source_files.append(&mut rust_updates);
        updated_source_files.sort();
        updated_source_files.dedup();
        if updated_source_files.is_empty() {
            warnings.push(
                "已生成新的 Program keypair，但未找到可自动更新的 Anchor.toml 或 declare_id!；请手动同步 Program ID 后重新编译。"
                    .to_string(),
            );
        } else {
            warnings.push(
                "已生成新的 Program keypair，并同步 Anchor.toml / declare_id!；请重新编译后部署。"
                    .to_string(),
            );
        }
    } else {
        warnings.push(
            "已生成新的 Program keypair；请手动同步 Anchor.toml / declare_id! 后重新编译。"
                .to_string(),
        );
    }

    Ok(Json(ProgramGenerateKeypairResponse {
        source_dir: path_string(&source_dir),
        artifact_stem,
        program_keypair_path: path_string(&keypair_path),
        backup_program_keypair_path: backup_path.as_ref().map(|path| path_string(path)),
        expected_program_id: program_id,
        updated_source_files,
        warnings,
    }))
}

#[derive(Deserialize)]
struct ProgramIdlRequest {
    source_dir: String,
    #[serde(default)]
    artifact_stem: Option<String>,
}

#[derive(Serialize)]
struct ProgramIdlResponse {
    source_dir: String,
    idl_path: String,
    idl_json: Value,
}

async fn program_idl(
    Json(req): Json<ProgramIdlRequest>,
) -> Result<Json<ProgramIdlResponse>, ApiError> {
    let source_dir_raw = req.source_dir.trim();
    if source_dir_raw.is_empty() || source_dir_raw.len() > 4096 {
        return Err(program_source_error("源码目录路径无效"));
    }
    let source_dir = PathBuf::from(source_dir_raw)
        .canonicalize()
        .map_err(|error| program_source_error(format!("源码目录不存在或不可访问: {error}")))?;
    if !source_dir.is_dir() {
        return Err(program_source_error("源码目录不是目录"));
    }
    let artifact_stem = req
        .artifact_stem
        .as_deref()
        .and_then(safe_artifact_stem)
        .or_else(|| detect_program_artifact_stem(&source_dir));
    let idl_path = find_program_idl_path(&source_dir, artifact_stem.as_deref())
        .ok_or_else(|| program_source_error("未找到 target/idl/*.json，请先编译项目"))?;
    let text = read_text_file_limited(&idl_path, MAX_PROGRAM_IDL_JSON_BYTES, "Anchor IDL")?;
    let idl_json: Value = serde_json::from_str(&text)
        .map_err(|_| program_source_error("Anchor IDL 不是有效 JSON"))?;
    if idl_json
        .get("instructions")
        .and_then(Value::as_array)
        .is_none_or(|items| items.is_empty())
    {
        return Err(program_source_error("Anchor IDL 缺少 instructions"));
    }
    Ok(Json(ProgramIdlResponse {
        source_dir: path_string(&source_dir),
        idl_path: path_string(&idl_path),
        idl_json,
    }))
}

#[derive(Deserialize)]
struct GenericProgramAccountMetaRequest {
    pubkey: String,
    is_signer: bool,
    is_writable: bool,
}

#[derive(Deserialize)]
struct ProgramInvokeRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    program_id: String,
    instruction_name: String,
    accounts: Vec<GenericProgramAccountMetaRequest>,
    data_base64: String,
    #[serde(default)]
    network: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    additional_signers: Vec<GenericProgramAdditionalSignerRequest>,
}

#[derive(Serialize)]
struct ProgramInvokeResponse {
    status: String,
    signature: Option<String>,
    simulation_error: Option<String>,
    logs: Vec<String>,
}

#[derive(Deserialize)]
struct ExternalSignSubmitRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    #[serde(default, alias = "requiredSigner")]
    required_signer: String,
    #[serde(default, alias = "transactionBase64")]
    transaction_base64: String,
    #[serde(default, alias = "transactionFormat")]
    transaction_format: Option<String>,
    #[serde(default)]
    network: Option<String>,
    #[serde(default, alias = "requestId")]
    request_id: Option<String>,
    #[serde(default, alias = "expiresAt")]
    expires_at: Option<u64>,
    #[serde(default, alias = "expectedGenesisHash")]
    expected_genesis_hash: Option<String>,
    #[serde(default, alias = "recentBlockhash")]
    recent_blockhash: Option<String>,
    #[serde(default, alias = "lastValidBlockHeight")]
    last_valid_block_height: Option<u64>,
}

#[derive(Serialize)]
struct ExternalSignSubmitResponse {
    status: String,
    signature: String,
    slot: u64,
    required_signer: String,
    signed_by: String,
    network: String,
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", alias = "rawTransaction")]
    raw_transaction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", alias = "recentBlockhash")]
    recent_blockhash: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        alias = "lastValidBlockHeight"
    )]
    last_valid_block_height: Option<u64>,
}

#[derive(Serialize)]
struct ExternalSignOnlyResponse {
    status: String,
    required_signer: String,
    signed_by: String,
    request_id: Option<String>,
    raw_transaction: String,
    recent_blockhash: String,
}

#[derive(Deserialize)]
struct ExternalSignMessageRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    #[serde(default, alias = "requiredSigner")]
    required_signer: String,
    #[serde(default, alias = "messageBase64")]
    message_base64: String,
    #[serde(default, alias = "requestId")]
    request_id: Option<String>,
    #[serde(default, alias = "expiresAt")]
    expires_at: Option<u64>,
}

#[derive(Serialize)]
struct ExternalSignMessageResponse {
    status: String,
    required_signer: String,
    signed_by: String,
    request_id: Option<String>,
    signature: String,
    message_base64: String,
}

#[derive(Deserialize)]
struct ExternalSignPreviewRequest {
    #[serde(default, alias = "requiredSigner")]
    required_signer: String,
    transaction_base64: String,
    #[serde(default, alias = "transactionFormat")]
    transaction_format: Option<String>,
    #[serde(default, alias = "knownPrograms")]
    known_programs: Vec<ExternalSignKnownProgram>,
}

#[derive(Clone, Deserialize)]
struct ExternalSignKnownProgram {
    #[serde(alias = "programId")]
    program_id: String,
    label: String,
}

#[derive(Serialize)]
struct ExternalSignInstructionPreview {
    index: usize,
    program_id: String,
    account_count: usize,
    data_bytes: usize,
}

#[derive(Serialize)]
struct ExternalSignTransactionPreviewResponse {
    status: String,
    transaction_format: String,
    recent_blockhash: String,
    required_signatures: usize,
    required_signer_present: bool,
    signer_accounts: Vec<String>,
    writable_accounts: Vec<String>,
    readonly_accounts: Vec<String>,
    programs: Vec<String>,
    instructions: Vec<ExternalSignInstructionPreview>,
    warnings: Vec<String>,
}

#[derive(Deserialize)]
struct GenericProgramAdditionalSignerRequest {
    pubkey: String,
    wallet_id: String,
    password: String,
}

impl Drop for GenericProgramAdditionalSignerRequest {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

fn keypair_from_saved_wallet(
    wallet_id: &str,
    password: &str,
    address_label: &str,
) -> Result<Keypair, ApiError> {
    let wallet_id = wallet_id.trim();
    validate_wallet_id(wallet_id)?;
    let (keypair, wallet) = if password.is_empty() {
        let wallet = wallet_store::find(wallet_id).map_err(|message| ApiError { message })?;
        (keypair_from_saved_wallet_session(wallet_id)?, wallet)
    } else {
        unlock_saved_wallet_for_session(wallet_id, password, address_label)?
    };
    let expected_pubkey = Pubkey::from_str(address_label).map_err(|_| ApiError {
        message: format!("Signer 地址无效: {address_label}"),
    })?;
    if keypair.pubkey() != expected_pubkey || wallet.public_key != expected_pubkey.to_string() {
        return Err(ApiError {
            message: format!(
                "Signer {} 选择的钱包不匹配，实际解锁为 {}",
                expected_pubkey,
                keypair.pubkey()
            ),
        });
    }
    Ok(keypair)
}

fn validate_external_sign_expiry(expires_at: Option<u64>) -> Result<(), ApiError> {
    let Some(expires_at) = expires_at else {
        return Ok(());
    };
    let now_ms = now_unix_ms_lossy();
    let expires_at_ms = if expires_at < 10_000_000_000 {
        expires_at.saturating_mul(1_000)
    } else {
        expires_at
    };
    if expires_at_ms <= now_ms {
        return Err(ApiError {
            message: "外部签名请求已过期".to_string(),
        });
    }
    Ok(())
}

fn decode_external_legacy_transaction(transaction_base64: &str) -> Result<Transaction, ApiError> {
    let trimmed = transaction_base64.trim();
    if trimmed.is_empty() {
        return Err(ApiError {
            message: "需要提供交易 base64".to_string(),
        });
    }
    let bytes = BASE64.decode(trimmed).map_err(|error| ApiError {
        message: format!("交易 base64 解码失败: {error}"),
    })?;
    if bytes.len() > SOLANA_TRANSACTION_PACKET_DATA_BYTES {
        return Err(ApiError {
            message: format!(
                "交易数据过大: {} bytes，最大 {} bytes",
                bytes.len(),
                SOLANA_TRANSACTION_PACKET_DATA_BYTES
            ),
        });
    }
    bincode::deserialize::<Transaction>(&bytes).map_err(|error| ApiError {
        message: format!("交易反序列化失败；当前仅支持 legacy Transaction base64: {error}"),
    })
}

fn decode_external_versioned_transaction(
    transaction_base64: &str,
) -> Result<VersionedTransaction, ApiError> {
    let trimmed = transaction_base64.trim();
    if trimmed.is_empty() {
        return Err(ApiError {
            message: "需要提供交易 base64".to_string(),
        });
    }
    let bytes = BASE64.decode(trimmed).map_err(|error| ApiError {
        message: format!("交易 base64 解码失败: {error}"),
    })?;
    if bytes.len() > SOLANA_TRANSACTION_PACKET_DATA_BYTES {
        return Err(ApiError {
            message: format!(
                "交易数据过大: {} bytes，最大 {} bytes",
                bytes.len(),
                SOLANA_TRANSACTION_PACKET_DATA_BYTES
            ),
        });
    }
    bincode::deserialize::<VersionedTransaction>(&bytes).map_err(|error| ApiError {
        message: format!("versioned transaction 反序列化失败: {error}"),
    })
}

fn external_sign_program_label<'a>(
    program_id: &str,
    known_programs: &'a [ExternalSignKnownProgram],
) -> &'a str {
    if let Some(program) = known_programs
        .iter()
        .find(|program| program.program_id.trim() == program_id && !program.label.trim().is_empty())
    {
        return program.label.trim();
    }
    match program_id {
        "11111111111111111111111111111111" => "System Program",
        SPL_TOKEN_PROGRAM_ID => "SPL Token",
        SPL_TOKEN_2022_PROGRAM_ID => "SPL Token 2022",
        "ComputeBudget111111111111111111111111111111" => "Compute Budget",
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" => "Associated Token Account",
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" => "Memo Program",
        "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo" => "Memo Program",
        UPGRADEABLE_LOADER_ID_STR => "Upgradeable Loader",
        _ => "Unknown Program",
    }
}

fn external_sign_instruction_preview(
    index: usize,
    program_id: String,
    account_count: usize,
    data_bytes: usize,
    known_programs: &[ExternalSignKnownProgram],
) -> ExternalSignInstructionPreview {
    let label = external_sign_program_label(&program_id, known_programs);
    ExternalSignInstructionPreview {
        index,
        program_id: format!("{} ({})", program_id, label),
        account_count,
        data_bytes,
    }
}

fn preview_external_legacy_transaction(
    transaction: &Transaction,
    required_signer: Option<&Pubkey>,
    known_programs: &[ExternalSignKnownProgram],
) -> ExternalSignTransactionPreviewResponse {
    let message = &transaction.message;
    let required_signatures = message.header.num_required_signatures as usize;
    let signer_accounts = message
        .account_keys
        .iter()
        .take(required_signatures)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut writable_accounts = Vec::new();
    let mut readonly_accounts = Vec::new();
    for (index, account) in message.account_keys.iter().enumerate() {
        if message.is_maybe_writable(index, None) {
            writable_accounts.push(account.to_string());
        } else {
            readonly_accounts.push(account.to_string());
        }
    }
    let mut programs = Vec::new();
    let instructions = message
        .instructions
        .iter()
        .enumerate()
        .map(|(index, instruction)| {
            let program_id = message
                .account_keys
                .get(instruction.program_id_index as usize)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("account-index:{}", instruction.program_id_index));
            if !programs.contains(&program_id) {
                programs.push(program_id.clone());
            }
            external_sign_instruction_preview(
                index,
                program_id,
                instruction.accounts.len(),
                instruction.data.len(),
                known_programs,
            )
        })
        .collect::<Vec<_>>();
    let required_signer_present = required_signer
        .map(|required| {
            signer_accounts
                .iter()
                .any(|account| account == &required.to_string())
        })
        .unwrap_or(false);
    let mut warnings = Vec::new();
    if !required_signer_present {
        warnings.push("requiredSigner 不在交易所需 signer 列表中；签名将被拒绝".to_string());
    }
    if programs
        .iter()
        .any(|program| external_sign_program_label(program, known_programs) == "Unknown Program")
    {
        warnings.push("交易包含未识别 program，请确认 DApp 来源和指令意图".to_string());
    }

    ExternalSignTransactionPreviewResponse {
        status: "success".to_string(),
        transaction_format: "legacy".to_string(),
        recent_blockhash: message.recent_blockhash.to_string(),
        required_signatures,
        required_signer_present,
        signer_accounts,
        writable_accounts,
        readonly_accounts,
        programs,
        instructions,
        warnings,
    }
}

fn preview_external_versioned_transaction(
    transaction: &VersionedTransaction,
    required_signer: Option<&Pubkey>,
    known_programs: &[ExternalSignKnownProgram],
) -> ExternalSignTransactionPreviewResponse {
    let message = &transaction.message;
    let required_signatures = message.header().num_required_signatures as usize;
    let static_accounts = message.static_account_keys();
    let signer_accounts = static_accounts
        .iter()
        .take(required_signatures)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut writable_accounts = Vec::new();
    let mut readonly_accounts = Vec::new();
    for (index, account) in static_accounts.iter().enumerate() {
        if message.is_maybe_writable(index, None) {
            writable_accounts.push(account.to_string());
        } else {
            readonly_accounts.push(account.to_string());
        }
    }
    let mut programs = Vec::new();
    let instructions = message
        .instructions()
        .iter()
        .enumerate()
        .map(|(index, instruction)| {
            let program_id = static_accounts
                .get(instruction.program_id_index as usize)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("account-index:{}", instruction.program_id_index));
            if !programs.contains(&program_id) {
                programs.push(program_id.clone());
            }
            external_sign_instruction_preview(
                index,
                program_id,
                instruction.accounts.len(),
                instruction.data.len(),
                known_programs,
            )
        })
        .collect::<Vec<_>>();
    let required_signer_present = required_signer
        .map(|required| {
            signer_accounts
                .iter()
                .any(|account| account == &required.to_string())
        })
        .unwrap_or(false);
    let mut warnings = Vec::new();
    if !required_signer_present {
        warnings.push("requiredSigner 不在交易所需 signer 列表中；签名将被拒绝".to_string());
    }
    if message
        .address_table_lookups()
        .is_some_and(|lookups| !lookups.is_empty())
    {
        warnings.push(
            "v0 交易使用地址表；当前预览只展示静态账户，动态加载账户需在链上解析后核对".to_string(),
        );
    }
    if programs
        .iter()
        .any(|program| external_sign_program_label(program, known_programs) == "Unknown Program")
    {
        warnings.push("交易包含未识别 program，请确认 DApp 来源和指令意图".to_string());
    }

    ExternalSignTransactionPreviewResponse {
        status: "success".to_string(),
        transaction_format: "versioned".to_string(),
        recent_blockhash: message.recent_blockhash().to_string(),
        required_signatures,
        required_signer_present,
        signer_accounts,
        writable_accounts,
        readonly_accounts,
        programs,
        instructions,
        warnings,
    }
}

fn preview_external_transaction_request(
    req: &ExternalSignPreviewRequest,
) -> Result<ExternalSignTransactionPreviewResponse, ApiError> {
    let required_signer = req.required_signer.trim();
    let required_signer = if required_signer.is_empty() {
        None
    } else {
        Some(Pubkey::from_str(required_signer).map_err(|_| ApiError {
            message: "requiredSigner 地址无效".to_string(),
        })?)
    };
    let transaction_format = req
        .transaction_format
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto")
        .to_ascii_lowercase();
    match transaction_format.as_str() {
        "legacy" => Ok(preview_external_legacy_transaction(
            &decode_external_legacy_transaction(&req.transaction_base64)?,
            required_signer.as_ref(),
            &req.known_programs,
        )),
        "versioned" | "v0" => Ok(preview_external_versioned_transaction(
            &decode_external_versioned_transaction(&req.transaction_base64)?,
            required_signer.as_ref(),
            &req.known_programs,
        )),
        "auto" => match decode_external_versioned_transaction(&req.transaction_base64) {
            Ok(transaction) => Ok(preview_external_versioned_transaction(
                &transaction,
                required_signer.as_ref(),
                &req.known_programs,
            )),
            Err(versioned_error) => {
                let transaction = decode_external_legacy_transaction(&req.transaction_base64)
                    .map_err(|legacy_error| ApiError {
                        message: format!(
                            "交易既不能按 versioned 也不能按 legacy 预览；versioned: {}；legacy: {}",
                            versioned_error.message, legacy_error.message
                        ),
                    })?;
                Ok(preview_external_legacy_transaction(
                    &transaction,
                    required_signer.as_ref(),
                    &req.known_programs,
                ))
            }
        },
        _ => Err(ApiError {
            message: "transactionFormat 必须是 auto、legacy 或 versioned".to_string(),
        }),
    }
}

async fn external_sign_preview(
    Json(req): Json<ExternalSignPreviewRequest>,
) -> Result<Json<ExternalSignTransactionPreviewResponse>, ApiError> {
    Ok(Json(preview_external_transaction_request(&req)?))
}

fn external_sign_legacy_transaction(
    transaction_base64: &str,
    required_signer: &Pubkey,
    signing_keypair: &Keypair,
) -> Result<Transaction, ApiError> {
    let mut transaction = decode_external_legacy_transaction(transaction_base64)?;
    transaction.sanitize().map_err(|error| ApiError {
        message: format!("外部交易结构校验失败: {error:?}"),
    })?;
    let required_signature_count = transaction.message.header.num_required_signatures as usize;
    let signing_position = transaction
        .message
        .account_keys
        .get(0..required_signature_count)
        .and_then(|signers| signers.iter().position(|pubkey| pubkey == required_signer))
        .ok_or_else(|| ApiError {
            message: format!("交易没有要求 {} 作为 signer", required_signer),
        })?;
    if signing_position >= transaction.signatures.len() {
        return Err(ApiError {
            message: "交易签名数组与 message signer 数量不匹配".to_string(),
        });
    }

    let recent_blockhash = transaction.message.recent_blockhash;
    transaction
        .try_partial_sign(&[signing_keypair], recent_blockhash)
        .map_err(|error| ApiError {
            message: format!("外部交易签名失败: {error}"),
        })?;
    let signer_signature = transaction
        .signatures
        .get(signing_position)
        .ok_or_else(|| ApiError {
            message: "交易签名数组与 message signer 数量不匹配".to_string(),
        })?;
    if !signer_signature.verify(required_signer.as_ref(), &transaction.message_data()) {
        return Err(ApiError {
            message: "外部交易当前钱包签名无效，已中止".to_string(),
        });
    }
    Ok(transaction)
}

fn external_sign_versioned_transaction(
    transaction_base64: &str,
    required_signer: &Pubkey,
    signing_keypair: &Keypair,
) -> Result<VersionedTransaction, ApiError> {
    let mut transaction = decode_external_versioned_transaction(transaction_base64)?;
    transaction.sanitize().map_err(|error| ApiError {
        message: format!("外部 versioned 交易结构校验失败: {error:?}"),
    })?;
    let required_signature_count = transaction.message.header().num_required_signatures as usize;
    let signing_position = transaction
        .message
        .static_account_keys()
        .get(0..required_signature_count)
        .and_then(|signers| signers.iter().position(|pubkey| pubkey == required_signer))
        .ok_or_else(|| ApiError {
            message: format!("交易没有要求 {} 作为 signer", required_signer),
        })?;
    if signing_position >= transaction.signatures.len() {
        return Err(ApiError {
            message: "交易签名数组与 message signer 数量不匹配".to_string(),
        });
    }

    let signature = signing_keypair
        .try_sign_message(&transaction.message.serialize())
        .map_err(|error| ApiError {
            message: format!("外部 versioned 交易签名失败: {error}"),
        })?;
    transaction.signatures[signing_position] = signature;
    let signer_signature = transaction
        .signatures
        .get(signing_position)
        .ok_or_else(|| ApiError {
            message: "交易签名数组与 message signer 数量不匹配".to_string(),
        })?;
    if !signer_signature.verify(required_signer.as_ref(), &transaction.message.serialize()) {
        return Err(ApiError {
            message: "外部 versioned 交易当前钱包签名无效，已中止".to_string(),
        });
    }
    Ok(transaction)
}

enum SignedExternalTransaction {
    Legacy(Transaction),
    Versioned(VersionedTransaction),
}

impl SignedExternalTransaction {
    fn raw_base64(&self) -> Result<String, ApiError> {
        Ok(match self {
            Self::Legacy(transaction) => {
                BASE64.encode(bincode::serialize(transaction).map_err(|error| ApiError {
                    message: format!("已签名交易序列化失败: {error}"),
                })?)
            }
            Self::Versioned(transaction) => {
                BASE64.encode(bincode::serialize(transaction).map_err(|error| ApiError {
                    message: format!("已签名 versioned 交易序列化失败: {error}"),
                })?)
            }
        })
    }

    fn recent_blockhash(&self) -> solana_sdk::hash::Hash {
        match self {
            Self::Legacy(transaction) => transaction.message.recent_blockhash,
            Self::Versioned(transaction) => *transaction.message.recent_blockhash(),
        }
    }

    async fn submit_once(
        &self,
        client: &RpcClient,
        action: &str,
        context: &str,
        commitment: CommitmentConfig,
        commitment_label: &str,
        timeout: Duration,
    ) -> Result<(Signature, u64), ApiError> {
        match self {
            Self::Legacy(transaction) => {
                submit_signed_transaction_once(
                    client,
                    transaction,
                    action,
                    context,
                    commitment,
                    commitment_label,
                    timeout,
                )
                .await
            }
            Self::Versioned(transaction) => {
                submit_signed_versioned_transaction_once(
                    client,
                    transaction,
                    action,
                    context,
                    commitment,
                    commitment_label,
                    timeout,
                )
                .await
            }
        }
    }
}

fn sign_external_transaction_request(
    req: &ExternalSignSubmitRequest,
) -> Result<(Pubkey, Pubkey, SignedExternalTransaction, String, String), ApiError> {
    let required_signer = Pubkey::from_str(req.required_signer.trim()).map_err(|_| ApiError {
        message: "requiredSigner 地址无效".to_string(),
    })?;
    let signing_keypair = req.wallet.keypair()?;
    let signed_by = signing_keypair.pubkey();
    if signed_by != required_signer {
        return Err(ApiError {
            message: format!(
                "外部签名请求只允许 {} 签名，当前解锁钱包为 {}",
                required_signer, signed_by
            ),
        });
    }

    let transaction_format = req
        .transaction_format
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto")
        .to_ascii_lowercase();
    let signed_transaction = match transaction_format.as_str() {
        "legacy" => SignedExternalTransaction::Legacy(external_sign_legacy_transaction(
            &req.transaction_base64,
            &required_signer,
            &signing_keypair,
        )?),
        "versioned" | "v0" => {
            SignedExternalTransaction::Versioned(external_sign_versioned_transaction(
                &req.transaction_base64,
                &required_signer,
                &signing_keypair,
            )?)
        }
        "auto" => {
            match external_sign_versioned_transaction(
                &req.transaction_base64,
                &required_signer,
                &signing_keypair,
            ) {
                Ok(transaction) => SignedExternalTransaction::Versioned(transaction),
                Err(versioned_error) => SignedExternalTransaction::Legacy(
                    external_sign_legacy_transaction(
                        &req.transaction_base64,
                        &required_signer,
                        &signing_keypair,
                    )
                    .map_err(|legacy_error| ApiError {
                        message: format!(
                            "交易既不能按 versioned 也不能按 legacy 签名；versioned: {}；legacy: {}",
                            versioned_error.message, legacy_error.message
                        ),
                    })?,
                ),
            }
        }
        _ => {
            return Err(ApiError {
                message: "transactionFormat 必须是 auto、legacy 或 versioned".to_string(),
            })
        }
    };
    let signed_transaction_base64 = signed_transaction.raw_base64()?;
    let signed_recent_blockhash_hash = signed_transaction.recent_blockhash();
    let signed_recent_blockhash = signed_recent_blockhash_hash.to_string();
    Ok((
        required_signer,
        signed_by,
        signed_transaction,
        signed_transaction_base64,
        signed_recent_blockhash,
    ))
}

async fn external_sign_sign(
    Json(req): Json<ExternalSignSubmitRequest>,
) -> Result<Json<ExternalSignOnlyResponse>, ApiError> {
    validate_external_sign_expiry(req.expires_at)?;
    let (
        required_signer,
        signed_by,
        _signed_transaction,
        signed_transaction_base64,
        signed_recent_blockhash,
    ) = sign_external_transaction_request(&req)?;
    if let Some(expected_recent_blockhash) = req
        .recent_blockhash
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if expected_recent_blockhash != signed_recent_blockhash {
            return Err(ApiError {
                message: format!(
                    "交易 blockhash 为 {}，与请求中的 {} 不一致；请重新导入签名请求",
                    signed_recent_blockhash, expected_recent_blockhash
                ),
            });
        }
    }

    Ok(Json(ExternalSignOnlyResponse {
        status: "success".to_string(),
        required_signer: required_signer.to_string(),
        signed_by: signed_by.to_string(),
        request_id: req.request_id,
        raw_transaction: signed_transaction_base64,
        recent_blockhash: signed_recent_blockhash,
    }))
}

async fn external_sign_message(
    Json(req): Json<ExternalSignMessageRequest>,
) -> Result<Json<ExternalSignMessageResponse>, ApiError> {
    validate_external_sign_expiry(req.expires_at)?;
    let required_signer = Pubkey::from_str(req.required_signer.trim()).map_err(|_| ApiError {
        message: "requiredSigner 地址无效".to_string(),
    })?;
    let signing_keypair = req.wallet.keypair()?;
    let signed_by = signing_keypair.pubkey();
    if signed_by != required_signer {
        return Err(ApiError {
            message: format!(
                "外部消息签名请求只允许 {} 签名，当前解锁钱包为 {}",
                required_signer, signed_by
            ),
        });
    }

    let message_base64 = req.message_base64.trim();
    require_nonempty(message_base64, "消息 base64")?;
    let message_bytes = BASE64.decode(message_base64).map_err(|error| ApiError {
        message: format!("消息 base64 解码失败: {error}"),
    })?;
    if message_bytes.is_empty() || message_bytes.len() > MAX_EXTERNAL_SIGN_MESSAGE_BYTES {
        return Err(ApiError {
            message: format!(
                "消息长度无效，最大 {} bytes",
                MAX_EXTERNAL_SIGN_MESSAGE_BYTES
            ),
        });
    }

    let signature = signing_keypair
        .try_sign_message(&message_bytes)
        .map_err(|error| ApiError {
            message: format!("外部消息签名失败: {error}"),
        })?;
    if !signature.verify(required_signer.as_ref(), &message_bytes) {
        return Err(ApiError {
            message: "外部消息当前钱包签名无效，已中止".to_string(),
        });
    }

    Ok(Json(ExternalSignMessageResponse {
        status: "success".to_string(),
        required_signer: required_signer.to_string(),
        signed_by: signed_by.to_string(),
        request_id: req.request_id,
        signature: BASE64.encode(signature.as_ref()),
        message_base64: message_base64.to_string(),
    }))
}

async fn external_sign_submit(
    Json(req): Json<ExternalSignSubmitRequest>,
) -> Result<Json<ExternalSignSubmitResponse>, ApiError> {
    validate_external_sign_expiry(req.expires_at)?;
    let (
        required_signer,
        signed_by,
        signed_transaction,
        signed_transaction_base64,
        signed_recent_blockhash,
    ) = sign_external_transaction_request(&req)?;
    let signed_recent_blockhash_hash = signed_transaction.recent_blockhash();
    if let Some(expected_recent_blockhash) = req
        .recent_blockhash
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if expected_recent_blockhash != signed_recent_blockhash {
            return Err(ApiError {
                message: format!(
                    "交易 blockhash 为 {}，与请求中的 {} 不一致；请重新导入签名请求",
                    signed_recent_blockhash, expected_recent_blockhash
                ),
            });
        }
    }

    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let signed_last_valid_block_height = match req.last_valid_block_height {
        Some(last_valid_block_height) if last_valid_block_height > 0 => last_valid_block_height,
        _ => {
            let latest = client
                .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
                .map_err(|error| ApiError {
                    message: format!("读取 RPC latest blockhash 失败: {error}"),
                })?;
            if latest.0 != signed_recent_blockhash_hash {
                return Err(ApiError {
                    message: "签名请求缺少 lastValidBlockHeight，且当前 RPC latest blockhash 与交易不一致；请重新导入签名请求"
                        .to_string(),
                });
            }
            latest.1
        }
    };
    if let Some(expected_genesis_hash) = req
        .expected_genesis_hash
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let expected_genesis_hash = solana_sdk::hash::Hash::from_str(expected_genesis_hash)
            .map_err(|_| ApiError {
                message: "expectedGenesisHash 无效".to_string(),
            })?;
        let actual_genesis_hash = client.get_genesis_hash().map_err(|error| ApiError {
            message: format!("读取 RPC genesis hash 失败: {error}"),
        })?;
        if actual_genesis_hash != expected_genesis_hash {
            return Err(ApiError {
                message: format!(
                    "RPC genesis hash 为 {}，预期为 {}；已在提交前中止",
                    actual_genesis_hash, expected_genesis_hash
                ),
            });
        }
    }

    let context = format!(
        "external_sign request={} signer={} network={}",
        req.request_id.as_deref().unwrap_or("-"),
        required_signer,
        network
    );
    let (signature, slot) = signed_transaction
        .submit_once(
            &client,
            "外部签名",
            &context,
            CommitmentConfig::confirmed(),
            "confirmed",
            Duration::from_secs(20),
        )
        .await?;

    Ok(Json(ExternalSignSubmitResponse {
        status: "success".to_string(),
        signature: signature.to_string(),
        slot,
        required_signer: required_signer.to_string(),
        signed_by: signed_by.to_string(),
        network,
        request_id: req.request_id,
        raw_transaction: Some(signed_transaction_base64),
        recent_blockhash: Some(signed_recent_blockhash),
        last_valid_block_height: Some(signed_last_valid_block_height),
    }))
}

fn decode_generic_instruction_data(value: &str) -> Result<Vec<u8>, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ApiError {
            message: "Instruction data 不能为空".to_string(),
        });
    }
    let max_base64_len = MAX_GENERIC_PROGRAM_INSTRUCTION_DATA_BYTES.div_ceil(3) * 4;
    if trimmed.len() > max_base64_len {
        return Err(ApiError {
            message: "Instruction data 过大".to_string(),
        });
    }
    let data = BASE64.decode(trimmed.as_bytes()).map_err(|_| ApiError {
        message: "Instruction data base64 无效".to_string(),
    })?;
    if data.is_empty() || data.len() > MAX_GENERIC_PROGRAM_INSTRUCTION_DATA_BYTES {
        return Err(ApiError {
            message: "Instruction data 大小无效".to_string(),
        });
    }
    Ok(data)
}

fn build_generic_program_instruction(
    program_id: &str,
    accounts: &[GenericProgramAccountMetaRequest],
    data_base64: &str,
) -> Result<Instruction, ApiError> {
    let program_id = Pubkey::from_str(program_id.trim()).map_err(|_| ApiError {
        message: "Program ID 无效".to_string(),
    })?;
    if accounts.len() > MAX_GENERIC_PROGRAM_INSTRUCTION_ACCOUNTS {
        return Err(ApiError {
            message: "Instruction 账户数量过多".to_string(),
        });
    }
    let metas = accounts
        .iter()
        .map(|account| {
            let pubkey = Pubkey::from_str(account.pubkey.trim()).map_err(|_| ApiError {
                message: format!("账户地址无效: {}", account.pubkey),
            })?;
            Ok(if account.is_writable {
                AccountMeta::new(pubkey, account.is_signer)
            } else {
                AccountMeta::new_readonly(pubkey, account.is_signer)
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Instruction {
        program_id,
        accounts: metas,
        data: decode_generic_instruction_data(data_base64)?,
    })
}

async fn program_invoke(
    Json(mut req): Json<ProgramInvokeRequest>,
) -> Result<Json<ProgramInvokeResponse>, ApiError> {
    let signer = req.wallet.keypair()?;
    let signer_pubkey = signer.pubkey();
    let instruction =
        build_generic_program_instruction(&req.program_id, &req.accounts, &req.data_base64)?;
    let mode = req.mode.as_deref().unwrap_or("simulate");
    if mode != "simulate" && mode != "send" {
        return Err(ApiError {
            message: "调用模式必须是 simulate 或 send".to_string(),
        });
    }
    if req.additional_signers.len() > MAX_GENERIC_PROGRAM_ADDITIONAL_SIGNERS {
        return Err(ApiError {
            message: "额外 signer 数量过多".to_string(),
        });
    }
    let mut signers = vec![signer];
    let mut signer_pubkeys = vec![signer_pubkey];
    for additional in &req.additional_signers {
        let requested_pubkey =
            Pubkey::from_str(additional.pubkey.trim()).map_err(|_| ApiError {
                message: format!("Signer 地址无效: {}", additional.pubkey),
            })?;
        if signer_pubkeys.contains(&requested_pubkey) {
            continue;
        }
        let keypair = keypair_from_saved_wallet(
            &additional.wallet_id,
            &additional.password,
            &requested_pubkey.to_string(),
        )?;
        signer_pubkeys.push(keypair.pubkey());
        signers.push(keypair);
    }
    req.additional_signers.clear();

    for account in &instruction.accounts {
        if account.is_signer && !signer_pubkeys.contains(&account.pubkey) {
            return Err(ApiError {
                message: format!(
                    "账户 {} 需要签名，请为这个 signer 选择已保存钱包并输入密码",
                    account.pubkey
                ),
            });
        }
    }
    let (client, _) = rpc_client_for(req.network.as_deref())?;
    let blockhash = client.get_latest_blockhash().map_err(|error| ApiError {
        message: format!("获取 blockhash 失败: {error}"),
    })?;
    let signer_refs = signers
        .iter()
        .map(|keypair| keypair as &dyn Signer)
        .collect::<Vec<_>>();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&signer_pubkey),
        &signer_refs,
        blockhash,
    );
    if mode == "simulate" {
        let simulation = client
            .simulate_transaction_with_config(
                &transaction,
                RpcSimulateTransactionConfig {
                    sig_verify: true,
                    replace_recent_blockhash: false,
                    commitment: Some(CommitmentConfig::confirmed()),
                    encoding: Some(UiTransactionEncoding::Base64),
                    accounts: None,
                    min_context_slot: None,
                    inner_instructions: false,
                },
            )
            .map_err(|error| ApiError {
                message: format!("模拟调用 RPC 失败: {error}"),
            })?;
        return Ok(Json(ProgramInvokeResponse {
            status: if simulation.value.err.is_some() {
                "simulation_failed".to_string()
            } else {
                "simulated".to_string()
            },
            signature: None,
            simulation_error: simulation.value.err.map(|error| format!("{error}")),
            logs: simulation.value.logs.unwrap_or_default(),
        }));
    }

    let signature = client
        .send_and_confirm_transaction(&transaction)
        .map_err(|error| ApiError {
            message: format!(
                "{} 调用失败: {error}",
                req.instruction_name
                    .trim()
                    .chars()
                    .take(80)
                    .collect::<String>()
            ),
        })?;
    Ok(Json(ProgramInvokeResponse {
        status: "success".to_string(),
        signature: Some(signature.to_string()),
        simulation_error: None,
        logs: Vec::new(),
    }))
}

async fn program_deploy_source_build_status(
    Path(job_id): Path<String>,
) -> Result<Json<ProgramDeploySourceResponse>, ApiError> {
    let job = {
        let jobs = program_source_build_jobs().lock().await;
        jobs.get(&job_id)
            .cloned()
            .ok_or_else(|| program_source_error("构建任务不存在或已过期"))?
    };
    let (build_plans, build_blocked_reason) = program_source_build_plans(&job.source_dir);
    let build_available = !build_plans.is_empty();
    let artifact_stem = detect_program_artifact_stem(&job.source_dir);
    let mut warnings = job.warnings.clone();
    if let Some(error) = job.build_error.as_ref() {
        warnings.push(error.clone());
    }
    let mut artifacts = load_program_source_artifacts(
        &job.source_dir,
        artifact_stem.as_deref(),
        None,
        job.status != "running",
    )?;
    warnings.append(&mut artifacts.warnings);

    Ok(Json(ProgramDeploySourceResponse {
        source_dir: path_string(&job.source_dir),
        built: job.status == "completed",
        build_status: Some(job.status),
        build_job_id: Some(job_id),
        build_error: job.build_error,
        build_command: job.build_command,
        build_template: job.build_template,
        build_stdout: job.build_stdout,
        build_stderr: job.build_stderr,
        program_so_path: artifacts
            .program_so_path
            .as_ref()
            .map(|path| path_string(path)),
        program_so_name: artifacts.program_so_name,
        program_so_base64: artifacts.program_so_base64,
        program_so_sha256: artifacts.program_so_sha256,
        program_so_size: artifacts.program_so_size,
        program_keypair_path: artifacts
            .program_keypair_path
            .as_ref()
            .map(|path| path_string(path)),
        expected_program_id: artifacts.expected_program_id,
        manifest_program_id: artifacts.manifest_program_id,
        manifest_network: artifacts.manifest_network,
        manifest_genesis_hash: artifacts.manifest_genesis_hash,
        manifest_upgrade_authority: artifacts.manifest_upgrade_authority,
        manifest_owner_admin: artifacts.manifest_owner_admin,
        manifest_operational_admin: artifacts.manifest_operational_admin,
        build_available,
        build_blocked_reason,
        source_validation_errors: artifacts.source_validation_errors,
        warnings,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProgramDeploymentJournalRequest {
    network: String,
    expected_genesis_hash: String,
    expected_program_id: String,
    expected_program_sha256: String,
    program_len: usize,
    max_data_len: usize,
    expected_upgrade_authority: String,
}

#[derive(Deserialize)]
struct ProgramDeploymentJournalByProgramRequest {
    network: String,
    expected_genesis_hash: String,
    program_id: String,
}

#[derive(Serialize)]
struct ProgramDeploymentJournalResponse {
    network: String,
    genesis_hash: String,
    write_chunk_bytes: usize,
    write_chunk_count: usize,
    journal: Option<ProgramDeploymentJournalView>,
    deployment_attempts: Vec<wallet_store::ProgramDeploymentAttemptRecord>,
    conflicting_journal: Option<ProgramDeploymentJournalView>,
    conflicting_deployment_attempts: Vec<wallet_store::ProgramDeploymentAttemptRecord>,
}

#[derive(Serialize)]
struct ProgramDeploymentJournalView {
    genesis_hash: String,
    program_id: String,
    program_sha256: String,
    program_len: usize,
    max_data_len: usize,
    upgrade_authority: String,
    buffer_address: String,
    status: String,
    create_signature: Option<String>,
    create_last_valid_block_height: Option<u64>,
    last_write_signature: Option<String>,
    last_write_chunk_index: Option<usize>,
    last_write_last_valid_block_height: Option<u64>,
    completed_writes: usize,
    deploy_signature: Option<String>,
    deploy_last_valid_block_height: Option<u64>,
    attempt_evidence_version: u32,
    revision: u64,
    created_at: u64,
    updated_at: u64,
}

impl From<&wallet_store::ProgramDeploymentRecord> for ProgramDeploymentJournalView {
    fn from(record: &wallet_store::ProgramDeploymentRecord) -> Self {
        Self {
            genesis_hash: record.genesis_hash.clone(),
            program_id: record.program_id.clone(),
            program_sha256: record.program_sha256.clone(),
            program_len: record.program_len,
            max_data_len: record.max_data_len,
            upgrade_authority: record.upgrade_authority.clone(),
            buffer_address: record.buffer_address.clone(),
            status: record.status.clone(),
            create_signature: record.create_signature.clone(),
            create_last_valid_block_height: record.create_last_valid_block_height,
            last_write_signature: record.last_write_signature.clone(),
            last_write_chunk_index: record.last_write_chunk_index,
            last_write_last_valid_block_height: record.last_write_last_valid_block_height,
            completed_writes: record.completed_writes,
            deploy_signature: record.deploy_signature.clone(),
            deploy_last_valid_block_height: record.deploy_last_valid_block_height,
            attempt_evidence_version: record.attempt_evidence_version,
            revision: record.revision,
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

struct ProgramDeploymentJournalIntent {
    expected_genesis_hash: solana_sdk::hash::Hash,
    program_id: Pubkey,
    program_sha256: String,
    program_len: usize,
    max_data_len: usize,
    upgrade_authority: Pubkey,
}

fn parse_canonical_deployment_pubkey(value: &str, label: &str) -> Result<Pubkey, ApiError> {
    let trimmed = value.trim();
    let pubkey = Pubkey::from_str(trimmed).map_err(|_| ApiError {
        message: format!("无效的{label}"),
    })?;
    if pubkey == Pubkey::default() || pubkey.to_string() != trimmed {
        return Err(ApiError {
            message: format!("{label}必须是 canonical 非零公钥"),
        });
    }
    Ok(pubkey)
}

fn validate_program_deployment_journal_request(
    req: &ProgramDeploymentJournalRequest,
) -> Result<ProgramDeploymentJournalIntent, ApiError> {
    if req.program_len == 0
        || req.program_len > MAX_PROGRAM_SO_BYTES
        || req.max_data_len < req.program_len
        || req.max_data_len > MAX_PROGRAM_SO_BYTES
    {
        return Err(ApiError {
            message: format!(
                "Program 长度必须满足 1 <= program_len <= max_data_len <= {}",
                MAX_PROGRAM_SO_BYTES
            ),
        });
    }
    let program_sha256 = req.expected_program_sha256.trim().to_ascii_lowercase();
    if program_sha256.len() != 64 || !program_sha256.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return Err(ApiError {
            message: "预期 Program SHA-256 必须是 64 位十六进制".to_string(),
        });
    }
    let expected_genesis_text = req.expected_genesis_hash.trim();
    let expected_genesis_hash =
        solana_sdk::hash::Hash::from_str(expected_genesis_text).map_err(|_| ApiError {
            message: "无效的预期 genesis hash".to_string(),
        })?;
    if expected_genesis_hash == solana_sdk::hash::Hash::default()
        || expected_genesis_hash.to_string() != expected_genesis_text
    {
        return Err(ApiError {
            message: "预期 genesis hash 必须是 canonical 非零值".to_string(),
        });
    }
    Ok(ProgramDeploymentJournalIntent {
        expected_genesis_hash,
        program_id: parse_canonical_deployment_pubkey(&req.expected_program_id, "预期 Program ID")?,
        program_sha256,
        program_len: req.program_len,
        max_data_len: req.max_data_len,
        upgrade_authority: parse_canonical_deployment_pubkey(
            &req.expected_upgrade_authority,
            "预期 Upgrade Authority",
        )?,
    })
}

async fn program_deployment_journal(
    Json(req): Json<ProgramDeploymentJournalRequest>,
) -> Result<Json<ProgramDeploymentJournalResponse>, ApiError> {
    if req.network.trim().is_empty() {
        return Err(ApiError {
            message: "部署网络不能为空".to_string(),
        });
    }
    let intent = validate_program_deployment_journal_request(&req)?;
    let selector = rpc_selector(Some(req.network.trim()))?;
    let network = selector.network;
    let genesis_hash = intent.expected_genesis_hash.to_string();
    let program_id = intent.program_id.to_string();
    let (journal, deployment_attempts) =
        wallet_store::load_program_deployment_snapshot(&genesis_hash, &program_id)
            .map_err(|message| ApiError { message })?;
    let mut matching_journal = None;
    let mut matching_attempts = Vec::new();
    let mut conflicting_journal = None;
    let mut conflicting_attempts = Vec::new();
    if let Some(record) = journal.as_ref() {
        if !deployment_status_is_known(&record.status)
            || record.attempt_evidence_version
                != wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION
        {
            return Err(deployment_journal_error(format!(
                "Program {} 的部署记录状态或证据版本无效",
                intent.program_id
            )));
        }
        for attempt in &deployment_attempts {
            validate_program_deployment_attempt_record(record, attempt)?;
        }
        let binding_matches = validate_deployment_journal_binding(
            record,
            &genesis_hash,
            &intent.program_id,
            &intent.program_sha256,
            intent.program_len,
            intent.max_data_len,
            &intent.upgrade_authority,
            None,
        )
        .is_ok();
        if binding_matches {
            matching_journal = Some(ProgramDeploymentJournalView::from(record));
            matching_attempts = deployment_attempts;
        } else {
            conflicting_journal = Some(ProgramDeploymentJournalView::from(record));
            conflicting_attempts = deployment_attempts;
        }
    } else if !deployment_attempts.is_empty() {
        return Err(deployment_journal_error(
            "部署 attempt 缺少对应 journal，拒绝返回撕裂快照",
        ));
    }
    Ok(Json(ProgramDeploymentJournalResponse {
        network,
        genesis_hash,
        write_chunk_bytes: PROGRAM_WRITE_CHUNK_BYTES,
        write_chunk_count: intent.program_len.div_ceil(PROGRAM_WRITE_CHUNK_BYTES),
        journal: matching_journal,
        deployment_attempts: matching_attempts,
        conflicting_journal,
        conflicting_deployment_attempts: conflicting_attempts,
    }))
}

async fn program_deployment_journal_by_program(
    Json(req): Json<ProgramDeploymentJournalByProgramRequest>,
) -> Result<Json<ProgramDeploymentJournalResponse>, ApiError> {
    if req.network.trim().is_empty() {
        return Err(ApiError {
            message: "部署网络不能为空".to_string(),
        });
    }
    let selector = rpc_selector(Some(req.network.trim()))?;
    let network = selector.network;
    let expected_genesis_text = req.expected_genesis_hash.trim();
    let expected_genesis_hash =
        solana_sdk::hash::Hash::from_str(expected_genesis_text).map_err(|_| ApiError {
            message: "无效的预期 genesis hash".to_string(),
        })?;
    if expected_genesis_hash == solana_sdk::hash::Hash::default()
        || expected_genesis_hash.to_string() != expected_genesis_text
    {
        return Err(ApiError {
            message: "预期 genesis hash 必须是 canonical 非零值".to_string(),
        });
    }
    let program_id = parse_canonical_deployment_pubkey(&req.program_id, "Program ID")?;
    let genesis_hash = expected_genesis_hash.to_string();
    let program_id = program_id.to_string();
    let (journal, deployment_attempts) =
        wallet_store::load_program_deployment_snapshot(&genesis_hash, &program_id)
            .map_err(|message| ApiError { message })?;
    let Some(record) = journal.as_ref() else {
        return Ok(Json(ProgramDeploymentJournalResponse {
            network,
            genesis_hash,
            write_chunk_bytes: PROGRAM_WRITE_CHUNK_BYTES,
            write_chunk_count: 0,
            journal: None,
            deployment_attempts: Vec::new(),
            conflicting_journal: None,
            conflicting_deployment_attempts: Vec::new(),
        }));
    };
    if !deployment_status_is_known(&record.status)
        || record.attempt_evidence_version
            != wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION
    {
        return Err(deployment_journal_error(format!(
            "Program {} 的部署记录状态或证据版本无效",
            program_id
        )));
    }
    for attempt in &deployment_attempts {
        validate_program_deployment_attempt_record(record, attempt)?;
    }
    Ok(Json(ProgramDeploymentJournalResponse {
        network,
        genesis_hash,
        write_chunk_bytes: PROGRAM_WRITE_CHUNK_BYTES,
        write_chunk_count: record.program_len.div_ceil(PROGRAM_WRITE_CHUNK_BYTES),
        journal: Some(ProgramDeploymentJournalView::from(record)),
        deployment_attempts,
        conflicting_journal: None,
        conflicting_deployment_attempts: Vec::new(),
    }))
}

#[cfg(test)]
mod generic_program_deployment_policy_tests {
    use super::*;

    fn unique_temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "fnzero-safe-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn valid_journal_request() -> ProgramDeploymentJournalRequest {
        ProgramDeploymentJournalRequest {
            network: "devnet".to_string(),
            expected_genesis_hash: solana_sdk::hash::Hash::new_unique().to_string(),
            expected_program_id: Pubkey::new_unique().to_string(),
            expected_program_sha256: "AB".repeat(32),
            program_len: 1_024,
            max_data_len: 2_048,
            expected_upgrade_authority: Pubkey::new_unique().to_string(),
        }
    }

    #[test]
    fn generic_journal_intent_normalizes_hash_without_hidden_policy() {
        let request = valid_journal_request();
        let intent = validate_program_deployment_journal_request(&request).unwrap();
        assert_eq!(intent.program_sha256, "ab".repeat(32));
        assert_eq!(intent.program_id.to_string(), request.expected_program_id);
        assert_eq!(
            intent.upgrade_authority.to_string(),
            request.expected_upgrade_authority
        );
    }

    #[test]
    fn program_write_chunk_fits_solana_transaction_packet() {
        let payer = Keypair::new();
        let buffer = Pubkey::new_unique();
        let chunk = vec![7_u8; PROGRAM_WRITE_CHUNK_BYTES];
        let instruction = loader_v3_instruction::write(&buffer, &payer.pubkey(), 0, chunk);
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&payer.pubkey()),
            &[&payer],
            solana_sdk::hash::Hash::new_unique(),
        );
        let serialized = bincode::serialize(&transaction).unwrap();
        assert!(
            serialized.len() <= SOLANA_TRANSACTION_PACKET_DATA_BYTES,
            "serialized write transaction is {} bytes, above packet limit {}",
            serialized.len(),
            SOLANA_TRANSACTION_PACKET_DATA_BYTES,
        );
    }

    #[test]
    fn external_sign_preview_summarizes_legacy_transaction() {
        let payer = Keypair::new();
        let recipient = Pubkey::new_unique();
        let instruction = Instruction {
            program_id: Pubkey::default(),
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(recipient, false),
            ],
            data: Vec::new(),
        };
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&payer.pubkey()),
            &[&payer],
            solana_sdk::hash::Hash::new_unique(),
        );
        let transaction_base64 = BASE64.encode(bincode::serialize(&transaction).unwrap());
        let preview = preview_external_transaction_request(&ExternalSignPreviewRequest {
            required_signer: payer.pubkey().to_string(),
            transaction_base64,
            transaction_format: Some("legacy".to_string()),
            known_programs: Vec::new(),
        })
        .unwrap();

        assert_eq!(preview.transaction_format, "legacy");
        assert!(preview.required_signer_present);
        assert_eq!(preview.required_signatures, 1);
        assert_eq!(preview.instructions.len(), 1);
        assert!(preview
            .instructions
            .first()
            .unwrap()
            .program_id
            .contains("System Program"));
        assert!(preview
            .writable_accounts
            .iter()
            .any(|account| account == &recipient.to_string()));
    }

    #[tokio::test]
    async fn external_sign_message_returns_base64_signature() {
        std::env::set_var(ALLOW_DIRECT_SECRET_INPUT_ENV, "true");
        let signer = Keypair::new();
        let message_base64 = BASE64.encode(b"fnzero wallet binding test");
        let Json(response) = external_sign_message(Json(ExternalSignMessageRequest {
            wallet: WalletAuthRequest {
                wallet_id: None,
                private_key: None,
                secret_key: Some(signer.to_base58_string()),
                keystore_json: None,
                encrypted_key: None,
                password: None,
            },
            required_signer: signer.pubkey().to_string(),
            message_base64: message_base64.clone(),
            request_id: Some("req-1".to_string()),
            expires_at: None,
        }))
        .await
        .unwrap();

        let signature_bytes = BASE64.decode(&response.signature).unwrap();
        let signature = Signature::try_from(signature_bytes.as_slice()).unwrap();
        assert!(signature.verify(signer.pubkey().as_ref(), b"fnzero wallet binding test"));
        assert_eq!(response.message_base64, message_base64);
    }

    #[test]
    fn generic_journal_intent_rejects_unsafe_boundaries() {
        let mut request = valid_journal_request();
        request.program_len = 0;
        assert!(validate_program_deployment_journal_request(&request).is_err());

        let mut request = valid_journal_request();
        request.max_data_len = request.program_len - 1;
        assert!(validate_program_deployment_journal_request(&request).is_err());

        let mut request = valid_journal_request();
        request.expected_program_sha256 = "xyz".to_string();
        assert!(validate_program_deployment_journal_request(&request).is_err());

        let mut request = valid_journal_request();
        request.expected_program_id = Pubkey::default().to_string();
        assert!(validate_program_deployment_journal_request(&request).is_err());

        let mut request = valid_journal_request();
        request.expected_genesis_hash = solana_sdk::hash::Hash::default().to_string();
        assert!(validate_program_deployment_journal_request(&request).is_err());
    }

    #[test]
    fn unknown_network_labels_never_fall_back_to_mainnet() {
        assert!(parse_rpc_selector("devnett").is_err());
        assert!(parse_rpc_selector("rpc:devnett:https%3A%2F%2Fexample.invalid").is_err());
        assert_eq!(parse_rpc_selector("mainnet").unwrap().network, "mainnet");
    }

    #[cfg(unix)]
    #[test]
    fn program_source_artifact_discovery_rejects_symlinks_outside_source_dir() {
        use std::os::unix::fs::symlink;

        let base = unique_temp_path("source-artifact-symlink");
        let source = base.join("source");
        let outside = base.join("outside");
        fs::create_dir_all(source.join("target/deploy")).unwrap();
        fs::create_dir_all(source.join(".keys")).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let outside_so = outside.join("escaped.so");
        let outside_keypair = outside.join("escaped-keypair.json");
        fs::write(&outside_so, b"not-a-program").unwrap();
        fs::write(&outside_keypair, b"[]").unwrap();
        symlink(&outside_so, source.join("target/deploy/escaped.so")).unwrap();
        symlink(&outside_keypair, source.join(".keys/escaped-keypair.json")).unwrap();

        let canonical_source = source.canonicalize().unwrap();
        assert!(find_program_so_path(&canonical_source, None).is_none());
        assert!(find_program_keypair_path(&canonical_source, None).is_none());
    }

    #[test]
    fn program_source_artifact_discovery_prefers_target_deploy_so() {
        let source = unique_temp_path("source-artifact-prefer-deploy-so");
        fs::create_dir_all(source.join("target/verifiable")).unwrap();
        fs::create_dir_all(source.join("target/deploy")).unwrap();

        let deploy_so = source.join("target/deploy/fnzero.so");
        let deploy_bytes = b"deploy-so";
        fs::write(&deploy_so, deploy_bytes).unwrap();

        // Even if verifiable is newer, target/deploy/<name>.so must win.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(
            source.join("target/verifiable/fnzero.so"),
            b"newer-verifiable",
        )
        .unwrap();
        fs::write(
            source.join("target/verifiable/fnzero-build.json"),
            format!(
                r#"{{"artifacts":{{"program":{{"sha256":"{}","length":{}}}}}}}"#,
                "0".repeat(64),
                99
            ),
        )
        .unwrap();

        let canonical_source = source.canonicalize().unwrap();
        let selected = find_program_so_path(&canonical_source, Some("fnzero")).unwrap();
        assert_eq!(selected, deploy_so.canonicalize().unwrap());

        let artifacts =
            load_program_source_artifacts(&canonical_source, Some("fnzero"), Some("devnet"), true)
                .unwrap();
        let deploy_sha = program_deploy::sha256_hex(deploy_bytes);
        assert_eq!(
            artifacts.program_so_path,
            Some(deploy_so.canonicalize().unwrap())
        );
        assert_eq!(
            artifacts.program_so_sha256.as_deref(),
            Some(deploy_sha.as_str())
        );
        assert!(artifacts
            .warnings
            .iter()
            .any(|warning| warning.contains("build metadata SHA-256")));

        let _ = fs::remove_dir_all(source);
    }

    #[test]
    fn program_keypair_discovery_prefers_so_stem_specific_keypair() {
        let source = unique_temp_path("source-artifact-keypair-stem");
        fs::create_dir_all(source.join(".keys")).unwrap();
        fs::create_dir_all(source.join("target/deploy")).unwrap();

        let unrelated_keypair = Keypair::new();
        let target_keypair = Keypair::new();
        fs::write(
            source.join(".keys/alpha-program-keypair.json"),
            serde_json::to_string(&unrelated_keypair.to_bytes().to_vec()).unwrap(),
        )
        .unwrap();
        fs::write(
            source.join("target/deploy/beta-keypair.json"),
            serde_json::to_string(&target_keypair.to_bytes().to_vec()).unwrap(),
        )
        .unwrap();

        let canonical_source = source.canonicalize().unwrap();
        let selected = find_program_keypair_path(&canonical_source, Some("beta")).unwrap();
        assert_eq!(
            selected,
            source
                .join("target/deploy/beta-keypair.json")
                .canonicalize()
                .unwrap()
        );
        let mut json = fs::read_to_string(selected).unwrap();
        let parsed = program_deploy::parse_program_keypair_json(&json).unwrap();
        json.zeroize();
        assert_eq!(parsed.pubkey(), target_keypair.pubkey());
        assert_eq!(
            artifact_stem_from_so_name("beta.so").as_deref(),
            Some("beta")
        );

        let _ = fs::remove_dir_all(source);
    }

    #[test]
    fn program_keypair_discovery_prefers_target_deploy_over_keys() {
        let source = unique_temp_path("source-artifact-keypair-prefer-deploy");
        fs::create_dir_all(source.join(".keys")).unwrap();
        fs::create_dir_all(source.join("target/deploy")).unwrap();

        let keys_keypair = Keypair::new();
        let deploy_keypair = Keypair::new();
        let keys_path = source.join(".keys/fnzero-program-keypair.json");
        let deploy_path = source.join("target/deploy/fnzero-keypair.json");
        fs::write(
            &deploy_path,
            serde_json::to_string(&deploy_keypair.to_bytes().to_vec()).unwrap(),
        )
        .unwrap();
        // Even if .keys is newer, target/deploy must win.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(
            &keys_path,
            serde_json::to_string(&keys_keypair.to_bytes().to_vec()).unwrap(),
        )
        .unwrap();

        let canonical_source = source.canonicalize().unwrap();
        let selected = find_program_keypair_path(&canonical_source, Some("fnzero")).unwrap();
        assert_eq!(selected, deploy_path.canonicalize().unwrap());
        let mut json = fs::read_to_string(selected).unwrap();
        let parsed = program_deploy::parse_program_keypair_json(&json).unwrap();
        json.zeroize();
        assert_eq!(parsed.pubkey(), deploy_keypair.pubkey());

        let _ = fs::remove_dir_all(source);
    }

    #[test]
    fn program_keypair_discovery_falls_back_to_keys_when_deploy_missing() {
        let source = unique_temp_path("source-artifact-keypair-keys-fallback");
        fs::create_dir_all(source.join(".keys")).unwrap();
        fs::create_dir_all(source.join("target/deploy")).unwrap();

        let keys_keypair = Keypair::new();
        let keys_path = source.join(".keys/fnzero-program-keypair.json");
        fs::write(
            &keys_path,
            serde_json::to_string(&keys_keypair.to_bytes().to_vec()).unwrap(),
        )
        .unwrap();

        let canonical_source = source.canonicalize().unwrap();
        let selected = find_program_keypair_path(&canonical_source, Some("fnzero")).unwrap();
        assert_eq!(selected, keys_path.canonicalize().unwrap());
        let mut json = fs::read_to_string(selected).unwrap();
        let parsed = program_deploy::parse_program_keypair_json(&json).unwrap();
        json.zeroize();
        assert_eq!(parsed.pubkey(), keys_keypair.pubkey());

        let _ = fs::remove_dir_all(source);
    }

    #[test]
    fn program_source_artifacts_block_mismatched_program_ids_before_deploy() {
        let source = unique_temp_path("source-artifact-program-id-validation");
        fs::create_dir_all(source.join("target/deploy")).unwrap();
        fs::create_dir_all(source.join("target/idl")).unwrap();
        fs::create_dir_all(source.join("programs/fnzero/src")).unwrap();

        let expected_keypair = Keypair::new();
        let stale_program_pubkey = Pubkey::new_unique();
        let stale_program_id = stale_program_pubkey.to_string();
        let mut stale_so = b"\x7fELFAnchorError occurred".to_vec();
        stale_so.extend_from_slice(&stale_program_pubkey.to_bytes());
        fs::write(source.join("target/deploy/fnzero.so"), stale_so).unwrap();
        fs::write(
            source.join("target/deploy/fnzero-keypair.json"),
            serde_json::to_string(&expected_keypair.to_bytes().to_vec()).unwrap(),
        )
        .unwrap();
        fs::write(
            source.join("Anchor.toml"),
            format!(
                r#"[programs.devnet]
fnzero = "{stale_program_id}"
"#
            ),
        )
        .unwrap();
        fs::write(
            source.join("target/idl/fnzero.json"),
            format!(r#"{{"address":"{stale_program_id}","instructions":[]}}"#),
        )
        .unwrap();
        fs::write(
            source.join("programs/fnzero/src/lib.rs"),
            format!(r#"declare_id!("{stale_program_id}");"#),
        )
        .unwrap();

        let canonical_source = source.canonicalize().unwrap();
        let artifacts =
            load_program_source_artifacts(&canonical_source, Some("fnzero"), Some("devnet"), true)
                .unwrap();

        let expected_program_id = expected_keypair.pubkey().to_string();
        assert_eq!(
            artifacts.expected_program_id.as_deref(),
            Some(expected_program_id.as_str())
        );
        assert!(artifacts
            .source_validation_errors
            .iter()
            .any(|error| { error.contains("Anchor.toml") && error.contains(&stale_program_id) }));
        assert!(artifacts
            .source_validation_errors
            .iter()
            .any(|error| error.contains("target/idl/fnzero.json")));
        assert!(artifacts
            .source_validation_errors
            .iter()
            .any(|error| error.contains("declare_id!")));
        assert!(
            artifacts
                .source_validation_errors
                .iter()
                .any(|error| error.contains("target/deploy/fnzero.so")
                    && error.contains("Anchor .so"))
        );
        assert!(artifacts
            .warnings
            .iter()
            .any(|warning| warning.contains("部署前一致性校验发现")));

        let _ = fs::remove_dir_all(source);
    }

    #[test]
    fn prebuild_program_id_validation_blocks_only_source_declarations() {
        let source = unique_temp_path("source-prebuild-program-id-validation");
        fs::create_dir_all(source.join("target/idl")).unwrap();
        fs::create_dir_all(source.join("programs/fnzero/src")).unwrap();

        let expected_program_id = Pubkey::new_unique().to_string();
        let stale_idl_program_id = Pubkey::new_unique().to_string();
        fs::write(
            source.join("Anchor.toml"),
            format!(
                r#"[programs.devnet]
fnzero = "{expected_program_id}"
"#
            ),
        )
        .unwrap();
        fs::write(
            source.join("target/idl/fnzero.json"),
            format!(r#"{{"address":"{stale_idl_program_id}","instructions":[]}}"#),
        )
        .unwrap();
        fs::write(
            source.join("programs/fnzero/src/lib.rs"),
            format!(r#"declare_id!("{expected_program_id}");"#),
        )
        .unwrap();

        let canonical_source = source.canonicalize().unwrap();
        let prebuild_errors = collect_prebuild_source_validation_errors(
            &canonical_source,
            Some("fnzero"),
            Some("devnet"),
            Some(&expected_program_id),
        )
        .unwrap();
        let postbuild_errors = collect_source_validation_errors(
            &canonical_source,
            Some("fnzero"),
            Some("devnet"),
            Some(&expected_program_id),
            None,
        )
        .unwrap();

        assert!(prebuild_errors.is_empty());
        assert!(postbuild_errors
            .iter()
            .any(|error| error.contains("target/idl/fnzero.json")));

        let _ = fs::remove_dir_all(source);
    }

    #[test]
    fn generated_program_keypair_helpers_sync_anchor_sources() {
        let source = unique_temp_path("source-generate-program-keypair-sync");
        fs::create_dir_all(source.join("programs/fnzero/src")).unwrap();

        let old_program_id = Pubkey::new_unique().to_string();
        let new_program_id = Pubkey::new_unique().to_string();
        fs::write(
            source.join("Anchor.toml"),
            format!(
                r#"[programs.devnet]
fnzero = "{old_program_id}"
"#
            ),
        )
        .unwrap();
        fs::write(
            source.join("programs/fnzero/src/lib.rs"),
            format!(
                r#"use anchor_lang::prelude::*;
declare_id!("{old_program_id}");
"#
            ),
        )
        .unwrap();

        let canonical_source = source.canonicalize().unwrap();
        let anchor_updates =
            update_anchor_program_ids(&canonical_source, Some("fnzero"), &new_program_id).unwrap();
        let rust_updates =
            update_rust_declare_id_files(&canonical_source, Some("fnzero"), &new_program_id)
                .unwrap();

        assert_eq!(anchor_updates.len(), 1);
        assert_eq!(rust_updates.len(), 1);
        assert!(fs::read_to_string(source.join("Anchor.toml"))
            .unwrap()
            .contains(&new_program_id));
        assert!(
            fs::read_to_string(source.join("programs/fnzero/src/lib.rs"))
                .unwrap()
                .contains(&new_program_id)
        );
        assert!(
            !fs::read_to_string(source.join("programs/fnzero/src/lib.rs"))
                .unwrap()
                .contains(&old_program_id)
        );

        let _ = fs::remove_dir_all(source);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeployProgramRequest {
    #[serde(default)]
    wallet_id: Option<String>,
    #[serde(default)]
    private_key: Option<String>,
    #[serde(default)]
    secret_key: Option<String>,
    #[serde(default)]
    keystore_json: Option<String>,
    #[serde(default)]
    encrypted_key: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    program_keypair_json: Option<String>,
    #[serde(default)]
    program_keypair_path: Option<String>,
    expected_program_id: String,
    expected_upgrade_authority: String,
    expected_genesis_hash: String,
    expected_program_sha256: String,
    program_so_base64: String,
    network: String,
    #[serde(default)]
    max_data_len: Option<usize>,
    #[serde(default)]
    resume_buffer_address: Option<String>,
}

impl DeployProgramRequest {
    fn take_wallet_auth(&mut self) -> WalletAuthRequest {
        WalletAuthRequest {
            wallet_id: self.wallet_id.take(),
            private_key: self.private_key.take(),
            secret_key: self.secret_key.take(),
            keystore_json: self.keystore_json.take(),
            encrypted_key: self.encrypted_key.take(),
            password: self.password.take(),
        }
    }
}

impl Drop for DeployProgramRequest {
    fn drop(&mut self) {
        if let Some(value) = self.program_keypair_json.as_mut() {
            value.zeroize();
        }
        self.take_wallet_auth().clear_secrets();
    }
}

#[derive(Serialize)]
struct DeployProgramResponse {
    program_id: String,
    programdata_address: String,
    buffer_address: String,
    authority: String,
    network: String,
    genesis_hash: String,
    program_bytes: usize,
    max_data_len: usize,
    program_sha256: String,
    temporary_buffer_rent_lamports: u64,
    program_rent_lamports: u64,
    programdata_rent_lamports: u64,
    rent_lamports: u64,
    estimated_transaction_fees_lamports: u64,
    fee_rate_reserve_lamports: u64,
    recovery_write_reserve_lamports: u64,
    total_fee_budget_lamports: u64,
    estimated_required_balance_lamports: u64,
    create_buffer_signature: Option<String>,
    skipped_write_chunks: usize,
    write_signatures: Vec<String>,
    deploy_signature: String,
    finalized_slot: u64,
    deployed_slot: u64,
    readback_verified: bool,
    journal_revision: Option<u64>,
    attempt_evidence_version: Option<u32>,
    deployment_attempts: Vec<wallet_store::ProgramDeploymentAttemptRecord>,
    status: String,
}

async fn deploy_generic_program(
    Json(req): Json<DeployProgramRequest>,
) -> Result<Json<DeployProgramResponse>, ApiError> {
    deploy_program(Json(req)).await
}

async fn deploy_program(
    Json(mut req): Json<DeployProgramRequest>,
) -> Result<Json<DeployProgramResponse>, ApiError> {
    let _deploy_guard = PROGRAM_DEPLOY_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .try_lock()
        .map_err(|_| ApiError {
            message: PROGRAM_DEPLOY_BUSY_MESSAGE.to_string(),
        })?;
    let expected_upgrade_authority = Pubkey::from_str(req.expected_upgrade_authority.trim())
        .map_err(|_| ApiError {
            message: "无效的预期 Upgrade Authority".to_string(),
        })?;

    let program_bytes = decode_program_binary_base64(&req.program_so_base64)?;

    let program_keypair_json = match (
        req.program_keypair_json.take(),
        req.program_keypair_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    ) {
        (Some(json), None) => json,
        (None, Some(path)) => {
            let path = PathBuf::from(path)
                .canonicalize()
                .map_err(|error| ApiError {
                    message: format!("Program keypair 路径不可访问: {error}"),
                })?;
            read_text_file_limited(
                &path,
                program_deploy::MAX_PROGRAM_KEYPAIR_JSON_BYTES,
                "Program keypair",
            )?
        }
        (Some(mut json), Some(_)) => {
            json.zeroize();
            return Err(ApiError {
                message: "Program keypair JSON 与路径只能提供一个".to_string(),
            });
        }
        (None, None) => {
            return Err(ApiError {
                message: "必须提供 Program keypair JSON 或 Program keypair 路径".to_string(),
            });
        }
    };
    let mut program_keypair_json = Zeroizing::new(program_keypair_json);
    let program_keypair_result = program_deploy::parse_program_keypair_json(&program_keypair_json);
    program_keypair_json.zeroize();
    let program_keypair = program_keypair_result.map_err(|message| ApiError { message })?;
    let program_id =
        program_deploy::require_program_id(&program_keypair, req.expected_program_id.trim())
            .map_err(|message| ApiError { message })?;

    let program_sha256 =
        program_deploy::require_sha256(&program_bytes, &req.expected_program_sha256)
            .map_err(|message| ApiError { message })?;
    program_deploy::require_anchor_declared_program_id(&program_bytes, &program_id)
        .map_err(|message| ApiError { message })?;
    let program_bytes = verify_program_binary_offline(program_bytes).await?;

    let requested_resume_buffer_address = req
        .resume_buffer_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Pubkey::from_str(value).map_err(|_| ApiError {
                message: "无效的恢复 Buffer 地址".to_string(),
            })
        })
        .transpose()?;
    let max_data_len = req.max_data_len.unwrap_or(program_bytes.len());
    if max_data_len < program_bytes.len() {
        return Err(ApiError {
            message: "最大 Program 数据长度不能小于 .so 文件大小".to_string(),
        });
    }
    if max_data_len > MAX_PROGRAM_SO_BYTES {
        return Err(ApiError {
            message: format!(
                "最大 Program 数据长度不能超过 {} bytes（Solana Upgradeable Loader 协议上限）",
                MAX_PROGRAM_SO_BYTES
            ),
        });
    }

    if req.network.trim().is_empty() {
        return Err(ApiError {
            message: "部署网络不能为空".to_string(),
        });
    }
    let selector = rpc_selector(Some(req.network.trim()))?;
    let rpc_url = selector.url;
    let network = selector.network;
    let client = RpcClient::new_with_timeout_and_commitment(
        rpc_url.to_string(),
        Duration::from_secs(PROGRAM_DEPLOY_RPC_TIMEOUT_SECS),
        CommitmentConfig::confirmed(),
    );

    let expected_genesis_hash = solana_sdk::hash::Hash::from_str(req.expected_genesis_hash.trim())
        .map_err(|_| ApiError {
            message: "无效的预期 genesis hash".to_string(),
        })?;
    let actual_genesis_hash = client.get_genesis_hash().map_err(|error| ApiError {
        message: format!("读取 RPC genesis hash 失败: {error}"),
    })?;
    if actual_genesis_hash != expected_genesis_hash {
        return Err(ApiError {
            message: format!(
                "RPC genesis hash 为 {}，预期为 {}；已在花费前中止部署",
                actual_genesis_hash, expected_genesis_hash
            ),
        });
    }

    let genesis_hash = actual_genesis_hash.to_string();
    let mut deployment_journal =
        wallet_store::find_program_deployment(&genesis_hash, &program_id.to_string())
            .map_err(|message| ApiError { message })?;
    let mut deployment_journal_binding_matches = true;
    let mut finalized_journal_binding_conflicts = false;
    let journal_buffer_address = if let Some(record) = deployment_journal.as_ref() {
        if !deployment_status_is_known(&record.status) {
            return Err(deployment_journal_error(format!(
                "Program {} 的记录状态 {} 无法识别，拒绝继续",
                program_id, record.status
            )));
        }
        match validate_deployment_journal_binding(
            record,
            &genesis_hash,
            &program_id,
            &program_sha256,
            program_bytes.len(),
            max_data_len,
            &expected_upgrade_authority,
            requested_resume_buffer_address.as_ref(),
        ) {
            Ok(buffer) => Some(buffer),
            Err(_)
                if requested_resume_buffer_address.is_none()
                    && record.status != DEPLOYMENT_STATUS_FINALIZED =>
            {
                deployment_journal_binding_matches = false;
                None
            }
            Err(_)
                if requested_resume_buffer_address.is_none()
                    && record.status == DEPLOYMENT_STATUS_FINALIZED =>
            {
                deployment_journal_binding_matches = false;
                finalized_journal_binding_conflicts = true;
                None
            }
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    let deployment_attempts = if let Some(record) = deployment_journal.as_ref() {
        if deployment_journal_binding_matches {
            let attempts = wallet_store::load_program_deployment_attempts(
                &record.genesis_hash,
                &record.program_id,
            )
            .map_err(|message| ApiError { message })?;
            for attempt in &attempts {
                validate_program_deployment_attempt_record(record, attempt)?;
            }
            attempts
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    if !deployment_journal_binding_matches {
        deployment_journal = None;
    }

    let programdata_address = get_program_data_address(&program_id);
    let deployment_state_addresses = vec![program_id, programdata_address];
    let existing_accounts = client
        .get_multiple_accounts_with_commitment(
            &deployment_state_addresses,
            CommitmentConfig::finalized(),
        )
        .map_err(|error| ApiError {
            message: format!("部署前查询 Program 与 ProgramData 失败: {error}"),
        })?;
    let existing_finalized_slot = existing_accounts.context.slot;
    if existing_accounts.value.len() != deployment_state_addresses.len() {
        return Err(ApiError {
            message: "部署前 finalized 账户查询结果不完整，拒绝部署".to_string(),
        });
    }
    let mut existing_values = existing_accounts.value.into_iter();
    let existing_program = existing_values.next().flatten();
    let existing_programdata = existing_values.next().flatten();

    let existing_verified_readback = match (existing_program, existing_programdata) {
        (None, None) => None,
        (Some(program), Some(programdata)) => Some(
            program_deploy::verify_deployment_readback(
                &program_id,
                &expected_upgrade_authority,
                &program_bytes,
                max_data_len,
                &program.owner,
                program.executable,
                &program.data,
                &programdata.owner,
                &programdata.data,
            )
            .map_err(|error| ApiError {
                message: format!(
                    "目标 Program 已存在，但链上 finalized 代码与本次 .so 不一致；同一个 Program ID 不能再次走“新部署”，请使用升级流程发布新 .so，或生成新的 Program keypair 后全新部署。链上校验详情: {error}"
                ),
            })?,
        ),
        _ => {
            return Err(ApiError {
                message: format!(
                    "目标 Program 与 ProgramData 只有一个存在（Program ID: {}），拒绝继续部署",
                    program_id
                ),
            })
        }
    };

    if finalized_journal_binding_conflicts && existing_verified_readback.is_none() {
        return Err(ApiError {
            message: format!(
                "Program {} 已有 finalized 部署记录，但当前 artifact 与记录不同，且链上 finalized Program 不可见；为避免覆盖历史或误复用 Program ID，请生成新的 Program keypair 后新部署，或确认链上 Program 存在后使用升级流程",
                program_id
            ),
        });
    }

    let buffer_lamports = client
        .get_minimum_balance_for_rent_exemption(UpgradeableLoaderState::size_of_buffer(
            program_bytes.len(),
        ))
        .map_err(|e| ApiError {
            message: format!("计算 buffer 租金失败: {}", e),
        })?;
    let program_lamports = client
        .get_minimum_balance_for_rent_exemption(UpgradeableLoaderState::size_of_program())
        .map_err(|e| ApiError {
            message: format!("计算 program 租金失败: {}", e),
        })?;
    let programdata_lamports = client
        .get_minimum_balance_for_rent_exemption(UpgradeableLoaderState::size_of_programdata(
            max_data_len,
        ))
        .map_err(|e| ApiError {
            message: format!("计算 ProgramData 租金失败: {}", e),
        })?;
    let final_rent_lamports = program_lamports
        .checked_add(programdata_lamports)
        .ok_or_else(|| ApiError {
            message: "Program 与 ProgramData 最终租金总额溢出".to_string(),
        })?;

    let wallet_auth = req.take_wallet_auth();
    let payer = run_keystore_task(move || wallet_auth.keypair()).await?;
    let payer_pubkey = payer.pubkey();
    if expected_upgrade_authority != payer_pubkey {
        return Err(ApiError {
            message: format!(
                "预期 Upgrade Authority 为 {}，但付款钱包为 {}；首次部署必须由该 authority 付款并持有升级权限",
                expected_upgrade_authority, payer_pubkey
            ),
        });
    }
    if let Some(readback) = existing_verified_readback {
        if readback.program_sha256 != program_sha256 {
            return Err(ApiError {
                message: "finalized Program SHA-256 与本地已验证哈希不一致".to_string(),
            });
        }
        for attempt in deployment_attempts.iter().filter(|attempt| {
            attempt.stage == wallet_store::PROGRAM_DEPLOYMENT_STAGE_DEPLOY
                && deployment_attempt_is_active(&attempt.status)
        }) {
            let completed_writes = deployment_journal
                .as_ref()
                .map(|record| record.completed_writes)
                .unwrap_or_default();
            transition_deployment_attempt(
                &mut deployment_journal,
                &attempt.signature,
                &attempt.status,
                wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED,
                DEPLOYMENT_STATUS_FINALIZED,
                completed_writes,
            )?;
        }
        if deployment_journal
            .as_ref()
            .is_some_and(|record| record.status != DEPLOYMENT_STATUS_FINALIZED)
        {
            let completed_writes = deployment_journal
                .as_ref()
                .map(|record| record.completed_writes)
                .unwrap_or_default();
            transition_deployment_journal(
                &mut deployment_journal,
                DEPLOYMENT_STATUS_FINALIZED,
                None,
                None,
                None,
                None,
                None,
                completed_writes,
                None,
                None,
            )?;
        }
        let (journal_revision, attempt_evidence_version, deployment_attempts) =
            load_deployment_receipt_evidence(deployment_journal.as_ref())?;
        let buffer_address = deployment_journal
            .as_ref()
            .map(|record| record.buffer_address.clone())
            .unwrap_or_default();
        let create_buffer_signature = deployment_journal
            .as_ref()
            .and_then(|record| record.create_signature.clone());
        let deploy_signature = deployment_journal
            .as_ref()
            .and_then(|record| record.deploy_signature.clone())
            .unwrap_or_default();
        let write_signatures = deployment_attempts
            .iter()
            .filter(|attempt| attempt.stage == wallet_store::PROGRAM_DEPLOYMENT_STAGE_WRITE)
            .map(|attempt| attempt.signature.clone())
            .collect();
        return Ok(Json(DeployProgramResponse {
            program_id: program_id.to_string(),
            programdata_address: programdata_address.to_string(),
            buffer_address,
            authority: readback.upgrade_authority.to_string(),
            network,
            genesis_hash,
            program_bytes: program_bytes.len(),
            max_data_len,
            program_sha256,
            temporary_buffer_rent_lamports: buffer_lamports,
            program_rent_lamports: program_lamports,
            programdata_rent_lamports: programdata_lamports,
            rent_lamports: final_rent_lamports,
            estimated_transaction_fees_lamports: 0,
            fee_rate_reserve_lamports: 0,
            recovery_write_reserve_lamports: 0,
            total_fee_budget_lamports: 0,
            estimated_required_balance_lamports: 0,
            create_buffer_signature,
            skipped_write_chunks: program_bytes.chunks(PROGRAM_WRITE_CHUNK_BYTES).count(),
            write_signatures,
            deploy_signature,
            finalized_slot: existing_finalized_slot,
            deployed_slot: readback.deployed_slot,
            readback_verified: true,
            journal_revision,
            attempt_evidence_version,
            deployment_attempts,
            status: "already_deployed_verified".to_string(),
        }));
    }

    let deploy_attempts = deployment_attempts
        .iter()
        .filter(|attempt| attempt.stage == wallet_store::PROGRAM_DEPLOYMENT_STAGE_DEPLOY)
        .collect::<Vec<_>>();
    for attempt in &deploy_attempts {
        if deployment_attempt_is_blocking_terminal(&attempt.status) {
            return Err(deployment_journal_error(format!(
                "deploy attempt {} 已处于终态 {}，但 finalized Program 不存在；禁止自动重签",
                attempt.signature, attempt.status
            )));
        }
        if deployment_attempt_is_active(&attempt.status) {
            let completed_writes = deployment_journal
                .as_ref()
                .map(|record| record.completed_writes)
                .unwrap_or_default();
            reconcile_absent_deployment_attempt(
                &client,
                &mut deployment_journal,
                attempt,
                DEPLOYMENT_STATUS_BUFFER_FINALIZED,
                completed_writes,
                |client, min_context_slot| {
                    confirm_deploy_attempt_still_absent(
                        client,
                        &program_id,
                        &programdata_address,
                        min_context_slot,
                    )
                },
            )?;
        }
    }
    if deployment_journal.as_ref().is_some_and(|record| {
        matches!(
            record.status.as_str(),
            DEPLOYMENT_STATUS_DEPLOY_SIGNED
                | DEPLOYMENT_STATUS_DEPLOY_RECONCILE
                | DEPLOYMENT_STATUS_DEPLOY_FINALIZED
                | DEPLOYMENT_STATUS_FINALIZED
        ) && deploy_attempts.is_empty()
    }) {
        return Err(deployment_journal_error(
            "journal 处于 deploy 状态但缺少完整 signature/last-valid-block-height attempt 证据",
        ));
    }

    let mut buffer_keypair = (journal_buffer_address.is_none()
        && requested_resume_buffer_address.is_none())
    .then(Keypair::new);
    let mut buffer_address = journal_buffer_address
        .or(requested_resume_buffer_address)
        .or_else(|| buffer_keypair.as_ref().map(|keypair| keypair.pubkey()))
        .ok_or_else(|| ApiError {
            message: "无法确定部署 Buffer 地址".to_string(),
        })?;
    let mut rotating_create_buffer = false;

    let (mut write_plan, resume_buffer_lamports) = if buffer_keypair.is_none() {
        let response = client
            .get_account_with_commitment(&buffer_address, CommitmentConfig::finalized())
            .map_err(|error| ApiError {
                message: format!("读取恢复 Buffer {} 失败: {error}", buffer_address),
            })?;
        if let Some(account) = response.value {
            if account.lamports < buffer_lamports {
                return Err(ApiError {
                    message: format!(
                        "恢复 Buffer {} 余额为 {} lamports，低于当前所需免租金额 {}",
                        buffer_address, account.lamports, buffer_lamports
                    ),
                });
            }
            let plan = program_deploy::verify_resume_buffer(
                &payer_pubkey,
                &program_bytes,
                PROGRAM_WRITE_CHUNK_BYTES,
                &account.owner,
                account.executable,
                &account.data,
            )
            .map_err(|error| ApiError {
                message: format!("恢复 Buffer {} 校验失败: {error}", buffer_address),
            })?;
            for attempt in deployment_attempts.iter().filter(|attempt| {
                attempt.stage == wallet_store::PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER
                    && attempt.buffer_address == buffer_address.to_string()
                    && deployment_attempt_is_active(&attempt.status)
            }) {
                transition_deployment_attempt(
                    &mut deployment_journal,
                    &attempt.signature,
                    &attempt.status,
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED,
                    DEPLOYMENT_STATUS_BUFFER_READY,
                    plan.completed_chunks,
                )?;
            }
            (plan, account.lamports)
        } else {
            let record = deployment_journal.as_ref().ok_or_else(|| ApiError {
                message: format!(
                    "恢复 Buffer {} 在 finalized 状态下不存在，且没有可审计的 create attempt；拒绝自动创建新 Buffer",
                    buffer_address
                ),
            })?;
            if record.completed_writes != 0
                || deployment_attempts.iter().any(|attempt| {
                    matches!(
                        attempt.stage.as_str(),
                        wallet_store::PROGRAM_DEPLOYMENT_STAGE_WRITE
                            | wallet_store::PROGRAM_DEPLOYMENT_STAGE_DEPLOY
                    )
                })
            {
                return Err(deployment_journal_error(format!(
                    "Buffer {} 不存在，但 journal 已包含 write/deploy 证据；拒绝轮换地址",
                    buffer_address
                )));
            }
            let create_attempts = deployment_attempts
                .iter()
                .filter(|attempt| {
                    attempt.stage == wallet_store::PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER
                        && attempt.buffer_address == buffer_address.to_string()
                })
                .collect::<Vec<_>>();
            if let Some(attempt) = create_attempts
                .iter()
                .find(|attempt| deployment_attempt_is_blocking_terminal(&attempt.status))
            {
                return Err(deployment_journal_error(format!(
                    "create-buffer attempt {} 已处于终态 {}，但 finalized Buffer 不存在；禁止自动轮换",
                    attempt.signature, attempt.status
                )));
            }
            let active_create_attempts = create_attempts
                .iter()
                .filter(|attempt| deployment_attempt_is_active(&attempt.status))
                .copied()
                .collect::<Vec<_>>();
            if active_create_attempts.len() > 1 {
                return Err(deployment_journal_error(
                    "同一 Buffer 存在多个活动 create attempt，拒绝自动恢复",
                ));
            }
            if let Some(attempt) = active_create_attempts.first() {
                reconcile_absent_deployment_attempt(
                    &client,
                    &mut deployment_journal,
                    attempt,
                    DEPLOYMENT_STATUS_CREATE_BUFFER_RECONCILE,
                    0,
                    |client, min_context_slot| {
                        confirm_create_buffer_attempt_still_absent(
                            client,
                            &buffer_address,
                            min_context_slot,
                        )
                    },
                )?;
            } else if !create_attempts.iter().any(|attempt| {
                attempt.status == wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_EXPIRED_ABSENT
            }) {
                return Err(deployment_journal_error(format!(
                    "Buffer {} 不存在且缺少完整 create signature/last-valid-block-height 证据",
                    buffer_address
                )));
            }
            let replacement = Keypair::new();
            buffer_address = replacement.pubkey();
            buffer_keypair = Some(replacement);
            rotating_create_buffer = true;
            (
                program_deploy::BufferWritePlan {
                    completed_chunks: 0,
                    pending_chunk_indexes: (0..program_bytes
                        .chunks(PROGRAM_WRITE_CHUNK_BYTES)
                        .count())
                        .collect(),
                },
                0,
            )
        }
    } else {
        (
            program_deploy::BufferWritePlan {
                completed_chunks: 0,
                pending_chunk_indexes: (0..program_bytes.chunks(PROGRAM_WRITE_CHUNK_BYTES).count())
                    .collect(),
            },
            0,
        )
    };

    if buffer_keypair.is_none() {
        let chain_completed = write_plan.completed_chunks;
        let total_chunks = chain_completed
            .checked_add(write_plan.pending_chunk_indexes.len())
            .ok_or_else(|| deployment_journal_error("Buffer chunk 总数溢出"))?;
        if let Some(record) = deployment_journal.as_ref() {
            if record.attempt_evidence_version == 0 {
                if record.completed_writes > chain_completed {
                    return Err(deployment_journal_error(format!(
                        "旧 journal 的完成计数 {} 大于 finalized Buffer 的 {}；该旧值可能来自 confirmed 状态，拒绝自动迁移",
                        record.completed_writes, chain_completed
                    )));
                }
                match record.status.as_str() {
                    DEPLOYMENT_STATUS_WRITE_SIGNED
                    | DEPLOYMENT_STATUS_WRITE_CONFIRMED
                    | DEPLOYMENT_STATUS_WRITE_RECONCILE => {
                        let last_index = record.last_write_chunk_index.ok_or_else(|| {
                            deployment_journal_error(
                                "旧 write journal 缺少 chunk index，无法证明此前尝试均已落地",
                            )
                        })?;
                        if last_index >= total_chunks
                            || write_plan
                                .pending_chunk_indexes
                                .iter()
                                .any(|pending| *pending < last_index)
                        {
                            return Err(deployment_journal_error(
                                "旧 write journal 存在无法还原的早期 pending chunk，拒绝自动重签",
                            ));
                        }
                        if write_plan.pending_chunk_indexes.contains(&last_index)
                            && !deployment_attempts.iter().any(|attempt| {
                                attempt.stage == wallet_store::PROGRAM_DEPLOYMENT_STAGE_WRITE
                                    && attempt.chunk_index == Some(last_index)
                            })
                        {
                            return Err(deployment_journal_error(
                                "旧 write journal 的最后一个 pending chunk 缺少完整签名证据",
                            ));
                        }
                    }
                    DEPLOYMENT_STATUS_BUFFER_READY if chain_completed < record.completed_writes => {
                        return Err(deployment_journal_error(format!(
                            "finalized Buffer 仅完成 {} 块，少于旧 journal 的 {} 块",
                            chain_completed, record.completed_writes
                        )));
                    }
                    DEPLOYMENT_STATUS_BUFFER_FINALIZED
                    | DEPLOYMENT_STATUS_DEPLOY_SIGNED
                    | DEPLOYMENT_STATUS_DEPLOY_RECONCILE
                    | DEPLOYMENT_STATUS_DEPLOY_FINALIZED
                    | DEPLOYMENT_STATUS_FINALIZED
                        if !write_plan.pending_chunk_indexes.is_empty() =>
                    {
                        return Err(deployment_journal_error(
                            "旧 journal 声称 Buffer 已 finalized，但回读仍存在 pending chunk",
                        ));
                    }
                    DEPLOYMENT_STATUS_CREATE_BUFFER_SIGNED
                    | DEPLOYMENT_STATUS_CREATE_BUFFER_RECONCILE
                        if record.completed_writes != 0 =>
                    {
                        return Err(deployment_journal_error(
                            "旧 create-buffer journal 含非零写入进度，拒绝迁移",
                        ));
                    }
                    _ => {}
                }
            } else if chain_completed < record.completed_writes {
                return Err(deployment_journal_error(format!(
                    "finalized Buffer 仅完成 {} 块，少于 journal 的 {} 块",
                    chain_completed, record.completed_writes
                )));
            }
        }

        for attempt in deployment_attempts
            .iter()
            .filter(|attempt| attempt.stage == wallet_store::PROGRAM_DEPLOYMENT_STAGE_WRITE)
        {
            let index = attempt
                .chunk_index
                .ok_or_else(|| deployment_journal_error("write attempt 缺少 chunk index"))?;
            if index >= total_chunks {
                return Err(deployment_journal_error(format!(
                    "write attempt {} 的 chunk index {} 超出总块数 {}",
                    attempt.signature, index, total_chunks
                )));
            }
            let pending = write_plan.pending_chunk_indexes.contains(&index);
            if pending && deployment_attempt_is_blocking_terminal(&attempt.status) {
                return Err(deployment_journal_error(format!(
                    "write chunk {} 的 attempt {} 已处于终态 {}，但 finalized Buffer 仍未包含该块",
                    index, attempt.signature, attempt.status
                )));
            }
            if !deployment_attempt_is_active(&attempt.status) {
                continue;
            }
            let completed_for_transition = deployment_journal
                .as_ref()
                .map(|_| chain_completed)
                .unwrap_or(chain_completed);
            if pending {
                reconcile_absent_deployment_attempt(
                    &client,
                    &mut deployment_journal,
                    attempt,
                    DEPLOYMENT_STATUS_BUFFER_READY,
                    completed_for_transition,
                    |client, min_context_slot| {
                        confirm_write_attempt_still_absent(
                            client,
                            &buffer_address,
                            &payer_pubkey,
                            &program_bytes,
                            &write_plan,
                            index,
                            min_context_slot,
                        )
                    },
                )?;
            } else {
                transition_deployment_attempt(
                    &mut deployment_journal,
                    &attempt.signature,
                    &attempt.status,
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED,
                    DEPLOYMENT_STATUS_BUFFER_READY,
                    completed_for_transition,
                )?;
            }
        }

        if let Some(record) = deployment_journal.as_ref() {
            if record.attempt_evidence_version == 0 {
                let promoted = wallet_store::promote_program_deployment_attempt_evidence(
                    record,
                    DEPLOYMENT_STATUS_BUFFER_READY,
                    chain_completed,
                )
                .map_err(|message| ApiError { message })?;
                deployment_journal = Some(promoted);
            } else if record.completed_writes != chain_completed
                || matches!(
                    record.status.as_str(),
                    DEPLOYMENT_STATUS_CREATE_BUFFER_SIGNED
                        | DEPLOYMENT_STATUS_CREATE_BUFFER_RECONCILE
                        | DEPLOYMENT_STATUS_WRITE_SIGNED
                        | DEPLOYMENT_STATUS_WRITE_CONFIRMED
                        | DEPLOYMENT_STATUS_WRITE_RECONCILE
                        | DEPLOYMENT_STATUS_DEPLOY_SIGNED
                        | DEPLOYMENT_STATUS_DEPLOY_RECONCILE
                        | DEPLOYMENT_STATUS_DEPLOY_FINALIZED
                )
            {
                transition_deployment_journal(
                    &mut deployment_journal,
                    DEPLOYMENT_STATUS_BUFFER_READY,
                    None,
                    None,
                    None,
                    None,
                    None,
                    chain_completed,
                    None,
                    None,
                )?;
            }
        }
    }

    let create_buffer_ixs = if buffer_keypair.is_some() {
        Some(
            loader_v3_instruction::create_buffer(
                &payer_pubkey,
                &buffer_address,
                &payer_pubkey,
                buffer_lamports,
                program_bytes.len(),
            )
            .map_err(|e| ApiError {
                message: format!("创建 buffer 指令失败: {}", e),
            })?,
        )
    } else {
        None
    };

    #[allow(deprecated)]
    let deploy_ixs = loader_v3_instruction::deploy_with_max_program_len(
        &payer_pubkey,
        &program_id,
        &buffer_address,
        &payer_pubkey,
        program_lamports,
        max_data_len,
    )
    .map_err(|e| ApiError {
        message: format!("创建 deploy 指令失败: {}", e),
    })?;

    let fee_blockhash = client.get_latest_blockhash().map_err(|error| ApiError {
        message: format!("获取交易费估算 blockhash 失败: {error}"),
    })?;
    let create_buffer_fee = create_buffer_ixs
        .as_deref()
        .map(|instructions| {
            estimate_instruction_fee(
                &client,
                instructions,
                &payer_pubkey,
                &fee_blockhash,
                "create-buffer",
            )
        })
        .transpose()?
        .unwrap_or(0);
    let mut write_fee_by_chunk_len = HashMap::<usize, u64>::new();
    let mut write_fees = 0u64;
    let mut estimated_write_fee_lamports = 0u64;
    for index in &write_plan.pending_chunk_indexes {
        let start = index
            .checked_mul(PROGRAM_WRITE_CHUNK_BYTES)
            .ok_or_else(|| ApiError {
                message: "Program 写入偏移超出范围".to_string(),
            })?;
        let chunk = program_bytes
            .get(
                start
                    ..start
                        .saturating_add(PROGRAM_WRITE_CHUNK_BYTES)
                        .min(program_bytes.len()),
            )
            .ok_or_else(|| ApiError {
                message: "Program 写入块超出制品范围".to_string(),
            })?;
        let fee = if let Some(fee) = write_fee_by_chunk_len.get(&chunk.len()) {
            *fee
        } else {
            let offset = u32::try_from(start).map_err(|_| ApiError {
                message: "Program 写入偏移超出范围".to_string(),
            })?;
            let instruction = loader_v3_instruction::write(
                &buffer_address,
                &payer_pubkey,
                offset,
                chunk.to_vec(),
            );
            let fee = estimate_instruction_fee(
                &client,
                &[instruction],
                &payer_pubkey,
                &fee_blockhash,
                "write-buffer",
            )?;
            write_fee_by_chunk_len.insert(chunk.len(), fee);
            fee
        };
        estimated_write_fee_lamports = estimated_write_fee_lamports.max(fee);
        write_fees = write_fees.checked_add(fee).ok_or_else(|| ApiError {
            message: "Program 写入交易费总额溢出".to_string(),
        })?;
    }
    let deploy_fee = estimate_instruction_fee(
        &client,
        &deploy_ixs,
        &payer_pubkey,
        &fee_blockhash,
        "deploy",
    )?;
    let estimated_transaction_fees_lamports = create_buffer_fee
        .checked_add(write_fees)
        .and_then(|value| value.checked_add(deploy_fee))
        .ok_or_else(|| ApiError {
            message: "部署交易费总额溢出".to_string(),
        })?;
    let fee_budget = program_deploy::deployment_fee_budget(
        estimated_transaction_fees_lamports,
        estimated_write_fee_lamports,
        write_plan.pending_chunk_indexes.len(),
    )
    .map_err(|message| ApiError { message })?;
    let rent_budget = program_deploy::deployment_rent_budget(
        buffer_lamports,
        program_lamports,
        programdata_lamports,
        buffer_keypair.is_none().then_some(resume_buffer_lamports),
    )
    .map_err(|message| ApiError { message })?;
    let required_rent_balance = rent_budget.required_rent_balance_lamports;
    let estimated_required_balance_lamports = required_rent_balance
        .checked_add(fee_budget.total_fee_budget_lamports)
        .ok_or_else(|| ApiError {
            message: "部署所需余额总额溢出".to_string(),
        })?;
    let payer_balance = client
        .get_balance(&payer_pubkey)
        .map_err(|error| ApiError {
            message: format!("查询部署钱包余额失败: {error}"),
        })?;
    if payer_balance < estimated_required_balance_lamports {
        return Err(ApiError {
            message: format!(
                "部署钱包余额不足：当前 {} lamports，至少需要 {} lamports（租金需求 {} + 当前估算交易费 {} + 费率预留 {} + 恢复写入预留 {}）",
                payer_balance,
                estimated_required_balance_lamports,
                required_rent_balance,
                estimated_transaction_fees_lamports,
                fee_budget.fee_rate_reserve_lamports,
                fee_budget.recovery_write_reserve_lamports
            ),
        });
    }

    if deployment_journal.is_none() && buffer_keypair.is_none() {
        let record = wallet_store::ProgramDeploymentRecord {
            genesis_hash: genesis_hash.clone(),
            program_id: program_id.to_string(),
            program_sha256: program_sha256.clone(),
            program_len: program_bytes.len(),
            max_data_len,
            upgrade_authority: expected_upgrade_authority.to_string(),
            buffer_address: buffer_address.to_string(),
            status: DEPLOYMENT_STATUS_BUFFER_READY.to_string(),
            create_signature: None,
            create_last_valid_block_height: None,
            last_write_signature: None,
            last_write_chunk_index: None,
            last_write_last_valid_block_height: None,
            completed_writes: write_plan.completed_chunks,
            deploy_signature: None,
            deploy_last_valid_block_height: None,
            attempt_evidence_version: wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION,
            revision: 0,
            created_at: 0,
            updated_at: 0,
        };
        let (stored, inserted) = wallet_store::reserve_program_deployment(record)
            .map_err(|message| ApiError { message })?;
        if !inserted {
            validate_deployment_journal_binding(
                &stored,
                &genesis_hash,
                &program_id,
                &program_sha256,
                program_bytes.len(),
                max_data_len,
                &expected_upgrade_authority,
                Some(&buffer_address),
            )?;
            return Err(deployment_journal_error(format!(
                "另一部署请求已抢先预留 Buffer {}；当前请求未发送交易，请重新进入恢复流程",
                stored.buffer_address
            )));
        }
        deployment_journal = Some(stored);
    }

    if let (Some(instructions), Some(buffer_signer)) =
        (create_buffer_ixs.as_ref(), buffer_keypair.as_ref())
    {
        let (blockhash, last_valid_block_height) = client
            .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
            .map_err(|error| ApiError {
                message: format!("获取 create-buffer blockhash 失败: {error}"),
            })?;
        let transaction = Transaction::new_signed_with_payer(
            instructions,
            Some(&payer_pubkey),
            &[&payer, buffer_signer],
            blockhash,
        );
        let local_signature = transaction
            .signatures
            .first()
            .copied()
            .ok_or_else(|| ApiError {
                message: "create-buffer 交易缺少本地签名".to_string(),
            })?;
        let record = wallet_store::ProgramDeploymentRecord {
            genesis_hash: genesis_hash.clone(),
            program_id: program_id.to_string(),
            program_sha256: program_sha256.clone(),
            program_len: program_bytes.len(),
            max_data_len,
            upgrade_authority: expected_upgrade_authority.to_string(),
            buffer_address: buffer_address.to_string(),
            status: DEPLOYMENT_STATUS_CREATE_BUFFER_SIGNED.to_string(),
            create_signature: Some(local_signature.to_string()),
            create_last_valid_block_height: Some(last_valid_block_height),
            last_write_signature: None,
            last_write_chunk_index: None,
            last_write_last_valid_block_height: None,
            completed_writes: 0,
            deploy_signature: None,
            deploy_last_valid_block_height: None,
            attempt_evidence_version: wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION,
            revision: 0,
            created_at: 0,
            updated_at: 0,
        };
        let create_attempt = new_program_deployment_attempt(
            &record,
            wallet_store::PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
            None,
            &local_signature,
            last_valid_block_height,
        );
        if rotating_create_buffer {
            let current = deployment_journal
                .as_ref()
                .ok_or_else(|| deployment_journal_error("Buffer 轮换时部署 journal 不存在"))?;
            let stored = wallet_store::rotate_program_deployment_create_attempt(
                current,
                create_attempt,
                DEPLOYMENT_STATUS_CREATE_BUFFER_SIGNED,
            )
            .map_err(|message| ApiError { message })?;
            deployment_journal = Some(stored);
        } else {
            let (stored, inserted) =
                wallet_store::reserve_program_deployment_with_attempt(record, create_attempt)
                    .map_err(|message| ApiError { message })?;
            if !inserted {
                let binding_matches = validate_deployment_journal_binding(
                    &stored,
                    &genesis_hash,
                    &program_id,
                    &program_sha256,
                    program_bytes.len(),
                    max_data_len,
                    &expected_upgrade_authority,
                    None,
                )
                .is_ok();
                if !binding_matches {
                    let record = wallet_store::ProgramDeploymentRecord {
                        genesis_hash: genesis_hash.clone(),
                        program_id: program_id.to_string(),
                        program_sha256: program_sha256.clone(),
                        program_len: program_bytes.len(),
                        max_data_len,
                        upgrade_authority: expected_upgrade_authority.to_string(),
                        buffer_address: buffer_address.to_string(),
                        status: DEPLOYMENT_STATUS_CREATE_BUFFER_SIGNED.to_string(),
                        create_signature: Some(local_signature.to_string()),
                        create_last_valid_block_height: Some(last_valid_block_height),
                        last_write_signature: None,
                        last_write_chunk_index: None,
                        last_write_last_valid_block_height: None,
                        completed_writes: 0,
                        deploy_signature: None,
                        deploy_last_valid_block_height: None,
                        attempt_evidence_version:
                            wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_EVIDENCE_VERSION,
                        revision: 0,
                        created_at: 0,
                        updated_at: 0,
                    };
                    let create_attempt = new_program_deployment_attempt(
                        &record,
                        wallet_store::PROGRAM_DEPLOYMENT_STAGE_CREATE_BUFFER,
                        None,
                        &local_signature,
                        last_valid_block_height,
                    );
                    let replaced = wallet_store::replace_inactive_program_deployment_with_attempt(
                        record,
                        create_attempt,
                    )
                    .map_err(deployment_journal_error)?;
                    deployment_journal = Some(replaced);
                } else {
                    return Err(deployment_journal_error(format!(
                        "另一部署请求已抢先预留 Buffer {}；当前 Buffer {} 的本地签名交易尚未发送，请重新进入恢复流程",
                        stored.buffer_address, buffer_address
                    )));
                }
            } else {
                deployment_journal = Some(stored);
            }
        }
        let context = format!("Program ID: {program_id}；Buffer: {buffer_address}");
        let submission = submit_signed_transaction_once(
            &client,
            &transaction,
            "创建 Buffer",
            &context,
            CommitmentConfig::finalized(),
            "finalized",
            Duration::from_secs(90),
        )
        .await;
        match submission {
            Ok((signature, _)) => {
                if signature != local_signature {
                    return Err(deployment_journal_error(
                        "RPC 返回的 create-buffer 签名与本地已持久化签名不一致",
                    ));
                }
                transition_deployment_attempt(
                    &mut deployment_journal,
                    &local_signature.to_string(),
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED,
                    DEPLOYMENT_STATUS_CREATE_BUFFER_RECONCILE,
                    0,
                )?;
                let finalized_account = client
                    .get_account_with_commitment(&buffer_address, CommitmentConfig::finalized())
                    .map_err(|error| ApiError {
                        message: format!(
                            "create-buffer 签名已 finalized，但回读 Buffer {} 失败: {error}",
                            buffer_address
                        ),
                    })?
                    .value
                    .ok_or_else(|| {
                        deployment_journal_error(format!(
                            "create-buffer 签名 {} 已 finalized，但 Buffer {} 不存在",
                            local_signature, buffer_address
                        ))
                    })?;
                write_plan = program_deploy::verify_resume_buffer(
                    &payer_pubkey,
                    &program_bytes,
                    PROGRAM_WRITE_CHUNK_BYTES,
                    &finalized_account.owner,
                    finalized_account.executable,
                    &finalized_account.data,
                )
                .map_err(|error| {
                    deployment_journal_error(format!(
                        "create-buffer 签名已 finalized，但 Buffer 回读校验失败: {error}"
                    ))
                })?;
                transition_deployment_attempt(
                    &mut deployment_journal,
                    &local_signature.to_string(),
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED,
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED,
                    DEPLOYMENT_STATUS_BUFFER_READY,
                    write_plan.completed_chunks,
                )?;
            }
            Err(error) => {
                let journal_error = transition_deployment_attempt(
                    &mut deployment_journal,
                    &local_signature.to_string(),
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION,
                    DEPLOYMENT_STATUS_CREATE_BUFFER_RECONCILE,
                    0,
                )
                .err()
                .map(|journal_error| format!("；journal 更新失败: {}", journal_error.message))
                .unwrap_or_default();
                return Err(ApiError {
                    message: format!(
                        "{}；Buffer {} 已记录，本地签名 {}，last valid block height {}{}",
                        error.message,
                        buffer_address,
                        local_signature,
                        last_valid_block_height,
                        journal_error
                    ),
                });
            }
        }
    }

    let create_buffer_signature = deployment_journal
        .as_ref()
        .and_then(|record| record.create_signature.clone());

    let mut write_signatures = Vec::with_capacity(write_plan.pending_chunk_indexes.len());
    let completed_writes = write_plan.completed_chunks;
    let total_pending_writes = write_plan.pending_chunk_indexes.len();
    for (position, index) in write_plan.pending_chunk_indexes.iter().copied().enumerate() {
        let start = index
            .checked_mul(PROGRAM_WRITE_CHUNK_BYTES)
            .ok_or_else(|| ApiError {
                message: "Program 写入偏移超出范围".to_string(),
            })?;
        let end = start
            .saturating_add(PROGRAM_WRITE_CHUNK_BYTES)
            .min(program_bytes.len());
        let chunk = program_bytes.get(start..end).ok_or_else(|| ApiError {
            message: "Program 写入块超出制品范围".to_string(),
        })?;
        let offset = u32::try_from(start).map_err(|_| ApiError {
            message: "Program 写入偏移超出范围".to_string(),
        })?;
        let write_ix =
            loader_v3_instruction::write(&buffer_address, &payer_pubkey, offset, chunk.to_vec());
        let (blockhash, write_last_valid_block_height) = client
            .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
            .map_err(|error| ApiError {
                message: format!("获取 write-buffer blockhash 失败: {error}"),
            })?;
        let transaction = Transaction::new_signed_with_payer(
            &[write_ix],
            Some(&payer_pubkey),
            &[&payer],
            blockhash,
        );
        let local_signature = transaction
            .signatures
            .first()
            .copied()
            .ok_or_else(|| ApiError {
                message: "write-buffer 交易缺少本地签名".to_string(),
            })?;
        let attempt = new_program_deployment_attempt(
            deployment_journal.as_ref().ok_or_else(|| ApiError {
                message: "部署 journal 不存在，拒绝写入 Buffer".to_string(),
            })?,
            wallet_store::PROGRAM_DEPLOYMENT_STAGE_WRITE,
            Some(index),
            &local_signature,
            write_last_valid_block_height,
        );
        begin_deployment_attempt(
            &mut deployment_journal,
            attempt,
            DEPLOYMENT_STATUS_WRITE_SIGNED,
            completed_writes,
        )?;
        let context = format!(
            "Program ID: {program_id}；Buffer: {buffer_address}；写入进度: {}/{}；chunk index: {}",
            position + 1,
            total_pending_writes,
            index
        );
        let submission = submit_signed_transaction_once(
            &client,
            &transaction,
            "写入 Buffer",
            &context,
            CommitmentConfig::confirmed(),
            "confirmed",
            Duration::from_secs(120),
        )
        .await;
        match submission {
            Ok((signature, _)) => {
                if signature != local_signature {
                    return Err(deployment_journal_error(format!(
                        "write chunk {} 的 RPC 签名与本地已持久化签名不一致",
                        index
                    )));
                }
                transition_deployment_attempt(
                    &mut deployment_journal,
                    &local_signature.to_string(),
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED,
                    DEPLOYMENT_STATUS_WRITE_CONFIRMED,
                    completed_writes,
                )?;
                write_signatures.push(signature.to_string());
            }
            Err(error) => {
                let journal_error = transition_deployment_attempt(
                    &mut deployment_journal,
                    &local_signature.to_string(),
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
                    wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION,
                    DEPLOYMENT_STATUS_WRITE_RECONCILE,
                    completed_writes,
                )
                .err()
                .map(|journal_error| format!("；journal 更新失败: {}", journal_error.message))
                .unwrap_or_default();
                return Err(ApiError {
                    message: format!(
                        "{}；Buffer {} 的 chunk {} 已记录本地签名 {}{}",
                        error.message, buffer_address, index, local_signature, journal_error
                    ),
                });
            }
        }
    }

    let buffer_finalized_deadline = Instant::now() + Duration::from_secs(120);
    let finalized_completed_writes = loop {
        let response = client
            .get_account_with_commitment(&buffer_address, CommitmentConfig::finalized())
            .map_err(|error| ApiError {
                message: format!(
                    "部署前 finalized 回读 Buffer {} 失败: {error}",
                    buffer_address
                ),
            })?;
        let account = response.value.ok_or_else(|| ApiError {
            message: format!("部署前 Buffer {} 不存在", buffer_address),
        })?;
        let finalized_plan = program_deploy::verify_resume_buffer(
            &payer_pubkey,
            &program_bytes,
            PROGRAM_WRITE_CHUNK_BYTES,
            &account.owner,
            account.executable,
            &account.data,
        )
        .map_err(|error| ApiError {
            message: format!("部署前 Buffer {} 回读校验失败: {error}", buffer_address),
        })?;
        if finalized_plan.pending_chunk_indexes.is_empty() {
            break finalized_plan.completed_chunks;
        }
        if Instant::now() >= buffer_finalized_deadline {
            return Err(ApiError {
                message: format!(
                    "Buffer {} 仍有 {} 个块未 finalized；请保留该地址并使用恢复部署，不能盲目创建新 Buffer",
                    buffer_address,
                    finalized_plan.pending_chunk_indexes.len()
                ),
            });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    let current_journal = deployment_journal.as_ref().ok_or_else(|| ApiError {
        message: "部署 journal 不存在，拒绝完成 Buffer 回读".to_string(),
    })?;
    let active_attempts = wallet_store::load_active_program_deployment_attempts(
        &current_journal.genesis_hash,
        &current_journal.program_id,
    )
    .map_err(|message| ApiError { message })?;
    for attempt in active_attempts
        .iter()
        .filter(|attempt| attempt.stage == wallet_store::PROGRAM_DEPLOYMENT_STAGE_WRITE)
    {
        transition_deployment_attempt(
            &mut deployment_journal,
            &attempt.signature,
            &attempt.status,
            wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED,
            DEPLOYMENT_STATUS_WRITE_CONFIRMED,
            finalized_completed_writes,
        )?;
    }
    transition_deployment_journal(
        &mut deployment_journal,
        DEPLOYMENT_STATUS_BUFFER_FINALIZED,
        None,
        None,
        None,
        None,
        None,
        finalized_completed_writes,
        None,
        None,
    )?;

    let (blockhash, deploy_last_valid_block_height) = client
        .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
        .map_err(|error| ApiError {
            message: format!("获取 deploy blockhash 失败: {error}"),
        })?;
    let deploy_transaction = Transaction::new_signed_with_payer(
        &deploy_ixs,
        Some(&payer_pubkey),
        &[&payer, &program_keypair],
        blockhash,
    );
    let local_deploy_signature =
        deploy_transaction
            .signatures
            .first()
            .copied()
            .ok_or_else(|| ApiError {
                message: "deploy 交易缺少本地签名".to_string(),
            })?;
    simulate_program_deployment_transaction(&client, &deploy_transaction, "deploy")?;
    let deploy_attempt = new_program_deployment_attempt(
        deployment_journal.as_ref().ok_or_else(|| ApiError {
            message: "部署 journal 不存在，拒绝记录 deploy attempt".to_string(),
        })?,
        wallet_store::PROGRAM_DEPLOYMENT_STAGE_DEPLOY,
        None,
        &local_deploy_signature,
        deploy_last_valid_block_height,
    );
    begin_deployment_attempt(
        &mut deployment_journal,
        deploy_attempt,
        DEPLOYMENT_STATUS_DEPLOY_SIGNED,
        finalized_completed_writes,
    )?;
    let deploy_context = format!("Program ID: {program_id}；Buffer: {buffer_address}");
    let deploy_submission = submit_signed_transaction_once(
        &client,
        &deploy_transaction,
        "部署",
        &deploy_context,
        CommitmentConfig::finalized(),
        "finalized",
        Duration::from_secs(90),
    )
    .await;
    let (deploy_signature, finalized_slot) = match deploy_submission {
        Ok(result) => result,
        Err(error) => {
            let journal_error = transition_deployment_attempt(
                &mut deployment_journal,
                &local_deploy_signature.to_string(),
                wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
                wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_REQUIRES_RECONCILIATION,
                DEPLOYMENT_STATUS_DEPLOY_RECONCILE,
                finalized_completed_writes,
            )
            .err()
            .map(|journal_error| format!("；journal 更新失败: {}", journal_error.message))
            .unwrap_or_default();
            return Err(ApiError {
                message: format!(
                    "{}；Program {} 已记录本地部署签名 {}，last valid block height {}{}",
                    error.message,
                    program_id,
                    local_deploy_signature,
                    deploy_last_valid_block_height,
                    journal_error
                ),
            });
        }
    };
    if deploy_signature != local_deploy_signature {
        return Err(deployment_journal_error(
            "RPC 返回的 deploy 签名与本地已持久化签名不一致",
        ));
    }
    transition_deployment_attempt(
        &mut deployment_journal,
        &local_deploy_signature.to_string(),
        wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_SIGNED,
        wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED,
        DEPLOYMENT_STATUS_DEPLOY_FINALIZED,
        finalized_completed_writes,
    )?;
    let readback = wait_for_finalized_deployment_readback(
        &client,
        &program_id,
        &programdata_address,
        &expected_upgrade_authority,
        &program_bytes,
        max_data_len,
        finalized_slot,
    )
    .await
    .map_err(|error| ApiError {
        message: format!(
            "{}；Program ID: {}，部署签名: {}",
            error.message, program_id, deploy_signature
        ),
    })?;
    if readback.program_sha256 != program_sha256 {
        return Err(ApiError {
            message: "finalized 回读 SHA-256 与本地已验证哈希不一致".to_string(),
        });
    }
    transition_deployment_attempt(
        &mut deployment_journal,
        &local_deploy_signature.to_string(),
        wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_CONFIRMED,
        wallet_store::PROGRAM_DEPLOYMENT_ATTEMPT_FINALIZED,
        DEPLOYMENT_STATUS_FINALIZED,
        finalized_completed_writes,
    )?;
    let (journal_revision, attempt_evidence_version, deployment_attempts) =
        load_deployment_receipt_evidence(deployment_journal.as_ref())?;

    Ok(Json(DeployProgramResponse {
        program_id: program_id.to_string(),
        programdata_address: programdata_address.to_string(),
        buffer_address: buffer_address.to_string(),
        authority: readback.upgrade_authority.to_string(),
        network,
        genesis_hash,
        program_bytes: program_bytes.len(),
        max_data_len,
        program_sha256,
        temporary_buffer_rent_lamports: buffer_lamports,
        program_rent_lamports: program_lamports,
        programdata_rent_lamports: programdata_lamports,
        rent_lamports: final_rent_lamports,
        estimated_transaction_fees_lamports,
        fee_rate_reserve_lamports: fee_budget.fee_rate_reserve_lamports,
        recovery_write_reserve_lamports: fee_budget.recovery_write_reserve_lamports,
        total_fee_budget_lamports: fee_budget.total_fee_budget_lamports,
        estimated_required_balance_lamports,
        create_buffer_signature,
        skipped_write_chunks: write_plan.completed_chunks,
        write_signatures,
        deploy_signature: deploy_signature.to_string(),
        finalized_slot,
        deployed_slot: readback.deployed_slot,
        readback_verified: true,
        journal_revision,
        attempt_evidence_version,
        deployment_attempts,
        status: "finalized".to_string(),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpgradeProgramRequest {
    #[serde(default)]
    wallet_id: Option<String>,
    #[serde(default)]
    private_key: Option<String>,
    #[serde(default)]
    secret_key: Option<String>,
    #[serde(default)]
    keystore_json: Option<String>,
    #[serde(default)]
    encrypted_key: Option<String>,
    #[serde(default)]
    password: Option<String>,
    program_id: String,
    expected_upgrade_authority: String,
    expected_genesis_hash: String,
    expected_program_sha256: String,
    program_so_base64: String,
    network: String,
    #[serde(default)]
    spill_address: Option<String>,
}

impl UpgradeProgramRequest {
    fn take_wallet_auth(&mut self) -> WalletAuthRequest {
        WalletAuthRequest {
            wallet_id: self.wallet_id.take(),
            private_key: self.private_key.take(),
            secret_key: self.secret_key.take(),
            keystore_json: self.keystore_json.take(),
            encrypted_key: self.encrypted_key.take(),
            password: self.password.take(),
        }
    }
}

impl Drop for UpgradeProgramRequest {
    fn drop(&mut self) {
        self.take_wallet_auth().clear_secrets();
    }
}

#[derive(Serialize)]
struct UpgradeProgramResponse {
    program_id: String,
    programdata_address: String,
    buffer_address: String,
    authority: String,
    network: String,
    genesis_hash: String,
    program_bytes: usize,
    program_sha256: String,
    rent_lamports: u64,
    extension_rent_lamports: u64,
    previous_programdata_capacity: usize,
    programdata_capacity: usize,
    extend_signature: Option<String>,
    create_buffer_signature: String,
    write_signatures: Vec<String>,
    upgrade_signature: String,
    deployed_slot: u64,
    readback_verified: bool,
    status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProgramDataExtensionPlan {
    previous_capacity: usize,
    new_capacity: usize,
    new_account_len: usize,
    additional_bytes: u32,
}

fn programdata_extension_plan(
    current_account_len: usize,
    required_program_len: usize,
) -> Result<Option<ProgramDataExtensionPlan>, String> {
    let metadata_len = UpgradeableLoaderState::size_of_programdata_metadata();
    let max_account_len = usize::try_from(MAX_PERMITTED_DATA_LENGTH)
        .map_err(|_| "当前平台无法表示 Solana 最大账户长度".to_string())?;
    let max_program_len = max_account_len
        .checked_sub(metadata_len)
        .ok_or_else(|| "Solana 最大账户长度小于 ProgramData 元数据".to_string())?;
    if current_account_len > max_account_len {
        return Err(format!(
            "ProgramData 账户长度 {} 超过 Solana 协议上限 {}",
            current_account_len, max_account_len
        ));
    }
    if required_program_len > max_program_len {
        return Err(format!(
            "Program .so 长度 {} 超过 Solana Upgradeable Loader 上限 {}",
            required_program_len, max_program_len
        ));
    }
    let previous_capacity = current_account_len
        .checked_sub(metadata_len)
        .ok_or_else(|| "ProgramData 账户长度不足".to_string())?;
    if required_program_len <= previous_capacity {
        return Ok(None);
    }

    let required_additional_bytes = required_program_len
        .checked_sub(previous_capacity)
        .ok_or_else(|| "ProgramData 扩容长度计算失败".to_string())?;
    let minimum_extension_count = required_additional_bytes
        .checked_add(PROGRAMDATA_MINIMUM_EXTENSION_BYTES - 1)
        .ok_or_else(|| "ProgramData 扩容长度计算溢出".to_string())?
        / PROGRAMDATA_MINIMUM_EXTENSION_BYTES;
    let additional_bytes = minimum_extension_count
        .checked_mul(PROGRAMDATA_MINIMUM_EXTENSION_BYTES)
        .ok_or_else(|| "ProgramData 扩容总长度溢出".to_string())?;
    let rounded_account_len = current_account_len
        .checked_add(additional_bytes)
        .ok_or_else(|| "ProgramData 扩容后长度溢出".to_string())?;
    // Loader accepts any extension at or above its protocol minimum. The only
    // smaller valid extension is one that reaches the maximum account length.
    let new_account_len = rounded_account_len.min(max_account_len);
    let additional_bytes = new_account_len
        .checked_sub(current_account_len)
        .ok_or_else(|| "ProgramData 扩容总长度计算失败".to_string())?;
    let new_capacity = new_account_len
        .checked_sub(metadata_len)
        .ok_or_else(|| "ProgramData 扩容后容量溢出".to_string())?;

    let additional_bytes = u32::try_from(additional_bytes)
        .map_err(|_| "ProgramData 扩容字节数超出链上指令范围".to_string())?;
    if (additional_bytes as usize) < PROGRAMDATA_MINIMUM_EXTENSION_BYTES
        && new_account_len != max_account_len
    {
        return Err("ProgramData 小额扩容未达到 Solana 最大账户长度".to_string());
    }

    Ok(Some(ProgramDataExtensionPlan {
        previous_capacity,
        new_capacity,
        new_account_len,
        additional_bytes,
    }))
}

async fn upgrade_generic_program(
    Json(req): Json<UpgradeProgramRequest>,
) -> Result<Json<UpgradeProgramResponse>, ApiError> {
    upgrade_program(Json(req)).await
}

async fn program_upgrade_progress() -> Json<ProgramUpgradeProgress> {
    let store = program_upgrade_progress_store();
    let progress = store.lock().await.clone();
    Json(progress)
}

async fn upgrade_program(
    Json(mut req): Json<UpgradeProgramRequest>,
) -> Result<Json<UpgradeProgramResponse>, ApiError> {
    let _deploy_guard = PROGRAM_DEPLOY_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .try_lock()
        .map_err(|_| ApiError {
            message: PROGRAM_DEPLOY_BUSY_MESSAGE.to_string(),
        })?;

    let result = upgrade_program_inner(&mut req).await;
    finish_program_upgrade_progress(&result).await;
    result
}

async fn upgrade_program_inner(
    req: &mut UpgradeProgramRequest,
) -> Result<Json<UpgradeProgramResponse>, ApiError> {
    let program_id = Pubkey::from_str(req.program_id.trim()).map_err(|_| ApiError {
        message: "无效的 Program ID".to_string(),
    })?;
    let expected_upgrade_authority = Pubkey::from_str(req.expected_upgrade_authority.trim())
        .map_err(|_| ApiError {
            message: "无效的预期 Upgrade Authority".to_string(),
        })?;

    let program_bytes = decode_program_binary_base64(&req.program_so_base64)?;
    let write_chunk_count = program_bytes.chunks(PROGRAM_WRITE_CHUNK_BYTES).count();
    begin_program_upgrade_progress(
        &program_id.to_string(),
        req.network.trim(),
        program_bytes.len(),
        write_chunk_count,
    )
    .await;

    let program_sha256 =
        program_deploy::require_sha256(&program_bytes, &req.expected_program_sha256)
            .map_err(|message| ApiError { message })?;
    program_deploy::require_anchor_declared_program_id(&program_bytes, &program_id)
        .map_err(|message| ApiError { message })?;
    publish_program_upgrade_progress(|progress| {
        progress.stage = "verifying".to_string();
        progress.message = "正在离线校验 SBF 程序制品".to_string();
    })
    .await;
    let program_bytes = verify_program_binary_offline(program_bytes).await?;

    if req.network.trim().is_empty() {
        return Err(ApiError {
            message: "升级网络不能为空".to_string(),
        });
    }
    let selector = rpc_selector(Some(req.network.trim()))?;
    let rpc_url = selector.url;
    let network = selector.network;
    publish_program_upgrade_progress(|progress| {
        progress.network = network.clone();
        progress.message = format!("正在连接 RPC 并校验网络（{network}）");
    })
    .await;
    let client = RpcClient::new_with_timeout_and_commitment(
        rpc_url.to_string(),
        Duration::from_secs(PROGRAM_DEPLOY_RPC_TIMEOUT_SECS),
        CommitmentConfig::confirmed(),
    );

    let expected_genesis_hash = solana_sdk::hash::Hash::from_str(req.expected_genesis_hash.trim())
        .map_err(|_| ApiError {
            message: "无效的预期 genesis hash".to_string(),
        })?;
    let actual_genesis_hash = client.get_genesis_hash().map_err(|error| ApiError {
        message: format!("读取 RPC genesis hash 失败: {error}"),
    })?;
    if actual_genesis_hash != expected_genesis_hash {
        return Err(ApiError {
            message: format!(
                "RPC genesis hash 为 {}，预期为 {}；已在花费前中止升级",
                actual_genesis_hash, expected_genesis_hash
            ),
        });
    }
    let genesis_hash = actual_genesis_hash.to_string();

    let wallet_auth = req.take_wallet_auth();
    let payer = wallet_auth.keypair()?;
    let payer_pubkey = payer.pubkey();
    if payer_pubkey != expected_upgrade_authority {
        return Err(ApiError {
            message: format!(
                "签名钱包 {} 与预期 Upgrade Authority {} 不一致",
                payer_pubkey, expected_upgrade_authority
            ),
        });
    }

    let programdata_address =
        require_program_upgrade_authority(&client, &program_id, &payer_pubkey)?;
    let programdata_account = client
        .get_account_with_commitment(&programdata_address, CommitmentConfig::confirmed())
        .map_err(|error| ApiError {
            message: format!("读取 ProgramData 失败: {error}"),
        })?
        .value
        .ok_or_else(|| ApiError {
            message: format!("ProgramData {} 不存在", programdata_address),
        })?;
    let metadata_len = UpgradeableLoaderState::size_of_programdata_metadata();
    if programdata_account.data.len() < metadata_len {
        return Err(ApiError {
            message: "ProgramData 账户长度不足".to_string(),
        });
    }
    let extension_plan =
        programdata_extension_plan(programdata_account.data.len(), program_bytes.len())
            .map_err(|message| ApiError { message })?;
    let previous_programdata_capacity = programdata_account.data.len() - metadata_len;
    let extension_rent_lamports = if let Some(plan) = extension_plan.as_ref() {
        client
            .get_minimum_balance_for_rent_exemption(plan.new_account_len)
            .map_err(|error| ApiError {
                message: format!("计算 ProgramData 扩容租金失败: {error}"),
            })?
            .saturating_sub(programdata_account.lamports)
    } else {
        0
    };
    let mut max_program_len = previous_programdata_capacity;

    let spill = if let Some(spill) = req
        .spill_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Pubkey::from_str(spill).map_err(|_| ApiError {
            message: "无效的 spill 地址".to_string(),
        })?
    } else {
        payer_pubkey
    };

    let buffer_keypair = Keypair::new();
    let buffer_lamports = client
        .get_minimum_balance_for_rent_exemption(UpgradeableLoaderState::size_of_buffer(
            program_bytes.len(),
        ))
        .map_err(|error| ApiError {
            message: format!("计算 buffer 租金失败: {error}"),
        })?;
    // Optional extension + create buffer + write chunks + upgrade; keep a small SOL reserve.
    let extension_transaction_count = if extension_plan.is_some() { 1 } else { 0 };
    let transaction_count = write_chunk_count
        .saturating_add(2)
        .saturating_add(extension_transaction_count);
    let estimated_fee_lamports =
        (transaction_count.saturating_mul(10_000)).saturating_add(50_000_000) as u64;
    let estimated_required_balance_lamports = buffer_lamports
        .checked_add(extension_rent_lamports)
        .ok_or_else(|| ApiError {
            message: "ProgramData 扩容与 Buffer 租金总额溢出".to_string(),
        })?
        .checked_add(estimated_fee_lamports)
        .ok_or_else(|| ApiError {
            message: "升级所需余额总额溢出".to_string(),
        })?;
    let payer_balance = client
        .get_balance(&payer_pubkey)
        .map_err(|error| ApiError {
            message: format!("查询升级钱包余额失败: {error}"),
        })?;
    if payer_balance < estimated_required_balance_lamports {
        return Err(ApiError {
            message: format!(
                "升级钱包余额不足：当前 {:.4} SOL（{} lamports），至少需要约 {:.4} SOL（{} lamports）。其中 ProgramData 扩容租金约 {:.4} SOL，升级 Buffer 租金约 {:.4} SOL，交易费预留约 {:.4} SOL。Buffer 租金升级成功后会退回 spill 地址，ProgramData 扩容租金会留在链上账户。",
                payer_balance as f64 / 1_000_000_000.0,
                payer_balance,
                estimated_required_balance_lamports as f64 / 1_000_000_000.0,
                estimated_required_balance_lamports,
                extension_rent_lamports as f64 / 1_000_000_000.0,
                buffer_lamports as f64 / 1_000_000_000.0,
                estimated_fee_lamports as f64 / 1_000_000_000.0
            ),
        });
    }

    let extend_signature = if let Some(plan) = extension_plan {
        publish_program_upgrade_progress(|progress| {
            progress.stage = "extending_programdata".to_string();
            progress.message = format!(
                "正在扩容 ProgramData：{} → {} bytes（补充租金 {} lamports）",
                plan.previous_capacity, plan.new_capacity, extension_rent_lamports
            );
        })
        .await;
        let extend_program_checked_active = client
            .get_feature_activation_slot(&ENABLE_EXTEND_PROGRAM_CHECKED_FEATURE_ID)
            .map_err(|error| ApiError {
                message: format!("查询 ProgramData 扩容指令 feature 状态失败: {error}"),
            })?
            .is_some();
        let extend_ix = if extend_program_checked_active {
            tracing::info!(
                "using ExtendProgramChecked to expand {} by {} bytes",
                program_id,
                plan.additional_bytes
            );
            loader_v3_instruction::extend_program_checked(
                &program_id,
                &payer_pubkey,
                Some(&payer_pubkey),
                plan.additional_bytes,
            )
        } else {
            tracing::info!(
                "using legacy ExtendProgram to expand {} by {} bytes because checked feature is inactive",
                program_id,
                plan.additional_bytes
            );
            loader_v3_instruction::extend_program(
                &program_id,
                Some(&payer_pubkey),
                plan.additional_bytes,
            )
        };
        let (signature, _) = sign_and_send_with_commitment(
            &client,
            vec![extend_ix],
            &[&payer],
            &payer_pubkey,
            "扩容 ProgramData",
            CommitmentConfig::finalized(),
            "finalized",
            Duration::from_secs(90),
        )
        .await?;
        let expanded_account = client
            .get_account_with_commitment(&programdata_address, CommitmentConfig::finalized())
            .map_err(|error| ApiError {
                message: format!("扩容后回读 ProgramData 失败: {error}"),
            })?
            .value
            .ok_or_else(|| ApiError {
                message: format!("扩容后 ProgramData {} 不存在", programdata_address),
            })?;
        if expanded_account.data.len() < plan.new_account_len {
            return Err(ApiError {
                message: format!(
                    "ProgramData 扩容交易已 finalized，但回读长度为 {}，预期至少为 {}；扩容签名 {}",
                    expanded_account.data.len(),
                    plan.new_account_len,
                    signature
                ),
            });
        }
        let expanded_authority = loader_upgrade_authority_from_programdata(&expanded_account.data)?;
        if expanded_authority != payer_pubkey {
            return Err(ApiError {
                message: format!(
                    "ProgramData 扩容后 Upgrade Authority 为 {}，预期为 {}",
                    expanded_authority, payer_pubkey
                ),
            });
        }
        max_program_len = expanded_account.data.len() - metadata_len;
        if max_program_len < plan.new_capacity {
            return Err(ApiError {
                message: format!(
                    "ProgramData 扩容未达到目标容量：当前 {} bytes，预期至少 {} bytes",
                    max_program_len, plan.new_capacity
                ),
            });
        }
        publish_program_upgrade_progress(|progress| {
            progress.last_signature = Some(signature.clone());
            progress.message =
                format!("ProgramData 扩容已完成，当前容量 {} bytes", max_program_len);
        })
        .await;
        Some(signature)
    } else {
        None
    };

    publish_program_upgrade_progress(|progress| {
        progress.stage = "creating_buffer".to_string();
        progress.message = format!("正在创建升级 Buffer（{}）", buffer_keypair.pubkey());
        progress.buffer_address = Some(buffer_keypair.pubkey().to_string());
        progress.write_total = write_chunk_count;
        progress.program_bytes = program_bytes.len();
    })
    .await;
    let create_buffer_ixs = loader_v3_instruction::create_buffer(
        &payer_pubkey,
        &buffer_keypair.pubkey(),
        &payer_pubkey,
        buffer_lamports,
        program_bytes.len(),
    )
    .map_err(|error| ApiError {
        message: format!("创建 buffer 指令失败: {error}"),
    })?;
    let create_buffer_signature = sign_and_send_with_commitment(
        &client,
        create_buffer_ixs,
        &[&payer, &buffer_keypair],
        &payer_pubkey,
        "创建升级 Buffer",
        CommitmentConfig::finalized(),
        "finalized",
        Duration::from_secs(90),
    )
    .await?
    .0;

    let mut write_signatures = Vec::with_capacity(write_chunk_count);
    for (index, chunk) in program_bytes.chunks(PROGRAM_WRITE_CHUNK_BYTES).enumerate() {
        let offset = index
            .checked_mul(PROGRAM_WRITE_CHUNK_BYTES)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| ApiError {
                message: "Program 写入偏移超出范围".to_string(),
            })?;
        let write_ix = loader_v3_instruction::write(
            &buffer_keypair.pubkey(),
            &payer_pubkey,
            offset,
            chunk.to_vec(),
        );
        publish_program_upgrade_progress(|progress| {
            progress.stage = "writing".to_string();
            progress.write_completed = index;
            progress.write_total = write_chunk_count;
            progress.message = format!(
                "正在写入升级 Buffer：{}/{}（约 {:.1}%）",
                index + 1,
                write_chunk_count,
                ((index as f64) / (write_chunk_count.max(1) as f64)) * 100.0
            );
            progress.buffer_address = Some(buffer_keypair.pubkey().to_string());
        })
        .await;
        tracing::info!(
            "program upgrade write chunk {}/{} for {} ({} bytes)",
            index + 1,
            write_chunk_count,
            program_id,
            chunk.len()
        );
        let write_signature = sign_and_send_with_commitment(
            &client,
            vec![write_ix],
            &[&payer],
            &payer_pubkey,
            &format!("写入升级 Buffer ({}/{})", index + 1, write_chunk_count),
            CommitmentConfig::confirmed(),
            "confirmed",
            Duration::from_secs(120),
        )
        .await?
        .0;
        publish_program_upgrade_progress(|progress| {
            progress.write_completed = index + 1;
            progress.last_signature = Some(write_signature.clone());
            progress.message = format!(
                "已写入升级 Buffer：{}/{}（约 {:.1}%）",
                index + 1,
                write_chunk_count,
                ((index + 1) as f64 / (write_chunk_count.max(1) as f64)) * 100.0
            );
        })
        .await;
        write_signatures.push(write_signature);
    }

    publish_program_upgrade_progress(|progress| {
        progress.stage = "upgrading".to_string();
        progress.message = "正在提交 upgradeable-loader 升级交易".to_string();
        progress.write_completed = write_chunk_count;
    })
    .await;
    let upgrade_ix =
        squads_v4::upgrade_program_ix(&program_id, &buffer_keypair.pubkey(), &payer_pubkey, &spill);
    let (upgrade_signature, upgrade_slot) = sign_and_send_with_commitment(
        &client,
        vec![upgrade_ix],
        &[&payer],
        &payer_pubkey,
        "提交 Program 升级",
        CommitmentConfig::finalized(),
        "finalized",
        Duration::from_secs(90),
    )
    .await?;

    publish_program_upgrade_progress(|progress| {
        progress.stage = "verifying_readback".to_string();
        progress.message = "正在 finalized 回读并校验链上 Program 数据".to_string();
        progress.last_signature = Some(upgrade_signature.clone());
    })
    .await;
    let readback = wait_for_finalized_deployment_readback(
        &client,
        &program_id,
        &programdata_address,
        &payer_pubkey,
        &program_bytes,
        max_program_len,
        upgrade_slot,
    )
    .await?;

    Ok(Json(UpgradeProgramResponse {
        program_id: program_id.to_string(),
        programdata_address: programdata_address.to_string(),
        buffer_address: buffer_keypair.pubkey().to_string(),
        authority: readback.upgrade_authority.to_string(),
        network,
        genesis_hash,
        program_bytes: program_bytes.len(),
        program_sha256,
        rent_lamports: buffer_lamports.saturating_add(extension_rent_lamports),
        extension_rent_lamports,
        previous_programdata_capacity,
        programdata_capacity: max_program_len,
        extend_signature,
        create_buffer_signature,
        write_signatures,
        upgrade_signature,
        deployed_slot: readback.deployed_slot,
        readback_verified: true,
        status: "finalized".to_string(),
    }))
}

#[derive(Deserialize)]
struct ProgramInfoRequest {
    program_id: String,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Serialize)]
struct ProgramInfoResponse {
    program_id: String,
    programdata_address: String,
    exists: bool,
    executable: bool,
    owner: String,
    lamports: u64,
    data_len: usize,
    network: String,
}

async fn program_info(
    Json(req): Json<ProgramInfoRequest>,
) -> Result<Json<ProgramInfoResponse>, ApiError> {
    let program_id = Pubkey::from_str(req.program_id.trim()).map_err(|_| ApiError {
        message: "无效的 Program ID".to_string(),
    })?;
    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let network = network_name(req.network.as_deref());
    let client = RpcClient::new_with_commitment(rpc_url.to_string(), CommitmentConfig::confirmed());
    let programdata_address = get_program_data_address(&program_id);
    let Some(account) = client
        .get_account_with_commitment(&program_id, CommitmentConfig::confirmed())
        .map_err(|e| ApiError {
            message: format!("查询 Program 失败: {}", e),
        })?
        .value
    else {
        return Ok(Json(ProgramInfoResponse {
            program_id: program_id.to_string(),
            programdata_address: programdata_address.to_string(),
            exists: false,
            executable: false,
            owner: "".to_string(),
            lamports: 0,
            data_len: 0,
            network,
        }));
    };

    Ok(Json(ProgramInfoResponse {
        program_id: program_id.to_string(),
        programdata_address: programdata_address.to_string(),
        exists: true,
        executable: account.executable,
        owner: account.owner.to_string(),
        lamports: account.lamports,
        data_len: account.data.len(),
        network,
    }))
}

#[derive(Deserialize)]
struct ProgramAddressSeedRequest {
    kind: String,
    value: String,
}

#[derive(Deserialize)]
struct ProgramDeriveAddressRequest {
    program_id: String,
    seeds: Vec<ProgramAddressSeedRequest>,
}

#[derive(Serialize)]
struct ProgramDeriveAddressResponse {
    address: String,
    bump: u8,
}

async fn program_derive_address(
    Json(req): Json<ProgramDeriveAddressRequest>,
) -> Result<Json<ProgramDeriveAddressResponse>, ApiError> {
    let program_id = Pubkey::from_str(req.program_id.trim()).map_err(|_| ApiError {
        message: "无效的 PDA Program ID".to_string(),
    })?;
    if req.seeds.is_empty() || req.seeds.len() > 16 {
        return Err(ApiError {
            message: "PDA seeds 数量必须在 1 到 16 之间".to_string(),
        });
    }

    let mut seed_bytes = Vec::with_capacity(req.seeds.len());
    for seed in req.seeds {
        let bytes = match seed.kind.as_str() {
            "bytes_base64" => BASE64.decode(seed.value.trim()).map_err(|_| ApiError {
                message: "PDA seed base64 无效".to_string(),
            })?,
            "pubkey" => Pubkey::from_str(seed.value.trim())
                .map_err(|_| ApiError {
                    message: "PDA seed pubkey 无效".to_string(),
                })?
                .to_bytes()
                .to_vec(),
            _ => {
                return Err(ApiError {
                    message: "不支持的 PDA seed 类型".to_string(),
                });
            }
        };
        if bytes.is_empty() || bytes.len() > 32 {
            return Err(ApiError {
                message: "PDA 单个 seed 长度必须在 1 到 32 bytes 之间".to_string(),
            });
        }
        seed_bytes.push(bytes);
    }

    let seed_refs: Vec<&[u8]> = seed_bytes.iter().map(Vec::as_slice).collect();
    let (address, bump) = Pubkey::find_program_address(&seed_refs, &program_id);
    Ok(Json(ProgramDeriveAddressResponse {
        address: address.to_string(),
        bump,
    }))
}

// ============= Squads v4 Multisig =============

#[derive(Deserialize)]
struct SquadsCreateRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    members: Vec<String>,
    threshold: u16,
    #[serde(default)]
    time_lock: Option<u32>,
    #[serde(default)]
    memo: Option<String>,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Serialize)]
struct SquadsMemberResponse {
    key: String,
    permissions: u8,
}

#[derive(Serialize)]
struct SquadsCreateResponse {
    multisig: String,
    vault: String,
    create_key: String,
    signature: String,
    threshold: u16,
    members: Vec<SquadsMemberResponse>,
    creation_fee_lamports: u64,
    network: String,
    status: String,
}

async fn squads_create(
    Json(req): Json<SquadsCreateRequest>,
) -> Result<Json<SquadsCreateResponse>, ApiError> {
    if req.members.is_empty() {
        return Err(ApiError {
            message: "至少需要一个多签成员".to_string(),
        });
    }
    let mut members = req
        .members
        .iter()
        .map(|member| {
            squads_v4::parse_pubkey(member, "成员地址").map(|key| SquadsMember {
                key,
                permissions: SquadsPermissions::all(),
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|message| ApiError { message })?;
    members.sort_by_key(|member| member.key);
    members.dedup_by_key(|member| member.key);

    if req.threshold == 0 || usize::from(req.threshold) > members.len() {
        return Err(ApiError {
            message: "阈值必须大于 0 且不能超过成员数量".to_string(),
        });
    }

    if let Some(memo) = &req.memo {
        validate_text_len(memo, "memo", MAX_TEXT_FIELD_CHARS)?;
    }

    let payer = req.wallet.keypair()?;
    if !members.iter().any(|member| member.key == payer.pubkey()) {
        return Err(ApiError {
            message: "当前签名钱包必须是多签成员".to_string(),
        });
    }
    let create_key = Keypair::new();
    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let program_config = load_squads_program_config(&client)?;
    let (ix, multisig) = squads_v4::multisig_create_ix(
        &create_key.pubkey(),
        &payer.pubkey(),
        &program_config.treasury,
        req.threshold,
        members.clone(),
        req.time_lock.unwrap_or(0),
        req.memo,
    )
    .map_err(|message| ApiError { message })?;
    let signature = sign_and_send(&client, vec![ix], &[&payer, &create_key], &payer.pubkey())?;
    let vault = squads_v4::vault_pda(&multisig, 0);

    Ok(Json(SquadsCreateResponse {
        multisig: multisig.to_string(),
        vault: vault.to_string(),
        create_key: create_key.pubkey().to_string(),
        signature,
        threshold: req.threshold,
        members: members
            .into_iter()
            .map(|member| SquadsMemberResponse {
                key: member.key.to_string(),
                permissions: member.permissions.mask,
            })
            .collect(),
        creation_fee_lamports: program_config.multisig_creation_fee,
        network,
        status: "success".to_string(),
    }))
}

#[derive(Deserialize)]
struct SquadsInfoRequest {
    multisig: String,
    #[serde(default)]
    proposal: Option<String>,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Serialize)]
struct SquadsInfoResponse {
    multisig: String,
    vault: String,
    create_key: String,
    threshold: u16,
    time_lock: u32,
    transaction_index: u64,
    stale_transaction_index: u64,
    members: Vec<SquadsMemberResponse>,
    proposal: Option<SquadsProposalResponse>,
    network: String,
}

#[derive(Serialize)]
struct SquadsProposalResponse {
    address: String,
    transaction_index: u64,
    status: String,
    approved: Vec<String>,
    rejected: Vec<String>,
    cancelled: Vec<String>,
}

async fn squads_info(
    Json(req): Json<SquadsInfoRequest>,
) -> Result<Json<SquadsInfoResponse>, ApiError> {
    let multisig_key = squads_v4::parse_pubkey(&req.multisig, "多签地址")
        .map_err(|message| ApiError { message })?;
    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let multisig = load_squads_multisig(&client, &multisig_key)?;
    let proposal = if let Some(proposal) = req
        .proposal
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let proposal_key = squads_v4::parse_pubkey(proposal, "提案地址")
            .map_err(|message| ApiError { message })?;
        let proposal = load_squads_proposal(&client, &proposal_key)?;
        Some(SquadsProposalResponse {
            address: proposal_key.to_string(),
            transaction_index: proposal.transaction_index,
            status: proposal.status.label().to_string(),
            approved: proposal
                .approved
                .into_iter()
                .map(|key| key.to_string())
                .collect(),
            rejected: proposal
                .rejected
                .into_iter()
                .map(|key| key.to_string())
                .collect(),
            cancelled: proposal
                .cancelled
                .into_iter()
                .map(|key| key.to_string())
                .collect(),
        })
    } else {
        None
    };

    Ok(Json(SquadsInfoResponse {
        multisig: multisig_key.to_string(),
        vault: squads_v4::vault_pda(&multisig_key, 0).to_string(),
        create_key: multisig.create_key.to_string(),
        threshold: multisig.threshold,
        time_lock: multisig.time_lock,
        transaction_index: multisig.transaction_index,
        stale_transaction_index: multisig.stale_transaction_index,
        members: multisig
            .members
            .into_iter()
            .map(|member| SquadsMemberResponse {
                key: member.key.to_string(),
                permissions: member.permissions.mask,
            })
            .collect(),
        proposal,
        network,
    }))
}

#[derive(Deserialize)]
struct SquadsProposalsRequest {
    multisig: String,
    #[serde(default)]
    network: Option<String>,
    #[serde(default)]
    limit: Option<u64>,
}

#[derive(Serialize)]
struct SquadsProposalsResponse {
    multisig: String,
    vault: String,
    proposals: Vec<SquadsProposalResponse>,
    latest_transaction_index: u64,
    network: String,
}

async fn squads_proposals(
    Json(req): Json<SquadsProposalsRequest>,
) -> Result<Json<SquadsProposalsResponse>, ApiError> {
    let multisig_key = squads_v4::parse_pubkey(&req.multisig, "多签地址")
        .map_err(|message| ApiError { message })?;
    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let multisig = load_squads_multisig(&client, &multisig_key)?;
    let limit = req.limit.unwrap_or(20).clamp(1, 50);
    let start = multisig.transaction_index;
    let end = start.saturating_sub(limit.saturating_sub(1));
    let mut proposals = Vec::new();

    for index in (end..=start).rev() {
        let proposal_key = squads_v4::proposal_pda(&multisig_key, index);
        if let Ok(proposal) = load_squads_proposal(&client, &proposal_key) {
            proposals.push(SquadsProposalResponse {
                address: proposal_key.to_string(),
                transaction_index: proposal.transaction_index,
                status: proposal.status.label().to_string(),
                approved: proposal
                    .approved
                    .into_iter()
                    .map(|key| key.to_string())
                    .collect(),
                rejected: proposal
                    .rejected
                    .into_iter()
                    .map(|key| key.to_string())
                    .collect(),
                cancelled: proposal
                    .cancelled
                    .into_iter()
                    .map(|key| key.to_string())
                    .collect(),
            });
        }
    }

    Ok(Json(SquadsProposalsResponse {
        multisig: multisig_key.to_string(),
        vault: squads_v4::vault_pda(&multisig_key, 0).to_string(),
        proposals,
        latest_transaction_index: multisig.transaction_index,
        network,
    }))
}

#[derive(Serialize)]
struct SquadsProposalCreateResponse {
    multisig: String,
    vault: String,
    transaction: String,
    proposal: String,
    transaction_index: u64,
    signature: String,
    network: String,
    status: String,
}

#[derive(Deserialize)]
struct SquadsSolTransferProposalRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    multisig: String,
    to_address: String,
    amount: DecimalAmount,
    #[serde(default)]
    memo: Option<String>,
    #[serde(default)]
    network: Option<String>,
}

async fn squads_sol_transfer_proposal(
    Json(req): Json<SquadsSolTransferProposalRequest>,
) -> Result<Json<SquadsProposalCreateResponse>, ApiError> {
    let signer = req.wallet.keypair()?;
    let multisig_key = squads_v4::parse_pubkey(&req.multisig, "多签地址")
        .map_err(|message| ApiError { message })?;
    let to_pubkey = squads_v4::parse_pubkey(&req.to_address, "接收地址")
        .map_err(|message| ApiError { message })?;
    let amount_lamports = sol_to_lamports(&req.amount)?;
    if let Some(memo) = &req.memo {
        validate_text_len(memo, "memo", MAX_TEXT_FIELD_CHARS)?;
    }

    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let multisig = load_squads_multisig(&client, &multisig_key)?;
    let transaction_index = next_squads_transaction_index(&multisig)?;
    let vault = squads_v4::vault_pda(&multisig_key, 0);
    let transfer_ix = squads_v4::sol_transfer_ix(&vault, &to_pubkey, amount_lamports);
    let (tx_create_ix, transaction, vault, _) = squads_v4::vault_transaction_create_ix(
        &multisig_key,
        &signer.pubkey(),
        transaction_index,
        0,
        &[transfer_ix],
        req.memo,
    )
    .map_err(|message| ApiError { message })?;
    let (proposal_ix, proposal) =
        squads_v4::proposal_create_ix(&multisig_key, &signer.pubkey(), transaction_index, false)
            .map_err(|message| ApiError { message })?;
    let signature = sign_and_send(
        &client,
        vec![tx_create_ix, proposal_ix],
        &[&signer],
        &signer.pubkey(),
    )?;

    Ok(Json(SquadsProposalCreateResponse {
        multisig: multisig_key.to_string(),
        vault: vault.to_string(),
        transaction: transaction.to_string(),
        proposal: proposal.to_string(),
        transaction_index,
        signature,
        network,
        status: "success".to_string(),
    }))
}

#[derive(Deserialize)]
struct SquadsTokenTransferProposalRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    multisig: String,
    mint: String,
    #[serde(default)]
    recipient: Option<String>,
    amount: DecimalAmount,
    #[allow(dead_code)]
    #[serde(default)]
    decimals: Option<u8>,
    #[serde(default)]
    source_token_account: Option<String>,
    #[serde(default)]
    destination_token_account: Option<String>,
    #[serde(default)]
    memo: Option<String>,
    #[serde(default)]
    network: Option<String>,
}

async fn squads_token_transfer_proposal(
    Json(req): Json<SquadsTokenTransferProposalRequest>,
) -> Result<Json<SquadsProposalCreateResponse>, ApiError> {
    let signer = req.wallet.keypair()?;
    let multisig_key = squads_v4::parse_pubkey(&req.multisig, "多签地址")
        .map_err(|message| ApiError { message })?;
    let mint =
        squads_v4::parse_pubkey(&req.mint, "Token Mint").map_err(|message| ApiError { message })?;
    let recipient = if let Some(recipient) = req
        .recipient
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(
            squads_v4::parse_pubkey(recipient, "接收钱包地址")
                .map_err(|message| ApiError { message })?,
        )
    } else {
        None
    };
    if let Some(memo) = &req.memo {
        validate_text_len(memo, "memo", MAX_TEXT_FIELD_CHARS)?;
    }

    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let mint_info = token_mint_info_from_rpc(&client, &mint)?;
    let decimals = mint_info.decimals;
    let token_amount = token_amount_to_raw(&req.amount, decimals)?;
    let multisig = load_squads_multisig(&client, &multisig_key)?;
    let transaction_index = next_squads_transaction_index(&multisig)?;
    let vault = squads_v4::vault_pda(&multisig_key, 0);
    let source = if let Some(source) = req
        .source_token_account
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        squads_v4::parse_pubkey(source, "来源 Token 账户")
            .map_err(|message| ApiError { message })?
    } else {
        squads_v4::associated_token_address(&vault, &mint)
    };
    let destination_override = req
        .destination_token_account
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let destination = if let Some(destination) = destination_override {
        squads_v4::parse_pubkey(destination, "接收 Token 账户")
            .map_err(|message| ApiError { message })?
    } else if let Some(recipient) = recipient {
        squads_v4::associated_token_address(&recipient, &mint)
    } else {
        return Err(ApiError {
            message: "接收钱包地址或接收 Token 账户不能为空".to_string(),
        });
    };
    let transfer_ix = squads_v4::token_transfer_checked_ix(
        &source,
        &mint,
        &destination,
        &vault,
        token_amount,
        decimals,
    );
    let mut inner_instructions = Vec::new();
    if destination_override.is_none() {
        if let Some(recipient) = recipient {
            inner_instructions.push(squads_v4::create_associated_token_account_idempotent_ix(
                &vault, &recipient, &mint,
            ));
        }
    }
    inner_instructions.push(transfer_ix);
    let (tx_create_ix, transaction, vault, _) = squads_v4::vault_transaction_create_ix(
        &multisig_key,
        &signer.pubkey(),
        transaction_index,
        0,
        &inner_instructions,
        req.memo,
    )
    .map_err(|message| ApiError { message })?;
    let (proposal_ix, proposal) =
        squads_v4::proposal_create_ix(&multisig_key, &signer.pubkey(), transaction_index, false)
            .map_err(|message| ApiError { message })?;
    let signature = sign_and_send(
        &client,
        vec![tx_create_ix, proposal_ix],
        &[&signer],
        &signer.pubkey(),
    )?;

    Ok(Json(SquadsProposalCreateResponse {
        multisig: multisig_key.to_string(),
        vault: vault.to_string(),
        transaction: transaction.to_string(),
        proposal: proposal.to_string(),
        transaction_index,
        signature,
        network,
        status: "success".to_string(),
    }))
}

#[derive(Deserialize)]
struct SquadsPrepareUpgradeBufferRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    multisig: String,
    program_so_base64: String,
    #[serde(default)]
    expected_program_id: Option<String>,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Serialize)]
struct SquadsPrepareUpgradeBufferResponse {
    multisig: String,
    vault: String,
    buffer_address: String,
    create_signature: String,
    authority_signature: String,
    network: String,
    program_bytes: usize,
    rent_lamports: u64,
    write_signatures: Vec<String>,
    status: String,
}

async fn squads_prepare_upgrade_buffer(
    Json(req): Json<SquadsPrepareUpgradeBufferRequest>,
) -> Result<Json<SquadsPrepareUpgradeBufferResponse>, ApiError> {
    let program_bytes = decode_program_binary_base64(&req.program_so_base64)?;
    if let Some(expected_program_id) = req
        .expected_program_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let expected_program_id = Pubkey::from_str(expected_program_id).map_err(|_| ApiError {
            message: "无效的目标 Program ID".to_string(),
        })?;
        program_deploy::require_anchor_declared_program_id(&program_bytes, &expected_program_id)
            .map_err(|message| ApiError { message })?;
    }
    let program_bytes = verify_program_binary_offline(program_bytes).await?;

    let payer = req.wallet.keypair()?;
    let payer_pubkey = payer.pubkey();
    let multisig = squads_v4::parse_pubkey(&req.multisig, "多签地址")
        .map_err(|message| ApiError { message })?;
    let vault = squads_v4::vault_pda(&multisig, 0);
    let buffer_keypair = Keypair::new();
    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let multisig_state = load_squads_multisig(&client, &multisig)?;
    require_squads_member(&multisig_state, &payer_pubkey)?;
    let buffer_lamports = client
        .get_minimum_balance_for_rent_exemption(UpgradeableLoaderState::size_of_buffer(
            program_bytes.len(),
        ))
        .map_err(|e| ApiError {
            message: format!("计算 buffer 租金失败: {}", e),
        })?;

    let create_buffer_ixs = loader_v3_instruction::create_buffer(
        &payer_pubkey,
        &buffer_keypair.pubkey(),
        &payer_pubkey,
        buffer_lamports,
        program_bytes.len(),
    )
    .map_err(|e| ApiError {
        message: format!("创建 buffer 指令失败: {}", e),
    })?;
    let create_signature = sign_and_send_with_commitment(
        &client,
        create_buffer_ixs,
        &[&payer, &buffer_keypair],
        &payer_pubkey,
        "创建多签升级 Buffer",
        CommitmentConfig::finalized(),
        "finalized",
        Duration::from_secs(90),
    )
    .await?
    .0;

    let write_chunk_count = program_bytes.chunks(PROGRAM_WRITE_CHUNK_BYTES).count();
    let mut write_signatures = Vec::with_capacity(write_chunk_count);
    for (index, chunk) in program_bytes.chunks(PROGRAM_WRITE_CHUNK_BYTES).enumerate() {
        let offset = index
            .checked_mul(PROGRAM_WRITE_CHUNK_BYTES)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| ApiError {
                message: "Program 写入偏移超出范围".to_string(),
            })?;
        let write_ix = loader_v3_instruction::write(
            &buffer_keypair.pubkey(),
            &payer_pubkey,
            offset,
            chunk.to_vec(),
        );
        write_signatures.push(
            sign_and_send_with_commitment(
                &client,
                vec![write_ix],
                &[&payer],
                &payer_pubkey,
                &format!("写入多签升级 Buffer ({}/{})", index + 1, write_chunk_count),
                CommitmentConfig::confirmed(),
                "confirmed",
                Duration::from_secs(120),
            )
            .await?
            .0,
        );
    }

    let set_authority_ix =
        squads_v4::set_buffer_authority_ix(&buffer_keypair.pubkey(), &payer_pubkey, &vault);
    let authority_signature = sign_and_send_with_commitment(
        &client,
        vec![set_authority_ix],
        &[&payer],
        &payer_pubkey,
        "移交升级 Buffer 给 Squads vault",
        CommitmentConfig::confirmed(),
        "confirmed",
        Duration::from_secs(90),
    )
    .await?
    .0;

    Ok(Json(SquadsPrepareUpgradeBufferResponse {
        multisig: multisig.to_string(),
        vault: vault.to_string(),
        buffer_address: buffer_keypair.pubkey().to_string(),
        create_signature,
        authority_signature,
        network,
        program_bytes: program_bytes.len(),
        rent_lamports: buffer_lamports,
        write_signatures,
        status: "success".to_string(),
    }))
}

#[derive(Deserialize)]
struct SquadsProgramUpgradeProposalRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    multisig: String,
    program_id: String,
    buffer_address: String,
    #[serde(default)]
    spill_address: Option<String>,
    #[serde(default)]
    memo: Option<String>,
    #[serde(default)]
    network: Option<String>,
}

async fn squads_program_upgrade_proposal(
    Json(req): Json<SquadsProgramUpgradeProposalRequest>,
) -> Result<Json<SquadsProposalCreateResponse>, ApiError> {
    let program_id = squads_v4::parse_pubkey(&req.program_id, "Program ID")
        .map_err(|message| ApiError { message })?;

    let signer = req.wallet.keypair()?;
    let multisig_key = squads_v4::parse_pubkey(&req.multisig, "多签地址")
        .map_err(|message| ApiError { message })?;
    let buffer = squads_v4::parse_pubkey(&req.buffer_address, "buffer 地址")
        .map_err(|message| ApiError { message })?;
    let spill = if let Some(spill) = req
        .spill_address
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        squads_v4::parse_pubkey(spill, "spill 地址").map_err(|message| ApiError { message })?
    } else {
        signer.pubkey()
    };
    if let Some(memo) = &req.memo {
        validate_text_len(memo, "memo", MAX_TEXT_FIELD_CHARS)?;
    }

    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let multisig = load_squads_multisig(&client, &multisig_key)?;
    require_squads_member(&multisig, &signer.pubkey())?;
    let transaction_index = next_squads_transaction_index(&multisig)?;
    let vault = squads_v4::vault_pda(&multisig_key, 0);
    require_program_upgrade_authority(&client, &program_id, &vault)?;
    require_upgrade_buffer_authority(&client, &buffer, &vault)?;
    let upgrade_ix = squads_v4::upgrade_program_ix(&program_id, &buffer, &vault, &spill);
    let (tx_create_ix, transaction, vault, _) = squads_v4::vault_transaction_create_ix(
        &multisig_key,
        &signer.pubkey(),
        transaction_index,
        0,
        &[upgrade_ix],
        req.memo,
    )
    .map_err(|message| ApiError { message })?;
    let (proposal_ix, proposal) =
        squads_v4::proposal_create_ix(&multisig_key, &signer.pubkey(), transaction_index, false)
            .map_err(|message| ApiError { message })?;
    let signature = sign_and_send(
        &client,
        vec![tx_create_ix, proposal_ix],
        &[&signer],
        &signer.pubkey(),
    )?;

    Ok(Json(SquadsProposalCreateResponse {
        multisig: multisig_key.to_string(),
        vault: vault.to_string(),
        transaction: transaction.to_string(),
        proposal: proposal.to_string(),
        transaction_index,
        signature,
        network,
        status: "success".to_string(),
    }))
}

#[derive(Deserialize)]
struct SquadsVoteRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    multisig: String,
    proposal: String,
    #[serde(default)]
    memo: Option<String>,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Serialize)]
struct SquadsActionResponse {
    signature: String,
    status: String,
    network: String,
}

async fn squads_proposal_approve(
    Json(req): Json<SquadsVoteRequest>,
) -> Result<Json<SquadsActionResponse>, ApiError> {
    let signer = req.wallet.keypair()?;
    let multisig = squads_v4::parse_pubkey(&req.multisig, "多签地址")
        .map_err(|message| ApiError { message })?;
    let proposal = squads_v4::parse_pubkey(&req.proposal, "提案地址")
        .map_err(|message| ApiError { message })?;
    if let Some(memo) = &req.memo {
        validate_text_len(memo, "memo", MAX_TEXT_FIELD_CHARS)?;
    }
    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let ix = squads_v4::proposal_approve_ix(&multisig, &proposal, &signer.pubkey(), req.memo)
        .map_err(|message| ApiError { message })?;
    let signature = sign_and_send_single(&client, ix, &signer)?;
    Ok(Json(SquadsActionResponse {
        signature,
        status: "success".to_string(),
        network,
    }))
}

async fn squads_proposal_reject(
    Json(req): Json<SquadsVoteRequest>,
) -> Result<Json<SquadsActionResponse>, ApiError> {
    let signer = req.wallet.keypair()?;
    let multisig = squads_v4::parse_pubkey(&req.multisig, "多签地址")
        .map_err(|message| ApiError { message })?;
    let proposal = squads_v4::parse_pubkey(&req.proposal, "提案地址")
        .map_err(|message| ApiError { message })?;
    if let Some(memo) = &req.memo {
        validate_text_len(memo, "memo", MAX_TEXT_FIELD_CHARS)?;
    }
    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let ix = squads_v4::proposal_reject_ix(&multisig, &proposal, &signer.pubkey(), req.memo)
        .map_err(|message| ApiError { message })?;
    let signature = sign_and_send_single(&client, ix, &signer)?;
    Ok(Json(SquadsActionResponse {
        signature,
        status: "success".to_string(),
        network,
    }))
}

#[derive(Deserialize)]
struct SquadsExecuteRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    multisig: String,
    proposal: String,
    transaction_index: u64,
    #[serde(default)]
    network: Option<String>,
}

async fn squads_proposal_execute(
    Json(req): Json<SquadsExecuteRequest>,
) -> Result<Json<SquadsActionResponse>, ApiError> {
    let signer = req.wallet.keypair()?;
    let multisig = squads_v4::parse_pubkey(&req.multisig, "多签地址")
        .map_err(|message| ApiError { message })?;
    let proposal = squads_v4::parse_pubkey(&req.proposal, "提案地址")
        .map_err(|message| ApiError { message })?;
    let transaction = squads_v4::transaction_pda(&multisig, req.transaction_index);
    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let vault_transaction = load_squads_vault_transaction(&client, &transaction)?;
    if vault_transaction.multisig != multisig || vault_transaction.index != req.transaction_index {
        return Err(ApiError {
            message: "Squads 交易账户与请求参数不匹配".to_string(),
        });
    }
    let ix = squads_v4::vault_transaction_execute_ix(
        &multisig,
        &transaction,
        &proposal,
        &signer.pubkey(),
        &vault_transaction.message,
        vault_transaction.vault_index,
        u8::try_from(vault_transaction.ephemeral_signer_bumps.len()).map_err(|_| ApiError {
            message: "Squads ephemeral signer 数量超出范围".to_string(),
        })?,
    )
    .map_err(|message| ApiError { message })?;
    let signature = sign_and_send_single(&client, ix, &signer)?;
    Ok(Json(SquadsActionResponse {
        signature,
        status: "success".to_string(),
        network,
    }))
}

#[derive(Deserialize)]
struct SquadsSetProgramAuthorityRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    multisig: String,
    program_id: String,
    #[serde(default)]
    network: Option<String>,
}

#[derive(Serialize)]
struct SquadsSetProgramAuthorityResponse {
    program_id: String,
    programdata_address: String,
    new_authority: String,
    signature: String,
    network: String,
    status: String,
}

async fn squads_set_program_authority(
    Json(req): Json<SquadsSetProgramAuthorityRequest>,
) -> Result<Json<SquadsSetProgramAuthorityResponse>, ApiError> {
    let signer = req.wallet.keypair()?;
    let multisig = squads_v4::parse_pubkey(&req.multisig, "多签地址")
        .map_err(|message| ApiError { message })?;
    let program_id = squads_v4::parse_pubkey(&req.program_id, "Program ID")
        .map_err(|message| ApiError { message })?;
    let vault = squads_v4::vault_pda(&multisig, 0);
    let (client, network) = rpc_client_for(req.network.as_deref())?;
    let multisig_state = load_squads_multisig(&client, &multisig)?;
    require_squads_member(&multisig_state, &signer.pubkey())?;
    let programdata_address =
        require_program_upgrade_authority(&client, &program_id, &signer.pubkey())?;
    let ix = squads_v4::set_program_upgrade_authority_ix(&program_id, &signer.pubkey(), &vault);
    let signature = sign_and_send_single(&client, ix, &signer)?;
    Ok(Json(SquadsSetProgramAuthorityResponse {
        program_id: program_id.to_string(),
        programdata_address: programdata_address.to_string(),
        new_authority: vault.to_string(),
        signature,
        network,
        status: "success".to_string(),
    }))
}

// ============= 2FA Operations (4-6) =============

// 4. Setup 2FA
#[derive(Deserialize)]
struct Setup2faRequest {
    hardware_fingerprint: String,
    master_password: String,
    #[serde(default)]
    account: Option<String>,
    #[serde(default)]
    issuer: Option<String>,
}

impl Drop for Setup2faRequest {
    fn drop(&mut self) {
        self.hardware_fingerprint.zeroize();
        self.master_password.zeroize();
    }
}
#[derive(Serialize)]
struct Setup2faResponse {
    totp_secret: String,
    qr_code_url: String,
}

impl Drop for Setup2faResponse {
    fn drop(&mut self) {
        self.totp_secret.zeroize();
        self.qr_code_url.zeroize();
    }
}

async fn setup_2fa(
    Json(mut req): Json<Setup2faRequest>,
) -> Result<Json<Setup2faResponse>, ApiError> {
    require_nonempty(req.hardware_fingerprint.trim(), "硬件指纹")?;
    require_nonempty(req.master_password.as_str(), "主密码")?;
    validate_text_len(&req.hardware_fingerprint, "硬件指纹", MAX_TEXT_FIELD_CHARS)?;
    validate_text_len(&req.master_password, "主密码", MAX_TEXT_FIELD_CHARS)?;
    let account = validate_optional_label(req.account.take(), "账户名称")?
        .unwrap_or_else(|| "fnzero-safe".to_string());
    let issuer = validate_optional_label(req.issuer.take(), "发行者")?
        .unwrap_or_else(|| "FnzSafe".to_string());

    let totp_secret = fnzero_safe::derive_totp_secret_from_hardware_and_password(
        &req.hardware_fingerprint,
        &req.master_password,
        &account,
        &issuer,
    )
    .map_err(|e| ApiError {
        message: format!("生成 TOTP 失败: {}", e),
    })?;

    // Generate QR code URL
    let qr_code_url = format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}",
        urlencoding::encode(&issuer),
        urlencoding::encode(&account),
        urlencoding::encode(&totp_secret),
        urlencoding::encode(&issuer)
    );

    Ok(Json(Setup2faResponse {
        totp_secret,
        qr_code_url,
    }))
}

// 5. Create Triple-Factor Wallet
#[derive(Deserialize)]
struct CreateTripleFactorRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    totp_secret: String,
    hardware_fingerprint: String,
    master_password: String,
    question_index: usize,
    security_answer: String,
}

impl Drop for CreateTripleFactorRequest {
    fn drop(&mut self) {
        self.totp_secret.zeroize();
        self.hardware_fingerprint.zeroize();
        self.master_password.zeroize();
        self.security_answer.zeroize();
    }
}
#[derive(Serialize)]
struct CreateTripleFactorResponse {
    encrypted_wallet: String,
    public_key: String,
}

async fn create_triple_factor_wallet(
    Json(req): Json<CreateTripleFactorRequest>,
) -> Result<Json<CreateTripleFactorResponse>, ApiError> {
    require_nonempty(req.totp_secret.trim(), "TOTP secret")?;
    require_nonempty(req.hardware_fingerprint.trim(), "硬件指纹")?;
    require_nonempty(req.master_password.as_str(), "主密码")?;
    require_nonempty(req.security_answer.trim(), "安全答案")?;
    if req.question_index > MAX_SECURITY_QUESTION_INDEX {
        return Err(ApiError {
            message: format!("安全问题索引不能超过 {}", MAX_SECURITY_QUESTION_INDEX),
        });
    }
    validate_text_len(&req.totp_secret, "TOTP secret", MAX_TEXT_FIELD_CHARS)?;
    validate_text_len(&req.hardware_fingerprint, "硬件指纹", MAX_TEXT_FIELD_CHARS)?;
    validate_text_len(&req.master_password, "主密码", MAX_TEXT_FIELD_CHARS)?;
    validate_text_len(&req.security_answer, "安全答案", MAX_TEXT_FIELD_CHARS)?;
    let keypair = req.wallet.keypair()?;
    let private_key = Zeroizing::new(keypair.to_base58_string());

    let encrypted = fnzero_safe::encrypt_with_triple_factor(
        &private_key,
        &req.totp_secret,
        &req.hardware_fingerprint,
        &req.master_password,
        req.question_index,
        &req.security_answer,
    )
    .map_err(|e| ApiError {
        message: format!("加密失败: {}", e),
    })?;

    // Get public key from private key
    let public_key = KeyManager::get_public_key(&private_key).map_err(|e| ApiError {
        message: format!("获取公钥失败: {}", e),
    })?;

    Ok(Json(CreateTripleFactorResponse {
        encrypted_wallet: encrypted,
        public_key,
    }))
}

// 6. Unlock Triple-Factor Wallet
#[derive(Deserialize)]
struct UnlockTripleFactorRequest {
    encrypted_wallet: String,
    hardware_fingerprint: String,
    master_password: String,
    security_answer: String,
    totp_code: String,
}

impl Drop for UnlockTripleFactorRequest {
    fn drop(&mut self) {
        self.encrypted_wallet.zeroize();
        self.hardware_fingerprint.zeroize();
        self.master_password.zeroize();
        self.security_answer.zeroize();
        self.totp_code.zeroize();
    }
}
#[derive(Serialize)]
struct UnlockTripleFactorResponse {
    public_key: String,
    unlocked: bool,
}

async fn unlock_triple_factor_wallet(
    Json(req): Json<UnlockTripleFactorRequest>,
) -> Result<Json<UnlockTripleFactorResponse>, ApiError> {
    require_nonempty(req.encrypted_wallet.trim(), "三因素钱包")?;
    require_nonempty(req.hardware_fingerprint.trim(), "硬件指纹")?;
    require_nonempty(req.master_password.as_str(), "主密码")?;
    require_nonempty(req.security_answer.trim(), "安全答案")?;
    require_nonempty(req.totp_code.trim(), "TOTP 验证码")?;
    validate_text_len(&req.encrypted_wallet, "三因素钱包", MAX_JSON_BODY_BYTES)?;
    validate_text_len(&req.hardware_fingerprint, "硬件指纹", MAX_TEXT_FIELD_CHARS)?;
    validate_text_len(&req.master_password, "主密码", MAX_TEXT_FIELD_CHARS)?;
    validate_text_len(&req.security_answer, "安全答案", MAX_TEXT_FIELD_CHARS)?;
    validate_text_len(&req.totp_code, "TOTP 验证码", MAX_LABEL_CHARS)?;
    let (decrypted, _question, _index) = fnzero_safe::decrypt_with_triple_factor_and_2fa(
        &req.encrypted_wallet,
        &req.hardware_fingerprint,
        &req.master_password,
        &req.security_answer,
        &req.totp_code,
    )
    .map_err(|e| ApiError {
        message: format!("解密失败: {}", e),
    })?;
    let decrypted = Zeroizing::new(decrypted);

    let public_key = KeyManager::get_public_key(&decrypted).map_err(|e| ApiError {
        message: format!("获取公钥失败: {}", e),
    })?;

    Ok(Json(UnlockTripleFactorResponse {
        public_key,
        unlocked: true,
    }))
}

// ============= Pump.fun Operations (15-18) =============

// 15. Pump.fun Sell Token
#[derive(Deserialize)]
struct PumpfunSellRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    mint: String,
    #[serde(default)]
    amount: Option<DecimalAmount>,
    #[serde(default)]
    sell_percent: Option<u64>,
    #[serde(default)]
    slippage: Option<u64>,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct PumpfunSellResponse {
    status: String,
    signature: String,
    dex: String,
    market: String,
    sold_raw_amount: String,
    decimals: u8,
    source_account: String,
}

async fn pumpfun_sell(
    Json(req): Json<PumpfunSellRequest>,
) -> Result<Json<PumpfunSellResponse>, ApiError> {
    let keypair = req.wallet.keypair()?;

    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let slippage = normalize_slippage_bps(req.slippage)?;
    let sell_percent = normalize_sell_percent_bps(req.sell_percent)?;

    let execution = execute_pump_sell(
        keypair,
        req.mint,
        &rpc_url,
        req.amount,
        sell_percent,
        slippage,
        DexType::PumpFun,
    )
    .await?;

    Ok(Json(PumpfunSellResponse {
        status: "success".to_string(),
        signature: execution.signature,
        dex: pump_sell_dex_value(execution.dex_type).to_string(),
        market: pump_sell_market_value(execution.dex_type).to_string(),
        sold_raw_amount: execution.sold_raw_amount.to_string(),
        decimals: execution.decimals,
        source_account: execution.source_account,
    }))
}

// 17. Pump.fun Cashback
#[derive(Deserialize)]
struct CashbackInfoRequest {
    owner: String,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct CashbackInfoResponse {
    owner: String,
    network: String,
    accumulator: String,
    amount_lamports: u64,
    ui_amount_string: String,
    asset: String,
    available: bool,
}

async fn cashback_info_handler(
    req: CashbackInfoRequest,
    dex_type: DexType,
) -> Result<Json<CashbackInfoResponse>, ApiError> {
    let owner = Pubkey::from_str(&req.owner).map_err(|_| ApiError {
        message: "无效的钱包地址".to_string(),
    })?;
    let network = network_name(req.network.as_deref()).to_string();
    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let client = RpcClient::new_with_commitment(rpc_url.to_string(), CommitmentConfig::confirmed());
    let (accumulator, amount_lamports, asset) = cashback_info(&client, &owner, dex_type)?;
    Ok(Json(CashbackInfoResponse {
        owner: owner.to_string(),
        network,
        accumulator: accumulator.to_string(),
        amount_lamports,
        ui_amount_string: lamports_to_sol(amount_lamports).to_string(),
        asset,
        available: amount_lamports > 0,
    }))
}

async fn pumpfun_cashback_info(
    Json(req): Json<CashbackInfoRequest>,
) -> Result<Json<CashbackInfoResponse>, ApiError> {
    cashback_info_handler(req, DexType::PumpFun).await
}

async fn pumpswap_cashback_info(
    Json(req): Json<CashbackInfoRequest>,
) -> Result<Json<CashbackInfoResponse>, ApiError> {
    cashback_info_handler(req, DexType::PumpSwap).await
}

#[derive(Deserialize)]
struct PumpfunCashbackRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct PumpfunCashbackResponse {
    status: String,
    message: String,
    signature: String,
    amount_lamports: u64,
    ui_amount_string: String,
    asset: String,
}

async fn pumpfun_cashback(
    Json(req): Json<PumpfunCashbackRequest>,
) -> Result<Json<PumpfunCashbackResponse>, ApiError> {
    let keypair = req.wallet.keypair()?;
    let owner = keypair.pubkey();
    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let rpc_client =
        RpcClient::new_with_commitment(rpc_url.to_string(), CommitmentConfig::confirmed());
    let (_accumulator, amount_lamports, asset) =
        cashback_info(&rpc_client, &owner, DexType::PumpFun)?;
    if amount_lamports == 0 {
        return Err(ApiError {
            message: "当前没有可领取的 Pump.fun 返现".to_string(),
        });
    }
    let signature = execute_cashback_claim(keypair, &rpc_url, DexType::PumpFun).await?;
    Ok(Json(PumpfunCashbackResponse {
        status: "success".to_string(),
        message: format!(
            "已提交 Pump.fun 返现领取，领取前可领取金额约 {} {}",
            lamports_to_sol(amount_lamports),
            asset
        ),
        signature,
        amount_lamports,
        ui_amount_string: lamports_to_sol(amount_lamports).to_string(),
        asset,
    }))
}

// 16. PumpSwap Sell Token
#[derive(Deserialize)]
struct PumpswapSellRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    mint: String,
    #[serde(default)]
    amount: Option<DecimalAmount>,
    #[serde(default)]
    sell_percent: Option<u64>,
    #[serde(default)]
    slippage: Option<u64>,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct PumpswapSellResponse {
    status: String,
    signature: String,
    dex: String,
    market: String,
    sold_raw_amount: String,
    decimals: u8,
    source_account: String,
}

async fn pumpswap_sell(
    Json(req): Json<PumpswapSellRequest>,
) -> Result<Json<PumpswapSellResponse>, ApiError> {
    let keypair = req.wallet.keypair()?;

    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let slippage = normalize_slippage_bps(req.slippage)?;
    let sell_percent = normalize_sell_percent_bps(req.sell_percent)?;

    let execution = execute_pump_sell(
        keypair,
        req.mint,
        &rpc_url,
        req.amount,
        sell_percent,
        slippage,
        DexType::PumpSwap,
    )
    .await?;

    Ok(Json(PumpswapSellResponse {
        status: "success".to_string(),
        signature: execution.signature,
        dex: pump_sell_dex_value(execution.dex_type).to_string(),
        market: pump_sell_market_value(execution.dex_type).to_string(),
        sold_raw_amount: execution.sold_raw_amount.to_string(),
        decimals: execution.decimals,
        source_account: execution.source_account,
    }))
}

async fn automated_token_sell(
    Json(intent): Json<AutomatedTokenSellIntent>,
) -> Result<Json<AutomatedTradeReceipt>, ApiError> {
    let now_ms = now_unix_ms_lossy();
    intent
        .validate(now_ms)
        .map_err(|message| ApiError { message })?;
    validate_wallet_id(&intent.wallet_id)?;
    Pubkey::from_str(&intent.mint).map_err(|_| ApiError {
        message: "automated trade token mint is invalid".to_string(),
    })?;
    let execution_guard =
        match automated_trade::begin(&intent, now_ms).map_err(|message| ApiError { message })? {
            ReplayDecision::Finished(result) => {
                return result.map(Json).map_err(|message| ApiError { message })
            }
            ReplayDecision::Execute(guard) => guard,
        };

    let keypair = match keypair_from_saved_wallet_session(&intent.wallet_id) {
        Ok(keypair) => keypair,
        Err(error) => {
            let _ = execution_guard.finish(Err(error.message.clone()));
            return Err(error);
        }
    };
    let dex_type = if intent.venue == "pumpfun" {
        DexType::PumpFun
    } else {
        DexType::PumpSwap
    };
    let execution = execute_pump_sell(
        keypair,
        intent.mint,
        DEFAULT_RPC_URL,
        None,
        Some(intent.sell_percent_bps),
        intent.slippage_bps,
        dex_type,
    )
    .await;
    let receipt = match execution {
        Ok(execution) => AutomatedTradeReceipt {
            status: "success".to_string(),
            signature: execution.signature,
            dex: pump_sell_dex_value(execution.dex_type).to_string(),
            market: pump_sell_market_value(execution.dex_type).to_string(),
            sold_raw_amount: execution.sold_raw_amount.to_string(),
            decimals: execution.decimals,
            source_account: execution.source_account,
        },
        Err(error) => {
            let _ = execution_guard.finish(Err(error.message.clone()));
            return Err(error);
        }
    };
    execution_guard
        .finish(Ok(receipt.clone()))
        .map_err(|message| ApiError { message })?;
    Ok(Json(receipt))
}

// 18. PumpSwap Cashback
#[derive(Deserialize)]
struct PumpswapCashbackRequest {
    #[serde(flatten)]
    wallet: WalletAuthRequest,
    #[serde(default)]
    network: Option<String>,
}
#[derive(Serialize)]
struct PumpswapCashbackResponse {
    status: String,
    message: String,
    signature: String,
    amount_lamports: u64,
    ui_amount_string: String,
    asset: String,
}

async fn pumpswap_cashback(
    Json(req): Json<PumpswapCashbackRequest>,
) -> Result<Json<PumpswapCashbackResponse>, ApiError> {
    let keypair = req.wallet.keypair()?;
    let owner = keypair.pubkey();
    let rpc_url = get_rpc_url(req.network.as_deref())?;
    let rpc_client =
        RpcClient::new_with_commitment(rpc_url.to_string(), CommitmentConfig::confirmed());
    let (_accumulator, amount_lamports, asset) =
        cashback_info(&rpc_client, &owner, DexType::PumpSwap)?;
    if amount_lamports == 0 {
        return Err(ApiError {
            message: "当前没有可领取的 PumpSwap 返现".to_string(),
        });
    }
    let signature = execute_cashback_claim(keypair, &rpc_url, DexType::PumpSwap).await?;
    Ok(Json(PumpswapCashbackResponse {
        status: "success".to_string(),
        message: format!(
            "已提交 PumpSwap 返现领取，领取前可领取金额约 {} {}",
            lamports_to_sol(amount_lamports),
            asset
        ),
        signature,
        amount_lamports,
        ui_amount_string: lamports_to_sol(amount_lamports).to_string(),
        asset,
    }))
}

// ============= Static File Serving =============

async fn serve_assets(uri: Uri) -> impl IntoResponse {
    let path = uri.path();
    tracing::info!("Serving asset: {}", path);

    // URL decode the path to handle encoded characters like %5B -> [ and %5D -> ]
    let decoded_path = match urlencoding::decode(path) {
        Ok(decoded) => decoded.to_string(),
        Err(e) => {
            tracing::warn!("Failed to decode path: {}, error: {}", path, e);
            path.to_string()
        }
    };

    let path_to_serve = if decoded_path == "/" {
        "index.html".to_string()
    } else {
        let trimmed = decoded_path.trim_start_matches('/');
        if trimmed.ends_with('/') {
            format!("{}index.html", trimmed)
        } else {
            trimmed.to_string()
        }
    };

    tracing::info!("Looking for asset: {}", path_to_serve);

    let asset = Assets::get(&path_to_serve)
        .map(|content| (path_to_serve.clone(), content))
        .or_else(|| {
            let index_path = format!("{}/index.html", path_to_serve.trim_end_matches('/'));
            Assets::get(&index_path).map(|content| (index_path, content))
        });

    match asset {
        Some((asset_path, content)) => {
            let mime = mime_guess::from_path(&asset_path)
                .first_or_octet_stream()
                .to_string();
            tracing::info!("Found asset: {}, mime: {}", asset_path, mime);
            asset_response(
                StatusCode::OK,
                Some(&mime),
                Body::from(content.data.to_vec()),
            )
        }
        None => {
            tracing::warn!(
                "Asset not found: {}, falling back to index.html",
                path_to_serve
            );
            if let Some(index) = Assets::get("index.html") {
                asset_response(
                    StatusCode::OK,
                    Some("text/html"),
                    Body::from(index.data.to_vec()),
                )
            } else {
                asset_response(StatusCode::NOT_FOUND, None, Body::from("Not Found"))
            }
        }
    }
}

fn asset_response(status: StatusCode, content_type: Option<&str>, body: Body) -> Response {
    let mut builder = Response::builder().status(status);
    if let Some(content_type) = content_type {
        builder = builder.header("Content-Type", content_type);
    }
    builder.body(body).unwrap_or_else(|e| {
        tracing::error!("Failed to build asset response: {}", e);
        let mut response = Response::new(Body::from(r#"{"error":"Internal Server Error"}"#));
        *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        response
            .headers_mut()
            .insert("content-type", HeaderValue::from_static("application/json"));
        response
    })
}

#[derive(Debug)]
struct ApiError {
    message: String,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let body = Json(json!({ "error": self.message }));
        (status, body).into_response()
    }
}
impl ApiError {
    fn status_code(&self) -> StatusCode {
        let message = self.message.as_str();
        if message == SBF_VERIFY_BUSY_MESSAGE || message.starts_with("密码尝试过于频繁") {
            StatusCode::TOO_MANY_REQUESTS
        } else if message.starts_with("RpcUnavailable:")
            || message.starts_with("GasEstimateFailed:")
            || message.starts_with("HistoryUnavailable:")
        {
            StatusCode::BAD_GATEWAY
        } else if message.starts_with("WrongPassword:")
            || message.starts_with("BiometricCancelled:")
            || message.starts_with("TotpInvalid:")
        {
            StatusCode::UNAUTHORIZED
        } else if message.starts_with("Unsupported:") || message.starts_with("NotImplemented:") {
            StatusCode::NOT_IMPLEMENTED
        } else if message.starts_with("InvalidInput:")
            || message.starts_with("InvalidChainId:")
            || message.starts_with("InvalidTypedData:")
            || message.starts_with("UnsupportedChain:")
            || message.starts_with("InsufficientFunds:")
            || message.starts_with("UserRejected:")
        {
            StatusCode::BAD_REQUEST
        } else if message == PROGRAM_DEPLOY_BUSY_MESSAGE
            || message.contains("目标 Program 或 ProgramData 已存在")
            || message.contains("部署 journal 冲突")
            || message.contains("尚未统一密码")
        {
            StatusCode::CONFLICT
        } else if message.contains("RPC 节点暂时无法读取")
            || message.contains("卖出执行异常")
            || message.contains("卖出成功但未返回交易签名")
        {
            StatusCode::BAD_GATEWAY
        } else if message.contains("未找到") {
            StatusCode::NOT_FOUND
        } else if message.contains("密码校验失败")
            || message.contains("密码错误")
            || message.contains("钱包解锁失败")
            || message.contains("keystore 校验失败")
            || message.contains("keystore 解密失败")
            || message.contains("解密失败")
        {
            StatusCode::UNAUTHORIZED
        } else if message.contains("已禁用") {
            StatusCode::FORBIDDEN
        } else if message.contains("查询失败")
            || message.contains("查询余额失败")
            || message.contains("查询交易记录失败")
            || message.contains("查询 Token")
            || message.contains("查询 Program 失败")
            || message.contains("获取 blockhash 失败")
            || message.contains("get_account")
            || message.contains("getProgramAccounts")
            || message.contains("rpc")
            || message.contains("RPC")
            || message.contains("Connection rate limits exceeded")
            || message.contains("429")
            || message.contains("timed out")
            || message.contains("timeout")
            || message.contains("error sending request")
        {
            StatusCode::BAD_GATEWAY
        } else if message.contains("需要")
            || message.contains("必须")
            || message.contains("无效")
            || message.contains("过大")
            || message.contains("不能为空")
            || message.contains("请使用")
            || message.contains("超出")
            || message.contains("不能超过")
            || message.contains("余额为 0")
            || message.contains("余额")
            || message.contains("未找到可用 PumpSwap 池")
            || message.contains("获取 Pump.fun 参数失败")
            || message.contains("获取 PumpSwap 参数失败")
            || message.contains("No pool found")
            || message.contains("Bonding curve not found")
            || message.contains("bonding curve")
            || message.contains("卖出失败")
        {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        ApiError {
            message: err.to_string(),
        }
    }
}
