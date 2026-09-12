//! Shared EVM wallet, asset, payment, and dApp signing services.
//!
//! EVM support is intentionally chain-generic: a chain is data (`chain_id`,
//! RPC URL, explorer URL, and native symbol), while wallet, ERC-20, gas, and
//! signing logic is shared by every EVM network.

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng as AeadOsRng, Payload},
    Aes256Gcm,
};
use argon2::{Algorithm, Argon2, Params, Version as Argon2Version};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use bip39::{Language, Mnemonic};
use fnzero_safe_chain_core::{
    capabilities, capability_ids, families, validate_derivation_path_input,
    validate_mnemonic_input, ChainAdapter, ChainDescriptor, ChainEndpoint, ChainError, ChainFamily,
    ChainId, ChainResult, DerivedAccount, NativeAsset, SupportLevel,
};
use k256::{
    ecdsa::{RecoveryId, Signature, SigningKey},
    elliptic_curve::rand_core::OsRng,
};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use std::io::Read;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const DEFAULT_EVM_DERIVATION_PATH: &str = "m/44'/60'/0'/0/0";
const LEGACY_KEYSTORE_VERSION: u8 = 1;
const KEYSTORE_VERSION: u8 = 2;
const KEYSTORE_SECRET_MNEMONIC: &str = "mnemonic";
const KEYSTORE_SECRET_PRIVATE_KEY: &str = "private_key";
const KEYSTORE_KDF: &str = "argon2id";
const KEYSTORE_CIPHER: &str = "aes-256-gcm";
const KEYSTORE_AAD_DOMAIN: &[u8] = b"fnzero-safe-evm-keystore";
const KEYSTORE_SALT_BYTES: usize = 16;
const KEYSTORE_NONCE_BYTES: usize = 12;
const KEYSTORE_TAG_BYTES: usize = 16;
const MAX_KEYSTORE_JSON_BYTES: usize = 128 * 1024;
const MAX_KEYSTORE_SECRET_BYTES: usize = 1024;
const MAX_KEYSTORE_PASSWORD_BYTES: usize = 1024;
const PRIVATE_KEY_BYTES: usize = 32;
const ARGON2_MEMORY_KIB: u32 = 64 * 1024;
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 1;
const JSON_RPC_TIMEOUT_SECS: u64 = 20;
const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
const ERC20_BALANCE_OF_SELECTOR: [u8; 4] = [0x70, 0xa0, 0x82, 0x31];
const ERC20_DECIMALS_SELECTOR: [u8; 4] = [0x31, 0x3c, 0xe5, 0x67];
const ERC20_SYMBOL_SELECTOR: [u8; 4] = [0x95, 0xd8, 0x9b, 0x41];
const ERC20_NAME_SELECTOR: [u8; 4] = [0x06, 0xfd, 0xde, 0x03];
const DEFAULT_PRIORITY_FEE_WEI: &str = "1500000000";
const ETHERSCAN_API_KEY_ENV: &str = "FNZERO_SAFE_ETHERSCAN_API_KEY";
const MAX_ETHERSCAN_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum EvmServiceError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("wrong password")]
    WrongPassword,
    #[error("unsupported chain")]
    UnsupportedChain,
    #[error("EVM RPC request failed")]
    RpcUnavailable,
    #[error("gas estimation failed")]
    GasEstimateFailed,
    #[error("insufficient funds")]
    InsufficientFunds,
    #[error("invalid chain id")]
    InvalidChainId,
    #[error("user rejected the signing request")]
    UserRejected,
    #[error("invalid typed data")]
    InvalidTypedData,
    #[error("transaction history is unavailable")]
    HistoryUnavailable,
}

pub type EvmResult<T> = Result<T, EvmServiceError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmChainConfig {
    pub chain_id: u64,
    pub name: String,
    pub native_symbol: String,
    pub rpc_url: String,
    pub explorer_url: Option<String>,
    pub testnet: bool,
}

/// Adapts one EVM network to the chain-agnostic registry.
pub struct EvmChainAdapter {
    descriptor: ChainDescriptor,
}

impl EvmChainAdapter {
    pub fn new(chain: EvmChainConfig) -> ChainResult<Self> {
        let history_api_key = etherscan_api_key();
        Self::new_with_history_api_key(chain, history_api_key.as_deref().map(String::as_str))
    }

    fn new_with_history_api_key(
        chain: EvmChainConfig,
        history_api_key: Option<&str>,
    ) -> ChainResult<Self> {
        let chain_id = ChainId::new("eip155", &chain.chain_id.to_string())?;
        validate_chain(&chain).map_err(|error| match error {
            EvmServiceError::InvalidChainId => {
                ChainError::InvalidChainId(format!("eip155:{}", chain.chain_id))
            }
            error => ChainError::InvalidDescriptor {
                chain_id: chain_id.clone(),
                reason: error.to_string(),
            },
        })?;
        let mut chain_capabilities = capability_ids(&[
            capabilities::ACCOUNT_DERIVATION,
            capabilities::ADDRESS_VALIDATION,
            capabilities::PRIVATE_KEY_IMPORT,
            capabilities::NATIVE_BALANCE,
            capabilities::FUNGIBLE_TOKENS,
            capabilities::TRANSFER,
            capabilities::STATUS,
            capabilities::MESSAGE_SIGNING,
            capabilities::DAPP_CONNECT,
        ])?;
        if etherscan_history_available(&chain, history_api_key) {
            chain_capabilities.push(fnzero_safe_chain_core::CapabilityId::new(
                capabilities::HISTORY,
            )?);
        }
        Ok(Self {
            descriptor: ChainDescriptor {
                chain_id,
                family: ChainFamily::new(families::EVM)?,
                name: chain.name,
                network: if chain.testnet { "testnet" } else { "mainnet" }.to_string(),
                testnet: chain.testnet,
                native_asset: NativeAsset {
                    symbol: chain.native_symbol.clone(),
                    name: chain.native_symbol,
                    decimals: 18,
                },
                default_derivation_path: DEFAULT_EVM_DERIVATION_PATH.to_string(),
                address_formats: vec!["hex20".to_string()],
                capabilities: chain_capabilities,
                endpoints: vec![ChainEndpoint {
                    kind: "ethereum-json-rpc".to_string(),
                    url: chain.rpc_url,
                }],
                explorer_url: chain.explorer_url,
                support_level: SupportLevel::Beta,
            },
        })
    }
}

impl ChainAdapter for EvmChainAdapter {
    fn descriptor(&self) -> &ChainDescriptor {
        &self.descriptor
    }

    fn normalize_address(&self, address: &str) -> ChainResult<String> {
        crate::normalize_address(address, "address")
            .map_err(|error| ChainError::InvalidAddress(error.to_string()))
    }

    fn derive_account(
        &self,
        mnemonic: &str,
        derivation_path: Option<&str>,
    ) -> ChainResult<DerivedAccount> {
        let path = derivation_path
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_EVM_DERIVATION_PATH);
        validate_evm_adapter_path(path)?;
        let address = address_from_mnemonic(mnemonic, Some(path))
            .map_err(|error| ChainError::DerivationFailed(error.to_string()))?;
        DerivedAccount::new(
            self.descriptor.chain_id.clone(),
            address,
            path.to_string(),
            None,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmWalletSummary {
    pub id: String,
    pub name: String,
    pub address: String,
    pub derivation_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmWalletKeystore {
    pub wallet: EvmWalletSummary,
    pub keystore_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmCreateWalletRequest {
    pub name: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmImportPrivateKeyRequest {
    pub name: String,
    pub private_key_hex: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmImportMnemonicRequest {
    pub name: String,
    pub mnemonic: String,
    pub derivation_path: Option<String>,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmImportKeystoreRequest {
    pub name: String,
    pub keystore_json: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmUnlockWalletRequest {
    pub keystore_json: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmExportPrivateKeyRequest {
    pub keystore_json: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmExportPrivateKeyResponse {
    pub address: String,
    pub private_key_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmTokenQuery {
    pub contract_address: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmAssetQueryRequest {
    pub chain: EvmChainConfig,
    pub wallet_address: String,
    pub tokens: Vec<EvmTokenQuery>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmTokenAsset {
    pub contract_address: String,
    pub symbol: String,
    pub name: String,
    pub balance: String,
    pub decimals: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmAssetSnapshot {
    pub chain: EvmChainConfig,
    pub wallet_address: String,
    pub native_balance_wei: String,
    pub tokens: Vec<EvmTokenAsset>,
    pub recent_transactions: Vec<EvmTransactionHistoryEntry>,
    pub history_status: String,
    pub history_message: Option<String>,
    pub refreshed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmTransactionHistoryEntry {
    pub hash: String,
    pub block_number: Option<u64>,
    pub status: String,
}

#[derive(Debug, Deserialize)]
struct EtherscanHistoryResponse {
    status: Option<String>,
    message: Option<String>,
    result: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvmTransferKind {
    Native,
    Erc20,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmPaymentPreviewRequest {
    pub chain: EvmChainConfig,
    pub wallet_address: String,
    pub recipient: String,
    pub amount_wei_or_units: String,
    pub token_contract: Option<String>,
    pub memo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmPaymentPreview {
    pub preview_id: String,
    pub chain: EvmChainConfig,
    pub wallet_address: String,
    pub recipient: String,
    pub token_contract: Option<String>,
    pub amount_wei_or_units: String,
    pub gas_limit: String,
    pub gas_price_wei: String,
    pub max_fee_per_gas_wei: Option<String>,
    pub max_priority_fee_per_gas_wei: Option<String>,
    pub fee_model: String,
    pub nonce: String,
    pub estimated_fee_wei: String,
    pub summary: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmPaymentSubmitRequest {
    pub preview_id: String,
    pub approved: bool,
    pub chain: EvmChainConfig,
    pub wallet_address: String,
    pub keystore_json: String,
    pub password: String,
    pub recipient: String,
    pub amount_wei_or_units: String,
    pub token_contract: Option<String>,
    pub gas_limit: Option<String>,
    pub gas_price_wei: Option<String>,
    pub max_fee_per_gas_wei: Option<String>,
    pub max_priority_fee_per_gas_wei: Option<String>,
    pub nonce: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmTransactionSubmitResult {
    pub transaction_hash: String,
    pub chain: EvmChainConfig,
    pub submitted_at: String,
    pub status: String,
    pub block_number: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmTransactionStatusRequest {
    pub chain: EvmChainConfig,
    pub transaction_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmTransactionStatus {
    pub transaction_hash: String,
    pub chain: EvmChainConfig,
    pub block_number: Option<u64>,
    pub status: String,
    pub gas_used: Option<String>,
    pub effective_gas_price_wei: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmDappSignPreviewRequest {
    pub chain: EvmChainConfig,
    pub wallet_address: String,
    pub app_name: String,
    pub app_url: String,
    pub method: String,
    pub payload_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmDappSignPreview {
    pub preview_id: String,
    pub chain: EvmChainConfig,
    pub wallet_address: String,
    pub app_name: String,
    pub app_url: String,
    pub method: String,
    pub summary: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmDappSignSubmitRequest {
    pub preview_id: String,
    pub approved: bool,
    pub chain: EvmChainConfig,
    pub wallet_address: String,
    pub app_name: String,
    pub app_url: String,
    pub keystore_json: String,
    pub password: String,
    pub method: String,
    pub payload_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmDappSignSubmitResult {
    pub signature: Option<String>,
    pub signed_transaction: Option<String>,
    pub transaction: Option<EvmTransactionSubmitResult>,
    pub status: String,
}

macro_rules! zeroize_fields_on_drop {
    ($type:ty, $($field:ident),+ $(,)?) => {
        impl Drop for $type {
            fn drop(&mut self) {
                $(self.$field.zeroize();)+
            }
        }
    };
}

zeroize_fields_on_drop!(EvmCreateWalletRequest, password);
zeroize_fields_on_drop!(EvmImportPrivateKeyRequest, private_key_hex, password);
zeroize_fields_on_drop!(EvmImportMnemonicRequest, mnemonic, password);
zeroize_fields_on_drop!(EvmImportKeystoreRequest, keystore_json, password);
zeroize_fields_on_drop!(EvmUnlockWalletRequest, keystore_json, password);
zeroize_fields_on_drop!(EvmExportPrivateKeyRequest, keystore_json, password);
zeroize_fields_on_drop!(EvmExportPrivateKeyResponse, private_key_hex);
zeroize_fields_on_drop!(EvmPaymentSubmitRequest, keystore_json, password);
zeroize_fields_on_drop!(EvmDappSignSubmitRequest, keystore_json, password);

#[derive(Debug, Deserialize, Serialize)]
struct EvmKeystore {
    version: u8,
    wallet_family: String,
    #[serde(default = "default_keystore_secret_type")]
    secret_type: String,
    address: String,
    derivation_path: Option<String>,
    crypto: EvmKeystoreCrypto,
    metadata: EvmKeystoreMetadata,
}

struct DecryptedEvmKeystore {
    signing_key: SigningKey,
    keystore: EvmKeystore,
}

#[derive(Debug, Deserialize, Serialize)]
struct EvmKeystoreCrypto {
    kdf: String,
    kdf_params: EvmKeystoreKdfParams,
    cipher: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct EvmKeystoreKdfParams {
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct EvmKeystoreMetadata {
    wallet_name: String,
}

fn default_keystore_secret_type() -> String {
    KEYSTORE_SECRET_PRIVATE_KEY.to_string()
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    message: String,
}

pub fn builtin_chains() -> Vec<EvmChainConfig> {
    vec![
        chain(
            1,
            "Ethereum",
            "ETH",
            "https://ethereum-rpc.publicnode.com",
            Some("https://etherscan.io"),
            false,
        ),
        chain(
            56,
            "BNB Smart Chain",
            "BNB",
            "https://bsc-dataseed.binance.org",
            Some("https://bscscan.com"),
            false,
        ),
        chain(
            137,
            "Polygon",
            "POL",
            "https://polygon-bor-rpc.publicnode.com",
            Some("https://polygonscan.com"),
            false,
        ),
        chain(
            42161,
            "Arbitrum One",
            "ETH",
            "https://arb1.arbitrum.io/rpc",
            Some("https://arbiscan.io"),
            false,
        ),
        chain(
            10,
            "Optimism",
            "ETH",
            "https://mainnet.optimism.io",
            Some("https://optimistic.etherscan.io"),
            false,
        ),
        chain(
            8453,
            "Base",
            "ETH",
            "https://mainnet.base.org",
            Some("https://basescan.org"),
            false,
        ),
        chain(
            43114,
            "Avalanche C-Chain",
            "AVAX",
            "https://api.avax.network/ext/bc/C/rpc",
            Some("https://snowtrace.io"),
            false,
        ),
        chain(
            250,
            "Fantom Opera",
            "FTM",
            "https://rpcapi.fantom.network",
            Some("https://ftmscan.com"),
            false,
        ),
        chain(
            59144,
            "Linea",
            "ETH",
            "https://rpc.linea.build",
            Some("https://lineascan.build"),
            false,
        ),
        chain(
            534352,
            "Scroll",
            "ETH",
            "https://rpc.scroll.io",
            Some("https://scrollscan.com"),
            false,
        ),
        chain(
            324,
            "zkSync Era",
            "ETH",
            "https://mainnet.era.zksync.io",
            Some("https://explorer.zksync.io"),
            false,
        ),
        chain(
            4663,
            "Robinhood Chain",
            "ETH",
            "https://rpc.mainnet.chain.robinhood.com",
            Some("https://robinscan.io"),
            false,
        ),
        chain(
            11155111,
            "Ethereum Sepolia",
            "ETH",
            "https://ethereum-sepolia-rpc.publicnode.com",
            Some("https://sepolia.etherscan.io"),
            true,
        ),
        chain(
            97,
            "BSC Testnet",
            "tBNB",
            "https://data-seed-prebsc-1-s1.binance.org:8545",
            Some("https://testnet.bscscan.com"),
            true,
        ),
        chain(
            80002,
            "Polygon Amoy",
            "POL",
            "https://rpc-amoy.polygon.technology",
            Some("https://amoy.polygonscan.com"),
            true,
        ),
        chain(
            84532,
            "Base Sepolia",
            "ETH",
            "https://sepolia.base.org",
            Some("https://sepolia.basescan.org"),
            true,
        ),
    ]
}

pub fn builtin_chain_adapters() -> ChainResult<Vec<EvmChainAdapter>> {
    builtin_chains()
        .into_iter()
        .map(EvmChainAdapter::new)
        .collect()
}

pub fn create_wallet(req: EvmCreateWalletRequest) -> EvmResult<EvmWalletKeystore> {
    let name = require_non_empty(&req.name, "wallet name")?;
    require_non_empty(&req.password, "wallet password")?;
    let signing_key = SigningKey::random(&mut OsRng);
    wallet_from_signing_key(name, signing_key, &req.password, None)
}

pub fn import_private_key(req: EvmImportPrivateKeyRequest) -> EvmResult<EvmWalletKeystore> {
    let name = require_non_empty(&req.name, "wallet name")?;
    require_non_empty(&req.password, "wallet password")?;
    let signing_key = signing_key_from_hex(&req.private_key_hex)?;
    wallet_from_signing_key(name, signing_key, &req.password, None)
}

pub fn import_mnemonic(req: EvmImportMnemonicRequest) -> EvmResult<EvmWalletKeystore> {
    let name = require_non_empty(&req.name, "wallet name")?;
    require_non_empty(&req.password, "wallet password")?;
    let mnemonic = Zeroizing::new(normalize_mnemonic_phrase(&req.mnemonic)?);
    let derivation_path = req
        .derivation_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_EVM_DERIVATION_PATH)
        .to_string();
    let signing_key = signing_key_from_mnemonic(&mnemonic, &derivation_path)?;
    let address = address_from_signing_key(&signing_key);
    let keystore_json = encrypt_keystore(
        &signing_key,
        mnemonic.as_bytes(),
        KEYSTORE_SECRET_MNEMONIC,
        &req.password,
        &name,
        Some(derivation_path.clone()),
    )?;
    Ok(EvmWalletKeystore {
        wallet: wallet_summary(name, address, Some(derivation_path)),
        keystore_json,
    })
}

pub fn address_from_mnemonic(mnemonic: &str, derivation_path: Option<&str>) -> EvmResult<String> {
    let mnemonic = Zeroizing::new(normalize_mnemonic_phrase(mnemonic)?);
    let derivation_path = derivation_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_EVM_DERIVATION_PATH);
    let signing_key = signing_key_from_mnemonic(&mnemonic, derivation_path)?;
    Ok(address_from_signing_key(&signing_key))
}

pub fn import_keystore(req: EvmImportKeystoreRequest) -> EvmResult<EvmWalletKeystore> {
    let name = require_non_empty(&req.name, "wallet name")?;
    let DecryptedEvmKeystore {
        signing_key,
        mut keystore,
    } = decrypt_keystore(&req.keystore_json, &req.password)?;
    keystore.metadata.wallet_name = name.clone();
    let address = address_from_signing_key(&signing_key);
    let keystore_json = serde_json::to_string(&keystore).map_err(|_| {
        EvmServiceError::InvalidInput("Failed to encode EVM keystore JSON".to_string())
    })?;
    Ok(EvmWalletKeystore {
        wallet: wallet_summary(name, address, keystore.derivation_path),
        keystore_json,
    })
}

pub fn unlock_wallet(req: EvmUnlockWalletRequest) -> EvmResult<EvmWalletSummary> {
    unlock_signing_key(&req).map(|(wallet, _)| wallet)
}

/// Unlocks an EVM keystore for trusted in-process callers.
///
/// The returned private key is zeroized on drop and must never cross an IPC or
/// serialization boundary.
pub fn unlock_private_key(
    req: EvmUnlockWalletRequest,
) -> EvmResult<(EvmWalletSummary, Zeroizing<Vec<u8>>)> {
    let (wallet, signing_key) = unlock_signing_key(&req)?;
    let private_key = Zeroizing::new(signing_key.to_bytes().to_vec());
    Ok((wallet, private_key))
}

fn unlock_signing_key(req: &EvmUnlockWalletRequest) -> EvmResult<(EvmWalletSummary, SigningKey)> {
    let DecryptedEvmKeystore {
        signing_key,
        keystore,
    } = decrypt_keystore(&req.keystore_json, &req.password)?;
    let address = address_from_signing_key(&signing_key);
    let wallet = wallet_summary(
        keystore.metadata.wallet_name,
        address,
        keystore.derivation_path,
    );
    Ok((wallet, signing_key))
}

pub fn export_private_key(
    req: EvmExportPrivateKeyRequest,
) -> EvmResult<EvmExportPrivateKeyResponse> {
    let signing_key = decrypt_keystore(&req.keystore_json, &req.password)?.signing_key;
    Ok(EvmExportPrivateKeyResponse {
        address: address_from_signing_key(&signing_key),
        private_key_hex: format!("0x{}", hex::encode(signing_key.to_bytes())),
    })
}

pub fn load_asset_snapshot(req: EvmAssetQueryRequest) -> EvmResult<EvmAssetSnapshot> {
    load_asset_snapshot_with_history(req, true)
}

pub fn load_asset_snapshot_without_history(
    req: EvmAssetQueryRequest,
) -> EvmResult<EvmAssetSnapshot> {
    load_asset_snapshot_with_history(req, false)
}

fn load_asset_snapshot_with_history(
    req: EvmAssetQueryRequest,
    include_history: bool,
) -> EvmResult<EvmAssetSnapshot> {
    validate_chain(&req.chain)?;
    validate_rpc_chain_id(&req.chain)?;
    let wallet_address = normalize_address(&req.wallet_address, "wallet address")?;
    let native_balance_wei = rpc_call(
        &req.chain.rpc_url,
        "eth_getBalance",
        serde_json::json!([wallet_address, "latest"]),
    )
    .and_then(rpc_hex_quantity_to_decimal)
    .map_err(|_| EvmServiceError::RpcUnavailable)?;

    let mut tokens = Vec::new();
    for query in req.tokens {
        tokens.push(load_token_asset(
            &req.chain,
            &wallet_address,
            &query.contract_address,
        )?);
    }

    let (recent_transactions, history_status, history_message) = if include_history {
        load_recent_transactions(&req.chain, &wallet_address)
    } else {
        (Vec::new(), "not_requested".to_string(), None)
    };

    Ok(EvmAssetSnapshot {
        chain: req.chain,
        wallet_address,
        native_balance_wei,
        tokens,
        recent_transactions,
        history_status,
        history_message,
        refreshed_at_ms: now_ms(),
    })
}

pub fn preview_payment(req: EvmPaymentPreviewRequest) -> EvmResult<EvmPaymentPreview> {
    validate_chain(&req.chain)?;
    validate_rpc_chain_id(&req.chain)?;
    let wallet_address = normalize_address(&req.wallet_address, "wallet address")?;
    let recipient = normalize_address(&req.recipient, "recipient")?;
    let amount = normalize_decimal(&req.amount_wei_or_units, "amount")?;
    let token_contract = req
        .token_contract
        .as_deref()
        .map(|value| normalize_address(value, "token contract"))
        .transpose()?;

    let data = token_contract
        .as_deref()
        .map(|_| erc20_transfer_calldata(&recipient, &amount))
        .transpose()?
        .unwrap_or_default();
    let to = token_contract.clone().unwrap_or_else(|| recipient.clone());
    let value = if token_contract.is_some() {
        "0"
    } else {
        amount.as_str()
    };
    let nonce = rpc_call(
        &req.chain.rpc_url,
        "eth_getTransactionCount",
        serde_json::json!([wallet_address, "pending"]),
    )
    .and_then(rpc_hex_quantity_to_decimal)
    .map_err(|_| EvmServiceError::RpcUnavailable)?;
    let fee_quote = load_fee_quote(&req.chain)?;
    let gas_limit = estimate_gas(&req.chain, &wallet_address, &to, value, &data)?;
    let estimated_fee_wei = decimal_mul(&fee_quote.max_fee_per_gas_wei(), &gas_limit)?;

    let preview_id = payment_preview_id(&PaymentPreviewIdInput {
        chain: &req.chain,
        wallet_address: &wallet_address,
        recipient: &recipient,
        token_contract: token_contract.as_deref(),
        amount_wei_or_units: &amount,
        gas_limit: &gas_limit,
        gas_price_wei: &fee_quote.gas_price_wei,
        max_fee_per_gas_wei: fee_quote.max_fee_per_gas_wei.as_deref(),
        max_priority_fee_per_gas_wei: fee_quote.max_priority_fee_per_gas_wei.as_deref(),
        nonce: &nonce,
    });

    Ok(EvmPaymentPreview {
        preview_id,
        chain: req.chain,
        wallet_address,
        recipient,
        token_contract,
        amount_wei_or_units: amount,
        gas_limit,
        gas_price_wei: fee_quote.gas_price_wei.clone(),
        max_fee_per_gas_wei: fee_quote.max_fee_per_gas_wei,
        max_priority_fee_per_gas_wei: fee_quote.max_priority_fee_per_gas_wei,
        fee_model: fee_quote.fee_model,
        nonce,
        estimated_fee_wei,
        summary: "Prepare EVM transfer".to_string(),
        warnings: vec![
            "Review chain id, recipient, token, gas, and dApp origin before signing.".to_string(),
        ],
    })
}

pub fn submit_payment(req: EvmPaymentSubmitRequest) -> EvmResult<EvmTransactionSubmitResult> {
    submit_payment_with_key_loader(&req, || {
        decrypt_keystore(&req.keystore_json, &req.password).map(|decrypted| decrypted.signing_key)
    })
}

pub fn submit_payment_with_private_key(
    req: EvmPaymentSubmitRequest,
    private_key: &[u8],
) -> EvmResult<EvmTransactionSubmitResult> {
    submit_payment_with_key_loader(&req, || signing_key_from_bytes(private_key))
}

pub fn submit_payment_with_private_key_loader<F>(
    req: EvmPaymentSubmitRequest,
    load_private_key: F,
) -> EvmResult<EvmTransactionSubmitResult>
where
    F: FnOnce() -> Result<Zeroizing<Vec<u8>>, String>,
{
    submit_payment_with_key_loader(&req, || {
        let private_key = load_private_key().map_err(EvmServiceError::InvalidInput)?;
        signing_key_from_bytes(private_key.as_slice())
    })
}

fn submit_payment_with_key_loader<F>(
    req: &EvmPaymentSubmitRequest,
    load_signing_key: F,
) -> EvmResult<EvmTransactionSubmitResult>
where
    F: FnOnce() -> EvmResult<SigningKey>,
{
    require_non_empty(&req.preview_id, "preview id")?;
    if !req.approved {
        return Err(EvmServiceError::UserRejected);
    }
    validate_chain(&req.chain)?;
    let wallet_address = normalize_address(&req.wallet_address, "wallet address")?;
    let recipient = normalize_address(&req.recipient, "recipient")?;
    let amount = normalize_decimal(&req.amount_wei_or_units, "amount")?;
    let token_contract = req
        .token_contract
        .as_deref()
        .map(|value| normalize_address(value, "token contract"))
        .transpose()?;
    let data = token_contract
        .as_deref()
        .map(|_| erc20_transfer_calldata(&recipient, &amount))
        .transpose()?
        .unwrap_or_default();
    let to = token_contract.clone().unwrap_or_else(|| recipient.clone());
    let value = if data.is_empty() {
        amount.as_str()
    } else {
        "0"
    };
    let nonce = required_decimal_option(req.nonce.as_deref(), "nonce")?;
    let gas_limit = required_decimal_option(req.gas_limit.as_deref(), "gas limit")?;
    let gas_price_wei = required_decimal_option(req.gas_price_wei.as_deref(), "gas price")?;
    let max_fee_per_gas_wei = req
        .max_fee_per_gas_wei
        .as_deref()
        .map(|value| normalize_decimal(value, "max fee per gas"))
        .transpose()?;
    let max_priority_fee_per_gas_wei = req
        .max_priority_fee_per_gas_wei
        .as_deref()
        .map(|value| normalize_decimal(value, "max priority fee per gas"))
        .transpose()?;
    if max_fee_per_gas_wei.is_some() != max_priority_fee_per_gas_wei.is_some() {
        return Err(EvmServiceError::InvalidInput(
            "EIP-1559 fee fields must be submitted together".to_string(),
        ));
    }
    let expected_preview_id = payment_preview_id(&PaymentPreviewIdInput {
        chain: &req.chain,
        wallet_address: &wallet_address,
        recipient: &recipient,
        token_contract: token_contract.as_deref(),
        amount_wei_or_units: &amount,
        gas_limit: &gas_limit,
        gas_price_wei: &gas_price_wei,
        max_fee_per_gas_wei: max_fee_per_gas_wei.as_deref(),
        max_priority_fee_per_gas_wei: max_priority_fee_per_gas_wei.as_deref(),
        nonce: &nonce,
    });
    if req.preview_id != expected_preview_id {
        return Err(EvmServiceError::InvalidInput(
            "EVM payment preview is stale or mismatched".to_string(),
        ));
    }
    let signing_key = load_signing_key()?;
    let from = address_from_signing_key(&signing_key);
    if !address_eq(&from, &wallet_address) {
        return Err(EvmServiceError::InvalidInput(
            "EVM signing key does not match preview wallet address".to_string(),
        ));
    }
    let raw_tx = sign_evm_transaction(&EvmTxSigningInput {
        signing_key: &signing_key,
        chain_id: req.chain.chain_id,
        nonce: &nonce,
        gas_limit: &gas_limit,
        to: &to,
        value,
        data: &data,
        gas_price_wei: &gas_price_wei,
        max_fee_per_gas_wei: max_fee_per_gas_wei.as_deref(),
        max_priority_fee_per_gas_wei: max_priority_fee_per_gas_wei.as_deref(),
    })?;
    let tx_hash = send_raw_transaction(&req.chain, &raw_tx)?;

    Ok(EvmTransactionSubmitResult {
        transaction_hash: tx_hash,
        chain: req.chain.clone(),
        submitted_at: submitted_at(),
        status: format!("submitted from {from}"),
        block_number: None,
    })
}

pub fn preview_dapp_signing(req: EvmDappSignPreviewRequest) -> EvmResult<EvmDappSignPreview> {
    validate_chain(&req.chain)?;
    let wallet_address = normalize_address(&req.wallet_address, "wallet address")?;
    let app_name = require_non_empty(&req.app_name, "dApp name")?;
    let app_url = require_non_empty(&req.app_url, "dApp URL")?;
    let method = require_non_empty(&req.method, "dApp method")?;
    let payload_json = require_non_empty(&req.payload_json, "dApp payload")?;
    let preview_id = dapp_sign_preview_id(&DappSignPreviewIdInput {
        chain: &req.chain,
        wallet_address: &wallet_address,
        app_name: &app_name,
        app_url: &app_url,
        method: &method,
        payload_json: &payload_json,
    });
    Ok(EvmDappSignPreview {
        preview_id,
        chain: req.chain,
        wallet_address,
        app_name,
        app_url: app_url.clone(),
        method: method.clone(),
        summary: format!("{app_url} requested {method}"),
        warnings: vec!["Only approve EVM dApp requests from sites you trust.".to_string()],
    })
}

pub fn submit_dapp_signing(req: EvmDappSignSubmitRequest) -> EvmResult<EvmDappSignSubmitResult> {
    submit_dapp_signing_with_key_loader(&req, || {
        decrypt_keystore(&req.keystore_json, &req.password).map(|decrypted| decrypted.signing_key)
    })
}

pub fn submit_dapp_signing_with_private_key(
    req: EvmDappSignSubmitRequest,
    private_key: &[u8],
) -> EvmResult<EvmDappSignSubmitResult> {
    submit_dapp_signing_with_key_loader(&req, || signing_key_from_bytes(private_key))
}

pub fn submit_dapp_signing_with_private_key_loader<F>(
    req: EvmDappSignSubmitRequest,
    load_private_key: F,
) -> EvmResult<EvmDappSignSubmitResult>
where
    F: FnOnce() -> Result<Zeroizing<Vec<u8>>, String>,
{
    submit_dapp_signing_with_key_loader(&req, || {
        let private_key = load_private_key().map_err(EvmServiceError::InvalidInput)?;
        signing_key_from_bytes(private_key.as_slice())
    })
}

fn submit_dapp_signing_with_key_loader<F>(
    req: &EvmDappSignSubmitRequest,
    load_signing_key: F,
) -> EvmResult<EvmDappSignSubmitResult>
where
    F: FnOnce() -> EvmResult<SigningKey>,
{
    require_non_empty(&req.preview_id, "preview id")?;
    if !req.approved {
        return Err(EvmServiceError::UserRejected);
    }
    validate_chain(&req.chain)?;
    let wallet_address = normalize_address(&req.wallet_address, "wallet address")?;
    let app_name = require_non_empty(&req.app_name, "dApp name")?;
    let app_url = require_non_empty(&req.app_url, "dApp URL")?;
    let method = require_non_empty(&req.method, "dApp method")?;
    let payload_json = require_non_empty(&req.payload_json, "dApp payload")?;
    let expected_preview_id = dapp_sign_preview_id(&DappSignPreviewIdInput {
        chain: &req.chain,
        wallet_address: &wallet_address,
        app_name: &app_name,
        app_url: &app_url,
        method: &method,
        payload_json: &payload_json,
    });
    if req.preview_id != expected_preview_id {
        return Err(EvmServiceError::InvalidInput(
            "EVM dApp preview is stale or mismatched".to_string(),
        ));
    }
    let signing_key = load_signing_key()?;
    let signing_address = address_from_signing_key(&signing_key);
    if !address_eq(&signing_address, &wallet_address) {
        return Err(EvmServiceError::InvalidInput(
            "EVM signing key does not match preview wallet address".to_string(),
        ));
    }
    match method.as_str() {
        "personal_sign" | "eth_sign" => {
            let message = evm_message_from_payload(&payload_json, &wallet_address)?;
            Ok(EvmDappSignSubmitResult {
                signature: Some(sign_personal_message(&signing_key, &message)?),
                signed_transaction: None,
                transaction: None,
                status: "signed".to_string(),
            })
        }
        "eth_signTypedData" | "eth_signTypedData_v4" => {
            let digest = typed_data_digest(&payload_json)?;
            Ok(EvmDappSignSubmitResult {
                signature: Some(sign_hash(&signing_key, &digest)?),
                signed_transaction: None,
                transaction: None,
                status: "signed".to_string(),
            })
        }
        "eth_sendTransaction" | "eth_signTransaction" => {
            let from = address_from_signing_key(&signing_key);
            let tx = parse_dapp_transaction(&req.chain, &from, &payload_json)?;
            let raw_tx = sign_evm_transaction(&EvmTxSigningInput {
                signing_key: &signing_key,
                chain_id: req.chain.chain_id,
                nonce: &tx.nonce,
                gas_limit: &tx.gas_limit,
                to: &tx.to,
                value: &tx.value,
                data: &tx.data,
                gas_price_wei: &tx.gas_price_wei,
                max_fee_per_gas_wei: tx.max_fee_per_gas_wei.as_deref(),
                max_priority_fee_per_gas_wei: tx.max_priority_fee_per_gas_wei.as_deref(),
            })?;
            if method == "eth_signTransaction" {
                return Ok(EvmDappSignSubmitResult {
                    signature: None,
                    signed_transaction: Some(raw_tx),
                    transaction: None,
                    status: "signed".to_string(),
                });
            }
            let tx_hash = send_raw_transaction(&req.chain, &raw_tx)?;
            Ok(EvmDappSignSubmitResult {
                signature: Some(tx_hash.clone()),
                signed_transaction: None,
                transaction: Some(EvmTransactionSubmitResult {
                    transaction_hash: tx_hash,
                    chain: req.chain.clone(),
                    submitted_at: submitted_at(),
                    status: "submitted".to_string(),
                    block_number: None,
                }),
                status: "submitted".to_string(),
            })
        }
        _ => Err(EvmServiceError::InvalidInput(
            "Unsupported EVM dApp signing method".to_string(),
        )),
    }
}

pub fn transaction_status(req: EvmTransactionStatusRequest) -> EvmResult<EvmTransactionStatus> {
    validate_chain(&req.chain)?;
    validate_rpc_chain_id(&req.chain)?;
    let transaction_hash = normalize_tx_hash(&req.transaction_hash)?;
    let receipt = rpc_call(
        &req.chain.rpc_url,
        "eth_getTransactionReceipt",
        serde_json::json!([transaction_hash]),
    )?;
    if receipt.is_null() {
        return Ok(EvmTransactionStatus {
            transaction_hash,
            chain: req.chain,
            block_number: None,
            status: "pending".to_string(),
            gas_used: None,
            effective_gas_price_wei: None,
        });
    }
    let block_number = receipt
        .get("blockNumber")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| hex_quantity_to_u64(value).ok());
    let status = match receipt.get("status").and_then(serde_json::Value::as_str) {
        Some("0x1") => "confirmed",
        Some("0x0") => "failed",
        _ => "unknown",
    }
    .to_string();
    let gas_used = receipt
        .get("gasUsed")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| hex_quantity_to_decimal(value).ok());
    let effective_gas_price_wei = receipt
        .get("effectiveGasPrice")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| hex_quantity_to_decimal(value).ok());

    Ok(EvmTransactionStatus {
        transaction_hash,
        chain: req.chain,
        block_number,
        status,
        gas_used,
        effective_gas_price_wei,
    })
}

pub fn erc20_transfer_calldata(recipient: &str, amount_units: &str) -> EvmResult<String> {
    let recipient = normalize_address(recipient, "recipient")?;
    let amount = decimal_to_32_bytes(amount_units)?;
    let mut bytes = Vec::with_capacity(68);
    bytes.extend_from_slice(&ERC20_TRANSFER_SELECTOR);
    bytes.extend_from_slice(&[0u8; 12]);
    bytes.extend_from_slice(&address_bytes(&recipient)?);
    bytes.extend_from_slice(&amount);
    Ok(format!("0x{}", hex::encode(bytes)))
}

pub fn sign_personal_message(signing_key: &SigningKey, message: &[u8]) -> EvmResult<String> {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut hasher = Keccak256::new();
    hasher.update(prefix.as_bytes());
    hasher.update(message);
    let digest = hasher.finalize();
    sign_hash(signing_key, digest.as_slice())
}

fn chain(
    chain_id: u64,
    name: &str,
    native_symbol: &str,
    rpc_url: &str,
    explorer_url: Option<&str>,
    testnet: bool,
) -> EvmChainConfig {
    EvmChainConfig {
        chain_id,
        name: name.to_string(),
        native_symbol: native_symbol.to_string(),
        rpc_url: rpc_url.to_string(),
        explorer_url: explorer_url.map(str::to_string),
        testnet,
    }
}

fn require_non_empty(value: &str, field: &'static str) -> EvmResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(EvmServiceError::InvalidInput(format!(
            "{field} is required"
        )));
    }
    Ok(trimmed.to_string())
}

fn required_decimal_option(value: Option<&str>, field: &'static str) -> EvmResult<String> {
    let value = value.ok_or_else(|| {
        EvmServiceError::InvalidInput(format!("{field} is required from the approved preview"))
    })?;
    normalize_decimal(value, field)
}

fn validate_chain(chain: &EvmChainConfig) -> EvmResult<()> {
    if chain.chain_id == 0 {
        return Err(EvmServiceError::InvalidChainId);
    }
    validate_chain_label(&chain.name, "chain name", 128)?;
    validate_chain_label(&chain.native_symbol, "native symbol", 32)?;
    let rpc_url = require_non_empty(&chain.rpc_url, "RPC URL")?;
    if rpc_url.len() > 2_048 {
        return Err(EvmServiceError::InvalidInput(
            "EVM RPC URL must not exceed 2048 bytes".to_string(),
        ));
    }
    let parsed = reqwest::Url::parse(&rpc_url).map_err(|_| {
        EvmServiceError::InvalidInput("EVM RPC URL must be a valid HTTP(S) URL".to_string())
    })?;
    let host = parsed.host_str().ok_or_else(|| {
        EvmServiceError::InvalidInput("EVM RPC URL must include a host".to_string())
    })?;
    let local_http = parsed.scheme() == "http" && is_loopback_host(host);
    if rpc_url != chain.rpc_url
        || (parsed.scheme() != "https" && !local_http)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(EvmServiceError::InvalidInput(
            "EVM RPC URL must use HTTPS (or loopback HTTP) without whitespace, credentials, or a fragment".to_string(),
        ));
    }
    if let Some(explorer_url) = chain.explorer_url.as_deref() {
        validate_explorer_origin(explorer_url)?;
    }
    Ok(())
}

fn validate_chain_label(value: &str, field: &'static str, max_bytes: usize) -> EvmResult<()> {
    let trimmed = require_non_empty(value, field)?;
    if trimmed != value || value.len() > max_bytes {
        return Err(EvmServiceError::InvalidInput(format!(
            "{field} must not contain surrounding whitespace or exceed {max_bytes} bytes"
        )));
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || std::net::IpAddr::from_str(host.trim_matches(['[', ']']))
            .is_ok_and(|address| address.is_loopback())
}

fn validate_explorer_origin(explorer_url: &str) -> EvmResult<()> {
    if explorer_url.is_empty() || explorer_url.len() > 2_048 || explorer_url.trim() != explorer_url
    {
        return Err(EvmServiceError::InvalidInput(
            "EVM explorer URL must be a bounded HTTPS origin".to_string(),
        ));
    }
    let parsed = reqwest::Url::parse(explorer_url).map_err(|_| {
        EvmServiceError::InvalidInput("EVM explorer URL must be a valid HTTPS origin".to_string())
    })?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(EvmServiceError::InvalidInput(
            "EVM explorer URL must be an HTTPS origin without credentials, path, query, or fragment"
                .to_string(),
        ));
    }
    Ok(())
}

fn validate_evm_adapter_path(path_text: &str) -> ChainResult<()> {
    validate_derivation_path_input(path_text)?;
    let path = bip32::DerivationPath::from_str(path_text)
        .map_err(|error| ChainError::InvalidDerivationPath(error.to_string()))?;
    let components = path.as_ref();
    let valid = components.len() == 5
        && components[0].is_hardened()
        && components[0].index() == 44
        && components[1].is_hardened()
        && components[1].index() == 60
        && components[2].is_hardened()
        && !components[3].is_hardened()
        && matches!(components[3].index(), 0 | 1)
        && !components[4].is_hardened();
    if !valid {
        return Err(ChainError::InvalidDerivationPath(
            "expected EVM BIP44 path m/44'/60'/account'/change/index".to_string(),
        ));
    }
    Ok(())
}

fn wallet_from_signing_key(
    name: String,
    signing_key: SigningKey,
    password: &str,
    derivation_path: Option<String>,
) -> EvmResult<EvmWalletKeystore> {
    let address = address_from_signing_key(&signing_key);
    let private_key = signing_key.to_bytes();
    let keystore_json = encrypt_keystore(
        &signing_key,
        private_key.as_slice(),
        KEYSTORE_SECRET_PRIVATE_KEY,
        password,
        &name,
        derivation_path.clone(),
    )?;
    Ok(EvmWalletKeystore {
        wallet: wallet_summary(name, address, derivation_path),
        keystore_json,
    })
}

fn wallet_summary(
    name: String,
    address: String,
    derivation_path: Option<String>,
) -> EvmWalletSummary {
    EvmWalletSummary {
        id: format!(
            "evm-{}",
            address.trim_start_matches("0x").to_ascii_lowercase()
        ),
        name,
        address,
        derivation_path,
    }
}

fn normalize_mnemonic_phrase(phrase: &str) -> EvmResult<String> {
    validate_mnemonic_input(phrase).map_err(|_| {
        EvmServiceError::InvalidInput("Mnemonic must contain at most 1024 bytes".to_string())
    })?;
    let normalized = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Err(EvmServiceError::InvalidInput(
            "Mnemonic is required".to_string(),
        ));
    }
    Mnemonic::parse_in_normalized(Language::English, &normalized).map_err(|_| {
        EvmServiceError::InvalidInput(
            "Mnemonic checksum failed; check the words and order".to_string(),
        )
    })?;
    Ok(normalized)
}

fn signing_key_from_mnemonic(mnemonic: &str, derivation_path: &str) -> EvmResult<SigningKey> {
    validate_derivation_path_input(derivation_path).map_err(|_| {
        EvmServiceError::InvalidInput(
            "Derivation path must contain between 1 and 256 bytes".to_string(),
        )
    })?;
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, mnemonic)
        .map_err(|_| EvmServiceError::InvalidInput("Mnemonic checksum failed".to_string()))?;
    let path = bip32::DerivationPath::from_str(derivation_path).map_err(|error| {
        EvmServiceError::InvalidInput(format!("Invalid derivation path: {error}"))
    })?;
    let seed = Zeroizing::new(mnemonic.to_seed(""));
    let xprv = bip32::XPrv::derive_from_path(seed.as_slice(), &path).map_err(|error| {
        EvmServiceError::InvalidInput(format!("Failed to derive EVM key: {error}"))
    })?;
    let bytes = xprv.private_key().to_bytes();
    SigningKey::from_slice(bytes.as_slice())
        .map_err(|_| EvmServiceError::InvalidInput("Derived EVM key is invalid".to_string()))
}

fn signing_key_from_hex(private_key_hex: &str) -> EvmResult<SigningKey> {
    let normalized = private_key_hex.trim().trim_start_matches("0x");
    if normalized.len() != 64 {
        return Err(EvmServiceError::InvalidInput(
            "EVM private key must be 32 bytes hex".to_string(),
        ));
    }
    let mut bytes =
        Zeroizing::new(hex::decode(normalized).map_err(|_| {
            EvmServiceError::InvalidInput("Private key must be valid hex".to_string())
        })?);
    let signing_key = SigningKey::from_slice(bytes.as_slice())
        .map_err(|_| EvmServiceError::InvalidInput("EVM private key is invalid".to_string()))?;
    bytes.zeroize();
    Ok(signing_key)
}

fn signing_key_from_bytes(private_key: &[u8]) -> EvmResult<SigningKey> {
    SigningKey::from_slice(private_key)
        .map_err(|_| EvmServiceError::InvalidInput("EVM private key bytes are invalid".to_string()))
}

fn address_from_signing_key(signing_key: &SigningKey) -> String {
    let verifying_key = signing_key.verifying_key();
    let encoded = verifying_key.to_encoded_point(false);
    let public_key = encoded.as_bytes();
    let hash = keccak256(&public_key[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
}

fn normalize_address(address: &str, field: &'static str) -> EvmResult<String> {
    let normalized = address.trim();
    let hex_part = normalized.strip_prefix("0x").unwrap_or(normalized);
    if hex_part.len() != 40 || !hex_part.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(EvmServiceError::InvalidInput(format!(
            "{field} must be a 20-byte EVM address"
        )));
    }
    let has_lowercase = hex_part.bytes().any(|byte| byte.is_ascii_lowercase());
    let has_uppercase = hex_part.bytes().any(|byte| byte.is_ascii_uppercase());
    if has_lowercase && has_uppercase && !has_valid_eip55_checksum(hex_part) {
        return Err(EvmServiceError::InvalidInput(format!(
            "{field} has an invalid EIP-55 checksum"
        )));
    }
    Ok(format!("0x{}", hex_part.to_ascii_lowercase()))
}

fn has_valid_eip55_checksum(address: &str) -> bool {
    let lowercase = address.to_ascii_lowercase();
    let hash = hex::encode(keccak256(lowercase.as_bytes()));
    address
        .bytes()
        .zip(hash.bytes())
        .all(|(address_byte, hash_byte)| {
            !address_byte.is_ascii_alphabetic()
                || address_byte.is_ascii_uppercase() == (hash_byte >= b'8')
        })
}

fn address_eq(left: &str, right: &str) -> bool {
    matches!(
        (
            normalize_address(left, "address"),
            normalize_address(right, "address")
        ),
        (Ok(left), Ok(right)) if left == right
    )
}

fn address_bytes(address: &str) -> EvmResult<[u8; 20]> {
    let address = normalize_address(address, "address")?;
    let bytes = hex::decode(address.trim_start_matches("0x"))
        .map_err(|_| EvmServiceError::InvalidInput("Address must be valid hex".to_string()))?;
    bytes
        .try_into()
        .map_err(|_| EvmServiceError::InvalidInput("Address must be 20 bytes".to_string()))
}

fn encrypt_keystore(
    signing_key: &SigningKey,
    secret: &[u8],
    secret_type: &str,
    password: &str,
    wallet_name: &str,
    derivation_path: Option<String>,
) -> EvmResult<String> {
    require_non_empty(password, "wallet password")?;
    let address = address_from_signing_key(signing_key);
    let mut salt = [0u8; KEYSTORE_SALT_BYTES];
    let mut rng = AeadOsRng;
    aes_gcm::aead::rand_core::RngCore::fill_bytes(&mut rng, &mut salt);
    let nonce = Aes256Gcm::generate_nonce(&mut rng);
    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_slice()).map_err(|_| {
        EvmServiceError::InvalidInput("AES-256-GCM initialization failed".to_string())
    })?;
    let aad = keystore_aad_v2(&address, secret_type, derivation_path.as_deref());
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: secret,
                aad: &aad,
            },
        )
        .map_err(|_| EvmServiceError::InvalidInput("EVM keystore encryption failed".to_string()))?;
    serde_json::to_string(&EvmKeystore {
        version: KEYSTORE_VERSION,
        wallet_family: "evm".to_string(),
        secret_type: secret_type.to_string(),
        address,
        derivation_path,
        crypto: EvmKeystoreCrypto {
            kdf: KEYSTORE_KDF.to_string(),
            kdf_params: EvmKeystoreKdfParams {
                memory_kib: ARGON2_MEMORY_KIB,
                iterations: ARGON2_ITERATIONS,
                parallelism: ARGON2_PARALLELISM,
                salt: BASE64.encode(salt),
            },
            cipher: KEYSTORE_CIPHER.to_string(),
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        },
        metadata: EvmKeystoreMetadata {
            wallet_name: wallet_name.to_string(),
        },
    })
    .map_err(|_| EvmServiceError::InvalidInput("Failed to encode EVM keystore JSON".to_string()))
}

fn decrypt_keystore(keystore_json: &str, password: &str) -> EvmResult<DecryptedEvmKeystore> {
    if keystore_json.len() > MAX_KEYSTORE_JSON_BYTES {
        return Err(EvmServiceError::InvalidInput(
            "EVM keystore JSON is too large".to_string(),
        ));
    }
    require_non_empty(keystore_json, "keystore json")?;
    require_non_empty(password, "wallet password")?;
    let document: serde_json::Value = serde_json::from_str(keystore_json)
        .map_err(|_| EvmServiceError::InvalidInput("Invalid EVM keystore JSON".to_string()))?;
    let has_explicit_secret_type = document
        .get("secret_type")
        .and_then(serde_json::Value::as_str)
        .is_some();
    let keystore: EvmKeystore = serde_json::from_value(document)
        .map_err(|_| EvmServiceError::InvalidInput("Invalid EVM keystore JSON".to_string()))?;
    if !matches!(keystore.version, LEGACY_KEYSTORE_VERSION | KEYSTORE_VERSION)
        || keystore.wallet_family != "evm"
    {
        return Err(EvmServiceError::InvalidInput(
            "Unsupported EVM keystore version".to_string(),
        ));
    }
    if keystore.version == KEYSTORE_VERSION && !has_explicit_secret_type {
        return Err(EvmServiceError::InvalidInput(
            "EVM v2 keystore is missing secret_type".to_string(),
        ));
    }
    if keystore.version == LEGACY_KEYSTORE_VERSION
        && keystore.secret_type != KEYSTORE_SECRET_PRIVATE_KEY
    {
        return Err(EvmServiceError::InvalidInput(
            "Legacy EVM keystore must contain a private key".to_string(),
        ));
    }
    if keystore.secret_type != KEYSTORE_SECRET_PRIVATE_KEY
        && keystore.secret_type != KEYSTORE_SECRET_MNEMONIC
    {
        return Err(EvmServiceError::InvalidInput(
            "Unsupported EVM keystore secret type".to_string(),
        ));
    }
    if keystore.crypto.kdf != KEYSTORE_KDF || keystore.crypto.cipher != KEYSTORE_CIPHER {
        return Err(EvmServiceError::InvalidInput(
            "Unsupported EVM keystore crypto".to_string(),
        ));
    }
    if keystore.crypto.kdf_params.memory_kib != ARGON2_MEMORY_KIB
        || keystore.crypto.kdf_params.iterations != ARGON2_ITERATIONS
        || keystore.crypto.kdf_params.parallelism != ARGON2_PARALLELISM
    {
        return Err(EvmServiceError::InvalidInput(
            "Unsupported EVM keystore KDF parameters".to_string(),
        ));
    }
    let salt: [u8; KEYSTORE_SALT_BYTES] = BASE64
        .decode(keystore.crypto.kdf_params.salt.as_bytes())
        .map_err(|_| EvmServiceError::InvalidInput("Keystore salt is invalid".to_string()))?
        .try_into()
        .map_err(|_| {
            EvmServiceError::InvalidInput("Keystore salt length is invalid".to_string())
        })?;
    let nonce_bytes: [u8; KEYSTORE_NONCE_BYTES] = BASE64
        .decode(keystore.crypto.nonce.as_bytes())
        .map_err(|_| EvmServiceError::InvalidInput("Keystore nonce is invalid".to_string()))?
        .try_into()
        .map_err(|_| {
            EvmServiceError::InvalidInput("Keystore nonce length is invalid".to_string())
        })?;
    let ciphertext = BASE64
        .decode(keystore.crypto.ciphertext.as_bytes())
        .map_err(|_| EvmServiceError::InvalidInput("Keystore ciphertext is invalid".to_string()))?;
    if ciphertext.len() <= KEYSTORE_TAG_BYTES
        || ciphertext.len() > MAX_KEYSTORE_SECRET_BYTES + KEYSTORE_TAG_BYTES
    {
        return Err(EvmServiceError::InvalidInput(
            "Keystore ciphertext length is invalid".to_string(),
        ));
    }
    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_slice()).map_err(|_| {
        EvmServiceError::InvalidInput("AES-256-GCM initialization failed".to_string())
    })?;
    let aad = if keystore.version == LEGACY_KEYSTORE_VERSION {
        keystore_aad_v1(&keystore.address)
    } else {
        keystore_aad_v2(
            &keystore.address,
            &keystore.secret_type,
            keystore.derivation_path.as_deref(),
        )
    };
    let nonce = aes_gcm::Nonce::from(nonce_bytes);
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| EvmServiceError::WrongPassword)?,
    );
    let signing_key = if keystore.secret_type == KEYSTORE_SECRET_PRIVATE_KEY {
        if plaintext.len() != PRIVATE_KEY_BYTES {
            return Err(EvmServiceError::WrongPassword);
        }
        SigningKey::from_slice(plaintext.as_slice()).map_err(|_| EvmServiceError::WrongPassword)?
    } else {
        let mnemonic = std::str::from_utf8(plaintext.as_slice()).map_err(|_| {
            EvmServiceError::InvalidInput("Decrypted mnemonic is not valid UTF-8".to_string())
        })?;
        let derivation_path = keystore.derivation_path.as_deref().ok_or_else(|| {
            EvmServiceError::InvalidInput(
                "Mnemonic keystore is missing its derivation path".to_string(),
            )
        })?;
        signing_key_from_mnemonic(mnemonic, derivation_path)?
    };
    let derived_address = address_from_signing_key(&signing_key);
    if !address_eq(&derived_address, &keystore.address) {
        return Err(EvmServiceError::InvalidInput(
            "Keystore address does not match decrypted secret".to_string(),
        ));
    }
    Ok(DecryptedEvmKeystore {
        signing_key,
        keystore,
    })
}

fn derive_key(password: &str, salt: &[u8; KEYSTORE_SALT_BYTES]) -> EvmResult<Zeroizing<[u8; 32]>> {
    if password.len() > MAX_KEYSTORE_PASSWORD_BYTES {
        return Err(EvmServiceError::InvalidInput(
            "EVM keystore password is too long".to_string(),
        ));
    }
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(32),
    )
    .map_err(|_| EvmServiceError::InvalidInput("Invalid Argon2id parameters".to_string()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Argon2Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| EvmServiceError::InvalidInput("Argon2id key derivation failed".to_string()))?;
    Ok(key)
}

fn keystore_aad_v1(address: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(KEYSTORE_AAD_DOMAIN.len() + address.len() + 2);
    aad.extend_from_slice(KEYSTORE_AAD_DOMAIN);
    aad.push(0);
    aad.extend_from_slice(address.as_bytes());
    aad
}

fn keystore_aad_v2(address: &str, secret_type: &str, derivation_path: Option<&str>) -> Vec<u8> {
    let derivation_path = derivation_path.unwrap_or_default();
    let mut aad = Vec::with_capacity(
        KEYSTORE_AAD_DOMAIN.len() + address.len() + secret_type.len() + derivation_path.len() + 8,
    );
    aad.extend_from_slice(KEYSTORE_AAD_DOMAIN);
    aad.push(0);
    aad.push(KEYSTORE_VERSION);
    aad.push(0);
    aad.extend_from_slice(b"evm");
    aad.push(0);
    aad.extend_from_slice(address.as_bytes());
    aad.push(0);
    aad.extend_from_slice(secret_type.as_bytes());
    aad.push(0);
    aad.extend_from_slice(derivation_path.as_bytes());
    aad
}

fn rpc_call(
    rpc_url: &str,
    method: &str,
    params: serde_json::Value,
) -> EvmResult<serde_json::Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(JSON_RPC_TIMEOUT_SECS))
        .build()
        .map_err(|_| EvmServiceError::RpcUnavailable)?;
    let response = client
        .post(rpc_url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }))
        .send()
        .map_err(|_| EvmServiceError::RpcUnavailable)?;
    let rpc: JsonRpcResponse = response
        .json()
        .map_err(|_| EvmServiceError::RpcUnavailable)?;
    if let Some(error) = rpc.error {
        let lower = error.message.to_ascii_lowercase();
        if lower.contains("insufficient") || lower.contains("fund") {
            return Err(EvmServiceError::InsufficientFunds);
        }
        if lower.contains("gas") {
            return Err(EvmServiceError::GasEstimateFailed);
        }
        return Err(EvmServiceError::RpcUnavailable);
    }
    rpc.result.ok_or(EvmServiceError::RpcUnavailable)
}

pub fn validate_rpc_chain_id(chain: &EvmChainConfig) -> EvmResult<()> {
    validate_chain(chain)?;
    let reported = rpc_call(&chain.rpc_url, "eth_chainId", serde_json::json!([]))?;
    validate_reported_chain_id(chain.chain_id, &reported)
}

fn validate_reported_chain_id(expected: u64, reported: &serde_json::Value) -> EvmResult<()> {
    let reported = reported
        .as_str()
        .ok_or(EvmServiceError::InvalidChainId)
        .and_then(hex_quantity_to_u64)?;
    if reported != expected {
        return Err(EvmServiceError::InvalidChainId);
    }
    Ok(())
}

fn load_recent_transactions(
    chain: &EvmChainConfig,
    wallet_address: &str,
) -> (Vec<EvmTransactionHistoryEntry>, String, Option<String>) {
    if chain.explorer_url.is_none() {
        return (
            Vec::new(),
            "unsupported".to_string(),
            Some("No EVM explorer API is configured for this chain".to_string()),
        );
    }

    match load_etherscan_compatible_history(chain, wallet_address) {
        Ok(entries) => (entries, "ok".to_string(), None),
        Err(EvmServiceError::HistoryUnavailable) => (
            Vec::new(),
            "unsupported".to_string(),
            Some("The configured explorer does not expose account history".to_string()),
        ),
        Err(_) => (
            Vec::new(),
            "unavailable".to_string(),
            Some("EVM transaction history is temporarily unavailable".to_string()),
        ),
    }
}

fn load_etherscan_compatible_history(
    chain: &EvmChainConfig,
    wallet_address: &str,
) -> EvmResult<Vec<EvmTransactionHistoryEntry>> {
    let api_key = etherscan_api_key().ok_or(EvmServiceError::HistoryUnavailable)?;
    let api_url = etherscan_compatible_api_url(chain, wallet_address, &api_key)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(JSON_RPC_TIMEOUT_SECS))
        .build()
        .map_err(|_| EvmServiceError::RpcUnavailable)?;
    let response = client
        .get(api_url)
        .send()
        .map_err(|_| EvmServiceError::RpcUnavailable)?;
    if !response.status().is_success() {
        return Err(EvmServiceError::RpcUnavailable);
    }
    let body = read_etherscan_response(response)?;
    parse_etherscan_history_response(&body)
}

fn read_etherscan_response(reader: impl Read) -> EvmResult<String> {
    let mut body = Vec::new();
    reader
        .take((MAX_ETHERSCAN_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|_| EvmServiceError::RpcUnavailable)?;
    if body.len() > MAX_ETHERSCAN_RESPONSE_BYTES {
        return Err(EvmServiceError::RpcUnavailable);
    }
    String::from_utf8(body).map_err(|_| EvmServiceError::RpcUnavailable)
}

fn etherscan_compatible_api_url(
    chain: &EvmChainConfig,
    wallet_address: &str,
    api_key: &str,
) -> EvmResult<String> {
    let wallet_address = normalize_address(wallet_address, "wallet address")?;
    let explorer_url = chain
        .explorer_url
        .as_deref()
        .ok_or(EvmServiceError::HistoryUnavailable)?;
    if etherscan_chain_id(explorer_url) != Some(chain.chain_id) || !valid_etherscan_api_key(api_key)
    {
        return Err(EvmServiceError::HistoryUnavailable);
    }
    let mut url = reqwest::Url::parse("https://api.etherscan.io/v2/api")
        .map_err(|_| EvmServiceError::HistoryUnavailable)?;
    url.query_pairs_mut()
        .append_pair("chainid", &chain.chain_id.to_string())
        .append_pair("module", "account")
        .append_pair("action", "txlist")
        .append_pair("address", &wallet_address)
        .append_pair("page", "1")
        .append_pair("offset", "10")
        .append_pair("sort", "desc")
        .append_pair("apikey", api_key);
    Ok(url.into())
}

fn etherscan_chain_id(explorer_url: &str) -> Option<u64> {
    validate_explorer_origin(explorer_url).ok()?;
    let url = reqwest::Url::parse(explorer_url.trim()).ok()?;
    match url.host_str()? {
        "etherscan.io" => Some(1),
        "sepolia.etherscan.io" => Some(11_155_111),
        "optimistic.etherscan.io" => Some(10),
        "bscscan.com" => Some(56),
        "testnet.bscscan.com" => Some(97),
        "polygonscan.com" => Some(137),
        "amoy.polygonscan.com" => Some(80_002),
        "arbiscan.io" => Some(42_161),
        "basescan.org" => Some(8_453),
        "sepolia.basescan.org" => Some(84_532),
        "snowtrace.io" => Some(43_114),
        "ftmscan.com" => Some(250),
        "lineascan.build" => Some(59_144),
        "scrollscan.com" => Some(534_352),
        _ => None,
    }
}

fn etherscan_api_key() -> Option<Zeroizing<String>> {
    std::env::var(ETHERSCAN_API_KEY_ENV)
        .ok()
        .filter(|value| valid_etherscan_api_key(value))
        .map(Zeroizing::new)
}

fn valid_etherscan_api_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn etherscan_history_available(chain: &EvmChainConfig, api_key: Option<&str>) -> bool {
    chain
        .explorer_url
        .as_deref()
        .is_some_and(|explorer| etherscan_chain_id(explorer) == Some(chain.chain_id))
        && api_key.is_some_and(valid_etherscan_api_key)
}

fn parse_etherscan_history_response(body: &str) -> EvmResult<Vec<EvmTransactionHistoryEntry>> {
    let response: EtherscanHistoryResponse =
        serde_json::from_str(body).map_err(|_| EvmServiceError::RpcUnavailable)?;
    if matches!(response.result, serde_json::Value::String(_)) {
        let message = response
            .message
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if response.status.as_deref() == Some("0")
            && (message.contains("no transactions") || message.contains("ok"))
        {
            return Ok(Vec::new());
        }
        return Err(EvmServiceError::HistoryUnavailable);
    }
    if response.status.as_deref() != Some("1") {
        return Err(EvmServiceError::HistoryUnavailable);
    }
    let items = response
        .result
        .as_array()
        .ok_or(EvmServiceError::HistoryUnavailable)?;
    items.iter().map(etherscan_history_entry).take(10).collect()
}

fn etherscan_history_entry(value: &serde_json::Value) -> EvmResult<EvmTransactionHistoryEntry> {
    let hash = value
        .get("hash")
        .and_then(serde_json::Value::as_str)
        .ok_or(EvmServiceError::HistoryUnavailable)
        .and_then(normalize_tx_hash)
        .map_err(|_| EvmServiceError::HistoryUnavailable)?;
    let block_number = value
        .get("blockNumber")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.parse::<u64>().ok());
    let status = value
        .get("txreceipt_status")
        .or_else(|| value.get("status"))
        .and_then(serde_json::Value::as_str)
        .map(|value| match value {
            "1" => "confirmed",
            "0" => "failed",
            other => other,
        })
        .unwrap_or("unknown")
        .to_string();

    Ok(EvmTransactionHistoryEntry {
        hash,
        block_number,
        status,
    })
}

fn estimate_gas(
    chain: &EvmChainConfig,
    from: &str,
    to: &str,
    value_decimal: &str,
    data: &str,
) -> EvmResult<String> {
    let value = decimal_to_hex_quantity(value_decimal)?;
    let data = if data.is_empty() { "0x" } else { data };
    rpc_call(
        &chain.rpc_url,
        "eth_estimateGas",
        serde_json::json!([{
            "from": from,
            "to": to,
            "value": value,
            "data": data,
        }]),
    )
    .and_then(rpc_hex_quantity_to_decimal)
    .map_err(|error| match error {
        EvmServiceError::InsufficientFunds => EvmServiceError::InsufficientFunds,
        _ => EvmServiceError::GasEstimateFailed,
    })
}

fn load_token_asset(
    chain: &EvmChainConfig,
    wallet_address: &str,
    token_contract: &str,
) -> EvmResult<EvmTokenAsset> {
    let contract_address = normalize_address(token_contract, "token contract")?;
    let balance_data = erc20_balance_of_calldata(wallet_address)?;
    let balance = eth_call(chain, &contract_address, &balance_data)
        .and_then(|value| hex_word_to_decimal(&value))
        .unwrap_or_else(|_| "0".to_string());
    let decimals = eth_call(
        chain,
        &contract_address,
        &selector_data(ERC20_DECIMALS_SELECTOR),
    )
    .and_then(|value| hex_word_to_u8(&value))
    .unwrap_or(18);
    let symbol = eth_call(
        chain,
        &contract_address,
        &selector_data(ERC20_SYMBOL_SELECTOR),
    )
    .and_then(|value| decode_erc20_string(&value))
    .unwrap_or_else(|_| "ERC20".to_string());
    let name = eth_call(
        chain,
        &contract_address,
        &selector_data(ERC20_NAME_SELECTOR),
    )
    .and_then(|value| decode_erc20_string(&value))
    .unwrap_or_else(|_| format!("Token {}", short_address(&contract_address)));

    Ok(EvmTokenAsset {
        contract_address,
        symbol,
        name,
        balance,
        decimals,
    })
}

fn eth_call(chain: &EvmChainConfig, to: &str, data: &str) -> EvmResult<String> {
    rpc_call(
        &chain.rpc_url,
        "eth_call",
        serde_json::json!([{"to": to, "data": data}, "latest"]),
    )
    .and_then(|value| {
        value
            .as_str()
            .map(str::to_string)
            .ok_or(EvmServiceError::RpcUnavailable)
    })
}

fn rpc_hex_quantity_to_decimal(value: serde_json::Value) -> EvmResult<String> {
    let quantity = value.as_str().ok_or(EvmServiceError::RpcUnavailable)?;
    hex_quantity_to_decimal(quantity)
}

fn selector_data(selector: [u8; 4]) -> String {
    format!("0x{}", hex::encode(selector))
}

fn erc20_balance_of_calldata(wallet_address: &str) -> EvmResult<String> {
    let mut bytes = Vec::with_capacity(36);
    bytes.extend_from_slice(&ERC20_BALANCE_OF_SELECTOR);
    bytes.extend_from_slice(&[0u8; 12]);
    bytes.extend_from_slice(&address_bytes(wallet_address)?);
    Ok(format!("0x{}", hex::encode(bytes)))
}

#[derive(Debug, Clone)]
struct EvmFeeQuote {
    fee_model: String,
    gas_price_wei: String,
    max_fee_per_gas_wei: Option<String>,
    max_priority_fee_per_gas_wei: Option<String>,
}

impl EvmFeeQuote {
    fn max_fee_per_gas_wei(&self) -> String {
        self.max_fee_per_gas_wei
            .clone()
            .unwrap_or_else(|| self.gas_price_wei.clone())
    }
}

#[derive(Debug, Clone)]
struct DappTransactionRequest {
    to: String,
    value: String,
    data: String,
    gas_limit: String,
    gas_price_wei: String,
    max_fee_per_gas_wei: Option<String>,
    max_priority_fee_per_gas_wei: Option<String>,
    nonce: String,
}

struct EvmTxSigningInput<'a> {
    signing_key: &'a SigningKey,
    chain_id: u64,
    nonce: &'a str,
    gas_limit: &'a str,
    to: &'a str,
    value: &'a str,
    data: &'a str,
    gas_price_wei: &'a str,
    max_fee_per_gas_wei: Option<&'a str>,
    max_priority_fee_per_gas_wei: Option<&'a str>,
}

struct PaymentPreviewIdInput<'a> {
    chain: &'a EvmChainConfig,
    wallet_address: &'a str,
    recipient: &'a str,
    token_contract: Option<&'a str>,
    amount_wei_or_units: &'a str,
    gas_limit: &'a str,
    gas_price_wei: &'a str,
    max_fee_per_gas_wei: Option<&'a str>,
    max_priority_fee_per_gas_wei: Option<&'a str>,
    nonce: &'a str,
}

struct DappSignPreviewIdInput<'a> {
    chain: &'a EvmChainConfig,
    wallet_address: &'a str,
    app_name: &'a str,
    app_url: &'a str,
    method: &'a str,
    payload_json: &'a str,
}

struct LegacyTxSigningInput<'a> {
    signing_key: &'a SigningKey,
    chain_id: u64,
    nonce: &'a str,
    gas_price_wei: &'a str,
    gas_limit: &'a str,
    to: &'a str,
    value: &'a str,
    data: &'a str,
}

fn payment_preview_id(input: &PaymentPreviewIdInput<'_>) -> String {
    let material = serde_json::json!({
        "scope": "fnzero-safe-evm-payment-preview-v1",
        "chain_id": input.chain.chain_id,
        "rpc_url": input.chain.rpc_url,
        "wallet_address": input.wallet_address,
        "recipient": input.recipient,
        "token_contract": input.token_contract,
        "amount_wei_or_units": input.amount_wei_or_units,
        "gas_limit": input.gas_limit,
        "gas_price_wei": input.gas_price_wei,
        "max_fee_per_gas_wei": input.max_fee_per_gas_wei,
        "max_priority_fee_per_gas_wei": input.max_priority_fee_per_gas_wei,
        "nonce": input.nonce,
    });
    format!(
        "evm-payment:{}",
        hex::encode(keccak256(material.to_string().as_bytes()))
    )
}

fn dapp_sign_preview_id(input: &DappSignPreviewIdInput<'_>) -> String {
    let material = serde_json::json!({
        "scope": "fnzero-safe-evm-dapp-preview-v1",
        "chain_id": input.chain.chain_id,
        "rpc_url": input.chain.rpc_url,
        "wallet_address": input.wallet_address,
        "app_name": input.app_name,
        "app_url": input.app_url,
        "method": input.method,
        "payload_json": input.payload_json,
    });
    format!(
        "evm-dapp:{}",
        hex::encode(keccak256(material.to_string().as_bytes()))
    )
}

fn load_nonce(chain: &EvmChainConfig, wallet_address: &str) -> EvmResult<String> {
    rpc_call(
        &chain.rpc_url,
        "eth_getTransactionCount",
        serde_json::json!([wallet_address, "pending"]),
    )
    .and_then(rpc_hex_quantity_to_decimal)
    .map_err(|_| EvmServiceError::RpcUnavailable)
}

fn load_fee_quote(chain: &EvmChainConfig) -> EvmResult<EvmFeeQuote> {
    let gas_price_wei = rpc_call(&chain.rpc_url, "eth_gasPrice", serde_json::json!([]))
        .and_then(rpc_hex_quantity_to_decimal)
        .map_err(|_| EvmServiceError::RpcUnavailable)?;
    let latest_block = rpc_call(
        &chain.rpc_url,
        "eth_getBlockByNumber",
        serde_json::json!(["latest", false]),
    )
    .ok();
    let base_fee_wei = latest_block
        .as_ref()
        .and_then(|value| value.get("baseFeePerGas"))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| hex_quantity_to_decimal(value).ok());
    let Some(base_fee_wei) = base_fee_wei else {
        return Ok(EvmFeeQuote {
            fee_model: "legacy".to_string(),
            gas_price_wei,
            max_fee_per_gas_wei: None,
            max_priority_fee_per_gas_wei: None,
        });
    };

    let priority_fee_wei = rpc_call(
        &chain.rpc_url,
        "eth_maxPriorityFeePerGas",
        serde_json::json!([]),
    )
    .and_then(rpc_hex_quantity_to_decimal)
    .unwrap_or_else(|_| DEFAULT_PRIORITY_FEE_WEI.to_string());
    let doubled_base_fee = decimal_mul_u64(&base_fee_wei, 2)?;
    let mut max_fee_per_gas_wei = decimal_add(&doubled_base_fee, &priority_fee_wei)?;
    if decimal_cmp(&max_fee_per_gas_wei, &gas_price_wei)? == std::cmp::Ordering::Less {
        max_fee_per_gas_wei = gas_price_wei.clone();
    }

    Ok(EvmFeeQuote {
        fee_model: "eip1559".to_string(),
        gas_price_wei,
        max_fee_per_gas_wei: Some(max_fee_per_gas_wei),
        max_priority_fee_per_gas_wei: Some(priority_fee_wei),
    })
}

fn send_raw_transaction(chain: &EvmChainConfig, raw_tx: &str) -> EvmResult<String> {
    validate_rpc_chain_id(chain)?;
    rpc_call(
        &chain.rpc_url,
        "eth_sendRawTransaction",
        serde_json::json!([raw_tx]),
    )
    .and_then(|value| {
        value
            .as_str()
            .map(str::to_string)
            .ok_or(EvmServiceError::RpcUnavailable)
    })
}

fn sign_evm_transaction(input: &EvmTxSigningInput<'_>) -> EvmResult<String> {
    match (
        input.max_fee_per_gas_wei,
        input.max_priority_fee_per_gas_wei,
    ) {
        (Some(max_fee_per_gas_wei), Some(max_priority_fee_per_gas_wei)) => {
            sign_type2_transaction(&Type2TxSigningInput {
                signing_key: input.signing_key,
                chain_id: input.chain_id,
                nonce: input.nonce,
                max_priority_fee_per_gas_wei,
                max_fee_per_gas_wei,
                gas_limit: input.gas_limit,
                to: input.to,
                value: input.value,
                data: input.data,
            })
        }
        _ => sign_legacy_transaction(&LegacyTxSigningInput {
            signing_key: input.signing_key,
            chain_id: input.chain_id,
            nonce: input.nonce,
            gas_price_wei: input.gas_price_wei,
            gas_limit: input.gas_limit,
            to: input.to,
            value: input.value,
            data: input.data,
        }),
    }
}

fn sign_legacy_transaction(input: &LegacyTxSigningInput<'_>) -> EvmResult<String> {
    let signing_key = input.signing_key;
    let chain_id = input.chain_id;
    let nonce = input.nonce;
    let gas_price_wei = input.gas_price_wei;
    let gas_limit = input.gas_limit;
    let to = input.to;
    let value = input.value;
    let data = input.data;
    if chain_id == 0 {
        return Err(EvmServiceError::InvalidChainId);
    }
    let to = address_bytes(to)?;
    let data = hex_data_to_bytes(data)?;
    let unsigned_items = vec![
        rlp_bytes(&decimal_to_be_bytes(nonce)?),
        rlp_bytes(&decimal_to_be_bytes(gas_price_wei)?),
        rlp_bytes(&decimal_to_be_bytes(gas_limit)?),
        rlp_bytes(&to),
        rlp_bytes(&decimal_to_be_bytes(value)?),
        rlp_bytes(&data),
        rlp_bytes(&u64_to_be_bytes(chain_id)),
        rlp_bytes(&[]),
        rlp_bytes(&[]),
    ];
    let signing_payload = rlp_list(&unsigned_items);
    let digest = keccak256(&signing_payload);
    let (signature, recovery_id) = sign_digest(signing_key, &digest)?;
    let v = u128::from(chain_id)
        .checked_mul(2)
        .and_then(|value| value.checked_add(35 + u128::from(recovery_id.to_byte())))
        .ok_or(EvmServiceError::InvalidChainId)?;
    let sig_bytes = signature.to_bytes();
    let r = trim_leading_zeroes(&sig_bytes[..32]);
    let s = trim_leading_zeroes(&sig_bytes[32..]);
    let signed_items = vec![
        rlp_bytes(&decimal_to_be_bytes(nonce)?),
        rlp_bytes(&decimal_to_be_bytes(gas_price_wei)?),
        rlp_bytes(&decimal_to_be_bytes(gas_limit)?),
        rlp_bytes(&to),
        rlp_bytes(&decimal_to_be_bytes(value)?),
        rlp_bytes(&data),
        rlp_bytes(&u128_to_be_bytes(v)),
        rlp_bytes(r),
        rlp_bytes(s),
    ];
    Ok(format!("0x{}", hex::encode(rlp_list(&signed_items))))
}

struct Type2TxSigningInput<'a> {
    signing_key: &'a SigningKey,
    chain_id: u64,
    nonce: &'a str,
    max_priority_fee_per_gas_wei: &'a str,
    max_fee_per_gas_wei: &'a str,
    gas_limit: &'a str,
    to: &'a str,
    value: &'a str,
    data: &'a str,
}

fn sign_type2_transaction(input: &Type2TxSigningInput<'_>) -> EvmResult<String> {
    if input.chain_id == 0 {
        return Err(EvmServiceError::InvalidChainId);
    }
    let to = address_bytes(input.to)?;
    let data = hex_data_to_bytes(input.data)?;
    let access_list = rlp_list(&[]);
    let unsigned_items = vec![
        rlp_bytes(&u64_to_be_bytes(input.chain_id)),
        rlp_bytes(&decimal_to_be_bytes(input.nonce)?),
        rlp_bytes(&decimal_to_be_bytes(input.max_priority_fee_per_gas_wei)?),
        rlp_bytes(&decimal_to_be_bytes(input.max_fee_per_gas_wei)?),
        rlp_bytes(&decimal_to_be_bytes(input.gas_limit)?),
        rlp_bytes(&to),
        rlp_bytes(&decimal_to_be_bytes(input.value)?),
        rlp_bytes(&data),
        access_list.clone(),
    ];
    let unsigned_payload = rlp_list(&unsigned_items);
    let mut signing_payload = Vec::with_capacity(1 + unsigned_payload.len());
    signing_payload.push(0x02);
    signing_payload.extend_from_slice(&unsigned_payload);
    let digest = keccak256(&signing_payload);
    let (signature, recovery_id) = sign_digest(input.signing_key, &digest)?;
    let sig_bytes = signature.to_bytes();
    let signed_items = vec![
        rlp_bytes(&u64_to_be_bytes(input.chain_id)),
        rlp_bytes(&decimal_to_be_bytes(input.nonce)?),
        rlp_bytes(&decimal_to_be_bytes(input.max_priority_fee_per_gas_wei)?),
        rlp_bytes(&decimal_to_be_bytes(input.max_fee_per_gas_wei)?),
        rlp_bytes(&decimal_to_be_bytes(input.gas_limit)?),
        rlp_bytes(&to),
        rlp_bytes(&decimal_to_be_bytes(input.value)?),
        rlp_bytes(&data),
        access_list,
        rlp_bytes(&[recovery_id.to_byte()]),
        rlp_bytes(trim_leading_zeroes(&sig_bytes[..32])),
        rlp_bytes(trim_leading_zeroes(&sig_bytes[32..])),
    ];
    let mut raw = Vec::new();
    raw.push(0x02);
    raw.extend_from_slice(&rlp_list(&signed_items));
    Ok(format!("0x{}", hex::encode(raw)))
}

fn sign_hash(signing_key: &SigningKey, digest: &[u8]) -> EvmResult<String> {
    let (signature, recovery_id) = sign_digest(signing_key, digest)?;
    let mut bytes = Vec::with_capacity(65);
    bytes.extend_from_slice(signature.to_bytes().as_slice());
    bytes.push(recovery_id.to_byte() + 27);
    Ok(format!("0x{}", hex::encode(bytes)))
}

fn sign_digest(signing_key: &SigningKey, digest: &[u8]) -> EvmResult<(Signature, RecoveryId)> {
    if digest.len() != 32 {
        return Err(EvmServiceError::InvalidInput(
            "Signing digest must be 32 bytes".to_string(),
        ));
    }
    signing_key
        .sign_prehash_recoverable(digest)
        .map_err(|_| EvmServiceError::InvalidInput("EVM signing failed".to_string()))
}

fn evm_message_from_payload(payload_json: &str, wallet_address: &str) -> EvmResult<Vec<u8>> {
    let value: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|_| EvmServiceError::InvalidInput("EVM dApp payload must be JSON".to_string()))?;
    if let Some(message) = value.get("message").and_then(serde_json::Value::as_str) {
        return evm_message_bytes(message);
    }
    if let Some(params) = value.get("params").and_then(serde_json::Value::as_array) {
        for item in params {
            if let Some(message) = item.as_str() {
                if normalize_address(message, "signing account").is_ok() {
                    if !address_eq(message, wallet_address) {
                        return Err(EvmServiceError::InvalidInput(
                            "EVM signing account does not match the selected wallet".to_string(),
                        ));
                    }
                    continue;
                }
                return evm_message_bytes(message);
            }
        }
    }
    Err(EvmServiceError::InvalidInput(
        "EVM message payload must include a message string".to_string(),
    ))
}

fn evm_message_bytes(value: &str) -> EvmResult<Vec<u8>> {
    let bytes = if let Some(hex_value) = value.strip_prefix("0x") {
        if hex_value.len() % 2 != 0 {
            return Err(EvmServiceError::InvalidInput(
                "EVM message hex must contain complete bytes".to_string(),
            ));
        }
        hex::decode(hex_value).map_err(|_| {
            EvmServiceError::InvalidInput("EVM message contains invalid hex".to_string())
        })?
    } else {
        value.as_bytes().to_vec()
    };
    if bytes.is_empty() || bytes.len() > 16 * 1024 {
        return Err(EvmServiceError::InvalidInput(
            "EVM message must contain between 1 and 16384 bytes".to_string(),
        ));
    }
    Ok(bytes)
}

fn parse_dapp_transaction(
    chain: &EvmChainConfig,
    signer_address: &str,
    payload_json: &str,
) -> EvmResult<DappTransactionRequest> {
    let value: serde_json::Value = serde_json::from_str(payload_json)
        .map_err(|_| EvmServiceError::InvalidInput("EVM dApp payload must be JSON".to_string()))?;
    let tx = extract_dapp_transaction_value(&value)?;
    let from = tx
        .get("from")
        .and_then(serde_json::Value::as_str)
        .map(|value| normalize_address(value, "transaction from"))
        .transpose()?;
    if let Some(from) = from {
        if !address_eq(&from, signer_address) {
            return Err(EvmServiceError::InvalidInput(
                "Transaction from does not match the selected EVM wallet".to_string(),
            ));
        }
    }
    let to = tx
        .get("to")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| EvmServiceError::InvalidInput("EVM transaction to is required".to_string()))
        .and_then(|value| normalize_address(value, "transaction to"))?;
    let value = evm_quantity_field(tx.get("value"), "transaction value")?
        .unwrap_or_else(|| "0".to_string());
    let data = evm_data_field(
        tx.get("data")
            .or_else(|| tx.get("input"))
            .and_then(serde_json::Value::as_str),
    )?;
    let gas_limit = match tx
        .get("gas")
        .or_else(|| tx.get("gasLimit"))
        .and_then(serde_json::Value::as_str)
    {
        Some(value) => evm_quantity_to_decimal(value, "gas limit")?,
        None => estimate_gas(chain, signer_address, &to, &value, &data)?,
    };
    let nonce = match tx.get("nonce").and_then(serde_json::Value::as_str) {
        Some(value) => evm_quantity_to_decimal(value, "nonce")?,
        None => load_nonce(chain, signer_address)?,
    };
    let provided_gas_price_wei = tx
        .get("gasPrice")
        .and_then(serde_json::Value::as_str)
        .map(|value| evm_quantity_to_decimal(value, "gas price"))
        .transpose()?;
    let provided_max_fee_per_gas_wei = tx
        .get("maxFeePerGas")
        .and_then(serde_json::Value::as_str)
        .map(|value| evm_quantity_to_decimal(value, "max fee per gas"))
        .transpose()?;
    let provided_max_priority_fee_per_gas_wei = tx
        .get("maxPriorityFeePerGas")
        .and_then(serde_json::Value::as_str)
        .map(|value| evm_quantity_to_decimal(value, "max priority fee per gas"))
        .transpose()?;
    let fee_quote = if provided_gas_price_wei.is_none()
        && (provided_max_fee_per_gas_wei.is_none()
            || provided_max_priority_fee_per_gas_wei.is_none())
    {
        Some(load_fee_quote(chain)?)
    } else {
        None
    };
    let gas_price_wei = provided_gas_price_wei
        .or_else(|| fee_quote.as_ref().map(|quote| quote.gas_price_wei.clone()))
        .unwrap_or_else(|| "0".to_string());
    let max_fee_per_gas_wei = provided_max_fee_per_gas_wei.or_else(|| {
        fee_quote
            .as_ref()
            .and_then(|quote| quote.max_fee_per_gas_wei.clone())
    });
    let max_priority_fee_per_gas_wei = provided_max_priority_fee_per_gas_wei.or_else(|| {
        fee_quote
            .as_ref()
            .and_then(|quote| quote.max_priority_fee_per_gas_wei.clone())
    });

    Ok(DappTransactionRequest {
        to,
        value,
        data,
        gas_limit,
        gas_price_wei,
        max_fee_per_gas_wei,
        max_priority_fee_per_gas_wei,
        nonce,
    })
}

fn extract_dapp_transaction_value(
    value: &serde_json::Value,
) -> EvmResult<&serde_json::Map<String, serde_json::Value>> {
    if let Some(params) = value.get("params") {
        if let Some(items) = params.as_array() {
            if let Some(first) = items.first().and_then(serde_json::Value::as_object) {
                return Ok(first);
            }
        }
        if let Some(object) = params.as_object() {
            if let Some(tx) = object
                .get("transaction")
                .or_else(|| object.get("tx"))
                .and_then(serde_json::Value::as_object)
            {
                return Ok(tx);
            }
            if object.contains_key("to")
                || object.contains_key("data")
                || object.contains_key("value")
            {
                return Ok(object);
            }
        }
    }
    if let Some(tx) = value
        .get("transaction")
        .or_else(|| value.get("tx"))
        .and_then(serde_json::Value::as_object)
    {
        return Ok(tx);
    }
    value
        .as_object()
        .filter(|object| object.contains_key("to"))
        .ok_or_else(|| {
            EvmServiceError::InvalidInput(
                "EVM dApp transaction payload is missing a transaction object".to_string(),
            )
        })
}

fn evm_quantity_field(
    value: Option<&serde_json::Value>,
    field: &'static str,
) -> EvmResult<Option<String>> {
    match value {
        Some(serde_json::Value::String(value)) => evm_quantity_to_decimal(value, field).map(Some),
        Some(serde_json::Value::Number(value)) => {
            evm_quantity_to_decimal(&value.to_string(), field).map(Some)
        }
        Some(_) => Err(EvmServiceError::InvalidInput(format!(
            "{field} must be a hex or decimal quantity"
        ))),
        None => Ok(None),
    }
}

fn evm_quantity_to_decimal(value: &str, field: &'static str) -> EvmResult<String> {
    let value = require_non_empty(value, field)?;
    if value.starts_with("0x") {
        return hex_quantity_to_decimal(&value);
    }
    normalize_decimal(&value, field)
}

fn evm_data_field(value: Option<&str>) -> EvmResult<String> {
    let data = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("0x");
    hex_data_to_bytes(data)?;
    Ok(data.to_string())
}

fn typed_data_digest(payload_json: &str) -> EvmResult<[u8; 32]> {
    let value: serde_json::Value =
        serde_json::from_str(payload_json).map_err(|_| EvmServiceError::InvalidTypedData)?;
    let typed_data = extract_typed_data(&value)?;
    let domain_separator = hash_typed_struct("EIP712Domain", typed_data.domain(), &typed_data)?;
    let primary_type = typed_data.primary_type()?;
    let message_hash = hash_typed_struct(primary_type, typed_data.message(), &typed_data)?;
    let mut payload = Vec::with_capacity(66);
    payload.extend_from_slice(b"\x19\x01");
    payload.extend_from_slice(&domain_separator);
    payload.extend_from_slice(&message_hash);
    Ok(keccak256(&payload))
}

struct TypedData {
    value: serde_json::Value,
}

impl TypedData {
    fn types(&self) -> EvmResult<&serde_json::Map<String, serde_json::Value>> {
        self.value
            .get("types")
            .and_then(serde_json::Value::as_object)
            .ok_or(EvmServiceError::InvalidTypedData)
    }

    fn primary_type(&self) -> EvmResult<&str> {
        self.value
            .get("primaryType")
            .and_then(serde_json::Value::as_str)
            .ok_or(EvmServiceError::InvalidTypedData)
    }

    fn domain(&self) -> &serde_json::Value {
        self.value.get("domain").unwrap_or(&serde_json::Value::Null)
    }

    fn message(&self) -> &serde_json::Value {
        self.value
            .get("message")
            .unwrap_or(&serde_json::Value::Null)
    }

    fn fields(&self, type_name: &str) -> EvmResult<Vec<TypedField>> {
        let fields = self
            .types()?
            .get(type_name)
            .and_then(serde_json::Value::as_array)
            .ok_or(EvmServiceError::InvalidTypedData)?;
        fields
            .iter()
            .map(|field| {
                let field = field.as_object().ok_or(EvmServiceError::InvalidTypedData)?;
                let name = field
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(EvmServiceError::InvalidTypedData)?;
                let ty = field
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(EvmServiceError::InvalidTypedData)?;
                Ok(TypedField {
                    name: name.to_string(),
                    ty: ty.to_string(),
                })
            })
            .collect()
    }

    fn has_type(&self, type_name: &str) -> bool {
        self.types()
            .ok()
            .is_some_and(|types| types.contains_key(type_name))
    }
}

#[derive(Debug, Clone)]
struct TypedField {
    name: String,
    ty: String,
}

fn extract_typed_data(value: &serde_json::Value) -> EvmResult<TypedData> {
    if value.get("types").is_some() && value.get("primaryType").is_some() {
        return Ok(TypedData {
            value: value.clone(),
        });
    }
    if let Some(params) = value.get("params").and_then(serde_json::Value::as_array) {
        for item in params.iter().rev() {
            if item.get("types").is_some() && item.get("primaryType").is_some() {
                return Ok(TypedData {
                    value: item.clone(),
                });
            }
            if let Some(raw) = item.as_str() {
                let parsed: serde_json::Value =
                    serde_json::from_str(raw).map_err(|_| EvmServiceError::InvalidTypedData)?;
                if parsed.get("types").is_some() && parsed.get("primaryType").is_some() {
                    return Ok(TypedData { value: parsed });
                }
            }
        }
    }
    if let Some(raw) = value.get("typedData").and_then(serde_json::Value::as_str) {
        let parsed: serde_json::Value =
            serde_json::from_str(raw).map_err(|_| EvmServiceError::InvalidTypedData)?;
        return Ok(TypedData { value: parsed });
    }
    if let Some(typed_data) = value.get("typedData") {
        return Ok(TypedData {
            value: typed_data.clone(),
        });
    }
    Err(EvmServiceError::InvalidTypedData)
}

fn hash_typed_struct(
    type_name: &str,
    data: &serde_json::Value,
    typed_data: &TypedData,
) -> EvmResult<[u8; 32]> {
    let mut encoded = Vec::with_capacity(32);
    encoded.extend_from_slice(&keccak256(encode_type(type_name, typed_data)?.as_bytes()));
    let object = data.as_object();
    for field in typed_data.fields(type_name)? {
        let value = object.and_then(|object| object.get(&field.name));
        encoded.extend_from_slice(&encode_typed_value(&field.ty, value, typed_data)?);
    }
    Ok(keccak256(&encoded))
}

fn encode_type(type_name: &str, typed_data: &TypedData) -> EvmResult<String> {
    let mut deps = Vec::new();
    collect_type_dependencies(type_name, typed_data, &mut deps)?;
    deps.retain(|dep| dep != type_name);
    deps.sort();
    deps.dedup();
    let mut ordered = vec![type_name.to_string()];
    ordered.extend(deps);
    ordered
        .into_iter()
        .map(|name| {
            let fields = typed_data.fields(&name)?;
            let args = fields
                .into_iter()
                .map(|field| format!("{} {}", field.ty, field.name))
                .collect::<Vec<_>>()
                .join(",");
            Ok(format!("{name}({args})"))
        })
        .collect::<EvmResult<Vec<_>>>()
        .map(|parts| parts.join(""))
}

fn collect_type_dependencies(
    type_name: &str,
    typed_data: &TypedData,
    deps: &mut Vec<String>,
) -> EvmResult<()> {
    if deps.iter().any(|dep| dep == type_name) {
        return Ok(());
    }
    if !typed_data.has_type(type_name) {
        return Ok(());
    }
    deps.push(type_name.to_string());
    for field in typed_data.fields(type_name)? {
        let base_type = eip712_base_type(&field.ty);
        if typed_data.has_type(&base_type) {
            collect_type_dependencies(&base_type, typed_data, deps)?;
        }
    }
    Ok(())
}

fn encode_typed_value(
    ty: &str,
    value: Option<&serde_json::Value>,
    typed_data: &TypedData,
) -> EvmResult<[u8; 32]> {
    if ty.ends_with(']') {
        let item_type = ty
            .split_once('[')
            .map(|(item, _)| item)
            .ok_or(EvmServiceError::InvalidTypedData)?;
        let values = value
            .and_then(serde_json::Value::as_array)
            .ok_or(EvmServiceError::InvalidTypedData)?;
        let mut encoded = Vec::with_capacity(values.len() * 32);
        for item in values {
            encoded.extend_from_slice(&encode_typed_value(item_type, Some(item), typed_data)?);
        }
        return Ok(keccak256(&encoded));
    }
    if typed_data.has_type(ty) {
        return hash_typed_struct(ty, value.unwrap_or(&serde_json::Value::Null), typed_data);
    }
    let value = value.ok_or(EvmServiceError::InvalidTypedData)?;
    match ty {
        "string" => value
            .as_str()
            .map(|value| keccak256(value.as_bytes()))
            .ok_or(EvmServiceError::InvalidTypedData),
        "bytes" => value
            .as_str()
            .ok_or(EvmServiceError::InvalidTypedData)
            .and_then(hex_data_to_bytes)
            .map(|bytes| keccak256(&bytes)),
        "address" => {
            let address = value
                .as_str()
                .ok_or(EvmServiceError::InvalidTypedData)
                .and_then(|value| normalize_address(value, "typed data address"))?;
            let mut output = [0u8; 32];
            output[12..].copy_from_slice(&address_bytes(&address)?);
            Ok(output)
        }
        "bool" => {
            let mut output = [0u8; 32];
            output[31] = u8::from(value.as_bool().ok_or(EvmServiceError::InvalidTypedData)?);
            Ok(output)
        }
        _ if ty.starts_with("bytes") => encode_fixed_bytes(ty, value),
        _ if ty.starts_with("uint") => encode_typed_uint(ty, value),
        _ if ty.starts_with("int") => encode_typed_int(ty, value),
        _ => Err(EvmServiceError::InvalidTypedData),
    }
}

fn encode_fixed_bytes(ty: &str, value: &serde_json::Value) -> EvmResult<[u8; 32]> {
    let size = ty
        .strip_prefix("bytes")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|size| (1..=32).contains(size))
        .ok_or(EvmServiceError::InvalidTypedData)?;
    let bytes = value
        .as_str()
        .ok_or(EvmServiceError::InvalidTypedData)
        .and_then(hex_data_to_bytes)?;
    if bytes.len() != size {
        return Err(EvmServiceError::InvalidTypedData);
    }
    let mut output = [0u8; 32];
    output[..bytes.len()].copy_from_slice(&bytes);
    Ok(output)
}

fn encode_typed_uint(ty: &str, value: &serde_json::Value) -> EvmResult<[u8; 32]> {
    validate_integer_type(ty, "uint")?;
    let decimal = typed_json_integer_to_decimal(value)?;
    decimal_to_32_bytes(&decimal)
}

fn encode_typed_int(ty: &str, value: &serde_json::Value) -> EvmResult<[u8; 32]> {
    validate_integer_type(ty, "int")?;
    let decimal = typed_json_integer_to_decimal(value)?;
    decimal_to_32_bytes(&decimal)
}

fn validate_integer_type(ty: &str, prefix: &str) -> EvmResult<()> {
    let bits = ty.strip_prefix(prefix).unwrap_or_default();
    let bits = if bits.is_empty() {
        256
    } else {
        bits.parse::<usize>()
            .map_err(|_| EvmServiceError::InvalidTypedData)?
    };
    if bits == 0 || bits > 256 || bits % 8 != 0 {
        return Err(EvmServiceError::InvalidTypedData);
    }
    Ok(())
}

fn typed_json_integer_to_decimal(value: &serde_json::Value) -> EvmResult<String> {
    match value {
        serde_json::Value::String(value) => evm_quantity_to_decimal(value, "typed data integer"),
        serde_json::Value::Number(value) => {
            normalize_decimal(&value.to_string(), "typed data integer")
        }
        _ => Err(EvmServiceError::InvalidTypedData),
    }
}

fn eip712_base_type(ty: &str) -> String {
    ty.split_once('[')
        .map(|(base, _)| base)
        .unwrap_or(ty)
        .to_string()
}

fn hex_data_to_bytes(data: &str) -> EvmResult<Vec<u8>> {
    let data = data.trim();
    if data.is_empty() || data == "0x" {
        return Ok(Vec::new());
    }
    let hex = data
        .strip_prefix("0x")
        .ok_or_else(|| EvmServiceError::InvalidInput("Hex data must start with 0x".to_string()))?;
    if hex.len() % 2 != 0 {
        return Err(EvmServiceError::InvalidInput(
            "Hex data length must be even".to_string(),
        ));
    }
    hex::decode(hex).map_err(|_| EvmServiceError::InvalidInput("Hex data is invalid".to_string()))
}

fn normalize_decimal(value: &str, field: &'static str) -> EvmResult<String> {
    let value = require_non_empty(value, field)?;
    if !value.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(EvmServiceError::InvalidInput(format!(
            "{field} must be a decimal integer in base units"
        )));
    }
    let trimmed = value.trim_start_matches('0');
    Ok(if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    })
}

fn decimal_to_hex_quantity(value: &str) -> EvmResult<String> {
    let bytes = decimal_to_be_bytes(value)?;
    if bytes.is_empty() {
        Ok("0x0".to_string())
    } else {
        Ok(format!("0x{}", hex::encode(bytes)))
    }
}

fn hex_quantity_to_decimal(value: &str) -> EvmResult<String> {
    let value = if value == "0x" { "0x0" } else { value };
    let hex = value.strip_prefix("0x").ok_or_else(|| {
        EvmServiceError::InvalidInput("Hex quantity must start with 0x".to_string())
    })?;
    if !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(EvmServiceError::InvalidInput(
            "Hex quantity is invalid".to_string(),
        ));
    }
    let padded;
    let hex = if hex.len() % 2 == 0 {
        hex
    } else {
        padded = format!("0{hex}");
        &padded
    };
    let bytes = hex::decode(hex)
        .map_err(|_| EvmServiceError::InvalidInput("Hex quantity is invalid".to_string()))?;
    Ok(be_bytes_to_decimal(&bytes))
}

fn hex_quantity_to_u64(value: &str) -> EvmResult<u64> {
    let decimal = hex_quantity_to_decimal(value)?;
    decimal
        .parse::<u64>()
        .map_err(|_| EvmServiceError::InvalidInput("Hex quantity exceeds u64".to_string()))
}

fn normalize_tx_hash(value: &str) -> EvmResult<String> {
    let value = require_non_empty(value, "transaction hash")?;
    let hex = value.strip_prefix("0x").unwrap_or(&value);
    if hex.len() != 64 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(EvmServiceError::InvalidInput(
            "Transaction hash must be 32 bytes hex".to_string(),
        ));
    }
    Ok(format!("0x{}", hex.to_ascii_lowercase()))
}

fn hex_word_to_decimal(value: &str) -> EvmResult<String> {
    hex_quantity_to_decimal(value)
}

fn hex_word_to_u8(value: &str) -> EvmResult<u8> {
    let decimal = hex_word_to_decimal(value)?;
    decimal
        .parse::<u8>()
        .map_err(|_| EvmServiceError::InvalidInput("ERC-20 decimals is invalid".to_string()))
}

fn decode_erc20_string(value: &str) -> EvmResult<String> {
    let bytes = hex_data_to_bytes(value)?;
    if bytes.is_empty() {
        return Err(EvmServiceError::InvalidInput(
            "ERC-20 string is empty".to_string(),
        ));
    }
    if bytes.len() == 32 {
        let trimmed = bytes
            .into_iter()
            .take_while(|byte| *byte != 0)
            .collect::<Vec<_>>();
        return String::from_utf8(trimmed).map_err(|_| {
            EvmServiceError::InvalidInput("ERC-20 bytes32 string is invalid".to_string())
        });
    }
    if bytes.len() >= 96 {
        let len = be_bytes_to_decimal(&bytes[64..96])
            .parse::<usize>()
            .map_err(|_| {
                EvmServiceError::InvalidInput("ERC-20 dynamic string length is invalid".to_string())
            })?;
        let start = 96;
        let end = start + len;
        if end <= bytes.len() {
            return String::from_utf8(bytes[start..end].to_vec()).map_err(|_| {
                EvmServiceError::InvalidInput("ERC-20 dynamic string is invalid".to_string())
            });
        }
    }
    Err(EvmServiceError::InvalidInput(
        "ERC-20 string response is invalid".to_string(),
    ))
}

fn decimal_mul(left: &str, right: &str) -> EvmResult<String> {
    let left = normalize_decimal(left, "left")?;
    let right = normalize_decimal(right, "right")?;
    let mut digits = vec![0u8; left.len() + right.len()];
    for (i, lb) in left.bytes().rev().enumerate() {
        for (j, rb) in right.bytes().rev().enumerate() {
            digits[i + j] += (lb - b'0') * (rb - b'0');
        }
    }
    for index in 0..digits.len() {
        if digits[index] >= 10 {
            let carry = digits[index] / 10;
            digits[index] %= 10;
            if index + 1 == digits.len() {
                digits.push(carry);
            } else {
                digits[index + 1] += carry;
            }
        }
    }
    while digits.len() > 1 && digits.last() == Some(&0) {
        digits.pop();
    }
    Ok(digits
        .into_iter()
        .rev()
        .map(|digit| char::from(b'0' + digit))
        .collect())
}

fn decimal_mul_u64(left: &str, right: u64) -> EvmResult<String> {
    decimal_mul(left, &right.to_string())
}

fn decimal_add(left: &str, right: &str) -> EvmResult<String> {
    let left = normalize_decimal(left, "left")?;
    let right = normalize_decimal(right, "right")?;
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut carry = 0u8;
    let mut output = Vec::with_capacity(left.len().max(right.len()) + 1);
    let mut i = 0usize;
    while i < left.len() || i < right.len() || carry > 0 {
        let l = left
            .len()
            .checked_sub(1 + i)
            .and_then(|index| left.get(index))
            .map(|byte| byte - b'0')
            .unwrap_or(0);
        let r = right
            .len()
            .checked_sub(1 + i)
            .and_then(|index| right.get(index))
            .map(|byte| byte - b'0')
            .unwrap_or(0);
        let sum = l + r + carry;
        output.push(char::from(b'0' + (sum % 10)));
        carry = sum / 10;
        i += 1;
    }
    Ok(output.into_iter().rev().collect())
}

fn decimal_cmp(left: &str, right: &str) -> EvmResult<std::cmp::Ordering> {
    let left = normalize_decimal(left, "left")?;
    let right = normalize_decimal(right, "right")?;
    Ok(left.len().cmp(&right.len()).then_with(|| left.cmp(&right)))
}

fn decimal_to_32_bytes(value: &str) -> EvmResult<[u8; 32]> {
    let bytes = decimal_to_be_bytes(value)?;
    if bytes.len() > 32 {
        return Err(EvmServiceError::InvalidInput(
            "Integer exceeds uint256".to_string(),
        ));
    }
    let mut output = [0u8; 32];
    output[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(output)
}

fn decimal_to_be_bytes(value: &str) -> EvmResult<Vec<u8>> {
    let value = normalize_decimal(value, "decimal")?;
    if value == "0" {
        return Ok(Vec::new());
    }
    let mut bytes = vec![0u8];
    for digit in value.bytes() {
        let digit = digit - b'0';
        let mut carry = u16::from(digit);
        for byte in bytes.iter_mut().rev() {
            let next = u16::from(*byte) * 10 + carry;
            *byte = (next & 0xff) as u8;
            carry = next >> 8;
        }
        while carry > 0 {
            bytes.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    Ok(trim_leading_zeroes(&bytes).to_vec())
}

fn be_bytes_to_decimal(bytes: &[u8]) -> String {
    let mut digits = vec![0u8];
    for byte in trim_leading_zeroes(bytes) {
        let mut carry = *byte as u16;
        for digit in digits.iter_mut().rev() {
            let next = u16::from(*digit) * 256 + carry;
            *digit = (next % 10) as u8;
            carry = next / 10;
        }
        while carry > 0 {
            digits.insert(0, (carry % 10) as u8);
            carry /= 10;
        }
    }
    digits
        .into_iter()
        .map(|digit| char::from(b'0' + digit))
        .collect()
}

fn u64_to_be_bytes(value: u64) -> Vec<u8> {
    trim_leading_zeroes(&value.to_be_bytes()).to_vec()
}

fn u128_to_be_bytes(value: u128) -> Vec<u8> {
    trim_leading_zeroes(&value.to_be_bytes()).to_vec()
}

fn trim_leading_zeroes(bytes: &[u8]) -> &[u8] {
    let first_non_zero = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len());
    &bytes[first_non_zero..]
}

fn rlp_bytes(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        return bytes.to_vec();
    }
    if bytes.len() <= 55 {
        let mut output = Vec::with_capacity(1 + bytes.len());
        output.push(0x80 + bytes.len() as u8);
        output.extend_from_slice(bytes);
        return output;
    }
    let len = u64_to_be_bytes(bytes.len() as u64);
    let mut output = Vec::with_capacity(1 + len.len() + bytes.len());
    output.push(0xb7 + len.len() as u8);
    output.extend_from_slice(&len);
    output.extend_from_slice(bytes);
    output
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload_len: usize = items.iter().map(Vec::len).sum();
    let mut payload = Vec::with_capacity(payload_len);
    for item in items {
        payload.extend_from_slice(item);
    }
    if payload.len() <= 55 {
        let mut output = Vec::with_capacity(1 + payload.len());
        output.push(0xc0 + payload.len() as u8);
        output.extend_from_slice(&payload);
        return output;
    }
    let len = u64_to_be_bytes(payload.len() as u64);
    let mut output = Vec::with_capacity(1 + len.len() + payload.len());
    output.push(0xf7 + len.len() as u8);
    output.extend_from_slice(&len);
    output.extend_from_slice(&payload);
    output
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn submitted_at() -> String {
    now_ms().to_string()
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    hasher.finalize().into()
}

fn short_address(address: &str) -> String {
    if address.len() >= 10 {
        format!("{}...{}", &address[..6], &address[address.len() - 4..])
    } else {
        address.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV_PRIVATE_KEY: &str =
        "0x0000000000000000000000000000000000000000000000000000000000000001";
    const DEV_MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn legacy_private_key_keystore(password: &str) -> String {
        let signing_key = signing_key_from_hex(DEV_PRIVATE_KEY).unwrap();
        let address = address_from_signing_key(&signing_key);
        let mut salt = [0u8; KEYSTORE_SALT_BYTES];
        let mut rng = AeadOsRng;
        aes_gcm::aead::rand_core::RngCore::fill_bytes(&mut rng, &mut salt);
        let nonce = Aes256Gcm::generate_nonce(&mut rng);
        let key = derive_key(password, &salt).unwrap();
        let cipher = Aes256Gcm::new_from_slice(key.as_slice()).unwrap();
        let private_key = signing_key.to_bytes();
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: private_key.as_slice(),
                    aad: &keystore_aad_v1(&address),
                },
            )
            .unwrap();
        serde_json::json!({
            "version": LEGACY_KEYSTORE_VERSION,
            "wallet_family": "evm",
            "address": address,
            "derivation_path": null,
            "crypto": {
                "kdf": KEYSTORE_KDF,
                "kdf_params": {
                    "memory_kib": ARGON2_MEMORY_KIB,
                    "iterations": ARGON2_ITERATIONS,
                    "parallelism": ARGON2_PARALLELISM,
                    "salt": BASE64.encode(salt),
                },
                "cipher": KEYSTORE_CIPHER,
                "nonce": BASE64.encode(nonce),
                "ciphertext": BASE64.encode(ciphertext),
            },
            "metadata": { "wallet_name": "Legacy EVM" },
        })
        .to_string()
    }

    #[test]
    fn adapter_rejects_non_evm_derivation_paths() {
        let adapter = EvmChainAdapter::new(builtin_chains()[0].clone()).unwrap();
        assert!(adapter
            .derive_account(DEV_MNEMONIC, Some("m/44'/195'/0'/0/0"))
            .is_err());
        assert!(adapter
            .derive_account(DEV_MNEMONIC, Some("m/44'/60'/0'/2/0"))
            .is_err());
        assert!(adapter
            .derive_account(DEV_MNEMONIC, Some("m/44'/60'/7'/1/42"))
            .is_ok());
        assert!(matches!(
            adapter.derive_account(DEV_MNEMONIC, Some(&"m".repeat(257))),
            Err(ChainError::InvalidDerivationPath(_))
        ));
        assert!(adapter
            .derive_account(&"word ".repeat(1_025), None)
            .is_err());
    }

    #[test]
    fn adapters_only_advertise_history_when_the_backend_supports_it() {
        let mut chains = builtin_chains().into_iter();
        let ethereum =
            EvmChainAdapter::new_with_history_api_key(chains.next().unwrap(), Some("test-api-key"))
                .unwrap();
        let zksync = EvmChainAdapter::new_with_history_api_key(
            chains
                .find(|chain| chain.chain_id == 324)
                .expect("zkSync must remain in the built-in catalog"),
            Some("test-api-key"),
        )
        .unwrap();

        assert!(ethereum.descriptor().supports(capabilities::HISTORY));
        assert!(!zksync.descriptor().supports(capabilities::HISTORY));

        let unsupported = EvmChainAdapter::new_with_history_api_key(
            chain(
                999_999,
                "Unknown EVM",
                "ETH",
                "https://rpc.example.com",
                Some("https://explorer.example.com"),
                true,
            ),
            Some("test-api-key"),
        )
        .unwrap();
        assert!(!unsupported.descriptor().supports(capabilities::HISTORY));

        let without_key =
            EvmChainAdapter::new_with_history_api_key(builtin_chains()[0].clone(), None).unwrap();
        assert!(!without_key.descriptor().supports(capabilities::HISTORY));
    }

    #[test]
    fn rpc_chain_id_must_match_the_configured_chain() {
        assert!(validate_reported_chain_id(1, &serde_json::json!("0x1")).is_ok());
        assert!(matches!(
            validate_reported_chain_id(1, &serde_json::json!("0xa")),
            Err(EvmServiceError::InvalidChainId)
        ));
        assert!(matches!(
            validate_reported_chain_id(1, &serde_json::json!(1)),
            Err(EvmServiceError::InvalidChainId)
        ));
    }

    #[test]
    fn chain_configuration_rejects_malformed_or_ambiguous_rpc_urls() {
        let mut config = builtin_chains()[0].clone();
        for rpc_url in [
            "https://",
            " https://ethereum-rpc.publicnode.com",
            "https://user:secret@example.com",
            "https://example.com/#ignored-fragment",
            "http://example.com",
            "ftp://example.com",
        ] {
            config.rpc_url = rpc_url.to_string();
            assert!(validate_chain(&config).is_err(), "accepted {rpc_url}");
        }

        config.rpc_url = "http://127.0.0.1:8545".to_string();
        assert!(validate_chain(&config).is_ok());
        config.rpc_url = "http://[::1]:8545".to_string();
        assert!(validate_chain(&config).is_ok());
    }

    #[test]
    fn adapter_preserves_chain_id_errors_and_classifies_other_config_errors() {
        let mut config = builtin_chains()[0].clone();
        config.chain_id = 0;
        assert!(matches!(
            EvmChainAdapter::new(config),
            Err(ChainError::InvalidChainId(_))
        ));

        let mut config = builtin_chains()[0].clone();
        config.name = " Ethereum ".to_string();
        assert!(matches!(
            EvmChainAdapter::new(config),
            Err(ChainError::InvalidDescriptor { .. })
        ));
    }

    #[test]
    fn chain_configuration_rejects_ambiguous_explorer_urls() {
        let mut config = builtin_chains()[0].clone();
        for explorer_url in [
            "http://etherscan.io",
            "https://user@etherscan.io",
            "https://etherscan.io/address/0x1",
            "https://etherscan.io?network=mainnet",
            "https://etherscan.io/#mainnet",
        ] {
            config.explorer_url = Some(explorer_url.to_string());
            assert!(validate_chain(&config).is_err(), "accepted {explorer_url}");
            assert!(etherscan_chain_id(explorer_url).is_none());
        }
    }

    #[test]
    fn invalid_addresses_never_compare_equal() {
        assert!(!address_eq("not-an-address", "also-invalid"));
    }

    #[test]
    fn mixed_case_addresses_require_a_valid_eip55_checksum() {
        let checksummed = "0x5AEDA56215b167893e80B4fE645BA6d5Bab767DE";
        assert_eq!(
            normalize_address(checksummed, "address").unwrap(),
            checksummed.to_ascii_lowercase()
        );
        assert!(
            normalize_address("0x5AEDA56215b167893e80B4fE645BA6d5Bab767De", "address").is_err()
        );
        assert!(
            normalize_address("0X5AEDA56215b167893e80B4fE645BA6d5Bab767DE", "address").is_err()
        );
    }

    #[test]
    fn includes_robinhood_chain_mainnet() {
        let robinhood = builtin_chains()
            .into_iter()
            .find(|chain| chain.chain_id == 4663)
            .expect("Robinhood Chain mainnet should be built in");
        assert_eq!(robinhood.name, "Robinhood Chain");
        assert_eq!(robinhood.native_symbol, "ETH");
        assert!(!robinhood.testnet);
    }

    #[test]
    fn polygon_networks_use_pol_as_the_native_symbol() {
        let chains = builtin_chains();
        for chain_id in [137, 80002] {
            let polygon = chains
                .iter()
                .find(|chain| chain.chain_id == chain_id)
                .expect("Polygon network should be built in");
            assert_eq!(polygon.native_symbol, "POL");
        }
        let polygon_mainnet = chains
            .iter()
            .find(|chain| chain.chain_id == 137)
            .expect("Polygon mainnet should be built in");
        assert_eq!(
            polygon_mainnet.rpc_url,
            "https://polygon-bor-rpc.publicnode.com"
        );
    }

    #[test]
    fn derives_known_evm_address_from_private_key() {
        let key = signing_key_from_hex(DEV_PRIVATE_KEY).unwrap();
        assert_eq!(
            address_from_signing_key(&key),
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn encrypts_and_unlocks_evm_keystore() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let document: serde_json::Value = serde_json::from_str(&created.keystore_json).unwrap();
        assert_eq!(document.get("secret_type").unwrap(), "private_key");
        let unlocked = unlock_wallet(EvmUnlockWalletRequest {
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
        })
        .unwrap();
        assert_eq!(
            unlocked.address,
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn mnemonic_keystore_restores_the_derived_account() {
        const MNEMONIC: &str = "test test test test test test test test test test test junk";
        let created = import_mnemonic(EvmImportMnemonicRequest {
            name: "Mnemonic EVM".to_string(),
            mnemonic: MNEMONIC.to_string(),
            derivation_path: None,
            password: "strong-password".to_string(),
        })
        .unwrap();
        assert!(!created.keystore_json.contains(MNEMONIC));
        let document: serde_json::Value = serde_json::from_str(&created.keystore_json).unwrap();
        assert_eq!(document.get("version").unwrap(), KEYSTORE_VERSION);
        assert_eq!(document.get("secret_type").unwrap(), "mnemonic");

        let restored = import_keystore(EvmImportKeystoreRequest {
            name: "Restored EVM".to_string(),
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
        })
        .unwrap();
        assert_eq!(restored.wallet.address, created.wallet.address);
        assert_eq!(
            restored.wallet.derivation_path.as_deref(),
            Some(DEFAULT_EVM_DERIVATION_PATH)
        );
        let restored_document: serde_json::Value =
            serde_json::from_str(&restored.keystore_json).unwrap();
        assert_eq!(restored_document.get("secret_type").unwrap(), "mnemonic");
    }

    #[test]
    fn mnemonic_keystore_rejects_authenticated_metadata_tampering() {
        const MNEMONIC: &str = "test test test test test test test test test test test junk";
        let created = import_mnemonic(EvmImportMnemonicRequest {
            name: "Mnemonic EVM".to_string(),
            mnemonic: MNEMONIC.to_string(),
            derivation_path: None,
            password: "strong-password".to_string(),
        })
        .unwrap();
        let mut document: serde_json::Value = serde_json::from_str(&created.keystore_json).unwrap();

        document["derivation_path"] = serde_json::Value::String("m/44'/60'/0'/0/1".to_string());
        assert!(export_private_key(EvmExportPrivateKeyRequest {
            keystore_json: document.to_string(),
            password: "strong-password".to_string(),
        })
        .is_err());

        let mut document: serde_json::Value = serde_json::from_str(&created.keystore_json).unwrap();
        document["secret_type"] = serde_json::Value::String("private_key".to_string());
        assert!(unlock_wallet(EvmUnlockWalletRequest {
            keystore_json: document.to_string(),
            password: "strong-password".to_string(),
        })
        .is_err());
    }

    #[test]
    fn private_key_keystore_without_secret_type_remains_compatible() {
        let unlocked = unlock_wallet(EvmUnlockWalletRequest {
            keystore_json: legacy_private_key_keystore("strong-password"),
            password: "strong-password".to_string(),
        })
        .unwrap();
        assert_eq!(
            unlocked.address,
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn legacy_keystore_rejects_mnemonic_type_confusion() {
        let mut document: serde_json::Value =
            serde_json::from_str(&legacy_private_key_keystore("strong-password")).unwrap();
        document["secret_type"] = serde_json::Value::String("mnemonic".to_string());
        document["derivation_path"] =
            serde_json::Value::String(DEFAULT_EVM_DERIVATION_PATH.to_string());

        assert!(matches!(
            decrypt_keystore(&document.to_string(), "strong-password"),
            Err(EvmServiceError::InvalidInput(message))
                if message == "Legacy EVM keystore must contain a private key"
        ));
    }

    #[test]
    fn rejects_oversized_keystore_passwords_before_kdf() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let oversized = "x".repeat(MAX_KEYSTORE_PASSWORD_BYTES + 1);

        assert!(matches!(
            decrypt_keystore(&created.keystore_json, &oversized),
            Err(EvmServiceError::InvalidInput(message))
                if message == "EVM keystore password is too long"
        ));
        assert!(matches!(
            import_private_key(EvmImportPrivateKeyRequest {
                name: "EVM".to_string(),
                private_key_hex: DEV_PRIVATE_KEY.to_string(),
                password: oversized,
            }),
            Err(EvmServiceError::InvalidInput(message))
                if message == "EVM keystore password is too long"
        ));
    }

    #[test]
    fn rejects_oversized_keystore_json_before_parsing() {
        let oversized = " ".repeat(MAX_KEYSTORE_JSON_BYTES + 1);
        assert!(matches!(
            decrypt_keystore(&oversized, "strong-password"),
            Err(EvmServiceError::InvalidInput(message))
                if message == "EVM keystore JSON is too large"
        ));
    }

    #[test]
    fn rejects_unapproved_keystore_kdf_parameters() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();

        for (field, value) in [
            ("memory_kib", ARGON2_MEMORY_KIB + 1),
            ("iterations", ARGON2_ITERATIONS + 1),
            ("parallelism", ARGON2_PARALLELISM + 1),
        ] {
            let mut document: serde_json::Value =
                serde_json::from_str(&created.keystore_json).unwrap();
            document["crypto"]["kdf_params"][field] = serde_json::json!(value);
            assert!(matches!(
                decrypt_keystore(&document.to_string(), "strong-password"),
                Err(EvmServiceError::InvalidInput(message))
                    if message == "Unsupported EVM keystore KDF parameters"
            ));
        }
    }

    #[test]
    fn rejects_invalid_keystore_ciphertext_lengths() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();

        for ciphertext in [
            vec![0; KEYSTORE_TAG_BYTES],
            vec![0; MAX_KEYSTORE_SECRET_BYTES + KEYSTORE_TAG_BYTES + 1],
        ] {
            let mut document: serde_json::Value =
                serde_json::from_str(&created.keystore_json).unwrap();
            document["crypto"]["ciphertext"] = serde_json::Value::String(BASE64.encode(ciphertext));
            assert!(matches!(
                decrypt_keystore(&document.to_string(), "strong-password"),
                Err(EvmServiceError::InvalidInput(message))
                    if message == "Keystore ciphertext length is invalid"
            ));
        }
    }

    #[test]
    fn unlock_private_key_returns_zeroizing_material_for_the_same_address() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let expected_address = created.wallet.address.clone();
        let (wallet, private_key) = unlock_private_key(EvmUnlockWalletRequest {
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
        })
        .unwrap();

        assert_eq!(wallet.address, expected_address);
        assert_eq!(
            private_key.as_slice(),
            &hex::decode(DEV_PRIVATE_KEY.trim_start_matches("0x")).unwrap()
        );
    }

    #[test]
    fn builds_erc20_transfer_calldata() {
        let calldata = erc20_transfer_calldata(
            "0x000000000000000000000000000000000000dead",
            "1000000000000000000",
        )
        .unwrap();
        assert!(calldata.starts_with("0xa9059cbb"));
        assert!(
            calldata.contains("000000000000000000000000000000000000000000000000000000000000dead")
        );
    }

    #[test]
    fn rejects_wrong_evm_password() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        assert!(matches!(
            unlock_wallet(EvmUnlockWalletRequest {
                keystore_json: created.keystore_json,
                password: "wrong-password".to_string(),
            }),
            Err(EvmServiceError::WrongPassword)
        ));
    }

    #[test]
    fn hashes_eip712_mail_example() {
        let payload = serde_json::json!({
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"}
                ],
                "Person": [
                    {"name": "name", "type": "string"},
                    {"name": "wallet", "type": "address"}
                ],
                "Mail": [
                    {"name": "from", "type": "Person"},
                    {"name": "to", "type": "Person"},
                    {"name": "contents", "type": "string"}
                ]
            },
            "primaryType": "Mail",
            "domain": {
                "name": "Ether Mail",
                "version": "1",
                "chainId": 1,
                "verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
            },
            "message": {
                "from": {
                    "name": "Cow",
                    "wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"
                },
                "to": {
                    "name": "Bob",
                    "wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
                },
                "contents": "Hello, Bob!"
            }
        });
        let digest = typed_data_digest(&payload.to_string()).unwrap();
        assert_eq!(
            hex::encode(digest),
            "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2"
        );
    }

    #[test]
    fn signs_eip1559_transaction_with_type2_prefix() {
        let key = signing_key_from_hex(DEV_PRIVATE_KEY).unwrap();
        let raw = sign_evm_transaction(&EvmTxSigningInput {
            signing_key: &key,
            chain_id: 11155111,
            nonce: "0",
            gas_limit: "21000",
            to: "0x000000000000000000000000000000000000dead",
            value: "1",
            data: "0x",
            gas_price_wei: "1000000000",
            max_fee_per_gas_wei: Some("2000000000"),
            max_priority_fee_per_gas_wei: Some("1000000000"),
        })
        .unwrap();
        assert!(raw.starts_with("0x02"));
        assert!(raw.len() > 130);
    }

    #[test]
    fn payment_submit_rejects_keystore_for_different_preview_wallet() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );
        let wallet_address = "0x000000000000000000000000000000000000dead";
        let recipient = "0x000000000000000000000000000000000000beef";
        let preview_id = payment_preview_id(&PaymentPreviewIdInput {
            chain: &chain,
            wallet_address,
            recipient,
            token_contract: None,
            amount_wei_or_units: "1",
            gas_limit: "21000",
            gas_price_wei: "1000000000",
            max_fee_per_gas_wei: None,
            max_priority_fee_per_gas_wei: None,
            nonce: "0",
        });

        let error = submit_payment(EvmPaymentSubmitRequest {
            preview_id,
            approved: true,
            chain,
            wallet_address: wallet_address.to_string(),
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            recipient: recipient.to_string(),
            amount_wei_or_units: "1".to_string(),
            token_contract: None,
            gas_limit: Some("21000".to_string()),
            gas_price_wei: Some("1000000000".to_string()),
            max_fee_per_gas_wei: None,
            max_priority_fee_per_gas_wei: None,
            nonce: Some("0".to_string()),
        })
        .unwrap_err();

        assert!(matches!(error, EvmServiceError::InvalidInput(_)));
        assert!(!error.to_string().contains("strong-password"));
        assert!(!error.to_string().contains(DEV_PRIVATE_KEY));
    }

    #[test]
    fn payment_submit_rejects_mismatched_preview_id_before_sending() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );

        let error = submit_payment(EvmPaymentSubmitRequest {
            preview_id: "evm-payment:stale".to_string(),
            approved: true,
            chain,
            wallet_address: created.wallet.address,
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            recipient: "0x000000000000000000000000000000000000beef".to_string(),
            amount_wei_or_units: "1".to_string(),
            token_contract: None,
            gas_limit: Some("21000".to_string()),
            gas_price_wei: Some("1000000000".to_string()),
            max_fee_per_gas_wei: None,
            max_priority_fee_per_gas_wei: None,
            nonce: Some("0".to_string()),
        })
        .unwrap_err();

        assert!(matches!(error, EvmServiceError::InvalidInput(_)));
        assert!(error.to_string().contains("stale or mismatched"));
    }

    #[test]
    fn payment_submit_rejects_mismatched_preview_id_before_decrypting() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );

        let error = submit_payment(EvmPaymentSubmitRequest {
            preview_id: "evm-payment:stale".to_string(),
            approved: true,
            chain,
            wallet_address: created.wallet.address,
            keystore_json: created.keystore_json,
            password: "wrong-password".to_string(),
            recipient: "0x000000000000000000000000000000000000beef".to_string(),
            amount_wei_or_units: "1".to_string(),
            token_contract: None,
            gas_limit: Some("21000".to_string()),
            gas_price_wei: Some("1000000000".to_string()),
            max_fee_per_gas_wei: None,
            max_priority_fee_per_gas_wei: None,
            nonce: Some("0".to_string()),
        })
        .unwrap_err();

        assert!(matches!(error, EvmServiceError::InvalidInput(_)));
        assert!(error.to_string().contains("stale or mismatched"));
        assert!(!matches!(error, EvmServiceError::WrongPassword));
    }

    #[test]
    fn payment_submit_with_private_key_rejects_a_different_wallet_before_sending() {
        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );
        let wallet_address = "0x000000000000000000000000000000000000dead";
        let recipient = "0x000000000000000000000000000000000000beef";
        let preview_id = payment_preview_id(&PaymentPreviewIdInput {
            chain: &chain,
            wallet_address,
            recipient,
            token_contract: None,
            amount_wei_or_units: "1",
            gas_limit: "21000",
            gas_price_wei: "1000000000",
            max_fee_per_gas_wei: None,
            max_priority_fee_per_gas_wei: None,
            nonce: "0",
        });
        let request = EvmPaymentSubmitRequest {
            preview_id,
            approved: true,
            chain,
            wallet_address: wallet_address.to_string(),
            keystore_json: String::new(),
            password: String::new(),
            recipient: recipient.to_string(),
            amount_wei_or_units: "1".to_string(),
            token_contract: None,
            gas_limit: Some("21000".to_string()),
            gas_price_wei: Some("1000000000".to_string()),
            max_fee_per_gas_wei: None,
            max_priority_fee_per_gas_wei: None,
            nonce: Some("0".to_string()),
        };
        let private_key = hex::decode(DEV_PRIVATE_KEY.trim_start_matches("0x")).unwrap();

        let error = submit_payment_with_private_key(request, &private_key).unwrap_err();
        assert!(matches!(error, EvmServiceError::InvalidInput(_)));
        assert!(error.to_string().contains("does not match preview"));
    }

    #[test]
    fn private_key_loader_is_not_called_for_a_stale_payment_preview() {
        use std::cell::Cell;

        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );
        let loader_called = Cell::new(false);
        let error = submit_payment_with_private_key_loader(
            EvmPaymentSubmitRequest {
                preview_id: "evm-payment:stale".to_string(),
                approved: true,
                chain,
                wallet_address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_string(),
                keystore_json: String::new(),
                password: String::new(),
                recipient: "0x000000000000000000000000000000000000beef".to_string(),
                amount_wei_or_units: "1".to_string(),
                token_contract: None,
                gas_limit: Some("21000".to_string()),
                gas_price_wei: Some("1000000000".to_string()),
                max_fee_per_gas_wei: None,
                max_priority_fee_per_gas_wei: None,
                nonce: Some("0".to_string()),
            },
            || {
                loader_called.set(true);
                Ok(Zeroizing::new(vec![0_u8; PRIVATE_KEY_BYTES]))
            },
        )
        .unwrap_err();

        assert!(!loader_called.get());
        assert!(error.to_string().contains("stale or mismatched"));
    }

    #[test]
    fn payment_preview_id_uses_normalized_token_contract() {
        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );
        let token = normalize_address(
            "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
            "token contract",
        )
        .unwrap();
        let preview_id = payment_preview_id(&PaymentPreviewIdInput {
            chain: &chain,
            wallet_address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            recipient: "0x000000000000000000000000000000000000beef",
            token_contract: Some(&token),
            amount_wei_or_units: "1",
            gas_limit: "65000",
            gas_price_wei: "1000000000",
            max_fee_per_gas_wei: None,
            max_priority_fee_per_gas_wei: None,
            nonce: "0",
        });
        let submit_preview_id = payment_preview_id(&PaymentPreviewIdInput {
            chain: &chain,
            wallet_address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            recipient: "0x000000000000000000000000000000000000beef",
            token_contract: Some(token.as_str()),
            amount_wei_or_units: "1",
            gas_limit: "65000",
            gas_price_wei: "1000000000",
            max_fee_per_gas_wei: None,
            max_priority_fee_per_gas_wei: None,
            nonce: "0",
        });

        assert_eq!(preview_id, submit_preview_id);
    }

    #[test]
    fn rpc_hex_quantity_rejects_malformed_values() {
        assert_eq!(
            rpc_hex_quantity_to_decimal(serde_json::json!("0x2a")).unwrap(),
            "42"
        );
        assert!(matches!(
            rpc_hex_quantity_to_decimal(serde_json::json!(0)),
            Err(EvmServiceError::RpcUnavailable)
        ));
        assert!(matches!(
            rpc_hex_quantity_to_decimal(serde_json::json!("42")),
            Err(EvmServiceError::InvalidInput(_))
        ));
    }

    #[test]
    fn dapp_submit_rejects_keystore_for_different_preview_wallet() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );
        let wallet_address = "0x000000000000000000000000000000000000dead";
        let payload_json = serde_json::json!(["hello"]).to_string();
        let preview_id = dapp_sign_preview_id(&DappSignPreviewIdInput {
            chain: &chain,
            wallet_address,
            app_name: "Test dApp",
            app_url: "https://example.com",
            method: "personal_sign",
            payload_json: &payload_json,
        });

        let error = submit_dapp_signing(EvmDappSignSubmitRequest {
            preview_id,
            approved: true,
            chain,
            wallet_address: wallet_address.to_string(),
            app_name: "Test dApp".to_string(),
            app_url: "https://example.com".to_string(),
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            method: "personal_sign".to_string(),
            payload_json,
        })
        .unwrap_err();

        assert!(matches!(error, EvmServiceError::InvalidInput(_)));
        assert!(!error.to_string().contains("strong-password"));
        assert!(!error.to_string().contains(DEV_PRIVATE_KEY));
    }

    #[test]
    fn dapp_submit_rejects_mismatched_preview_id_before_signing() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );

        let error = submit_dapp_signing(EvmDappSignSubmitRequest {
            preview_id: "evm-dapp:stale".to_string(),
            approved: true,
            chain,
            wallet_address: created.wallet.address,
            app_name: "Test dApp".to_string(),
            app_url: "https://example.com".to_string(),
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            method: "personal_sign".to_string(),
            payload_json: serde_json::json!(["hello"]).to_string(),
        })
        .unwrap_err();

        assert!(matches!(error, EvmServiceError::InvalidInput(_)));
        assert!(error.to_string().contains("stale or mismatched"));
        assert!(!error.to_string().contains("strong-password"));
    }

    #[test]
    fn dapp_submit_rejects_mismatched_preview_id_before_decrypting() {
        let created = import_private_key(EvmImportPrivateKeyRequest {
            name: "EVM".to_string(),
            private_key_hex: DEV_PRIVATE_KEY.to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );

        let error = submit_dapp_signing(EvmDappSignSubmitRequest {
            preview_id: "evm-dapp:stale".to_string(),
            approved: true,
            chain,
            wallet_address: created.wallet.address,
            app_name: "Test dApp".to_string(),
            app_url: "https://example.com".to_string(),
            keystore_json: created.keystore_json,
            password: "wrong-password".to_string(),
            method: "personal_sign".to_string(),
            payload_json: serde_json::json!(["hello"]).to_string(),
        })
        .unwrap_err();

        assert!(matches!(error, EvmServiceError::InvalidInput(_)));
        assert!(error.to_string().contains("stale or mismatched"));
        assert!(!matches!(error, EvmServiceError::WrongPassword));
    }

    #[test]
    fn dapp_submit_signs_with_in_memory_private_key() {
        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );
        let wallet_address = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
        let payload_json = serde_json::json!({ "message": "hello" }).to_string();
        let preview_id = dapp_sign_preview_id(&DappSignPreviewIdInput {
            chain: &chain,
            wallet_address,
            app_name: "Test dApp",
            app_url: "https://example.com",
            method: "personal_sign",
            payload_json: &payload_json,
        });
        let private_key = hex::decode(DEV_PRIVATE_KEY.trim_start_matches("0x")).unwrap();
        let result = submit_dapp_signing_with_private_key(
            EvmDappSignSubmitRequest {
                preview_id,
                approved: true,
                chain,
                wallet_address: wallet_address.to_string(),
                app_name: "Test dApp".to_string(),
                app_url: "https://example.com".to_string(),
                keystore_json: String::new(),
                password: String::new(),
                method: "personal_sign".to_string(),
                payload_json,
            },
            &private_key,
        )
        .unwrap();

        assert_eq!(result.status, "signed");
        assert!(result
            .signature
            .as_deref()
            .is_some_and(|value| value.starts_with("0x")));
    }

    #[test]
    fn dapp_message_payload_decodes_hex_and_binds_the_selected_account() {
        let wallet_address = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
        let payload = serde_json::json!({
            "params": ["0x68656c6c6f", wallet_address]
        })
        .to_string();
        assert_eq!(
            evm_message_from_payload(&payload, wallet_address).unwrap(),
            b"hello"
        );

        let mismatched = serde_json::json!({
            "params": [
                "0x000000000000000000000000000000000000dead",
                "0x68656c6c6f"
            ]
        })
        .to_string();
        let error = evm_message_from_payload(&mismatched, wallet_address).unwrap_err();
        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn parses_dapp_transaction_payload() {
        let chain = chain(
            11155111,
            "Sepolia",
            "ETH",
            "http://127.0.0.1:8545",
            None,
            true,
        );
        let payload = serde_json::json!({
            "method": "eth_signTransaction",
            "params": [{
                "from": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
                "to": "0x000000000000000000000000000000000000dead",
                "value": "0x1",
                "gas": "0x5208",
                "gasPrice": "0x3b9aca00",
                "nonce": "0x0"
            }]
        });
        let tx = parse_dapp_transaction(
            &chain,
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            &payload.to_string(),
        )
        .unwrap();
        assert_eq!(tx.value, "1");
        assert_eq!(tx.gas_limit, "21000");
        assert_eq!(tx.gas_price_wei, "1000000000");
    }

    #[test]
    fn derives_known_etherscan_api_urls() {
        let sepolia_chain = builtin_chains()
            .into_iter()
            .find(|chain| chain.chain_id == 11_155_111)
            .unwrap();
        let sepolia = etherscan_compatible_api_url(
            &sepolia_chain,
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            "test-api-key",
        )
        .unwrap();
        assert!(sepolia.starts_with("https://api.etherscan.io/v2/api?chainid=11155111&"));
        assert!(sepolia.ends_with("apikey=test-api-key"));

        let optimism_chain = builtin_chains()
            .into_iter()
            .find(|chain| chain.chain_id == 10)
            .unwrap();
        let optimism = etherscan_compatible_api_url(
            &optimism_chain,
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            "test-api-key",
        )
        .unwrap();
        assert!(optimism.contains("chainid=10"));

        let mut mismatched = builtin_chains()[0].clone();
        mismatched.explorer_url = Some("https://bscscan.com".to_string());
        assert!(etherscan_compatible_api_url(
            &mismatched,
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            "test-api-key",
        )
        .is_err());
        mismatched.explorer_url = Some("http://etherscan.io".to_string());
        assert!(etherscan_compatible_api_url(
            &mismatched,
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            "test-api-key",
        )
        .is_err());
    }

    #[test]
    fn parses_etherscan_compatible_history() {
        let body = serde_json::json!({
            "status": "1",
            "message": "OK",
            "result": [{
                "hash": "0x1111111111111111111111111111111111111111111111111111111111111111",
                "blockNumber": "123456",
                "txreceipt_status": "1"
            }, {
                "hash": "0x2222222222222222222222222222222222222222222222222222222222222222",
                "blockNumber": "123455",
                "txreceipt_status": "0"
            }]
        });
        let entries = parse_etherscan_history_response(&body.to_string()).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].block_number, Some(123456));
        assert_eq!(entries[0].status, "confirmed");
        assert_eq!(entries[1].status, "failed");
    }

    #[test]
    fn parses_empty_etherscan_history_as_ok() {
        let body = serde_json::json!({
            "status": "0",
            "message": "No transactions found",
            "result": "No transactions found"
        });
        let entries = parse_etherscan_history_response(&body.to_string()).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn rejects_unsuccessful_or_malformed_etherscan_history() {
        let unsuccessful = serde_json::json!({
            "status": "0",
            "message": "NOTOK",
            "result": [],
        });
        assert!(matches!(
            parse_etherscan_history_response(&unsuccessful.to_string()),
            Err(EvmServiceError::HistoryUnavailable)
        ));

        let malformed = serde_json::json!({
            "status": "1",
            "message": "OK",
            "result": [{ "hash": "not-a-transaction-hash", "blockNumber": "1" }],
        });
        assert!(matches!(
            parse_etherscan_history_response(&malformed.to_string()),
            Err(EvmServiceError::HistoryUnavailable)
        ));
    }

    #[test]
    fn bounds_etherscan_history_response_bodies() {
        let oversized = std::io::Cursor::new(vec![b'x'; MAX_ETHERSCAN_RESPONSE_BYTES + 1]);
        assert!(matches!(
            read_etherscan_response(oversized),
            Err(EvmServiceError::RpcUnavailable)
        ));
    }
}
