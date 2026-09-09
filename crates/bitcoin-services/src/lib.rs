//! Bitcoin account derivation and address validation for the multi-chain registry.
//!
//! Transaction building and broadcasting are intentionally not advertised yet. They will use
//! PSBT-based flows rather than forcing Bitcoin into an account-chain transaction model.

#![forbid(unsafe_code)]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use bip32::DerivationPath;
use bip39::{Language, Mnemonic};
use bitcoin::absolute::LockTime;
use bitcoin::consensus::encode;
use bitcoin::hashes::Hash;
use bitcoin::key::CompressedPublicKey;
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::{Message, PublicKey, Secp256k1, SecretKey};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::transaction::Version;
use bitcoin::{
    Address, AddressType, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut,
    Txid, Witness,
};
use fnzero_safe_chain_core::{
    capabilities, capability_ids, families, validate_address_input, validate_derivation_path_input,
    validate_mnemonic_input, ChainAdapter, ChainDescriptor, ChainEndpoint, ChainError, ChainFamily,
    ChainId, ChainResult, DerivedAccount, NativeAsset, SupportLevel,
};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::time::Duration;
use thiserror::Error;
use zeroize::Zeroizing;

pub const BITCOIN_MAINNET_CAIP2: &str = "bip122:000000000019d6689c085ae165831e93";
pub const BITCOIN_TESTNET_CAIP2: &str = "bip122:000000000933ea01ad0ee984209779ba";
pub const BITCOIN_MAINNET_DERIVATION_PATH: &str = "m/84'/0'/0'/0/0";
pub const BITCOIN_TESTNET_DERIVATION_PATH: &str = "m/84'/1'/0'/0/0";
pub const BITCOIN_MAINNET_ESPLORA_URL: &str = "https://blockstream.info/api";
pub const BITCOIN_TESTNET_ESPLORA_URL: &str = "https://blockstream.info/testnet/api";
const BITCOIN_DUST_SATS: u64 = 294;
const DEFAULT_FEE_RATE_SAT_VB: f64 = 5.0;
const MAX_FEE_RATE_SAT_VB: f64 = 500.0;
const MAX_TRANSACTION_INPUTS: usize = 200;
const MAX_ABSOLUTE_FEE_SATS: u64 = 1_000_000;

#[derive(Debug, Error)]
pub enum BitcoinServiceError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("Bitcoin network request failed: {0}")]
    Network(String),
    #[error("insufficient confirmed Bitcoin balance")]
    InsufficientFunds,
    #[error("Bitcoin transaction signing failed: {0}")]
    Signing(String),
}

pub type BitcoinServiceResult<T> = Result<T, BitcoinServiceError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BitcoinBalance {
    pub address: String,
    pub confirmed_sats: u64,
    pub unconfirmed_sats: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BitcoinTransferPreview {
    pub sender: String,
    pub recipient: String,
    pub amount_sats: u64,
    pub fee_sats: u64,
    pub fee_rate_sat_vb: f64,
    pub total_input_sats: u64,
    pub change_sats: u64,
    pub input_count: usize,
    pub output_count: usize,
    pub rbf: bool,
    pub psbt_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BitcoinBroadcastResult {
    pub txid: String,
}

#[derive(Debug, Clone, Deserialize)]
struct EsploraAddressStats {
    funded_txo_sum: u64,
    spent_txo_sum: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct EsploraAddress {
    chain_stats: EsploraAddressStats,
    mempool_stats: EsploraAddressStats,
}

#[derive(Debug, Clone, Deserialize)]
struct EsploraUtxoStatus {
    confirmed: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct EsploraUtxo {
    txid: String,
    vout: u32,
    value: u64,
    status: EsploraUtxoStatus,
}

#[derive(Debug)]
struct PreparedBitcoinTransfer {
    psbt: Psbt,
    preview: BitcoinTransferPreview,
}

pub struct BitcoinAdapter {
    descriptor: ChainDescriptor,
    network: Network,
}

impl BitcoinAdapter {
    pub fn mainnet() -> ChainResult<Self> {
        Self::new(
            BITCOIN_MAINNET_CAIP2,
            "Bitcoin",
            "mainnet",
            false,
            Network::Bitcoin,
            BITCOIN_MAINNET_DERIVATION_PATH,
            BITCOIN_MAINNET_ESPLORA_URL,
            "https://mempool.space",
        )
    }

    pub fn testnet() -> ChainResult<Self> {
        Self::new(
            BITCOIN_TESTNET_CAIP2,
            "Bitcoin Testnet",
            "testnet",
            true,
            Network::Testnet,
            BITCOIN_TESTNET_DERIVATION_PATH,
            BITCOIN_TESTNET_ESPLORA_URL,
            "https://mempool.space/testnet",
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        chain_id: &str,
        name: &str,
        network_name: &str,
        testnet: bool,
        network: Network,
        derivation_path: &str,
        endpoint: &str,
        explorer_url: &str,
    ) -> ChainResult<Self> {
        Ok(Self {
            descriptor: ChainDescriptor {
                chain_id: ChainId::from_str(chain_id)?,
                family: ChainFamily::new(families::BITCOIN)?,
                name: name.to_string(),
                network: network_name.to_string(),
                testnet,
                native_asset: NativeAsset {
                    symbol: "BTC".to_string(),
                    name: "Bitcoin".to_string(),
                    decimals: 8,
                },
                default_derivation_path: derivation_path.to_string(),
                address_formats: vec!["p2wpkh".to_string()],
                capabilities: capability_ids(&[
                    capabilities::ACCOUNT_DERIVATION,
                    capabilities::ADDRESS_VALIDATION,
                    capabilities::NATIVE_BALANCE,
                    capabilities::TRANSFER,
                ])?,
                endpoints: vec![ChainEndpoint {
                    kind: "esplora".to_string(),
                    url: endpoint.to_string(),
                }],
                explorer_url: Some(explorer_url.to_string()),
                support_level: SupportLevel::Experimental,
            },
            network,
        })
    }
}

impl ChainAdapter for BitcoinAdapter {
    fn descriptor(&self) -> &ChainDescriptor {
        &self.descriptor
    }

    fn normalize_address(&self, address: &str) -> ChainResult<String> {
        validate_address_input(address)?;
        let unchecked = Address::from_str(address.trim())
            .map_err(|_| ChainError::InvalidAddress("invalid Bitcoin address".to_string()))?;
        let checked = unchecked.require_network(self.network).map_err(|_| {
            ChainError::InvalidAddress(format!(
                "Bitcoin address does not belong to {}",
                self.descriptor.network
            ))
        })?;
        if checked.address_type() != Some(AddressType::P2wpkh) {
            return Err(ChainError::InvalidAddress(
                "only BIP84 P2WPKH addresses are enabled in the experimental adapter".to_string(),
            ));
        }
        Ok(checked.to_string())
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
            .unwrap_or(&self.descriptor.default_derivation_path);
        let path = DerivationPath::from_str(path_text)
            .map_err(|error| ChainError::InvalidDerivationPath(error.to_string()))?;
        validate_bip84_path(&path, self.network)?;
        let seed = Zeroizing::new(mnemonic.to_seed(""));
        let child = bip32::XPrv::derive_from_path(seed.as_slice(), &path)
            .map_err(|error| ChainError::DerivationFailed(error.to_string()))?;
        let public_key = child.public_key().to_bytes();
        let compressed = CompressedPublicKey(
            PublicKey::from_slice(&public_key)
                .map_err(|error| ChainError::DerivationFailed(error.to_string()))?,
        );
        let address = Address::p2wpkh(&compressed, self.network).to_string();
        DerivedAccount::new(
            self.descriptor.chain_id.clone(),
            address,
            path.to_string(),
            Some(hex::encode(compressed.to_bytes())),
        )
    }
}

fn validate_bip84_path(path: &DerivationPath, network: Network) -> ChainResult<()> {
    let coin_type = if network == Network::Bitcoin { 0 } else { 1 };
    let components = path.as_ref();
    let valid = components.len() == 5
        && components[0].is_hardened()
        && components[0].index() == 84
        && components[1].is_hardened()
        && components[1].index() == coin_type
        && components[2].is_hardened()
        && !components[3].is_hardened()
        && matches!(components[3].index(), 0 | 1)
        && !components[4].is_hardened();
    if !valid {
        return Err(ChainError::InvalidDerivationPath(format!(
            "expected BIP84 path m/84'/{coin_type}'/account'/change/index"
        )));
    }
    Ok(())
}

fn network_config(chain_id: &str) -> BitcoinServiceResult<(Network, &'static str, &'static str)> {
    match chain_id {
        BITCOIN_MAINNET_CAIP2 => Ok((
            Network::Bitcoin,
            BITCOIN_MAINNET_DERIVATION_PATH,
            BITCOIN_MAINNET_ESPLORA_URL,
        )),
        BITCOIN_TESTNET_CAIP2 => Ok((
            Network::Testnet,
            BITCOIN_TESTNET_DERIVATION_PATH,
            BITCOIN_TESTNET_ESPLORA_URL,
        )),
        _ => Err(BitcoinServiceError::InvalidInput(
            "unsupported Bitcoin chain id".to_string(),
        )),
    }
}

pub fn private_key_from_mnemonic(
    mnemonic: &str,
    chain_id: &str,
) -> BitcoinServiceResult<Zeroizing<[u8; 32]>> {
    let (network, derivation_path, _) = network_config(chain_id)?;
    validate_mnemonic_input(mnemonic)
        .map_err(|error| BitcoinServiceError::InvalidInput(error.to_string()))?;
    let normalized = Zeroizing::new(mnemonic.split_whitespace().collect::<Vec<_>>().join(" "));
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &normalized)
        .map_err(|_| BitcoinServiceError::InvalidInput("invalid mnemonic".to_string()))?;
    let path = DerivationPath::from_str(derivation_path)
        .map_err(|error| BitcoinServiceError::InvalidInput(error.to_string()))?;
    validate_bip84_path(&path, network)
        .map_err(|error| BitcoinServiceError::InvalidInput(error.to_string()))?;
    let seed = Zeroizing::new(mnemonic.to_seed(""));
    let child = bip32::XPrv::derive_from_path(seed.as_slice(), &path)
        .map_err(|error| BitcoinServiceError::InvalidInput(error.to_string()))?;
    Ok(Zeroizing::new(child.private_key().to_bytes().into()))
}

pub fn address_from_private_key(
    private_key: &[u8],
    chain_id: &str,
) -> BitcoinServiceResult<String> {
    let (network, _, _) = network_config(chain_id)?;
    let secret_key = SecretKey::from_slice(private_key).map_err(|_| {
        BitcoinServiceError::InvalidInput("invalid Bitcoin private key".to_string())
    })?;
    let public_key = PublicKey::from_secret_key(&Secp256k1::new(), &secret_key);
    let compressed = CompressedPublicKey(public_key);
    Ok(Address::p2wpkh(&compressed, network).to_string())
}

fn checked_address(value: &str, network: Network) -> BitcoinServiceResult<Address> {
    Address::from_str(value.trim())
        .map_err(|_| BitcoinServiceError::InvalidInput("invalid Bitcoin address".to_string()))?
        .require_network(network)
        .map_err(|_| {
            BitcoinServiceError::InvalidInput(
                "Bitcoin address belongs to a different network".to_string(),
            )
        })
}

fn http_client() -> BitcoinServiceResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| BitcoinServiceError::Network(error.to_string()))
}

async fn response_error(response: reqwest::Response) -> BitcoinServiceError {
    let status = response.status();
    let message = response.text().await.unwrap_or_default();
    BitcoinServiceError::Network(if message.trim().is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {}", message.trim())
    })
}

pub async fn fetch_balance(chain_id: &str, address: &str) -> BitcoinServiceResult<BitcoinBalance> {
    let (network, _, endpoint) = network_config(chain_id)?;
    let address = checked_address(address, network)?.to_string();
    let response = http_client()?
        .get(format!("{endpoint}/address/{address}"))
        .send()
        .await
        .map_err(|error| BitcoinServiceError::Network(error.to_string()))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let snapshot = response
        .json::<EsploraAddress>()
        .await
        .map_err(|error| BitcoinServiceError::Network(error.to_string()))?;
    let confirmed_sats = snapshot
        .chain_stats
        .funded_txo_sum
        .checked_sub(snapshot.chain_stats.spent_txo_sum)
        .ok_or_else(|| {
            BitcoinServiceError::Network("invalid confirmed balance response".to_string())
        })?;
    let unconfirmed_sats = i128::from(snapshot.mempool_stats.funded_txo_sum)
        - i128::from(snapshot.mempool_stats.spent_txo_sum);
    let unconfirmed_sats = i64::try_from(unconfirmed_sats).map_err(|_| {
        BitcoinServiceError::Network("invalid mempool balance response".to_string())
    })?;
    Ok(BitcoinBalance {
        address,
        confirmed_sats,
        unconfirmed_sats,
    })
}

async fn fetch_confirmed_utxos(
    endpoint: &str,
    address: &str,
) -> BitcoinServiceResult<Vec<EsploraUtxo>> {
    let response = http_client()?
        .get(format!("{endpoint}/address/{address}/utxo"))
        .send()
        .await
        .map_err(|error| BitcoinServiceError::Network(error.to_string()))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let mut utxos = response
        .json::<Vec<EsploraUtxo>>()
        .await
        .map_err(|error| BitcoinServiceError::Network(error.to_string()))?;
    utxos.retain(|utxo| utxo.status.confirmed);
    utxos.sort_by(|left, right| right.value.cmp(&left.value));
    if utxos.len() > MAX_TRANSACTION_INPUTS {
        utxos.truncate(MAX_TRANSACTION_INPUTS);
    }
    Ok(utxos)
}

async fn fetch_fee_rate(endpoint: &str) -> BitcoinServiceResult<f64> {
    let response = http_client()?
        .get(format!("{endpoint}/fee-estimates"))
        .send()
        .await
        .map_err(|error| BitcoinServiceError::Network(error.to_string()))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let estimates = response
        .json::<std::collections::BTreeMap<String, f64>>()
        .await
        .map_err(|error| BitcoinServiceError::Network(error.to_string()))?;
    let fee_rate = estimates
        .get("6")
        .copied()
        .or_else(|| {
            estimates
                .values()
                .copied()
                .find(|value| value.is_finite() && *value > 0.0)
        })
        .unwrap_or(DEFAULT_FEE_RATE_SAT_VB)
        .ceil()
        .clamp(1.0, MAX_FEE_RATE_SAT_VB);
    Ok(fee_rate)
}

fn estimated_p2wpkh_vbytes(input_count: usize, output_count: usize) -> BitcoinServiceResult<u64> {
    let inputs = u64::try_from(input_count)
        .map_err(|_| BitcoinServiceError::InvalidInput("too many Bitcoin inputs".to_string()))?;
    let outputs = u64::try_from(output_count)
        .map_err(|_| BitcoinServiceError::InvalidInput("too many Bitcoin outputs".to_string()))?;
    11_u64
        .checked_add(inputs.checked_mul(69).ok_or_else(|| {
            BitcoinServiceError::InvalidInput("Bitcoin transaction size overflow".to_string())
        })?)
        .and_then(|value| value.checked_add(outputs.checked_mul(31)?))
        .ok_or_else(|| {
            BitcoinServiceError::InvalidInput("Bitcoin transaction size overflow".to_string())
        })
}

fn fee_for(
    input_count: usize,
    output_count: usize,
    fee_rate_sat_vb: f64,
) -> BitcoinServiceResult<u64> {
    if !fee_rate_sat_vb.is_finite() || !(1.0..=MAX_FEE_RATE_SAT_VB).contains(&fee_rate_sat_vb) {
        return Err(BitcoinServiceError::InvalidInput(
            "Bitcoin fee rate is outside the supported range".to_string(),
        ));
    }
    let fee = (estimated_p2wpkh_vbytes(input_count, output_count)? as f64 * fee_rate_sat_vb).ceil()
        as u64;
    if fee > MAX_ABSOLUTE_FEE_SATS {
        return Err(BitcoinServiceError::InvalidInput(
            "Bitcoin miner fee exceeds the safety limit".to_string(),
        ));
    }
    Ok(fee)
}

fn build_psbt(
    network: Network,
    sender: &str,
    recipient: &str,
    amount_sats: u64,
    fee_rate_sat_vb: f64,
    utxos: &[EsploraUtxo],
) -> BitcoinServiceResult<PreparedBitcoinTransfer> {
    if amount_sats < BITCOIN_DUST_SATS {
        return Err(BitcoinServiceError::InvalidInput(format!(
            "Bitcoin amount must be at least {BITCOIN_DUST_SATS} sats"
        )));
    }
    let sender = checked_address(sender, network)?;
    if sender.address_type() != Some(AddressType::P2wpkh) {
        return Err(BitcoinServiceError::InvalidInput(
            "only BIP84 P2WPKH sender addresses are supported".to_string(),
        ));
    }
    let recipient = checked_address(recipient, network)?;
    let mut selected = Vec::new();
    let mut total_input_sats = 0_u64;
    let mut fee_sats = 0_u64;
    let mut change_sats = 0_u64;
    for utxo in utxos {
        total_input_sats = total_input_sats.checked_add(utxo.value).ok_or_else(|| {
            BitcoinServiceError::InvalidInput("Bitcoin input value overflow".to_string())
        })?;
        selected.push(utxo);
        let two_output_fee = fee_for(selected.len(), 2, fee_rate_sat_vb)?;
        if total_input_sats
            >= amount_sats
                .saturating_add(two_output_fee)
                .saturating_add(BITCOIN_DUST_SATS)
        {
            fee_sats = two_output_fee;
            change_sats = total_input_sats - amount_sats - fee_sats;
            break;
        }
        let one_output_fee = fee_for(selected.len(), 1, fee_rate_sat_vb)?;
        if total_input_sats >= amount_sats.saturating_add(one_output_fee) {
            fee_sats = total_input_sats - amount_sats;
            change_sats = 0;
            break;
        }
    }
    if fee_sats == 0 || selected.is_empty() {
        return Err(BitcoinServiceError::InsufficientFunds);
    }
    if fee_sats > MAX_ABSOLUTE_FEE_SATS {
        return Err(BitcoinServiceError::InvalidInput(
            "Bitcoin miner fee exceeds the safety limit".to_string(),
        ));
    }

    let inputs = selected
        .iter()
        .map(|utxo| {
            let txid = Txid::from_str(&utxo.txid).map_err(|_| {
                BitcoinServiceError::Network("invalid UTXO transaction id".to_string())
            })?;
            Ok(TxIn {
                previous_output: OutPoint::new(txid, utxo.vout),
                script_sig: ScriptBuf::new(),
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: Witness::new(),
            })
        })
        .collect::<BitcoinServiceResult<Vec<_>>>()?;
    let mut outputs = vec![TxOut {
        value: Amount::from_sat(amount_sats),
        script_pubkey: recipient.script_pubkey(),
    }];
    if change_sats > 0 {
        outputs.push(TxOut {
            value: Amount::from_sat(change_sats),
            script_pubkey: sender.script_pubkey(),
        });
    }
    let transaction = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: inputs,
        output: outputs,
    };
    let mut psbt = Psbt::from_unsigned_tx(transaction)
        .map_err(|error| BitcoinServiceError::InvalidInput(error.to_string()))?;
    for (input, utxo) in psbt.inputs.iter_mut().zip(selected.iter()) {
        input.witness_utxo = Some(TxOut {
            value: Amount::from_sat(utxo.value),
            script_pubkey: sender.script_pubkey(),
        });
        input.sighash_type = Some(EcdsaSighashType::All.into());
    }
    let psbt_base64 = BASE64.encode(psbt.serialize());
    Ok(PreparedBitcoinTransfer {
        preview: BitcoinTransferPreview {
            sender: sender.to_string(),
            recipient: recipient.to_string(),
            amount_sats,
            fee_sats,
            fee_rate_sat_vb,
            total_input_sats,
            change_sats,
            input_count: selected.len(),
            output_count: psbt.unsigned_tx.output.len(),
            rbf: true,
            psbt_base64,
        },
        psbt,
    })
}

pub async fn preview_transfer(
    chain_id: &str,
    sender: &str,
    recipient: &str,
    amount_sats: u64,
) -> BitcoinServiceResult<BitcoinTransferPreview> {
    let (network, _, endpoint) = network_config(chain_id)?;
    let sender = checked_address(sender, network)?.to_string();
    let utxos = fetch_confirmed_utxos(endpoint, &sender).await?;
    let fee_rate = fetch_fee_rate(endpoint).await?;
    Ok(build_psbt(network, &sender, recipient, amount_sats, fee_rate, &utxos)?.preview)
}

fn sign_psbt(
    mut psbt: Psbt,
    private_key: &[u8],
    expected_sender: &str,
    network: Network,
) -> BitcoinServiceResult<Transaction> {
    let secret_key = SecretKey::from_slice(private_key)
        .map_err(|_| BitcoinServiceError::Signing("invalid private key".to_string()))?;
    let secp = Secp256k1::new();
    let public_key = PublicKey::from_secret_key(&secp, &secret_key);
    let compressed = CompressedPublicKey(public_key);
    let sender = Address::p2wpkh(&compressed, network);
    if sender.to_string() != expected_sender {
        return Err(BitcoinServiceError::Signing(
            "wallet key does not match the selected Bitcoin account".to_string(),
        ));
    }
    let unsigned_tx = psbt.unsigned_tx.clone();
    for index in 0..psbt.inputs.len() {
        let previous_output = psbt.inputs[index].witness_utxo.as_ref().ok_or_else(|| {
            BitcoinServiceError::Signing("PSBT input is missing its UTXO".to_string())
        })?;
        if previous_output.script_pubkey != sender.script_pubkey() {
            return Err(BitcoinServiceError::Signing(
                "PSBT contains an input from a different address".to_string(),
            ));
        }
        let sighash = SighashCache::new(&unsigned_tx)
            .p2wpkh_signature_hash(
                index,
                &previous_output.script_pubkey,
                previous_output.value,
                EcdsaSighashType::All,
            )
            .map_err(|error| BitcoinServiceError::Signing(error.to_string()))?;
        let message = Message::from_digest(sighash.to_byte_array());
        let signature = bitcoin::ecdsa::Signature {
            signature: secp.sign_ecdsa(&message, &secret_key),
            sighash_type: EcdsaSighashType::All,
        };
        psbt.inputs[index].final_script_witness = Some(Witness::p2wpkh(&signature, &public_key));
    }
    psbt.extract_tx()
        .map_err(|error| BitcoinServiceError::Signing(error.to_string()))
}

pub async fn submit_transfer(
    chain_id: &str,
    mnemonic: &str,
    sender: &str,
    recipient: &str,
    amount_sats: u64,
    fee_rate_sat_vb: f64,
) -> BitcoinServiceResult<BitcoinBroadcastResult> {
    let (network, _, endpoint) = network_config(chain_id)?;
    let sender = checked_address(sender, network)?.to_string();
    let private_key = private_key_from_mnemonic(mnemonic, chain_id)?;
    if address_from_private_key(private_key.as_ref(), chain_id)? != sender {
        return Err(BitcoinServiceError::Signing(
            "wallet mnemonic does not match the selected Bitcoin account".to_string(),
        ));
    }
    let utxos = fetch_confirmed_utxos(endpoint, &sender).await?;
    let prepared = build_psbt(
        network,
        &sender,
        recipient,
        amount_sats,
        fee_rate_sat_vb,
        &utxos,
    )?;
    let transaction = sign_psbt(prepared.psbt, private_key.as_ref(), &sender, network)?;
    let expected_txid = transaction.compute_txid().to_string();
    let raw_transaction = encode::serialize_hex(&transaction);
    let response = http_client()?
        .post(format!("{endpoint}/tx"))
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(raw_transaction)
        .send()
        .await
        .map_err(|error| BitcoinServiceError::Network(error.to_string()))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let txid = response
        .text()
        .await
        .map_err(|error| BitcoinServiceError::Network(error.to_string()))?
        .trim()
        .to_string();
    if txid != expected_txid {
        return Err(BitcoinServiceError::Network(
            "broadcast service returned a mismatched transaction id".to_string(),
        ));
    }
    Ok(BitcoinBroadcastResult { txid })
}

pub fn builtin_adapters() -> ChainResult<Vec<BitcoinAdapter>> {
    Ok(vec![BitcoinAdapter::mainnet()?, BitcoinAdapter::testnet()?])
}

#[cfg(test)]
mod tests {
    use super::*;

    const MNEMONIC: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn derives_bip84_mainnet_vector() {
        let adapter = BitcoinAdapter::mainnet().unwrap();
        let account = adapter.derive_account(MNEMONIC, None).unwrap();
        assert_eq!(
            account.address,
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
        );
        assert_eq!(account.derivation_path, BITCOIN_MAINNET_DERIVATION_PATH);
        assert!(adapter.normalize_address(&account.address).is_ok());
        assert_eq!(
            adapter
                .derive_account(&format!("  {}  ", MNEMONIC.replace(' ', "  ")), None)
                .unwrap()
                .address,
            account.address
        );
    }

    #[test]
    fn rejects_an_address_from_the_wrong_network() {
        let adapter = BitcoinAdapter::testnet().unwrap();
        assert!(adapter
            .normalize_address("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")
            .is_err());
    }

    #[test]
    fn rejects_non_bip84_and_wrong_network_derivation_paths() {
        let mainnet = BitcoinAdapter::mainnet().unwrap();
        assert!(mainnet
            .derive_account(MNEMONIC, Some("m/44'/0'/0'/0/0"))
            .is_err());
        assert!(mainnet
            .derive_account(MNEMONIC, Some(BITCOIN_TESTNET_DERIVATION_PATH))
            .is_err());

        let testnet = BitcoinAdapter::testnet().unwrap();
        assert!(testnet
            .derive_account(MNEMONIC, Some(BITCOIN_MAINNET_DERIVATION_PATH))
            .is_err());
        assert!(testnet
            .derive_account(MNEMONIC, Some("  m/84'/1'/7'/1/42  "))
            .is_ok_and(|account| account.derivation_path == "m/84'/1'/7'/1/42"));
    }

    #[test]
    fn direct_adapter_calls_enforce_identity_input_bounds() {
        let adapter = BitcoinAdapter::mainnet().unwrap();
        assert!(matches!(
            adapter.normalize_address(&"a".repeat(129)),
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
    fn private_key_matches_the_bip84_account() {
        let key = private_key_from_mnemonic(MNEMONIC, BITCOIN_MAINNET_CAIP2).unwrap();
        assert_eq!(
            address_from_private_key(key.as_ref(), BITCOIN_MAINNET_CAIP2).unwrap(),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
        );
    }

    #[test]
    fn builds_and_signs_a_bounded_rbf_psbt() {
        let sender = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
        let utxos = vec![EsploraUtxo {
            txid: "0000000000000000000000000000000000000000000000000000000000000001".to_string(),
            vout: 0,
            value: 100_000,
            status: EsploraUtxoStatus { confirmed: true },
        }];
        let prepared = build_psbt(Network::Bitcoin, sender, sender, 50_000, 2.0, &utxos).unwrap();
        assert_eq!(prepared.preview.input_count, 1);
        assert_eq!(prepared.preview.output_count, 2);
        assert!(prepared.preview.fee_sats > 0);
        assert!(prepared.preview.change_sats > 0);
        assert!(!prepared.preview.psbt_base64.is_empty());

        let key = private_key_from_mnemonic(MNEMONIC, BITCOIN_MAINNET_CAIP2).unwrap();
        let transaction = sign_psbt(prepared.psbt, key.as_ref(), sender, Network::Bitcoin).unwrap();
        assert_eq!(transaction.input[0].witness.len(), 2);
    }

    #[test]
    fn refuses_dust_and_insufficient_funds() {
        let sender = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
        assert!(matches!(
            build_psbt(Network::Bitcoin, sender, sender, 100, 2.0, &[]),
            Err(BitcoinServiceError::InvalidInput(_))
        ));
        assert!(matches!(
            build_psbt(Network::Bitcoin, sender, sender, 50_000, 2.0, &[]),
            Err(BitcoinServiceError::InsufficientFunds)
        ));
    }
}
