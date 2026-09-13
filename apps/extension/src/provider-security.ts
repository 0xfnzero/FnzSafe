import type { ProviderRequest } from './types';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PARAMS = 50;
const MAX_PENDING_TOTAL = 20;
const MAX_PENDING_PER_ORIGIN = 3;
const MAX_APPROVALS_PER_MINUTE = 10;

const EVM_METHODS = new Set([
  'eth_accounts', 'eth_blockNumber', 'eth_call', 'eth_chainId',
  'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice', 'eth_getBalance',
  'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber', 'eth_getCode', 'eth_getLogs',
  'eth_getStorageAt', 'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex', 'eth_getTransactionByHash',
  'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas',
  'eth_requestAccounts', 'eth_sendTransaction', 'eth_sign', 'eth_signTransaction',
  'eth_signTypedData_v4', 'eth_syncing', 'net_version', 'personal_sign',
  'wallet_getCapabilities', 'wallet_switchEthereumChain', 'web3_clientVersion',
]);

const SOLANA_METHODS = new Set([
  'solana_connect', 'solana_signAllTransactions', 'solana_signAndSendTransaction',
  'solana_signMessage', 'solana_signTransaction',
]);

export function safeProviderOrigin(url?: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const localHttp = parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (parsed.protocol !== 'https:' && !localHttp) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function validateProviderRequest(value: unknown): ProviderRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid provider request');
  }
  const request = value as Partial<ProviderRequest>;
  if (request.channel !== 'fnzsafe:provider' ||
      typeof request.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(request.id) ||
      (request.family !== 'evm' && request.family !== 'solana') ||
      typeof request.method !== 'string' || request.method.length === 0 || request.method.length > 80 ||
      (request.params !== undefined && (!Array.isArray(request.params) || request.params.length > MAX_PARAMS))) {
    throw new Error('Invalid provider request');
  }
  const methods = request.family === 'evm' ? EVM_METHODS : SOLANA_METHODS;
  if (!methods.has(request.method)) throw new Error('Unsupported provider method');
  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw new Error('Invalid provider request');
  }
  if (new TextEncoder().encode(serialized).length > MAX_REQUEST_BYTES) {
    throw new Error('Provider request is too large');
  }
  return request as ProviderRequest;
}

export class ApprovalRequestGuard {
  private readonly recent = new Map<string, number[]>();

  assertAllowed(
    id: string,
    origin: string,
    pending: ReadonlyMap<string, { origin: string }>,
    now = Date.now(),
  ): void {
    if (pending.has(id)) throw new Error('A request with this id is already pending');
    if (pending.size >= MAX_PENDING_TOTAL) throw new Error('Too many wallet confirmations are pending');
    let originPending = 0;
    for (const item of pending.values()) if (item.origin === origin) originPending += 1;
    if (originPending >= MAX_PENDING_PER_ORIGIN) throw new Error('This site has too many pending confirmations');

    const cutoff = now - 60_000;
    const timestamps = (this.recent.get(origin) ?? []).filter((timestamp) => timestamp > cutoff);
    if (timestamps.length >= MAX_APPROVALS_PER_MINUTE) {
      this.recent.set(origin, timestamps);
      throw new Error('This site is requesting confirmations too quickly');
    }
    timestamps.push(now);
    this.recent.set(origin, timestamps);
    if (this.recent.size > 100) {
      for (const [key, values] of this.recent) {
        if (values.every((timestamp) => timestamp <= cutoff)) this.recent.delete(key);
      }
    }
  }
}

export const providerSecurityLimits = {
  MAX_REQUEST_BYTES,
  MAX_PENDING_TOTAL,
  MAX_PENDING_PER_ORIGIN,
  MAX_APPROVALS_PER_MINUTE,
};
