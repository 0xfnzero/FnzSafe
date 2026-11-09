//! Network choices come from the trusted wallet UI, never from a site's RPC URLs.
use super::*;

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct NetworkContext {
    pub wallet_family: String,
    pub wallet_public_key: String,
    pub network: String,
    pub rpc_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct NetworkSelection {
    #[serde(skip)]
    changed: bool,
    pub tab_id: String,
    pub wallet_family: String,
    pub wallet_public_key: String,
    pub network: String,
}

pub(crate) fn validate_contexts(contexts: &[NetworkContext]) -> Result<(), String> {
    if contexts.len() > 128 {
        return Err("Too many DApp networks".into());
    }
    let mut networks = HashSet::new();
    for context in contexts {
        if !networks.insert(context.network.clone()) {
            return Err("Duplicate DApp network".into());
        }
        match context.wallet_family.as_str() {
            "evm" => {
                validate_deep_link_evm_network(&context.network)?;
                if !is_likely_evm_address(&context.wallet_public_key) {
                    return Err("Invalid EVM wallet address".into());
                }
                // Validate URLs now; only instantiate the RPC client when selected.
                evm_dapp_rpc::ReadRpc::new(
                    context.rpc_url.as_deref().ok_or("Missing EVM RPC")?,
                    &context.network,
                )?;
            }
            "solana" => {
                validate_dapp_network(&context.network)?;
                if context.network.starts_with("eip155:")
                    || !is_likely_solana_pubkey(&context.wallet_public_key)
                {
                    return Err("Invalid Solana wallet context".into());
                }
            }
            _ => return Err("Unsupported DApp wallet family".into()),
        }
    }
    Ok(())
}

fn selection(label: &str, session: &DappSession) -> Result<NetworkSelection, String> {
    Ok(NetworkSelection {
        changed: false,
        tab_id: dapp_tab_id_from_label(label)
            .ok_or("Invalid DApp tab")?
            .to_string(),
        wallet_family: session.wallet_family.clone(),
        wallet_public_key: session.wallet_public_key.clone(),
        network: session.network.clone(),
    })
}

// Main-window-only command: events merely wake the UI; the native session is authoritative.
#[tauri::command]
pub(crate) fn dapp_current_network(
    state: tauri::State<'_, DappBridgeState>,
    tab_id: String,
) -> Result<NetworkSelection, String> {
    ensure_dapp_connections_active(state.inner())?;
    let label = dapp_tab_label(&tab_id)?;
    let sessions = state.sessions.lock().map_err(|_| "Session unavailable")?;
    selection(
        &label,
        sessions.get(&label).ok_or("DApp session is closed")?,
    )
}

#[tauri::command]
pub(crate) fn dapp_provider_network(
    webview: DesktopWebview,
    state: tauri::State<'_, DappBridgeState>,
    wallet_family: String,
) -> Result<String, evm_dapp_rpc::RpcError> {
    provider_network(state.inner(), webview.label(), &wallet_family)
        .map_err(|message| evm_dapp_rpc::RpcError::new(4900, &message))
}

fn provider_network(state: &DappBridgeState, label: &str, family: &str) -> Result<String, String> {
    ensure_dapp_connections_active(state)?;
    if dapp_tab_id_from_label(label).is_none() {
        return Err("Network lookup requires a DApp tab".into());
    }
    let sessions = state.sessions.lock().map_err(|_| "Session unavailable")?;
    let session = sessions.get(label).ok_or("DApp session is closed")?;
    if now_ms().saturating_sub(session.opened_at_ms) > 12 * 60 * 60 * 1000 {
        return Err("DApp session expired".into());
    }
    if session.wallet_family == family {
        return Ok(session.network.clone());
    }
    session
        .available_networks
        .iter()
        .find(|c| c.wallet_family == family)
        .map(|c| c.network.clone())
        .ok_or("This wallet has no account for the requested chain".into())
}

pub(crate) fn switch_network(
    state: &DappBridgeState,
    label: &str,
    network: &str,
) -> Result<NetworkSelection, evm_dapp_rpc::RpcError> {
    use evm_dapp_rpc::RpcError;
    fn denied(message: impl Into<String>) -> RpcError {
        RpcError::new(4100, &message.into())
    }
    ensure_dapp_connections_active(state).map_err(denied)?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| denied("Session unavailable"))?;
    let session = sessions
        .get_mut(label)
        .ok_or_else(|| denied("DApp session is closed"))?;
    if now_ms().saturating_sub(session.opened_at_ms) > 12 * 60 * 60 * 1000 {
        return Err(denied("DApp session expired"));
    }
    if session.network == network {
        return selection(label, session).map_err(denied);
    }
    let active = state
        .active_tab_label
        .try_lock()
        .map_err(|_| RpcError::new(-32002, "Wallet view is changing; retry the request"))?;
    if active.as_deref() != Some(label) {
        return Err(denied(
            "Only the visible DApp may change the wallet network",
        ));
    }
    let context = session
        .available_networks
        .iter()
        .find(|c| c.network == network)
        .cloned()
        .ok_or_else(|| {
            RpcError::new(
                4902,
                "Unknown network. Add or enable it in FnzSafe settings first.",
            )
        })?;
    // Hold these guards through the update, using the same ordering as claim/disconnect.
    let requests = state
        .requests
        .lock()
        .map_err(|_| denied("Signing requests unavailable"))?;
    let connects = state
        .connect_requests
        .lock()
        .map_err(|_| denied("Connection requests unavailable"))?;
    let current_time = now_ms();
    if requests.values().any(|p| {
        p.webview_label == label
            && p.result.is_none()
            && (p.claimed
                || current_time.saturating_sub(p.event.created_at_ms) <= DAPP_REQUEST_TTL_MS)
    }) || connects.values().any(|p| {
        p.webview_label.as_deref() == Some(label)
            && p.result.is_none()
            && current_time.saturating_sub(p.event.created_at_ms) <= DAPP_REQUEST_TTL_MS
    }) {
        return Err(RpcError::new(
            -32002,
            "Finish the pending wallet request before switching networks",
        ));
    }
    let rpc = if context.wallet_family == "evm" {
        Some(
            evm_dapp_rpc::ReadRpc::new(
                context
                    .rpc_url
                    .as_deref()
                    .ok_or_else(|| denied("Missing RPC"))?,
                network,
            )
            .map_err(denied)?,
        )
    } else {
        None
    };
    ensure_dapp_connections_active(state).map_err(denied)?;
    session.wallet_family = context.wallet_family;
    session.wallet_public_key = context.wallet_public_key;
    session.network = context.network;
    session.evm_rpc = rpc;
    // Remember the last explicitly selected network for each provider family.
    if let Some(index) = session
        .available_networks
        .iter()
        .position(|c| c.network == network)
    {
        let selected_context = session.available_networks.remove(index);
        session.available_networks.insert(0, selected_context);
    }
    session.opened_at_ms = current_time;
    let mut selected = selection(label, session).map_err(denied)?;
    selected.changed = true;
    Ok(selected)
}

#[tauri::command]
pub(crate) fn dapp_switch_network(
    webview: DesktopWebview,
    app: DesktopAppHandle,
    state: tauri::State<'_, DappBridgeState>,
    network: String,
) -> Result<String, evm_dapp_rpc::RpcError> {
    let selected = switch_network(state.inner(), webview.label(), &network)?;
    // Do not expose an address through network discovery before the connection approval.
    if selected.changed {
        let _ = app.emit_to("main", "dapp://network-changed", &selected.tab_id);
    }
    Ok(selected.network)
}

#[cfg(test)]
mod tests {
    use super::*;
    const LABEL: &str = "dapp-tab-network-test";
    const EVM: &str = "0x1111111111111111111111111111111111111111";
    const SOL: &str = "11111111111111111111111111111111";

    fn fixture() -> DappBridgeState {
        let state = DappBridgeState::default();
        state.paused.store(false, Ordering::Release);
        *state.active_tab_label.lock().unwrap() = Some(LABEL.into());
        let contexts = vec![
            NetworkContext {
                wallet_family: "solana".into(),
                wallet_public_key: SOL.into(),
                network: "mainnet".into(),
                rpc_url: None,
            },
            NetworkContext {
                wallet_family: "evm".into(),
                wallet_public_key: EVM.into(),
                network: "eip155:97".into(),
                rpc_url: Some("https://rpc.example.invalid".into()),
            },
        ];
        state.sessions.lock().unwrap().insert(
            LABEL.into(),
            DappSession {
                app_id: "web:example.invalid".into(),
                app_name: "Test".into(),
                url: "https://example.invalid".into(),
                wallet_family: "solana".into(),
                wallet_public_key: SOL.into(),
                network: "mainnet".into(),
                opened_at_ms: now_ms(),
                evm_rpc: None,
                available_networks: contexts,
            },
        );
        state
    }

    #[test]
    fn discovery_does_not_switch_but_explicit_switch_uses_evm_address_and_rpc() {
        let state = fixture();
        assert_eq!(provider_network(&state, LABEL, "evm").unwrap(), "eip155:97");
        assert_eq!(state.sessions.lock().unwrap()[LABEL].wallet_public_key, SOL);
        let selected = switch_network(&state, LABEL, "eip155:97").unwrap();
        assert_eq!(selected.wallet_family, "evm");
        assert_eq!(selected.wallet_public_key, EVM);
        let sessions = state.sessions.lock().unwrap();
        let session = &sessions[LABEL];
        assert!(session.evm_rpc.is_some());
        assert!(validate_dapp_provider_context(session, Some("solana"), Some("mainnet")).is_err());
        assert!(validate_dapp_provider_context(session, Some("evm"), Some("eip155:97")).is_ok());
        drop(sessions);
        assert_eq!(
            switch_network(&state, LABEL, "mainnet")
                .unwrap()
                .wallet_public_key,
            SOL
        );
        assert!(state.sessions.lock().unwrap()[LABEL].evm_rpc.is_none());
    }

    #[test]
    fn unknown_hidden_locked_and_expired_switches_do_not_mutate_session() {
        let state = fixture();
        assert_eq!(
            switch_network(&state, LABEL, "eip155:99999")
                .unwrap_err()
                .code,
            4902
        );
        *state.active_tab_label.lock().unwrap() = None;
        assert_eq!(
            switch_network(&state, LABEL, "eip155:97").unwrap_err().code,
            4100
        );
        *state.active_tab_label.lock().unwrap() = Some(LABEL.into());
        state.paused.store(true, Ordering::Release);
        assert_eq!(
            switch_network(&state, LABEL, "eip155:97").unwrap_err().code,
            4100
        );
        state.paused.store(false, Ordering::Release);
        state
            .sessions
            .lock()
            .unwrap()
            .get_mut(LABEL)
            .unwrap()
            .opened_at_ms = 0;
        assert_eq!(
            switch_network(&state, LABEL, "eip155:97").unwrap_err().code,
            4100
        );
        assert_eq!(state.sessions.lock().unwrap()[LABEL].wallet_public_key, SOL);
    }

    #[test]
    fn pending_connection_blocks_chain_change_until_resolved() {
        let state = fixture();
        state.connect_requests.lock().unwrap().insert(
            "pending".into(),
            DappPendingConnectRequest {
                webview_label: Some(LABEL.into()),
                result: None,
                event: DappConnectRequestEvent {
                    request_id: "pending".into(),
                    app_id: "test".into(),
                    app_name: "Test".into(),
                    app_url: "https://example.invalid".into(),
                    wallet_family: "solana".into(),
                    wallet_public_key: Some(SOL.into()),
                    network: "mainnet".into(),
                    callback_url: None,
                    created_at_ms: now_ms(),
                },
            },
        );
        assert_eq!(
            switch_network(&state, LABEL, "eip155:97").unwrap_err().code,
            -32002
        );
        assert_eq!(state.sessions.lock().unwrap()[LABEL].wallet_public_key, SOL);
        state.connect_requests.lock().unwrap().clear();
        assert!(switch_network(&state, LABEL, "eip155:97").is_ok());
    }

    #[test]
    fn pending_and_claimed_signature_block_chain_changes() {
        let state = fixture();
        state.requests.lock().unwrap().insert(
            "sign".into(),
            DappPendingRequest {
                webview_label: LABEL.into(),
                result: None,
                claimed: false,
                event: DappSignRequestEvent {
                    request_id: "sign".into(),
                    app_id: "test".into(),
                    app_name: "Test".into(),
                    app_url: "https://example.invalid".into(),
                    request_purpose: None,
                    method: "signMessage".into(),
                    wallet_family: "solana".into(),
                    wallet_public_key: SOL.into(),
                    network: "mainnet".into(),
                    transaction_base64: String::new(),
                    transaction_format: "message".into(),
                    message_base64: Some("aGk=".into()),
                    payload_json: None,
                    callback_url: None,
                    known_programs: vec![],
                    created_at_ms: now_ms(),
                },
            },
        );
        assert_eq!(
            switch_network(&state, LABEL, "eip155:97").unwrap_err().code,
            -32002
        );
        {
            let mut requests = state.requests.lock().unwrap();
            let pending = requests.get_mut("sign").unwrap();
            pending.claimed = true;
            pending.event.created_at_ms = 0;
        }
        assert_eq!(
            switch_network(&state, LABEL, "eip155:97").unwrap_err().code,
            -32002
        );
    }

    #[test]
    fn configured_contexts_validate_family_address_and_endpoint() {
        let state = fixture();
        let mut contexts = state.sessions.lock().unwrap()[LABEL]
            .available_networks
            .clone();
        assert!(validate_contexts(&contexts).is_ok());
        contexts[1].wallet_public_key = SOL.into();
        assert!(validate_contexts(&contexts).is_err());
        contexts[1].wallet_public_key = EVM.into();
        contexts[1].rpc_url = Some("http://remote.invalid".into());
        assert!(validate_contexts(&contexts).is_err());
    }
}
