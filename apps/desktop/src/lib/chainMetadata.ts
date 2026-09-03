const CHAIN_LOGO_BY_ID: Readonly<Record<number, string>> = {
  1: "/chain-icons/ethereum.svg",
  10: "/chain-icons/optimism.svg",
  56: "/chain-icons/binance-smart-chain.svg",
  97: "/chain-icons/binance-smart-chain.svg",
  137: "/chain-icons/polygon.svg",
  250: "/chain-icons/fantom.svg",
  324: "/chain-icons/zksync.svg",
  4663: "/chain-icons/robinhood.svg",
  8453: "/chain-icons/base.svg",
  42161: "/chain-icons/arbitrum-one.svg",
  43114: "/chain-icons/avalanche.svg",
  46630: "/chain-icons/robinhood.svg",
  59144: "/chain-icons/linea.svg",
  80002: "/chain-icons/polygon.svg",
  84532: "/chain-icons/base.svg",
  534352: "/chain-icons/scroll.svg",
  11155111: "/chain-icons/ethereum.svg",
};

export const SOLANA_CHAIN_LOGO_URI = "/chain-icons/solana.svg";

export function chainLogoUri(chainId?: number): string | undefined {
  return chainId === undefined ? undefined : CHAIN_LOGO_BY_ID[chainId];
}
