import type { ChainInfo } from '../types';

export interface PublicAccount {
  id: string;
  name: string;
  family: 'evm' | 'solana' | 'bitcoin' | 'tron';
  address: string;
}

export interface WalletStatus {
  initialized: boolean;
  locked: boolean;
  accounts: PublicAccount[];
  settings: {
    activeAccountId?: string;
    evmChainId: number;
    solanaCluster: 'mainnet-beta' | 'devnet';
    enhancedAssetDetection: boolean;
  };
  chains: ChainInfo[];
  connectedOrigins: string[];
  connectedSites: Array<{
    origin: string;
    families: Array<'evm' | 'solana'>;
    accountCount: number;
    networkCount: number;
  }>;
}

export async function api<T>(message: Record<string, unknown>): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as {
    ok: boolean;
    result?: T;
    error?: string;
  };
  if (!response?.ok) {
    throw new Error(response?.error ?? 'FnzSafe service worker did not respond');
  }
  return response.result as T;
}

export function compact(value: string): string {
  return value.length > 18
    ? `${value.slice(0, 8)}...${value.slice(-6)}`
    : value;
}
