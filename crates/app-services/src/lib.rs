//! Shared application service contracts for desktop and mobile frontends.
//!
//! Mobile v1 includes wallet management, assets, payments, 2FA, Pump trading,
//! dApp signing, and Squads multisig. It intentionally excludes Program deploy,
//! Program upgrade, source builds, and generic Program invocation.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use bip39::{Language, Mnemonic};
use fnzero_safe::{KeyManager, Keypair, Pubkey, Signer};
use fnzero_safe_evm_services as evm;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_account_decoder_client_types::UiAccountData;
use solana_client::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_derivation_path::DerivationPath;
use solana_rpc_client_types::request::TokenAccountsFilter;
use solana_sdk::{
    instruction::Instruction,
    sanitize::Sanitize,
    signature::Signature,
    signer::keypair::{
        generate_seed_from_seed_phrase_and_passphrase, keypair_from_seed_and_derivation_path,
    },
    transaction::{Transaction, VersionedTransaction},
};
use std::fmt::Write as _;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

mod squads_v4;

pub mod capabilities {
    pub const WALLET_MANAGEMENT: &str = "wallet_management";
    pub const ASSETS: &str = "assets";
    pub const PAYMENTS: &str = "payments";
    pub const TWO_FACTOR: &str = "two_factor";
    pub const PUMP_TRADING: &str = "pump_trading";
    pub const DAPP_SIGNING: &str = "dapp_signing";
    pub const SQUADS_MULTISIG: &str = "squads_multisig";
    pub const EVM_CHAINS: &str = "evm_chains";
    pub const EVM_WALLETS: &str = "evm_wallets";
    pub const EVM_ASSETS: &str = "evm_assets";
    pub const EVM_PAYMENTS: &str = "evm_payments";
    pub const EVM_DAPP_SIGNING: &str = "evm_dapp_signing";
}

const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFQYJYYo8M2ee9VhgC3Q";
const DEFAULT_MNEMONIC_DERIVATION_PATH: &str = "m/44'/501'/0'/0'";
const SOLANA_TRANSACTION_PACKET_DATA_BYTES: usize = 1232;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppSurface {
    Desktop,
    Mobile,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppNetwork {
    #[default]
    Mainnet,
    Devnet,
    Testnet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MobileErrorCode {
    InvalidInput,
    WrongPassword,
    RpcUnavailable,
    InsufficientFunds,
    UserRejected,
    BiometricCancelled,
    TotpInvalid,
    UnsupportedChain,
    GasEstimateFailed,
    InvalidChainId,
    InvalidTypedData,
    HistoryUnavailable,
    Unsupported,
    NotImplemented,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChainFamily {
    Solana,
    Evm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WalletFamily {
    Solana,
    Evm,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppChain {
    pub family: ChainFamily,
    pub chain_id: Option<u64>,
    pub network: Option<AppNetwork>,
    pub name: String,
    pub native_symbol: String,
    pub rpc_url: Option<String>,
    pub explorer_url: Option<String>,
    pub testnet: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MobileError {
    pub code: MobileErrorCode,
    pub message: String,
}

impl MobileError {
    pub fn new(code: MobileErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
pub enum AppServiceError {
    #[error("{0}")]
    Message(String),
    #[error("{message}")]
    Mobile {
        code: MobileErrorCode,
        message: String,
    },
    #[error("unsupported on {surface:?}: {capability}")]
    Unsupported {
        surface: AppSurface,
        capability: &'static str,
    },
}

impl AppServiceError {
    pub fn mobile(code: MobileErrorCode, message: impl Into<String>) -> Self {
        Self::Mobile {
            code,
            message: message.into(),
        }
    }

    pub fn to_mobile_error(&self) -> MobileError {
        match self {
            Self::Message(message) => MobileError::new(MobileErrorCode::InvalidInput, message),
            Self::Mobile { code, message } => MobileError::new(*code, message),
            Self::Unsupported { capability, .. } => MobileError::new(
                MobileErrorCode::Unsupported,
                format!("{capability} is not available on this surface"),
            ),
        }
    }
}

pub type AppServiceResult<T> = Result<T, AppServiceError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SurfaceCapabilities {
    pub surface: AppSurface,
    pub enabled: Vec<&'static str>,
    pub excluded: Vec<&'static str>,
}

pub fn mobile_capabilities() -> SurfaceCapabilities {
    SurfaceCapabilities {
        surface: AppSurface::Mobile,
        enabled: vec![
            capabilities::WALLET_MANAGEMENT,
            capabilities::ASSETS,
            capabilities::PAYMENTS,
            capabilities::TWO_FACTOR,
            capabilities::PUMP_TRADING,
            capabilities::DAPP_SIGNING,
            capabilities::SQUADS_MULTISIG,
            capabilities::EVM_CHAINS,
            capabilities::EVM_WALLETS,
            capabilities::EVM_ASSETS,
            capabilities::EVM_PAYMENTS,
            capabilities::EVM_DAPP_SIGNING,
        ],
        excluded: vec![
            "program_deploy",
            "program_upgrade",
            "program_source_build",
            "program_invoke",
        ],
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletSummary {
    pub id: String,
    pub name: String,
    pub public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmChainConfig {
    pub chain_id: u64,
    pub name: String,
    pub native_symbol: String,
    pub rpc_url: String,
    pub explorer_url: Option<String>,
    pub testnet: bool,
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
pub struct CreateWalletRequest {
    pub name: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportKeystoreRequest {
    pub name: String,
    pub keystore_json: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportPrivateKeyRequest {
    pub name: String,
    pub private_key_base58: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportMnemonicRequest {
    pub name: String,
    pub mnemonic: String,
    pub derivation_path: Option<String>,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnlockWalletRequest {
    pub keystore_json: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportPrivateKeyRequest {
    pub keystore_json: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportPrivateKeyResponse {
    pub public_key: String,
    pub private_key_base58: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletKeystore {
    pub wallet: WalletSummary,
    pub keystore_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnlockWalletResponse {
    pub wallet: WalletSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssetSummary {
    pub token_account: String,
    pub mint: String,
    pub symbol: String,
    pub name: String,
    pub amount: String,
    pub raw_amount: String,
    pub decimals: u8,
    pub logo_uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransactionHistoryEntry {
    pub signature: String,
    pub slot: u64,
    pub block_time: Option<i64>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssetSnapshot {
    pub network: AppNetwork,
    pub wallet_public_key: String,
    pub sol_balance_lamports: u64,
    pub tokens: Vec<AssetSummary>,
    pub recent_transactions: Vec<TransactionHistoryEntry>,
    pub refreshed_at_ms: u64,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetQueryRequest {
    pub network: AppNetwork,
    pub wallet_public_key: String,
    pub rpc_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentPreviewRequest {
    pub network: AppNetwork,
    pub wallet_public_key: String,
    pub recipient: String,
    pub mint: Option<String>,
    pub amount: String,
    pub operation: PaymentOperation,
    pub amount_base_units: u64,
    pub memo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SigningPreview {
    pub id: String,
    pub title: String,
    pub network: AppNetwork,
    pub wallet_public_key: String,
    pub summary: String,
    pub warnings: Vec<String>,
    pub requires_user_confirmation: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentOperation {
    SolTransfer,
    SplTokenTransfer,
    WsolWrap,
    WsolUnwrap,
    WsolCloseAta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentSubmitRequest {
    pub preview_id: String,
    pub approved: bool,
    pub network: AppNetwork,
    pub rpc_url: Option<String>,
    pub wallet_public_key: String,
    pub keystore_json: String,
    pub password: String,
    pub operation: PaymentOperation,
    pub recipient: Option<String>,
    pub mint: Option<String>,
    pub amount_base_units: u64,
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
pub struct TransactionSubmitResult {
    pub signature: String,
    pub slot: Option<u64>,
    pub network: AppNetwork,
    pub submitted_at: String,
    pub status: String,
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
pub struct PumpPreviewRequest {
    pub network: AppNetwork,
    pub wallet_public_key: String,
    pub mint: String,
    pub sell_percent_bps: u32,
    pub slippage_bps: u32,
    pub venue: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DappSignPreviewRequest {
    pub network: AppNetwork,
    pub wallet_public_key: String,
    pub app_name: String,
    pub app_url: String,
    pub method: String,
    pub payload_base64: String,
    pub transaction_format: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DappSignSubmitRequest {
    pub preview_id: String,
    pub approved: bool,
    pub network: AppNetwork,
    pub rpc_url: Option<String>,
    pub wallet_public_key: String,
    pub keystore_json: String,
    pub password: String,
    pub app_name: String,
    pub app_url: String,
    pub method: String,
    pub payload_base64: String,
    pub transaction_format: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DappSignSubmitResult {
    pub signature: Option<String>,
    pub signature_base64: Option<String>,
    pub signed_payload_base64: Option<String>,
    pub signed_payloads_base64: Vec<String>,
    pub transaction: Option<TransactionSubmitResult>,
    pub status: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsPreviewRequest {
    pub network: AppNetwork,
    pub wallet_public_key: String,
    pub multisig: String,
    pub proposal: Option<String>,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsMemberSummary {
    pub key: String,
    pub permissions: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsProposalSummary {
    pub address: String,
    pub transaction_index: u64,
    pub status: String,
    pub approved: Vec<String>,
    pub rejected: Vec<String>,
    pub cancelled: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsInfoRequest {
    pub network: AppNetwork,
    pub rpc_url: Option<String>,
    pub multisig: String,
    pub proposal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsInfoResponse {
    pub multisig: String,
    pub vault: String,
    pub create_key: String,
    pub threshold: u16,
    pub time_lock: u32,
    pub transaction_index: u64,
    pub stale_transaction_index: u64,
    pub members: Vec<SquadsMemberSummary>,
    pub proposal: Option<SquadsProposalSummary>,
    pub network: AppNetwork,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsProposalsRequest {
    pub network: AppNetwork,
    pub rpc_url: Option<String>,
    pub multisig: String,
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsProposalsResponse {
    pub multisig: String,
    pub vault: String,
    pub proposals: Vec<SquadsProposalSummary>,
    pub latest_transaction_index: u64,
    pub network: AppNetwork,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsCreateSubmitRequest {
    pub approved: bool,
    pub network: AppNetwork,
    pub rpc_url: Option<String>,
    pub keystore_json: String,
    pub password: String,
    pub members: Vec<String>,
    pub threshold: u16,
    pub time_lock: Option<u32>,
    pub memo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsCreateSubmitResult {
    pub multisig: String,
    pub vault: String,
    pub create_key: String,
    pub signature: String,
    pub threshold: u16,
    pub members: Vec<SquadsMemberSummary>,
    pub creation_fee_lamports: u64,
    pub network: AppNetwork,
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SquadsTransferKind {
    Sol,
    SplToken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsTransferProposalSubmitRequest {
    pub approved: bool,
    pub network: AppNetwork,
    pub rpc_url: Option<String>,
    pub keystore_json: String,
    pub password: String,
    pub multisig: String,
    pub kind: SquadsTransferKind,
    pub recipient: Option<String>,
    pub destination_token_account: Option<String>,
    pub source_token_account: Option<String>,
    pub mint: Option<String>,
    pub amount_base_units: u64,
    pub decimals: Option<u8>,
    pub memo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsProposalCreateSubmitResult {
    pub multisig: String,
    pub vault: String,
    pub transaction: String,
    pub proposal: String,
    pub transaction_index: u64,
    pub signature: String,
    pub network: AppNetwork,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsVoteSubmitRequest {
    pub approved: bool,
    pub network: AppNetwork,
    pub rpc_url: Option<String>,
    pub keystore_json: String,
    pub password: String,
    pub multisig: String,
    pub proposal: String,
    pub memo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SquadsExecuteSubmitRequest {
    pub approved: bool,
    pub network: AppNetwork,
    pub rpc_url: Option<String>,
    pub keystore_json: String,
    pub password: String,
    pub multisig: String,
    pub proposal: String,
    pub transaction_index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TotpSetup {
    pub secret: String,
    pub issuer: String,
    pub account: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TotpVerifyRequest {
    pub secret: String,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BiometricPolicy {
    pub supported: bool,
    pub configured: bool,
    pub reason: Option<String>,
}

fn require_non_empty(value: &str, field: &'static str) -> AppServiceResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("{field} is required"),
        ));
    }
    Ok(trimmed.to_string())
}

fn require_pubkey(value: &str, field: &'static str) -> AppServiceResult<Pubkey> {
    let value = require_non_empty(value, field)?;
    Pubkey::from_str(&value).map_err(|_| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("{field} must be a valid Solana public key"),
        )
    })
}

struct SolanaPaymentPreviewIdInput<'a> {
    network: AppNetwork,
    wallet_public_key: &'a str,
    operation: PaymentOperation,
    recipient: Option<&'a str>,
    mint: Option<&'a str>,
    amount_base_units: u64,
}

struct SolanaDappPreviewIdInput<'a> {
    network: AppNetwork,
    wallet_public_key: &'a str,
    app_name: &'a str,
    app_url: &'a str,
    method: &'a str,
    payload_base64: &'a str,
    transaction_format: Option<&'a str>,
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut hex, "{byte:02x}").expect("writing to String cannot fail");
    }
    hex
}

fn solana_payment_preview_id(input: &SolanaPaymentPreviewIdInput<'_>) -> String {
    let material = serde_json::json!({
        "scope": "fnzero-safe-solana-payment-preview-v1",
        "network": input.network,
        "wallet_public_key": input.wallet_public_key,
        "operation": input.operation,
        "recipient": input.recipient,
        "mint": input.mint,
        "amount_base_units": input.amount_base_units,
    });
    format!(
        "solana-payment:{}",
        sha256_hex(material.to_string().as_bytes())
    )
}

fn solana_dapp_preview_id(input: &SolanaDappPreviewIdInput<'_>) -> String {
    let material = serde_json::json!({
        "scope": "fnzero-safe-solana-dapp-preview-v1",
        "network": input.network,
        "wallet_public_key": input.wallet_public_key,
        "app_name": input.app_name,
        "app_url": input.app_url,
        "method": input.method,
        "payload_base64": input.payload_base64,
        "transaction_format": input.transaction_format,
    });
    format!(
        "solana-dapp:{}",
        sha256_hex(material.to_string().as_bytes())
    )
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

fn rpc_url(network: AppNetwork, override_url: Option<String>) -> AppServiceResult<String> {
    if let Some(url) = override_url {
        return require_non_empty(&url, "RPC URL");
    }

    Ok(match network {
        AppNetwork::Mainnet => "https://api.mainnet-beta.solana.com",
        AppNetwork::Devnet => "https://api.devnet.solana.com",
        AppNetwork::Testnet => "https://api.testnet.solana.com",
    }
    .to_string())
}

fn parse_token_amount(parsed: &serde_json::Value) -> Option<(String, String, u8)> {
    let info = parsed.get("info")?;
    let amount = info.get("tokenAmount")?;
    let raw_amount = amount.get("amount")?.as_str()?.to_string();
    let decimals = amount
        .get("decimals")?
        .as_u64()
        .and_then(|value| u8::try_from(value).ok())?;
    let ui_amount = amount
        .get("uiAmountString")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| raw_amount.clone());

    Some((ui_amount, raw_amount, decimals))
}

fn token_account_from_json(pubkey: String, parsed: &serde_json::Value) -> Option<AssetSummary> {
    let info = parsed.get("info")?;
    let mint = info.get("mint")?.as_str()?.to_string();
    let (amount, raw_amount, decimals) = parse_token_amount(parsed)?;

    if raw_amount == "0" {
        return None;
    }

    let short_mint = if mint.len() > 8 {
        format!("{}...{}", &mint[..4], &mint[mint.len() - 4..])
    } else {
        mint.clone()
    };

    Some(AssetSummary {
        token_account: pubkey,
        mint,
        symbol: "SPL".to_string(),
        name: format!("Token {short_mint}"),
        amount,
        raw_amount,
        decimals,
        logo_uri: None,
    })
}

fn token_accounts_for_program(
    client: &RpcClient,
    wallet_pubkey: &Pubkey,
    token_program: &str,
) -> AppServiceResult<Vec<AssetSummary>> {
    let token_program = Pubkey::from_str(token_program).map_err(|_| {
        AppServiceError::mobile(MobileErrorCode::InvalidInput, "Invalid token program")
    })?;
    let accounts = client
        .get_token_accounts_by_owner(wallet_pubkey, TokenAccountsFilter::ProgramId(token_program))
        .map_err(map_rpc_error)?;

    Ok(accounts
        .into_iter()
        .filter_map(|account| match account.account.data {
            UiAccountData::Json(parsed) => token_account_from_json(account.pubkey, &parsed.parsed),
            _ => None,
        })
        .collect())
}

fn map_rpc_error(message: impl ToString) -> AppServiceError {
    let message = message.to_string();
    let lower = message.to_lowercase();

    if lower.contains("insufficient") || lower.contains("balance") {
        return AppServiceError::mobile(MobileErrorCode::InsufficientFunds, "Insufficient funds");
    }

    AppServiceError::mobile(
        MobileErrorCode::RpcUnavailable,
        "Solana RPC request failed; check network and RPC settings",
    )
}

fn map_evm_error(error: evm::EvmServiceError) -> AppServiceError {
    use evm::EvmServiceError;
    match error {
        EvmServiceError::InvalidInput(message) => {
            AppServiceError::mobile(MobileErrorCode::InvalidInput, message)
        }
        EvmServiceError::WrongPassword => {
            AppServiceError::mobile(MobileErrorCode::WrongPassword, "Wrong password")
        }
        EvmServiceError::UnsupportedChain => {
            AppServiceError::mobile(MobileErrorCode::UnsupportedChain, "Unsupported EVM chain")
        }
        EvmServiceError::RpcUnavailable => AppServiceError::mobile(
            MobileErrorCode::RpcUnavailable,
            "EVM RPC request failed; check chain and RPC settings",
        ),
        EvmServiceError::GasEstimateFailed => AppServiceError::mobile(
            MobileErrorCode::GasEstimateFailed,
            "EVM gas estimation failed",
        ),
        EvmServiceError::InsufficientFunds => {
            AppServiceError::mobile(MobileErrorCode::InsufficientFunds, "Insufficient funds")
        }
        EvmServiceError::InvalidChainId => {
            AppServiceError::mobile(MobileErrorCode::InvalidChainId, "Invalid EVM chain id")
        }
        EvmServiceError::UserRejected => AppServiceError::mobile(
            MobileErrorCode::UserRejected,
            "User rejected the signing request",
        ),
        EvmServiceError::InvalidTypedData => {
            AppServiceError::mobile(MobileErrorCode::InvalidTypedData, "Invalid EVM typed data")
        }
        EvmServiceError::HistoryUnavailable => AppServiceError::mobile(
            MobileErrorCode::HistoryUnavailable,
            "EVM transaction history is unavailable",
        ),
    }
}

impl From<evm::EvmChainConfig> for EvmChainConfig {
    fn from(value: evm::EvmChainConfig) -> Self {
        Self {
            chain_id: value.chain_id,
            name: value.name,
            native_symbol: value.native_symbol,
            rpc_url: value.rpc_url,
            explorer_url: value.explorer_url,
            testnet: value.testnet,
        }
    }
}

impl From<EvmChainConfig> for evm::EvmChainConfig {
    fn from(value: EvmChainConfig) -> Self {
        Self {
            chain_id: value.chain_id,
            name: value.name,
            native_symbol: value.native_symbol,
            rpc_url: value.rpc_url,
            explorer_url: value.explorer_url,
            testnet: value.testnet,
        }
    }
}

impl From<evm::EvmWalletSummary> for EvmWalletSummary {
    fn from(value: evm::EvmWalletSummary) -> Self {
        Self {
            id: value.id,
            name: value.name,
            address: value.address,
            derivation_path: value.derivation_path,
        }
    }
}

impl From<evm::EvmWalletKeystore> for EvmWalletKeystore {
    fn from(value: evm::EvmWalletKeystore) -> Self {
        Self {
            wallet: value.wallet.into(),
            keystore_json: value.keystore_json,
        }
    }
}

impl From<EvmTokenQuery> for evm::EvmTokenQuery {
    fn from(value: EvmTokenQuery) -> Self {
        Self {
            contract_address: value.contract_address,
        }
    }
}

impl From<evm::EvmTokenAsset> for EvmTokenAsset {
    fn from(value: evm::EvmTokenAsset) -> Self {
        Self {
            contract_address: value.contract_address,
            symbol: value.symbol,
            name: value.name,
            balance: value.balance,
            decimals: value.decimals,
        }
    }
}

impl From<evm::EvmTransactionHistoryEntry> for EvmTransactionHistoryEntry {
    fn from(value: evm::EvmTransactionHistoryEntry) -> Self {
        Self {
            hash: value.hash,
            block_number: value.block_number,
            status: value.status,
        }
    }
}

impl From<evm::EvmAssetSnapshot> for EvmAssetSnapshot {
    fn from(value: evm::EvmAssetSnapshot) -> Self {
        Self {
            chain: value.chain.into(),
            wallet_address: value.wallet_address,
            native_balance_wei: value.native_balance_wei,
            tokens: value.tokens.into_iter().map(Into::into).collect(),
            recent_transactions: value
                .recent_transactions
                .into_iter()
                .map(Into::into)
                .collect(),
            history_status: value.history_status,
            history_message: value.history_message,
            refreshed_at_ms: value.refreshed_at_ms,
        }
    }
}

impl From<evm::EvmPaymentPreview> for EvmPaymentPreview {
    fn from(value: evm::EvmPaymentPreview) -> Self {
        Self {
            preview_id: value.preview_id,
            chain: value.chain.into(),
            wallet_address: value.wallet_address,
            recipient: value.recipient,
            token_contract: value.token_contract,
            amount_wei_or_units: value.amount_wei_or_units,
            gas_limit: value.gas_limit,
            gas_price_wei: value.gas_price_wei,
            max_fee_per_gas_wei: value.max_fee_per_gas_wei,
            max_priority_fee_per_gas_wei: value.max_priority_fee_per_gas_wei,
            fee_model: value.fee_model,
            nonce: value.nonce,
            estimated_fee_wei: value.estimated_fee_wei,
            summary: value.summary,
            warnings: value.warnings,
        }
    }
}

impl From<evm::EvmTransactionSubmitResult> for EvmTransactionSubmitResult {
    fn from(value: evm::EvmTransactionSubmitResult) -> Self {
        Self {
            transaction_hash: value.transaction_hash,
            chain: value.chain.into(),
            submitted_at: value.submitted_at,
            status: value.status,
            block_number: value.block_number,
        }
    }
}

impl From<evm::EvmTransactionStatus> for EvmTransactionStatus {
    fn from(value: evm::EvmTransactionStatus) -> Self {
        Self {
            transaction_hash: value.transaction_hash,
            chain: value.chain.into(),
            block_number: value.block_number,
            status: value.status,
            gas_used: value.gas_used,
            effective_gas_price_wei: value.effective_gas_price_wei,
        }
    }
}

impl From<evm::EvmDappSignPreview> for EvmDappSignPreview {
    fn from(value: evm::EvmDappSignPreview) -> Self {
        Self {
            preview_id: value.preview_id,
            chain: value.chain.into(),
            wallet_address: value.wallet_address,
            app_name: value.app_name,
            app_url: value.app_url,
            method: value.method,
            summary: value.summary,
            warnings: value.warnings,
        }
    }
}

impl From<evm::EvmDappSignSubmitResult> for EvmDappSignSubmitResult {
    fn from(value: evm::EvmDappSignSubmitResult) -> Self {
        Self {
            signature: value.signature,
            signed_transaction: value.signed_transaction,
            transaction: value.transaction.map(Into::into),
            status: value.status,
        }
    }
}

fn keypair_from_mobile_keystore(keystore_json: &str, password: &str) -> AppServiceResult<Keypair> {
    require_non_empty(keystore_json, "keystore json")?;
    require_non_empty(password, "wallet password")?;
    KeyManager::keypair_from_encrypted_json(keystore_json, password)
        .map_err(|_| AppServiceError::mobile(MobileErrorCode::WrongPassword, "Wrong password"))
}

fn keypair_from_selected_mobile_wallet(
    wallet_public_key: &str,
    keystore_json: &str,
    password: &str,
) -> AppServiceResult<Keypair> {
    let expected_wallet_pubkey = require_pubkey(wallet_public_key, "wallet public key")?;
    let keypair = keypair_from_mobile_keystore(keystore_json, password)?;
    if keypair.pubkey() != expected_wallet_pubkey {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Keystore does not match the selected wallet",
        ));
    }
    Ok(keypair)
}

fn sign_and_send_instructions(
    client: &RpcClient,
    instructions: Vec<Instruction>,
    signers: &[&Keypair],
    payer: &Pubkey,
) -> AppServiceResult<Signature> {
    let blockhash = client.get_latest_blockhash().map_err(map_rpc_error)?;
    let tx = Transaction::new_signed_with_payer(&instructions, Some(payer), signers, blockhash);
    client
        .send_and_confirm_transaction(&tx)
        .map_err(map_rpc_error)
}

fn sign_and_send_single(
    client: &RpcClient,
    instruction: Instruction,
    signer: &Keypair,
) -> AppServiceResult<Signature> {
    sign_and_send_instructions(client, vec![instruction], &[signer], &signer.pubkey())
}

fn load_squads_multisig(
    client: &RpcClient,
    multisig: &Pubkey,
) -> AppServiceResult<squads_v4::Multisig> {
    let account = client.get_account(multisig).map_err(map_rpc_error)?;
    if account.owner != squads_v4::SQUADS_PROGRAM_ID || account.executable {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Address is not a Squads v4 multisig account",
        ));
    }
    let state = squads_v4::decode_account::<squads_v4::Multisig>(&account.data, "Multisig")
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))?;
    let (expected_multisig, expected_bump) = squads_v4::multisig_pda_with_bump(&state.create_key);
    if expected_multisig != *multisig || expected_bump != state.bump {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Squads multisig address does not match its create key",
        ));
    }
    Ok(state)
}

fn load_squads_proposal(
    client: &RpcClient,
    proposal: &Pubkey,
) -> AppServiceResult<squads_v4::Proposal> {
    let account = client.get_account(proposal).map_err(map_rpc_error)?;
    squads_v4::decode_account::<squads_v4::Proposal>(&account.data, "Proposal")
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))
}

fn load_squads_vault_transaction(
    client: &RpcClient,
    transaction: &Pubkey,
) -> AppServiceResult<squads_v4::VaultTransaction> {
    let account = client.get_account(transaction).map_err(map_rpc_error)?;
    squads_v4::decode_account::<squads_v4::VaultTransaction>(&account.data, "VaultTransaction")
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))
}

fn load_squads_program_config(client: &RpcClient) -> AppServiceResult<squads_v4::ProgramConfig> {
    let program_config = squads_v4::program_config_pda();
    let account = client.get_account(&program_config).map_err(map_rpc_error)?;
    squads_v4::decode_account::<squads_v4::ProgramConfig>(&account.data, "ProgramConfig")
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))
}

fn next_squads_transaction_index(multisig: &squads_v4::Multisig) -> AppServiceResult<u64> {
    multisig.transaction_index.checked_add(1).ok_or_else(|| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Squads transaction index is out of range",
        )
    })
}

fn require_squads_member(multisig: &squads_v4::Multisig, signer: &Pubkey) -> AppServiceResult<()> {
    if multisig.members.iter().any(|member| member.key == *signer) {
        Ok(())
    } else {
        Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Selected wallet is not a member of this Squads multisig",
        ))
    }
}

fn squads_member_summary(member: squads_v4::Member) -> SquadsMemberSummary {
    SquadsMemberSummary {
        key: member.key.to_string(),
        permissions: member.permissions.mask,
    }
}

fn squads_proposal_summary(
    address: Pubkey,
    proposal: squads_v4::Proposal,
) -> SquadsProposalSummary {
    SquadsProposalSummary {
        address: address.to_string(),
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
    }
}

fn transaction_result(
    signature: Signature,
    network: AppNetwork,
    status: impl Into<String>,
) -> TransactionSubmitResult {
    TransactionSubmitResult {
        signature: signature.to_string(),
        slot: None,
        network,
        submitted_at: submitted_at(),
        status: status.into(),
    }
}

fn decode_transaction_bytes(transaction_base64: &str) -> AppServiceResult<Vec<u8>> {
    let transaction_base64 = require_non_empty(transaction_base64, "transaction base64")?;
    let bytes = BASE64.decode(transaction_base64).map_err(|_| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Transaction payload must be valid base64",
        )
    })?;
    if bytes.is_empty() || bytes.len() > SOLANA_TRANSACTION_PACKET_DATA_BYTES {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!(
                "Transaction payload length is invalid; maximum is {SOLANA_TRANSACTION_PACKET_DATA_BYTES} bytes"
            ),
        ));
    }
    Ok(bytes)
}

fn decode_legacy_transaction(transaction_base64: &str) -> AppServiceResult<Transaction> {
    let bytes = decode_transaction_bytes(transaction_base64)?;
    bincode::deserialize::<Transaction>(&bytes).map_err(|error| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("Legacy transaction decode failed: {error}"),
        )
    })
}

fn decode_versioned_transaction(
    transaction_base64: &str,
) -> AppServiceResult<VersionedTransaction> {
    let bytes = decode_transaction_bytes(transaction_base64)?;
    bincode::deserialize::<VersionedTransaction>(&bytes).map_err(|error| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("Versioned transaction decode failed: {error}"),
        )
    })
}

fn encode_legacy_transaction(transaction: &Transaction) -> AppServiceResult<String> {
    bincode::serialize(transaction)
        .map(|bytes| BASE64.encode(bytes))
        .map_err(|error| {
            AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                format!("Signed transaction encode failed: {error}"),
            )
        })
}

fn encode_versioned_transaction(transaction: &VersionedTransaction) -> AppServiceResult<String> {
    bincode::serialize(transaction)
        .map(|bytes| BASE64.encode(bytes))
        .map_err(|error| {
            AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                format!("Signed versioned transaction encode failed: {error}"),
            )
        })
}

enum SignedDappTransaction {
    Legacy(Transaction),
    Versioned(VersionedTransaction),
}

impl SignedDappTransaction {
    fn signature(&self) -> AppServiceResult<Signature> {
        let signature = match self {
            Self::Legacy(transaction) => transaction.signatures.first(),
            Self::Versioned(transaction) => transaction.signatures.first(),
        }
        .copied()
        .ok_or_else(|| {
            AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                "Signed transaction is missing a signature",
            )
        })?;
        if signature == Signature::default() {
            return Err(AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                "Transaction was not signed",
            ));
        }
        Ok(signature)
    }

    fn raw_base64(&self) -> AppServiceResult<String> {
        match self {
            Self::Legacy(transaction) => encode_legacy_transaction(transaction),
            Self::Versioned(transaction) => encode_versioned_transaction(transaction),
        }
    }

    fn submit(&self, client: &RpcClient) -> AppServiceResult<Signature> {
        match self {
            Self::Legacy(transaction) => client
                .send_and_confirm_transaction(transaction)
                .map_err(map_rpc_error),
            Self::Versioned(transaction) => client
                .send_and_confirm_transaction(transaction)
                .map_err(map_rpc_error),
        }
    }
}

fn sign_legacy_dapp_transaction(
    transaction_base64: &str,
    required_signer: &Pubkey,
    signing_keypair: &Keypair,
) -> AppServiceResult<Transaction> {
    let mut transaction = decode_legacy_transaction(transaction_base64)?;
    transaction.sanitize().map_err(|error| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("Legacy transaction sanitize failed: {error:?}"),
        )
    })?;
    let required_signature_count = transaction.message.header.num_required_signatures as usize;
    let signing_position = transaction
        .message
        .account_keys
        .get(0..required_signature_count)
        .and_then(|signers| signers.iter().position(|pubkey| pubkey == required_signer))
        .ok_or_else(|| {
            AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                "Transaction does not require the selected wallet as signer",
            )
        })?;
    if signing_position >= transaction.signatures.len() {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Transaction signature array does not match signer count",
        ));
    }

    let recent_blockhash = transaction.message.recent_blockhash;
    transaction
        .try_partial_sign(&[signing_keypair], recent_blockhash)
        .map_err(|error| {
            AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                format!("Legacy transaction signing failed: {error}"),
            )
        })?;
    let signer_signature = transaction
        .signatures
        .get(signing_position)
        .ok_or_else(|| {
            AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                "Transaction signature array does not match signer count",
            )
        })?;
    if !signer_signature.verify(required_signer.as_ref(), &transaction.message_data()) {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Generated transaction signature failed verification",
        ));
    }
    Ok(transaction)
}

fn sign_versioned_dapp_transaction(
    transaction_base64: &str,
    required_signer: &Pubkey,
    signing_keypair: &Keypair,
) -> AppServiceResult<VersionedTransaction> {
    let mut transaction = decode_versioned_transaction(transaction_base64)?;
    transaction.sanitize().map_err(|error| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("Versioned transaction sanitize failed: {error:?}"),
        )
    })?;
    let required_signature_count = transaction.message.header().num_required_signatures as usize;
    let signing_position = transaction
        .message
        .static_account_keys()
        .get(0..required_signature_count)
        .and_then(|signers| signers.iter().position(|pubkey| pubkey == required_signer))
        .ok_or_else(|| {
            AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                "Versioned transaction does not require the selected wallet as signer",
            )
        })?;
    if signing_position >= transaction.signatures.len() {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Versioned transaction signature array does not match signer count",
        ));
    }

    let signature = signing_keypair
        .try_sign_message(&transaction.message.serialize())
        .map_err(|error| {
            AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                format!("Versioned transaction signing failed: {error}"),
            )
        })?;
    transaction.signatures[signing_position] = signature;
    let signer_signature = transaction
        .signatures
        .get(signing_position)
        .ok_or_else(|| {
            AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                "Versioned transaction signature array does not match signer count",
            )
        })?;
    if !signer_signature.verify(required_signer.as_ref(), &transaction.message.serialize()) {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Generated versioned transaction signature failed verification",
        ));
    }
    Ok(transaction)
}

fn sign_dapp_transaction(
    transaction_base64: &str,
    transaction_format: Option<&str>,
    required_signer: &Pubkey,
    signing_keypair: &Keypair,
) -> AppServiceResult<SignedDappTransaction> {
    let format = transaction_format
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto")
        .to_ascii_lowercase();

    match format.as_str() {
        "legacy" => Ok(SignedDappTransaction::Legacy(sign_legacy_dapp_transaction(
            transaction_base64,
            required_signer,
            signing_keypair,
        )?)),
        "versioned" | "v0" => Ok(SignedDappTransaction::Versioned(
            sign_versioned_dapp_transaction(transaction_base64, required_signer, signing_keypair)?,
        )),
        "auto" => match sign_versioned_dapp_transaction(
            transaction_base64,
            required_signer,
            signing_keypair,
        ) {
            Ok(transaction) => Ok(SignedDappTransaction::Versioned(transaction)),
            Err(versioned_error) => Ok(SignedDappTransaction::Legacy(
                sign_legacy_dapp_transaction(transaction_base64, required_signer, signing_keypair)
                    .map_err(|legacy_error| {
                        AppServiceError::mobile(
                            MobileErrorCode::InvalidInput,
                            format!(
                                "Transaction could not be signed as versioned or legacy; versioned: {}; legacy: {}",
                                versioned_error.to_mobile_error().message,
                                legacy_error.to_mobile_error().message
                            ),
                        )
                    })?,
            )),
        },
        _ => Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "transaction_format must be auto, legacy, versioned, or v0",
        )),
    }
}

fn decode_dapp_transaction_batch(batch_base64: &str) -> AppServiceResult<Vec<String>> {
    let bytes = BASE64.decode(batch_base64).map_err(|_| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Transaction batch payload must be valid base64",
        )
    })?;
    let payload = String::from_utf8(bytes).map_err(|_| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Transaction batch payload must be UTF-8 JSON",
        )
    })?;
    let transactions: Vec<String> = serde_json::from_str(&payload).map_err(|_| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Transaction batch payload must be a JSON array of base64 transactions",
        )
    })?;
    if transactions.is_empty() || transactions.len() > 16 {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "signAllTransactions requires 1 to 16 transactions",
        ));
    }
    Ok(transactions)
}

fn require_positive_amount(amount: u64, field: &'static str) -> AppServiceResult<()> {
    if amount == 0 {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("{field} must be greater than zero"),
        ));
    }
    Ok(())
}

fn wallet_id(public_key: &str) -> String {
    format!(
        "wallet-{}-{}",
        &public_key[..4],
        &public_key[public_key.len() - 4..]
    )
}

fn normalize_mnemonic_phrase(phrase: &str) -> AppServiceResult<String> {
    let normalized = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Mnemonic is required",
        ));
    }

    let word_count = normalized.split_whitespace().count();
    if !matches!(word_count, 12 | 15 | 18 | 21 | 24) {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Mnemonic must contain 12, 15, 18, 21, or 24 words",
        ));
    }

    Mnemonic::parse_in_normalized(Language::English, &normalized).map_err(|_| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Mnemonic checksum failed; check the words and order",
        )
    })?;
    Ok(normalized)
}

fn normalize_mnemonic_derivation_path(
    value: Option<&str>,
) -> AppServiceResult<(DerivationPath, String)> {
    let path = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_MNEMONIC_DERIVATION_PATH);
    let derivation_path = DerivationPath::from_absolute_path_str(path).map_err(|error| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("Invalid derivation path: {error}"),
        )
    })?;
    Ok((derivation_path, path.to_string()))
}

fn keypair_from_mnemonic_phrase(
    mnemonic: &str,
    derivation_path: &DerivationPath,
) -> AppServiceResult<Keypair> {
    let seed = generate_seed_from_seed_phrase_and_passphrase(mnemonic, "");
    keypair_from_seed_and_derivation_path(&seed, Some(derivation_path.clone())).map_err(|error| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("Failed to derive wallet from mnemonic: {error}"),
        )
    })
}

fn with_mobile_keystore_metadata(
    keystore_json: &str,
    wallet_name: &str,
    encrypted_mnemonic: Option<&str>,
    derivation_path: Option<&str>,
) -> AppServiceResult<String> {
    let mut value: serde_json::Value = serde_json::from_str(keystore_json).map_err(|error| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("Invalid generated keystore JSON: {error}"),
        )
    })?;
    let object = value.as_object_mut().ok_or_else(|| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Keystore JSON must be an object",
        )
    })?;
    let metadata = object
        .entry("metadata")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let metadata = metadata.as_object_mut().ok_or_else(|| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Keystore metadata must be an object",
        )
    })?;

    metadata.insert(
        "wallet_name".to_string(),
        serde_json::Value::String(wallet_name.to_string()),
    );
    if let Some(encrypted_mnemonic) = encrypted_mnemonic {
        metadata.insert(
            "encrypted_mnemonic".to_string(),
            serde_json::Value::String(encrypted_mnemonic.to_string()),
        );
    }
    if let Some(derivation_path) = derivation_path {
        metadata.insert(
            "mnemonic_derivation_path".to_string(),
            serde_json::Value::String(derivation_path.to_string()),
        );
    }

    serde_json::to_string(&value).map_err(|error| {
        AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            format!("Failed to encode keystore JSON: {error}"),
        )
    })
}

pub fn create_wallet(req: CreateWalletRequest) -> AppServiceResult<WalletKeystore> {
    let name = require_non_empty(&req.name, "wallet name")?;
    require_non_empty(&req.password, "wallet password")?;

    let keypair = KeyManager::generate_keypair();
    let public_key = keypair.pubkey().to_string();
    let keystore_json = KeyManager::keypair_to_encrypted_json(&keypair, &req.password)
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))?;
    let keystore_json = with_mobile_keystore_metadata(&keystore_json, &name, None, None)?;

    Ok(WalletKeystore {
        wallet: WalletSummary {
            id: wallet_id(&public_key),
            name,
            public_key,
        },
        keystore_json,
    })
}

pub fn evm_builtin_chains() -> Vec<EvmChainConfig> {
    evm::builtin_chains().into_iter().map(Into::into).collect()
}

pub fn evm_wallet_create(req: EvmCreateWalletRequest) -> AppServiceResult<EvmWalletKeystore> {
    evm::create_wallet(evm::EvmCreateWalletRequest {
        name: req.name,
        password: req.password,
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn evm_wallet_import_private_key(
    req: EvmImportPrivateKeyRequest,
) -> AppServiceResult<EvmWalletKeystore> {
    evm::import_private_key(evm::EvmImportPrivateKeyRequest {
        name: req.name,
        private_key_hex: req.private_key_hex,
        password: req.password,
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn evm_wallet_import_mnemonic(
    req: EvmImportMnemonicRequest,
) -> AppServiceResult<EvmWalletKeystore> {
    evm::import_mnemonic(evm::EvmImportMnemonicRequest {
        name: req.name,
        mnemonic: req.mnemonic,
        derivation_path: req.derivation_path,
        password: req.password,
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn evm_wallet_import_keystore(
    req: EvmImportKeystoreRequest,
) -> AppServiceResult<EvmWalletKeystore> {
    evm::import_keystore(evm::EvmImportKeystoreRequest {
        name: req.name,
        keystore_json: req.keystore_json,
        password: req.password,
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn evm_wallet_unlock(req: EvmUnlockWalletRequest) -> AppServiceResult<EvmWalletSummary> {
    evm::unlock_wallet(evm::EvmUnlockWalletRequest {
        keystore_json: req.keystore_json,
        password: req.password,
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn evm_wallet_export_private_key(
    req: EvmExportPrivateKeyRequest,
) -> AppServiceResult<EvmExportPrivateKeyResponse> {
    evm::export_private_key(evm::EvmExportPrivateKeyRequest {
        keystore_json: req.keystore_json,
        password: req.password,
    })
    .map(|value| EvmExportPrivateKeyResponse {
        address: value.address.clone(),
        private_key_hex: value.private_key_hex.clone(),
    })
    .map_err(map_evm_error)
}

pub fn import_keystore(req: ImportKeystoreRequest) -> AppServiceResult<WalletKeystore> {
    let name = require_non_empty(&req.name, "wallet name")?;
    require_non_empty(&req.keystore_json, "keystore json")?;
    require_non_empty(&req.password, "wallet password")?;

    let keypair = KeyManager::keypair_from_encrypted_json(&req.keystore_json, &req.password)
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::WrongPassword, message))?;
    let public_key = keypair.pubkey().to_string();

    Ok(WalletKeystore {
        wallet: WalletSummary {
            id: wallet_id(&public_key),
            name,
            public_key,
        },
        keystore_json: req.keystore_json,
    })
}

pub fn import_private_key(req: ImportPrivateKeyRequest) -> AppServiceResult<WalletKeystore> {
    let name = require_non_empty(&req.name, "wallet name")?;
    let private_key = require_non_empty(&req.private_key_base58, "private key")?;
    require_non_empty(&req.password, "wallet password")?;

    let keypair =
        std::panic::catch_unwind(|| Keypair::from_base58_string(&private_key)).map_err(|_| {
            AppServiceError::mobile(MobileErrorCode::InvalidInput, "Invalid private key")
        })?;
    let public_key = keypair.pubkey().to_string();
    let keystore_json = KeyManager::keypair_to_encrypted_json(&keypair, &req.password)
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))?;
    let keystore_json = with_mobile_keystore_metadata(&keystore_json, &name, None, None)?;

    Ok(WalletKeystore {
        wallet: WalletSummary {
            id: wallet_id(&public_key),
            name,
            public_key,
        },
        keystore_json,
    })
}

pub fn import_mnemonic(req: ImportMnemonicRequest) -> AppServiceResult<WalletKeystore> {
    let name = require_non_empty(&req.name, "wallet name")?;
    require_non_empty(&req.password, "wallet password")?;
    let mnemonic = normalize_mnemonic_phrase(&req.mnemonic)?;
    let (derivation_path, derivation_path_label) =
        normalize_mnemonic_derivation_path(req.derivation_path.as_deref())?;

    let keypair = keypair_from_mnemonic_phrase(&mnemonic, &derivation_path)?;
    let public_key = keypair.pubkey().to_string();
    let keystore_json = KeyManager::keypair_to_encrypted_json(&keypair, &req.password)
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))?;
    let keystore_json =
        with_mobile_keystore_metadata(&keystore_json, &name, None, Some(&derivation_path_label))?;

    Ok(WalletKeystore {
        wallet: WalletSummary {
            id: wallet_id(&public_key),
            name,
            public_key,
        },
        keystore_json,
    })
}

pub fn unlock_wallet(req: UnlockWalletRequest) -> AppServiceResult<UnlockWalletResponse> {
    require_non_empty(&req.keystore_json, "keystore json")?;
    require_non_empty(&req.password, "wallet password")?;

    let keypair = KeyManager::keypair_from_encrypted_json(&req.keystore_json, &req.password)
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::WrongPassword, message))?;
    let public_key = keypair.pubkey().to_string();

    Ok(UnlockWalletResponse {
        wallet: WalletSummary {
            id: wallet_id(&public_key),
            name: "Unlocked Wallet".to_string(),
            public_key,
        },
    })
}

pub fn export_private_key(
    req: ExportPrivateKeyRequest,
) -> AppServiceResult<ExportPrivateKeyResponse> {
    require_non_empty(&req.keystore_json, "keystore json")?;
    require_non_empty(&req.password, "wallet password")?;

    let keypair = KeyManager::keypair_from_encrypted_json(&req.keystore_json, &req.password)
        .map_err(|_| AppServiceError::mobile(MobileErrorCode::WrongPassword, "Wrong password"))?;

    Ok(ExportPrivateKeyResponse {
        public_key: keypair.pubkey().to_string(),
        private_key_base58: keypair.to_base58_string(),
    })
}

pub fn empty_asset_snapshot(network: AppNetwork, wallet_public_key: String) -> AssetSnapshot {
    AssetSnapshot {
        network,
        wallet_public_key,
        sol_balance_lamports: 0,
        tokens: Vec::new(),
        recent_transactions: Vec::new(),
        refreshed_at_ms: 0,
    }
}

pub fn load_asset_snapshot(req: AssetQueryRequest) -> AppServiceResult<AssetSnapshot> {
    let wallet_pubkey = require_pubkey(&req.wallet_public_key, "wallet public key")?;
    let rpc_url = rpc_url(req.network, req.rpc_url)?;
    let client = RpcClient::new(rpc_url.clone());
    let sol_balance_lamports = client.get_balance(&wallet_pubkey).map_err(map_rpc_error)?;

    let mut tokens = token_accounts_for_program(&client, &wallet_pubkey, TOKEN_PROGRAM_ID)?;
    tokens.extend(token_accounts_for_program(
        &client,
        &wallet_pubkey,
        TOKEN_2022_PROGRAM_ID,
    )?);
    tokens.sort_by(|left, right| left.mint.cmp(&right.mint));

    let recent_transactions = client
        .get_signatures_for_address(&wallet_pubkey)
        .map_err(map_rpc_error)?
        .into_iter()
        .take(20)
        .map(|entry| TransactionHistoryEntry {
            signature: entry.signature,
            slot: entry.slot,
            block_time: entry.block_time,
            status: entry
                .confirmation_status
                .map(|status| format!("{status:?}"))
                .unwrap_or_else(|| {
                    if entry.err.is_some() {
                        "failed".to_string()
                    } else {
                        "unknown".to_string()
                    }
                }),
        })
        .collect();

    Ok(AssetSnapshot {
        network: req.network,
        wallet_public_key: wallet_pubkey.to_string(),
        sol_balance_lamports,
        tokens,
        recent_transactions,
        refreshed_at_ms: now_ms(),
    })
}

pub fn evm_load_asset_snapshot(req: EvmAssetQueryRequest) -> AppServiceResult<EvmAssetSnapshot> {
    evm::load_asset_snapshot(evm::EvmAssetQueryRequest {
        chain: req.chain.into(),
        wallet_address: req.wallet_address,
        tokens: req.tokens.into_iter().map(Into::into).collect(),
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn evm_load_asset_balances_snapshot(
    req: EvmAssetQueryRequest,
) -> AppServiceResult<EvmAssetSnapshot> {
    evm::load_asset_snapshot_without_history(evm::EvmAssetQueryRequest {
        chain: req.chain.into(),
        wallet_address: req.wallet_address,
        tokens: req.tokens.into_iter().map(Into::into).collect(),
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn preview_payment(req: PaymentPreviewRequest) -> AppServiceResult<SigningPreview> {
    let wallet_public_key = require_pubkey(&req.wallet_public_key, "wallet public key")?;
    require_non_empty(&req.amount, "amount")?;
    let recipient = match req.operation {
        PaymentOperation::SolTransfer | PaymentOperation::SplTokenTransfer => {
            Some(require_pubkey(&req.recipient, "recipient")?.to_string())
        }
        PaymentOperation::WsolWrap
        | PaymentOperation::WsolUnwrap
        | PaymentOperation::WsolCloseAta => None,
    };
    let mint = match req.operation {
        PaymentOperation::SplTokenTransfer => {
            Some(require_pubkey(req.mint.as_deref().unwrap_or_default(), "token mint")?.to_string())
        }
        _ => None,
    };
    if matches!(
        req.operation,
        PaymentOperation::SolTransfer
            | PaymentOperation::SplTokenTransfer
            | PaymentOperation::WsolWrap
    ) {
        require_positive_amount(req.amount_base_units, "payment amount")?;
    }
    let wallet_public_key = wallet_public_key.to_string();
    let preview_id = solana_payment_preview_id(&SolanaPaymentPreviewIdInput {
        network: req.network,
        wallet_public_key: &wallet_public_key,
        operation: req.operation,
        recipient: recipient.as_deref(),
        mint: mint.as_deref(),
        amount_base_units: req.amount_base_units,
    });

    Ok(SigningPreview {
        id: preview_id,
        title: match req.operation {
            PaymentOperation::SolTransfer => "SOL Payment",
            PaymentOperation::SplTokenTransfer => "SPL Token Payment",
            PaymentOperation::WsolWrap => "Wrap SOL",
            PaymentOperation::WsolUnwrap => "Unwrap WSOL",
            PaymentOperation::WsolCloseAta => "Close WSOL ATA",
        }
        .to_string(),
        network: req.network,
        wallet_public_key,
        summary: match recipient.as_deref() {
            Some(recipient) => format!("Send {} to {}", req.amount, recipient),
            None => req.amount,
        },
        warnings: vec!["Review the recipient and network before signing.".to_string()],
        requires_user_confirmation: true,
    })
}

pub fn submit_payment(req: PaymentSubmitRequest) -> AppServiceResult<TransactionSubmitResult> {
    require_non_empty(&req.preview_id, "preview id")?;
    if !req.approved {
        return Err(AppServiceError::mobile(
            MobileErrorCode::UserRejected,
            "User rejected the signing request",
        ));
    }

    let expected_wallet_pubkey = require_pubkey(&req.wallet_public_key, "wallet public key")?;
    let recipient_for_preview = match req.operation {
        PaymentOperation::SolTransfer | PaymentOperation::SplTokenTransfer => Some(
            require_pubkey(req.recipient.as_deref().unwrap_or_default(), "recipient")?.to_string(),
        ),
        PaymentOperation::WsolWrap
        | PaymentOperation::WsolUnwrap
        | PaymentOperation::WsolCloseAta => None,
    };
    let mint_for_preview = match req.operation {
        PaymentOperation::SplTokenTransfer => {
            Some(require_pubkey(req.mint.as_deref().unwrap_or_default(), "token mint")?.to_string())
        }
        _ => None,
    };
    let expected_preview_id = solana_payment_preview_id(&SolanaPaymentPreviewIdInput {
        network: req.network,
        wallet_public_key: &expected_wallet_pubkey.to_string(),
        operation: req.operation,
        recipient: recipient_for_preview.as_deref(),
        mint: mint_for_preview.as_deref(),
        amount_base_units: req.amount_base_units,
    });
    if req.preview_id != expected_preview_id {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Solana payment preview is stale or mismatched",
        ));
    }
    require_non_empty(&req.keystore_json, "keystore json")?;
    require_non_empty(&req.password, "wallet password")?;

    let keypair = KeyManager::keypair_from_encrypted_json(&req.keystore_json, &req.password)
        .map_err(|_| AppServiceError::mobile(MobileErrorCode::WrongPassword, "Wrong password"))?;

    if keypair.pubkey() != expected_wallet_pubkey {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Keystore does not match the selected wallet",
        ));
    }

    let client = fnzero_safe::solana_utils::solana_ops::SolanaClient::new(rpc_url(
        req.network,
        req.rpc_url,
    )?);

    let signature = match req.operation {
        PaymentOperation::SolTransfer => {
            require_positive_amount(req.amount_base_units, "transfer amount")?;
            let recipient =
                require_pubkey(req.recipient.as_deref().unwrap_or_default(), "recipient")?;
            client
                .transfer_sol(&keypair, &recipient, req.amount_base_units)
                .map_err(map_rpc_error)?
        }
        PaymentOperation::SplTokenTransfer => {
            require_positive_amount(req.amount_base_units, "transfer amount")?;
            let recipient =
                require_pubkey(req.recipient.as_deref().unwrap_or_default(), "recipient")?;
            let mint = require_pubkey(req.mint.as_deref().unwrap_or_default(), "token mint")?;
            client
                .transfer_token(&keypair, &recipient, &mint, req.amount_base_units)
                .map_err(map_rpc_error)?
        }
        PaymentOperation::WsolWrap => {
            require_positive_amount(req.amount_base_units, "wrap amount")?;
            client
                .wrap_sol(&keypair, req.amount_base_units)
                .map_err(map_rpc_error)?
        }
        PaymentOperation::WsolUnwrap => client.unwrap_sol(&keypair).map_err(map_rpc_error)?,
        PaymentOperation::WsolCloseAta => client.unwrap_sol(&keypair).map_err(map_rpc_error)?,
    };

    Ok(TransactionSubmitResult {
        signature: signature.to_string(),
        slot: None,
        network: req.network,
        submitted_at: submitted_at(),
        status: "confirmed".to_string(),
    })
}

pub fn evm_payment_preview(req: EvmPaymentPreviewRequest) -> AppServiceResult<EvmPaymentPreview> {
    evm::preview_payment(evm::EvmPaymentPreviewRequest {
        chain: req.chain.into(),
        wallet_address: req.wallet_address,
        recipient: req.recipient,
        amount_wei_or_units: req.amount_wei_or_units,
        token_contract: req.token_contract,
        memo: req.memo,
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn evm_payment_submit(
    req: EvmPaymentSubmitRequest,
) -> AppServiceResult<EvmTransactionSubmitResult> {
    evm::submit_payment(evm::EvmPaymentSubmitRequest {
        preview_id: req.preview_id,
        approved: req.approved,
        chain: req.chain.into(),
        wallet_address: req.wallet_address,
        keystore_json: req.keystore_json,
        password: req.password,
        recipient: req.recipient,
        amount_wei_or_units: req.amount_wei_or_units,
        token_contract: req.token_contract,
        gas_limit: req.gas_limit,
        gas_price_wei: req.gas_price_wei,
        max_fee_per_gas_wei: req.max_fee_per_gas_wei,
        max_priority_fee_per_gas_wei: req.max_priority_fee_per_gas_wei,
        nonce: req.nonce,
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn evm_transaction_status(
    req: EvmTransactionStatusRequest,
) -> AppServiceResult<EvmTransactionStatus> {
    evm::transaction_status(evm::EvmTransactionStatusRequest {
        chain: req.chain.into(),
        transaction_hash: req.transaction_hash,
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn preview_pump_trade(req: PumpPreviewRequest) -> AppServiceResult<SigningPreview> {
    require_non_empty(&req.wallet_public_key, "wallet public key")?;
    require_non_empty(&req.mint, "token mint")?;
    require_non_empty(&req.venue, "venue")?;

    Ok(SigningPreview {
        id: Uuid::new_v4().to_string(),
        title: format!("{} Sell", req.venue),
        network: req.network,
        wallet_public_key: req.wallet_public_key,
        summary: format!(
            "Sell {} bps of {} with {} bps slippage",
            req.sell_percent_bps, req.mint, req.slippage_bps
        ),
        warnings: vec![
            "Pump trades can move quickly; confirm slippage before signing.".to_string(),
        ],
        requires_user_confirmation: true,
    })
}

pub fn preview_dapp_signing(req: DappSignPreviewRequest) -> AppServiceResult<SigningPreview> {
    let wallet_public_key = require_pubkey(&req.wallet_public_key, "wallet public key")?;
    let app_name = require_non_empty(&req.app_name, "dApp name")?;
    let app_url = require_non_empty(&req.app_url, "dApp URL")?;
    let method = require_non_empty(&req.method, "dApp method")?;
    let payload_base64 = require_non_empty(&req.payload_base64, "signing payload")?;
    let wallet_public_key = wallet_public_key.to_string();
    let preview_id = solana_dapp_preview_id(&SolanaDappPreviewIdInput {
        network: req.network,
        wallet_public_key: &wallet_public_key,
        app_name: &app_name,
        app_url: &app_url,
        method: &method,
        payload_base64: &payload_base64,
        transaction_format: req.transaction_format.as_deref(),
    });

    Ok(SigningPreview {
        id: preview_id,
        title: format!("{app_name} Request"),
        network: req.network,
        wallet_public_key,
        summary: format!("{app_url} requested {method}"),
        warnings: vec!["Only approve dApp requests from sites you trust.".to_string()],
        requires_user_confirmation: true,
    })
}

pub fn submit_dapp_signing(req: DappSignSubmitRequest) -> AppServiceResult<DappSignSubmitResult> {
    require_non_empty(&req.preview_id, "preview id")?;
    if !req.approved {
        return Err(AppServiceError::mobile(
            MobileErrorCode::UserRejected,
            "User rejected the dApp signing request",
        ));
    }

    let expected_wallet_pubkey = require_pubkey(&req.wallet_public_key, "wallet public key")?;
    let app_name = require_non_empty(&req.app_name, "dApp name")?;
    let app_url = require_non_empty(&req.app_url, "dApp URL")?;
    let method = require_non_empty(&req.method, "dApp method")?;
    let payload_base64 = require_non_empty(&req.payload_base64, "signing payload")?;
    let expected_preview_id = solana_dapp_preview_id(&SolanaDappPreviewIdInput {
        network: req.network,
        wallet_public_key: &expected_wallet_pubkey.to_string(),
        app_name: &app_name,
        app_url: &app_url,
        method: &method,
        payload_base64: &payload_base64,
        transaction_format: req.transaction_format.as_deref(),
    });
    if req.preview_id != expected_preview_id {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Solana dApp signing preview is stale or mismatched",
        ));
    }

    let keypair = keypair_from_selected_mobile_wallet(
        &req.wallet_public_key,
        &req.keystore_json,
        &req.password,
    )?;

    match method.as_str() {
        "signMessage" | "personal_sign" => {
            let payload = BASE64.decode(payload_base64).map_err(|_| {
                AppServiceError::mobile(
                    MobileErrorCode::InvalidInput,
                    "Signing payload must be valid base64",
                )
            })?;
            if payload.is_empty() || payload.len() > 4096 {
                return Err(AppServiceError::mobile(
                    MobileErrorCode::InvalidInput,
                    "Signing payload length is invalid",
                ));
            }

            let signature = keypair.try_sign_message(&payload).map_err(|_| {
                AppServiceError::mobile(MobileErrorCode::InvalidInput, "Message signing failed")
            })?;
            if !signature.verify(expected_wallet_pubkey.as_ref(), &payload) {
                return Err(AppServiceError::mobile(
                    MobileErrorCode::InvalidInput,
                    "Generated message signature failed verification",
                ));
            }

            Ok(DappSignSubmitResult {
                signature: Some(signature.to_string()),
                signature_base64: Some(BASE64.encode(signature.as_ref())),
                signed_payload_base64: Some(BASE64.encode(payload)),
                signed_payloads_base64: Vec::new(),
                transaction: None,
                status: "signed".to_string(),
            })
        }
        "signTransaction" | "signAndSendTransaction" => {
            let signed_transaction = sign_dapp_transaction(
                &payload_base64,
                req.transaction_format.as_deref(),
                &expected_wallet_pubkey,
                &keypair,
            )?;
            let raw_transaction = signed_transaction.raw_base64()?;
            let signature = signed_transaction.signature()?;

            if method == "signTransaction" {
                return Ok(DappSignSubmitResult {
                    signature: Some(signature.to_string()),
                    signature_base64: None,
                    signed_payload_base64: Some(raw_transaction),
                    signed_payloads_base64: Vec::new(),
                    transaction: None,
                    status: "signed".to_string(),
                });
            }

            let client = RpcClient::new_with_commitment(
                rpc_url(req.network, req.rpc_url)?,
                CommitmentConfig::confirmed(),
            );
            let submitted_signature = signed_transaction.submit(&client)?;
            if submitted_signature != signature {
                return Err(AppServiceError::mobile(
                    MobileErrorCode::RpcUnavailable,
                    "RPC returned a different transaction signature than the local signed transaction",
                ));
            }

            Ok(DappSignSubmitResult {
                signature: Some(signature.to_string()),
                signature_base64: None,
                signed_payload_base64: Some(raw_transaction),
                signed_payloads_base64: Vec::new(),
                transaction: Some(TransactionSubmitResult {
                    signature: signature.to_string(),
                    slot: None,
                    network: req.network,
                    submitted_at: submitted_at(),
                    status: "confirmed".to_string(),
                }),
                status: "submitted".to_string(),
            })
        }
        "signAllTransactions" => {
            let transactions = decode_dapp_transaction_batch(&payload_base64)?;
            let mut signed_payloads_base64 = Vec::with_capacity(transactions.len());
            let mut first_signature = None;
            for transaction_base64 in transactions {
                let signed_transaction = sign_dapp_transaction(
                    &transaction_base64,
                    req.transaction_format.as_deref(),
                    &expected_wallet_pubkey,
                    &keypair,
                )?;
                if first_signature.is_none() {
                    first_signature = Some(signed_transaction.signature()?.to_string());
                }
                signed_payloads_base64.push(signed_transaction.raw_base64()?);
            }

            Ok(DappSignSubmitResult {
                signature: first_signature,
                signature_base64: None,
                signed_payload_base64: None,
                signed_payloads_base64,
                transaction: None,
                status: "signed".to_string(),
            })
        }
        _ => Err(AppServiceError::mobile(
            MobileErrorCode::Unsupported,
            "Unsupported dApp signing method",
        )),
    }
}

pub fn evm_dapp_sign_preview(
    req: EvmDappSignPreviewRequest,
) -> AppServiceResult<EvmDappSignPreview> {
    evm::preview_dapp_signing(evm::EvmDappSignPreviewRequest {
        chain: req.chain.into(),
        wallet_address: req.wallet_address,
        app_name: req.app_name,
        app_url: req.app_url,
        method: req.method,
        payload_json: req.payload_json,
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn evm_dapp_sign_submit(
    req: EvmDappSignSubmitRequest,
) -> AppServiceResult<EvmDappSignSubmitResult> {
    evm::submit_dapp_signing(evm::EvmDappSignSubmitRequest {
        preview_id: req.preview_id,
        approved: req.approved,
        chain: req.chain.into(),
        wallet_address: req.wallet_address,
        app_name: req.app_name,
        app_url: req.app_url,
        keystore_json: req.keystore_json,
        password: req.password,
        method: req.method,
        payload_json: req.payload_json,
    })
    .map(Into::into)
    .map_err(map_evm_error)
}

pub fn preview_squads_action(req: SquadsPreviewRequest) -> AppServiceResult<SigningPreview> {
    require_non_empty(&req.wallet_public_key, "wallet public key")?;
    require_non_empty(&req.multisig, "Squads multisig")?;
    require_non_empty(&req.action, "Squads action")?;

    Ok(SigningPreview {
        id: Uuid::new_v4().to_string(),
        title: "Squads Multisig Action".to_string(),
        network: req.network,
        wallet_public_key: req.wallet_public_key,
        summary: format!("{} on multisig {}", req.action, req.multisig),
        warnings: vec!["Confirm proposal state and threshold before signing.".to_string()],
        requires_user_confirmation: true,
    })
}

pub fn squads_info(req: SquadsInfoRequest) -> AppServiceResult<SquadsInfoResponse> {
    let multisig_key = require_pubkey(&req.multisig, "Squads multisig")?;
    let client = RpcClient::new_with_commitment(
        rpc_url(req.network, req.rpc_url)?,
        CommitmentConfig::confirmed(),
    );
    let multisig = load_squads_multisig(&client, &multisig_key)?;
    let proposal = if let Some(proposal) = req
        .proposal
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let proposal_key = require_pubkey(proposal, "Squads proposal")?;
        Some(squads_proposal_summary(
            proposal_key,
            load_squads_proposal(&client, &proposal_key)?,
        ))
    } else {
        None
    };

    Ok(SquadsInfoResponse {
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
            .map(squads_member_summary)
            .collect(),
        proposal,
        network: req.network,
    })
}

pub fn squads_proposals(req: SquadsProposalsRequest) -> AppServiceResult<SquadsProposalsResponse> {
    let multisig_key = require_pubkey(&req.multisig, "Squads multisig")?;
    let client = RpcClient::new_with_commitment(
        rpc_url(req.network, req.rpc_url)?,
        CommitmentConfig::confirmed(),
    );
    let multisig = load_squads_multisig(&client, &multisig_key)?;
    let limit = req.limit.unwrap_or(20).clamp(1, 50);
    let start = multisig.transaction_index;
    let end = start.saturating_sub(limit.saturating_sub(1));
    let mut proposals = Vec::new();

    for index in (end..=start).rev() {
        let proposal_key = squads_v4::proposal_pda(&multisig_key, index);
        if let Ok(proposal) = load_squads_proposal(&client, &proposal_key) {
            proposals.push(squads_proposal_summary(proposal_key, proposal));
        }
    }

    Ok(SquadsProposalsResponse {
        multisig: multisig_key.to_string(),
        vault: squads_v4::vault_pda(&multisig_key, 0).to_string(),
        proposals,
        latest_transaction_index: multisig.transaction_index,
        network: req.network,
    })
}

pub fn squads_create_submit(
    req: SquadsCreateSubmitRequest,
) -> AppServiceResult<SquadsCreateSubmitResult> {
    if !req.approved {
        return Err(AppServiceError::mobile(
            MobileErrorCode::UserRejected,
            "User rejected the Squads create request",
        ));
    }
    if req.members.is_empty() {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "At least one Squads member is required",
        ));
    }
    let payer = keypair_from_mobile_keystore(&req.keystore_json, &req.password)?;
    let mut members = req
        .members
        .iter()
        .map(|member| {
            require_pubkey(member, "Squads member").map(|key| squads_v4::Member {
                key,
                permissions: squads_v4::Permissions::all(),
            })
        })
        .collect::<AppServiceResult<Vec<_>>>()?;
    members.sort_by_key(|member| member.key);
    members.dedup_by_key(|member| member.key);
    if req.threshold == 0 || usize::from(req.threshold) > members.len() {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Squads threshold must be greater than zero and not exceed members",
        ));
    }
    if !members.iter().any(|member| member.key == payer.pubkey()) {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Selected wallet must be a Squads member",
        ));
    }

    let client = RpcClient::new_with_commitment(
        rpc_url(req.network, req.rpc_url)?,
        CommitmentConfig::confirmed(),
    );
    let program_config = load_squads_program_config(&client)?;
    let create_key = Keypair::new();
    let (ix, multisig) = squads_v4::multisig_create_ix(
        &create_key.pubkey(),
        &payer.pubkey(),
        &program_config.treasury,
        req.threshold,
        members.clone(),
        req.time_lock.unwrap_or(0),
        req.memo,
    )
    .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))?;
    let signature =
        sign_and_send_instructions(&client, vec![ix], &[&payer, &create_key], &payer.pubkey())?;
    let vault = squads_v4::vault_pda(&multisig, 0);

    Ok(SquadsCreateSubmitResult {
        multisig: multisig.to_string(),
        vault: vault.to_string(),
        create_key: create_key.pubkey().to_string(),
        signature: signature.to_string(),
        threshold: req.threshold,
        members: members.into_iter().map(squads_member_summary).collect(),
        creation_fee_lamports: program_config.multisig_creation_fee,
        network: req.network,
        status: "confirmed".to_string(),
    })
}

pub fn squads_transfer_proposal_submit(
    req: SquadsTransferProposalSubmitRequest,
) -> AppServiceResult<SquadsProposalCreateSubmitResult> {
    if !req.approved {
        return Err(AppServiceError::mobile(
            MobileErrorCode::UserRejected,
            "User rejected the Squads proposal request",
        ));
    }
    let signer = keypair_from_mobile_keystore(&req.keystore_json, &req.password)?;
    let multisig_key = require_pubkey(&req.multisig, "Squads multisig")?;
    require_positive_amount(req.amount_base_units, "proposal amount")?;
    let client = RpcClient::new_with_commitment(
        rpc_url(req.network, req.rpc_url)?,
        CommitmentConfig::confirmed(),
    );
    let multisig = load_squads_multisig(&client, &multisig_key)?;
    require_squads_member(&multisig, &signer.pubkey())?;
    let transaction_index = next_squads_transaction_index(&multisig)?;
    let vault = squads_v4::vault_pda(&multisig_key, 0);

    let inner_instructions = match req.kind {
        SquadsTransferKind::Sol => {
            let recipient =
                require_pubkey(req.recipient.as_deref().unwrap_or_default(), "recipient")?;
            vec![squads_v4::sol_transfer_ix(
                &vault,
                &recipient,
                req.amount_base_units,
            )]
        }
        SquadsTransferKind::SplToken => {
            let mint = require_pubkey(req.mint.as_deref().unwrap_or_default(), "token mint")?;
            let decimals = match req.decimals {
                Some(decimals) => decimals,
                None => {
                    client
                        .get_token_supply(&mint)
                        .map_err(map_rpc_error)?
                        .decimals
                }
            };
            let source = if let Some(source) = req
                .source_token_account
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                require_pubkey(source, "source token account")?
            } else {
                squads_v4::associated_token_address(&vault, &mint)
            };
            let destination_override = req
                .destination_token_account
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let recipient = req
                .recipient
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| require_pubkey(value, "recipient"))
                .transpose()?;
            let destination = if let Some(destination) = destination_override {
                require_pubkey(destination, "destination token account")?
            } else if let Some(recipient) = recipient {
                squads_v4::associated_token_address(&recipient, &mint)
            } else {
                return Err(AppServiceError::mobile(
                    MobileErrorCode::InvalidInput,
                    "Recipient wallet or destination token account is required",
                ));
            };
            let mut inner_instructions = Vec::new();
            if destination_override.is_none() {
                if let Some(recipient) = recipient {
                    inner_instructions.push(
                        squads_v4::create_associated_token_account_idempotent_ix(
                            &vault, &recipient, &mint,
                        ),
                    );
                }
            }
            inner_instructions.push(squads_v4::token_transfer_checked_ix(
                &source,
                &mint,
                &destination,
                &vault,
                req.amount_base_units,
                decimals,
            ));
            inner_instructions
        }
    };

    let (tx_create_ix, transaction, vault, _) = squads_v4::vault_transaction_create_ix(
        &multisig_key,
        &signer.pubkey(),
        transaction_index,
        0,
        &inner_instructions,
        req.memo,
    )
    .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))?;
    let (proposal_ix, proposal) =
        squads_v4::proposal_create_ix(&multisig_key, &signer.pubkey(), transaction_index, false)
            .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))?;
    let signature = sign_and_send_instructions(
        &client,
        vec![tx_create_ix, proposal_ix],
        &[&signer],
        &signer.pubkey(),
    )?;

    Ok(SquadsProposalCreateSubmitResult {
        multisig: multisig_key.to_string(),
        vault: vault.to_string(),
        transaction: transaction.to_string(),
        proposal: proposal.to_string(),
        transaction_index,
        signature: signature.to_string(),
        network: req.network,
        status: "confirmed".to_string(),
    })
}

pub fn squads_approve_submit(
    req: SquadsVoteSubmitRequest,
) -> AppServiceResult<TransactionSubmitResult> {
    if !req.approved {
        return Err(AppServiceError::mobile(
            MobileErrorCode::UserRejected,
            "User rejected the Squads approve request",
        ));
    }
    let signer = keypair_from_mobile_keystore(&req.keystore_json, &req.password)?;
    let multisig = require_pubkey(&req.multisig, "Squads multisig")?;
    let proposal = require_pubkey(&req.proposal, "Squads proposal")?;
    let client = RpcClient::new_with_commitment(
        rpc_url(req.network, req.rpc_url)?,
        CommitmentConfig::confirmed(),
    );
    let state = load_squads_multisig(&client, &multisig)?;
    require_squads_member(&state, &signer.pubkey())?;
    let ix = squads_v4::proposal_approve_ix(&multisig, &proposal, &signer.pubkey(), req.memo)
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))?;
    let signature = sign_and_send_single(&client, ix, &signer)?;
    Ok(transaction_result(signature, req.network, "confirmed"))
}

pub fn squads_reject_submit(
    req: SquadsVoteSubmitRequest,
) -> AppServiceResult<TransactionSubmitResult> {
    if !req.approved {
        return Err(AppServiceError::mobile(
            MobileErrorCode::UserRejected,
            "User rejected the Squads reject request",
        ));
    }
    let signer = keypair_from_mobile_keystore(&req.keystore_json, &req.password)?;
    let multisig = require_pubkey(&req.multisig, "Squads multisig")?;
    let proposal = require_pubkey(&req.proposal, "Squads proposal")?;
    let client = RpcClient::new_with_commitment(
        rpc_url(req.network, req.rpc_url)?,
        CommitmentConfig::confirmed(),
    );
    let state = load_squads_multisig(&client, &multisig)?;
    require_squads_member(&state, &signer.pubkey())?;
    let ix = squads_v4::proposal_reject_ix(&multisig, &proposal, &signer.pubkey(), req.memo)
        .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))?;
    let signature = sign_and_send_single(&client, ix, &signer)?;
    Ok(transaction_result(signature, req.network, "confirmed"))
}

pub fn squads_execute_submit(
    req: SquadsExecuteSubmitRequest,
) -> AppServiceResult<TransactionSubmitResult> {
    if !req.approved {
        return Err(AppServiceError::mobile(
            MobileErrorCode::UserRejected,
            "User rejected the Squads execute request",
        ));
    }
    let signer = keypair_from_mobile_keystore(&req.keystore_json, &req.password)?;
    let multisig = require_pubkey(&req.multisig, "Squads multisig")?;
    let proposal = require_pubkey(&req.proposal, "Squads proposal")?;
    let transaction = squads_v4::transaction_pda(&multisig, req.transaction_index);
    let client = RpcClient::new_with_commitment(
        rpc_url(req.network, req.rpc_url)?,
        CommitmentConfig::confirmed(),
    );
    let state = load_squads_multisig(&client, &multisig)?;
    require_squads_member(&state, &signer.pubkey())?;
    let vault_transaction = load_squads_vault_transaction(&client, &transaction)?;
    if vault_transaction.multisig != multisig || vault_transaction.index != req.transaction_index {
        return Err(AppServiceError::mobile(
            MobileErrorCode::InvalidInput,
            "Squads transaction account does not match the request",
        ));
    }
    let ix = squads_v4::vault_transaction_execute_ix(
        &multisig,
        &transaction,
        &proposal,
        &signer.pubkey(),
        &vault_transaction.message,
        vault_transaction.vault_index,
        u8::try_from(vault_transaction.ephemeral_signer_bumps.len()).map_err(|_| {
            AppServiceError::mobile(
                MobileErrorCode::InvalidInput,
                "Squads ephemeral signer count is out of range",
            )
        })?,
    )
    .map_err(|message| AppServiceError::mobile(MobileErrorCode::InvalidInput, message))?;
    let signature = sign_and_send_single(&client, ix, &signer)?;
    Ok(transaction_result(signature, req.network, "confirmed"))
}

pub fn setup_totp(account: String) -> AppServiceResult<TotpSetup> {
    let account = require_non_empty(&account, "TOTP account")?;

    Ok(TotpSetup {
        secret: fnzero_safe::totp::TOTPManager::generate_secret(),
        issuer: "FnzSafe".to_string(),
        account,
    })
}

pub fn verify_totp(req: TotpVerifyRequest) -> AppServiceResult<bool> {
    let secret = require_non_empty(&req.secret, "TOTP secret")?;
    let code = require_non_empty(&req.code, "TOTP code")?;

    let manager = fnzero_safe::totp::TOTPManager::new(fnzero_safe::totp::TOTPConfig {
        secret,
        issuer: "FnzSafe".to_string(),
        account: "mobile-wallet".to_string(),
        algorithm: "SHA1".to_string(),
        digits: 6,
        step: 30,
    });

    let verified = manager
        .verify_code(&code)
        .map_err(|_| AppServiceError::mobile(MobileErrorCode::TotpInvalid, "Invalid TOTP code"))?;
    if !verified {
        return Err(AppServiceError::mobile(
            MobileErrorCode::TotpInvalid,
            "Invalid TOTP code",
        ));
    }
    Ok(true)
}

pub fn biometric_policy_stub() -> BiometricPolicy {
    BiometricPolicy {
        supported: false,
        configured: false,
        reason: Some("Native platform channel not configured yet".to_string()),
    }
}

pub fn unsupported_mobile_program_workflow(capability: &'static str) -> AppServiceError {
    AppServiceError::Unsupported {
        surface: AppSurface::Mobile,
        capability,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solana_payment_preview_for(
        wallet_public_key: &str,
        recipient: &str,
        amount_base_units: u64,
    ) -> SigningPreview {
        preview_payment(PaymentPreviewRequest {
            network: AppNetwork::Devnet,
            wallet_public_key: wallet_public_key.to_string(),
            recipient: recipient.to_string(),
            mint: None,
            amount: format!("{amount_base_units} lamports"),
            operation: PaymentOperation::SolTransfer,
            amount_base_units,
            memo: None,
        })
        .unwrap()
    }

    fn solana_dapp_preview_for(
        wallet_public_key: &str,
        method: &str,
        payload_base64: &str,
        transaction_format: Option<&str>,
    ) -> SigningPreview {
        preview_dapp_signing(DappSignPreviewRequest {
            network: AppNetwork::Devnet,
            wallet_public_key: wallet_public_key.to_string(),
            app_name: "Example dApp".to_string(),
            app_url: "https://example.invalid".to_string(),
            method: method.to_string(),
            payload_base64: payload_base64.to_string(),
            transaction_format: transaction_format.map(ToString::to_string),
        })
        .unwrap()
    }

    #[test]
    fn mobile_surface_excludes_program_workflows() {
        let capabilities = mobile_capabilities();

        assert!(capabilities
            .enabled
            .contains(&capabilities::SQUADS_MULTISIG));
        assert!(capabilities.excluded.contains(&"program_deploy"));
        assert!(capabilities.excluded.contains(&"program_upgrade"));
        assert!(capabilities.excluded.contains(&"program_invoke"));
    }

    #[test]
    fn wallet_create_and_unlock_round_trips_without_private_key_in_response() {
        let created = create_wallet(CreateWalletRequest {
            name: "Mobile Wallet".to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();

        assert_eq!(created.wallet.name, "Mobile Wallet");
        assert!(!created.keystore_json.contains("strong-password"));

        let unlocked = unlock_wallet(UnlockWalletRequest {
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
        })
        .unwrap();

        assert_eq!(unlocked.wallet.public_key, created.wallet.public_key);
    }

    #[test]
    fn wallet_private_key_import_and_export_round_trips() {
        let created = create_wallet(CreateWalletRequest {
            name: "Mobile Wallet".to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let exported = export_private_key(ExportPrivateKeyRequest {
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
        })
        .unwrap();

        let imported = import_private_key(ImportPrivateKeyRequest {
            name: "Imported Wallet".to_string(),
            private_key_base58: exported.private_key_base58,
            password: "new-strong-password".to_string(),
        })
        .unwrap();

        assert_eq!(imported.wallet.public_key, exported.public_key);
        assert!(!imported.keystore_json.contains("new-strong-password"));
    }

    #[test]
    fn wallet_mnemonic_import_creates_unlockable_keystore() {
        let imported = import_mnemonic(ImportMnemonicRequest {
            name: "Mnemonic Wallet".to_string(),
            mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
                .to_string(),
            derivation_path: None,
            password: "strong-password".to_string(),
        })
        .unwrap();

        let unlocked = unlock_wallet(UnlockWalletRequest {
            keystore_json: imported.keystore_json,
            password: "strong-password".to_string(),
        })
        .unwrap();

        assert_eq!(unlocked.wallet.public_key, imported.wallet.public_key);
    }

    #[test]
    fn wallet_mnemonic_import_rejects_invalid_phrase() {
        let error = import_mnemonic(ImportMnemonicRequest {
            name: "Mnemonic Wallet".to_string(),
            mnemonic: "not enough words".to_string(),
            derivation_path: None,
            password: "strong-password".to_string(),
        })
        .unwrap_err();

        assert_eq!(error.to_mobile_error().code, MobileErrorCode::InvalidInput);
    }

    #[test]
    fn payment_preview_requires_confirmation() {
        let wallet = Pubkey::new_unique().to_string();
        let recipient = Pubkey::new_unique().to_string();
        let preview = preview_payment(PaymentPreviewRequest {
            network: AppNetwork::Devnet,
            wallet_public_key: wallet,
            recipient,
            mint: None,
            amount: "0.1 SOL".to_string(),
            operation: PaymentOperation::SolTransfer,
            amount_base_units: 100_000_000,
            memo: None,
        })
        .unwrap();

        assert!(preview.requires_user_confirmation);
        assert_eq!(preview.title, "SOL Payment");
    }

    #[test]
    fn payment_submit_reject_maps_to_user_rejected_without_decrypting_wallet() {
        let error = submit_payment(PaymentSubmitRequest {
            preview_id: "preview-1".to_string(),
            approved: false,
            network: AppNetwork::Devnet,
            rpc_url: None,
            wallet_public_key: "11111111111111111111111111111111".to_string(),
            keystore_json: String::new(),
            password: String::new(),
            operation: PaymentOperation::SolTransfer,
            recipient: Some("11111111111111111111111111111111".to_string()),
            mint: None,
            amount_base_units: 1,
        })
        .unwrap_err();

        assert_eq!(error.to_mobile_error().code, MobileErrorCode::UserRejected);
    }

    #[test]
    fn payment_submit_wrong_password_is_structured() {
        let created = create_wallet(CreateWalletRequest {
            name: "Mobile Wallet".to_string(),
            password: "correct-password".to_string(),
        })
        .unwrap();
        let recipient = Pubkey::new_unique().to_string();
        let preview = solana_payment_preview_for(&created.wallet.public_key, &recipient, 1);

        let error = submit_payment(PaymentSubmitRequest {
            preview_id: preview.id,
            approved: true,
            network: AppNetwork::Devnet,
            rpc_url: None,
            wallet_public_key: created.wallet.public_key,
            keystore_json: created.keystore_json,
            password: "wrong-password".to_string(),
            operation: PaymentOperation::SolTransfer,
            recipient: Some(recipient),
            mint: None,
            amount_base_units: 1,
        })
        .unwrap_err();

        assert_eq!(error.to_mobile_error().code, MobileErrorCode::WrongPassword);
        assert!(!error.to_mobile_error().message.contains("wrong-password"));
    }

    #[test]
    fn payment_submit_zero_amount_fails_before_rpc() {
        let created = create_wallet(CreateWalletRequest {
            name: "Mobile Wallet".to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let recipient = Pubkey::new_unique().to_string();
        let preview_id = solana_payment_preview_id(&SolanaPaymentPreviewIdInput {
            network: AppNetwork::Devnet,
            wallet_public_key: &created.wallet.public_key,
            operation: PaymentOperation::SolTransfer,
            recipient: Some(&recipient),
            mint: None,
            amount_base_units: 0,
        });

        let error = submit_payment(PaymentSubmitRequest {
            preview_id,
            approved: true,
            network: AppNetwork::Devnet,
            rpc_url: None,
            wallet_public_key: created.wallet.public_key,
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            operation: PaymentOperation::SolTransfer,
            recipient: Some(recipient),
            mint: None,
            amount_base_units: 0,
        })
        .unwrap_err();

        assert_eq!(error.to_mobile_error().code, MobileErrorCode::InvalidInput);
    }

    #[test]
    fn payment_submit_rejects_stale_preview_id() {
        let created = create_wallet(CreateWalletRequest {
            name: "Mobile Wallet".to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let recipient = Pubkey::new_unique().to_string();
        let preview = solana_payment_preview_for(&created.wallet.public_key, &recipient, 1);

        let error = submit_payment(PaymentSubmitRequest {
            preview_id: preview.id,
            approved: true,
            network: AppNetwork::Devnet,
            rpc_url: None,
            wallet_public_key: created.wallet.public_key,
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            operation: PaymentOperation::SolTransfer,
            recipient: Some(recipient),
            mint: None,
            amount_base_units: 2,
        })
        .unwrap_err();

        assert_eq!(error.to_mobile_error().code, MobileErrorCode::InvalidInput);
        assert!(error
            .to_mobile_error()
            .message
            .contains("stale or mismatched"));
    }

    #[test]
    fn wsol_close_ata_validates_selected_wallet_before_rpc() {
        let created = create_wallet(CreateWalletRequest {
            name: "Mobile Wallet".to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let selected_wallet = "11111111111111111111111111111111".to_string();
        let preview_id = solana_payment_preview_id(&SolanaPaymentPreviewIdInput {
            network: AppNetwork::Devnet,
            wallet_public_key: &selected_wallet,
            operation: PaymentOperation::WsolCloseAta,
            recipient: None,
            mint: None,
            amount_base_units: 0,
        });

        let error = submit_payment(PaymentSubmitRequest {
            preview_id,
            approved: true,
            network: AppNetwork::Devnet,
            rpc_url: None,
            wallet_public_key: selected_wallet,
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            operation: PaymentOperation::WsolCloseAta,
            recipient: None,
            mint: None,
            amount_base_units: 0,
        })
        .unwrap_err();

        assert_eq!(error.to_mobile_error().code, MobileErrorCode::InvalidInput);
    }

    #[test]
    fn dapp_sign_reject_maps_to_user_rejected_without_decrypting_wallet() {
        let error = submit_dapp_signing(DappSignSubmitRequest {
            preview_id: "preview-1".to_string(),
            approved: false,
            network: AppNetwork::Devnet,
            rpc_url: None,
            wallet_public_key: "11111111111111111111111111111111".to_string(),
            keystore_json: String::new(),
            password: String::new(),
            app_name: "Example dApp".to_string(),
            app_url: "https://example.invalid".to_string(),
            method: "signMessage".to_string(),
            payload_base64: "aGVsbG8=".to_string(),
            transaction_format: None,
        })
        .unwrap_err();

        assert_eq!(error.to_mobile_error().code, MobileErrorCode::UserRejected);
    }

    #[test]
    fn dapp_sign_message_returns_verified_signature() {
        let created = create_wallet(CreateWalletRequest {
            name: "Mobile Wallet".to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let preview =
            solana_dapp_preview_for(&created.wallet.public_key, "signMessage", "aGVsbG8=", None);

        let result = submit_dapp_signing(DappSignSubmitRequest {
            preview_id: preview.id,
            approved: true,
            network: AppNetwork::Devnet,
            rpc_url: None,
            wallet_public_key: created.wallet.public_key,
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            app_name: "Example dApp".to_string(),
            app_url: "https://example.invalid".to_string(),
            method: "signMessage".to_string(),
            payload_base64: "aGVsbG8=".to_string(),
            transaction_format: None,
        })
        .unwrap();

        assert_eq!(result.status, "signed");
        assert!(result.signature.is_some());
        assert!(result.signature_base64.is_some());
        assert_eq!(result.signed_payload_base64.as_deref(), Some("aGVsbG8="));
        assert!(result.transaction.is_none());
    }

    #[test]
    fn dapp_sign_rejects_stale_preview_id() {
        let created = create_wallet(CreateWalletRequest {
            name: "Mobile Wallet".to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let preview =
            solana_dapp_preview_for(&created.wallet.public_key, "signMessage", "aGVsbG8=", None);

        let error = submit_dapp_signing(DappSignSubmitRequest {
            preview_id: preview.id,
            approved: true,
            network: AppNetwork::Devnet,
            rpc_url: None,
            wallet_public_key: created.wallet.public_key,
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            app_name: "Example dApp".to_string(),
            app_url: "https://example.invalid".to_string(),
            method: "signMessage".to_string(),
            payload_base64: "dGFtcGVyZWQ=".to_string(),
            transaction_format: None,
        })
        .unwrap_err();

        assert_eq!(error.to_mobile_error().code, MobileErrorCode::InvalidInput);
        assert!(error
            .to_mobile_error()
            .message
            .contains("stale or mismatched"));
    }

    #[test]
    fn dapp_transaction_signing_returns_signed_transaction() {
        use solana_sdk::{hash::Hash, instruction::AccountMeta, message::Message};

        let created = create_wallet(CreateWalletRequest {
            name: "Mobile Wallet".to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let signer =
            keypair_from_mobile_keystore(&created.keystore_json, "strong-password").unwrap();
        let recipient = Pubkey::new_unique();
        let mut data = vec![2, 0, 0, 0];
        data.extend_from_slice(&1_u64.to_le_bytes());
        let instruction = Instruction {
            program_id: Pubkey::from_str("11111111111111111111111111111111").unwrap(),
            accounts: vec![
                AccountMeta::new(signer.pubkey(), true),
                AccountMeta::new(recipient, false),
            ],
            data,
        };
        let mut transaction =
            Transaction::new_unsigned(Message::new(&[instruction], Some(&signer.pubkey())));
        transaction.message.recent_blockhash = Hash::new_unique();
        let transaction_base64 = BASE64.encode(bincode::serialize(&transaction).unwrap());
        let preview = solana_dapp_preview_for(
            &created.wallet.public_key,
            "signTransaction",
            &transaction_base64,
            Some("legacy"),
        );

        let result = submit_dapp_signing(DappSignSubmitRequest {
            preview_id: preview.id,
            approved: true,
            network: AppNetwork::Devnet,
            rpc_url: None,
            wallet_public_key: created.wallet.public_key,
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            app_name: "Example dApp".to_string(),
            app_url: "https://example.invalid".to_string(),
            method: "signTransaction".to_string(),
            payload_base64: transaction_base64,
            transaction_format: Some("legacy".to_string()),
        })
        .unwrap();

        assert_eq!(result.status, "signed");
        assert!(result.signature.is_some());
        assert!(result.transaction.is_none());
        let signed: Transaction = bincode::deserialize(
            &BASE64
                .decode(result.signed_payload_base64.unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_ne!(signed.signatures[0], Signature::default());
    }

    #[test]
    fn dapp_sign_all_transactions_returns_signed_batch() {
        use solana_sdk::{hash::Hash, instruction::AccountMeta, message::Message};

        let created = create_wallet(CreateWalletRequest {
            name: "Mobile Wallet".to_string(),
            password: "strong-password".to_string(),
        })
        .unwrap();
        let signer =
            keypair_from_mobile_keystore(&created.keystore_json, "strong-password").unwrap();
        let recipient = Pubkey::new_unique();

        let transaction_payload = |lamports: u64| {
            let mut data = vec![2, 0, 0, 0];
            data.extend_from_slice(&lamports.to_le_bytes());
            let instruction = Instruction {
                program_id: Pubkey::from_str("11111111111111111111111111111111").unwrap(),
                accounts: vec![
                    AccountMeta::new(signer.pubkey(), true),
                    AccountMeta::new(recipient, false),
                ],
                data,
            };
            let mut transaction =
                Transaction::new_unsigned(Message::new(&[instruction], Some(&signer.pubkey())));
            transaction.message.recent_blockhash = Hash::new_unique();
            BASE64.encode(bincode::serialize(&transaction).unwrap())
        };
        let batch_base64 = BASE64.encode(
            serde_json::to_string(&vec![transaction_payload(1), transaction_payload(2)])
                .unwrap()
                .as_bytes(),
        );
        let preview = solana_dapp_preview_for(
            &created.wallet.public_key,
            "signAllTransactions",
            &batch_base64,
            Some("legacy"),
        );

        let result = submit_dapp_signing(DappSignSubmitRequest {
            preview_id: preview.id,
            approved: true,
            network: AppNetwork::Devnet,
            rpc_url: None,
            wallet_public_key: created.wallet.public_key,
            keystore_json: created.keystore_json,
            password: "strong-password".to_string(),
            app_name: "Example dApp".to_string(),
            app_url: "https://example.invalid".to_string(),
            method: "signAllTransactions".to_string(),
            payload_base64: batch_base64,
            transaction_format: Some("legacy".to_string()),
        })
        .unwrap();

        assert_eq!(result.status, "signed");
        assert!(result.signature.is_some());
        assert_eq!(result.signed_payloads_base64.len(), 2);
        assert!(result.signed_payload_base64.is_none());
        for signed_payload in result.signed_payloads_base64 {
            let signed: Transaction =
                bincode::deserialize(&BASE64.decode(signed_payload).unwrap()).unwrap();
            assert_ne!(signed.signatures[0], Signature::default());
        }
    }

    #[test]
    fn totp_invalid_code_maps_to_totp_invalid() {
        let setup = setup_totp("mobile-wallet".to_string()).unwrap();
        let error = verify_totp(TotpVerifyRequest {
            secret: setup.secret,
            code: "000000".to_string(),
        })
        .unwrap_err();

        assert_eq!(error.to_mobile_error().code, MobileErrorCode::TotpInvalid);
    }
}
