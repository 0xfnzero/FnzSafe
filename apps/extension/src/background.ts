import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getBytes,
  JsonRpcProvider,
  parseUnits,
  TransactionRequest,
  Wallet,
} from 'ethers';
import { chains, evmChain } from './chains';
import type {
  ApprovalView,
  EncryptedVault,
  ProviderRequest,
  VaultAccount,
  VaultPayload,
} from './types';
import { createInitialVault, decryptVaultWithMigration, encryptVault } from './vault';
import {
  attachUsdPrices,
  discoverEvmTokens,
  nativeAsset,
  visiblePortfolioAssets,
} from './portfolio';
import type { PortfolioAsset, PortfolioSnapshot } from './types';
import {
  grantOriginPermission,
  hasOriginPermission,
  normalizePermissionStore,
  type OriginPermissionStore,
} from './permissions';
import {
  inspectTypedData,
  normalizeAndInspectTransaction,
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
const SESSION_MS = 5 * 60_000;
const VAULT_KEY = 'encryptedVault';
const PERMISSIONS_KEY = 'originPermissions';
const SETTINGS_KEY = 'walletSettings';
const PORTFOLIO_CACHE_MS = 30_000;
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

interface WalletSettings {
  activeAccountId?: string;
  evmChainId: number;
  solanaCluster: 'mainnet-beta' | 'devnet';
  enhancedAssetDetection: boolean;
}

interface PendingRequest {
  request: ProviderRequest;
  origin: string;
  port: chrome.runtime.Port;
  windowId?: number;
  expiresAt: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

let unlockedVault: UnlockedVaultSession | null = null;
const pending = new Map<string, PendingRequest>();
const approvalGuard = new ApprovalRequestGuard();
const portfolioCache = new Map<string, { snapshot: PortfolioSnapshot; expiresAt: number }>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    evmChainId,
    solanaCluster,
    enhancedAssetDetection: value?.enhancedAssetDetection !== false,
  };
}

async function updateSettings(patch: Partial<WalletSettings>): Promise<WalletSettings> {
  const next = { ...(await settings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return normalizedSettings(next);
}

function touchSession(): void {
  void chrome.alarms.create(LOCK_ALARM, { when: Date.now() + SESSION_MS });
}

function lockVault(): void {
  if (unlockedVault) {
    destroyVaultSession(unlockedVault);
  }
  unlockedVault = null;
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
  const { payload, migrated } = await decryptVaultWithMigration(stored, password);
  if (migrated) {
    await chrome.storage.local.set({ [VAULT_KEY]: await encryptVault(payload, password) });
  }
  payload.recoveryMnemonic = '';
  unlockedVault = await protectVaultInMemory(payload);
  touchSession();
}

async function activeAccount(
  family: 'evm' | 'solana',
  includePrivateKey = false,
): Promise<VaultAccount> {
  if (!unlockedVault) throw new Error('Wallet is locked');
  const state = await settings();
  const accounts = includePrivateKey
    ? (await decryptUnlockedVault()).accounts
    : unlockedVault.accounts.map((account) => ({ ...account, privateKey: '' }));
  const selected = accounts.find(
    (account) => account.id === state.activeAccountId && account.family === family,
  );
  const account = selected ?? accounts.find((candidate) => candidate.family === family);
  if (!account) throw new Error(`No ${family} account is available`);
  touchSession();
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
  const warnings: string[] = [];
  let blocking = false;
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
  if (request.family === 'evm' && request.method === 'wallet_switchEthereumChain') {
    const state = await settings();
    const raw = (request.params?.[0] as { chainId?: string } | undefined)?.chainId;
    if (!/^0x[0-9a-fA-F]+$/.test(raw ?? '')) throw new Error('Requested chainId is invalid');
    const nextChain = evmChain(Number.parseInt(raw!, 16));
    const currentChain = evmChain(state.evmChainId);
    summary = 'Allow this site to switch networks?';
    details.push(
      { label: 'Current network', value: `${currentChain.name} (${currentChain.chainId})` },
      { label: 'Requested network', value: `${nextChain.name} (${nextChain.chainId})` },
    );
  } else if (request.family === 'evm' && (request.method === 'eth_sendTransaction' || request.method === 'eth_signTransaction')) {
    const state = await settings();
    const chain = evmChain(state.evmChainId);
    const account = unlockedVault ? await activeAccount('evm') : undefined;
    const inspection = normalizeAndInspectTransaction(request.params?.[0], chain.chainId!, account?.address, chain.symbol);
    details.push({ label: 'Network', value: `${chain.name} (${chain.chainId})` }, ...inspection.details);
    warnings.push(...inspection.warnings);
    if (account) {
      const simulation = await simulateEvmTransaction(chain, account.address, inspection.transaction);
      details.push({ label: 'Simulation', value: simulation.status });
      if (simulation.gasEstimate) details.push({ label: 'Estimated gas', value: simulation.gasEstimate });
      if (simulation.warning) warnings.push(simulation.warning);
      blocking = simulation.blocking;
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
  } else {
    const first = request.params?.[0];
    if (first !== undefined) {
      const text = typeof first === 'string' ? first : JSON.stringify(first);
      details.push({ label: 'Request', value: text.slice(0, 1200) });
    }
  }
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
  const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
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
  }
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

async function openApproval(item: PendingRequest): Promise<void> {
  approvalGuard.assertAllowed(item.request.id, item.origin, pending);
  pending.set(item.request.id, item);
  item.timeoutId = setTimeout(() => rejectPending(item.request.id, 'Wallet confirmation timed out'), 5 * 60_000);
  try {
    const popup = await chrome.windows.create({
      url: chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(item.request.id)}`),
      type: 'popup',
      width: 420,
      height: 680,
      focused: true,
    });
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

async function executeProviderRequest(request: ProviderRequest, origin: string): Promise<unknown> {
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
  if (request.method === 'wallet_switchEthereumChain') {
    const raw = (request.params?.[0] as { chainId?: string } | undefined)?.chainId;
    if (!/^0x[0-9a-fA-F]+$/.test(raw ?? '')) throw new Error('Requested chainId is invalid');
    const chainId = Number.parseInt(raw!, 16);
    evmChain(chainId);
    await updateSettings({ evmChainId: chainId });
    await grantPermission(origin, 'evm', account);
    return null;
  }
  if (request.family === 'evm') return executeEvm(request);
  return executeSolana(request);
}

async function executeEvm(request: ProviderRequest): Promise<unknown> {
  const account = await activeAccount('evm', true);
  const wallet = new Wallet(account.privateKey);
  const state = await settings();
  const chain = evmChain(state.evmChainId);
  const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
  const params = request.params ?? [];

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
    case 'eth_signTransaction': {
      const inspection = normalizeAndInspectTransaction(params[0], chain.chainId!, account.address, chain.symbol);
      const simulation = await simulateEvmTransaction(chain, account.address, inspection.transaction);
      if (simulation.blocking) throw new Error(simulation.warning ?? 'Transaction simulation failed');
      return wallet.signTransaction(inspection.transaction);
    }
    case 'eth_sendTransaction': {
      const inspection = normalizeAndInspectTransaction(params[0], chain.chainId!, account.address, chain.symbol);
      const simulation = await simulateEvmTransaction(chain, account.address, inspection.transaction);
      if (simulation.blocking) throw new Error(simulation.warning ?? 'Transaction simulation failed');
      const connected = wallet.connect(provider);
      const response = await connected.sendTransaction(inspection.transaction);
      return response.hash;
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
  const account = await activeAccount('solana', true);
  const keypair = Keypair.fromSecretKey(bs58.decode(account.privateKey));
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
    const chain = chains.find((item) => item.key === `solana:${state.solanaCluster}`)!;
    const connection = new Connection(chain.rpcUrl!, 'confirmed');
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
    const signature = await connection.sendRawTransaction(signed);
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
  const state = await settings();
  const selectedAccount = unlockedVault.accounts.find(
    (account) => account.id === state.activeAccountId && account.family === family,
  ) ?? unlockedVault.accounts.find((account) => account.family === family);
  const cacheKey = [family, selectedAccount?.id ?? 'none', state.evmChainId, state.solanaCluster, state.enhancedAssetDetection].join(':');
  const cached = portfolioCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.snapshot;
  const warnings: string[] = [];
  let partial = false;
  let assets: PortfolioAsset[] = [];

  if (family === 'evm') {
    const account = await activeAccount('evm');
    const chain = evmChain(state.evmChainId);
    const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    assets.push(nativeAsset(chain, (await provider.getBalance(account.address)).toString(), 18));
    if (state.enhancedAssetDetection) {
      try {
        assets.push(...await discoverEvmTokens(chain, account.address));
      } catch (error) {
        partial = true;
        warnings.push(errorMessage(error));
      }
    }
  } else if (family === 'solana') {
    const account = await activeAccount('solana');
    const chain = chains.find((item) => item.key === `solana:${state.solanaCluster}`)!;
    const connection = new Connection(chain.rpcUrl!, 'confirmed');
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
    if (SAFE_EVM_READ_METHODS.has(request.method)) {
      const chain = evmChain(state.evmChainId);
      const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, {
        staticNetwork: true,
      });
      return provider.send(request.method, request.params ?? []);
    }
  }
  if (requiresApproval(request.method)) return Symbol.for('approval');
  throw new Error(`Unsupported provider method: ${request.method}`);
}

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
        port.postMessage({ id, error: { code: -32600, message: errorMessage(error) } });
      }
    })();
  });
  port.onDisconnect.addListener(() => {
    for (const [id, item] of pending) {
      if (item.port !== port) continue;
      removePending(id);
      if (item.windowId) void chrome.windows.remove(item.windowId);
    }
  });
});

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
  void handleUiMessage(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: errorMessage(error) }),
  );
  return true;
});

async function handleUiMessage(message: Record<string, unknown>): Promise<unknown> {
  switch (message.type) {
    case 'STATUS': {
      const stored = await encryptedVault();
      const state = await settings();
      const permissions = await permissionStore();
      return {
        initialized: stored !== null,
        locked: unlockedVault === null,
        accounts: unlockedVault?.accounts ?? [],
        settings: normalizedSettings(state),
        chains,
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
      if (await encryptedVault()) throw new Error('A wallet vault already exists');
      const password = String(message.password ?? '');
      const payload = createInitialVault(
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
      });
      const recoveryMnemonic = payload.recoveryMnemonic;
      payload.recoveryMnemonic = '';
      unlockedVault = await protectVaultInMemory(payload);
      touchSession();
      return { recoveryMnemonic };
    }
    case 'GET_BALANCE': {
      if (!unlockedVault) throw new Error('Wallet is locked');
      const family = String(message.family ?? 'evm');
      const state = await settings();
      if (family === 'evm') {
        const account = await activeAccount('evm');
        const chain = evmChain(state.evmChainId);
        const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, {
          staticNetwork: true,
        });
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
        const chain = chains.find(
          (item) => item.key === `solana:${state.solanaCluster}`,
        )!;
        const lamports = await new Connection(
          chain.rpcUrl!,
          'confirmed',
        ).getBalance(new PublicKey(account.address));
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
      if (!unlockedVault) throw new Error('Unlock the wallet before sending');
      const family = String(message.family ?? '');
      const recipient = String(message.recipient ?? '');
      const amount = String(message.amount ?? '');
      const state = await settings();
      if (family === 'evm') {
        const account = await activeAccount('evm', true);
        const chain = evmChain(state.evmChainId);
        const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, {
          staticNetwork: true,
        });
        const value = parseUnits(amount, 18);
        if (value <= 0n) throw new Error('Amount must be greater than zero');
        const inspection = normalizeAndInspectTransaction({
          from: account.address,
          to: recipient,
          value,
          chainId: chain.chainId,
        }, chain.chainId!, account.address, chain.symbol);
        const simulation = await simulateEvmTransaction(chain, account.address, inspection.transaction);
        if (simulation.status !== 'Passed') throw new Error(simulation.warning ?? 'Transaction simulation failed');
        const response = await new Wallet(
          account.privateKey,
          provider,
        ).sendTransaction(inspection.transaction);
        return { signature: response.hash };
      }
      if (family === 'solana') {
        const account = await activeAccount('solana', true);
        const keypair = Keypair.fromSecretKey(bs58.decode(account.privateKey));
        const chain = chains.find(
          (item) => item.key === `solana:${state.solanaCluster}`,
        )!;
        const connection = new Connection(chain.rpcUrl!, 'confirmed');
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
        transaction.sign(keypair);
        const simulation = await connection.simulateTransaction(transaction);
        if (simulation.value.err) {
          throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
        }
        return {
          signature: await connection.sendRawTransaction(
            transaction.serialize(),
          ),
        };
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
    case 'SET_ACTIVE_ACCOUNT':
      if (!unlockedVault?.accounts.some((account) => account.id === message.accountId)) throw new Error('Unknown account');
      await updateSettings({ activeAccountId: String(message.accountId) });
      return true;
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
        if (!unlockedVault) await unlockVault(String(message.password ?? ''));
        const result = await executeProviderRequest(item.request, item.origin);
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
