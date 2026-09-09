export type ChainFamily = "solana" | "evm" | "bitcoin" | "tron" | string;

export interface MultiChainDescriptor {
  chain_id: string;
  family: ChainFamily;
  name: string;
  network: string;
  testnet: boolean;
  native_asset: {
    symbol: string;
    name: string;
    decimals: number;
  };
  default_derivation_path: string;
  address_formats: string[];
  capabilities: string[];
  endpoints: Array<{ kind: string; url: string }>;
  explorer_url?: string | null;
  support_level: "experimental" | "beta" | "stable" | string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isMultiChainDescriptor(value: unknown): value is MultiChainDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const chain = value as Partial<MultiChainDescriptor>;
  const nativeAsset = chain.native_asset;
  return typeof chain.chain_id === "string"
    && typeof chain.family === "string"
    && typeof chain.name === "string"
    && typeof chain.network === "string"
    && typeof chain.testnet === "boolean"
    && Boolean(nativeAsset)
    && typeof nativeAsset?.symbol === "string"
    && typeof nativeAsset.name === "string"
    && typeof nativeAsset.decimals === "number"
    && typeof chain.default_derivation_path === "string"
    && isStringArray(chain.address_formats)
    && isStringArray(chain.capabilities)
    && Array.isArray(chain.endpoints)
    && typeof chain.support_level === "string";
}

export function parseChainCatalog(value: unknown): MultiChainDescriptor[] | null {
  return Array.isArray(value) && value.every(isMultiChainDescriptor) ? value : null;
}

export type ChainCapabilityTier = "wallet" | "account" | "validation";

export const CHAIN_FAMILY_ORDER = ["solana", "evm", "bitcoin", "tron"] as const;

const WALLET_CAPABILITIES = ["assets:native_balance", "transactions:transfer"];
const ACCOUNT_CAPABILITIES = ["accounts:derive", "accounts:validate"];

export function chainCapabilityTier(chain: MultiChainDescriptor): ChainCapabilityTier {
  if (WALLET_CAPABILITIES.every((capability) => chain.capabilities.includes(capability))) {
    return "wallet";
  }
  if (ACCOUNT_CAPABILITIES.every((capability) => chain.capabilities.includes(capability))) {
    return "account";
  }
  return "validation";
}

export function sortChainCatalog(chains: MultiChainDescriptor[]): MultiChainDescriptor[] {
  const familyOrder = new Map<string, number>(CHAIN_FAMILY_ORDER.map((family, index) => [family, index]));
  return [...chains].sort((left, right) => {
    const familyDifference = (familyOrder.get(left.family) ?? 99) - (familyOrder.get(right.family) ?? 99);
    if (familyDifference !== 0) return familyDifference;
    if (left.testnet !== right.testnet) return left.testnet ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
}

export function chainFamilyCounts(chains: MultiChainDescriptor[]): Record<string, number> {
  return chains.reduce<Record<string, number>>((counts, chain) => {
    counts[chain.family] = (counts[chain.family] ?? 0) + 1;
    return counts;
  }, {});
}

export function visibleChainFamilies(chains: MultiChainDescriptor[]): string[] {
  const counts = chainFamilyCounts(chains);
  const known = CHAIN_FAMILY_ORDER.filter((family) => counts[family] > 0);
  const future = Object.keys(counts)
    .filter((family) => !CHAIN_FAMILY_ORDER.includes(family as (typeof CHAIN_FAMILY_ORDER)[number]))
    .sort();
  return [...known, ...future];
}

export function filterChainCatalog(
  chains: MultiChainDescriptor[],
  family: string,
  query: string,
): MultiChainDescriptor[] {
  const normalizedQuery = query.trim().toLowerCase();
  return sortChainCatalog(chains).filter((chain) => {
    if (family !== "all" && chain.family !== family) return false;
    if (!normalizedQuery) return true;
    return [
      chain.chain_id,
      chain.family,
      chain.name,
      chain.network,
      chain.native_asset.symbol,
      ...chain.address_formats,
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
  });
}

export function decimalToAtomicUnits(value: string, decimals: number): string | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) return null;
  const atomic = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return BigInt(atomic || "0").toString();
}

export function atomicToDecimalUnits(value: string, decimals: number): string {
  if (!/^\d+$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    return "--";
  }
  if (decimals === 0) return BigInt(value).toString();
  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
