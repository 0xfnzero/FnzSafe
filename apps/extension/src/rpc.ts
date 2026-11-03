import { Connection } from '@solana/web3.js';
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { chains } from './chains';
import type { ChainInfo } from './types';

export type RpcOverrides = Record<string, string>;
export function normalizeRpcUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Invalid RPC URL');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('Invalid RPC URL'); }
  if (url.username || url.password || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Use HTTPS, or HTTP on localhost. Credentials in the URL authority are not supported.');
  }
  return url.href;
}
export function normalizeRpcOverrides(raw: unknown): RpcOverrides {
  const result: RpcOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const chain of chains.filter(c => c.rpcUrl)) {
    try {
      const value = (raw as RpcOverrides)[chain.key];
      if (value) result[chain.key] = normalizeRpcUrl(value);
    } catch { /* Ignore invalid stored configuration. */ }
  }
  return result;
}
export function configuredChain(chain: ChainInfo, overrides: RpcOverrides): ChainInfo {
  return { ...chain, rpcUrl: overrides[chain.key] ?? chain.rpcUrl };
}
class RpcAccessError extends Error {}

async function rpcIdentity(url: string, method: string): Promise<unknown> {
  const response = await fetch(normalizeRpcUrl(url), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    signal: AbortSignal.timeout(10_000), redirect: 'error', credentials: 'omit',
  });
  if (response.status === 403) throw new RpcAccessError('RPC access denied (HTTP 403). Set a custom RPC in Settings.');
  if (response.status === 429) throw new RpcAccessError('RPC rate limit reached (HTTP 429). Try again later or set a custom RPC in Settings.');
  if (!response.ok) throw new Error('RPC unavailable');
  const body = await response.json();
  if (body.error || body.id !== 1) throw new Error('Invalid RPC response');
  return body.result;
}
export async function validateRpc(chain: ChainInfo): Promise<void> {
  try {
    if (!chain.rpcUrl) throw new Error('RPC missing');
    if (chain.family === 'evm') {
      const result = await rpcIdentity(chain.rpcUrl, 'eth_chainId');
      if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result) || BigInt(result) !== BigInt(chain.chainId!)) throw new Error('Wrong chain');
    } else if (chain.family === 'solana') {
      const expected = chain.key === 'solana:devnet' ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' : '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
      if (await rpcIdentity(chain.rpcUrl, 'getGenesisHash') !== expected) throw new Error('Wrong cluster');
    } else throw new Error('Unsupported network');
  } catch (error) {
    if (error instanceof RpcAccessError) throw error;
    throw new Error('RPC verification failed. Check the endpoint and selected network.');
  }
}
export async function evmProvider(chain: ChainInfo): Promise<JsonRpcProvider> {
  await validateRpc(chain);
  const request = new FetchRequest(chain.rpcUrl!);
  request.timeout = 15_000;
  request.allowInsecureAuthentication = false;
  request.getUrlFunc = async (req) => {
    const response = await fetch(req.url, { method: req.method, headers: req.headers,
      body: req.body ? new Uint8Array(req.body) : undefined,
      signal: AbortSignal.timeout(15_000), redirect: 'error', credentials: 'omit' });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return { statusCode: response.status, statusMessage: response.statusText,
      headers, body: new Uint8Array(await response.arrayBuffer()) };
  };
  const provider = new JsonRpcProvider(request, chain.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  // RPC errors can echo a complete request URL, including provider API keys.
  const send = provider.send.bind(provider);
  provider.send = async (method, params) => {
    try { return await send(method, params); }
    catch { throw new Error('RPC request failed. Check the endpoint, balance and transaction.'); }
  };
  return provider;
}
export async function solanaConnection(chain: ChainInfo): Promise<Connection> {
  await validateRpc(chain);
  return new Connection(chain.rpcUrl!, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: async (input, init) => {
      try { return await fetch(input, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error', credentials: 'omit' }); }
      catch { throw new Error('Solana RPC request failed'); }
    },
  });
}
