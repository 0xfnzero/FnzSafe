//! Chain-agnostic identities, capabilities, account derivation, and adapter registry.

#![forbid(unsafe_code)]

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{Display, Formatter};
use std::str::FromStr;
use std::sync::Arc;
use thiserror::Error;

pub mod capabilities {
    pub const ACCOUNT_DERIVATION: &str = "accounts:derive";
    pub const ADDRESS_VALIDATION: &str = "accounts:validate";
    pub const PRIVATE_KEY_IMPORT: &str = "accounts:import_private_key";
    pub const NATIVE_BALANCE: &str = "assets:native_balance";
    pub const FUNGIBLE_TOKENS: &str = "assets:fungible_tokens";
    pub const TRANSFER: &str = "transactions:transfer";
    pub const HISTORY: &str = "transactions:history";
    pub const STATUS: &str = "transactions:status";
    pub const MESSAGE_SIGNING: &str = "messages:sign";
    pub const DAPP_CONNECT: &str = "dapps:connect";
    pub const MULTISIG: &str = "accounts:multisig";
    pub const PROGRAMS: &str = "programs:manage";
}

pub mod families {
    pub const SOLANA: &str = "solana";
    pub const EVM: &str = "evm";
    pub const BITCOIN: &str = "bitcoin";
    pub const TRON: &str = "tron";
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ChainError {
    #[error("invalid CAIP-2 chain id: {0}")]
    InvalidChainId(String),
    #[error("invalid CAIP-10 account id: {0}")]
    InvalidAccountId(String),
    #[error("invalid chain family: {0}")]
    InvalidFamily(String),
    #[error("invalid capability id: {0}")]
    InvalidCapability(String),
    #[error("invalid address: {0}")]
    InvalidAddress(String),
    #[error("invalid derivation path: {0}")]
    InvalidDerivationPath(String),
    #[error("invalid chain descriptor for `{chain_id}`: {reason}")]
    InvalidDescriptor { chain_id: ChainId, reason: String },
    #[error("invalid mnemonic")]
    InvalidMnemonic,
    #[error("unsupported capability `{capability}` on `{chain_id}`")]
    UnsupportedCapability {
        chain_id: ChainId,
        capability: String,
    },
    #[error("chain adapter is already registered: {0}")]
    DuplicateChain(ChainId),
    #[error("chain adapter is not registered: {0}")]
    ChainNotFound(ChainId),
    #[error("account derivation failed: {0}")]
    DerivationFailed(String),
}

pub type ChainResult<T> = Result<T, ChainError>;

const MAX_ADDRESS_BYTES: usize = 128;
const MAX_MNEMONIC_BYTES: usize = 1_024;
const MAX_DERIVATION_PATH_BYTES: usize = 256;
const MAX_DESCRIPTOR_TEXT_BYTES: usize = 128;
const MAX_PUBLIC_KEY_HEX_BYTES: usize = 256;

/// CAIP-2 chain identifier, such as `eip155:1` or `bip122:000000000019d6689c085ae165831e93`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ChainId(String);

impl ChainId {
    pub fn new(namespace: &str, reference: &str) -> ChainResult<Self> {
        let value = format!("{namespace}:{reference}");
        validate_chain_id(namespace, reference).map(|_| Self(value))
    }

    pub fn namespace(&self) -> &str {
        self.0
            .split_once(':')
            .map(|value| value.0)
            .unwrap_or_default()
    }

    pub fn reference(&self) -> &str {
        self.0
            .split_once(':')
            .map(|value| value.1)
            .unwrap_or_default()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for ChainId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for ChainId {
    type Err = ChainError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (namespace, reference) = value
            .split_once(':')
            .ok_or_else(|| ChainError::InvalidChainId(value.to_string()))?;
        Self::new(namespace, reference)
    }
}

impl<'de> Deserialize<'de> for ChainId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str(&value).map_err(serde::de::Error::custom)
    }
}

/// Open family identifier. Adding a chain family does not require changing an enum in every client.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ChainFamily(String);

impl ChainFamily {
    pub fn new(value: &str) -> ChainResult<Self> {
        if value.is_empty()
            || value.len() > 32
            || !value.chars().all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
            })
        {
            return Err(ChainError::InvalidFamily(value.to_string()));
        }
        Ok(Self(value.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for ChainFamily {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ChainFamily {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct CapabilityId(String);

impl CapabilityId {
    pub fn new(value: &str) -> ChainResult<Self> {
        if value.is_empty()
            || value.len() > 64
            || !value.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, ':' | '_' | '-')
            })
        {
            return Err(ChainError::InvalidCapability(value.to_string()));
        }
        Ok(Self(value.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for CapabilityId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for CapabilityId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportLevel {
    Experimental,
    Beta,
    Stable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeAsset {
    pub symbol: String,
    pub name: String,
    pub decimals: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainEndpoint {
    pub kind: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainDescriptor {
    pub chain_id: ChainId,
    pub family: ChainFamily,
    pub name: String,
    pub network: String,
    pub testnet: bool,
    pub native_asset: NativeAsset,
    pub default_derivation_path: String,
    pub address_formats: Vec<String>,
    pub capabilities: Vec<CapabilityId>,
    pub endpoints: Vec<ChainEndpoint>,
    pub explorer_url: Option<String>,
    pub support_level: SupportLevel,
}

impl ChainDescriptor {
    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities
            .iter()
            .any(|candidate| candidate.as_str() == capability)
    }

    pub fn validate(&self) -> ChainResult<()> {
        for (field, value) in [
            ("name", self.name.as_str()),
            ("network", self.network.as_str()),
            ("native asset symbol", self.native_asset.symbol.as_str()),
            ("native asset name", self.native_asset.name.as_str()),
        ] {
            if value.is_empty() || value.len() > MAX_DESCRIPTOR_TEXT_BYTES || value.trim() != value
            {
                return Err(self.invalid(format!(
                    "{field} must contain between 1 and {MAX_DESCRIPTOR_TEXT_BYTES} bytes without surrounding whitespace"
                )));
            }
        }

        if self.address_formats.is_empty()
            || self.address_formats.iter().any(|format| {
                format.is_empty()
                    || format.len() > 64
                    || !format.chars().all(|character| {
                        character.is_ascii_lowercase()
                            || character.is_ascii_digit()
                            || matches!(character, '-' | '_')
                    })
            })
        {
            return Err(self.invalid("at least one valid address format is required"));
        }
        if !all_unique(self.address_formats.iter().map(String::as_str)) {
            return Err(self.invalid("address formats must be unique"));
        }
        if !self.supports(capabilities::ADDRESS_VALIDATION) {
            return Err(self.invalid("the address-validation capability is required"));
        }
        if !all_unique(self.capabilities.iter().map(CapabilityId::as_str)) {
            return Err(self.invalid("capabilities must be unique"));
        }
        if self.supports(capabilities::ACCOUNT_DERIVATION) {
            validate_derivation_path_input(&self.default_derivation_path).map_err(|_| {
                self.invalid("account derivation requires a default derivation path")
            })?;
            if self.default_derivation_path.trim() != self.default_derivation_path {
                return Err(self.invalid("default derivation path must be canonical"));
            }
        }
        for endpoint in &self.endpoints {
            if endpoint.kind.trim().is_empty()
                || endpoint.kind.len() > 64
                || endpoint.kind.trim() != endpoint.kind
                || endpoint.url.trim().is_empty()
                || endpoint.url.len() > 2_048
                || endpoint.url.trim() != endpoint.url
            {
                return Err(self.invalid("endpoint kind and URL must be non-empty and bounded"));
            }
        }
        if self
            .explorer_url
            .as_ref()
            .is_some_and(|url| url.trim().is_empty() || url.len() > 2_048 || url.trim() != url)
        {
            return Err(self.invalid("explorer URL must be non-empty and bounded"));
        }
        Ok(())
    }

    fn invalid(&self, reason: impl Into<String>) -> ChainError {
        ChainError::InvalidDescriptor {
            chain_id: self.chain_id.clone(),
            reason: reason.into(),
        }
    }
}

fn all_unique<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = BTreeSet::new();
    values.into_iter().all(|value| seen.insert(value))
}

/// CAIP-10 account identifier. The normalized address is produced by a chain adapter first.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct AccountId(String);

impl AccountId {
    pub fn new(chain_id: &ChainId, address: &str) -> ChainResult<Self> {
        if address.is_empty()
            || address.len() > 128
            || !address.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '.' | '%')
            })
        {
            return Err(ChainError::InvalidAccountId(format!(
                "{chain_id}:{address}"
            )));
        }
        Ok(Self(format!("{chain_id}:{address}")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Display for AccountId {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for AccountId {
    type Err = ChainError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (namespace, remainder) = value
            .split_once(':')
            .ok_or_else(|| ChainError::InvalidAccountId(value.to_string()))?;
        let (reference, address) = remainder
            .split_once(':')
            .ok_or_else(|| ChainError::InvalidAccountId(value.to_string()))?;
        let chain_id = ChainId::new(namespace, reference)
            .map_err(|_| ChainError::InvalidAccountId(value.to_string()))?;
        Self::new(&chain_id, address)
    }
}

impl<'de> Deserialize<'de> for AccountId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DerivedAccount {
    pub account_id: AccountId,
    pub chain_id: ChainId,
    pub address: String,
    pub derivation_path: String,
    pub public_key_hex: Option<String>,
}

impl DerivedAccount {
    pub fn new(
        chain_id: ChainId,
        address: String,
        derivation_path: String,
        public_key_hex: Option<String>,
    ) -> ChainResult<Self> {
        validate_derivation_path_input(&derivation_path)?;
        validate_public_key_hex(public_key_hex.as_deref())?;
        let account_id = AccountId::new(&chain_id, &address)?;
        Ok(Self {
            account_id,
            chain_id,
            address,
            derivation_path,
            public_key_hex,
        })
    }
}

impl<'de> Deserialize<'de> for DerivedAccount {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct WireAccount {
            account_id: AccountId,
            chain_id: ChainId,
            address: String,
            derivation_path: String,
            public_key_hex: Option<String>,
        }

        let wire = WireAccount::deserialize(deserializer)?;
        let account = Self::new(
            wire.chain_id,
            wire.address,
            wire.derivation_path,
            wire.public_key_hex,
        )
        .map_err(serde::de::Error::custom)?;
        if account.account_id != wire.account_id {
            return Err(serde::de::Error::custom(
                "account_id does not match chain_id and address",
            ));
        }
        Ok(account)
    }
}

/// Minimal common contract. Chain-specific transaction services remain behind the same adapter.
pub trait ChainAdapter: Send + Sync {
    fn descriptor(&self) -> &ChainDescriptor;

    fn normalize_address(&self, address: &str) -> ChainResult<String>;

    fn derive_account(
        &self,
        _mnemonic: &str,
        _derivation_path: Option<&str>,
    ) -> ChainResult<DerivedAccount> {
        Err(ChainError::UnsupportedCapability {
            chain_id: self.descriptor().chain_id.clone(),
            capability: capabilities::ACCOUNT_DERIVATION.to_string(),
        })
    }
}

#[derive(Default)]
pub struct ChainRegistry {
    adapters: BTreeMap<ChainId, Arc<dyn ChainAdapter>>,
}

impl ChainRegistry {
    pub fn register<A>(&mut self, adapter: A) -> ChainResult<()>
    where
        A: ChainAdapter + 'static,
    {
        adapter.descriptor().validate()?;
        let chain_id = adapter.descriptor().chain_id.clone();
        if self.adapters.contains_key(&chain_id) {
            return Err(ChainError::DuplicateChain(chain_id));
        }
        self.adapters.insert(chain_id, Arc::new(adapter));
        Ok(())
    }

    pub fn get(&self, chain_id: &ChainId) -> ChainResult<Arc<dyn ChainAdapter>> {
        self.adapters
            .get(chain_id)
            .cloned()
            .ok_or_else(|| ChainError::ChainNotFound(chain_id.clone()))
    }

    pub fn descriptors(&self) -> Vec<ChainDescriptor> {
        self.adapters
            .values()
            .map(|adapter| adapter.descriptor().clone())
            .collect()
    }

    pub fn normalize_address(&self, chain_id: &ChainId, address: &str) -> ChainResult<String> {
        let adapter = self.get(chain_id)?;
        ensure_capability(adapter.as_ref(), capabilities::ADDRESS_VALIDATION)?;
        validate_address_input(address)?;
        let normalized = adapter.normalize_address(address)?;
        AccountId::new(chain_id, &normalized).map_err(|_| {
            ChainError::InvalidAddress(
                "adapter returned an address that cannot be represented as CAIP-10".to_string(),
            )
        })?;
        Ok(normalized)
    }

    pub fn derive_account(
        &self,
        chain_id: &ChainId,
        mnemonic: &str,
        derivation_path: Option<&str>,
    ) -> ChainResult<DerivedAccount> {
        let adapter = self.get(chain_id)?;
        ensure_capability(adapter.as_ref(), capabilities::ACCOUNT_DERIVATION)?;
        validate_mnemonic_input(mnemonic)?;
        if let Some(path) = derivation_path {
            validate_derivation_path_input(path)?;
        }
        let account = adapter.derive_account(mnemonic, derivation_path)?;
        if &account.chain_id != chain_id {
            return Err(ChainError::DerivationFailed(
                "adapter returned an account for a different chain".to_string(),
            ));
        }
        let expected_account_id = AccountId::new(chain_id, &account.address).map_err(|_| {
            ChainError::DerivationFailed(
                "adapter returned an address that cannot be represented as CAIP-10".to_string(),
            )
        })?;
        if account.account_id != expected_account_id {
            return Err(ChainError::DerivationFailed(
                "adapter returned an account id that does not match its chain and address"
                    .to_string(),
            ));
        }
        validate_derivation_path_input(&account.derivation_path)?;
        validate_public_key_hex(account.public_key_hex.as_deref())?;
        let normalized = adapter.normalize_address(&account.address)?;
        if normalized != account.address {
            return Err(ChainError::DerivationFailed(
                "adapter returned a non-canonical account address".to_string(),
            ));
        }
        Ok(account)
    }

    pub fn len(&self) -> usize {
        self.adapters.len()
    }

    pub fn is_empty(&self) -> bool {
        self.adapters.is_empty()
    }
}

pub fn validate_address_input(address: &str) -> ChainResult<()> {
    if address.trim().is_empty() || address.len() > MAX_ADDRESS_BYTES {
        return Err(ChainError::InvalidAddress(
            "address must contain between 1 and 128 bytes".to_string(),
        ));
    }
    Ok(())
}

pub fn validate_mnemonic_input(mnemonic: &str) -> ChainResult<()> {
    if mnemonic.trim().is_empty() || mnemonic.len() > MAX_MNEMONIC_BYTES {
        return Err(ChainError::InvalidMnemonic);
    }
    Ok(())
}

pub fn validate_derivation_path_input(path: &str) -> ChainResult<()> {
    if path.trim().is_empty() || path.len() > MAX_DERIVATION_PATH_BYTES {
        return Err(ChainError::InvalidDerivationPath(
            "derivation path must contain between 1 and 256 bytes".to_string(),
        ));
    }
    Ok(())
}

fn validate_public_key_hex(public_key_hex: Option<&str>) -> ChainResult<()> {
    let Some(value) = public_key_hex else {
        return Ok(());
    };
    if value.is_empty()
        || value.len() > MAX_PUBLIC_KEY_HEX_BYTES
        || !value.len().is_multiple_of(2)
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ChainError::DerivationFailed(
            "public key must be bounded, even-length hexadecimal".to_string(),
        ));
    }
    Ok(())
}

fn ensure_capability(adapter: &dyn ChainAdapter, capability: &str) -> ChainResult<()> {
    if adapter.descriptor().supports(capability) {
        return Ok(());
    }
    Err(ChainError::UnsupportedCapability {
        chain_id: adapter.descriptor().chain_id.clone(),
        capability: capability.to_string(),
    })
}

pub fn capability_ids(values: &[&str]) -> ChainResult<Vec<CapabilityId>> {
    values
        .iter()
        .map(|value| CapabilityId::new(value))
        .collect()
}

fn validate_chain_id(namespace: &str, reference: &str) -> ChainResult<()> {
    let namespace_valid = (3..=8).contains(&namespace.len())
        && namespace.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    let reference_valid = (1..=32).contains(&reference.len())
        && reference
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'));
    if !namespace_valid || !reference_valid {
        return Err(ChainError::InvalidChainId(format!(
            "{namespace}:{reference}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AddressOnlyAdapter {
        descriptor: ChainDescriptor,
    }

    impl AddressOnlyAdapter {
        fn new() -> Self {
            Self {
                descriptor: ChainDescriptor {
                    chain_id: ChainId::from_str("example:mainnet").unwrap(),
                    family: ChainFamily::new("example").unwrap(),
                    name: "Example".to_string(),
                    network: "mainnet".to_string(),
                    testnet: false,
                    native_asset: NativeAsset {
                        symbol: "EX".to_string(),
                        name: "Example".to_string(),
                        decimals: 8,
                    },
                    default_derivation_path: String::new(),
                    address_formats: vec!["example".to_string()],
                    capabilities: capability_ids(&[capabilities::ADDRESS_VALIDATION]).unwrap(),
                    endpoints: Vec::new(),
                    explorer_url: None,
                    support_level: SupportLevel::Experimental,
                },
            }
        }
    }

    impl ChainAdapter for AddressOnlyAdapter {
        fn descriptor(&self) -> &ChainDescriptor {
            &self.descriptor
        }

        fn normalize_address(&self, address: &str) -> ChainResult<String> {
            Ok(address.trim().to_ascii_lowercase())
        }
    }

    struct InvalidOutputAdapter {
        descriptor: ChainDescriptor,
        output: InvalidOutput,
    }

    #[derive(Clone, Copy)]
    enum InvalidOutput {
        InvalidAddress,
        WrongChain,
        MismatchedAccountId,
    }

    impl InvalidOutputAdapter {
        fn new(output: InvalidOutput) -> Self {
            let mut descriptor = AddressOnlyAdapter::new().descriptor;
            descriptor.capabilities = capability_ids(&[
                capabilities::ADDRESS_VALIDATION,
                capabilities::ACCOUNT_DERIVATION,
            ])
            .unwrap();
            descriptor.default_derivation_path = "m/0".to_string();
            Self { descriptor, output }
        }
    }

    impl ChainAdapter for InvalidOutputAdapter {
        fn descriptor(&self) -> &ChainDescriptor {
            &self.descriptor
        }

        fn normalize_address(&self, _address: &str) -> ChainResult<String> {
            match self.output {
                InvalidOutput::InvalidAddress => Ok("invalid/address".to_string()),
                InvalidOutput::WrongChain | InvalidOutput::MismatchedAccountId => {
                    Ok("alice".to_string())
                }
            }
        }

        fn derive_account(
            &self,
            _mnemonic: &str,
            _derivation_path: Option<&str>,
        ) -> ChainResult<DerivedAccount> {
            match self.output {
                InvalidOutput::InvalidAddress | InvalidOutput::WrongChain => DerivedAccount::new(
                    ChainId::from_str("example:other").unwrap(),
                    "alice".to_string(),
                    "m/0".to_string(),
                    None,
                ),
                InvalidOutput::MismatchedAccountId => Ok(DerivedAccount {
                    account_id: AccountId::new(
                        &ChainId::from_str("example:mainnet").unwrap(),
                        "bob",
                    )
                    .unwrap(),
                    chain_id: ChainId::from_str("example:mainnet").unwrap(),
                    address: "alice".to_string(),
                    derivation_path: "m/0".to_string(),
                    public_key_hex: None,
                }),
            }
        }
    }

    #[test]
    fn parses_caip2_identifiers() {
        let ethereum = ChainId::from_str("eip155:1").unwrap();
        assert_eq!(ethereum.namespace(), "eip155");
        assert_eq!(ethereum.reference(), "1");

        let bitcoin = ChainId::from_str("bip122:000000000019d6689c085ae165831e93").unwrap();
        assert_eq!(bitcoin.namespace(), "bip122");
        assert!(ChainId::from_str("EIP155:1").is_err());
        assert!(ChainId::from_str("eip155:").is_err());
    }

    #[test]
    fn builds_caip10_account_identifiers() {
        let chain_id = ChainId::from_str("eip155:1").unwrap();
        let account =
            AccountId::new(&chain_id, "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf").unwrap();
        assert_eq!(
            account.as_str(),
            "eip155:1:0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
        assert_eq!(AccountId::from_str(account.as_str()).unwrap(), account);
    }

    #[test]
    fn rejects_invalid_identifiers_during_deserialization() {
        assert!(serde_json::from_str::<ChainId>(r#""EIP155:1""#).is_err());
        assert!(serde_json::from_str::<ChainFamily>(r#""EVM""#).is_err());
        assert!(serde_json::from_str::<CapabilityId>(r#""Transactions Transfer""#).is_err());
        assert!(serde_json::from_str::<AccountId>(r#""eip155:1:not:an:address""#).is_err());

        let chain_id: ChainId = serde_json::from_str(r#""eip155:1""#).unwrap();
        assert_eq!(chain_id.as_str(), "eip155:1");
        let account_id: AccountId =
            serde_json::from_str(r#""eip155:1:0x7e5f4552091a69125d5dfcb7b8c2659029395bdf""#)
                .unwrap();
        assert_eq!(
            account_id.as_str(),
            "eip155:1:0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn rejects_inconsistent_derived_accounts_during_deserialization() {
        let mismatched = serde_json::json!({
            "account_id": "eip155:1:0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            "chain_id": "eip155:10",
            "address": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            "derivation_path": "m/44'/60'/0'/0/0",
            "public_key_hex": null,
        });
        assert!(serde_json::from_value::<DerivedAccount>(mismatched).is_err());
    }

    #[test]
    fn registry_enforces_declared_capabilities() {
        let mut registry = ChainRegistry::default();
        registry.register(AddressOnlyAdapter::new()).unwrap();
        let chain_id = ChainId::from_str("example:mainnet").unwrap();

        assert_eq!(
            registry.normalize_address(&chain_id, " Alice ").unwrap(),
            "alice"
        );
        assert!(matches!(
            registry.derive_account(&chain_id, "unused", None),
            Err(ChainError::UnsupportedCapability { .. })
        ));
        assert!(matches!(
            registry.register(AddressOnlyAdapter::new()),
            Err(ChainError::DuplicateChain(_))
        ));
    }

    #[test]
    fn registry_rejects_inconsistent_descriptors() {
        let mut missing_validation = AddressOnlyAdapter::new();
        missing_validation.descriptor.capabilities.clear();
        let mut registry = ChainRegistry::default();
        assert!(matches!(
            registry.register(missing_validation),
            Err(ChainError::InvalidDescriptor { .. })
        ));

        let mut duplicate_format = AddressOnlyAdapter::new();
        duplicate_format
            .descriptor
            .address_formats
            .push("example".to_string());
        assert!(matches!(
            registry.register(duplicate_format),
            Err(ChainError::InvalidDescriptor { .. })
        ));

        let mut missing_path = AddressOnlyAdapter::new();
        missing_path.descriptor.capabilities = capability_ids(&[
            capabilities::ADDRESS_VALIDATION,
            capabilities::ACCOUNT_DERIVATION,
        ])
        .unwrap();
        assert!(matches!(
            registry.register(missing_path),
            Err(ChainError::InvalidDescriptor { .. })
        ));

        let mut ambiguous_endpoint = AddressOnlyAdapter::new();
        ambiguous_endpoint.descriptor.endpoints.push(ChainEndpoint {
            kind: "example".to_string(),
            url: " https://rpc.example.com".to_string(),
        });
        assert!(matches!(
            registry.register(ambiguous_endpoint),
            Err(ChainError::InvalidDescriptor { .. })
        ));
    }

    #[test]
    fn derived_accounts_reject_invalid_paths_and_public_keys() {
        let chain_id = ChainId::from_str("example:mainnet").unwrap();
        assert!(matches!(
            DerivedAccount::new(chain_id.clone(), "alice".to_string(), String::new(), None),
            Err(ChainError::InvalidDerivationPath(_))
        ));
        assert!(matches!(
            DerivedAccount::new(
                chain_id,
                "alice".to_string(),
                "m/0".to_string(),
                Some("not-hex".to_string()),
            ),
            Err(ChainError::DerivationFailed(_))
        ));
    }

    #[test]
    fn registry_rejects_oversized_identity_inputs_before_adapter_parsing() {
        assert!(matches!(
            validate_address_input(&"a".repeat(MAX_ADDRESS_BYTES + 1)),
            Err(ChainError::InvalidAddress(_))
        ));
        assert_eq!(
            validate_mnemonic_input(&"word ".repeat(MAX_MNEMONIC_BYTES)),
            Err(ChainError::InvalidMnemonic)
        );
        assert!(matches!(
            validate_derivation_path_input(&"m".repeat(MAX_DERIVATION_PATH_BYTES + 1)),
            Err(ChainError::InvalidDerivationPath(_))
        ));
    }

    #[test]
    fn registry_rejects_adapter_outputs_that_break_identity_invariants() {
        let mut registry = ChainRegistry::default();
        registry
            .register(InvalidOutputAdapter::new(InvalidOutput::InvalidAddress))
            .unwrap();
        let chain_id = ChainId::from_str("example:mainnet").unwrap();

        assert!(matches!(
            registry.normalize_address(&chain_id, "alice"),
            Err(ChainError::InvalidAddress(_))
        ));
        let mut registry = ChainRegistry::default();
        registry
            .register(InvalidOutputAdapter::new(InvalidOutput::WrongChain))
            .unwrap();
        assert!(matches!(
            registry.derive_account(&chain_id, "unused", Some("m/0")),
            Err(ChainError::DerivationFailed(_))
        ));

        let mut registry = ChainRegistry::default();
        registry
            .register(InvalidOutputAdapter::new(
                InvalidOutput::MismatchedAccountId,
            ))
            .unwrap();
        assert!(matches!(
            registry.derive_account(&chain_id, "unused", Some("m/0")),
            Err(ChainError::DerivationFailed(_))
        ));
    }
}
