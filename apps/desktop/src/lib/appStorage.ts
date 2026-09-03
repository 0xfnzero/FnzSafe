export const DEFAULT_NETWORK = "mainnet";
const NETWORK_STORAGE_KEY = "fnzero-safe-network-v1";
const RPC_PROFILES_STORAGE_KEY = "fnzero-safe-rpc-profiles-v1";
const CURRENT_WALLET_STORAGE_KEY = "fnzero-safe-current-wallet-v1";
const WORKSPACE_STORAGE_KEY = "fnzero-safe-squads-workspace-v1";
const DOWNLOAD_HISTORY_STORAGE_KEY = "fnzero-safe-download-history-v1";
const UI_THEME_STORAGE_KEY = "fnzero-safe-theme-v2";
const LEGACY_NETWORK_STORAGE_KEY = "sol-safekey-network-v1";
const LEGACY_RPC_PROFILES_STORAGE_KEY = "sol-safekey-rpc-profiles-v1";
const LEGACY_CURRENT_WALLET_STORAGE_KEY = "sol-safekey-current-wallet-v1";
const LEGACY_WORKSPACE_STORAGE_KEY = "sol-safekey-squads-workspace-v1";
const LEGACY_DOWNLOAD_HISTORY_STORAGE_KEY = "sol-safekey-download-history-v1";
const LEGACY_UI_THEME_STORAGE_KEY = "sol-safekey-theme-v2";
export const MAX_DOWNLOAD_HISTORY = 30;

export type AppNetwork = "mainnet" | "devnet" | "testnet";
export type RpcNetwork = AppNetwork;
export type AppUiTheme = "light" | "dark" | "deep-sea";

export interface RpcProfile {
  id: string;
  name: string;
  url: string;
  network: RpcNetwork;
  builtin?: boolean;
}

export interface StoredEvmChainConfig {
  chain_id: number;
  name: string;
  native_symbol: string;
  rpc_url: string;
  explorer_url: string | null;
  testnet: boolean;
}

export const DEFAULT_RPC_PROFILES: RpcProfile[] = [
  {
    id: "solana-mainnet",
    name: "Solana Mainnet",
    url: "https://api.mainnet-beta.solana.com",
    network: "mainnet",
    builtin: true,
  },
  {
    id: "publicnode-mainnet",
    name: "PublicNode Mainnet",
    url: "https://solana.publicnode.com",
    network: "mainnet",
    builtin: true,
  },
  {
    id: "solana-devnet",
    name: "Solana Devnet",
    url: "https://api.devnet.solana.com",
    network: "devnet",
    builtin: true,
  },
  {
    id: "solana-testnet",
    name: "Solana Testnet",
    url: "https://api.testnet.solana.com",
    network: "testnet",
    builtin: true,
  },
  {
    id: "publicnode-testnet",
    name: "PublicNode Testnet",
    url: "https://solana-testnet-rpc.publicnode.com",
    network: "testnet",
    builtin: true,
  },
];

export interface WorkspaceActor {
  createdBy?: string;
  createdByLabel?: string;
}

export interface WorkspaceMultisig extends WorkspaceActor {
  address: string;
  vault?: string;
  label?: string;
  network: AppNetwork;
  updatedAt: number;
}

export interface WorkspaceProgram extends WorkspaceActor {
  address: string;
  label?: string;
  network: AppNetwork;
  updatedAt: number;
}

export type ProgramDeploymentPlanKind = "direct-deploy" | "direct-upgrade" | "squads-upgrade";
export type ProgramDeploymentPlanStatus =
  | "draft"
  | "ready"
  | "running"
  | "buffer-ready"
  | "proposal-created"
  | "finalized"
  | "failed";

export interface ProgramDeploymentResult {
  programId: string;
  programdataAddress?: string;
  bufferAddress?: string;
  authority?: string;
  deploySignature?: string | null;
  createBufferSignature?: string | null;
  writeCount?: number;
  skippedWriteCount?: number;
  rentLamports?: number;
  estimatedFeesLamports?: number;
  feeRateReserveLamports?: number;
  recoveryWriteReserveLamports?: number;
  totalFeeBudgetLamports?: number;
  estimatedRequiredBalanceLamports?: number;
  programBytes?: number;
  programSha256?: string;
  genesisHash?: string;
  deployedSlot?: number;
  finalizedSlot?: number;
  readbackVerified?: boolean;
  receiptJson?: string;
  receiptSha256?: string;
  network: AppNetwork;
  completedAt: number;
}

export interface ProgramDeploymentPlan {
  id: string;
  projectId: string;
  kind: ProgramDeploymentPlanKind;
  network: AppNetwork;
  sourceDir: string;
  programId?: string;
  programSha256?: string;
  programBytes?: number;
  maxDataLen?: number;
  upgradeAuthority?: string;
  multisig?: string;
  vault?: string;
  bufferAddress?: string;
  proposal?: string;
  transactionIndex?: string;
  result?: ProgramDeploymentResult;
  status: ProgramDeploymentPlanStatus;
  createdAt: number;
  updatedAt: number;
}

export type ProgramDeploymentHistoryKind =
  | "direct-deploy"
  | "direct-upgrade"
  | "squads-upgrade-buffer"
  | "squads-upgrade-proposal"
  | "squads-upgrade-execute";

export interface ProgramDeploymentHistoryItem {
  id: string;
  projectId: string;
  kind: ProgramDeploymentHistoryKind;
  status: ProgramDeploymentPlanStatus;
  network: AppNetwork;
  sourceDir: string;
  programId?: string;
  programdataAddress?: string;
  upgradeAuthority?: string;
  multisig?: string;
  vault?: string;
  bufferAddress?: string;
  proposal?: string;
  transactionIndex?: string;
  programSha256?: string;
  programBytes?: number;
  maxDataLen?: number;
  deploySignature?: string | null;
  createBufferSignature?: string | null;
  authoritySignature?: string | null;
  signature?: string | null;
  receiptJson?: string;
  receiptSha256?: string;
  deployedSlot?: number;
  finalizedSlot?: number;
  readbackVerified?: boolean;
  createdAt: number;
  completedAt?: number;
}

export interface ProgramProject {
  id: string;
  name: string;
  sourceDir: string;
  ownerWallet?: string;
  ownerWalletLabel?: string;
  network: AppNetwork;
  programId?: string;
  programSha256?: string;
  programBytes?: number;
  programSoName?: string;
  programSoPath?: string;
  programKeypairPath?: string;
  upgradeAuthority?: string;
  multisig?: string;
  vault?: string;
  updatedAt: number;
  plans: ProgramDeploymentPlan[];
  history: ProgramDeploymentHistoryItem[];
}

export interface SquadsWorkspace {
  multisigs: WorkspaceMultisig[];
  programs: WorkspaceProgram[];
  proposals: WorkspaceProposal[];
  programProjects: ProgramProject[];
}

export interface WorkspaceProposal extends WorkspaceActor {
  address: string;
  multisig: string;
  transactionIndex: string;
  label?: string;
  status?: string;
  kind?: string;
  network: AppNetwork;
  updatedAt: number;
}

export interface DownloadHistoryItem {
  id: string;
  filename: string;
  path: string;
  createdAt: number;
  type: string;
}

export const emptyWorkspace: SquadsWorkspace = {
  multisigs: [],
  programs: [],
  proposals: [],
  programProjects: [],
};

export function currentNetwork(value: string | number | undefined): AppNetwork {
  return value === "devnet" || value === "testnet" ? value : "mainnet";
}

export function currentUiTheme(value: string | null | undefined): AppUiTheme {
  if (value === "light" || value === "dark" || value === "deep-sea") return value;
  return "deep-sea";
}

export function loadAppUiTheme(): AppUiTheme {
  if (typeof window === "undefined") return "deep-sea";
  return currentUiTheme(loadStorageValue(UI_THEME_STORAGE_KEY, LEGACY_UI_THEME_STORAGE_KEY));
}

export function saveAppUiTheme(theme: AppUiTheme): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
}

function loadStorageValue(primaryKey: string, legacyKey: string): string | null {
  const primary = window.localStorage.getItem(primaryKey);
  if (primary !== null) return primary;
  const legacy = window.localStorage.getItem(legacyKey);
  if (legacy !== null) {
    window.localStorage.setItem(primaryKey, legacy);
  }
  return legacy;
}

function loadStoredNetwork(): AppNetwork {
  if (typeof window === "undefined") return DEFAULT_NETWORK;
  return currentNetwork(loadStorageValue(NETWORK_STORAGE_KEY, LEGACY_NETWORK_STORAGE_KEY) || DEFAULT_NETWORK);
}

export function rpcProfileKey(profile: Pick<RpcProfile, "url" | "network">): string {
  return `${profile.network}:${profile.url.trim()}`;
}

function sanitizeRpcProfile(raw: Partial<RpcProfile> | undefined): RpcProfile | null {
  const id = String(raw?.id ?? "").trim();
  const name = String(raw?.name ?? "").trim();
  const url = validateRpcUrl(String(raw?.url ?? ""));
  const network = currentNetwork(raw?.network);
  if (!id || !name || !url) return null;
  return { id, name, url, network, builtin: raw?.builtin === true };
}

export function parsePersistedRpcProfiles(value: unknown): RpcProfile[] | null {
  if (!Array.isArray(value)) return null;
  const customProfiles = value
    .map((item) => sanitizeRpcProfile(item as Partial<RpcProfile>))
    .filter((item): item is RpcProfile => Boolean(item))
    .filter((item) => !item.builtin);
  return mergeRpcProfiles(customProfiles);
}

export function mergeRpcProfiles(customProfiles: RpcProfile[]): RpcProfile[] {
  const profiles: RpcProfile[] = [];
  const seen = new Set<string>();
  for (const profile of [...DEFAULT_RPC_PROFILES, ...customProfiles]) {
    const key = rpcProfileKey(profile);
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push(profile);
  }
  return profiles;
}

function loadStoredRpcProfiles(): RpcProfile[] {
  if (typeof window === "undefined") return DEFAULT_RPC_PROFILES;
  try {
    const raw = loadStorageValue(RPC_PROFILES_STORAGE_KEY, LEGACY_RPC_PROFILES_STORAGE_KEY);
    if (!raw) return DEFAULT_RPC_PROFILES;
    return parsePersistedRpcProfiles(JSON.parse(raw)) ?? DEFAULT_RPC_PROFILES;
  } catch {
    return DEFAULT_RPC_PROFILES;
  }
}

export function saveCustomRpcProfiles(profiles: RpcProfile[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    RPC_PROFILES_STORAGE_KEY,
    JSON.stringify(profiles.filter((profile) => !profile.builtin)),
  );
}

function sanitizeDownloadHistoryItem(raw: Partial<DownloadHistoryItem> | undefined): DownloadHistoryItem | null {
  const id = String(raw?.id ?? "").trim();
  const filename = String(raw?.filename ?? "").trim();
  const path = String(raw?.path ?? "").trim();
  const type = String(raw?.type ?? "application/octet-stream").trim() || "application/octet-stream";
  const createdAt = Number(raw?.createdAt ?? 0);
  if (
    !id ||
    !filename ||
    !path.startsWith("/") ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0 ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return null;
  }
  return { id, filename, path, createdAt, type };
}

export function parseDownloadHistory(value: unknown): DownloadHistoryItem[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => sanitizeDownloadHistoryItem(item as Partial<DownloadHistoryItem>))
    .filter((item): item is DownloadHistoryItem => Boolean(item))
    .slice(0, MAX_DOWNLOAD_HISTORY);
}

export function loadDownloadHistory(): DownloadHistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = loadStorageValue(DOWNLOAD_HISTORY_STORAGE_KEY, LEGACY_DOWNLOAD_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    return parseDownloadHistory(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

export function saveDownloadHistory(items: DownloadHistoryItem[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    DOWNLOAD_HISTORY_STORAGE_KEY,
    JSON.stringify(items.slice(0, MAX_DOWNLOAD_HISTORY)),
  );
}

export function defaultRpcProfileId(network: AppNetwork): string {
  return DEFAULT_RPC_PROFILES.find((profile) => profile.network === network)?.id || DEFAULT_RPC_PROFILES[0].id;
}

function normalizeStoredRpcSelection(rpcProfiles: RpcProfile[], storedNetwork: AppNetwork): string {
  if (typeof window !== "undefined") {
    const storedValue = loadStorageValue(NETWORK_STORAGE_KEY, LEGACY_NETWORK_STORAGE_KEY) || "";
    if (rpcProfiles.some((profile) => profile.id === storedValue)) {
      return storedValue;
    }
  }
  return defaultRpcProfileId(storedNetwork);
}

export function validateRpcUrl(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !isSafeUrlHostname(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function normalizeStoredEvmChain(value: unknown): StoredEvmChainConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const chainId = Number(record.chain_id);
  const name = String(record.name ?? "").trim();
  const nativeSymbol = String(record.native_symbol ?? "").trim();
  const rpcUrl = validateRpcUrl(String(record.rpc_url ?? ""));
  const rawExplorerUrl = String(record.explorer_url ?? "").trim();
  const explorerUrl = rawExplorerUrl ? validateRpcUrl(rawExplorerUrl) : null;
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !name ||
    name.length > 80 ||
    !nativeSymbol ||
    nativeSymbol.length > 16 ||
    !rpcUrl ||
    (rawExplorerUrl && !explorerUrl)
  ) return null;
  return {
    chain_id: chainId,
    name,
    native_symbol: nativeSymbol,
    rpc_url: rpcUrl,
    explorer_url: explorerUrl,
    testnet: Boolean(record.testnet),
  };
}

export function isSafeUrlHostname(hostname: string): boolean {
  return Boolean(hostname) && !hostname.startsWith(".") && !hostname.endsWith(".");
}

export function rpcRequestValue(profile: RpcProfile | undefined): string {
  if (!profile) return DEFAULT_NETWORK;
  return `rpc:${profile.network}:${encodeURIComponent(profile.url)}`;
}

export function loadStoredWalletId(): string {
  if (typeof window === "undefined") return "";
  return loadStorageValue(CURRENT_WALLET_STORAGE_KEY, LEGACY_CURRENT_WALLET_STORAGE_KEY) || "";
}

export function saveCurrentWalletId(walletId: string): void {
  if (typeof window === "undefined") return;
  if (walletId) {
    window.localStorage.setItem(CURRENT_WALLET_STORAGE_KEY, walletId);
  } else {
    window.localStorage.removeItem(CURRENT_WALLET_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_CURRENT_WALLET_STORAGE_KEY);
  }
}

export function saveSelectedRpcProfileId(profileId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NETWORK_STORAGE_KEY, profileId);
}

export function loadInitialRpcState(): { profiles: RpcProfile[]; selectedId: string } {
  const profiles = loadStoredRpcProfiles();
  return {
    profiles,
    selectedId: normalizeStoredRpcSelection(profiles, loadStoredNetwork()),
  };
}

export function loadWorkspace(): SquadsWorkspace {
  if (typeof window === "undefined") return emptyWorkspace;
  try {
    const raw = loadStorageValue(WORKSPACE_STORAGE_KEY, LEGACY_WORKSPACE_STORAGE_KEY);
    if (!raw) return emptyWorkspace;
    const parsed = JSON.parse(raw) as Partial<SquadsWorkspace>;
    const programProjects = Array.isArray(parsed.programProjects)
      ? parsed.programProjects.map((project) => {
          const candidate = project as Partial<ProgramProject>;
          return {
            ...candidate,
            plans: Array.isArray(candidate.plans) ? candidate.plans : [],
            history: Array.isArray(candidate.history) ? candidate.history : [],
          } as ProgramProject;
        })
      : [];
    return {
      multisigs: Array.isArray(parsed.multisigs) ? parsed.multisigs : [],
      programs: Array.isArray(parsed.programs) ? parsed.programs : [],
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      programProjects,
    };
  } catch {
    return emptyWorkspace;
  }
}

export function saveWorkspace(workspace: SquadsWorkspace): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
}
