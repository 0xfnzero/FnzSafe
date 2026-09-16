const CHAIN_LOGO_BY_ID: Readonly<Record<number, string>> = {
  1: "/chain-icons/ethereum.svg",
  10: "/chain-icons/optimism.svg",
  56: "/chain-icons/binance-smart-chain.svg",
  97: "/chain-icons/binance-smart-chain.svg",
  137: "/chain-icons/polygon.svg",
  250: "/chain-icons/fantom.svg",
  324: "/chain-icons/zksync.svg",
  4663: "/chain-icons/robinhood.svg",
  5042: "/chain-icons/arc.svg",
  5042002: "/chain-icons/arc.svg",
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

export const SOLANA_CHAIN_LOGO_URI = "/token-icons/solana.png";
export const BITCOIN_CHAIN_LOGO_URI = "/chain-icons/bitcoin.svg";
export const TRON_CHAIN_LOGO_URI = "/chain-icons/tron.svg";

const CHAIN_FAMILY_LOGO_BY_ID: Readonly<Record<string, string>> = {
  solana: SOLANA_CHAIN_LOGO_URI,
  evm: CHAIN_LOGO_BY_ID[1],
  bitcoin: BITCOIN_CHAIN_LOGO_URI,
  tron: TRON_CHAIN_LOGO_URI,
};

export function chainLogoUri(chainId?: number): string | undefined {
  return chainId === undefined ? undefined : CHAIN_LOGO_BY_ID[chainId];
}

export function chainFamilyLogoUri(family: string): string | undefined {
  return CHAIN_FAMILY_LOGO_BY_ID[family];
}

export function chainDescriptorLogoUri(chain: { family: string; chain_id: string }): string | undefined {
  if (chain.family !== "evm") {
    const expectedNamespace = chain.family === "bitcoin" ? "bip122" : chain.family;
    return chain.chain_id.startsWith(`${expectedNamespace}:`) && chain.chain_id.length > expectedNamespace.length + 1
      ? chainFamilyLogoUri(chain.family)
      : undefined;
  }

  const match = /^eip155:([1-9]\d*)$/.exec(chain.chain_id);
  if (!match) return undefined;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) ? chainLogoUri(chainId) : undefined;
}
