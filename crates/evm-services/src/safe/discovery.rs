//! Resumable, read-only discovery from the canonical 1.4.1 factory. Logs are
//! candidates only: current membership and deployed bytecode decide inclusion.
use super::*;

const MAX_BLOCK_SPAN: u64 = 50_000;
const PAGE_SIZE: usize = 5;

fn block_number(value: &Value) -> EvmResult<u64> {
    let raw = value
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .ok_or_else(|| invalid("Invalid discovery block number"))?;
    u64::from_str_radix(raw, 16).map_err(|_| invalid("Invalid discovery block number"))
}

fn candidate(log: &Value, topic: &str) -> EvmResult<Option<(String, String)>> {
    if log["removed"] == true {
        return Ok(None);
    }
    if !log["address"]
        .as_str()
        .is_some_and(|a| a.eq_ignore_ascii_case(FACTORY))
        || log["topics"][0].as_str() != Some(topic)
    {
        return Err(invalid("Unexpected Safe factory log"));
    }
    let topics = log["topics"]
        .as_array()
        .ok_or_else(|| invalid("Malformed Safe factory log"))?;
    if topics.len() != 2 {
        return Err(invalid("Malformed Safe factory topics"));
    }
    let proxy = hex_data_to_bytes(
        topics[1]
            .as_str()
            .ok_or_else(|| invalid("Malformed proxy topic"))?,
    )?;
    let singleton = hex_data_to_bytes(
        log["data"]
            .as_str()
            .ok_or_else(|| invalid("Malformed singleton data"))?,
    )?;
    if proxy.len() != 32 || singleton.len() != 32 {
        return Err(invalid("Malformed Safe factory data"));
    }
    Ok(Some((
        read_address(&proxy, 0)?,
        read_address(&singleton, 0)?,
    )))
}

pub(super) fn discover(
    chain: &EvmChainConfig,
    owner: &str,
    before: Option<u64>,
    offset: usize,
    span: Option<u64>,
) -> EvmResult<Value> {
    let owner = normalize_address(owner, "Safe owner")?;
    verify_factory(chain)?;
    let latest = block_number(&rpc_call(chain, "eth_blockNumber", json!([]))?)?;
    let to = before.unwrap_or(latest);
    if to > latest || offset > 100_000 {
        return Err(invalid("Invalid discovery cursor"));
    }
    let mut span = span.unwrap_or(MAX_BLOCK_SPAN).clamp(1, MAX_BLOCK_SPAN);
    let topic = hex_bytes(&keccak256(b"ProxyCreation(address,address)"));
    // Some RPCs allow only small log ranges. Shrink without advancing the cursor.
    let (from, logs) = loop {
        let from = to.saturating_sub(span - 1);
        let result = rpc_call(
            chain,
            "eth_getLogs",
            json!([{
                "address": FACTORY, "topics": [topic],
                "fromBlock": format!("0x{from:x}"), "toBlock": format!("0x{to:x}")
            }]),
        );
        match result {
            Ok(value) => break (from, value),
            Err(_) if offset == 0 && span > 500 => {
                span = (span / 10).max(500);
            }
            Err(error) => return Err(error),
        }
    };
    let mut logs = logs
        .as_array()
        .ok_or_else(|| invalid("Invalid factory log response"))?
        .clone();
    // Deterministic pagination, including several creations in the same block.
    let mut ordered = Vec::with_capacity(logs.len());
    for log in logs.drain(..) {
        let block = block_number(&log["blockNumber"])?;
        if block < from || block > to {
            return Err(invalid("Factory log outside requested range"));
        }
        ordered.push((block, block_number(&log["logIndex"])?, log));
    }
    ordered.sort_by_key(|(block, index, _)| std::cmp::Reverse((*block, *index)));
    if offset > ordered.len() {
        return Err(invalid(
            "Discovery history changed; restart synchronization",
        ));
    }
    let end = (offset + PAGE_SIZE).min(ordered.len());
    let mut accounts = Vec::new();
    let mut unsupported = 0;
    for (_, _, log) in &ordered[offset..end] {
        let Some((address, singleton)) = candidate(log, &topic)? else {
            continue;
        };
        // Unknown singleton deployments may emit misleading events or revert.
        // Never use them as an account or invoke their getOwners method.
        match require_code(chain, &singleton, &[SAFE_HASH, SAFE_L2_HASH]) {
            Ok(()) => {}
            Err(EvmServiceError::InvalidInput(_)) => {
                unsupported += 1;
                continue;
            }
            Err(error) => return Err(error),
        }
        let owners = call(chain, &address, "getOwners()", &[])?;
        if read_size(&owners, 0)? != 32 {
            return Err(invalid("Invalid owners offset"));
        }
        let count = read_size(&owners, 32)?;
        if count == 0 || count > MAX_OWNERS {
            unsupported += 1;
            continue;
        }
        let mut member = false;
        for i in 0..count {
            member |= read_address(&owners, 64 + i * 32)? == owner;
        }
        if member {
            // Recheck exact proxy/singleton code, version, and live owners before caching.
            let account = account(chain, &address)?;
            if account
                .owners
                .iter()
                .any(|a| a.eq_ignore_ascii_case(&owner))
            {
                accounts.push(account);
            }
        }
    }
    let more_in_range = end < ordered.len();
    let next = if more_in_range {
        Some(to)
    } else {
        from.checked_sub(1)
    };
    Ok(json!({ "discovery": {
        "accounts": accounts, "from_block": from, "to_block": to, "latest_block": latest,
        "next_before_block": next, "next_offset": if more_in_range { end } else { 0 },
        "block_span": span, "complete": next.is_none(), "unsupported": unsupported
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn factory_candidates_require_exact_event_shape() {
        let topic = hex_bytes(&keccak256(b"ProxyCreation(address,address)"));
        let proxy = "0x1111111111111111111111111111111111111111";
        let log = json!({"address":FACTORY,"topics":[topic, hex_bytes(&address_word(proxy).unwrap())], "data":hex_bytes(&address_word(SINGLETON).unwrap())});
        assert_eq!(
            candidate(&log, &topic).unwrap(),
            Some((proxy.into(), SINGLETON.into()))
        );
        for bad in [
            json!({"address":ZERO}),
            json!({"topics":[]}),
            json!({"data":"0x"}),
        ] {
            let mut altered = log.clone();
            for (key, value) in bad.as_object().unwrap() {
                altered[key] = value.clone();
            }
            assert!(candidate(&altered, &topic).is_err());
        }
        let mut removed = log;
        removed["removed"] = json!(true);
        assert_eq!(candidate(&removed, &topic).unwrap(), None);
    }
}
