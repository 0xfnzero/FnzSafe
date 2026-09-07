import type { AppNetwork, AppUiTheme } from "./appStorage";

export type SettingsSection =
  | "root"
  | "accounts"
  | "preferences"
  | "security"
  | "networks"
  | "address-book"
  | "connections"
  | "browser-data"
  | "ai-models"
  | "skills"
  | "developer"
  | "about";

export type AutoLockMinutes = null | 1 | 5 | 15 | 30 | 60;

export interface AppPreferences {
  autoLockMinutes: AutoLockMinutes;
  enabledEvmChainIds: number[];
  showTestnets: boolean;
  transactionDebugDetails: boolean;
  defaultSolanaNetwork: AppNetwork;
  defaultEvmChainId: number | null;
  migrationVersion: number;
}

export interface AddressBookEntry {
  id: string;
  label: string;
  chain: "solana" | "evm";
  network: string;
  address: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DappPermission {
  origin: string;
  walletId: string;
  walletPublicKey: string;
  network: string;
  appName: string;
  firstAuthorizedAtMs: number;
  lastUsedAtMs: number;
}

export interface PermissionWalletIdentity {
  id: string;
  public_key: string;
}

export interface SettingsSnapshot {
  preferences: AppPreferences;
  theme?: AppUiTheme | null;
  solanaRpcProfiles?: unknown;
  customEvmNetworks?: unknown;
  downloadHistory?: unknown;
  schemaVersion: number;
}

export interface SanitizedDiagnostics {
  appVersion: string;
  runtime: string;
  databasePath: string;
  settingsSchemaVersion: number;
  addressBookEntries: number;
  dappPermissions: number;
  generatedAtMs: number;
}

export interface SettingsSearchItem {
  title: string;
  description: string;
  summary?: string;
  keywords?: string[];
}

export type SerialTaskQueue = <Result>(task: () => Promise<Result>) => Promise<Result>;

interface PersistedApprovalOptions<Permission> {
  permissionAlreadyExisted: boolean;
  grant: () => Promise<Permission>;
  approve: () => Promise<void>;
  revoke: (permission: Permission) => Promise<unknown>;
}

export async function persistPermissionBeforeApproval<Permission>({
  permissionAlreadyExisted,
  grant,
  approve,
  revoke,
}: PersistedApprovalOptions<Permission>): Promise<Permission> {
  const permission = await grant();
  try {
    await approve();
    return permission;
  } catch (approvalError) {
    if (!permissionAlreadyExisted) {
      try {
        await revoke(permission);
      } catch (rollbackError) {
        throw new AggregateError(
          [approvalError, rollbackError],
          "DApp approval failed and the newly created permission could not be rolled back",
        );
      }
    }
    throw approvalError;
  }
}

export function createSerialTaskQueue(): SerialTaskQueue {
  let tail: Promise<void> = Promise.resolve();
  return <Result>(task: () => Promise<Result>) => {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  autoLockMinutes: 15,
  enabledEvmChainIds: [],
  showTestnets: false,
  transactionDebugDetails: false,
  defaultSolanaNetwork: "mainnet",
  defaultEvmChainId: null,
  migrationVersion: 1,
};

const STORAGE_KEYS = {
  theme: "fnzero-safe-theme-v2",
  network: "fnzero-safe-network-v1",
  rpcProfiles: "fnzero-safe-rpc-profiles-v1",
  customEvmNetworks: "fnzero.desktop.evm.custom_chains.v1",
  selectedEvmNetwork: "fnzero.desktop.evm.selected_chain.v1",
  downloads: "fnzero-safe-download-history-v1",
} as const;

function parseJsonStorage(storage: Storage, key: string): unknown {
  const raw = storage.getItem(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const BUILTIN_RPC_PROFILE_NETWORKS: Readonly<Record<string, AppNetwork>> = {
  "solana-mainnet": "mainnet",
  "publicnode-mainnet": "mainnet",
  "solana-devnet": "devnet",
  "solana-testnet": "testnet",
  "publicnode-testnet": "testnet",
};

export function resolveLegacySolanaNetwork(
  selectedProfileId: string | null,
  storedProfiles: unknown,
): AppNetwork {
  const selected = selectedProfileId?.trim() ?? "";
  if (selected === "mainnet" || selected === "devnet" || selected === "testnet") return selected;

  if (Array.isArray(storedProfiles)) {
    const matchingProfile = storedProfiles.find((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      return String((candidate as Record<string, unknown>).id ?? "").trim() === selected;
    }) as Record<string, unknown> | undefined;
    const network = matchingProfile?.network;
    if (network === "mainnet" || network === "devnet" || network === "testnet") return network;
  }

  return BUILTIN_RPC_PROFILE_NETWORKS[selected] ?? "mainnet";
}

export function buildLegacySettingsImport(storage: Storage): Record<string, unknown> {
  const selectedChain = Number(storage.getItem(STORAGE_KEYS.selectedEvmNetwork));
  const solanaRpcProfiles = parseJsonStorage(storage, STORAGE_KEYS.rpcProfiles);
  return {
    theme: storage.getItem(STORAGE_KEYS.theme) || undefined,
    solanaNetwork: resolveLegacySolanaNetwork(storage.getItem(STORAGE_KEYS.network), solanaRpcProfiles),
    solanaRpcProfiles,
    customEvmNetworks: parseJsonStorage(storage, STORAGE_KEYS.customEvmNetworks),
    currentEvmChainId: Number.isSafeInteger(selectedChain) && selectedChain > 0 ? selectedChain : undefined,
    downloadHistory: parseJsonStorage(storage, STORAGE_KEYS.downloads),
  };
}

export function normalizeAddress(chain: "solana" | "evm", address: string): string | null {
  const value = address.trim();
  if (chain === "evm") {
    return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
  }
  return decodedBase58Length(value) === 32 ? value : null;
}

export function normalizeAddressNetwork(chain: "solana" | "evm", network: string): string | null {
  const value = network.trim().toLowerCase();
  if (chain === "solana") {
    return value === "mainnet" || value === "devnet" || value === "testnet" ? value : null;
  }
  if (!/^[1-9]\d*$/.test(value)) return null;
  const chainId = Number(value);
  return Number.isSafeInteger(chainId) ? String(chainId) : null;
}

function decodedBase58Length(value: string): number | null {
  if (!value || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return null;
  const bytes: number[] = [0];
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for (const character of value) {
    let carry = alphabet.indexOf(character);
    if (carry < 0) return null;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length - 1 && value[leadingZeroes] === "1") leadingZeroes += 1;
  return bytes.length + leadingZeroes;
}

export function addressBookDuplicate(
  entries: AddressBookEntry[],
  candidate: Pick<AddressBookEntry, "chain" | "network" | "address">,
  editingId?: string,
): boolean {
  const normalized = normalizeAddress(candidate.chain, candidate.address);
  const normalizedNetwork = normalizeAddressNetwork(candidate.chain, candidate.network);
  if (!normalized || !normalizedNetwork) return false;
  return entries.some(
    (entry) =>
      entry.id !== editingId &&
      entry.chain === candidate.chain &&
      normalizeAddressNetwork(entry.chain, entry.network) === normalizedNetwork &&
      normalizeAddress(entry.chain, entry.address) === normalized,
  );
}

export function matchesSettingsSearch(item: SettingsSearchItem, search: string): boolean {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [item.title, item.description, item.summary ?? "", ...(item.keywords ?? [])]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

export function dappPermissionMatchesWallet(
  permission: Pick<DappPermission, "walletId"> & Partial<Pick<DappPermission, "walletPublicKey">>,
  wallet: PermissionWalletIdentity,
): boolean {
  if (permission.walletPublicKey?.trim()) {
    return permission.walletId === wallet.id && permission.walletPublicKey === wallet.public_key;
  }
  return permission.walletId === wallet.id || permission.walletId === wallet.public_key;
}

export function visibleEvmChainIds(
  chains: Array<{ chain_id: number; testnet: boolean }>,
  preferences: AppPreferences,
): number[] {
  const configured = new Set(preferences.enabledEvmChainIds);
  const eligible = chains.filter((chain) => preferences.showTestnets || !chain.testnet);
  if (configured.size === 0) return eligible.map((chain) => chain.chain_id);
  const visible = eligible.filter((chain) => configured.has(chain.chain_id)).map((chain) => chain.chain_id);
  return visible.length > 0 ? visible : eligible.slice(0, 1).map((chain) => chain.chain_id);
}

export function enabledChainFallback(
  currentChainId: number | null,
  enabledChainIds: number[],
): number | null {
  if (currentChainId !== null && enabledChainIds.includes(currentChainId)) return currentChainId;
  return enabledChainIds[0] ?? null;
}

export function toggleEnabledEvmChain(
  chains: Array<{ chain_id: number; testnet: boolean }>,
  preferences: AppPreferences,
  chainId: number,
  enabled: boolean,
): number[] {
  const current = new Set(
    preferences.enabledEvmChainIds.length > 0
      ? preferences.enabledEvmChainIds
      : chains.map((chain) => chain.chain_id),
  );
  visibleEvmChainIds(chains, preferences).forEach((id) => current.add(id));
  if (enabled) {
    current.add(chainId);
  } else {
    const remainingEligible = chains.some(
      (chain) =>
        chain.chain_id !== chainId
        && (preferences.showTestnets || !chain.testnet)
        && current.has(chain.chain_id),
    );
    if (remainingEligible) current.delete(chainId);
  }
  return chains.map((chain) => chain.chain_id).filter((id) => current.has(id));
}

export function nextAutoLockDeadline(now: number, minutes: AutoLockMinutes): number | null {
  return minutes === null ? null : now + minutes * 60_000;
}

export function hasAutoLockExpired(deadline: number | null, now: number): boolean {
  return deadline !== null && now >= deadline;
}

const SENSITIVE_FORM_FIELD =
  /(password|private.?key|mnemonic|secret|signature|signed|transaction.?base64|external.?sign|recent.?blockhash)/i;

export function stripSensitiveFormFields<T extends Record<string, unknown>>(form: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(form).filter(([key]) => !SENSITIVE_FORM_FIELD.test(key)),
  ) as Partial<T>;
}
