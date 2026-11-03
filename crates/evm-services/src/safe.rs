//! Safe 1.4.1 EOA multisig, independent of the hosted Safe Transaction Service.
//! All amounts/nonces are decimal strings. Refund and Safe gas fields are zero.
//! Batches delegate only to the verified canonical MultiSendCallOnly runtime.
use super::*;
use k256::ecdsa::VerifyingKey;
use serde_json::{json, Value};
use std::collections::BTreeMap;
mod batch;
mod discovery;
pub use batch::SafeBatchCall;

pub const FACTORY: &str = "0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67";
pub const SINGLETON: &str = "0x41675c099f32341bf84bfc5382af534df5c7461a";
const FACTORY_HASH: &str = "50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317";
const SAFE_HASH: &str = "1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4";
const SAFE_L2_HASH: &str = "b1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff";
const ZERO: &str = "0x0000000000000000000000000000000000000000";
const MAX_OWNERS: usize = 50;
const MAX_DATA: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafeSignature {
    pub owner: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafeProposal {
    pub version: u8,
    pub chain_id: u64,
    pub safe_address: String,
    pub to: String,
    pub value: String,
    pub data: String,
    pub nonce: String,
    pub safe_tx_hash: String,
    pub signatures: Vec<SafeSignature>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<Vec<SafeBatchCall>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafeAccount {
    pub address: String,
    pub chain_id: u64,
    pub version: String,
    pub owners: Vec<String>,
    pub threshold: usize,
    pub nonce: String,
    pub balance_wei: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SafeCommand {
    Discover {
        #[serde(default)]
        before_block: Option<u64>,
        #[serde(default)]
        offset: usize,
        #[serde(default)]
        block_span: Option<u64>,
    },
    Account {
        address: String,
    },
    PrepareCreate {
        owners: Vec<String>,
        threshold: usize,
        salt_nonce: String,
    },
    Create {
        owners: Vec<String>,
        threshold: usize,
        salt_nonce: String,
    },
    Propose {
        address: String,
        to: String,
        value: String,
        data: String,
        #[serde(default)]
        nonce: Option<String>,
        #[serde(default)]
        batch: Option<Vec<SafeBatchCall>>,
    },
    Validate {
        proposal: SafeProposal,
    },
    Sign {
        proposal: SafeProposal,
    },
    PrepareExecute {
        proposal: SafeProposal,
    },
    Execute {
        proposal: SafeProposal,
    },
    Receipt {
        address: String,
        transaction_hash: String,
        safe_tx_hash: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafeRequest {
    pub chain: EvmChainConfig,
    #[serde(default)]
    pub wallet_address: String,
    #[serde(default)]
    pub approved: bool,
    #[serde(default)]
    pub max_fee_wei: Option<String>,
    pub command: SafeCommand,
}

fn invalid(message: &str) -> EvmServiceError {
    EvmServiceError::InvalidInput(message.to_string())
}
fn hex_bytes(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}
fn word(value: &str) -> EvmResult<[u8; 32]> {
    decimal_to_32_bytes(value)
}
fn number(value: usize) -> [u8; 32] {
    word(&value.to_string()).expect("usize fits uint256")
}
fn address_word(address: &str) -> EvmResult<[u8; 32]> {
    let mut result = [0; 32];
    result[12..].copy_from_slice(&address_bytes(address)?);
    Ok(result)
}
fn bytes_tail(bytes: &[u8]) -> Vec<u8> {
    let mut encoded = number(bytes.len()).to_vec();
    encoded.extend_from_slice(bytes);
    encoded.resize(32 + bytes.len().div_ceil(32) * 32, 0);
    encoded
}
fn calldata(signature: &str, args: &[u8]) -> String {
    let mut encoded = keccak256(signature.as_bytes())[..4].to_vec();
    encoded.extend_from_slice(args);
    hex_bytes(&encoded)
}
fn read_word(bytes: &[u8], offset: usize) -> EvmResult<&[u8]> {
    bytes
        .get(offset..offset + 32)
        .ok_or_else(|| invalid("Malformed Safe ABI response"))
}
fn read_size(bytes: &[u8], offset: usize) -> EvmResult<usize> {
    let word = read_word(bytes, offset)?;
    if word[..24].iter().any(|v| *v != 0) {
        return Err(invalid("Safe ABI integer overflow"));
    }
    usize::try_from(u64::from_be_bytes(word[24..].try_into().unwrap()))
        .map_err(|_| invalid("Safe ABI integer overflow"))
}
fn read_address(bytes: &[u8], offset: usize) -> EvmResult<String> {
    let word = read_word(bytes, offset)?;
    if word[..12].iter().any(|v| *v != 0) {
        return Err(invalid("Invalid ABI address"));
    }
    Ok(hex_bytes(&word[12..]))
}
fn read_dynamic(bytes: &[u8]) -> EvmResult<Vec<u8>> {
    let offset = read_size(bytes, 0)?;
    if offset != 32 {
        return Err(invalid("Invalid ABI offset"));
    }
    let size = read_size(bytes, offset)?;
    if size > MAX_DATA {
        return Err(invalid("Safe response too large"));
    }
    Ok(bytes
        .get(offset + 32..offset + 32 + size)
        .ok_or_else(|| invalid("Truncated ABI bytes"))?
        .to_vec())
}
fn call(chain: &EvmChainConfig, to: &str, signature: &str, args: &[u8]) -> EvmResult<Vec<u8>> {
    hex_data_to_bytes(&eth_call(chain, to, &calldata(signature, args))?)
}
fn code(chain: &EvmChainConfig, address: &str) -> EvmResult<Vec<u8>> {
    let result = rpc_call(chain, "eth_getCode", json!([address, "latest"]))?;
    hex_data_to_bytes(result.as_str().ok_or(EvmServiceError::RpcUnavailable)?)
}
fn require_code(chain: &EvmChainConfig, address: &str, hashes: &[&str]) -> EvmResult<()> {
    let hash = hex::encode(keccak256(&code(chain, address)?));
    if !hashes.contains(&hash.as_str()) {
        return Err(invalid(
            "Verified Safe 1.4.1 deployment is unavailable on this network (code hash mismatch)",
        ));
    }
    Ok(())
}
fn verify_factory(chain: &EvmChainConfig) -> EvmResult<()> {
    require_code(chain, FACTORY, &[FACTORY_HASH])
}

pub fn account(chain: &EvmChainConfig, address: &str) -> EvmResult<SafeAccount> {
    validate_chain(chain)?;
    validate_rpc_chain_id(chain)?;
    let address = normalize_address(address, "Safe address")?;
    verify_factory(chain)?;
    require_code(
        chain,
        &address,
        &["d7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c"],
    )?;
    let singleton = read_address(&call(chain, &address, "masterCopy()", &[])?, 0)?;
    require_code(chain, &singleton, &[SAFE_HASH, SAFE_L2_HASH])?;
    let version = String::from_utf8(read_dynamic(&call(chain, &address, "VERSION()", &[])?)?)
        .map_err(|_| invalid("Invalid Safe version"))?;
    if version != "1.4.1" {
        return Err(invalid("Only Safe 1.4.1 is supported"));
    }
    let owner_data = call(chain, &address, "getOwners()", &[])?;
    if read_size(&owner_data, 0)? != 32 {
        return Err(invalid("Invalid owners offset"));
    }
    let count = read_size(&owner_data, 32)?;
    if count == 0 || count > MAX_OWNERS {
        return Err(invalid("Safe must have 1–50 owners"));
    }
    let owners = (0..count)
        .map(|i| read_address(&owner_data, 64 + i * 32))
        .collect::<EvmResult<Vec<_>>>()?;
    let threshold = read_size(&call(chain, &address, "getThreshold()", &[])?, 0)?;
    if threshold == 0 || threshold > count {
        return Err(invalid("Invalid Safe threshold"));
    }
    let nonce_data = call(chain, &address, "nonce()", &[])?;
    let nonce = hex_quantity_to_decimal(&hex_bytes(read_word(&nonce_data, 0)?))?;
    let balance_wei = rpc_hex_quantity_to_decimal(rpc_call(
        chain,
        "eth_getBalance",
        json!([address, "latest"]),
    )?)?;
    Ok(SafeAccount {
        address,
        chain_id: chain.chain_id,
        version,
        owners,
        threshold,
        nonce,
        balance_wei,
    })
}

fn creation_data(
    owners: &[String],
    threshold: usize,
    salt: &str,
) -> EvmResult<(Vec<String>, String)> {
    if owners.len() < 2 || owners.len() > MAX_OWNERS || threshold < 2 || threshold > owners.len() {
        return Err(invalid(
            "Use 2–50 distinct owners and a threshold between 2 and the owner count",
        ));
    }
    let owners = owners
        .iter()
        .map(|owner| normalize_address(owner, "owner"))
        .collect::<EvmResult<Vec<_>>>()?;
    let mut unique = std::collections::HashSet::new();
    for owner in &owners {
        if owner == ZERO
            || owner == "0x0000000000000000000000000000000000000001"
            || !unique.insert(owner.clone())
        {
            return Err(invalid(
                "Owners must be distinct, nonzero addresses (not sentinel)",
            ));
        }
    }
    let mut setup = Vec::new();
    setup.extend(number(8 * 32)); // owners
    setup.extend(number(threshold));
    setup.extend(address_word(ZERO)?); // no setup delegatecall
    setup.extend(number(8 * 32 + 32 + owners.len() * 32));
    setup.extend(address_word(ZERO)?); // no fallback handler or modules
    setup.extend(address_word(ZERO)?); // no payment
    setup.extend(number(0));
    setup.extend(address_word(ZERO)?);
    setup.extend(number(owners.len()));
    for owner in &owners {
        setup.extend(address_word(owner)?);
    }
    setup.extend(bytes_tail(&[]));
    let initializer = hex_data_to_bytes(&calldata(
        "setup(address[],uint256,address,bytes,address,address,uint256,address)",
        &setup,
    ))?;
    let mut args = Vec::new();
    args.extend(address_word(SINGLETON)?);
    args.extend(number(96));
    args.extend(word(salt)?);
    args.extend(bytes_tail(&initializer));
    Ok((
        owners,
        calldata("createProxyWithNonce(address,bytes,uint256)", &args),
    ))
}

// SafeTx gas/refund fields are fixed to zero. Reconstructing
// both hashes locally prevents imported JSON from hiding additional authority.
fn tx_args(proposal: &SafeProposal, last: [u8; 32]) -> EvmResult<Vec<u8>> {
    let mut args = Vec::new();
    args.extend(address_word(&proposal.to)?);
    args.extend(word(&proposal.value)?);
    args.extend(number(320));
    args.extend(number(usize::from(proposal.batch.is_some()))); // verified batch or CALL
    args.extend(number(0)); // safeTxGas
    args.extend(number(0)); // baseGas
    args.extend(number(0)); // gasPrice
    args.extend(address_word(ZERO)?);
    args.extend(address_word(ZERO)?);
    args.extend(last);
    args.extend(bytes_tail(&hex_data_to_bytes(&proposal.data)?));
    Ok(args)
}

pub fn proposal_hash(proposal: &SafeProposal) -> EvmResult<[u8; 32]> {
    let mut domain = keccak256(b"EIP712Domain(uint256 chainId,address verifyingContract)").to_vec();
    domain.extend(word(&proposal.chain_id.to_string())?);
    domain.extend(address_word(&proposal.safe_address)?);
    let mut tx = keccak256(b"SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)").to_vec();
    tx.extend(address_word(&proposal.to)?);
    tx.extend(word(&proposal.value)?);
    tx.extend(keccak256(&hex_data_to_bytes(&proposal.data)?));
    tx.extend(number(usize::from(proposal.batch.is_some())));
    for _ in 0..3 {
        tx.extend(number(0));
    }
    tx.extend(address_word(ZERO)?);
    tx.extend(address_word(ZERO)?);
    tx.extend(word(&proposal.nonce)?);
    let mut preimage = vec![0x19, 0x01];
    preimage.extend(keccak256(&domain));
    preimage.extend(keccak256(&tx));
    Ok(keccak256(&preimage))
}

fn canonical_proposal(chain: &EvmChainConfig, proposal: &SafeProposal) -> EvmResult<SafeProposal> {
    if proposal.version != 1 || proposal.chain_id != chain.chain_id {
        return Err(invalid("Proposal version or chain ID mismatch"));
    }
    let mut p = proposal.clone();
    p.safe_address = normalize_address(&p.safe_address, "Safe address")?;
    p.to = normalize_address(&p.to, "recipient")?;
    if p.to == ZERO {
        return Err(invalid("Zero-address recipient is not supported"));
    }
    p.value = normalize_decimal(&p.value, "value")?;
    p.nonce = normalize_decimal(&p.nonce, "nonce")?;
    if p.data.len() > MAX_DATA * 2 + 2 {
        return Err(invalid("Safe calldata exceeds 64 KiB"));
    }
    p.data = hex_bytes(&hex_data_to_bytes(&p.data)?);
    batch::validate(&p)?;
    let hash = hex_bytes(&proposal_hash(&p)?);
    if !p.safe_tx_hash.eq_ignore_ascii_case(&hash) {
        return Err(invalid("Safe transaction hash does not match proposal"));
    }
    p.safe_tx_hash = hash;
    Ok(p)
}

fn verified_signatures(p: &SafeProposal, owners: &[String]) -> EvmResult<Vec<SafeSignature>> {
    if p.signatures.len() > MAX_OWNERS {
        return Err(invalid("Too many signatures"));
    }
    let digest = proposal_hash(p)?;
    let mut signatures = BTreeMap::new();
    for entry in &p.signatures {
        let owner = normalize_address(&entry.owner, "signature owner")?;
        let bytes = hex_data_to_bytes(&entry.signature)?;
        if bytes.len() != 65 || !matches!(bytes[64], 27 | 28) {
            return Err(invalid(
                "Only 65-byte EIP-712 EOA signatures (v=27/28) are supported",
            ));
        }
        let sig =
            Signature::from_slice(&bytes[..64]).map_err(|_| invalid("Invalid Safe signature"))?;
        if sig.normalize_s().is_some() {
            return Err(invalid("Noncanonical Safe signature"));
        }
        let key = VerifyingKey::recover_from_prehash(
            &digest,
            &sig,
            RecoveryId::from_byte(bytes[64] - 27).unwrap(),
        )
        .map_err(|_| invalid("Cannot recover Safe signature"))?;
        let pubkey = key.to_encoded_point(false);
        let recovered = hex_bytes(&keccak256(&pubkey.as_bytes()[1..])[12..]);
        if owner != recovered || !owners.contains(&owner) {
            return Err(invalid("Signature is not from a current Safe owner"));
        }
        if signatures
            .insert(
                owner.clone(),
                SafeSignature {
                    owner,
                    signature: hex_bytes(&bytes),
                },
            )
            .is_some()
        {
            return Err(invalid("Duplicate Safe owner signature"));
        }
    }
    Ok(signatures.into_values().collect())
}

fn validate_proposal(
    chain: &EvmChainConfig,
    p: &SafeProposal,
) -> EvmResult<(SafeProposal, SafeAccount)> {
    let mut p = canonical_proposal(chain, p)?;
    batch::verify_runtime(chain, &p)?;
    let info = account(chain, &p.safe_address)?;
    if decimal_cmp(&p.nonce, &info.nonce)? == std::cmp::Ordering::Less {
        return Err(invalid(
            "Safe nonce already consumed; refresh and create a new proposal",
        ));
    }
    let onchain_hash = call(chain, &p.safe_address,
        "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)",
        &tx_args(&p, word(&p.nonce)?)?)?;
    if onchain_hash != proposal_hash(&p)? {
        return Err(invalid("Onchain Safe transaction hash mismatch"));
    }
    p.signatures = verified_signatures(&p, &info.owners)?;
    Ok((p, info))
}
fn execution_data(p: &SafeProposal, threshold: usize) -> EvmResult<String> {
    if p.signatures.len() < threshold {
        return Err(invalid("Safe signature threshold has not been reached"));
    }
    let data = hex_data_to_bytes(&p.data)?;
    let signature_offset = 320 + bytes_tail(&data).len();
    let mut args = tx_args(p, number(signature_offset))?;
    let signatures = p
        .signatures
        .iter()
        .take(threshold)
        .map(|s| hex_data_to_bytes(&s.signature))
        .collect::<EvmResult<Vec<_>>>()?
        .concat();
    args.extend(bytes_tail(&signatures));
    Ok(calldata("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)", &args))
}
fn require_approval(req: &SafeRequest) -> EvmResult<()> {
    if !req.approved {
        return Err(EvmServiceError::UserRejected);
    }
    normalize_address(&req.wallet_address, "signer wallet")?;
    Ok(())
}
fn send<F>(req: &SafeRequest, to: &str, data: &str, loader: F) -> EvmResult<Value>
where
    F: FnOnce() -> Result<Zeroizing<Vec<u8>>, String>,
{
    require_approval(req)?;
    let from = normalize_address(&req.wallet_address, "executor wallet")?;
    let gas = estimate_gas(&req.chain, &from, to, "0", data)?;
    let fees = load_fee_quote(&req.chain)?;
    let fee = decimal_mul(&fees.max_fee_per_gas_wei(), &gas)?;
    let cap = req
        .max_fee_wei
        .as_deref()
        .ok_or_else(|| invalid("Preview and approve the network fee first"))?;
    if decimal_cmp(&fee, cap)? == std::cmp::Ordering::Greater {
        return Err(invalid("Network fee increased; preview and approve again"));
    }
    let nonce = load_nonce(&req.chain, &from)?;
    let secret = loader().map_err(EvmServiceError::InvalidInput)?;
    let key = signing_key_from_bytes(secret.as_slice())?;
    if !address_eq(&address_from_signing_key(&key), &from) {
        return Err(invalid("Signing key does not match selected wallet"));
    }
    let raw = sign_evm_transaction(&EvmTxSigningInput {
        signing_key: &key,
        chain_id: req.chain.chain_id,
        nonce: &nonce,
        gas_limit: &gas,
        to,
        value: "0",
        data,
        gas_price_wei: &fees.gas_price_wei,
        max_fee_per_gas_wei: fees.max_fee_per_gas_wei.as_deref(),
        max_priority_fee_per_gas_wei: fees.max_priority_fee_per_gas_wei.as_deref(),
    })?;
    let hash = send_raw_transaction(&req.chain, &raw)?;
    Ok(
        json!({"status": "submitted", "transaction_hash": hash, "gas_limit": gas, "estimated_fee_wei": fee}),
    )
}

/// The key loader is called only for an explicitly approved mutation, after
/// validation. Desktop uses its existing unlocked wallet session; no key reaches JS.
pub fn handle<F>(req: SafeRequest, loader: F) -> EvmResult<Value>
where
    F: FnOnce() -> Result<Zeroizing<Vec<u8>>, String>,
{
    validate_chain(&req.chain)?;
    validate_rpc_chain_id(&req.chain)?;
    match &req.command {
        SafeCommand::Discover {
            before_block,
            offset,
            block_span,
        } => discovery::discover(
            &req.chain,
            &req.wallet_address,
            *before_block,
            *offset,
            *block_span,
        ),
        SafeCommand::Account { address } => Ok(json!({"account": account(&req.chain, address)?})),
        SafeCommand::PrepareCreate {
            owners,
            threshold,
            salt_nonce,
        }
        | SafeCommand::Create {
            owners,
            threshold,
            salt_nonce,
        } => {
            let (owners, data) = creation_data(owners, *threshold, salt_nonce)?;
            verify_factory(&req.chain)?;
            require_code(&req.chain, SINGLETON, &[SAFE_HASH])?;
            for owner in &owners {
                if !code(&req.chain, owner)?.is_empty() {
                    return Err(invalid("This creation flow supports EOA owners only"));
                }
            }
            // eth_call simulates factory CREATE2 and returns the exact proxy address.
            let predicted = read_address(
                &hex_data_to_bytes(&eth_call_tx(
                    &req.chain,
                    Some(&req.wallet_address),
                    FACTORY,
                    "0",
                    &data,
                )?)?,
                0,
            )?;
            if owners.contains(&predicted) {
                return Err(invalid("Safe cannot own itself"));
            }
            if matches!(&req.command, SafeCommand::Create { .. }) {
                let mut result = send(&req, FACTORY, &data, loader)?;
                result["address"] = json!(predicted);
                Ok(result)
            } else {
                let gas = estimate_gas(
                    &req.chain,
                    &normalize_address(&req.wallet_address, "creator wallet")?,
                    FACTORY,
                    "0",
                    &data,
                )?;
                Ok(
                    json!({"address": predicted, "owners": owners, "threshold": threshold, "gas_limit": gas, "estimated_fee_wei": decimal_mul(&load_fee_quote(&req.chain)?.max_fee_per_gas_wei(), &gas)?}),
                )
            }
        }
        SafeCommand::Propose {
            address,
            to,
            value,
            data,
            nonce,
            batch,
        } => {
            let info = account(&req.chain, address)?;
            let mut proposal = SafeProposal {
                version: 1,
                chain_id: req.chain.chain_id,
                safe_address: info.address,
                to: normalize_address(to, "recipient")?,
                value: normalize_decimal(value, "value")?,
                data: data.clone(),
                nonce: nonce
                    .as_deref()
                    .map(|n| normalize_decimal(n, "nonce"))
                    .transpose()?
                    .unwrap_or(info.nonce),
                safe_tx_hash: String::new(),
                signatures: vec![],
                batch: batch.clone(),
            };
            if data.len() > MAX_DATA * 2 + 2 {
                return Err(invalid("Safe calldata exceeds 64 KiB"));
            }
            proposal.safe_tx_hash = hex_bytes(&proposal_hash(&proposal)?);
            let (proposal, account) = validate_proposal(&req.chain, &proposal)?;
            Ok(json!({"proposal": proposal, "account": account}))
        }
        SafeCommand::Validate { proposal }
        | SafeCommand::Sign { proposal }
        | SafeCommand::PrepareExecute { proposal }
        | SafeCommand::Execute { proposal } => {
            let (mut proposal, info) = validate_proposal(&req.chain, proposal)?;
            match &req.command {
                SafeCommand::Sign { .. } => {
                    require_approval(&req)?;
                    let owner = normalize_address(&req.wallet_address, "signer wallet")?;
                    if !info.owners.contains(&owner) {
                        return Err(invalid("Selected wallet is not a Safe owner"));
                    }
                    if proposal.signatures.iter().any(|s| s.owner == owner) {
                        return Err(invalid("This owner has already signed"));
                    }
                    if !code(&req.chain, &owner)?.is_empty() {
                        return Err(invalid("Contract owner signatures are not supported"));
                    }
                    let secret = loader().map_err(EvmServiceError::InvalidInput)?;
                    let key = signing_key_from_bytes(secret.as_slice())?;
                    if !address_eq(&address_from_signing_key(&key), &owner) {
                        return Err(invalid("Signing key does not match selected owner"));
                    }
                    proposal.signatures.push(SafeSignature {
                        owner,
                        signature: sign_hash(&key, &proposal_hash(&proposal)?)?,
                    });
                    proposal.signatures = verified_signatures(&proposal, &info.owners)?;
                    Ok(json!({"proposal": proposal, "account": info}))
                }
                SafeCommand::PrepareExecute { .. } | SafeCommand::Execute { .. } => {
                    if proposal.nonce != info.nonce {
                        return Err(invalid(
                            "Execute earlier Safe nonces before this queued transaction",
                        ));
                    }
                    let data = execution_data(&proposal, info.threshold)?;
                    // Safe can emit ExecutionFailure inside a successful outer tx.
                    // Simulate and require true before handing anything to the signer.
                    let simulation = hex_data_to_bytes(&eth_call_tx(
                        &req.chain,
                        Some(&req.wallet_address),
                        &proposal.safe_address,
                        "0",
                        &data,
                    )?)?;
                    if read_size(&simulation, 0)? != 1 {
                        return Err(invalid("Safe execution simulation failed"));
                    }
                    if matches!(&req.command, SafeCommand::Execute { .. }) {
                        send(&req, &proposal.safe_address, &data, loader)
                    } else {
                        let gas = estimate_gas(
                            &req.chain,
                            &normalize_address(&req.wallet_address, "executor wallet")?,
                            &proposal.safe_address,
                            "0",
                            &data,
                        )?;
                        Ok(
                            json!({"proposal": proposal, "account": info, "gas_limit": gas, "estimated_fee_wei": decimal_mul(&load_fee_quote(&req.chain)?.max_fee_per_gas_wei(), &gas)?}),
                        )
                    }
                }
                _ => Ok(json!({"proposal": proposal, "account": info})),
            }
        }
        SafeCommand::Receipt {
            address,
            transaction_hash,
            safe_tx_hash,
        } => {
            let address = normalize_address(address, "Safe address")?;
            let hash = normalize_tx_hash(transaction_hash)?;
            let receipt = rpc_call(&req.chain, "eth_getTransactionReceipt", json!([hash]))?;
            if receipt.is_null() {
                return Ok(json!({"status": "pending"}));
            }
            if receipt["status"] != "0x1" {
                return Ok(json!({"status": "failed"}));
            }
            if let Some(safe_hash) = safe_tx_hash {
                let safe_hash = normalize_tx_hash(safe_hash)?;
                let success = hex_bytes(&keccak256(b"ExecutionSuccess(bytes32,uint256)"));
                let failure = hex_bytes(&keccak256(b"ExecutionFailure(bytes32,uint256)"));
                for log in receipt["logs"]
                    .as_array()
                    .ok_or(EvmServiceError::RpcUnavailable)?
                {
                    if !log["address"]
                        .as_str()
                        .is_some_and(|a| address_eq(a, &address))
                    {
                        continue;
                    }
                    let topic = log["topics"][0].as_str().unwrap_or("");
                    let event_hash = log["topics"][1].as_str().unwrap_or("");
                    if event_hash
                        .get(..66)
                        .is_some_and(|h| h.eq_ignore_ascii_case(&safe_hash))
                    {
                        if topic == success {
                            return Ok(json!({"status": "confirmed"}));
                        }
                        if topic == failure {
                            return Ok(json!({"status": "failed"}));
                        }
                    }
                }
                return Ok(json!({"status": "unverified"}));
            }
            // A creation receipt must actually contain this factory's ProxyCreation.
            let created = hex_bytes(&keccak256(b"ProxyCreation(address,address)"));
            let found = receipt["logs"]
                .as_array()
                .ok_or(EvmServiceError::RpcUnavailable)?
                .iter()
                .any(|log| {
                    log["address"]
                        .as_str()
                        .is_some_and(|a| address_eq(a, FACTORY))
                        && log["topics"][0] == created
                        && log["topics"][1]
                            .as_str()
                            .and_then(|data| hex_data_to_bytes(data).ok())
                            .and_then(|data| read_address(&data, 0).ok())
                            .is_some_and(|a| a == address)
                });
            if !found {
                return Ok(json!({"status": "unverified"}));
            }
            Ok(json!({"status": "confirmed", "account": account(&req.chain, &address)?}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal() -> SafeProposal {
        let mut p = SafeProposal {
            version: 1,
            chain_id: 97,
            safe_address: "0x1111111111111111111111111111111111111111".into(),
            to: "0x2222222222222222222222222222222222222222".into(),
            value: "123".into(),
            data: "0x123456".into(),
            nonce: "0".into(),
            batch: None,
            safe_tx_hash: String::new(),
            signatures: vec![],
        };
        p.safe_tx_hash = hex_bytes(&proposal_hash(&p).unwrap());
        p
    }
    #[test]
    fn rejects_duplicate_owners_and_unsafe_thresholds() {
        let a = "0x1111111111111111111111111111111111111111".to_string();
        let b = "0x2222222222222222222222222222222222222222".to_string();
        assert!(creation_data(&[a.clone(), a.clone()], 2, "0").is_err());
        assert!(creation_data(&[a.clone(), b.clone()], 1, "0").is_err());
        assert!(creation_data(&[a.clone(), ZERO.into()], 2, "0").is_err());
        assert!(creation_data(&[a, b], 2, "0").is_ok());
    }
    #[test]
    fn imported_transaction_cannot_add_hidden_authority() {
        let mut json = serde_json::to_value(proposal()).unwrap();
        json["operation"] = json!(1);
        assert!(serde_json::from_value::<SafeProposal>(json).is_err());
        let mut p = proposal();
        let chain = builtin_chains()
            .into_iter()
            .find(|c| c.chain_id == 97)
            .unwrap();
        assert!(canonical_proposal(&chain, &p).is_ok());
        p.value = "124".into();
        assert!(canonical_proposal(&chain, &p).is_err());
        p = proposal();
        p.chain_id = 56;
        assert!(canonical_proposal(&chain, &p).is_err());
        p = proposal();
        p.safe_address = p.to.clone();
        assert!(canonical_proposal(&chain, &p).is_err());
    }
    #[test]
    fn signatures_are_recovered_sorted_and_bound_to_exact_proposal() {
        let mut p = proposal();
        let keys = [
            signing_key_from_bytes(&[1; 32]).unwrap(),
            signing_key_from_bytes(&[2; 32]).unwrap(),
        ];
        let owners: Vec<_> = keys.iter().map(address_from_signing_key).collect();
        for key in &keys {
            p.signatures.push(SafeSignature {
                owner: address_from_signing_key(key),
                signature: sign_hash(key, &proposal_hash(&p).unwrap()).unwrap(),
            });
        }
        let signatures = verified_signatures(&p, &owners).unwrap();
        assert!(signatures[0].owner < signatures[1].owner);
        assert!(execution_data(&p, 3).is_err());
        let mut changed = p.clone();
        changed.nonce = "1".into();
        assert!(verified_signatures(&changed, &owners).is_err());
        let mut duplicate = p.clone();
        duplicate.signatures.push(duplicate.signatures[0].clone());
        assert!(verified_signatures(&duplicate, &owners).is_err());
        let mut spoof = p.clone();
        spoof.signatures[0].owner = owners[1].clone();
        assert!(verified_signatures(&spoof, &owners).is_err());
        let mut wrong_v = p.clone();
        wrong_v.signatures[0]
            .signature
            .replace_range(130..132, "00");
        assert!(verified_signatures(&wrong_v, &owners).is_err());
    }
    #[test]
    fn malformed_abi_cannot_overflow_or_truncate() {
        let pending: JsonRpcResponse = serde_json::from_str(r#"{"result":null}"#).unwrap();
        assert_eq!(pending.result, Some(Value::Null));
        let missing: JsonRpcResponse = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(missing.result, None);
        assert!(read_dynamic(&[255; 64]).is_err());
        assert!(read_address(&[255; 32], 0).is_err());
        let mut truncated = number(32).to_vec();
        truncated.extend(number(10));
        assert!(read_dynamic(&truncated).is_err());
    }

    /// Requires anvil and unmodified artifacts from @safe-global/safe-contracts@1.4.1.
    /// Only talks to the child chain on 127.0.0.1, with generated test keys.
    #[test]
    #[ignore = "requires ANVIL_BIN and SAFE_ARTIFACTS_DIR; see docs/safe-multisig.md"]
    fn real_safe_creation_signing_execution_and_replay_protection() {
        use std::{
            net::TcpListener,
            path::PathBuf,
            process::{Command, Stdio},
        };
        struct Node(std::process::Child);
        impl Drop for Node {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut node = Command::new(std::env::var("ANVIL_BIN").unwrap_or_else(|_| "anvil".into()));
        node.args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--chain-id",
            "31337",
            "--silent",
        ]);
        let _node = Node(
            node.stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let chain = EvmChainConfig {
            chain_id: 31337,
            name: "Safe isolated test".into(),
            native_symbol: "ETH".into(),
            rpc_url: format!("http://127.0.0.1:{port}"),
            explorer_url: None,
            testnet: true,
        };
        for _ in 0..100 {
            if validate_rpc_chain_id(&chain).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        validate_rpc_chain_id(&chain).unwrap();
        let dir = PathBuf::from(
            std::env::var("SAFE_ARTIFACTS_DIR").expect("SAFE_ARTIFACTS_DIR required"),
        );
        for (name, address, subdir) in [
            ("Safe", SINGLETON, ""),
            ("SafeProxyFactory", FACTORY, "proxies/"),
            ("MultiSendCallOnly", batch::MULTISEND, "libraries/"),
        ] {
            let artifact: Value = serde_json::from_slice(
                &std::fs::read(dir.join(format!("{subdir}{name}.sol/{name}.json"))).unwrap(),
            )
            .unwrap();
            rpc_call(
                &chain,
                "anvil_setCode",
                json!([address, artifact["deployedBytecode"]]),
            )
            .unwrap();
        }
        let keys = [[1u8; 32], [2u8; 32], [3u8; 32]];
        let owners: Vec<String> = keys
            .iter()
            .map(|key| address_from_signing_key(&signing_key_from_bytes(key).unwrap()))
            .collect();
        for owner in &owners {
            rpc_call(
                &chain,
                "anvil_setBalance",
                json!([owner, "0x56bc75e2d63100000"]),
            )
            .unwrap();
        }
        let request = |command: SafeCommand, signer: usize, approved: bool| SafeRequest {
            chain: chain.clone(),
            wallet_address: owners[signer].clone(),
            approved,
            max_fee_wei: Some("1000000000000000000".into()),
            command,
        };
        let run = |command, signer: usize, approved| {
            handle(request(command, signer, approved), || {
                Ok(Zeroizing::new(keys[signer].to_vec()))
            })
        };
        let create = || SafeCommand::Create {
            owners: owners[..2].to_vec(),
            threshold: 2,
            salt_nonce: "42".into(),
        };
        assert!(handle(request(create(), 0, false), || panic!(
            "unapproved key access"
        ))
        .is_err());
        let preview = run(
            SafeCommand::PrepareCreate {
                owners: owners[..2].to_vec(),
                threshold: 2,
                salt_nonce: "42".into(),
            },
            0,
            false,
        )
        .unwrap();
        let mut approved_create = request(create(), 0, true);
        approved_create.max_fee_wei = Some(
            preview["estimated_fee_wei"]
                .as_str()
                .expect("creation fee quote")
                .into(),
        );
        let mut over_budget = approved_create.clone();
        over_budget.max_fee_wei = Some("0".into());
        assert!(handle(over_budget, || panic!("over-budget key access")).is_err());
        let created = handle(approved_create, || Ok(Zeroizing::new(keys[0].to_vec()))).unwrap();
        rpc_call(&chain, "evm_mine", json!([])).unwrap();
        assert_eq!(created["address"], preview["address"]);
        let address = created["address"].as_str().unwrap().to_string();
        let receipt = run(
            SafeCommand::Receipt {
                address: address.clone(),
                transaction_hash: created["transaction_hash"].as_str().unwrap().into(),
                safe_tx_hash: None,
            },
            0,
            false,
        )
        .unwrap();
        assert_eq!(receipt["status"], "confirmed");
        assert_eq!(receipt["account"]["threshold"], 2);
        // Discovery must recover a fresh installation without reading a key,
        // and must not associate an unrelated EOA with the same Safe.
        for signer in [0, 1, 2] {
            let found = handle(
                request(
                    SafeCommand::Discover {
                        before_block: None,
                        offset: 0,
                        block_span: None,
                    },
                    signer,
                    false,
                ),
                || panic!("discovery accessed a key"),
            )
            .unwrap();
            assert_eq!(found["discovery"]["complete"], true);
            let accounts = found["discovery"]["accounts"].as_array().unwrap();
            assert_eq!(accounts.len(), usize::from(signer < 2));
            if signer < 2 {
                assert_eq!(accounts[0]["address"], address);
            }
        }
        rpc_call(
            &chain,
            "anvil_setBalance",
            json!([address, "0xde0b6b3a7640000"]),
        )
        .unwrap();
        let proposed = run(
            SafeCommand::Propose {
                address: address.clone(),
                to: owners[2].clone(),
                value: "17".into(),
                data: "0x".into(),
                nonce: None,
                batch: None,
            },
            0,
            false,
        )
        .unwrap();
        let p: SafeProposal = serde_json::from_value(proposed["proposal"].clone()).unwrap();
        assert!(handle(
            request(
                SafeCommand::Sign {
                    proposal: p.clone()
                },
                2,
                true
            ),
            || panic!("non-owner key access")
        )
        .is_err());
        let first = run(
            SafeCommand::Sign {
                proposal: p.clone(),
            },
            0,
            true,
        )
        .unwrap();
        let first: SafeProposal = serde_json::from_value(first["proposal"].clone()).unwrap();
        assert!(run(
            SafeCommand::PrepareExecute {
                proposal: first.clone()
            },
            0,
            false
        )
        .is_err());
        assert!(run(
            SafeCommand::Sign {
                proposal: first.clone()
            },
            0,
            true
        )
        .is_err());
        let second = run(SafeCommand::Sign { proposal: first }, 1, true).unwrap();
        let second: SafeProposal = serde_json::from_value(second["proposal"].clone()).unwrap();
        for field in ["to", "safe", "value", "data", "nonce", "chain"] {
            let mut tampered = second.clone();
            match field {
                "to" => tampered.to = address.clone(),
                "safe" => tampered.safe_address = owners[2].clone(),
                "value" => tampered.value = "18".into(),
                "data" => tampered.data = "0x00".into(),
                "nonce" => tampered.nonce = "1".into(),
                "chain" => tampered.chain_id = 97,
                _ => unreachable!(),
            }
            assert!(handle(
                request(SafeCommand::Execute { proposal: tampered }, 0, true),
                || panic!("tampered transaction must not access keys")
            )
            .is_err());
        }
        run(
            SafeCommand::PrepareExecute {
                proposal: second.clone(),
            },
            0,
            false,
        )
        .unwrap();
        let queued = run(
            SafeCommand::Propose {
                address: address.clone(),
                to: owners[2].clone(),
                value: "0".into(),
                data: "0x".into(),
                nonce: Some("1".into()),
                batch: None,
            },
            0,
            false,
        )
        .unwrap();
        let mut queued: SafeProposal = serde_json::from_value(queued["proposal"].clone()).unwrap();
        for signer in 0..2 {
            queued = serde_json::from_value(
                run(SafeCommand::Sign { proposal: queued }, signer, true).unwrap()["proposal"]
                    .clone(),
            )
            .unwrap();
        }
        assert!(run(
            SafeCommand::PrepareExecute {
                proposal: queued.clone()
            },
            0,
            false
        )
        .is_err());
        let executed = run(
            SafeCommand::Execute {
                proposal: second.clone(),
            },
            0,
            true,
        )
        .unwrap();
        rpc_call(&chain, "evm_mine", json!([])).unwrap();
        let receipt = run(
            SafeCommand::Receipt {
                address: address.clone(),
                transaction_hash: executed["transaction_hash"].as_str().unwrap().into(),
                safe_tx_hash: Some(p.safe_tx_hash),
            },
            0,
            false,
        )
        .unwrap();
        assert_eq!(receipt["status"], "confirmed");
        assert_eq!(account(&chain, &address).unwrap().nonce, "1");
        assert_eq!(
            account(&chain, &address).unwrap().balance_wei,
            "999999999999999983"
        );
        assert!(run(SafeCommand::Execute { proposal: second }, 0, true).is_err());
        run(SafeCommand::PrepareExecute { proposal: queued }, 0, false).unwrap();
        // Exercise dynamic calldata encoding with a genuine contract call.
        let result = run(
            SafeCommand::Propose {
                address: address.clone(),
                to: FACTORY.into(),
                value: "0".into(),
                data: calldata("proxyCreationCode()", &[]),
                nonce: None,
                batch: None,
            },
            0,
            false,
        )
        .unwrap();
        let mut p: SafeProposal = serde_json::from_value(result["proposal"].clone()).unwrap();
        for signer in 0..2 {
            p = serde_json::from_value(
                run(SafeCommand::Sign { proposal: p }, signer, true).unwrap()["proposal"].clone(),
            )
            .unwrap();
        }
        run(SafeCommand::Execute { proposal: p }, 0, true).unwrap();
        rpc_call(&chain, "evm_mine", json!([])).unwrap();
        assert_eq!(account(&chain, &address).unwrap().nonce, "2");
        // Optional cross-language fixture generated by the actual desktop ABI builder.
        // Solidity decodes the full nested tuple; ethers independently computes its expected hash.
        if let Ok(path) = std::env::var("SAFE_ABI_FIXTURE") {
            let fixture: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            let receiver = "0x4444444444444444444444444444444444444444";
            rpc_call(
                &chain,
                "anvil_setCode",
                json!([receiver, fixture["runtime"]]),
            )
            .unwrap();
            let cases = fixture["calls"].as_array().unwrap();
            assert!(!cases.is_empty());
            for (index, case) in cases.iter().enumerate() {
                let proposed = run(
                    SafeCommand::Propose {
                        address: address.clone(),
                        to: receiver.into(),
                        value: case["value"].as_str().unwrap().into(),
                        data: case["data"].as_str().unwrap().into(),
                        nonce: None,
                        batch: None,
                    },
                    0,
                    false,
                )
                .unwrap();
                let mut p: SafeProposal =
                    serde_json::from_value(proposed["proposal"].clone()).unwrap();
                assert_eq!(p.data, case["data"].as_str().unwrap());
                for signer in 0..2 {
                    p = serde_json::from_value(
                        run(SafeCommand::Sign { proposal: p }, signer, true).unwrap()["proposal"]
                            .clone(),
                    )
                    .unwrap();
                }
                run(
                    SafeCommand::PrepareExecute {
                        proposal: p.clone(),
                    },
                    2,
                    false,
                )
                .unwrap();
                let executed = run(
                    SafeCommand::Execute {
                        proposal: p.clone(),
                    },
                    2,
                    true,
                )
                .unwrap();
                rpc_call(&chain, "evm_mine", json!([])).unwrap();
                let receipt = run(
                    SafeCommand::Receipt {
                        address: address.clone(),
                        transaction_hash: executed["transaction_hash"].as_str().unwrap().into(),
                        safe_tx_hash: Some(p.safe_tx_hash),
                    },
                    2,
                    false,
                )
                .unwrap();
                assert_eq!(receipt["status"], "confirmed", "case {index}");
                assert_eq!(
                    hex_bytes(&call(&chain, receiver, "lastHash()", &[]).unwrap()),
                    case["expected_hash"].as_str().unwrap(),
                    "decoded parameter hash in case {index}"
                );
                assert_eq!(
                    read_address(&call(&chain, receiver, "lastSender()", &[]).unwrap(), 0).unwrap(),
                    address
                );
                assert_eq!(
                    call(&chain, receiver, "lastValue()", &[]).unwrap(),
                    word(case["value"].as_str().unwrap()).unwrap()
                );
                assert_eq!(
                    read_size(&call(&chain, receiver, "calls()", &[]).unwrap(), 0).unwrap(),
                    index + 1
                );
                assert_eq!(
                    account(&chain, &address).unwrap().nonce,
                    (index + 3).to_string()
                );
            }
            let before = account(&chain, &address).unwrap().nonce;
            for (data, value) in [
                (
                    fixture["nonpayable_data"].as_str().unwrap().to_string(),
                    "1",
                ),
                (cases[0]["data"].as_str().unwrap()[..10].to_string(), "0"),
            ] {
                let proposed = run(
                    SafeCommand::Propose {
                        address: address.clone(),
                        to: receiver.into(),
                        value: value.into(),
                        data,
                        nonce: None,
                        batch: None,
                    },
                    0,
                    false,
                )
                .unwrap();
                let mut p: SafeProposal =
                    serde_json::from_value(proposed["proposal"].clone()).unwrap();
                for signer in 0..2 {
                    p = serde_json::from_value(
                        run(SafeCommand::Sign { proposal: p }, signer, true).unwrap()["proposal"]
                            .clone(),
                    )
                    .unwrap();
                }
                assert!(run(
                    SafeCommand::PrepareExecute {
                        proposal: p.clone()
                    },
                    2,
                    false
                )
                .is_err());
                assert!(handle(
                    request(SafeCommand::Execute { proposal: p }, 2, true),
                    || panic!("reverting call must not access keys")
                )
                .is_err());
                assert_eq!(account(&chain, &address).unwrap().nonce, before);
            }
            println!("Verified {} frontend-encoded ABI calls through real Safe 2/2 execution, receiver state and rejected malformed/nonpayable calls", cases.len());
        }
        let nonce_before_revert = account(&chain, &address).unwrap().nonce;
        // A reverting target cannot be reported as a successful execution.
        let result = run(
            SafeCommand::Propose {
                address: address.clone(),
                to: FACTORY.into(),
                value: "0".into(),
                data: "0xdeadbeef".into(),
                nonce: None,
                batch: None,
            },
            0,
            false,
        )
        .unwrap();
        let mut p: SafeProposal = serde_json::from_value(result["proposal"].clone()).unwrap();
        for signer in 0..2 {
            p = serde_json::from_value(
                run(SafeCommand::Sign { proposal: p }, signer, true).unwrap()["proposal"].clone(),
            )
            .unwrap();
        }
        assert!(run(SafeCommand::PrepareExecute { proposal: p }, 0, false).is_err());
        assert_eq!(
            account(&chain, &address).unwrap().nonce,
            nonce_before_revert
        );
        // Official MultiSendCallOnly executes from the Safe, consumes one nonce,
        // and rolls back all preceding calls when a later target reverts.
        let before_batch = account(&chain, &address).unwrap();
        let calls = vec![
            SafeBatchCall {
                to: owners[2].clone(),
                value: "7".into(),
                data: "0x".into(),
            },
            SafeBatchCall {
                to: owners[2].clone(),
                value: "11".into(),
                data: "0x".into(),
            },
        ];
        let propose_batch = |calls: Vec<SafeBatchCall>| SafeCommand::Propose {
            address: address.clone(),
            to: batch::MULTISEND.into(),
            value: "0".into(),
            data: batch::encode(&calls).unwrap(),
            nonce: None,
            batch: Some(calls),
        };
        let result = run(propose_batch(calls.clone()), 0, false).unwrap();
        let mut batched: SafeProposal = serde_json::from_value(result["proposal"].clone()).unwrap();
        // A changed inner recipient, value, operation interpretation or envelope is rejected before key access.
        for mode in 0..4 {
            let mut changed = batched.clone();
            match mode {
                0 => changed.batch.as_mut().unwrap()[0].to = owners[1].clone(),
                1 => changed.batch.as_mut().unwrap()[0].value = "8".into(),
                2 => changed.batch = None,
                _ => changed.to = owners[2].clone(),
            }
            assert!(handle(
                request(SafeCommand::Sign { proposal: changed }, 0, true),
                || panic!("tampered batch accessed a key")
            )
            .is_err());
        }
        for signer in 0..2 {
            batched = serde_json::from_value(
                run(SafeCommand::Sign { proposal: batched }, signer, true).unwrap()["proposal"]
                    .clone(),
            )
            .unwrap();
        }
        let batch_hash = batched.safe_tx_hash.clone();
        let sent = run(SafeCommand::Execute { proposal: batched }, 0, true).unwrap();
        rpc_call(&chain, "evm_mine", json!([])).unwrap();
        assert_eq!(
            run(
                SafeCommand::Receipt {
                    address: address.clone(),
                    transaction_hash: sent["transaction_hash"].as_str().unwrap().into(),
                    safe_tx_hash: Some(batch_hash)
                },
                0,
                false
            )
            .unwrap()["status"],
            "confirmed"
        );
        let after_batch = account(&chain, &address).unwrap();
        assert_eq!(
            after_batch.nonce,
            decimal_add(&before_batch.nonce, "1").unwrap()
        );
        assert_eq!(
            decimal_add(&after_batch.balance_wei, "18").unwrap(),
            before_batch.balance_wei
        );
        let mut failing = calls.clone();
        failing[1] = SafeBatchCall {
            to: FACTORY.into(),
            value: "0".into(),
            data: "0xdeadbeef".into(),
        };
        let result = run(propose_batch(failing), 0, false).unwrap();
        let mut failing: SafeProposal = serde_json::from_value(result["proposal"].clone()).unwrap();
        for signer in 0..2 {
            failing = serde_json::from_value(
                run(SafeCommand::Sign { proposal: failing }, signer, true).unwrap()["proposal"]
                    .clone(),
            )
            .unwrap();
        }
        assert!(handle(
            request(
                SafeCommand::Execute {
                    proposal: failing.clone()
                },
                0,
                true
            ),
            || panic!("reverting batch accessed a key")
        )
        .is_err());
        // Broadcast the signed reverting payload directly on the isolated node to prove EVM rollback,
        // independently of the application's simulation guard.
        rpc_call(&chain, "anvil_impersonateAccount", json!([owners[0]])).unwrap();
        let raw = rpc_call(&chain,"eth_sendTransaction",json!([{"from":owners[0],"to":address,"data":execution_data(&failing,2).unwrap(),"gas":"0x2dc6c0"}])).unwrap();
        rpc_call(&chain, "evm_mine", json!([])).unwrap();
        let receipt = rpc_call(&chain, "eth_getTransactionReceipt", json!([raw])).unwrap();
        assert_eq!(receipt["status"], "0x0");
        rpc_call(&chain, "anvil_stopImpersonatingAccount", json!([owners[0]])).unwrap();
        assert_eq!(account(&chain, &address).unwrap().nonce, after_batch.nonce);
        assert_eq!(
            account(&chain, &address).unwrap().balance_wei,
            after_batch.balance_wei
        );
        rpc_call(&chain, "anvil_setCode", json!([batch::MULTISEND, "0x00"])).unwrap();
        assert!(handle(request(propose_batch(calls), 0, false), || panic!(
            "untrusted batch runtime accessed a key"
        ))
        .is_err());
        // Fail closed when the chain has no trusted factory.
        rpc_call(&chain, "anvil_setCode", json!([FACTORY, "0x00"])).unwrap();
        assert!(account(&chain, &address).is_err());
    }
}
