//! TRON account derivation and address validation for the multi-chain registry.
//!
//! Native/TRC-20 transaction construction is intentionally not advertised until the protobuf,
//! bandwidth, energy, permission, preview, and broadcast paths are implemented together.

#![forbid(unsafe_code)]

use bip32::DerivationPath;
use bip39::{Language, Mnemonic};
use fnzero_safe_chain_core::{
    capabilities, capability_ids, families, validate_address_input, validate_derivation_path_input,
    validate_mnemonic_input, ChainAdapter, ChainDescriptor, ChainEndpoint, ChainError, ChainFamily,
    ChainId, ChainResult, DerivedAccount, NativeAsset, SupportLevel,
};
use k256::ecdsa::{Signature, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

pub const TRON_MAINNET_CAIP2: &str = "tron:728126428";
pub const TRON_SHASTA_CAIP2: &str = "tron:2494104990";
pub const TRON_NILE_CAIP2: &str = "tron:3448148188";
pub const TRON_DERIVATION_PATH: &str = "m/44'/195'/0'/0/0";
pub const TRON_MAINNET_HTTP_URL: &str = "https://api.trongrid.io";
pub const TRON_SHASTA_HTTP_URL: &str = "https://api.shasta.trongrid.io";
pub const TRON_NILE_HTTP_URL: &str = "https://nile.trongrid.io";
const TRON_ADDRESS_PREFIX: u8 = 0x41;
const DEFAULT_BANDWIDTH_PRICE_SUN: u64 = 1_000;
const DEFAULT_ACCOUNT_ACTIVATION_FEE_SUN: u64 = 1_000_000;
const MAX_TRON_AMOUNT_SUN: u64 = i64::MAX as u64;
const MAX_TRANSACTION_LIFETIME_MS: u64 = 10 * 60 * 1_000;

#[derive(Debug, Error)]
pub enum TronServiceError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("TRON network request failed: {0}")]
    Network(String),
    #[error("TRON transaction signing failed: {0}")]
    Signing(String),
}

pub type TronServiceResult<T> = Result<T, TronServiceError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TronAccountSnapshot {
    pub address: String,
    pub balance_sun: u64,
    pub bandwidth_available: u64,
    pub energy_available: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TronTransferPreview {
    pub sender: String,
    pub recipient: String,
    pub amount_sun: u64,
    pub txid: String,
    pub expiration_ms: u64,
    pub estimated_bandwidth_bytes: u64,
    pub bandwidth_available: u64,
    pub bandwidth_price_sun: u64,
    pub recipient_activated: bool,
    pub account_activation_fee_sun: u64,
    pub estimated_max_fee_sun: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TronBroadcastResult {
    pub txid: String,
}

#[derive(Debug, Deserialize)]
struct TronAccountWire {
    #[serde(default)]
    balance: i64,
}

pub struct TronAdapter {
    descriptor: ChainDescriptor,
}

impl TronAdapter {
    pub fn mainnet() -> ChainResult<Self> {
        Self::new(
            TRON_MAINNET_CAIP2,
            "TRON",
            "mainnet",
            false,
            TRON_MAINNET_HTTP_URL,
            "https://tronscan.org",
        )
    }

    pub fn shasta() -> ChainResult<Self> {
        Self::new(
            TRON_SHASTA_CAIP2,
            "TRON Shasta",
            "shasta",
            true,
            TRON_SHASTA_HTTP_URL,
            "https://shasta.tronscan.org",
        )
    }

    pub fn nile() -> ChainResult<Self> {
        Self::new(
            TRON_NILE_CAIP2,
            "TRON Nile",
            "nile",
            true,
            TRON_NILE_HTTP_URL,
            "https://nile.tronscan.org",
        )
    }

    fn new(
        chain_id: &str,
        name: &str,
        network: &str,
        testnet: bool,
        endpoint: &str,
        explorer_url: &str,
    ) -> ChainResult<Self> {
        Ok(Self {
            descriptor: ChainDescriptor {
                chain_id: ChainId::from_str(chain_id)?,
                family: ChainFamily::new(families::TRON)?,
                name: name.to_string(),
                network: network.to_string(),
                testnet,
                native_asset: NativeAsset {
                    symbol: "TRX".to_string(),
                    name: "TRON".to_string(),
                    decimals: 6,
                },
                default_derivation_path: TRON_DERIVATION_PATH.to_string(),
                address_formats: vec!["base58check".to_string()],
                capabilities: capability_ids(&[
                    capabilities::ACCOUNT_DERIVATION,
                    capabilities::ADDRESS_VALIDATION,
                    capabilities::NATIVE_BALANCE,
                    capabilities::TRANSFER,
                ])?,
                endpoints: vec![ChainEndpoint {
                    kind: "tron-http".to_string(),
                    url: endpoint.to_string(),
                }],
                explorer_url: Some(explorer_url.to_string()),
                support_level: SupportLevel::Experimental,
            },
        })
    }
}

impl ChainAdapter for TronAdapter {
    fn descriptor(&self) -> &ChainDescriptor {
        &self.descriptor
    }

    fn normalize_address(&self, address: &str) -> ChainResult<String> {
        validate_address_input(address)?;
        let address = address.trim();
        let decoded = bs58::decode(address)
            .with_check(None)
            .into_vec()
            .map_err(|_| {
                ChainError::InvalidAddress("invalid TRON Base58Check address".to_string())
            })?;
        if decoded.len() != 21 || decoded[0] != TRON_ADDRESS_PREFIX {
            return Err(ChainError::InvalidAddress(
                "TRON address must contain the 0x41 network prefix".to_string(),
            ));
        }
        Ok(bs58::encode(decoded).with_check().into_string())
    }

    fn derive_account(
        &self,
        mnemonic: &str,
        derivation_path: Option<&str>,
    ) -> ChainResult<DerivedAccount> {
        validate_mnemonic_input(mnemonic)?;
        if let Some(path) = derivation_path {
            validate_derivation_path_input(path)?;
        }
        let normalized_mnemonic =
            Zeroizing::new(mnemonic.split_whitespace().collect::<Vec<_>>().join(" "));
        let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalized_mnemonic)
            .map_err(|_| ChainError::InvalidMnemonic)?;
        let path_text = derivation_path
            .map(str::trim)
            .unwrap_or(TRON_DERIVATION_PATH);
        let path = DerivationPath::from_str(path_text)
            .map_err(|error| ChainError::InvalidDerivationPath(error.to_string()))?;
        validate_tron_derivation_path(&path)?;
        let seed = Zeroizing::new(mnemonic.to_seed(""));
        let xprv = bip32::XPrv::derive_from_path(seed.as_slice(), &path)
            .map_err(|error| ChainError::DerivationFailed(error.to_string()))?;
        let mut private_key = Zeroizing::new(xprv.private_key().to_bytes().to_vec());
        let signing_key = SigningKey::from_slice(private_key.as_slice())
            .map_err(|_| ChainError::DerivationFailed("derived TRON key is invalid".to_string()))?;
        private_key.zeroize();
        derived_account(&self.descriptor, &signing_key, &path.to_string())
    }
}

fn validate_tron_derivation_path(path: &DerivationPath) -> ChainResult<()> {
    let components = path.as_ref();
    let valid = components.len() == 5
        && components[0].is_hardened()
        && components[0].index() == 44
        && components[1].is_hardened()
        && components[1].index() == 195
        && components[2].is_hardened()
        && !components[3].is_hardened()
        && matches!(components[3].index(), 0 | 1)
        && !components[4].is_hardened();
    if !valid {
        return Err(ChainError::InvalidDerivationPath(
            "expected TRON BIP44 path m/44'/195'/account'/change/index".to_string(),
        ));
    }
    Ok(())
}

fn derived_account(
    descriptor: &ChainDescriptor,
    signing_key: &SigningKey,
    derivation_path: &str,
) -> ChainResult<DerivedAccount> {
    let verifying_key = signing_key.verifying_key();
    let encoded = verifying_key.to_encoded_point(false);
    let public_key = encoded.as_bytes();
    let digest = Keccak256::digest(&public_key[1..]);
    let mut payload = Vec::with_capacity(21);
    payload.push(TRON_ADDRESS_PREFIX);
    payload.extend_from_slice(&digest[12..]);
    let address = bs58::encode(payload).with_check().into_string();
    DerivedAccount::new(
        descriptor.chain_id.clone(),
        address,
        derivation_path.to_string(),
        Some(hex::encode(public_key)),
    )
}

pub fn address_from_private_key(private_key: &[u8]) -> ChainResult<String> {
    let signing_key = SigningKey::from_slice(private_key)
        .map_err(|_| ChainError::DerivationFailed("TRON private key is invalid".to_string()))?;
    Ok(derived_account(
        &TronAdapter::mainnet()?.descriptor,
        &signing_key,
        TRON_DERIVATION_PATH,
    )?
    .address)
}

fn network_endpoint(chain_id: &str) -> TronServiceResult<&'static str> {
    match chain_id {
        TRON_MAINNET_CAIP2 => Ok(TRON_MAINNET_HTTP_URL),
        TRON_SHASTA_CAIP2 => Ok(TRON_SHASTA_HTTP_URL),
        TRON_NILE_CAIP2 => Ok(TRON_NILE_HTTP_URL),
        _ => Err(TronServiceError::InvalidInput(
            "unsupported TRON chain id".to_string(),
        )),
    }
}

pub fn private_key_from_mnemonic(mnemonic: &str) -> TronServiceResult<Zeroizing<[u8; 32]>> {
    validate_mnemonic_input(mnemonic)
        .map_err(|error| TronServiceError::InvalidInput(error.to_string()))?;
    let normalized = Zeroizing::new(mnemonic.split_whitespace().collect::<Vec<_>>().join(" "));
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalized)
        .map_err(|_| TronServiceError::InvalidInput("invalid mnemonic".to_string()))?;
    let path = DerivationPath::from_str(TRON_DERIVATION_PATH)
        .map_err(|error| TronServiceError::InvalidInput(error.to_string()))?;
    let seed = Zeroizing::new(mnemonic.to_seed(""));
    let xprv = bip32::XPrv::derive_from_path(seed.as_slice(), &path)
        .map_err(|error| TronServiceError::InvalidInput(error.to_string()))?;
    Ok(Zeroizing::new(xprv.private_key().to_bytes().into()))
}

fn normalize_tron_address(address: &str) -> TronServiceResult<String> {
    TronAdapter::mainnet()
        .map_err(|error| TronServiceError::InvalidInput(error.to_string()))?
        .normalize_address(address)
        .map_err(|error| TronServiceError::InvalidInput(error.to_string()))
}

fn http_client() -> TronServiceResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| TronServiceError::Network(error.to_string()))
}

async fn post_json(endpoint: &str, path: &str, body: Value) -> TronServiceResult<Value> {
    let response = http_client()?
        .post(format!("{endpoint}/{path}"))
        .json(&body)
        .send()
        .await
        .map_err(|error| TronServiceError::Network(error.to_string()))?;
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|error| TronServiceError::Network(error.to_string()))?;
    if !status.is_success() {
        return Err(TronServiceError::Network(format!(
            "HTTP {status}: {}",
            value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("request rejected")
        )));
    }
    Ok(value)
}

fn nonnegative_u64(value: Option<i64>, field: &str) -> TronServiceResult<u64> {
    u64::try_from(value.unwrap_or_default())
        .map_err(|_| TronServiceError::Network(format!("invalid {field} response")))
}

fn available_resource(value: &Value, limit: &str, used: &str) -> TronServiceResult<u64> {
    let limit = nonnegative_u64(value.get(limit).and_then(Value::as_i64), limit)?;
    let used = nonnegative_u64(value.get(used).and_then(Value::as_i64), used)?;
    Ok(limit.saturating_sub(used))
}

async fn fetch_account_value(endpoint: &str, address: &str) -> TronServiceResult<Value> {
    post_json(
        endpoint,
        "wallet/getaccount",
        json!({ "address": address, "visible": true }),
    )
    .await
}

async fn fetch_resources_value(endpoint: &str, address: &str) -> TronServiceResult<Value> {
    post_json(
        endpoint,
        "wallet/getaccountresource",
        json!({ "address": address, "visible": true }),
    )
    .await
}

pub async fn fetch_account(
    chain_id: &str,
    address: &str,
) -> TronServiceResult<TronAccountSnapshot> {
    let endpoint = network_endpoint(chain_id)?;
    let address = normalize_tron_address(address)?;
    let account = fetch_account_value(endpoint, &address).await?;
    let account: TronAccountWire = serde_json::from_value(account)
        .map_err(|error| TronServiceError::Network(error.to_string()))?;
    let resources = fetch_resources_value(endpoint, &address).await?;
    let free_bandwidth = available_resource(&resources, "freeNetLimit", "freeNetUsed")?;
    let staked_bandwidth = available_resource(&resources, "NetLimit", "NetUsed")?;
    let energy_available = available_resource(&resources, "EnergyLimit", "EnergyUsed")?;
    Ok(TronAccountSnapshot {
        address,
        balance_sun: nonnegative_u64(Some(account.balance), "TRON balance")?,
        bandwidth_available: free_bandwidth.saturating_add(staked_bandwidth),
        energy_available,
    })
}

async fn chain_parameters(endpoint: &str) -> TronServiceResult<(u64, u64)> {
    let value = post_json(endpoint, "wallet/getchainparameters", json!({})).await?;
    let parameters = value
        .get("chainParameter")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            TronServiceError::Network("invalid chain parameters response".to_string())
        })?;
    let parameter = |key: &str, default_value: u64| {
        parameters
            .iter()
            .find(|entry| entry.get("key").and_then(Value::as_str) == Some(key))
            .and_then(|entry| entry.get("value"))
            .and_then(Value::as_u64)
            .unwrap_or(default_value)
    };
    Ok((
        parameter("getTransactionFee", DEFAULT_BANDWIDTH_PRICE_SUN),
        parameter(
            "getCreateNewAccountFeeInSystemContract",
            DEFAULT_ACCOUNT_ACTIVATION_FEE_SUN,
        ),
    ))
}

async fn create_transfer_transaction(
    endpoint: &str,
    sender: &str,
    recipient: &str,
    amount_sun: u64,
) -> TronServiceResult<Value> {
    if amount_sun == 0 || amount_sun > MAX_TRON_AMOUNT_SUN {
        return Err(TronServiceError::InvalidInput(
            "TRON amount is outside the supported range".to_string(),
        ));
    }
    let value = post_json(
        endpoint,
        "wallet/createtransaction",
        json!({
            "owner_address": sender,
            "to_address": recipient,
            "amount": amount_sun,
            "visible": true,
        }),
    )
    .await?;
    if value.get("Error").is_some()
        || value
            .get("result")
            .and_then(|item| item.get("result"))
            .and_then(Value::as_bool)
            == Some(false)
    {
        return Err(TronServiceError::Network(
            value
                .get("Error")
                .and_then(Value::as_str)
                .or_else(|| value.pointer("/result/message").and_then(Value::as_str))
                .unwrap_or("TRON node rejected transaction creation")
                .to_string(),
        ));
    }
    validate_transaction(&value, sender, recipient, amount_sun)?;
    Ok(value)
}

fn transaction_contract_value(transaction: &Value) -> Option<&Value> {
    transaction.pointer("/raw_data/contract/0/parameter/value")
}

fn transaction_raw_data(transaction: &Value) -> TronServiceResult<Zeroizing<Vec<u8>>> {
    let raw_hex = transaction
        .get("raw_data_hex")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            TronServiceError::Network("TRON transaction is missing raw_data_hex".to_string())
        })?;
    if raw_hex.len() > 16_384 || raw_hex.len() % 2 != 0 {
        return Err(TronServiceError::Network(
            "TRON transaction raw_data_hex is invalid".to_string(),
        ));
    }
    let bytes = hex::decode(raw_hex).map_err(|_| {
        TronServiceError::Network("TRON transaction raw_data_hex is invalid".to_string())
    })?;
    if bytes.is_empty() {
        return Err(TronServiceError::Network(
            "TRON transaction raw_data_hex is empty".to_string(),
        ));
    }
    Ok(Zeroizing::new(bytes))
}

fn now_ms() -> TronServiceResult<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| TronServiceError::Signing(error.to_string()))
}

fn validate_transaction(
    transaction: &Value,
    sender: &str,
    recipient: &str,
    amount_sun: u64,
) -> TronServiceResult<()> {
    let contract = transaction_contract_value(transaction).ok_or_else(|| {
        TronServiceError::Network("TRON transaction contract is missing".to_string())
    })?;
    if contract.get("owner_address").and_then(Value::as_str) != Some(sender)
        || contract.get("to_address").and_then(Value::as_str) != Some(recipient)
        || contract.get("amount").and_then(Value::as_u64) != Some(amount_sun)
    {
        return Err(TronServiceError::Network(
            "TRON node returned a transaction that does not match the request".to_string(),
        ));
    }
    let expiration = transaction
        .pointer("/raw_data/expiration")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            TronServiceError::Network("TRON transaction expiration is missing".to_string())
        })?;
    let now = now_ms()?;
    if expiration <= now || expiration > now.saturating_add(MAX_TRANSACTION_LIFETIME_MS) {
        return Err(TronServiceError::Network(
            "TRON transaction expiration is outside the safety window".to_string(),
        ));
    }
    let raw_data = transaction_raw_data(transaction)?;
    let calculated_txid = hex::encode(Sha256::digest(raw_data.as_slice()));
    if transaction.get("txID").and_then(Value::as_str) != Some(calculated_txid.as_str()) {
        return Err(TronServiceError::Network(
            "TRON transaction id does not match raw_data".to_string(),
        ));
    }
    Ok(())
}

async fn transfer_preview_from_transaction(
    endpoint: &str,
    transaction: &Value,
    sender: &str,
    recipient: &str,
    amount_sun: u64,
) -> TronServiceResult<TronTransferPreview> {
    let raw_data = transaction_raw_data(transaction)?;
    let estimated_bandwidth_bytes = u64::try_from(raw_data.len())
        .map_err(|_| TronServiceError::Network("TRON transaction is too large".to_string()))?
        .saturating_add(67);
    let resources = fetch_resources_value(endpoint, sender).await?;
    let bandwidth_available = available_resource(&resources, "freeNetLimit", "freeNetUsed")?
        .saturating_add(available_resource(&resources, "NetLimit", "NetUsed")?);
    let recipient_account = fetch_account_value(endpoint, recipient).await?;
    let recipient_activated = recipient_account
        .get("address")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let (bandwidth_price_sun, activation_fee) = chain_parameters(endpoint).await?;
    let account_activation_fee_sun = if recipient_activated {
        0
    } else {
        activation_fee
    };
    let estimated_max_fee_sun = estimated_bandwidth_bytes
        .saturating_sub(bandwidth_available)
        .saturating_mul(bandwidth_price_sun)
        .saturating_add(account_activation_fee_sun);
    let sender_account = fetch_account_value(endpoint, sender).await?;
    let sender_balance = nonnegative_u64(
        sender_account.get("balance").and_then(Value::as_i64),
        "TRON balance",
    )?;
    if sender_balance < amount_sun.saturating_add(estimated_max_fee_sun) {
        return Err(TronServiceError::InvalidInput(
            "insufficient TRX balance for the amount and estimated resource fee".to_string(),
        ));
    }
    Ok(TronTransferPreview {
        sender: sender.to_string(),
        recipient: recipient.to_string(),
        amount_sun,
        txid: transaction
            .get("txID")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        expiration_ms: transaction
            .pointer("/raw_data/expiration")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        estimated_bandwidth_bytes,
        bandwidth_available,
        bandwidth_price_sun,
        recipient_activated,
        account_activation_fee_sun,
        estimated_max_fee_sun,
    })
}

pub async fn preview_transfer(
    chain_id: &str,
    sender: &str,
    recipient: &str,
    amount_sun: u64,
) -> TronServiceResult<TronTransferPreview> {
    let endpoint = network_endpoint(chain_id)?;
    let sender = normalize_tron_address(sender)?;
    let recipient = normalize_tron_address(recipient)?;
    let transaction =
        create_transfer_transaction(endpoint, &sender, &recipient, amount_sun).await?;
    transfer_preview_from_transaction(endpoint, &transaction, &sender, &recipient, amount_sun).await
}

pub async fn prepare_transfer(
    chain_id: &str,
    sender: &str,
    recipient: &str,
    amount_sun: u64,
) -> TronServiceResult<(TronTransferPreview, Value)> {
    let endpoint = network_endpoint(chain_id)?;
    let sender = normalize_tron_address(sender)?;
    let recipient = normalize_tron_address(recipient)?;
    let transaction =
        create_transfer_transaction(endpoint, &sender, &recipient, amount_sun).await?;
    let preview =
        transfer_preview_from_transaction(endpoint, &transaction, &sender, &recipient, amount_sun)
            .await?;
    Ok((preview, transaction))
}

fn sign_transaction(
    transaction: &mut Value,
    private_key: &[u8],
    expected_sender: &str,
    recipient: &str,
    amount_sun: u64,
) -> TronServiceResult<String> {
    validate_transaction(transaction, expected_sender, recipient, amount_sun)?;
    let signing_key = SigningKey::from_slice(private_key)
        .map_err(|_| TronServiceError::Signing("invalid TRON private key".to_string()))?;
    let actual_sender = address_from_private_key(private_key)
        .map_err(|error| TronServiceError::Signing(error.to_string()))?;
    if actual_sender != expected_sender {
        return Err(TronServiceError::Signing(
            "wallet mnemonic does not match the selected TRON account".to_string(),
        ));
    }
    let raw_data = transaction_raw_data(transaction)?;
    let digest = Sha256::digest(raw_data.as_slice());
    let (signature, recovery_id): (Signature, _) = signing_key
        .sign_prehash_recoverable(&digest)
        .map_err(|error| TronServiceError::Signing(error.to_string()))?;
    let mut signature_bytes = Zeroizing::new(Vec::with_capacity(65));
    signature_bytes.extend_from_slice(&signature.to_bytes());
    signature_bytes.push(recovery_id.to_byte());
    transaction["signature"] = json!([hex::encode(signature_bytes.as_slice())]);
    Ok(transaction
        .get("txID")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

pub async fn submit_transfer(
    chain_id: &str,
    mnemonic: &str,
    sender: &str,
    recipient: &str,
    amount_sun: u64,
) -> TronServiceResult<TronBroadcastResult> {
    let endpoint = network_endpoint(chain_id)?;
    let sender = normalize_tron_address(sender)?;
    let recipient = normalize_tron_address(recipient)?;
    let private_key = private_key_from_mnemonic(mnemonic)?;
    let mut transaction =
        create_transfer_transaction(endpoint, &sender, &recipient, amount_sun).await?;
    let txid = sign_transaction(
        &mut transaction,
        private_key.as_ref(),
        &sender,
        &recipient,
        amount_sun,
    )?;
    let response = post_json(endpoint, "wallet/broadcasttransaction", transaction).await?;
    if response.get("result").and_then(Value::as_bool) != Some(true) {
        return Err(TronServiceError::Network(
            response
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("TRON node rejected the signed transaction")
                .to_string(),
        ));
    }
    Ok(TronBroadcastResult { txid })
}

pub async fn submit_prepared_transfer(
    chain_id: &str,
    mnemonic: &str,
    sender: &str,
    recipient: &str,
    amount_sun: u64,
    mut transaction: Value,
) -> TronServiceResult<TronBroadcastResult> {
    let endpoint = network_endpoint(chain_id)?;
    let sender = normalize_tron_address(sender)?;
    let recipient = normalize_tron_address(recipient)?;
    let private_key = private_key_from_mnemonic(mnemonic)?;
    let txid = sign_transaction(
        &mut transaction,
        private_key.as_ref(),
        &sender,
        &recipient,
        amount_sun,
    )?;
    let response = post_json(endpoint, "wallet/broadcasttransaction", transaction).await?;
    if response.get("result").and_then(Value::as_bool) != Some(true) {
        return Err(TronServiceError::Network(
            response
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("TRON node rejected the signed transaction")
                .to_string(),
        ));
    }
    Ok(TronBroadcastResult { txid })
}

pub fn builtin_adapters() -> ChainResult<Vec<TronAdapter>> {
    Ok(vec![
        TronAdapter::mainnet()?,
        TronAdapter::shasta()?,
        TronAdapter::nile()?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    const MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn derives_and_validates_a_tron_account() {
        let adapter = TronAdapter::mainnet().unwrap();
        let account = adapter.derive_account(MNEMONIC, None).unwrap();
        assert!(account.address.starts_with('T'));
        assert_eq!(
            adapter.normalize_address(&account.address).unwrap(),
            account.address
        );
        assert_eq!(account.derivation_path, TRON_DERIVATION_PATH);
        assert_eq!(
            adapter
                .derive_account(&format!("  {}  ", MNEMONIC.replace(' ', "  ")), None)
                .unwrap()
                .address,
            account.address
        );
    }

    #[test]
    fn matches_private_key_one_address_vector() {
        let mut key = [0u8; 32];
        key[31] = 1;
        assert_eq!(
            address_from_private_key(&key).unwrap(),
            "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC"
        );
    }

    #[test]
    fn rejects_a_bad_checksum() {
        let adapter = TronAdapter::mainnet().unwrap();
        assert!(adapter
            .normalize_address("TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HD")
            .is_err());
    }

    #[test]
    fn rejects_non_tron_derivation_paths() {
        let adapter = TronAdapter::mainnet().unwrap();
        assert!(adapter
            .derive_account(MNEMONIC, Some("m/44'/60'/0'/0/0"))
            .is_err());
        assert!(adapter
            .derive_account(MNEMONIC, Some("m/44'/195'/0'/0'/0"))
            .is_err());
        assert!(adapter
            .derive_account(MNEMONIC, Some("m/44'/195'/0'/2/0"))
            .is_err());
        assert!(adapter
            .derive_account(MNEMONIC, Some("  m/44'/195'/7'/1/42  "))
            .is_ok_and(|account| account.derivation_path == "m/44'/195'/7'/1/42"));
    }

    #[test]
    fn direct_adapter_calls_enforce_identity_input_bounds() {
        let adapter = TronAdapter::mainnet().unwrap();
        assert!(matches!(
            adapter.normalize_address(&"T".repeat(129)),
            Err(ChainError::InvalidAddress(_))
        ));
        assert_eq!(
            adapter.derive_account(&"word ".repeat(1_025), None),
            Err(ChainError::InvalidMnemonic)
        );
        assert!(matches!(
            adapter.derive_account(MNEMONIC, Some(&"m".repeat(257))),
            Err(ChainError::InvalidDerivationPath(_))
        ));
    }

    #[test]
    fn mnemonic_private_key_matches_the_tron_account() {
        let key = private_key_from_mnemonic(MNEMONIC).unwrap();
        let address = address_from_private_key(key.as_ref()).unwrap();
        assert_eq!(
            address,
            TronAdapter::mainnet()
                .unwrap()
                .derive_account(MNEMONIC, None)
                .unwrap()
                .address
        );
    }

    #[test]
    fn validates_and_signs_only_the_expected_transfer() {
        let key = private_key_from_mnemonic(MNEMONIC).unwrap();
        let sender = address_from_private_key(key.as_ref()).unwrap();
        let recipient = "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC";
        let raw_data = [1_u8, 2, 3, 4];
        let txid = hex::encode(Sha256::digest(raw_data));
        let mut transaction = json!({
            "txID": txid,
            "raw_data_hex": hex::encode(raw_data),
            "raw_data": {
                "expiration": now_ms().unwrap() + 60_000,
                "contract": [{
                    "parameter": {
                        "value": {
                            "owner_address": sender,
                            "to_address": recipient,
                            "amount": 1_000_000_u64
                        }
                    }
                }]
            }
        });
        let signed_txid = sign_transaction(
            &mut transaction,
            key.as_ref(),
            &sender,
            recipient,
            1_000_000,
        )
        .unwrap();
        assert_eq!(signed_txid, txid);
        assert_eq!(transaction["signature"][0].as_str().unwrap().len(), 130);

        transaction["raw_data"]["contract"][0]["parameter"]["value"]["amount"] =
            json!(2_000_000_u64);
        assert!(validate_transaction(&transaction, &sender, recipient, 1_000_000).is_err());
    }
}
