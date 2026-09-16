import type { ChainInfo } from './types';

export const chains: ChainInfo[] = [
  { key: 'evm:1', family: 'evm', name: 'Ethereum', symbol: 'ETH', icon: 'ethereum.svg', rpcUrl: 'https://ethereum-rpc.publicnode.com', chainId: 1, transactionSupport: true },
  { key: 'evm:56', family: 'evm', name: 'BNB Smart Chain', symbol: 'BNB', icon: 'binance-smart-chain.svg', rpcUrl: 'https://bsc-dataseed.binance.org', chainId: 56, transactionSupport: true },
  { key: 'evm:42161', family: 'evm', name: 'Arbitrum One', symbol: 'ETH', icon: 'arbitrum-one.svg', rpcUrl: 'https://arb1.arbitrum.io/rpc', chainId: 42161, transactionSupport: true },
  { key: 'evm:10', family: 'evm', name: 'Optimism', symbol: 'ETH', icon: 'optimism.svg', rpcUrl: 'https://mainnet.optimism.io', chainId: 10, transactionSupport: true },
  { key: 'evm:137', family: 'evm', name: 'Polygon', symbol: 'POL', icon: 'polygon.svg', rpcUrl: 'https://polygon-rpc.com', chainId: 137, transactionSupport: true },
  { key: 'evm:8453', family: 'evm', name: 'Base', symbol: 'ETH', icon: 'base.svg', rpcUrl: 'https://mainnet.base.org', chainId: 8453, transactionSupport: true },
  { key: 'evm:43114', family: 'evm', name: 'Avalanche C-Chain', symbol: 'AVAX', icon: 'avalanche.svg', rpcUrl: 'https://api.avax.network/ext/bc/C/rpc', chainId: 43114, transactionSupport: true },
  { key: 'evm:250', family: 'evm', name: 'Fantom Opera', symbol: 'FTM', icon: 'fantom.svg', rpcUrl: 'https://rpcapi.fantom.network', chainId: 250, transactionSupport: true },
  { key: 'evm:59144', family: 'evm', name: 'Linea', symbol: 'ETH', icon: 'linea.svg', rpcUrl: 'https://rpc.linea.build', chainId: 59144, transactionSupport: true },
  { key: 'evm:534352', family: 'evm', name: 'Scroll', symbol: 'ETH', icon: 'scroll.svg', rpcUrl: 'https://rpc.scroll.io', chainId: 534352, transactionSupport: true },
  { key: 'evm:324', family: 'evm', name: 'zkSync Era', symbol: 'ETH', icon: 'zksync.svg', rpcUrl: 'https://mainnet.era.zksync.io', chainId: 324, transactionSupport: true },
  { key: 'evm:4663', family: 'evm', name: 'Robinhood Chain', symbol: 'ETH', icon: 'robinhood.svg', rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', chainId: 4663, transactionSupport: true },
  { key: 'evm:5042', family: 'evm', name: 'Arc', symbol: 'USDC', icon: 'arc.svg', rpcUrl: 'https://rpc.mainnet.arc.io', chainId: 5042, transactionSupport: true },
  { key: 'evm:5042002', family: 'evm', name: 'Arc Testnet', symbol: 'USDC', icon: 'arc.svg', rpcUrl: 'https://rpc.testnet.arc.io', chainId: 5042002, testnet: true, transactionSupport: true },
  { key: 'solana:mainnet-beta', family: 'solana', name: 'Solana', symbol: 'SOL', icon: 'solana.svg', rpcUrl: 'https://api.mainnet-beta.solana.com', transactionSupport: true },
  { key: 'solana:devnet', family: 'solana', name: 'Solana Devnet', symbol: 'SOL', icon: 'solana.svg', rpcUrl: 'https://api.devnet.solana.com', transactionSupport: true },
  { key: 'bitcoin:mainnet', family: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', icon: 'bitcoin.svg', transactionSupport: false },
  { key: 'tron:mainnet', family: 'tron', name: 'TRON', symbol: 'TRX', icon: 'tron.svg', transactionSupport: false },
];

export function evmChain(chainId: number): ChainInfo {
  const chain = chains.find((item) => item.family === 'evm' && item.chainId === chainId);
  if (!chain) throw new Error(`Unsupported EVM chain ${chainId}`);
  return chain;
}

export function requestedBuiltinChain(params: unknown): ChainInfo {
  const raw = Array.isArray(params) ? params[0]?.chainId : undefined;
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error('Requested chainId is invalid');
  const id = Number(BigInt(raw));
  if (!Number.isSafeInteger(id)) throw new Error('Requested chainId is invalid');
  return evmChain(id);
}

export function isArcChain(chainId: number | undefined): boolean {
  return chainId === 5042 || chainId === 5042002;
}

export function isNativeTokenAlias(chainId: number | undefined, address: string): boolean {
  return isArcChain(chainId) && address.toLowerCase() === '0x3600000000000000000000000000000000000000';
}

export const socialRecoveryConfig = Object.freeze({
  enabled: false,
  reason: 'Requires audited MPC custody, OAuth PKCE, redirect allowlisting and recovery policy configuration.',
});
