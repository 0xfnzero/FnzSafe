use super::*;

// Safe's canonical 1.4.1 deployment (including Ethereum, BSC and BSC testnet).
// Only this exact runtime may receive a DELEGATECALL; its inner operations are CALL-only.
pub(super) const MULTISEND: &str = "0x9641d764fc13c8b624c04430c7356c1c7c8102e2";
const RUNTIME_HASH: &str = "ecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafeBatchCall {
    pub to: String,
    pub value: String,
    pub data: String,
}

pub(super) fn encode(calls: &[SafeBatchCall]) -> EvmResult<String> {
    if calls.len() < 2 || calls.len() > 100 {
        return Err(invalid("Safe batch must contain 2–100 calls"));
    }
    let mut packed = Vec::new();
    for call in calls {
        let to = normalize_address(&call.to, "batch recipient")?;
        if to == ZERO {
            return Err(invalid("Zero-address batch recipient"));
        }
        let value = normalize_decimal(&call.value, "batch value")?;
        if value != call.value {
            return Err(invalid("Noncanonical batch value"));
        }
        if call.data.len() > MAX_DATA * 2 + 2 {
            return Err(invalid("Safe batch exceeds 64 KiB"));
        }
        let data = hex_data_to_bytes(&call.data)?;
        packed.push(0); // CALL, never nested delegatecall.
        packed.extend(address_bytes(&to)?);
        packed.extend(word(&value)?);
        packed.extend(number(data.len()));
        packed.extend(data);
        if packed.len() > MAX_DATA - 100 {
            return Err(invalid("Safe batch exceeds 64 KiB"));
        }
    }
    let mut args = number(32).to_vec();
    args.extend(bytes_tail(&packed));
    Ok(calldata("multiSend(bytes)", &args))
}

pub(super) fn validate(p: &SafeProposal) -> EvmResult<()> {
    if let Some(calls) = &p.batch {
        if p.to != MULTISEND || p.value != "0" || p.data != encode(calls)? {
            return Err(invalid("Safe batch does not match its executable payload"));
        }
    }
    Ok(())
}

pub(super) fn verify_runtime(chain: &EvmChainConfig, p: &SafeProposal) -> EvmResult<()> {
    if p.batch.is_some() {
        require_code(chain, MULTISEND, &[RUNTIME_HASH])?;
    }
    Ok(())
}
