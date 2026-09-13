import type { ChainFamily } from './types';

export interface OriginPermission {
  families: Array<'evm' | 'solana'>;
  accountIds: string[];
  evmChainIds: number[];
  solanaClusters: Array<'mainnet-beta' | 'devnet'>;
  grantedAt: number;
}

export type OriginPermissionStore = Record<string, OriginPermission>;

export function normalizePermissionStore(raw: unknown): OriginPermissionStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const normalized: OriginPermissionStore = {};
  for (const [origin, value] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) {
    try {
      const parsed = new URL(origin);
      const localHttp = parsed.protocol === 'http:' &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
      if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !localHttp)) continue;
    } catch {
      continue;
    }
    if (Array.isArray(value)) {
      // Legacy family-only grants are intentionally not migrated as active account grants.
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const item = value as Partial<OriginPermission>;
    const families = Array.isArray(item.families)
      ? item.families.filter((family): family is 'evm' | 'solana' => family === 'evm' || family === 'solana')
      : [];
    const accountIds = Array.isArray(item.accountIds)
      ? item.accountIds.slice(0, 100).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128)
      : [];
    if (families.length === 0 || accountIds.length === 0) continue;
    normalized[origin] = {
      families: [...new Set(families)],
      accountIds: [...new Set(accountIds)],
      evmChainIds: Array.isArray(item.evmChainIds)
        ? [...new Set(item.evmChainIds.slice(0, 100).filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
        : [],
      solanaClusters: Array.isArray(item.solanaClusters)
        ? [...new Set(item.solanaClusters.slice(0, 10).filter((cluster): cluster is 'mainnet-beta' | 'devnet' => cluster === 'mainnet-beta' || cluster === 'devnet'))]
        : [],
      grantedAt: Number.isFinite(item.grantedAt) ? Number(item.grantedAt) : Date.now(),
    };
  }
  return normalized;
}

export function grantOriginPermission(
  store: OriginPermissionStore,
  origin: string,
  family: Extract<ChainFamily, 'evm' | 'solana'>,
  accountId: string,
  network: number | 'mainnet-beta' | 'devnet',
  now = Date.now(),
): OriginPermissionStore {
  const current = store[origin] ?? {
    families: [], accountIds: [], evmChainIds: [], solanaClusters: [], grantedAt: now,
  };
  return {
    ...store,
    [origin]: {
      ...current,
      families: [...new Set([...current.families, family])],
      accountIds: [...new Set([...current.accountIds, accountId])],
      evmChainIds: family === 'evm' && typeof network === 'number'
        ? [...new Set([...current.evmChainIds, network])]
        : current.evmChainIds,
      solanaClusters: family === 'solana' && typeof network === 'string'
        ? [...new Set([...current.solanaClusters, network])]
        : current.solanaClusters,
    },
  };
}

export function hasOriginPermission(
  store: OriginPermissionStore,
  origin: string,
  family: 'evm' | 'solana',
  accountId: string,
  network?: number | 'mainnet-beta' | 'devnet',
): boolean {
  const permission = store[origin];
  if (!permission?.families.includes(family) || !permission.accountIds.includes(accountId)) return false;
  if (family === 'evm') {
    return typeof network === 'number' && permission.evmChainIds.includes(network);
  }
  return typeof network === 'string' && permission.solanaClusters.includes(network);
}
