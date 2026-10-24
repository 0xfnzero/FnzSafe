//! Loader-v3 ProgramData closure. The Program account's rent is not refunded.
use super::*;

const PREVIEW_TTL: Duration = Duration::from_secs(300);
const MAX_PREVIEWS: usize = 128;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DiscoverRequest {
    wallet_id: String,
    network: String,
    expected_genesis_hash: String,
}

#[derive(Serialize)]
pub(super) struct DiscoveredProgram {
    program_id: String,
    programdata_address: String,
    refundable_lamports: String,
}

#[derive(Serialize)]
pub(super) struct DiscoverResponse {
    wallet_id: String,
    authority: String,
    network: String,
    genesis_hash: String,
    programs: Vec<DiscoveredProgram>,
}

fn discovery_config(
    authority: Option<&Pubkey>,
) -> solana_rpc_client_api::config::RpcProgramAccountsConfig {
    use solana_rpc_client_api::filter::{Memcmp, RpcFilterType};
    let filters = match authority {
        // Loader-v3 ProgramData: enum u32, slot u64, Some tag u8, authority 32 bytes.
        Some(key) => vec![
            RpcFilterType::Memcmp(Memcmp::new_base58_encoded(0, &3u32.to_le_bytes())),
            RpcFilterType::Memcmp(Memcmp::new_base58_encoded(12, &[1])),
            RpcFilterType::Memcmp(Memcmp::new_base58_encoded(13, &key.to_bytes())),
        ],
        None => vec![
            RpcFilterType::DataSize(UpgradeableLoaderState::size_of_program() as u64),
            RpcFilterType::Memcmp(Memcmp::new_base58_encoded(0, &2u32.to_le_bytes())),
        ],
    };
    solana_rpc_client_api::config::RpcProgramAccountsConfig {
        filters: Some(filters),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            data_slice: Some(solana_account_decoder_client_types::UiDataSliceConfig {
                offset: 0,
                length: if authority.is_some() {
                    UpgradeableLoaderState::size_of_programdata_metadata()
                } else {
                    UpgradeableLoaderState::size_of_program()
                },
            }),
            commitment: Some(CommitmentConfig::finalized()),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn join_discovered_programs(
    authority: &Pubkey,
    data_accounts: &[(Pubkey, Account)],
    programs: &[(Pubkey, Account)],
) -> Result<Vec<DiscoveredProgram>, ApiError> {
    let data_by_address = data_accounts
        .iter()
        .map(|(key, account)| (key, account))
        .collect::<HashMap<_, _>>();
    let mut found = Vec::new();
    for (program, account) in programs {
        let address = get_program_data_address(program);
        let Some(data) = data_by_address.get(&address) else {
            continue;
        };
        // The scans may observe different finalized banks. This is candidate discovery;
        // preview always re-reads both complete accounts together before approval.
        validate_accounts(program, authority, account, data)?;
        found.push(DiscoveredProgram {
            program_id: program.to_string(),
            programdata_address: address.to_string(),
            refundable_lamports: data.lamports.to_string(),
        });
    }
    found.sort_by(|a, b| a.program_id.cmp(&b.program_id));
    Ok(found)
}

fn discover_programs(
    client: &RpcClient,
    authority: &Pubkey,
) -> Result<Vec<DiscoveredProgram>, ApiError> {
    let scan = |config| -> Result<Vec<(Pubkey, Account)>, ApiError> {
        client.get_program_ui_accounts_with_config(&UPGRADEABLE_LOADER_ID, config)
            .map_err(|e| fail(format!("链上合约扫描失败: {e}。当前 RPC 可能不支持 loader 的 getProgramAccounts 查询，请在设置中切换支持该查询的 RPC 后重试；这不代表钱包没有合约。")))?
            .into_iter().map(|(key, ui)| {
                ui.decode::<Account>().map(|account| (key, account))
                    .ok_or_else(|| fail("RPC 返回无法解码的程序账户，未发布扫描结果"))
            }).collect()
    };
    // Read only 45 bytes per ProgramData, never download deployed ELF binaries.
    let data_accounts = scan(discovery_config(Some(authority)))?;
    for (_, account) in &data_accounts {
        if account.owner != UPGRADEABLE_LOADER_ID
            || account.executable
            || loader_upgrade_authority_from_programdata(&account.data)? != *authority
        {
            return Err(fail("RPC 返回的 ProgramData 与钱包权限过滤不一致"));
        }
    }
    let programs = if data_accounts.is_empty() {
        Vec::new()
    } else {
        let program_accounts = scan(discovery_config(None))?;
        join_discovered_programs(authority, &data_accounts, &program_accounts)?
    };
    Ok(programs)
}

pub(super) async fn discover(
    Json(req): Json<DiscoverRequest>,
) -> Result<Json<DiscoverResponse>, ApiError> {
    let saved = wallet_store::find(&req.wallet_id).map_err(fail)?;
    require_solana_account(&saved.keystore_json)?;
    let authority = Pubkey::from_str(&saved.public_key).map_err(|_| fail("钱包公钥无效"))?;
    let (client, selector) = checked_client(&req.network, &req.expected_genesis_hash)?;
    let programs = discover_programs(&client, &authority)?;
    Ok(Json(DiscoverResponse {
        wallet_id: req.wallet_id,
        authority: authority.to_string(),
        network: selector.network,
        genesis_hash: req.expected_genesis_hash,
        programs,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PreviewRequest {
    wallet_id: String,
    program_id: String,
    network: String,
    expected_genesis_hash: String,
}

#[derive(Clone, Serialize)]
pub(super) struct PreviewResponse {
    preview_id: String,
    wallet_id: String,
    program_id: String,
    programdata_address: String,
    authority: String,
    recipient: String,
    network: String,
    genesis_hash: String,
    /// Decimal strings preserve lamport precision in JavaScript.
    refundable_lamports: String,
    retained_program_lamports: String,
    estimated_fee_lamports: String,
    context_slot: u64,
    expires_in_seconds: u64,
}

struct ClosePreview {
    response: PreviewResponse,
    rpc_url: String,
    snapshot_hash: String,
    created: Instant,
}

fn previews() -> &'static Mutex<HashMap<String, ClosePreview>> {
    static PREVIEWS: OnceLock<Mutex<HashMap<String, ClosePreview>>> = OnceLock::new();
    PREVIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn fail(message: impl Into<String>) -> ApiError {
    ApiError {
        message: message.into(),
    }
}

/// Validate both accounts from one bank, including the canonical ProgramData link.
fn validate_accounts(
    program_id: &Pubkey,
    authority: &Pubkey,
    program: &Account,
    data: &Account,
) -> Result<String, ApiError> {
    let address = get_program_data_address(program_id);
    if program_id == authority || address == *authority {
        return Err(fail("退款钱包不能与 Program 或 ProgramData 地址相同"));
    }
    if program.owner != UPGRADEABLE_LOADER_ID
        || data.owner != UPGRADEABLE_LOADER_ID
        || !program.executable
        || data.executable
        || program.data.len() != UpgradeableLoaderState::size_of_program()
        || data.data.len() < UpgradeableLoaderState::size_of_programdata_metadata()
        || data.lamports == 0
    {
        return Err(fail("目标不是有效的 loader-v3 Program / ProgramData"));
    }
    let state: UpgradeableLoaderState =
        bincode::deserialize(&program.data).map_err(|_| fail("Program 状态解析失败"))?;
    if !matches!(state, UpgradeableLoaderState::Program { programdata_address } if programdata_address == address)
    {
        return Err(fail("ProgramData 地址与 Program 不匹配"));
    }
    let actual = loader_upgrade_authority_from_programdata(&data.data)?;
    if actual != *authority {
        return Err(fail(format!(
            "当前 Upgrade Authority 为 {actual}，所选钱包 {authority} 无权关闭"
        )));
    }
    let bytes = bincode::serialize(&(program, data)).map_err(|_| fail("无法计算账户快照摘要"))?;
    Ok(program_deploy::sha256_hex(&bytes))
}

fn read_snapshot(
    client: &RpcClient,
    program: &Pubkey,
    authority: &Pubkey,
) -> Result<(String, u64, u64, u64), ApiError> {
    let response = client
        .get_multiple_accounts_with_commitment(
            &[*program, get_program_data_address(program)],
            CommitmentConfig::finalized(),
        )
        .map_err(|e| fail(format!("读取 Program 账户失败: {e}")))?;
    let mut accounts = response.value.into_iter();
    let program_account = accounts
        .next()
        .flatten()
        .ok_or_else(|| fail("Program 不存在"))?;
    let data = accounts
        .next()
        .flatten()
        .ok_or_else(|| fail("ProgramData 不存在，程序可能已关闭"))?;
    let hash = validate_accounts(program, authority, &program_account, &data)?;
    Ok((
        hash,
        data.lamports,
        program_account.lamports,
        response.context.slot,
    ))
}

fn close_instruction(program: &Pubkey, authority: &Pubkey) -> Instruction {
    loader_v3_instruction::close_any(
        &get_program_data_address(program),
        authority,
        Some(authority),
        Some(program),
    )
}

fn checked_client(
    network: &str,
    expected_genesis: &str,
) -> Result<(RpcClient, RpcSelector), ApiError> {
    let expected = solana_sdk::hash::Hash::from_str(expected_genesis)
        .map_err(|_| fail("无效的预期 genesis hash"))?;
    let selector = rpc_selector(Some(network))?;
    let client = RpcClient::new_with_timeout_and_commitment(
        selector.url.clone(),
        Duration::from_secs(PROGRAM_DEPLOY_RPC_TIMEOUT_SECS),
        CommitmentConfig::finalized(),
    );
    let actual = client
        .get_genesis_hash()
        .map_err(|e| fail(format!("读取集群身份失败: {e}")))?;
    if actual != expected {
        return Err(fail("RPC genesis hash 与预期不一致，已拒绝关闭"));
    }
    Ok((client, selector))
}

pub(super) async fn preview(
    Json(req): Json<PreviewRequest>,
) -> Result<Json<PreviewResponse>, ApiError> {
    let program = Pubkey::from_str(req.program_id.trim()).map_err(|_| fail("无效的 Program ID"))?;
    let saved = wallet_store::find(&req.wallet_id).map_err(fail)?;
    require_solana_account(&saved.keystore_json)?;
    let authority = Pubkey::from_str(&saved.public_key).map_err(|_| fail("钱包公钥无效"))?;
    let (client, selector) = checked_client(&req.network, &req.expected_genesis_hash)?;
    let (snapshot_hash, refund, retained, context_slot) =
        read_snapshot(&client, &program, &authority)?;
    let blockhash = client
        .get_latest_blockhash()
        .map_err(|e| fail(format!("读取 blockhash 失败: {e}")))?;
    let fee = estimate_instruction_fee(
        &client,
        &[close_instruction(&program, &authority)],
        &authority,
        &blockhash,
        "关闭 Program",
    )?;
    let response = PreviewResponse {
        preview_id: uuid::Uuid::new_v4().to_string(),
        wallet_id: req.wallet_id,
        program_id: program.to_string(),
        programdata_address: get_program_data_address(&program).to_string(),
        authority: authority.to_string(),
        recipient: authority.to_string(),
        network: selector.network,
        genesis_hash: req.expected_genesis_hash,
        refundable_lamports: refund.to_string(),
        retained_program_lamports: retained.to_string(),
        estimated_fee_lamports: fee.to_string(),
        context_slot,
        expires_in_seconds: PREVIEW_TTL.as_secs(),
    };
    let mut cache = previews().lock().map_err(|_| fail("关闭预览锁不可用"))?;
    cache.retain(|_, p| p.created.elapsed() < PREVIEW_TTL);
    if cache.len() >= MAX_PREVIEWS {
        return Err(fail("关闭预览数量已满，请稍后重试"));
    }
    cache.insert(
        response.preview_id.clone(),
        ClosePreview {
            response: response.clone(),
            rpc_url: selector.url,
            snapshot_hash,
            created: Instant::now(),
        },
    );
    Ok(Json(response))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubmitRequest {
    preview_id: String,
    wallet_id: String,
    confirmation_program_id: String,
    acknowledge_permanent_close: bool,
    #[serde(default)]
    password: Option<String>,
}

impl Drop for SubmitRequest {
    fn drop(&mut self) {
        if let Some(password) = self.password.as_mut() {
            password.zeroize();
        }
    }
}

fn consume_preview(id: &str) -> Result<ClosePreview, ApiError> {
    previews()
        .lock()
        .map_err(|_| fail("关闭预览锁不可用"))?
        .remove(id)
        .ok_or_else(|| fail("关闭预览不存在或已使用，请先核对交易状态"))
}

fn validate_confirmation(req: &SubmitRequest, preview: &ClosePreview) -> Result<(), ApiError> {
    if preview.created.elapsed() >= PREVIEW_TTL {
        return Err(fail("关闭预览已过期，请重新查询"));
    }
    if !req.acknowledge_permanent_close
        || req.confirmation_program_id != preview.response.program_id
        || req.wallet_id != preview.response.wallet_id
    {
        return Err(fail(
            "必须确认永久关闭，并输入预览中的完整 Program ID；钱包必须一致",
        ));
    }
    Ok(())
}

#[derive(Serialize)]
pub(super) struct CloseResponse {
    signature: String,
    finalized_slot: u64,
    program_id: String,
    recipient: String,
    expected_refund_lamports: String,
    actual_refunded_lamports: Option<String>,
    fee_lamports: Option<String>,
    readback_verified: bool,
    status: String,
}

pub(super) async fn submit(
    Json(mut req): Json<SubmitRequest>,
) -> Result<Json<CloseResponse>, ApiError> {
    // Share the deploy/upgrade guard so this process cannot close during an upgrade.
    let _guard = PROGRAM_DEPLOY_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .try_lock()
        .map_err(|_| fail(PROGRAM_DEPLOY_BUSY_MESSAGE))?;
    // Consume once, even on errors. No endpoint or frontend retry can reuse this intent.
    let preview = consume_preview(&req.preview_id)?;
    validate_confirmation(&req, &preview)?;
    let p = &preview.response;
    let (client, selector) = checked_client(&p.network, &p.genesis_hash)?;
    if selector.url != preview.rpc_url {
        return Err(fail("RPC 配置已改变，请重新查询"));
    }
    let auth = WalletAuthRequest {
        wallet_id: Some(req.wallet_id.clone()),
        password: req.password.take(),
        private_key: None,
        secret_key: None,
        keystore_json: None,
        encrypted_key: None,
    };
    let payer = auth.keypair()?;
    if payer.pubkey().to_string() != p.authority {
        return Err(fail("签名钱包与预览权限不一致"));
    }
    let program = Pubkey::from_str(&p.program_id).map_err(|_| fail("预览 Program ID 无效"))?;
    let (hash, _, _, _) = read_snapshot(&client, &program, &payer.pubkey())?;
    if hash != preview.snapshot_hash {
        return Err(fail("链上 Program 状态或余额已变化，请重新查询并确认"));
    }
    let instruction = close_instruction(&program, &payer.pubkey());
    let blockhash = client
        .get_latest_blockhash()
        .map_err(|e| fail(format!("读取 blockhash 失败: {e}")))?;
    let fee = estimate_instruction_fee(
        &client,
        std::slice::from_ref(&instruction),
        &payer.pubkey(),
        &blockhash,
        "关闭 Program",
    )?;
    let approved_fee = p
        .estimated_fee_lamports
        .parse::<u64>()
        .map_err(|_| fail("预览费用无效"))?;
    if fee > approved_fee {
        return Err(fail("交易费已增加，请重新查询并确认"));
    }
    let balance = client
        .get_balance(&payer.pubkey())
        .map_err(|e| fail(format!("读取钱包余额失败: {e}")))?;
    if balance < fee {
        return Err(fail(
            "钱包 SOL 不足以预付交易费，不能使用尚未退回的租金付款",
        ));
    }
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[&payer],
        blockhash,
    );
    simulate_program_deployment_transaction(&client, &transaction, "关闭 Program")?;
    let signature = transaction.signatures[0].to_string();
    let (_, slot) = submit_signed_transaction_once(
        &client,
        &transaction,
        "关闭 Program",
        &format!("program={program}；recipient={}", payer.pubkey()),
        CommitmentConfig::finalized(),
        "finalized",
        Duration::from_secs(90),
    )
    .await?;
    // A closure leaves the Program account in place; only ProgramData is drained.
    let readback = client
        .get_multiple_ui_accounts_with_config(
            &[get_program_data_address(&program)],
            RpcAccountInfoConfig {
                commitment: Some(CommitmentConfig::finalized()),
                min_context_slot: Some(slot),
                ..Default::default()
            },
        )
        .map_err(|e| {
            fail(format!(
                "交易 {signature} 已 finalized，但关闭回读失败: {e}；请核对签名，不要重试"
            ))
        })?;
    let verified = readback.value.len() == 1
        && readback
            .value
            .into_iter()
            .next()
            .flatten()
            .is_none_or(|account| account.lamports == 0);
    // Receipt balances establish the actual refund; a later account balance cannot.
    let refund = client
        .get_transaction_with_config(
            &transaction.signatures[0],
            RpcTransactionConfig {
                encoding: Some(UiTransactionEncoding::JsonParsed),
                commitment: Some(CommitmentConfig::finalized()),
                max_supported_transaction_version: Some(0),
            },
        )
        .ok()
        .and_then(|tx| {
            if tx.slot != slot {
                return None;
            }
            let (accounts, _) = parsed_message_accounts_and_programs(&tx.transaction.transaction);
            let meta = tx.transaction.meta?;
            if meta.err.is_some() {
                return None;
            }
            verify_refund_balances(
                &accounts,
                &meta.pre_balances,
                &meta.post_balances,
                meta.fee,
                &program,
                &payer.pubkey(),
            )
            .map(|amount| (amount, meta.fee))
        });
    Ok(Json(CloseResponse {
        signature,
        finalized_slot: slot,
        program_id: p.program_id.clone(),
        recipient: p.recipient.clone(),
        expected_refund_lamports: p.refundable_lamports.clone(),
        actual_refunded_lamports: refund.map(|(amount, _)| amount.to_string()),
        fee_lamports: refund.map(|(_, fee)| fee.to_string()),
        readback_verified: verified,
        status: if verified {
            "finalized"
        } else {
            "finalized_readback_mismatch"
        }
        .to_string(),
    }))
}

fn verify_refund_balances(
    accounts: &[String],
    pre: &[u64],
    post: &[u64],
    fee: u64,
    program: &Pubkey,
    recipient: &Pubkey,
) -> Option<u64> {
    if accounts.len() != pre.len() || pre.len() != post.len() {
        return None;
    }
    let index = |key: &Pubkey| accounts.iter().position(|a| a == &key.to_string());
    let data = index(&get_program_data_address(program))?;
    let program = index(program)?;
    let recipient = index(recipient)?;
    if pre[data] == 0 || post[data] != 0 || pre[program] != post[program] {
        return None;
    }
    let net = post[recipient] as i128 - pre[recipient] as i128;
    if net != pre[data] as i128 - fee as i128 {
        return None;
    }
    Some(pre[data])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Pubkey, Pubkey, Account, Account) {
        let program = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let program_state = UpgradeableLoaderState::Program {
            programdata_address: get_program_data_address(&program),
        };
        let data_state = UpgradeableLoaderState::ProgramData {
            slot: 42,
            upgrade_authority_address: Some(authority),
        };
        let p = Account {
            lamports: 1_141_440,
            data: bincode::serialize(&program_state).unwrap(),
            owner: UPGRADEABLE_LOADER_ID,
            executable: true,
            rent_epoch: 0,
        };
        let mut bytes = bincode::serialize(&data_state).unwrap();
        bytes.resize(UpgradeableLoaderState::size_of_programdata(100), 9);
        let d = Account {
            lamports: 2_000_000,
            data: bytes,
            owner: UPGRADEABLE_LOADER_ID,
            executable: false,
            rent_epoch: 0,
        };
        (program, authority, p, d)
    }

    #[test]
    #[ignore = "explicit read-only integration check against public devnet; no keys or transactions"]
    fn public_devnet_discovery_read_only() {
        let client = RpcClient::new_with_timeout_and_commitment(
            "https://api.devnet.solana.com".to_string(),
            Duration::from_secs(30),
            CommitmentConfig::finalized(),
        );
        // This public address is a query fixture only. It cannot authorize closure.
        let found = discover_programs(&client, &Pubkey::default()).unwrap();
        println!(
            "Public devnet loader-v3 discovery matched {} programs using metadata only",
            found.len()
        );
        for item in found {
            let program = Pubkey::from_str(&item.program_id).unwrap();
            assert_eq!(
                get_program_data_address(&program).to_string(),
                item.programdata_address
            );
        }
    }

    #[test]
    fn discovery_filters_match_loader_metadata_without_program_source() {
        use solana_rpc_client_api::filter::RpcFilterType;
        let (_, authority, p, d) = fixture();
        let matches = |config: solana_rpc_client_api::config::RpcProgramAccountsConfig,
                       bytes: &[u8]| {
            config.filters.unwrap().iter().all(|filter| match filter {
                RpcFilterType::DataSize(len) => bytes.len() as u64 == *len,
                RpcFilterType::Memcmp(memcmp) => memcmp.bytes_match(bytes),
                _ => false,
            })
        };
        assert!(matches(discovery_config(Some(&authority)), &d.data));
        assert!(!matches(
            discovery_config(Some(&Pubkey::new_unique())),
            &d.data
        ));
        assert!(!matches(discovery_config(Some(&authority)), &p.data));
        assert!(matches(discovery_config(None), &p.data));
        assert!(!matches(discovery_config(None), &d.data));
        assert_eq!(
            discovery_config(Some(&authority))
                .account_config
                .data_slice
                .unwrap()
                .length,
            45
        );
        assert_eq!(
            discovery_config(None)
                .account_config
                .data_slice
                .unwrap()
                .length,
            36
        );
        assert_eq!(
            discovery_config(None).account_config.commitment,
            Some(CommitmentConfig::finalized())
        );
    }

    #[test]
    fn discovery_finds_canonical_program_from_authority_metadata_alone() {
        let (program, authority, p, mut d) = fixture();
        d.data
            .truncate(UpgradeableLoaderState::size_of_programdata_metadata());
        let address = get_program_data_address(&program);
        let data_accounts = vec![(address, d.clone())];
        let program_accounts = vec![(program, p.clone())];
        let found =
            join_discovered_programs(&authority, &data_accounts, &program_accounts).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].program_id, program.to_string());
        assert_eq!(found[0].refundable_lamports, d.lamports.to_string());
        assert!(join_discovered_programs(&authority, &[], &program_accounts)
            .unwrap()
            .is_empty());
        assert!(
            join_discovered_programs(&Pubkey::new_unique(), &data_accounts, &program_accounts)
                .is_err()
        );
        let mut bad = p.clone();
        bad.data = bincode::serialize(&UpgradeableLoaderState::Program {
            programdata_address: Pubkey::new_unique(),
        })
        .unwrap();
        assert!(join_discovered_programs(&authority, &data_accounts, &[(program, bad)]).is_err());
    }

    #[test]
    fn accepts_valid_program_and_detects_binary_or_balance_changes() {
        let (id, authority, p, mut d) = fixture();
        let hash = validate_accounts(&id, &authority, &p, &d).unwrap();
        *d.data.last_mut().unwrap() ^= 1;
        assert_ne!(hash, validate_accounts(&id, &authority, &p, &d).unwrap());
        *d.data.last_mut().unwrap() ^= 1;
        d.lamports += 1;
        assert_ne!(hash, validate_accounts(&id, &authority, &p, &d).unwrap());
    }

    #[test]
    fn rejects_wrong_authority_immutable_and_wrong_programdata_link() {
        let (id, authority, mut p, mut d) = fixture();
        assert!(validate_accounts(&id, &Pubkey::new_unique(), &p, &d).is_err());
        p.data = bincode::serialize(&UpgradeableLoaderState::Program {
            programdata_address: Pubkey::new_unique(),
        })
        .unwrap();
        assert!(validate_accounts(&id, &authority, &p, &d).is_err());
        let (_, _, _, original) = fixture();
        p.data = bincode::serialize(&UpgradeableLoaderState::Program {
            programdata_address: get_program_data_address(&id),
        })
        .unwrap();
        let mut immutable = bincode::serialize(&UpgradeableLoaderState::ProgramData {
            slot: 42,
            upgrade_authority_address: None,
        })
        .unwrap();
        immutable.resize(original.data.len(), 0);
        d.data = immutable;
        assert!(validate_accounts(&id, &authority, &p, &d).is_err());
    }

    #[test]
    fn rejects_invalid_owners_flags_lengths_empty_and_wrong_state() {
        let (id, authority, p, d) = fixture();
        for index in 0..9 {
            let mut p = p.clone();
            let mut d = d.clone();
            match index {
                0 => p.owner = Pubkey::new_unique(),
                1 => d.owner = Pubkey::new_unique(),
                2 => p.executable = false,
                3 => d.executable = true,
                4 => p.data.truncate(3),
                5 => d.data.truncate(44),
                6 => d.lamports = 0,
                7 => d.data[0] = 255,
                8 => p.data[0] = 255,
                _ => unreachable!(),
            }
            assert!(
                validate_accounts(&id, &authority, &p, &d).is_err(),
                "case {index}"
            );
        }
    }

    #[test]
    fn close_targets_only_programdata_with_authority_signature_and_program_reference() {
        let program = Pubkey::new_unique();
        let payer = Keypair::new();
        let ix = close_instruction(&program, &payer.pubkey());
        assert_eq!(ix.program_id, UPGRADEABLE_LOADER_ID);
        assert_eq!(
            ix.accounts,
            vec![
                AccountMeta::new(get_program_data_address(&program), false),
                AccountMeta::new(payer.pubkey(), false),
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new(program, false),
            ]
        );
        let decoded: solana_loader_v3_interface::instruction::UpgradeableLoaderInstruction =
            bincode::deserialize(&ix.data).unwrap();
        assert!(matches!(
            decoded,
            solana_loader_v3_interface::instruction::UpgradeableLoaderInstruction::Close
        ));
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[&payer],
            solana_sdk::hash::Hash::new_unique(),
        );
        tx.verify().unwrap();
        assert_eq!(tx.message.header.num_required_signatures, 1);
    }

    fn preview_fixture() -> ClosePreview {
        ClosePreview {
            response: PreviewResponse {
                preview_id: "preview".into(),
                wallet_id: "wallet".into(),
                program_id: "program".into(),
                programdata_address: "data".into(),
                authority: "authority".into(),
                recipient: "authority".into(),
                network: "devnet".into(),
                genesis_hash: "genesis".into(),
                refundable_lamports: "2000000".into(),
                retained_program_lamports: "1141440".into(),
                estimated_fee_lamports: "5000".into(),
                context_slot: 42,
                expires_in_seconds: 300,
            },
            rpc_url: "http://localhost".into(),
            snapshot_hash: "hash".into(),
            created: Instant::now(),
        }
    }

    #[test]
    fn confirmation_requires_same_wallet_full_id_acknowledgment_and_fresh_preview() {
        let mut p = preview_fixture();
        let mut req = SubmitRequest {
            preview_id: "preview".into(),
            wallet_id: "wallet".into(),
            confirmation_program_id: "program".into(),
            acknowledge_permanent_close: true,
            password: None,
        };
        assert!(validate_confirmation(&req, &p).is_ok());
        req.acknowledge_permanent_close = false;
        assert!(validate_confirmation(&req, &p).is_err());
        req.acknowledge_permanent_close = true;
        req.confirmation_program_id = "different".into();
        assert!(validate_confirmation(&req, &p).is_err());
        req.confirmation_program_id = "program".into();
        req.wallet_id = "other-wallet".into();
        assert!(validate_confirmation(&req, &p).is_err());
        req.wallet_id = "wallet".into();
        p.created = Instant::now() - PREVIEW_TTL;
        assert!(validate_confirmation(&req, &p).is_err());
    }

    #[test]
    fn receipt_refund_requires_programdata_drain_and_exact_recipient_net_after_fee() {
        let program = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let accounts = vec![
            recipient.to_string(),
            get_program_data_address(&program).to_string(),
            program.to_string(),
        ];
        let pre = vec![100_000, 2_000_000, 1_141_440];
        let post = vec![2_095_000, 0, 1_141_440];
        assert_eq!(
            verify_refund_balances(&accounts, &pre, &post, 5_000, &program, &recipient),
            Some(2_000_000)
        );
        for (index, value) in [(0, 2_095_001), (1, 1), (2, 0)] {
            let mut bad = post.clone();
            bad[index] = value;
            assert_eq!(
                verify_refund_balances(&accounts, &pre, &bad, 5_000, &program, &recipient),
                None
            );
        }
        assert_eq!(
            verify_refund_balances(&accounts, &pre[..2], &post, 5_000, &program, &recipient),
            None
        );
        assert_eq!(
            verify_refund_balances(
                &accounts,
                &pre,
                &post,
                5_000,
                &program,
                &Pubkey::new_unique()
            ),
            None
        );
    }

    #[test]
    fn preview_intent_can_be_consumed_only_once() {
        let id = uuid::Uuid::new_v4().to_string();
        previews()
            .lock()
            .unwrap()
            .insert(id.clone(), preview_fixture());
        assert!(consume_preview(&id).is_ok());
        assert!(consume_preview(&id).is_err());
    }

    #[test]
    fn requests_reject_recipient_override_direct_private_key_and_unknown_fields() {
        let value = json!({ "preview_id": "preview", "wallet_id": "wallet",
            "confirmation_program_id": "program", "acknowledge_permanent_close": true });
        assert!(serde_json::from_value::<SubmitRequest>(value.clone()).is_ok());
        for field in ["recipient", "private_key", "network", "program_id"] {
            let mut bad = value.clone();
            bad[field] = json!("override");
            assert!(serde_json::from_value::<SubmitRequest>(bad).is_err());
        }
    }
}
