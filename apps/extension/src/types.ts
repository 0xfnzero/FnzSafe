export type ChainFamily = 'evm' | 'solana' | 'bitcoin' | 'tron';

export interface VaultAccount {
  id: string;
  name: string;
  family: ChainFamily;
  address: string;
  privateKey: string;
  derivationPath?: string;
}

export interface VaultPayload {
  recoveryMnemonic: string;
  accounts: VaultAccount[];
  selectedAccountId: string;
  selectedEvmChainId: number;
  selectedSolanaCluster: 'mainnet-beta' | 'devnet';
}

export interface EncryptedVault {
  version: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string; data: string };
}

export interface ChainInfo {
  key: string;
  family: ChainFamily;
  name: string;
  symbol: string;
  icon: string;
  rpcUrl?: string;
  chainId?: number;
  transactionSupport: boolean;
}

export interface PortfolioAsset {
  id: string;
  family: ChainFamily;
  chainKey: string;
  address?: string;
  symbol: string;
  name: string;
  balance: string;
  rawBalance: string;
  decimals: number;
  native: boolean;
  risk: 'verified' | 'unknown' | 'spam';
  priceUsd?: number;
  valueUsd?: number;
  priceSource?: string;
  priceUpdatedAt?: number;
}

export interface PortfolioSnapshot {
  assets: PortfolioAsset[];
  enhancedDetection: boolean;
  partial: boolean;
  warnings: string[];
  refreshedAt: number;
}

export interface ProviderRequest {
  id: string;
  channel: 'fnzsafe:provider';
  family: 'evm' | 'solana';
  method: string;
  params?: unknown[];
}

export interface ApprovalView {
  id: string;
  origin: string;
  family: 'evm' | 'solana';
  method: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  warnings: string[];
  locked: boolean;
  blocking: boolean;
}
