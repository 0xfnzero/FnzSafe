import { nextWalletName } from './wallet-names';
import { encryptSecretBackup } from './secret-backup';
import { validatePasskeyConfig } from './passkey';
import { registerPasskeyWindows } from './passkey-broker';
import { ensureDeviceWallet, hasDeviceWallet, loadDeviceWallet, saveDeviceWallet, removeDeviceWallet } from './device-vault';
import { displaySignedMessage } from './message-preview';
import { tokenAsset, transferRequest, prepareTransaction, signPrepared, sendPrepared, type PreparedTransaction } from './evm-transfers';
import { safeAccount, parseProposal, validateProposal, propose, signProposal, mergeProposals, prepareSafeCreation, prepareSafeExecution, safeReceipt, type SafeProposal } from './safe';
import { discoverSafes } from './safe-discovery';
import { parseSafeImport, safeImportTarget } from './safe-import';
import { safeBatchPayload } from '../../desktop/src/lib/safeBatch';
import { nextSafeNonce } from '../../desktop/src/lib/safeMultisig';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  type Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getBytes,
  parseUnits,
  TransactionRequest,
  Wallet,
} from 'ethers';
import { configuredChain, normalizeRpcOverrides, normalizeRpcUrl, validateRpc, evmProvider, solanaConnection, type RpcOverrides } from './rpc';
import { chains, evmChain, isArcChain, requestedBuiltinChain } from './chains';
import type {
  ChainInfo,
  ApprovalView,
  EncryptedVault,
  ProviderRequest,
  VaultAccount,
  VaultPayload,
} from './types';
import { importWallet, type WalletImport } from './import-wallet';
import { createInitialVault, decryptVaultWithMigration, encryptVault, mergeVaultAccounts, walletGroups, groupedVault } from './vault';
import {
  attachUsdPrices,
  discoverEvmTokens,
  nativeAsset,
  visiblePortfolioAssets,
} from './portfolio';
import type { PortfolioAsset, PortfolioSnapshot } from './types';
import { sessionAuthorization } from './memory-vault';
import {
  grantOriginPermission,
  hasOriginPermission,
  normalizePermissionStore,
  type OriginPermissionStore,
} from './permissions';
import {
  inspectTypedData,
  normalizeAndInspectTransaction,
  prepareArcFees,
} from './transaction-security';
import {
  ApprovalRequestGuard,
  safeProviderOrigin,
  validateProviderRequest,
} from './provider-security';
import { inspectSolanaTransaction } from './solana-security';
import {
  decryptSessionVault,
  destroyVaultSession,
  protectVaultInMemory,
  type UnlockedVaultSession,
} from './memory-vault';

const LOCK_ALARM = 'fnzsafe-lock';
const AUTO_LOCK_MINUTES = [5, 15, 30, 60];
const VAULT_KEY = 'encryptedVault';
const PERMISSIONS_KEY = 'originPermissions';
const SETTINGS_KEY = 'walletSettings';
const PORTFOLIO_CACHE_MS = 30_000;
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

interface WalletSettings {
  autoLockMinutes?: number;
  activeAccountId?: string;
  evmChainId: number;
  solanaCluster: 'mainnet-beta' | 'devnet';
  enhancedAssetDetection: boolean;
  rpcOverrides?: RpcOverrides;
}

interface PendingRequest {
  request: ProviderRequest;
  origin: string;
  port: chrome.runtime.Port;
  windowId?: number;
  expiresAt: number;
  context?: string;
  evmTransaction?: PreparedTransaction;
  timeoutId?: ReturnType<typeof setTimeout>;
}

let contextRevision = 0;
let deviceMode = false;
void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
let unlockedVault: UnlockedVaultSession | null = null;
let sessionDeadline = 0;
let sessionKeepAlive: ReturnType<typeof setInterval> | undefined;
const pending = new Map<string, PendingRequest>();
const approvalGuard = new ApprovalRequestGuard();
const portfolioCache = new Map<string, { snapshot: PortfolioSnapshot; expiresAt: number }>();

interface Review { id: string; context: string; chain: ChainInfo; expiresAt: number; kind: string; transaction?: PreparedTransaction; proposal?: SafeProposal; safeAddress?: string; details: Record<string, unknown> }
const reviews = new Map<string, Review>();
function saveReview(input: Omit<Review, 'id' | 'expiresAt'>) {
  for (const [id, review] of reviews) if (review.expiresAt < Date.now()) reviews.delete(id);
  if (reviews.size >= 20) throw new Error('Too many pending reviews');
  const review = { ...input, id: crypto.randomUUID(), expiresAt: Date.now() + 120000 };
  reviews.set(review.id, review);
  return { id: review.id, kind: review.kind, network: review.chain.name, chainId: review.chain.chainId, transaction: review.transaction, details: review.details };
}
interface ActivityRecord { hash: string; from: string; chainKey: string; kind: string; status: string; createdAt: number; safeAddress?: string; safeTxHash?: string }
async function activity(): Promise<ActivityRecord[]> { const saved = await chrome.storage.local.get('walletActivity'); return Array.isArray(saved.walletActivity) ? saved.walletActivity : []; }
async function recordActivity(input: Omit<ActivityRecord, 'status' | 'createdAt'>) {
  portfolioCache.clear();
  const records = await activity();
  await chrome.storage.local.set({ walletActivity: [{ ...input, status: 'pending', createdAt: Date.now() }, ...records.filter(r => r.hash !== input.hash)].slice(0, 200) });
}
interface SafeWorkspace { safes: Array<{ chainId: number; address: string; owners?: string[] }>; proposals: SafeProposal[] }
async function safeWorkspace(): Promise<SafeWorkspace> {
  const saved = (await chrome.storage.local.get('safeWorkspace')).safeWorkspace;
  return saved && Array.isArray(saved.safes) && Array.isArray(saved.proposals) ? saved : { safes: [], proposals: [] };
}
let safeWrites: Promise<unknown> = Promise.resolve();
function updateSafeWorkspace(update: (workspace: SafeWorkspace) => Promise<void> | void) {
  const pending = safeWrites.then(async () => {
    const workspace = await safeWorkspace();
    await update(workspace);
    await chrome.storage.local.set({ safeWorkspace: workspace });
  });
  safeWrites = pending.catch(() => {});
  return pending;
}
async function rememberSafe(chainId: number, address: string, owners?: string[]) {
  await updateSafeWorkspace(workspace => {
    const existing = workspace.safes.find(s => s.chainId === chainId && s.address.toLowerCase() === address.toLowerCase());
    if (existing) { if (owners) existing.owners = owners; }
    else workspace.safes.push({ chainId, address, ...(owners ? {owners} : {}) });
    if (workspace.safes.length > 100) throw new Error('Maximum 100 saved Safes');
  });
}
async function saveSafeProposal(proposal: SafeProposal) {
  await updateSafeWorkspace(workspace => {
    workspace.proposals = [proposal, ...workspace.proposals.filter(p => p.chain_id !== proposal.chain_id || p.safe_tx_hash.toLowerCase() !== proposal.safe_tx_hash.toLowerCase())].slice(0, 200);
  });
}
function tokenStorageKey(chain: string, address: string) { return `watchedTokens:${chain}:${address.toLowerCase()}`; }

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /https?:\/\//i.test(message) ? 'RPC request failed. Check the configured endpoint and network.' : message.slice(0, 1000);
}

async function encryptedVault(): Promise<EncryptedVault | null> {
  const result = await chrome.storage.local.get(VAULT_KEY);
  return (result[VAULT_KEY] as EncryptedVault | undefined) ?? null;
}

async function settings(): Promise<WalletSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizedSettings((result[SETTINGS_KEY] as WalletSettings | undefined) ?? {
    evmChainId: 1,
    solanaCluster: 'mainnet-beta',
    enhancedAssetDetection: true,
  });
}

function normalizedSettings(value: WalletSettings): WalletSettings {
  const evmChainId = Number.isSafeInteger(value?.evmChainId) &&
    chains.some((chain) => chain.family === 'evm' && chain.chainId === value.evmChainId)
    ? value.evmChainId
    : 1;
  const solanaCluster = value?.solanaCluster === 'devnet' ? 'devnet' : 'mainnet-beta';
  const activeAccountId = typeof value?.activeAccountId === 'string' &&
    value.activeAccountId.length > 0 && value.activeAccountId.length <= 128
    ? value.activeAccountId
    : undefined;
  return {
    activeAccountId,
    autoLockMinutes: AUTO_LOCK_MINUTES.includes(value?.autoLockMinutes ?? 0) ? value.autoLockMinutes : 15,
    evmChainId,
    solanaCluster,
    enhancedAssetDetection: value?.enhancedAssetDetection !== false,
    rpcOverrides: normalizeRpcOverrides(value?.rpcOverrides),
  };
}

async function updateSettings(patch: Partial<WalletSettings>): Promise<WalletSettings> {
  const next = normalizedSettings({ ...(await settings()), ...patch });
  contextRevision++;
  reviews.clear();
  portfolioCache.clear();
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return normalizedSettings(next);
}

function touchSession(): void {
  if (unlockedVault && !sessionKeepAlive) {
    // Chrome 110+ resets worker idle termination on extension API calls. Keep the
    // in-memory session alive only until its own idle deadline; never persist keys.
    sessionKeepAlive = setInterval(() => {
      if (Date.now() >= sessionDeadline) { lockVault(); return; }
      void chrome.runtime.getPlatformInfo().catch(() => undefined);
    }, 20_000);
  }
  const session = unlockedVault;
  void settings().then(state => {
    if (session && session === unlockedVault) { sessionDeadline = Date.now() + (state.autoLockMinutes ?? 15) * 60_000; void chrome.alarms.create(LOCK_ALARM, { when: sessionDeadline }); }
  }).catch(() => undefined);
}

function lockVault(): void {
  if (sessionKeepAlive) clearInterval(sessionKeepAlive);
  sessionKeepAlive = undefined; sessionDeadline = 0;
  if (unlockedVault) {
    destroyVaultSession(unlockedVault);
  }
  unlockedVault = null;
  contextRevision++;
  reviews.clear();
  portfolioCache.clear();
  void chrome.alarms.clear(LOCK_ALARM);
}

async function decryptUnlockedVault(): Promise<VaultPayload> {
  const session = unlockedVault;
  if (!session) throw new Error('Wallet is locked');
  return decryptSessionVault(session);
}

async function unlockVault(password: string): Promise<void> {
  const stored = await encryptedVault();
  if (!stored) throw new Error('Create a FnzSafe wallet first');
  const generation = contextRevision;
  const { payload, migrated } = await decryptVaultWithMigration(stored, password);
  if (migrated) {
    await chrome.storage.local.set({ [VAULT_KEY]: await encryptVault(payload, password) });
  }
  const session = await protectVaultInMemory(payload, password, true);
  if (generation !== contextRevision) { destroyVaultSession(session); throw new Error('Wallet changed during unlock'); }
  if (unlockedVault) destroyVaultSession(unlockedVault);
  unlockedVault = session;
  deviceMode = false;
  touchSession();
}

async function activeAccount(
  family: 'evm' | 'solana',
  includePrivateKey = false,
): Promise<VaultAccount> {
  if (!unlockedVault) throw new Error('Wallet is locked');
  if (includePrivateKey && deviceMode) throw new Error('Protect your wallet with a Passkey or password before signing. Open Protect wallet in FnzSafe.');
  const state = await settings();
  const accounts = includePrivateKey
    ? (await decryptUnlockedVault()).accounts
    : unlockedVault.accounts.map((account) => ({ ...account, privateKey: '' }));
  const activeWalletId = unlockedVault.accounts.find(a => a.id === state.activeAccountId)?.walletId ?? unlockedVault.wallets[0].id;
  const scopedAccounts = accounts.filter(a => (a.walletId ?? unlockedVault!.wallets[0].id) === activeWalletId);
  const selected = scopedAccounts.find(
    (account) => account.id === state.activeAccountId && account.family === family,
  );
  const account = selected ?? scopedAccounts.find((candidate) => candidate.family === family);
  if (!account) throw new Error(`No ${family} account is available`);
  return account;
}

async function permissionStore(): Promise<OriginPermissionStore> {
  const result = await chrome.storage.local.get(PERMISSIONS_KEY);
  return normalizePermissionStore(result[PERMISSIONS_KEY]);
}

async function hasPermission(origin: string, family: 'evm' | 'solana', accountId: string): Promise<boolean> {
  const state = await settings();
  const network = family === 'evm' ? state.evmChainId : state.solanaCluster;
  return hasOriginPermission(await permissionStore(), origin, family, accountId, network);
}

async function grantPermission(origin: string, family: 'evm' | 'solana', account: VaultAccount): Promise<void> {
  const state = await settings();
  const network = family === 'evm' ? state.evmChainId : state.solanaCluster;
  const permissions = grantOriginPermission(await permissionStore(), origin, family, account.id, network);
  await chrome.storage.local.set({ [PERMISSIONS_KEY]: permissions });
}

async function approvalView(item: PendingRequest): Promise<ApprovalView> {
  const { request, origin } = item;
  const details: ApprovalView['details'] = [
    { label: 'Site', value: origin },
    { label: 'Method', value: request.method },
  ];
  const selection = await settings();
  const selected = unlockedVault ? await activeAccount(request.family) : undefined;
  details.push({ label: 'Selected network', value: request.family === 'evm' ? `${evmChain(selection.evmChainId).name} (${selection.evmChainId})` : selection.solanaCluster });
  if (selected) details.push({ label: 'Signing account', value: selected.address });
  const warnings: string[] = [];
  let blocking = false;
  if (deviceMode && !['eth_requestAccounts', 'solana_connect', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'].includes(request.method)) {
    blocking = true; warnings.push('Protect your wallet with a Passkey or password in FnzSafe before signing or sending transactions.');
  }
  let summary = 'Allow this site to connect to FnzSafe?';
  if (request.method.includes('sign')) {
    summary = 'Review and sign this request';
    warnings.push('Only approve content you understand and intended to sign.');
  }
  if (request.method === 'eth_sign') {
    warnings.push('eth_sign is a blind-signing method. A malicious signature can authorize unintended actions.');
  }
  if (request.method === 'eth_sendTransaction' || request.method === 'solana_signAndSendTransaction') {
    summary = 'Review and submit this transaction';
    warnings.push('This action can transfer assets or approve contract access.');
  }
  if (request.family === 'evm' && ['wallet_switchEthereumChain', 'wallet_addEthereumChain'].includes(request.method)) {
    const state = await settings();
    const nextChain = requestedBuiltinChain(request.params);
    const currentChain = evmChain(state.evmChainId);
    summary = request.method === 'wallet_addEthereumChain' ? 'This network is built into FnzSafe. Allow this site to use it?' : 'Allow this site to switch networks?';
    details.push(
      { label: 'Current network', value: `${currentChain.name} (${currentChain.chainId})` },
      { label: 'Requested network', value: `${nextChain.name} (${nextChain.chainId})` },
    );
  } else if (request.family === 'evm' && (request.method === 'eth_sendTransaction' || request.method === 'eth_signTransaction')) {
    const state = await settings();
    const chain = configuredChain(evmChain(state.evmChainId), state.rpcOverrides ?? {});
    const account = unlockedVault ? await activeAccount('evm') : undefined;
    const inspection = normalizeAndInspectTransaction(request.params?.[0], chain.chainId!, account?.address, chain.symbol);
    details.push({ label: 'Network', value: `${chain.name} (${chain.chainId})` }, ...inspection.details);
    warnings.push(...inspection.warnings);
    if (account) {
      const provider = await evmProvider(chain);
      try {
        inspection.transaction = await prepareArcFees(inspection.transaction, chain.chainId!, () => provider.getFeeData());
        item.evmTransaction = await prepareTransaction(provider, chain, account.address, inspection.transaction);
        details.push({ label: 'Simulation', value: 'Passed' }, { label: 'Maximum network fee (wei)', value: item.evmTransaction.maxFeeWei }, { label: 'Account nonce', value: String(item.evmTransaction.nonce) });
      } catch { blocking = true; warnings.push('Unable to prepare a valid transaction. Check balance, gas, nonce and RPC before requesting again.'); }
      finally { provider.destroy(); }
    } else {
      warnings.push('Unlock is required before FnzSafe can simulate this transaction.');
    }
  } else if (request.family === 'evm' && request.method === 'eth_signTypedData_v4') {
    const state = await settings();
    const inspection = inspectTypedData(request.params?.[1] ?? request.params?.[0], state.evmChainId);
    details.push(...inspection.details);
    warnings.push(...inspection.warnings);
  } else if (request.family === 'solana' && [
    'solana_signTransaction',
    'solana_signAndSendTransaction',
  ].includes(request.method)) {
    const account = unlockedVault ? await activeAccount('solana') : undefined;
    if (account) {
      const inspection = inspectSolanaTransaction(String(request.params?.[0] ?? ''), account.address);
      details.push(...inspection.details);
      warnings.push(...inspection.warnings);
    } else {
      warnings.push('Unlock is required before FnzSafe can validate the transaction signer.');
    }
  } else if (request.family === 'solana' && request.method === 'solana_signAllTransactions') {
    const transactions = request.params?.[0];
    if (!Array.isArray(transactions) || transactions.length === 0 || transactions.length > 10) {
      throw new Error('A batch must contain between 1 and 10 transactions');
    }
    const account = unlockedVault ? await activeAccount('solana') : undefined;
    details.push({ label: 'Transaction count', value: String(transactions.length) });
    if (account) {
      transactions.forEach((transaction, index) => {
        const inspection = inspectSolanaTransaction(String(transaction), account.address);
        details.push({ label: `Transaction ${index + 1} programs`, value: inspection.details.find((detail) => detail.label === 'Programs')?.value ?? 'Unknown' });
        warnings.push(...inspection.warnings);
      });
    } else {
      warnings.push('Unlock is required before FnzSafe can validate transaction signers.');
    }
  } else if (request.method === 'solana_signMessage' || request.method === 'personal_sign' || request.method === 'eth_sign') {
    details.push({ label: 'Message to sign', value: displaySignedMessage(request.method, request.params ?? []) });
  } else {
    const first = request.params?.[0];
    if (first !== undefined) {
      const text = typeof first === 'string' ? first : JSON.stringify(first);
      details.push({ label: 'Request', value: text.slice(0, 1200) });
    }
  }
  if (!['eth_requestAccounts', 'solana_connect'].includes(request.method)) details.push({ label: 'Full request parameters', value: JSON.stringify(request.params ?? []) });
  return {
    id: request.id,
    origin,
    family: request.family,
    method: request.method,
    summary,
    details,
    warnings,
    locked: unlockedVault === null,
    blocking,
  };
}

async function simulateEvmTransaction(
  chain: ReturnType<typeof evmChain>,
  from: string,
  transaction: TransactionRequest,
): Promise<{ status: string; gasEstimate?: string; warning?: string; blocking: boolean }> {
  const provider = await evmProvider(chain);
  try {
    const request = { ...transaction, from };
    const [gasEstimate] = await Promise.all([
      withTimeout(provider.estimateGas(request), 10_000),
      withTimeout(provider.call(request), 10_000),
    ]);
    return { status: 'Passed', gasEstimate: gasEstimate.toString(), blocking: false };
  } catch (error) {
    const message = errorMessage(error);
    const reverted = /revert|call_exception|execution reverted/i.test(message);
    return {
      status: reverted ? 'Reverted - approval disabled' : 'Unavailable',
      warning: reverted
        ? 'The transaction reverted during simulation and cannot be approved.'
        : 'The RPC could not simulate this transaction. FnzSafe will retry before signing.',
      blocking: reverted,
    };
  } finally { provider.destroy(); }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('RPC simulation timed out')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}

async function assertSigningContext(context: string): Promise<void> {
  if (!unlockedVault || context !== await signingContext()) throw new Error('Wallet selection changed. Review the request again.');
}

async function signingContext(): Promise<string> {
  const state = await settings();
  return JSON.stringify([state.activeAccountId, state.evmChainId, state.solanaCluster, state.rpcOverrides, contextRevision]);
}

async function openApproval(item: PendingRequest): Promise<void> {
  approvalGuard.assertAllowed(item.request.id, item.origin, pending);
  item.context = await signingContext();
  pending.set(item.request.id, item);
  item.timeoutId = setTimeout(() => rejectPending(item.request.id, 'Wallet confirmation timed out'), 5 * 60_000);
  try {
    // Anchor to the requesting tab, not a different window the user focused meanwhile.
    const sourceWindowId = item.port.sender?.tab?.windowId;
    const sourceWindow = await (sourceWindowId === undefined
      ? chrome.windows.getLastFocused({ windowTypes: ['normal'] })
      : chrome.windows.get(sourceWindowId)).catch(() => undefined);
    const width = Math.min(380, sourceWindow?.width || 380);
    const height = Math.min(680, sourceWindow?.height || 680);
    if (pending.get(item.request.id) !== item) return;
    const popup = await chrome.windows.create({
      url: chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(item.request.id)}`),
      type: 'popup',
      width,
      height,
      ...(sourceWindow?.left !== undefined && sourceWindow.width !== undefined
        ? { left: sourceWindow.left + sourceWindow.width - width } : {}),
      ...(sourceWindow?.top !== undefined ? { top: sourceWindow.top } : {}),
      focused: true,
    });
    if (pending.get(item.request.id) !== item) {
      if (popup.id !== undefined) await chrome.windows.remove(popup.id).catch(() => undefined);
      return;
    }
    item.windowId = popup.id;
  } catch (error) {
    removePending(item.request.id);
    throw error;
  }
}

function removePending(id: string): PendingRequest | undefined {
  const item = pending.get(id);
  if (!item) return undefined;
  pending.delete(id);
  if (item.timeoutId) clearTimeout(item.timeoutId);
  return item;
}

function rejectPending(id: string, message: string): void {
  const item = removePending(id);
  if (!item) return;
  item.port.postMessage({ id, error: { code: 4001, message } });
  if (item.windowId) void chrome.windows.remove(item.windowId).catch(() => undefined);
}

async function executeProviderRequest(request: ProviderRequest, origin: string, reviewed?: PreparedTransaction): Promise<unknown> {
  if (request.method === 'eth_requestAccounts') {
    const account = await activeAccount('evm');
    await grantPermission(origin, 'evm', account);
    return [account.address];
  }
  if (request.method === 'solana_connect') {
    const account = await activeAccount('solana');
    await grantPermission(origin, 'solana', account);
    return { publicKey: account.address };
  }

  const account = await activeAccount(request.family);
  if (!(await hasPermission(origin, request.family, account.id))) throw new Error('Connect this site to the selected account before signing');
  if (request.method === 'wallet_addEthereumChain') {
    requestedBuiltinChain(request.params);
    return null;
  }
  if (request.method === 'wallet_switchEthereumChain') {
    const chainId = requestedBuiltinChain(request.params).chainId!;
    await updateSettings({ evmChainId: chainId });
    await grantPermission(origin, 'evm', account);
    return null;
  }
  if (request.family === 'evm') return executeEvm(request, reviewed);
  return executeSolana(request);
}

async function executeEvm(request: ProviderRequest, reviewed?: PreparedTransaction): Promise<unknown> {
  const context = await signingContext();
  const account = await activeAccount('evm', true);
  const wallet = new Wallet(account.privateKey);
  const state = await settings();
  const chain = configuredChain(evmChain(state.evmChainId), state.rpcOverrides ?? {});
  const params = request.params ?? [];
  await assertSigningContext(context);

  switch (request.method) {
    case 'personal_sign': {
      assertRequestedAccount(params[1], account.address);
      const message = String(params[0] ?? '');
      return wallet.signMessage(message.startsWith('0x') ? getBytes(message) : message);
    }
    case 'eth_sign':
      assertRequestedAccount(params[0], account.address);
      return wallet.signMessage(getBytes(String(params[1] ?? params[0] ?? '0x')));
    case 'eth_signTypedData_v4': {
      assertRequestedAccount(params[0], account.address);
      const rawPayload = params[1] ?? params[0];
      inspectTypedData(rawPayload, chain.chainId!);
      const payload = (typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload) as {
        domain: Record<string, unknown>;
        types: Record<string, Array<{ name: string; type: string }>>;
        message: Record<string, unknown>;
      };
      if (!payload || typeof payload !== 'object' || !payload.domain || !payload.types || !payload.message) {
        throw new Error('Typed data payload is invalid');
      }
      const { EIP712Domain: _, ...types } = payload.types;
      return wallet.signTypedData(payload.domain, types, payload.message);
    }
    case 'eth_signTransaction':
    case 'eth_sendTransaction': {
      if (!reviewed) throw new Error('Preview this transaction before approving');
      const provider = await evmProvider(chain);
      try {
        if (request.method === 'eth_signTransaction') return await signPrepared(provider, wallet, reviewed, () => assertSigningContext(context));
        const hash = await sendPrepared(provider, wallet, reviewed, () => assertSigningContext(context));
        await recordActivity({ hash, from: account.address, chainKey: chain.key, kind: 'dapp' });
        return hash;
      } finally { provider.destroy(); }
    }
    default:
      throw new Error(`Unsupported EVM signing method: ${request.method}`);
  }
}

function assertRequestedAccount(value: unknown, expectedAddress: string): void {
  if (typeof value !== 'string' || value.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error('Signing account does not match the selected FnzSafe account');
  }
}

async function executeSolana(request: ProviderRequest): Promise<unknown> {
  const context = await signingContext();
  const account = await activeAccount('solana', true);
  const keypair = Keypair.fromSecretKey(bs58.decode(account.privateKey));
  await assertSigningContext(context);
  if (request.method === 'solana_signMessage') {
    const encoded = String(request.params?.[0] ?? '');
    const signature = nacl.sign.detached(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)), keypair.secretKey);
    return { signature: bs58.encode(signature), publicKey: account.address };
  }
  if (request.method === 'solana_signAllTransactions') {
    const encodedTransactions = request.params?.[0];
    if (!Array.isArray(encodedTransactions) || encodedTransactions.length === 0 || encodedTransactions.length > 10) {
      throw new Error('A batch must contain between 1 and 10 transactions');
    }
    encodedTransactions.forEach((encoded) => inspectSolanaTransaction(String(encoded), account.address));
    return {
      signedTransactions: encodedTransactions.map((encoded) =>
        signSolanaTransaction(String(encoded), keypair).signedBase64,
      ),
    };
  }
  const encoded = String(request.params?.[0] ?? '');
  inspectSolanaTransaction(encoded, account.address);
  const { signed, signedBase64 } = signSolanaTransaction(encoded, keypair);
  if (request.method === 'solana_signTransaction') {
    return { signedTransaction: signedBase64 };
  }
  if (request.method === 'solana_signAndSendTransaction') {
    const state = await settings();
    const chain = configuredChain(chains.find((item) => item.key === `solana:${state.solanaCluster}`)!, state.rpcOverrides ?? {});
    const connection = await solanaConnection(chain);
    let simulation;
    try {
      simulation = await withTimeout(
        connection.simulateTransaction(VersionedTransaction.deserialize(signed), { sigVerify: true }),
        10_000,
      );
    } catch {
      simulation = await withTimeout(connection.simulateTransaction(Transaction.from(signed)), 10_000);
    }
    if (simulation.value.err) {
      throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    await assertSigningContext(context);
    const signature = await connection.sendRawTransaction(signed);
    await recordActivity({ hash: signature, from: account.address, chainKey: chain.key, kind: 'dapp' });
    return { signature, signedTransaction: signedBase64 };
  }
  throw new Error(`Unsupported Solana signing method: ${request.method}`);
}

function signSolanaTransaction(
  encoded: string,
  keypair: Keypair,
): { signed: Uint8Array; signedBase64: string } {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  let signed: Uint8Array;
  try {
    const transaction = VersionedTransaction.deserialize(bytes);
    transaction.sign([keypair]);
    signed = transaction.serialize();
  } catch {
    const transaction = Transaction.from(bytes);
    transaction.partialSign(keypair);
    signed = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  }
  const signedBase64 = btoa(String.fromCharCode(...signed));
  return { signed, signedBase64 };
}

function solanaTokenAssets(
  chainKey: string,
  accounts: Awaited<ReturnType<Connection['getParsedTokenAccountsByOwner']>>['value'],
): PortfolioAsset[] {
  const assets = new Map<string, PortfolioAsset>();
  for (const account of accounts) {
    const data = account.account.data;
    if (!('parsed' in data)) continue;
    const info = data.parsed?.info as {
      mint?: unknown;
      tokenAmount?: { amount?: unknown; decimals?: unknown; uiAmountString?: unknown };
    } | undefined;
    const mint = typeof info?.mint === 'string' ? info.mint : '';
    const rawBalance = typeof info?.tokenAmount?.amount === 'string' ? info.tokenAmount.amount : '';
    const decimals = Number(info?.tokenAmount?.decimals);
    if (!mint || !/^\d+$/.test(rawBalance) || BigInt(rawBalance) === 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) continue;
    const previous = assets.get(mint);
    const combined = (BigInt(previous?.rawBalance ?? '0') + BigInt(rawBalance)).toString();
    assets.set(mint, {
      id: `${chainKey}:${mint}`,
      family: 'solana',
      chainKey,
      address: mint,
      symbol: 'Token',
      name: `${mint.slice(0, 5)}...${mint.slice(-5)}`,
      balance: formatAtomicBalance(combined, decimals),
      rawBalance: combined,
      decimals,
      native: false,
      risk: 'unknown',
    });
  }
  return [...assets.values()];
}

function formatAtomicBalance(rawBalance: string, decimals: number): string {
  const padded = rawBalance.padStart(decimals + 1, '0');
  if (decimals === 0) return padded;
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

async function loadPortfolio(family: string, force = false): Promise<PortfolioSnapshot> {
  if (!unlockedVault) throw new Error('Wallet is locked');
  const generation = contextRevision;
  const state = await settings();
  const activeWalletId = unlockedVault.accounts.find(a => a.id === state.activeAccountId)?.walletId ?? unlockedVault.wallets[0].id;
  const scopedAccounts = unlockedVault.accounts.filter(a => a.walletId === activeWalletId);
  const selectedAccount = scopedAccounts.find(
    (account) => account.id === state.activeAccountId && account.family === family,
  ) ?? scopedAccounts.find((account) => account.family === family);
  const cacheKey = [family, selectedAccount?.id ?? 'none', state.evmChainId, state.solanaCluster, state.enhancedAssetDetection, JSON.stringify(state.rpcOverrides)].join(':');
  const cached = portfolioCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.snapshot;
  const warnings: string[] = [];
  let partial = false;
  let assets: PortfolioAsset[] = [];

  if (family === 'evm') {
    const account = await activeAccount('evm');
    const chain = configuredChain(evmChain(state.evmChainId), state.rpcOverrides ?? {});
    const provider = await evmProvider(chain);
    assets.push(nativeAsset(chain, (await provider.getBalance(account.address)).toString(), 18));
    const savedTokens = (await chrome.storage.local.get(tokenStorageKey(chain.key, account.address)))[tokenStorageKey(chain.key, account.address)];
    if (Array.isArray(savedTokens)) {
      for (const address of savedTokens.slice(0, 100)) {
        try { assets.push(await tokenAsset(provider, chain, account.address, address)); }
        catch { partial = true; warnings.push('An imported token could not be queried. Check its contract and RPC.'); }
      }
    }
    if (state.enhancedAssetDetection) {
      try {
        const discovered = await discoverEvmTokens(chain, account.address);
        assets.push(...discovered.filter(token => !assets.some(a => a.id === token.id)));
      } catch (error) {
        partial = true;
        warnings.push(errorMessage(error));
      }
    }
  } else if (family === 'solana') {
    const account = await activeAccount('solana');
    const chain = configuredChain(chains.find((item) => item.key === `solana:${state.solanaCluster}`)!, state.rpcOverrides ?? {});
    const connection = await solanaConnection(chain);
    const owner = new PublicKey(account.address);
    assets.push(nativeAsset(chain, String(await connection.getBalance(owner)), 9));
    if (state.enhancedAssetDetection) {
      const queries = await Promise.allSettled([
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
      ]);
      const accounts = queries.flatMap((result) => result.status === 'fulfilled' ? result.value.value : []);
      assets.push(...solanaTokenAssets(chain.key, accounts));
      if (queries.some((result) => result.status === 'rejected')) {
        partial = true;
        warnings.push('Some Solana token accounts could not be loaded.');
      }
    }
  } else {
    const chain = chains.find((item) => item.family === family);
    if (!chain) throw new Error('Unknown chain family');
    assets.push({
      id: `${chain.key}:native`, family: chain.family, chainKey: chain.key,
      symbol: chain.symbol, name: chain.name, balance: '--', rawBalance: '', decimals: family === 'bitcoin' ? 8 : 6,
      native: true, risk: 'verified',
    });
    partial = true;
    warnings.push(`${chain.name} balance indexing is not enabled in this extension build.`);
  }

  try {
    assets = await attachUsdPrices(assets);
  } catch {
    partial = true;
    warnings.push('USD prices are temporarily unavailable. Balances are still current.');
  }
  const flaggedSpamCount = assets.filter((asset) => asset.risk === 'spam').length;
  if (flaggedSpamCount > 0) warnings.push(`${flaggedSpamCount} suspicious token${flaggedSpamCount === 1 ? '' : 's'} flagged and placed last.`);
  const snapshot = {
    assets: visiblePortfolioAssets(assets),
    enhancedDetection: state.enhancedAssetDetection,
    partial,
    warnings,
    refreshedAt: Date.now(),
  };
  if (generation !== contextRevision || !unlockedVault) throw new Error('Wallet selection changed; refresh balances');
  portfolioCache.set(cacheKey, { snapshot, expiresAt: Date.now() + PORTFOLIO_CACHE_MS });
  return snapshot;
}

function requiresApproval(method: string): boolean {
  return [
    'eth_requestAccounts',
    'personal_sign',
    'eth_sign',
    'eth_signTypedData_v4',
    'eth_signTransaction',
    'eth_sendTransaction',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
    'solana_connect',
    'solana_signMessage',
    'solana_signTransaction',
    'solana_signAllTransactions',
    'solana_signAndSendTransaction',
  ].includes(method);
}

const SAFE_EVM_READ_METHODS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'eth_syncing',
  'web3_clientVersion',
]);

async function handleProviderRequest(request: ProviderRequest, origin: string): Promise<unknown> {
  if (unlockedVault && sessionDeadline && Date.now() >= sessionDeadline) lockVault();
  const state = await settings();
  if (request.family === 'evm') {
    if (request.method === 'eth_chainId') return `0x${state.evmChainId.toString(16)}`;
    if (request.method === 'net_version') return String(state.evmChainId);
    if (request.method === 'eth_accounts') {
      if (!unlockedVault) return [];
      const account = await activeAccount('evm');
      if (!(await hasPermission(origin, 'evm', account.id))) return [];
      return [account.address];
    }
    if (request.method === 'wallet_getCapabilities') return {};
    // Reject unknown networks before opening an approval that cannot be rendered.
    if (['wallet_switchEthereumChain', 'wallet_addEthereumChain'].includes(request.method)) requestedBuiltinChain(request.params);
    if (SAFE_EVM_READ_METHODS.has(request.method)) {
      const chain = configuredChain(evmChain(state.evmChainId), state.rpcOverrides ?? {});
      const provider = await evmProvider(chain);
      try { return await provider.send(request.method, request.params ?? []); }
      finally { provider.destroy(); }
    }
  }
  if (requiresApproval(request.method)) return Symbol.for('approval');
  throw new Error(`Unsupported provider method: ${request.method}`);
}

registerPasskeyWindows();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fnzsafe-provider') return;
  const origin = safeProviderOrigin(port.sender?.url);
  if (!origin || port.sender?.frameId !== 0) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener((rawRequest: unknown) => {
    void (async () => {
      let request: ProviderRequest | undefined;
      try {
        request = validateProviderRequest(rawRequest);
        const result = await handleProviderRequest(request, origin);
        if (result === Symbol.for('approval')) {
          await openApproval({ request, origin, port, expiresAt: Date.now() + 5 * 60_000 });
          return;
        }
        port.postMessage({ id: request.id, result });
      } catch (error) {
        const id = request?.id ?? (typeof rawRequest === 'object' && rawRequest && 'id' in rawRequest && typeof rawRequest.id === 'string' ? rawRequest.id.slice(0, 128) : '');
        port.postMessage({ id, error: { code: error instanceof Error && 'code' in error && error.code === 4902 ? 4902 : -32600, message: errorMessage(error) } });
      }
    })();
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    for (const [id, item] of pending) {
      if (item.port !== port) continue;
      removePending(id);
      if (item.windowId) void chrome.windows.remove(item.windowId);
    }
  });
});

let uiMutation: Promise<unknown> = Promise.resolve();
const SERIAL_UI_ACTIONS = new Set(['SELECT_WALLET_ACCOUNT', 'SET_AUTO_LOCK', 'CREATE_WALLET', 'OPEN_WALLET', 'PROTECT_DEFAULT_WALLET', 'CONFIRM_BACKUP', 'CREATE_VAULT', 'IMPORT_ACCOUNTS', 'IMPORT_TOKEN', 'SET_RPC', 'SET_NETWORK', 'SET_ACTIVE_ACCOUNT', 'SET_ENHANCED_ASSET_DETECTION', 'SAFE_IMPORT', 'SAFE_IMPORT_TRANSACTIONS', 'SAFE_PROPOSE', 'SAFE_ACCOUNT', 'EXECUTE_REVIEW', 'REFRESH_ACTIVITY', 'SEND_NATIVE']);

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url || ![chrome.runtime.getURL('popup.html'), chrome.runtime.getURL('approval.html')].includes(sender.url.split('?')[0])) {
    sendResponse({ ok: false, error: 'Untrusted wallet UI caller' });
    return false;
  }
  const operation = SERIAL_UI_ACTIONS.has(String(message.type))
    ? uiMutation.then(() => handleUiMessage(message)) : handleUiMessage(message);
  if (SERIAL_UI_ACTIONS.has(String(message.type))) uiMutation = operation.catch(() => undefined);
  void operation.then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: errorMessage(error) }),
  );
  return true;
});

async function handleUiMessage(message: Record<string, unknown>): Promise<unknown> {
  if (unlockedVault && sessionDeadline && Date.now() >= sessionDeadline) lockVault();
  switch (message.type) {
    case 'IMPORT_TOKEN': {
      if (!unlockedVault) throw new Error('Unlock the wallet first');
      const context = await signingContext();
      const state = await settings(), account = await activeAccount('evm');
      const chain = configuredChain(evmChain(state.evmChainId), state.rpcOverrides ?? {});
      const provider = await evmProvider(chain);
      try {
        const asset = await tokenAsset(provider, chain, account.address, String(message.address ?? ''));
        await assertSigningContext(context);
        const key = tokenStorageKey(chain.key, account.address);
        const saved = await chrome.storage.local.get(key);
        const addresses: string[] = Array.isArray(saved[key]) ? saved[key] : [];
        if (!addresses.some(a => a.toLowerCase() === asset.address!.toLowerCase())) addresses.push(asset.address!);
        if (addresses.length > 100) throw new Error('Maximum 100 manually imported tokens per account/network');
        await chrome.storage.local.set({ [key]: addresses });
        portfolioCache.clear();
        return asset;
      } finally { provider.destroy(); }
    }
    case 'GET_ACTIVITY': {
      const state = await settings();
      const key = String(message.family ?? 'evm') === 'solana' ? `solana:${state.solanaCluster}` : `evm:${state.evmChainId}`;
      const account = await activeAccount(key.startsWith('solana') ? 'solana' : 'evm');
      return (await activity()).filter(a => a.chainKey === key && a.from.toLowerCase() === account.address.toLowerCase());
    }
    case 'REFRESH_ACTIVITY': {
      const records = await activity();
      const record = records.find(a => a.hash === message.hash);
      if (!record) throw new Error('Transaction not found');
      const state = await settings();
      const chain = configuredChain(chains.find(c => c.key === record.chainKey)!, state.rpcOverrides ?? {});
      if (chain.family === 'evm') {
        const provider = await evmProvider(chain);
        try {
          if (record.safeAddress) record.status = await safeReceipt(provider, record.hash, record.safeAddress, record.safeTxHash);
          else { const receipt = await provider.getTransactionReceipt(record.hash); record.status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'failed'; }
        } finally { provider.destroy(); }
      } else {
        const connection = await solanaConnection(chain);
        const result = (await connection.getSignatureStatuses([record.hash])).value[0];
        record.status = !result ? 'pending' : result.err ? 'failed' : result.confirmationStatus === 'confirmed' || result.confirmationStatus === 'finalized' ? 'confirmed' : 'pending';
      }
      await chrome.storage.local.set({ walletActivity: records });
      return record;
    }
    case 'PREPARE_TRANSFER': {
      const context = await signingContext();
      const state = await settings(), account = await activeAccount('evm');
      const chain = configuredChain(evmChain(state.evmChainId), state.rpcOverrides ?? {});
      const provider = await evmProvider(chain);
      try {
        const token = message.token ? await tokenAsset(provider, chain, account.address, String(message.token)) : undefined;
        const transaction = await prepareTransaction(provider, chain, account.address, transferRequest(String(message.recipient ?? ''), String(message.amount ?? ''), token), !!token);
        await assertSigningContext(context);
        return saveReview({ context, chain, transaction, details: { recipient: String(message.recipient), amount: String(message.amount), symbol: token?.symbol ?? chain.symbol, tokenAddress: token?.address }, kind: 'transfer' });
      } finally { provider.destroy(); }
    }
    case 'EXECUTE_REVIEW': {
      const review = reviews.get(String(message.id));
      reviews.delete(String(message.id));
      if (!review || review.expiresAt < Date.now()) throw new Error('Review expired; prepare again');
      await assertSigningContext(review.context);
      const account = await activeAccount('evm', true), provider = await evmProvider(review.chain);
      try {
        if (review.proposal) {
          const validated = await validateProposal(provider, review.chain, review.proposal);
          if (review.kind === 'safe-sign') {
            const proposal = await signProposal(provider, review.chain, validated.proposal, new Wallet(account.privateKey), () => assertSigningContext(review.context));
            await saveSafeProposal(proposal);
            return { proposal };
          }
          if (validated.account.nonce !== review.proposal.nonce) throw new Error('Safe nonce changed; review again');
          await prepareSafeExecution(provider, review.chain, account.address, review.proposal);
        }
        if (!review.transaction) throw new Error('Missing transaction review');
        const hash = await sendPrepared(provider, new Wallet(account.privateKey), review.transaction, () => assertSigningContext(review.context));
        await recordActivity({ hash, from: account.address, chainKey: review.chain.key, kind: review.kind, safeAddress: review.safeAddress, safeTxHash: review.proposal?.safe_tx_hash });
        if (review.safeAddress) await rememberSafe(review.chain.chainId!, review.safeAddress);
        return { hash, address: review.safeAddress };
      } finally { provider.destroy(); }
    }
    case 'SAFE_LIST': {
      if (!unlockedVault) throw new Error('Unlock the wallet first');
      return safeWorkspace();
    }
    case 'SAFE_DISCOVER':
    case 'SAFE_IMPORT_TRANSACTIONS':
    case 'SAFE_ACCOUNT':
    case 'SAFE_PROPOSE':
    case 'SAFE_IMPORT':
    case 'SAFE_PREPARE_SIGN':
    case 'SAFE_PREPARE_EXECUTE':
    case 'SAFE_PREPARE_CREATE': {
      const context = await signingContext();
      const state = await settings(), account = await activeAccount('evm');
      const chain = configuredChain(evmChain(state.evmChainId), state.rpcOverrides ?? {});
      const provider = await evmProvider(chain);
      try {
        if (message.type === 'SAFE_DISCOVER') {
          const page = await discoverSafes(provider, chain, account.address, {
            before_block: message.before_block as number | undefined,
            offset: message.offset === undefined ? 0 : message.offset as number,
            block_span: message.block_span as number | undefined,
          });
          await assertSigningContext(context);
          await updateSafeWorkspace(async workspace => {
            await assertSigningContext(context);
            for (const info of page.accounts) {
              const existing = workspace.safes.find(s => s.chainId === chain.chainId && s.address.toLowerCase() === info.address.toLowerCase());
              if (existing) existing.owners = info.owners;
              else workspace.safes.push({chainId:chain.chainId!,address:info.address,owners:info.owners});
            }
            if (workspace.safes.length > 100) throw new Error('Maximum 100 saved Safes');
          });
          return page;
        }
        if (message.type === 'SAFE_IMPORT_TRANSACTIONS') {
          const file = parseSafeImport(String(message.file));
          if (file.kind !== 'transactions') throw new Error('Invalid Safe transaction file');
          const target = safeImportTarget(file, chain.chainId!, String(message.address || ''));
          const info = await safeAccount(provider, chain, target);
          const queued = (await safeWorkspace()).proposals.filter(p => p.chain_id === chain.chainId && p.safe_address.toLowerCase() === target.toLowerCase()).map(proposal => ({proposal}));
          const nonce = nextSafeNonce(info.nonce, queued);
          const payload = file.transactions.length > 1 ? safeBatchPayload(file.transactions) : {...file.transactions[0],batch:undefined};
          const proposal = await propose(provider,chain,target,payload.to,payload.value,payload.data,nonce,payload.batch);
          await assertSigningContext(context);
          await saveSafeProposal(proposal); await rememberSafe(chain.chainId!, info.address, info.owners);
          return proposal;
        }
        if (message.type === 'SAFE_ACCOUNT') {
          const info = await safeAccount(provider, chain, String(message.address));
          await assertSigningContext(context);
          await rememberSafe(chain.chainId!, info.address, info.owners);
          return info;
        }
        if (message.type === 'SAFE_PREPARE_CREATE') {
          const created = await prepareSafeCreation(provider, chain, account.address, message.owners as string[], Number(message.threshold), String(message.salt));
          await assertSigningContext(context);
          return saveReview({ context, chain, transaction: created.transaction, safeAddress: created.address, kind: 'safe-create', details: { owners: created.owners, threshold: created.threshold, address: created.address } });
        }
        if (message.type === 'SAFE_PROPOSE') {
          const proposal = await propose(provider, chain, String(message.address), String(message.to), String(message.value), String(message.data ?? '0x'), message.nonce ? String(message.nonce) : undefined);
          await assertSigningContext(context);
          await saveSafeProposal(proposal);
          return proposal;
        }
        let proposal = parseProposal(String(message.proposal));
        if (message.type === 'SAFE_IMPORT') {
          const existing = (await safeWorkspace()).proposals.find(p => p.chain_id === proposal.chain_id && p.safe_tx_hash.toLowerCase() === proposal.safe_tx_hash.toLowerCase());
          if (existing) proposal = mergeProposals(existing, proposal);
        }
        const validated = await validateProposal(provider, chain, proposal);
        proposal = validated.proposal;
        if (message.type === 'SAFE_IMPORT') {
          await assertSigningContext(context); await saveSafeProposal(proposal); await rememberSafe(chain.chainId!, proposal.safe_address);
          return proposal;
        }
        const transaction = message.type === 'SAFE_PREPARE_EXECUTE' ? await prepareSafeExecution(provider, chain, account.address, proposal) : undefined;
        await assertSigningContext(context);
        return saveReview({ context, chain, transaction, proposal, safeAddress: proposal.safe_address, kind: message.type === 'SAFE_PREPARE_SIGN' ? 'safe-sign' : 'safe-execute', details: { proposal, owners: validated.account.owners, threshold: validated.account.threshold, signer: account.address } });
      } finally { provider.destroy(); }
    }

    case 'CREATE_WALLET': {
      if (!unlockedVault) throw new Error('Unlock the wallet first');
      const generation = contextRevision;
      const password = deviceMode ? undefined : await sessionAuthorization(unlockedVault);
      const stored = await encryptedVault();
      const existing = deviceMode ? await loadDeviceWallet() : stored ? (await decryptVaultWithMigration(stored, password!)).payload : null;
      if (!existing) throw new Error('Wallet not found');
      if (message.name !== undefined && (typeof message.name !== 'string' || message.name.length > 80)) throw new Error('Wallet name is too long');
      const merged = mergeVaultAccounts(existing, createInitialVault(), message.name as string | undefined);
      const session = await protectVaultInMemory(merged, password, true);
      try {
        const encrypted = password !== undefined ? await encryptVault(merged, password) : null;
        if (generation !== contextRevision || !unlockedVault) throw new Error('Wallet changed during creation');
        if (encrypted) await chrome.storage.local.set({ [VAULT_KEY]: encrypted });
        else await saveDeviceWallet(merged);
        if (generation !== contextRevision || !unlockedVault) throw new Error('Wallet changed during creation');
        destroyVaultSession(unlockedVault); unlockedVault = session;
        await updateSettings({ activeAccountId: merged.selectedAccountId }); touchSession();
        return true;
      } catch (e) { if (unlockedVault !== session) destroyVaultSession(session); throw e; }
    }
    case 'OPEN_WALLET': {
      if (await encryptedVault()) return true;
      const generation = contextRevision;
      const payload = await ensureDeviceWallet();
      const savedSettings = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
      if (!savedSettings) await chrome.storage.local.set({ [SETTINGS_KEY]: {
        activeAccountId: payload.selectedAccountId, evmChainId: payload.selectedEvmChainId,
        solanaCluster: payload.selectedSolanaCluster, enhancedAssetDetection: false,
      } });
      const session = await protectVaultInMemory(payload, undefined, true);
      if (generation !== contextRevision) { destroyVaultSession(session); throw new Error('Wallet changed while opening'); }
      if (unlockedVault) destroyVaultSession(unlockedVault);
      unlockedVault = session; deviceMode = true; touchSession();
      return true;
    }
    case 'PROTECT_DEFAULT_WALLET': {
      if (!deviceMode || !unlockedVault || await encryptedVault()) throw new Error('Default wallet is not available');
      const generation = contextRevision;
      const payload = await loadDeviceWallet();
      if (!payload) throw new Error('Local wallet could not be recovered');
      const passkey = message.passkey ? validatePasskeyConfig(message.passkey, chrome.runtime.id) : null;
      if (passkey && !/^[a-f0-9]{64}$/.test(String(message.password))) throw new Error('Invalid passkey encryption secret');
      const encrypted = await encryptVault(payload, String(message.password ?? ''));
      if (generation !== contextRevision || !unlockedVault) throw new Error('Wallet changed during password setup');
      // Persist the password vault first: a crash must never destroy the only copy.
      await chrome.storage.local.set({ [VAULT_KEY]: encrypted, passkeyConfig: passkey, backupConfirmed: false });
      const session = await protectVaultInMemory(payload, String(message.password), true);
      if (generation !== contextRevision || !unlockedVault) { destroyVaultSession(session); throw new Error('Wallet changed during protection'); }
      destroyVaultSession(unlockedVault); unlockedVault = session;
      deviceMode = false;
      await removeDeviceWallet().catch(() => undefined);
      contextRevision++; reviews.clear();
      return true;
    }
    case 'EXPORT_SECRET': {
      if (!unlockedVault || deviceMode) throw new Error('Protect and unlock the wallet before exporting secrets');
      const generation = contextRevision;
      const stored = await encryptedVault();
      if (!stored) throw new Error('Wallet not found');
      const decrypted = await decryptVaultWithMigration(stored, String(message.password ?? ''));
      const payload = groupedVault(decrypted.payload);
      const wallet = walletGroups(payload).find(w => w.id === message.walletId);
      if (!wallet) throw new Error('Unknown wallet');
      const account = payload.accounts.find(a => a.id === message.accountId && (a.walletId ?? walletGroups(payload)[0].id) === wallet.id);
      if (!['mnemonic', 'privateKey'].includes(String(message.kind)) || !['encrypted', 'plaintext'].includes(String(message.format))) throw new Error('Unknown export format');
      const secret = message.kind === 'mnemonic' ? wallet.recoveryMnemonic : account?.privateKey;
      if (!secret) throw new Error('No recovery phrase or private key is available for this selection');
      let value = secret;
      if (message.format === 'encrypted') {
        if (message.kind === 'privateKey' && account?.family === 'bitcoin') {
          // Preserve the Bitcoin address type/path in an authenticated single-key backup.
          value = JSON.stringify(await encryptVault({ recoveryMnemonic: '', accounts: [{ ...account, walletId: undefined }], selectedAccountId: account.id, selectedEvmChainId: 1, selectedSolanaCluster: 'mainnet-beta' }, String(message.backupPassword ?? '')));
        } else value = await encryptSecretBackup(secret, String(message.backupPassword ?? ''));
      }
      if (!unlockedVault || generation !== contextRevision) throw new Error('Wallet changed during export');
      return { value, kind: message.kind, format: message.format, family: account?.family, address: account?.address, derivationPath: account?.derivationPath };
    }
    case 'GET_RECOVERY_PHRASE': {
      if (!unlockedVault || deviceMode) throw new Error('Protect your wallet with a Passkey or password first');
      const generation = contextRevision;
      const stored = await encryptedVault();
      if (!stored) throw new Error('Wallet not found');
      const { payload } = await decryptVaultWithMigration(stored, String(message.password ?? ''));
      if (!unlockedVault || generation !== contextRevision) throw new Error('Wallet changed during backup');
      const activeId = (await settings()).activeAccountId;
      const walletId = message.walletId ?? unlockedVault.accounts.find(a => a.id === activeId)?.walletId;
      const wallet = walletGroups(payload).find(w => w.id === walletId) ?? (!message.walletId ? walletGroups(payload)[0] : undefined);
      if (!wallet?.recoveryMnemonic) throw new Error('Imported private keys require an encrypted backup');
      return wallet.recoveryMnemonic;
    }
    case 'CONFIRM_BACKUP': {
      if (!unlockedVault || deviceMode) throw new Error('Unlock your protected wallet first');
      const selectedId = (await settings()).activeAccountId;
      const id = message.walletId ?? unlockedVault.accounts.find(a => a.id === selectedId)?.walletId;
      if (!unlockedVault.wallets.some(w => w.id === id)) throw new Error('Unknown wallet');
      const flags = (await chrome.storage.local.get('walletBackupConfirmations')).walletBackupConfirmations ?? {};
      await chrome.storage.local.set({ walletBackupConfirmations: { ...flags, [String(id)]: true } }); return true;
    }
    case 'SESSION_STATUS': return { locked: unlockedVault === null };
    case 'STATUS': {
      const stored = await encryptedVault();
      const state = await settings();
      const permissions = await permissionStore();
      const walletId = unlockedVault?.accounts.find(a => a.id === state.activeAccountId)?.walletId ?? unlockedVault?.wallets[0]?.id;
      const backupState = await chrome.storage.local.get(['walletBackupConfirmations', 'backupConfirmed']);
      return {
        initialized: stored !== null || deviceMode || await hasDeviceWallet(),
        passwordProtected: stored !== null,
        passkey: (await chrome.storage.local.get('passkeyConfig')).passkeyConfig ?? null,
        backupConfirmed: backupState.walletBackupConfirmations?.[walletId ?? ''] === true || (walletId === unlockedVault?.wallets[0]?.id && backupState.backupConfirmed === true),
        wallets: unlockedVault?.wallets ?? [],
        suggestedWalletName: nextWalletName(unlockedVault?.wallets ?? []),
        activeWalletId: walletId,
        locked: unlockedVault === null,
        accounts: unlockedVault?.accounts ?? [],
        settings: normalizedSettings(state),
        chains: chains.map(chain => configuredChain(chain, state.rpcOverrides ?? {})),
        connectedOrigins: Object.keys(permissions).sort(),
        connectedSites: Object.entries(permissions)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([origin, permission]) => ({
            origin,
            families: permission.families,
            accountCount: permission.accountIds.length,
            networkCount: permission.evmChainIds.length + permission.solanaClusters.length,
          })),
      };
    }
    case 'CREATE_VAULT': {
      if (await encryptedVault() || await loadDeviceWallet()) throw new Error('A wallet already exists; import accounts from Settings');
      const password = String(message.password ?? '');
      const payload = message.import ? await importWallet(message.import as WalletImport) : createInitialVault(
        typeof message.mnemonic === 'string' ? message.mnemonic : undefined,
      );
      await chrome.storage.local.set({
        [VAULT_KEY]: await encryptVault(payload, password),
        [SETTINGS_KEY]: {
          activeAccountId: payload.selectedAccountId,
          evmChainId: payload.selectedEvmChainId,
          solanaCluster: payload.selectedSolanaCluster,
          enhancedAssetDetection: true,
        } satisfies WalletSettings,
        backupConfirmed: false,
      });
      const recoveryMnemonic = payload.recoveryMnemonic;
      unlockedVault = await protectVaultInMemory(payload, password, true);
      touchSession();
      return { recoveryMnemonic };
    }
    case 'IMPORT_ACCOUNTS': {
      if (!unlockedVault) throw new Error('Unlock the wallet first');
      const password = String(message.password ?? '');
      const stored = await encryptedVault();
      if (!stored) throw new Error('Wallet not found');
      const generation = contextRevision;
      const existing = (await decryptVaultWithMigration(stored, password)).payload;
      if (message.name !== undefined && (typeof message.name !== 'string' || message.name.length > 80)) throw new Error('Wallet name is too long');
      const imported = await importWallet(message.import as WalletImport);
      const merged = mergeVaultAccounts(existing, imported, message.name as string | undefined);
      const encrypted = await encryptVault(merged, password);
      const session = await protectVaultInMemory(merged, password, true);
      try {
        if (generation !== contextRevision || !unlockedVault) throw new Error('Wallet changed during import');
        await chrome.storage.local.set({ [VAULT_KEY]: encrypted });
        if (generation !== contextRevision || !unlockedVault) throw new Error('Wallet changed during import');
        destroyVaultSession(unlockedVault); unlockedVault = session;
      } catch (e) { destroyVaultSession(session); throw e; }
      await updateSettings({ activeAccountId: merged.selectedAccountId });
      touchSession();
      return true;
    }
    case 'EXPORT_BACKUP': {
      if (!unlockedVault) throw new Error('Unlock the wallet first');
      const stored = await encryptedVault();
      if (!stored) throw new Error('Wallet not found');
      const { payload } = await decryptVaultWithMigration(stored, String(message.password ?? ''));
      if ((await chrome.storage.local.get('passkeyConfig')).passkeyConfig) {
        return encryptVault(payload, String(message.backupPassword ?? ''));
      }
      return stored;
    }
    case 'GET_BALANCE': {
      if (!unlockedVault) throw new Error('Wallet is locked');
      const family = String(message.family ?? 'evm');
      const state = await settings();
      if (family === 'evm') {
        const account = await activeAccount('evm');
        const chain = configuredChain(evmChain(state.evmChainId), state.rpcOverrides ?? {});
        const provider = await evmProvider(chain);
        const balance = await provider.getBalance(account.address);
        const padded = balance.toString().padStart(19, '0');
        const whole = padded.slice(0, -18);
        const fraction = padded.slice(-18, -10).replace(/0+$/, '');
        return {
          value: fraction ? `${whole}.${fraction}` : whole,
          symbol: chain.symbol,
        };
      }
      if (family === 'solana') {
        const account = await activeAccount('solana');
        const chain = configuredChain(chains.find((item) => item.key === `solana:${state.solanaCluster}`)!, state.rpcOverrides ?? {});
        const lamports = await (await solanaConnection(chain)).getBalance(new PublicKey(account.address));
        return { value: String(lamports / LAMPORTS_PER_SOL), symbol: 'SOL' };
      }
      return {
        value: '--',
        symbol: family === 'bitcoin' ? 'BTC' : 'TRX',
      };
    }
    case 'GET_PORTFOLIO':
      return loadPortfolio(String(message.family ?? 'evm'), message.force === true);
    case 'SEND_NATIVE': {
      const context = await signingContext();
      if (!unlockedVault) throw new Error('Unlock the wallet before sending');
      const family = String(message.family ?? '');
      const recipient = String(message.recipient ?? '');
      const amount = String(message.amount ?? '');
      const state = await settings();
      const expected = family === 'evm' ? `evm:${state.evmChainId}` : `solana:${state.solanaCluster}`;
      if (message.chainKey !== expected || message.accountId !== (await activeAccount(family === 'evm' ? 'evm' : 'solana')).id) throw new Error('Account or network changed; review again');
      if (family === 'evm') {
        const account = await activeAccount('evm', true);
        const chain = configuredChain(evmChain(state.evmChainId), state.rpcOverrides ?? {});
        const provider = await evmProvider(chain);
        const value = parseUnits(amount, 18);
        if (value <= 0n) throw new Error('Amount must be greater than zero');
        const inspection = normalizeAndInspectTransaction({
          from: account.address,
          to: recipient,
          value,
          chainId: chain.chainId,
        }, chain.chainId!, account.address, chain.symbol);
        inspection.transaction = await prepareArcFees(inspection.transaction, chain.chainId!, () => provider.getFeeData());
        const simulation = await simulateEvmTransaction(chain, account.address, inspection.transaction);
        if (simulation.status !== 'Passed') throw new Error(simulation.warning ?? 'Transaction simulation failed');
        await assertSigningContext(context);
        const response = await new Wallet(
          account.privateKey,
          provider,
        ).sendTransaction(inspection.transaction);
        await recordActivity({ hash: response.hash, from: account.address, chainKey: chain.key, kind: 'transfer' });
        return { signature: response.hash };
      }
      if (family === 'solana') {
        const account = await activeAccount('solana', true);
        const keypair = Keypair.fromSecretKey(bs58.decode(account.privateKey));
        const chain = configuredChain(chains.find((item) => item.key === `solana:${state.solanaCluster}`)!, state.rpcOverrides ?? {});
        const connection = await solanaConnection(chain);
        const numericAmount = Number(amount);
        const lamports = numericAmount * LAMPORTS_PER_SOL;
        if (!Number.isFinite(numericAmount) || numericAmount <= 0 ||
            !Number.isSafeInteger(lamports)) throw new Error('Amount must be a positive value with at most 9 decimals');
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: new PublicKey(recipient),
            lamports,
          }),
        );
        transaction.feePayer = keypair.publicKey;
        transaction.recentBlockhash = (
          await connection.getLatestBlockhash()
        ).blockhash;
        await assertSigningContext(context);
        transaction.sign(keypair);
        const simulation = await connection.simulateTransaction(transaction);
        if (simulation.value.err) {
          throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
        }
        await assertSigningContext(context);
        const signature = await connection.sendRawTransaction(transaction.serialize());
        await recordActivity({ hash: signature, from: account.address, chainKey: chain.key, kind: 'transfer' });
        return { signature };
      }
      throw new Error('Transactions are not enabled for this chain');
    }
    case 'UNLOCK':
      await unlockVault(String(message.password ?? ''));
      return true;
    case 'LOCK':
      lockVault();
      return true;
    case 'CLEAR_PERMISSIONS':
      await chrome.storage.local.remove(PERMISSIONS_KEY);
      return true;
    case 'REVOKE_PERMISSION': {
      const origin = String(message.origin ?? '');
      const permissions = await permissionStore();
      if (!(origin in permissions)) throw new Error('Connected site was not found');
      delete permissions[origin];
      await chrome.storage.local.set({ [PERMISSIONS_KEY]: permissions });
      return true;
    }
    case 'TOUCH_SESSION':
      if (unlockedVault) touchSession();
      return true;
    case 'SET_AUTO_LOCK': {
      if (!unlockedVault) throw new Error('Unlock the wallet first');
      if (!AUTO_LOCK_MINUTES.includes(Number(message.minutes))) throw new Error('Invalid auto-lock duration');
      await updateSettings({ autoLockMinutes: Number(message.minutes) }); touchSession(); return true;
    }
    case 'SELECT_WALLET_ACCOUNT': {
      const account = unlockedVault?.accounts.find(a => a.id === message.accountId);
      const chain = chains.find(c => c.key === message.chainKey);
      if (!account || !chain || chain.family !== account.family) throw new Error('Account and network do not match');
      await updateSettings({ activeAccountId: account.id,
        ...(chain.family === 'evm' ? { evmChainId: chain.chainId } : {}),
        ...(chain.family === 'solana' ? { solanaCluster: chain.key === 'solana:devnet' ? 'devnet' : 'mainnet-beta' } : {}),
      }); touchSession(); return true;
    }
    case 'SET_ACTIVE_ACCOUNT':
      if (!unlockedVault?.accounts.some((account) => account.id === message.accountId)) throw new Error('Unknown account');
      await updateSettings({ activeAccountId: String(message.accountId) });
      return true;
    case 'SET_RPC': {
      if (!unlockedVault) throw new Error('Unlock the wallet first');
      const chain = chains.find(c => c.key === message.key && c.rpcUrl);
      if (!chain) throw new Error('Unknown RPC network');
      const overrides = { ...(await settings()).rpcOverrides };
      if (message.reset === true) delete overrides[chain.key];
      else {
        const rpcUrl = normalizeRpcUrl(message.url);
        await validateRpc({ ...chain, rpcUrl });
        overrides[chain.key] = rpcUrl;
      }
      await updateSettings({ rpcOverrides: overrides });
      return true;
    }
    case 'SET_NETWORK': {
      const key = String(message.key ?? '');
      const chain = chains.find((candidate) => candidate.key === key);
      if (!chain) throw new Error('Unknown network');
      if (chain.family === 'evm') await updateSettings({ evmChainId: chain.chainId });
      if (chain.family === 'solana') await updateSettings({ solanaCluster: key.endsWith('devnet') ? 'devnet' : 'mainnet-beta' });
      return true;
    }
    case 'SET_ENHANCED_ASSET_DETECTION':
      await updateSettings({ enhancedAssetDetection: message.enabled === true });
      return true;
    case 'GET_PENDING': {
      const item = pending.get(String(message.id ?? ''));
      if (!item) throw new Error('This request expired or was already handled');
      if (item.expiresAt <= Date.now()) {
        rejectPending(item.request.id, 'Wallet confirmation timed out');
        throw new Error('This request expired or was already handled');
      }
      if (item.context !== await signingContext()) throw new Error('Account or network changed. Request approval again.');
      return approvalView(item);
    }
    case 'RESOLVE_PENDING': {
      const id = String(message.id ?? '');
      const item = pending.get(id);
      if (!item) throw new Error('This request expired or was already handled');
      removePending(id);
      try {
        if (!message.approved) {
          item.port.postMessage({ id, error: { code: 4001, message: 'User rejected the request' } });
          return true;
        }
        if (!unlockedVault) throw new Error('Unlock and review this request before approving');
        if (item.expiresAt <= Date.now() || item.context !== await signingContext()) throw new Error('Account or network changed. Request approval again.');
        const result = await executeProviderRequest(item.request, item.origin, item.evmTransaction);
        item.port.postMessage({ id, result });
        return true;
      } catch (error) {
        item.port.postMessage({ id, error: { code: -32603, message: errorMessage(error) } });
        throw error;
      } finally {
        if (item.windowId) void chrome.windows.remove(item.windowId).catch(() => undefined);
      }
    }
    default:
      throw new Error('Unknown FnzSafe UI request');
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOCK_ALARM) lockVault();
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, item] of pending) {
    if (item.windowId !== windowId) continue;
    rejectPending(id, 'User closed the confirmation window');
  }
});

chrome.runtime.onSuspend.addListener(lockVault);
