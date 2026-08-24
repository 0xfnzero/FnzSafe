"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import QRCode from "qrcode";
import { toast } from "sonner";
import { useTranslations } from '@/hooks/useTranslations';
import {
  Key,
  Lock,
  Download,
  Upload,
  Wallet,
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  RefreshCw,
  AlertTriangle,
  Hash,
  Coins,
  Plus,
  ArrowRightLeft,
  Send,
  Unlock,
  X,
  ShieldCheck,
  Pencil,
  Save,
  Settings,
  Trash2,
  ExternalLink,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  CircleDot,
  Compass,
  FolderOpen,
  CheckCircle2,
  XCircle,
  Sun,
  Moon,
  Search,
  Flame,
  Star,
  BarChart3,
  Fingerprint,
  EyeOff,
  HelpCircle,
  Minus,
  QrCode,
} from "lucide-react";
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { FieldHelp } from "@/components/FieldHelp";
import { SavedWalletPicker } from "@/components/SavedWalletPicker";
import { DEFAULT_API_PORT } from "@/lib/api";
import { apiFetch } from "@/lib/apiFetch";
import {
  anchorIdlProgramId,
  defaultAccountAddress,
  encodeAnchorInstruction,
  encodeAnchorSeedArgToBase64,
  flattenAnchorAccounts,
  idlTypeLabel,
  isValidAnchorAccountAddress,
  isUnsupportedIdlType,
  parseAnchorIdlJson,
  resolveAnchorAccountAddress,
  type AnchorIdlArg,
  type FlatAnchorAccount,
  type AnchorIdlInstruction,
  type AnchorIdlProgram,
} from "@/lib/anchorIdl";
import {
  currentNetwork,
  DEFAULT_NETWORK,
  DEFAULT_RPC_PROFILES,
  defaultRpcProfileId,
  emptyWorkspace,
  loadDownloadHistory,
  loadAppUiTheme,
  loadInitialRpcState,
  loadStoredWalletId,
  loadWorkspace,
  MAX_DOWNLOAD_HISTORY,
  mergeRpcProfiles,
  rpcProfileKey,
  rpcRequestValue,
  saveCurrentWalletId,
  saveCustomRpcProfiles,
  saveDownloadHistory,
  saveAppUiTheme,
  saveSelectedRpcProfileId,
  saveWorkspace,
  validateRpcUrl,
  type AppNetwork,
  type AppUiTheme,
  type DownloadHistoryItem,
  type ProgramDeploymentHistoryItem,
  type ProgramDeploymentPlan,
  type ProgramDeploymentPlanStatus,
  type ProgramDeploymentResult,
  type ProgramProject,
  type RpcProfile,
  type SquadsWorkspace,
  type WorkspaceActor,
  type WorkspaceMultisig,
  type WorkspaceProposal,
} from "@/lib/appStorage";
import { openExternalUrl } from "@/lib/openExternal";
import { localTokenMetadata } from "@/lib/localTokenRegistry";
import {
  buildProgramDeploymentReceiptJson,
  compactProgramDeploymentReceiptJson,
  isLikelySolanaGenesisHash,
  isLikelySolanaPublicKey,
  MAX_PROGRAM_KEYPAIR_FILE_BYTES,
  parseProgramKeypairJson,
  programIdFromKeypairBytes,
  serializeProgramKeypairJson,
  sha256Hex,
} from "@/lib/programDeploy";
import {
  deploymentReceiptFilename,
  isUnfinishedProgramDeploymentStatus,
  programDeploymentHistoryFilename,
  programDeploymentHistoryId,
  programDeploymentHistoryToJson,
  programProjectDeploymentHistoryToJson,
  programPlanId,
  programProjectId,
  safeFilename,
  sourceDirProjectName,
} from "@/lib/programWorkspace";
import {
  applyWalletAuth,
  authFormsWithWallets,
  fetchWallets,
  normalizeWalletAuth,
  type ApiRequestBody,
  type FormState,
  type SavedWallet,
  type WalletAuthTab,
  validateWalletAuth,
  walletLabel,
} from "@/lib/walletAuth";

const MAX_KEYSTORE_FILE_BYTES = 128 * 1024;
const MAX_PROGRAM_SO_FILE_BYTES = 3 * 1024 * 1024;
const FALLBACK_PROGRAM_WRITE_CHUNK_BYTES = 800;
const TRANSACTION_PAGE_SIZE = 20;
const MAX_TRANSACTION_HISTORY = 100;
const ASSET_AUTO_REFRESH_TTL_MS = 60_000;
const WALLET_ASSET_AUTO_REFRESH_INTERVAL_MS = 30_000;
const ACTIVE_OPERATION_ASSET_REFRESH_INTERVAL_MS = 12_000;
const TRANSACTION_AUTO_REFRESH_TTL_MS = 90_000;
const NONCE_AUTO_REFRESH_TTL_MS = 120_000;
const TOKEN_ASSET_PAGE_SIZE = 30;
const DEFAULT_POST_MUTATION_ASSET_REFRESH_DELAYS_MS = [0, 1800];
const POST_SELL_ASSET_REFRESH_DELAYS_MS = [0, 1200, 3000, 7000, 12000];
const PROGRAM_DEPLOY_SLOW_PROGRESS_MS = 90_000;
const PROGRAM_DEPLOY_STALLED_MS = 180_000;
const WALLET_LIST_LOAD_RETRY_DELAYS_MS = [350, 900, 1_800, 3_000, 5_000, 8_000, 13_000];
const UPGRADEABLE_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const SOLANA_TOKEN_LOGO_URI = "/token-icons/solana.png";
const ALLOW_DIRECT_SECRET_INPUT =
  process.env.NEXT_PUBLIC_ALLOW_DIRECT_SECRET_INPUT === "true";

function isTauriWebview(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function isResettableBiometricError(message: string): boolean {
  return (
    message.includes("无权读取 Keychain 凭据") ||
    message.includes("还没有为这个钱包启用 Touch ID") ||
    message.includes("not enabled Touch ID") ||
    message.includes("not been enabled")
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForBiometricPromptReadiness(): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (document.visibilityState === "visible" && document.hasFocus()) {
    await wait(250);
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("focus", done);
      document.removeEventListener("visibilitychange", done);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", done);
      document.removeEventListener("visibilitychange", done);
      resolve();
    }, 1800);
    window.addEventListener("focus", done);
    document.addEventListener("visibilitychange", done);
    done();
  });
  await wait(300);
}

function decodeBase64Bytes(value?: string): Uint8Array | null {
  if (!value || typeof window === "undefined") return null;
  try {
    const binary = window.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function dappMessagePreview(value?: string): { text: string; byteLength: number } | null {
  const bytes = decodeBase64Bytes(value);
  if (!bytes) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text: text.replace(/\u0000/g, "\\0"), byteLength: bytes.length };
  } catch {
    return { text: value || "", byteLength: bytes.length };
  }
}

type ThemeOption = { id: AppUiTheme; label: string; icon: ReactNode };

function ThemeSwitcher({
  appTheme,
  compact = false,
  label,
  options,
  onSelect,
}: {
  appTheme: AppUiTheme;
  compact?: boolean;
  label: string;
  options: ThemeOption[];
  onSelect: (theme: AppUiTheme) => void;
}) {
  const [open, setOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement | null>(null);
  const currentThemeOption = options.find((option) => option.id === appTheme) || options[0];

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={switcherRef} className={`app-theme-switcher relative ${compact ? "inline-flex" : "block"}`}>
      {!compact && <p className="mb-2 text-xs font-medium text-gray-400">{label}</p>}
      <button
        type="button"
        onClick={() => setOpen((nextOpen) => !nextOpen)}
        className={`app-theme-menu-button inline-flex h-10 min-w-0 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 text-sm font-semibold text-gray-200 transition-colors hover:bg-white/10 hover:text-white ${
          compact ? "w-10 px-0" : "w-full"
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={currentThemeOption.label}
      >
        {currentThemeOption.icon}
        {!compact && <span className="min-w-0 flex-1 truncate text-left">{currentThemeOption.label}</span>}
        {!compact && <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />}
      </button>
      {open && (
        <div
          className={`app-theme-menu absolute bottom-full z-[140] mb-2 overflow-hidden rounded-lg border border-white/10 bg-black/90 shadow-xl backdrop-blur-xl ${
            compact ? "left-0 w-48" : "left-0 right-0 w-full"
          }`}
          role="menu"
        >
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                onSelect(option.id);
                setOpen(false);
              }}
              className={`flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors ${
                appTheme === option.id
                  ? "bg-white/15 text-white"
                  : "text-gray-300 hover:bg-white/10 hover:text-white"
              }`}
              role="menuitemradio"
              aria-checked={appTheme === option.id}
            >
              {option.icon}
              <span className="truncate">{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const WALLET_PASSWORD_FORM_IDS = new Set([
  "decrypt",
  "unlock",
  "get-pubkey",
  "transfer-sol",
  "transfer-token",
  "create-wsol-ata",
  "wrap-sol",
  "unwrap-sol",
  "close-wsol-ata",
  "create-nonce",
  "program-deploy",
  "program-upgrade",
  "program-invoke",
  "program-invoke-standalone",
  "external-sign",
  "squads-create",
  "squads-sol-transfer",
  "squads-token-transfer",
  "squads-prepare-upgrade-buffer",
  "squads-program-upgrade",
  "squads-set-authority",
  "squads-approve",
  "squads-reject",
  "squads-execute",
  "pumpfun-sell",
  "pumpswap-sell",
  "create-tfa",
  "pumpfun-cashback",
  "pumpswap-cashback",
]);

const PROGRAM_INVOKE_FORM_IDS = new Set(["program-invoke", "program-invoke-standalone"]);

function isProgramInvokeForm(formId: string): boolean {
  return PROGRAM_INVOKE_FORM_IDS.has(formId);
}

const CREATE_PASSWORD_FORM_IDS = new Set([
  "create-encrypted",
  "create-keystore",
  "import-keystore",
  "import-mnemonic",
]);

const MASTER_PASSWORD_FORM_IDS = new Set([
  "setup-2fa",
  "create-tfa",
  "unlock-tfa",
]);

const TOKEN_ACTION_FORM_IDS = new Set(["pumpfun-sell", "transfer-token"]);
const CURRENT_WALLET_TOKEN_BALANCE_FORM_IDS = new Set(["transfer-token", "pumpfun-sell", "pumpswap-sell"]);

const PROGRAM_BUFFER_RECOVERY_STATUSES = new Set([
  "create_buffer_signed",
  "create_buffer_requires_reconciliation",
  "buffer_ready",
  "write_signed",
  "write_confirmed",
  "write_requires_reconciliation",
  "buffer_finalized",
  "deploy_signed",
  "deploy_requires_reconciliation",
]);
const PROGRAM_DEPLOYMENT_STATUSES = new Set([
  ...PROGRAM_BUFFER_RECOVERY_STATUSES,
  "deploy_finalized_pending_readback",
  "finalized",
]);
const PROGRAM_DEPLOYMENT_ATTEMPT_STAGES = new Set([
  "create_buffer",
  "write",
  "deploy",
]);
const PROGRAM_DEPLOYMENT_ATTEMPT_STATUSES = new Set([
  "signed",
  "confirmed",
  "requires_reconciliation",
  "finalized",
  "finalized_failed",
  "expired_absent",
]);

const SOLANA_GENESIS_HASHES: Record<AppNetwork, string> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};
const SOLANA_FAUCET_URL = "https://faucet.solana.com/";
const CIRCLE_FAUCET_URL = "https://faucet.circle.com/";
const PROGRAM_DEPLOY_RESULT_FIELDS = [
  "programId",
  "programdataAddress",
  "bufferAddress",
  "authority",
  "signature",
  "writeCount",
  "skippedWriteCount",
  "rentLamports",
  "estimatedFeesLamports",
  "feeRateReserveLamports",
  "recoveryWriteReserveLamports",
  "totalFeeBudgetLamports",
  "estimatedRequiredBalanceLamports",
  "createBufferSignature",
  "programBytes",
  "programSha256",
  "genesisHash",
  "deployedSlot",
  "finalizedSlot",
  "readbackVerified",
  "deploymentReceiptJson",
  "deploymentReceiptSha256",
] as const;
interface MenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  children?: MenuItem[];
  network?: boolean;
}

interface ProgramKeypairMetadata {
  filename: string;
  programId: string;
}

interface ProgramInvokeState {
  projectId?: string;
  sourceDir?: string;
  idlPath?: string;
  idlFileName?: string;
  idlJsonText: string;
  idl?: AnchorIdlProgram;
  programId: string;
  selectedInstruction: string;
  argValues: Record<string, string>;
  accountValues: Record<string, string>;
  signerWalletIds: Record<string, string>;
  signerPasswords: Record<string, string>;
  loading: boolean;
  error?: string;
  result?: {
    status: string;
    signature?: string;
    simulationError?: string;
    rawSimulationError?: string;
    errorMessage?: string;
    rawErrorMessage?: string;
    logs: string[];
  };
}

function emptyProgramInvokeState(preset: Partial<ProgramInvokeState> = {}): ProgramInvokeState {
  return {
    idlJsonText: "",
    programId: "",
    selectedInstruction: "",
    argValues: {},
    accountValues: {},
    signerWalletIds: {},
    signerPasswords: {},
    loading: false,
    ...preset,
  };
}

type ProgramInvokeWalletPickerTarget =
  | { kind: "arg"; name: string }
  | { kind: "account"; path: string; signer: boolean };

interface ProgramDeploySourceResponse {
  source_dir: string;
  built: boolean;
  build_status?: string | null;
  build_job_id?: string | null;
  build_error?: string | null;
  build_command?: string | null;
  build_template?: string | null;
  build_stdout?: string | null;
  build_stderr?: string | null;
  program_so_path?: string | null;
  program_so_name?: string | null;
  program_so_base64?: string | null;
  program_so_sha256?: string | null;
  program_so_size?: number | null;
  program_keypair_path?: string | null;
  expected_program_id?: string | null;
  manifest_program_id?: string | null;
  manifest_network?: string | null;
  manifest_genesis_hash?: string | null;
  manifest_upgrade_authority?: string | null;
  manifest_owner_admin?: string | null;
  manifest_operational_admin?: string | null;
  build_available: boolean;
  build_blocked_reason?: string | null;
  source_validation_errors?: string[];
  warnings: string[];
}

interface ProgramKeypairArtifactResponse {
  source_dir: string;
  artifact_stem?: string | null;
  program_keypair_path?: string | null;
  expected_program_id?: string | null;
  warnings?: string[];
}

interface ProgramGenerateKeypairResponse {
  source_dir: string;
  artifact_stem: string;
  program_keypair_path: string;
  backup_program_keypair_path?: string | null;
  expected_program_id: string;
  updated_source_files: string[];
  warnings: string[];
}

interface ProgramDeploymentJournalRecord {
  genesis_hash: string;
  program_id: string;
  program_sha256: string;
  program_len: number;
  max_data_len: number;
  upgrade_authority: string;
  buffer_address: string;
  status: string;
  create_signature: string | null;
  create_last_valid_block_height: number | null;
  last_write_signature: string | null;
  last_write_chunk_index: number | null;
  last_write_last_valid_block_height: number | null;
  completed_writes: number;
  deploy_signature: string | null;
  deploy_last_valid_block_height: number | null;
  attempt_evidence_version: number;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface ProgramDeploymentAttemptRecord {
  genesis_hash: string;
  program_id: string;
  stage: string;
  buffer_address: string;
  chunk_index: number | null;
  signature: string;
  last_valid_block_height: number;
  status: string;
  created_at: number;
  updated_at: number;
}

interface ProgramDeploymentJournalIntent {
  requestNetwork: string;
  network: AppNetwork;
  genesisHash: string;
  programId: string;
  programSha256: string;
  programLen: number;
  maxDataLen: number;
  upgradeAuthority: string;
}

interface ProgramDeploymentJournalState {
  intentKey: string;
  network: string;
  genesisHash: string;
  writeChunkBytes: number;
  writeChunkCount: number;
  journal: ProgramDeploymentJournalRecord | null;
  deploymentAttempts: ProgramDeploymentAttemptRecord[];
  conflictingJournal: ProgramDeploymentJournalRecord | null;
  conflictingDeploymentAttempts: ProgramDeploymentAttemptRecord[];
  loading: boolean;
  error?: string;
}

function emptyProgramDeploymentJournalState(): ProgramDeploymentJournalState {
  return {
    intentKey: "",
    network: "",
    genesisHash: "",
    writeChunkBytes: 0,
    writeChunkCount: 0,
    journal: null,
    deploymentAttempts: [],
    conflictingJournal: null,
    conflictingDeploymentAttempts: [],
    loading: false,
  };
}

function omitFormFields(
  state: FormState,
  fields: readonly string[],
): FormState {
  const next = { ...state };
  fields.forEach((field) => {
    delete next[field];
  });
  return next;
}

function programDeploymentIntentKey(intent: ProgramDeploymentJournalIntent): string {
  return JSON.stringify([
    intent.requestNetwork,
    intent.network,
    intent.genesisHash,
    intent.programId,
    intent.programSha256,
    intent.programLen,
    intent.maxDataLen,
    intent.upgradeAuthority,
  ]);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function parseProgramDeploymentJournalRecord(
  value: unknown,
  intent: ProgramDeploymentJournalIntent,
  options: { requireIntentMatch?: boolean } = {},
): ProgramDeploymentJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-journal-record");
  }
  const record = value as Record<string, unknown>;
  const requireIntentMatch = options.requireIntentMatch ?? true;
  const intentFieldsMatch =
    record.genesis_hash === intent.genesisHash &&
    record.program_id === intent.programId &&
    record.program_sha256 === intent.programSha256 &&
    record.program_len === intent.programLen &&
    record.max_data_len === intent.maxDataLen &&
    record.upgrade_authority === intent.upgradeAuthority;
  const conflictScopeMatches =
    record.genesis_hash === intent.genesisHash &&
    record.program_id === intent.programId;
  if (
    (requireIntentMatch ? !intentFieldsMatch : !conflictScopeMatches) ||
    typeof record.program_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(record.program_sha256) ||
    !Number.isSafeInteger(record.program_len) ||
    Number(record.program_len) <= 0 ||
    Number(record.program_len) > MAX_PROGRAM_SO_FILE_BYTES ||
    !Number.isSafeInteger(record.max_data_len) ||
    Number(record.max_data_len) < Number(record.program_len) ||
    Number(record.max_data_len) > MAX_PROGRAM_SO_FILE_BYTES ||
    typeof record.upgrade_authority !== "string" ||
    !isLikelySolanaPublicKey(record.upgrade_authority) ||
    typeof record.buffer_address !== "string" ||
    !isLikelySolanaPublicKey(record.buffer_address) ||
    typeof record.status !== "string" ||
    !PROGRAM_DEPLOYMENT_STATUSES.has(record.status) ||
    !isNullableString(record.create_signature) ||
    !isNullableSafeInteger(record.create_last_valid_block_height) ||
    !isNullableString(record.last_write_signature) ||
    !isNullableSafeInteger(record.last_write_chunk_index) ||
    !isNullableSafeInteger(record.last_write_last_valid_block_height) ||
    !Number.isSafeInteger(record.completed_writes) ||
    Number(record.completed_writes) < 0 ||
    !isNullableString(record.deploy_signature) ||
    !isNullableSafeInteger(record.deploy_last_valid_block_height) ||
    !Number.isSafeInteger(record.attempt_evidence_version) ||
    Number(record.attempt_evidence_version) <= 0 ||
    !Number.isSafeInteger(record.revision) ||
    Number(record.revision) < 0 ||
    !Number.isSafeInteger(record.created_at) ||
    Number(record.created_at) < 0 ||
    !Number.isSafeInteger(record.updated_at) ||
    Number(record.updated_at) < Number(record.created_at)
  ) {
    throw new Error("invalid-journal-record");
  }
  return record as unknown as ProgramDeploymentJournalRecord;
}

function parseProgramDeploymentAttemptRecord(
  value: unknown,
  intent: ProgramDeploymentJournalIntent,
): ProgramDeploymentAttemptRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-deployment-attempt");
  }
  const record = value as Record<string, unknown>;
  const stage = String(record.stage || "");
  const chunkIndex = record.chunk_index;
  const hasWriteChunkIndex = Number.isSafeInteger(chunkIndex) && Number(chunkIndex) >= 0;
  if (
    record.genesis_hash !== intent.genesisHash ||
    record.program_id !== intent.programId ||
    !PROGRAM_DEPLOYMENT_ATTEMPT_STAGES.has(stage) ||
    typeof record.buffer_address !== "string" ||
    !isLikelySolanaPublicKey(record.buffer_address) ||
    (stage === "write" ? !hasWriteChunkIndex : chunkIndex !== null) ||
    typeof record.signature !== "string" ||
    !PROGRAM_DEPLOYMENT_ATTEMPT_STATUSES.has(String(record.status || "")) ||
    !Number.isSafeInteger(record.last_valid_block_height) ||
    Number(record.last_valid_block_height) < 0 ||
    !Number.isSafeInteger(record.created_at) ||
    Number(record.created_at) < 0 ||
    !Number.isSafeInteger(record.updated_at) ||
    Number(record.updated_at) < Number(record.created_at)
  ) {
    throw new Error("invalid-deployment-attempt");
  }
  return record as unknown as ProgramDeploymentAttemptRecord;
}

function programDeploymentJournalToHistoryItem(
  project: ProgramProject,
  journal: ProgramDeploymentJournalRecord,
  attempts: ProgramDeploymentAttemptRecord[],
  network: AppNetwork,
  status: ProgramDeploymentPlanStatus,
): ProgramDeploymentHistoryItem {
  const signature =
    journal.deploy_signature ||
    [...attempts]
      .sort((a, b) => b.updated_at - a.updated_at)
      .find((attempt) => attempt.signature)?.signature ||
    journal.create_signature ||
    null;
  return {
    id: `journal-card:${journal.genesis_hash}:${journal.program_id}:${journal.program_sha256}:${journal.buffer_address}:${journal.revision}`,
    projectId: project.id,
    kind: "direct-deploy",
    status,
    network,
    sourceDir: project.sourceDir,
    programId: journal.program_id,
    upgradeAuthority: journal.upgrade_authority,
    bufferAddress: journal.buffer_address,
    programSha256: journal.program_sha256,
    programBytes: journal.program_len,
    maxDataLen: journal.max_data_len,
    deploySignature: journal.deploy_signature,
    createBufferSignature: journal.create_signature,
    signature,
    createdAt: journal.created_at * 1000,
    completedAt: journal.status === "finalized" ? journal.updated_at * 1000 : undefined,
  };
}

function programDeploymentRecordsMatch(
  record: ProgramDeploymentHistoryItem,
  journal: ProgramDeploymentHistoryItem,
): boolean {
  const optionalMatches = (left: unknown, right: unknown) =>
    left === undefined || left === null || left === "" || right === undefined || right === null || right === "" || left === right;
  return (
    record.kind === journal.kind &&
    record.network === journal.network &&
    record.programId === journal.programId &&
    optionalMatches(record.programSha256, journal.programSha256) &&
    optionalMatches(record.programBytes, journal.programBytes) &&
    optionalMatches(record.maxDataLen, journal.maxDataLen) &&
    optionalMatches(record.upgradeAuthority, journal.upgradeAuthority)
  );
}

function mergeProgramDeploymentHistoryWithJournal(
  record: ProgramDeploymentHistoryItem,
  journal: ProgramDeploymentHistoryItem | null,
): ProgramDeploymentHistoryItem {
  if (!journal || !programDeploymentRecordsMatch(record, journal)) return record;
  return {
    ...record,
    status: journal.status,
    bufferAddress: journal.bufferAddress || record.bufferAddress,
    deploySignature: journal.deploySignature || record.deploySignature,
    createBufferSignature: journal.createBufferSignature || record.createBufferSignature,
    signature: journal.signature || record.signature,
    completedAt: journal.completedAt || record.completedAt,
  };
}

function planMatchesHistoryRecord(
  plan: ProgramDeploymentPlan,
  record: Pick<
    ProgramDeploymentHistoryItem,
    "kind" | "programId" | "network" | "proposal" | "bufferAddress"
  > | null | undefined,
): boolean {
  if (!record) return false;
  if (plan.network !== record.network) return false;
  const planProgramId = String(plan.result?.programId || plan.programId || "").trim();
  const recordProgramId = String(record.programId || "").trim();
  if (planProgramId && recordProgramId && planProgramId !== recordProgramId) return false;
  if (plan.kind === "direct-deploy") return record.kind === "direct-deploy";
  if (plan.kind === "direct-upgrade") return record.kind === "direct-upgrade";
  if (plan.kind === "squads-upgrade") {
    const planProposal = String(plan.proposal || "").trim();
    const recordProposal = String(record.proposal || "").trim();
    if (planProposal && recordProposal) return planProposal === recordProposal;
    const planBuffer = String(plan.result?.bufferAddress || plan.bufferAddress || "").trim();
    const recordBuffer = String(record.bufferAddress || "").trim();
    if (planBuffer && recordBuffer && planBuffer === recordBuffer) {
      return record.kind.startsWith("squads-upgrade");
    }
    return record.kind.startsWith("squads-upgrade");
  }
  return false;
}

function programDeploymentHistoryDedupeKey(record: ProgramDeploymentHistoryItem): string {
  if (record.kind !== "direct-deploy" || !record.programId) {
    return record.id;
  }
  const anchor =
    record.deploySignature ||
    record.bufferAddress ||
    record.programSha256 ||
    record.createBufferSignature ||
    record.signature ||
    "";
  return [
    record.kind,
    record.network,
    record.programId,
    anchor,
  ].join(":");
}

function programDeploymentHistoryRank(record: ProgramDeploymentHistoryItem): number {
  const statusRank =
    record.status === "finalized" ? 100 :
      record.status === "failed" ? 60 :
        record.status === "running" ? 40 :
          20;
  const detailRank = [
    record.deploySignature,
    record.createBufferSignature,
    record.bufferAddress,
    record.programSha256,
    record.programBytes,
    record.maxDataLen,
    record.completedAt,
  ].filter(Boolean).length;
  return statusRank + detailRank;
}

function dedupeProgramDeploymentHistory(
  records: ProgramDeploymentHistoryItem[],
): ProgramDeploymentHistoryItem[] {
  const merged = new Map<string, ProgramDeploymentHistoryItem>();
  records.forEach((record) => {
    const key = programDeploymentHistoryDedupeKey(record);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, record);
      return;
    }
    const [primary, secondary] =
      programDeploymentHistoryRank(record) >= programDeploymentHistoryRank(existing)
        ? [record, existing]
        : [existing, record];
    merged.set(key, {
      ...secondary,
      ...primary,
      id: primary.id,
      createdAt: Math.min(primary.createdAt, secondary.createdAt),
      completedAt: primary.completedAt || secondary.completedAt,
      deploySignature: primary.deploySignature || secondary.deploySignature,
      createBufferSignature: primary.createBufferSignature || secondary.createBufferSignature,
      authoritySignature: primary.authoritySignature || secondary.authoritySignature,
      signature: primary.signature || secondary.signature,
      bufferAddress: primary.bufferAddress || secondary.bufferAddress,
      programSha256: primary.programSha256 || secondary.programSha256,
      programBytes: primary.programBytes || secondary.programBytes,
      maxDataLen: primary.maxDataLen || secondary.maxDataLen,
      upgradeAuthority: primary.upgradeAuthority || secondary.upgradeAuthority,
    });
  });
  return [...merged.values()];
}

type WorkspaceProposalAction = "approve" | "reject" | "execute";
type PasswordPromptField = "password" | "master_password";
type ExportBundleItem = "keystore" | "private-key" | "mnemonic";

type ExportBundleSelection = Record<ExportBundleItem, boolean>;

type PasswordPromptRequest =
  | { kind: "form"; formId: string; formState: FormState; fields?: PasswordPromptField[] }
  | { kind: "create-password"; formId: string; formState: FormState }
  | { kind: "master-password"; formId: string; formState: FormState }
  | { kind: "proposal"; proposal: WorkspaceProposal; action: WorkspaceProposalAction; formState: FormState }
  | { kind: "enable-biometric"; wallet: SavedWallet; formState: FormState }
  | { kind: "export-bundle"; wallet: SavedWallet; formState: FormState }
  | { kind: "export-keystore"; wallet: SavedWallet; formState: FormState }
  | { kind: "export-private-key"; wallet: SavedWallet; formState: FormState }
  | { kind: "export-mnemonic"; wallet: SavedWallet; formState: FormState }
  | { kind: "migrate-keystore"; wallet: SavedWallet; formState: FormState };

interface ExportedPrivateKeyPreview {
  walletName: string;
  publicKey: string;
  privateKey: string;
}

interface ExportedMnemonicPreview {
  walletName: string;
  publicKey: string;
  mnemonic: string;
}

type SensitiveExportKind = "private-key" | "mnemonic";

interface SensitiveExportPreview {
  kind: SensitiveExportKind;
  walletName: string;
  publicKey: string;
  value: string;
  title: string;
  hint: string;
  warning: string;
  qrCanvasLabel: string;
  plaintextLabel: string;
  temporaryHint: string;
  hiddenLabel: string;
  segmentsTitle: string;
  segmentsHelp: string;
  segmentsHint: string;
  copyLabel: string;
  downloadLabel: string;
  downloadSuffix: string;
  copyId: string;
  segmentCopyPrefix: string;
  qrFailedMessage: string;
}

type PrivateKeyExportMode = "simple" | "advanced";

const MIN_PRIVATE_KEY_SEGMENTS = 1;
const MAX_PRIVATE_KEY_SEGMENTS = 12;
const DEFAULT_PRIVATE_KEY_SEGMENTS = 1;

function clampPrivateKeySegmentCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PRIVATE_KEY_SEGMENTS;
  return Math.min(MAX_PRIVATE_KEY_SEGMENTS, Math.max(MIN_PRIVATE_KEY_SEGMENTS, Math.round(value)));
}

function splitPrivateKeyIntoSegments(privateKey: string, count: number): string[] {
  const safeCount = clampPrivateKeySegmentCount(count);
  const baseSize = Math.floor(privateKey.length / safeCount);
  const remainder = privateKey.length % safeCount;
  let offset = 0;
  return Array.from({ length: safeCount }, (_, index) => {
    const size = baseSize + (index < remainder ? 1 : 0);
    const segment = privateKey.slice(offset, offset + size);
    offset += size;
    return segment;
  });
}

function splitSensitiveExportIntoSegments(value: string, count: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const safeCount = clampPrivateKeySegmentCount(count);
    const baseSize = Math.floor(words.length / safeCount);
    const remainder = words.length % safeCount;
    let offset = 0;
    return Array.from({ length: safeCount }, (_, index) => {
      const size = baseSize + (index < remainder ? 1 : 0);
      const segment = words.slice(offset, offset + size).join(" ");
      offset += size;
      return segment;
    });
  }
  return splitPrivateKeyIntoSegments(value, count);
}

interface BiometricWalletStatus {
  supported: boolean;
  configured: boolean;
  reason?: string | null;
}

type DappId =
  | "jupiter"
  | "pumpfun"
  | "raydium"
  | "meteora"
  | "orca"
  | "drift"
  | "kamino"
  | "tensor"
  | "magiceden"
  | "sanctum";
type DappChain = "Solana" | "Ethereum" | "BSC" | "Polygon" | "Sui";
type DappCategoryId = "trend" | "defi" | "trading" | "nft" | "staking";

interface DappCatalogItem {
  id: DappId;
  name: string;
  url: string;
  domains: string[];
  chain: DappChain;
  category: Exclude<DappCategoryId, "trend">;
  description: string;
  tags: string[];
  rank: number;
  metricLabel: string;
  metricValue: string;
  accentClass: string;
  iconClass: string;
  logoUrl: string;
}

interface DappBrowserTab {
  id: string;
  title: string;
  url: string;
  addressInput: string;
  closable: boolean;
  showAddressBar: boolean;
  appId?: DappId;
  walletConnected: boolean;
  webviewOpen: boolean;
  loading: boolean;
}

interface DappSignRequestEvent {
  request_id: string;
  app_id: string;
  app_name: string;
  app_url: string;
  request_purpose?: string;
  method: "signTransaction" | "signAllTransactions" | "signAndSendTransaction" | "sendTransaction" | "signMessage" | string;
  wallet_public_key: string;
  network: string;
  transaction_base64: string;
  transaction_format: "legacy" | "versioned" | "v0" | "auto" | string;
  message_base64?: string;
  callback_url?: string;
  known_programs?: Array<{ program_id: string; label: string }>;
  created_at_ms: number;
}

interface DappConnectRequestEvent {
  request_id: string;
  app_id: string;
  app_name: string;
  app_url: string;
  network: string;
  callback_url: string;
  created_at_ms: number;
}

interface DappSignResult {
  approved: boolean;
  error?: string;
  public_key?: string;
  signature?: string;
  raw_transaction?: string;
  recent_blockhash?: string;
}

interface DappTransactionInstructionPreview {
  index: number;
  program_id: string;
  account_count: number;
  data_bytes: number;
}

interface DappTransactionPreview {
  status: string;
  transaction_format: string;
  recent_blockhash: string;
  required_signatures: number;
  required_signer_present: boolean;
  signer_accounts: string[];
  writable_accounts: string[];
  readonly_accounts: string[];
  programs: string[];
  instructions: DappTransactionInstructionPreview[];
  warnings: string[];
}

const DAPP_CATEGORIES: DappCategoryId[] = ["trend", "defi", "trading", "nft", "staking"];
const DAPP_CATALOG: DappCatalogItem[] = [
  {
    id: "jupiter",
    name: "Jupiter",
    url: "https://jup.ag/swap",
    domains: ["jup.ag"],
    chain: "Solana",
    category: "trading",
    description: "Swap aggregator, limit orders, DCA, and liquidity routing for Solana.",
    tags: ["Swap", "Aggregator", "Perps"],
    rank: 1,
    metricLabel: "Category",
    metricValue: "DEX",
    accentClass: "from-teal-300/35 via-sky-400/25 to-amber-300/25",
    iconClass: "bg-teal-300 text-zinc-950",
    logoUrl: "https://jup.ag/favicon.ico",
  },
  {
    id: "pumpfun",
    name: "pump.fun",
    url: "https://pump.fun/",
    domains: ["pump.fun"],
    chain: "Solana",
    category: "trading",
    description: "Token launch and discovery venue for Solana meme assets.",
    tags: ["Launchpad", "Meme", "Token"],
    rank: 2,
    metricLabel: "Category",
    metricValue: "Launch",
    accentClass: "from-lime-300/35 via-emerald-400/20 to-pink-400/25",
    iconClass: "bg-lime-300 text-zinc-950",
    logoUrl: "https://pump.fun/favicon.ico",
  },
  {
    id: "raydium",
    name: "Raydium",
    url: "https://raydium.io/swap/",
    domains: ["raydium.io"],
    chain: "Solana",
    category: "defi",
    description: "AMM swaps, concentrated liquidity pools, and DeFi routing.",
    tags: ["DEX", "Liquidity", "AMM"],
    rank: 3,
    metricLabel: "Category",
    metricValue: "DeFi",
    accentClass: "from-cyan-300/35 via-blue-400/25 to-fuchsia-400/20",
    iconClass: "bg-cyan-300 text-zinc-950",
    logoUrl: "https://raydium.io/favicon.ico",
  },
  {
    id: "meteora",
    name: "Meteora",
    url: "https://app.meteora.ag/",
    domains: ["meteora.ag"],
    chain: "Solana",
    category: "defi",
    description: "Dynamic liquidity markets and yield infrastructure on Solana.",
    tags: ["Liquidity", "Yield", "DLMM"],
    rank: 4,
    metricLabel: "Category",
    metricValue: "DeFi",
    accentClass: "from-orange-300/35 via-rose-300/20 to-sky-400/25",
    iconClass: "bg-orange-300 text-zinc-950",
    logoUrl: "https://app.meteora.ag/icons/v2.svg",
  },
  {
    id: "orca",
    name: "Orca",
    url: "https://www.orca.so/",
    domains: ["orca.so"],
    chain: "Solana",
    category: "defi",
    description: "Solana DEX with Whirlpool concentrated liquidity markets.",
    tags: ["DEX", "Whirlpools", "Liquidity"],
    rank: 5,
    metricLabel: "Category",
    metricValue: "DEX",
    accentClass: "from-sky-300/35 via-indigo-300/20 to-emerald-300/25",
    iconClass: "bg-sky-300 text-zinc-950",
    logoUrl: "https://www.orca.so/favicon.ico",
  },
  {
    id: "drift",
    name: "Drift",
    url: "https://app.drift.trade/",
    domains: ["drift.trade"],
    chain: "Solana",
    category: "trading",
    description: "Perpetuals, spot markets, lending, and structured trading.",
    tags: ["Perps", "Trading", "Lending"],
    rank: 6,
    metricLabel: "Category",
    metricValue: "Perps",
    accentClass: "from-violet-300/35 via-cyan-300/20 to-slate-200/20",
    iconClass: "bg-violet-300 text-zinc-950",
    logoUrl: "https://app.drift.trade/favicon.ico",
  },
  {
    id: "kamino",
    name: "Kamino",
    url: "https://app.kamino.finance/",
    domains: ["kamino.finance"],
    chain: "Solana",
    category: "defi",
    description: "Lending markets, multiply vaults, and liquidity strategies.",
    tags: ["Lending", "Vaults", "Yield"],
    rank: 7,
    metricLabel: "Category",
    metricValue: "Lend",
    accentClass: "from-emerald-300/35 via-lime-300/20 to-cyan-300/25",
    iconClass: "bg-emerald-300 text-zinc-950",
    logoUrl: "https://app.kamino.finance/favicon.ico",
  },
  {
    id: "tensor",
    name: "Tensor",
    url: "https://www.tensor.trade/",
    domains: ["tensor.trade"],
    chain: "Solana",
    category: "nft",
    description: "NFT marketplace and pro trading surface for Solana collections.",
    tags: ["NFT", "Marketplace", "Trading"],
    rank: 8,
    metricLabel: "Category",
    metricValue: "NFT",
    accentClass: "from-fuchsia-300/35 via-violet-300/25 to-cyan-300/20",
    iconClass: "bg-fuchsia-300 text-zinc-950",
    logoUrl: "https://www.tensor.trade/favicon.ico",
  },
  {
    id: "magiceden",
    name: "Magic Eden",
    url: "https://magiceden.io/",
    domains: ["magiceden.io"],
    chain: "Solana",
    category: "nft",
    description: "NFT marketplace with Solana collection discovery and trading.",
    tags: ["NFT", "Marketplace", "Collectibles"],
    rank: 9,
    metricLabel: "Category",
    metricValue: "NFT",
    accentClass: "from-pink-300/35 via-purple-300/20 to-amber-200/25",
    iconClass: "bg-pink-300 text-zinc-950",
    logoUrl: "https://magiceden.io/img/favicon/android-chrome-192x192.png",
  },
  {
    id: "sanctum",
    name: "Sanctum",
    url: "https://app.sanctum.so/",
    domains: ["sanctum.so"],
    chain: "Solana",
    category: "staking",
    description: "Liquid staking, LST swaps, and validator-backed yield routes.",
    tags: ["LST", "Staking", "Yield"],
    rank: 10,
    metricLabel: "Category",
    metricValue: "Stake",
    accentClass: "from-amber-200/35 via-teal-300/20 to-indigo-300/25",
    iconClass: "bg-amber-200 text-zinc-950",
    logoUrl: "https://app.sanctum.so/favicon.ico",
  },
];
const SOLANA_DAPP_CATALOG = DAPP_CATALOG.filter((dapp) => dapp.chain === "Solana");

function DappLogo({ dapp, size = "md" }: { dapp: DappCatalogItem; size?: "sm" | "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const sizeClass = size === "sm" ? "h-8 w-8" : size === "lg" ? "h-11 w-11" : "h-10 w-10";
  const imageSizeClass = size === "sm" ? "h-6 w-6" : size === "lg" ? "h-8 w-8" : "h-7 w-7";
  if (failed) {
    return (
      <span className={`inline-flex ${sizeClass} shrink-0 items-center justify-center rounded-lg text-sm font-bold ${dapp.iconClass}`}>
        {dapp.name.slice(0, 1)}
      </span>
    );
  }
  return (
    <span className={`inline-flex ${sizeClass} shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white p-1 shadow-sm`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Remote DApp favicons need per-image fallback handling. */}
      <img
        src={dapp.logoUrl}
        alt={`${dapp.name} logo`}
        className={`${imageSizeClass} object-contain`}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

const DAPP_HOME_TAB_ID = "dapp-home";
const DAPP_HOME_TAB: DappBrowserTab = {
  id: DAPP_HOME_TAB_ID,
  title: "DApp 首页",
  url: "",
  addressInput: "",
  closable: false,
  showAddressBar: false,
  walletConnected: false,
  webviewOpen: false,
  loading: false,
};

interface DappTabUrlEvent {
  tab_id: string;
  url: string;
  loaded?: boolean;
}

interface DappTabTitleEvent {
  tab_id: string;
  title: string;
}

interface DappNewWindowEvent {
  source_tab_id: string;
  url: string;
}

function newDappTabId(): string {
  return `dapp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDappBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol === "https:") return parsed.toString();
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1")
  ) {
    return parsed.toString();
  }
  throw new Error("只支持 https 网址，或本机 localhost http 地址。");
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function dappForUrl(url: string): DappCatalogItem | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:") return undefined;
    return SOLANA_DAPP_CATALOG.find((dapp) => dapp.domains.some((domain) => hostMatchesDomain(host, domain)));
  } catch {
    return undefined;
  }
}

function dappNativeWindowTopOffset(): number {
  if (typeof window === "undefined" || !isTauriWebview()) return 0;
  const measured = Math.round(window.outerHeight - window.innerHeight);
  if (Number.isFinite(measured) && measured > 0 && measured <= 96) return measured;
  const platform = window.navigator.platform.toLowerCase();
  return platform.includes("mac") ? 32 : 0;
}

interface WalletTokenAsset {
  account: string;
  mint: string;
  amount: string;
  ui_amount_string: string;
  decimals: number;
  name?: string;
  symbol?: string;
  logo_uri?: string;
}

interface WalletAssetsState {
  address: string;
  network: AppNetwork;
  solBalance: string;
  tokens: WalletTokenAsset[];
  loading: boolean;
  refreshing?: boolean;
  cached?: boolean;
  updatedAt?: number;
  error?: string;
}

interface WalletTransactionRecord {
  signature: string;
  slot: number;
  block_time?: number | null;
  confirmation_status?: string | null;
  err?: unknown;
  memo?: string | null;
  action?: string;
  summary?: string;
  counterparty?: string | null;
  programs?: string[];
  changes?: WalletTransactionChange[];
}

interface WalletTransactionChange {
  asset: string;
  mint?: string | null;
  amount: string;
  ui_amount: string;
  direction: "in" | "out";
  decimals: number;
}

interface WalletTransactionsState {
  address: string;
  network: AppNetwork;
  transactions: WalletTransactionRecord[];
  nextBefore?: string;
  hasMore: boolean;
  loaded: number;
  loading: boolean;
  error?: string;
}

interface DesktopEvmChainConfig {
  chain_id: number;
  name: string;
  native_symbol: string;
  rpc_url: string;
  explorer_url?: string | null;
  testnet: boolean;
}

interface DesktopEvmWalletSummary {
  id: string;
  name: string;
  address: string;
  derivation_path?: string | null;
}

interface DesktopEvmWalletKeystore {
  wallet: DesktopEvmWalletSummary;
  keystore_json: string;
}

interface DesktopEvmTokenAsset {
  contract_address: string;
  symbol: string;
  name: string;
  balance: string;
  decimals: number;
}

interface DesktopEvmTransactionHistoryEntry {
  hash: string;
  block_number?: number | null;
  status: string;
}

interface DesktopEvmAssetSnapshot {
  chain: DesktopEvmChainConfig;
  wallet_address: string;
  native_balance_wei: string;
  tokens: DesktopEvmTokenAsset[];
  recent_transactions: DesktopEvmTransactionHistoryEntry[];
  history_status: string;
  history_message?: string | null;
  refreshed_at_ms: number;
}

interface DesktopEvmPaymentPreview {
  preview_id: string;
  chain: DesktopEvmChainConfig;
  wallet_address: string;
  recipient: string;
  token_contract?: string | null;
  amount_wei_or_units: string;
  gas_limit: string;
  gas_price_wei: string;
  max_fee_per_gas_wei?: string | null;
  max_priority_fee_per_gas_wei?: string | null;
  fee_model: string;
  nonce: string;
  estimated_fee_wei: string;
  summary: string;
  warnings: string[];
}

interface DesktopEvmTransactionSubmitResult {
  transaction_hash: string;
  chain: DesktopEvmChainConfig;
  submitted_at: string;
  status: string;
  block_number?: number | null;
}

interface DesktopEvmTransactionStatus {
  transaction_hash: string;
  chain: DesktopEvmChainConfig;
  block_number?: number | null;
  status: string;
  gas_used?: string | null;
  effective_gas_price_wei?: string | null;
}

const DESKTOP_EVM_CUSTOM_CHAINS_STORAGE_KEY = "fnzero.desktop.evm.custom_chains.v1";
const DESKTOP_EVM_SELECTED_CHAIN_STORAGE_KEY = "fnzero.desktop.evm.selected_chain.v1";
const DESKTOP_EVM_TOKENS_STORAGE_PREFIX = "fnzero.desktop.evm.tokens.v1";

function isDesktopEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function normalizeDesktopEvmChain(value: unknown): DesktopEvmChainConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const chainId = Number(record.chain_id);
  const name = String(record.name || "").trim();
  const nativeSymbol = String(record.native_symbol || "").trim();
  const rpcUrl = String(record.rpc_url || "").trim();
  const explorerUrl = String(record.explorer_url || "").trim();
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !name ||
    !nativeSymbol ||
    !/^https?:\/\//.test(rpcUrl) ||
    (explorerUrl && !/^https?:\/\//.test(explorerUrl))
  ) {
    return null;
  }
  return {
    chain_id: chainId,
    name,
    native_symbol: nativeSymbol,
    rpc_url: rpcUrl,
    explorer_url: explorerUrl || null,
    testnet: Boolean(record.testnet),
  };
}

function loadStoredDesktopEvmChains(): DesktopEvmChainConfig[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DESKTOP_EVM_CUSTOM_CHAINS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeDesktopEvmChain).filter((item): item is DesktopEvmChainConfig => Boolean(item));
  } catch {
    return [];
  }
}

function saveStoredDesktopEvmChains(chains: DesktopEvmChainConfig[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DESKTOP_EVM_CUSTOM_CHAINS_STORAGE_KEY, JSON.stringify(chains));
}

function loadStoredDesktopEvmChainId(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(DESKTOP_EVM_SELECTED_CHAIN_STORAGE_KEY) || "";
}

function saveStoredDesktopEvmChainId(chainId: string) {
  if (typeof window === "undefined") return;
  const normalized = chainId.trim();
  if (normalized) {
    window.localStorage.setItem(DESKTOP_EVM_SELECTED_CHAIN_STORAGE_KEY, normalized);
  } else {
    window.localStorage.removeItem(DESKTOP_EVM_SELECTED_CHAIN_STORAGE_KEY);
  }
}

function desktopEvmTokenStorageKey(chainId: number, walletAddress: string): string {
  return `${DESKTOP_EVM_TOKENS_STORAGE_PREFIX}.${chainId}.${walletAddress.toLowerCase()}`;
}

function loadStoredDesktopEvmTokens(chainId: number, walletAddress: string): string[] {
  if (typeof window === "undefined" || !walletAddress) return [];
  try {
    const raw = window.localStorage.getItem(desktopEvmTokenStorageKey(chainId, walletAddress));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item): item is string => isDesktopEvmAddress(item));
  } catch {
    return [];
  }
}

function saveStoredDesktopEvmTokens(chainId: number, walletAddress: string, tokens: string[]) {
  if (typeof window === "undefined" || !walletAddress) return;
  const normalized = Array.from(new Map(
    tokens
      .map((token) => token.trim())
      .filter(isDesktopEvmAddress)
      .map((token) => [token.toLowerCase(), token]),
  ).values());
  window.localStorage.setItem(desktopEvmTokenStorageKey(chainId, walletAddress), JSON.stringify(normalized));
}

interface NonceAccountRecord {
  id: string;
  wallet_id?: string;
  owner: string;
  network: AppNetwork;
  nonce_account: string;
  signature: string;
  created_at: number;
}

interface NonceAccountsState {
  owner: string;
  network: AppNetwork;
  nonceAccounts: NonceAccountRecord[];
  loading: boolean;
  error?: string;
}

interface CreatedNonceAccount {
  nonce_account?: string;
  signature?: string;
}

interface TokenMintInfoState {
  mint: string;
  network: AppNetwork;
  decimals?: number;
  supply?: string;
  uiAmountString?: string;
  loading: boolean;
  error?: string;
}

interface CashbackInfoState {
  owner: string;
  network: AppNetwork;
  dex: "pumpfun" | "pumpswap";
  accumulator?: string;
  amountLamports?: number;
  uiAmountString?: string;
  asset?: string;
  available?: boolean;
  loading: boolean;
  error?: string;
}

type ExternalSignInputMode = "json" | "form";

interface ExternalSignAccountSummary {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

interface ExternalSignRequestSummary {
  valid: boolean;
  schema?: string;
  operation?: string;
  cluster?: string;
  network?: string;
  clusterGenesisHash?: string;
  programId?: string;
  bridgeMint?: string;
  requiredSigner?: string;
  transactionBase64?: string;
  dataBase64?: string;
  requestId?: string;
  recipient?: string;
  amount?: string;
  expiresAt?: string;
  recentBlockhash?: string;
  lastValidBlockHeight?: string;
  signerCount: number;
  writableCount: number;
  accounts: ExternalSignAccountSummary[];
}

interface ExternalSignInstructionAccountRequest {
  pubkey: string;
  is_signer: boolean;
  is_writable: boolean;
}

interface ExternalSignInstructionRequest {
  programId: string;
  instructionName: string;
  dataBase64: string;
  network?: string;
  requiredSigner?: string;
  requestId?: string;
  accounts: ExternalSignInstructionAccountRequest[];
}

function networkLabel(t: (key: string, vars?: Record<string, string | number>) => string, network: AppNetwork): string {
  return t(`features.check-balance.${network}`);
}

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

function shortSignature(value: string): string {
  return value.length > 20 ? `${value.slice(0, 8)}...${value.slice(-8)}` : value;
}

function externalSignRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function externalSignString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return "";
}

function parseExternalSignRequestSummary(raw: string): ExternalSignRequestSummary | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { valid: false, signerCount: 0, writableCount: 0, accounts: [] };
  }

  const request = externalSignRecord(parsed);
  if (!request) {
    return { valid: false, signerCount: 0, writableCount: 0, accounts: [] };
  }

  const transaction = externalSignRecord(request.transaction);
  const args = externalSignRecord(request.arguments);
  const readString = (...keys: string[]) => {
    for (const key of keys) {
      const value = externalSignString(request[key]) || externalSignString(transaction?.[key]) || externalSignString(args?.[key]);
      if (value) return value;
    }
    return "";
  };

  const accounts = Array.isArray(request.accounts)
    ? request.accounts
        .map((account): ExternalSignAccountSummary | null => {
          const record = externalSignRecord(account);
          const pubkey = externalSignString(record?.pubkey);
          if (!pubkey) return null;
          return {
            pubkey,
            isSigner: Boolean(record?.isSigner ?? record?.is_signer),
            isWritable: Boolean(record?.isWritable ?? record?.is_writable),
          };
        })
        .filter((account): account is ExternalSignAccountSummary => Boolean(account))
    : [];
  const requiredSigner =
    readString("requiredSigner", "required_signer", "signer", "signerPubkey", "signer_pubkey", "walletPublicKey", "wallet_public_key") ||
    accounts.find((account) => account.isSigner)?.pubkey ||
    "";
  const dataBase64 = readString("dataBase64", "data_base64", "instructionDataBase64", "instruction_data_base64");
  const transactionBase64 = readString("transactionBase64", "transaction_base64", "txBase64", "tx_base64", "base64");

  return {
    valid: true,
    schema: readString("schema"),
    operation: readString("operation", "method", "instruction"),
    cluster: readString("cluster"),
    network: readString("network"),
    clusterGenesisHash: readString("clusterGenesisHash", "cluster_genesis_hash", "expectedGenesisHash", "expected_genesis_hash", "genesisHash", "genesis_hash"),
    programId: readString("programId", "program_id"),
    bridgeMint: readString("bridgeMint", "bridge_mint", "mint"),
    requiredSigner,
    transactionBase64,
    dataBase64,
    requestId: readString("requestId", "request_id", "requestID", "id", "orderId", "order_id"),
    recipient: readString("recipient", "to", "destination", "destinationOwner", "destination_owner"),
    amount: readString("amount", "amountLamports", "amount_lamports", "rawAmount", "raw_amount"),
    expiresAt: readString("expiresAt", "expires_at"),
    recentBlockhash: readString("recentBlockhash", "recent_blockhash"),
    lastValidBlockHeight: readString("lastValidBlockHeight", "last_valid_block_height"),
    signerCount: accounts.filter((account) => account.isSigner).length,
    writableCount: accounts.filter((account) => account.isWritable).length,
    accounts,
  };
}

function parseExternalSignInstructionRequest(raw: string): ExternalSignInstructionRequest | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const request = externalSignRecord(parsed);
  if (!request) return null;
  const args = externalSignRecord(request.arguments);
  const transaction = externalSignRecord(request.transaction);
  const readString = (...keys: string[]) => {
    for (const key of keys) {
      const value = externalSignString(request[key]) || externalSignString(transaction?.[key]) || externalSignString(args?.[key]);
      if (value) return value;
    }
    return "";
  };
  const programId = readString("programId", "program_id");
  const dataBase64 = readString("dataBase64", "data_base64", "instructionDataBase64", "instruction_data_base64");
  if (!programId || !dataBase64 || !Array.isArray(request.accounts)) return null;

  const accounts = request.accounts
    .map((account): ExternalSignInstructionAccountRequest | null => {
      const record = externalSignRecord(account);
      const pubkey = externalSignString(record?.pubkey);
      if (!pubkey) return null;
      return {
        pubkey,
        is_signer: Boolean(record?.isSigner ?? record?.is_signer),
        is_writable: Boolean(record?.isWritable ?? record?.is_writable),
      };
    })
    .filter((account): account is ExternalSignInstructionAccountRequest => Boolean(account));
  if (accounts.length === 0) return null;

  const requiredSigner =
    readString("requiredSigner", "required_signer", "signer", "signerPubkey", "signer_pubkey", "walletPublicKey", "wallet_public_key") ||
    accounts.find((account) => account.is_signer)?.pubkey ||
    "";

  return {
    programId,
    instructionName: readString("operation", "method", "instruction", "instructionName", "instruction_name") || "external_sign_instruction",
    dataBase64,
    network: readString("network", "cluster"),
    requiredSigner,
    requestId: readString("requestId", "request_id", "requestID", "id", "orderId", "order_id"),
    accounts,
  };
}

function programDeploymentHistorySignature(item: ProgramDeploymentHistoryItem): string | null {
  return item.deploySignature || item.signature || item.createBufferSignature || item.authoritySignature || null;
}

function lastFinalizedProgramArtifactSha(
  project: ProgramProject | null | undefined,
  programIdValue: unknown,
): string | null {
  const programId = String(programIdValue || "").trim();
  if (!project || !programId) return null;
  // Only trust finalized deploy/upgrade *history* entries. Do not fall back to
  // project.programSha256 — that field is refreshed on every source import and
  // would make a freshly imported .so look "already deployed".
  const finalized = [...(project.history || [])]
    .filter((item) => {
      if (item.status !== "finalized") return false;
      if (String(item.programId || "").trim() !== programId) return false;
      if (!(item.kind === "direct-deploy" || item.kind === "direct-upgrade" || item.kind === "squads-upgrade-execute")) {
        return false;
      }
      return Boolean(String(item.programSha256 || "").trim());
    })
    .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));
  const fromHistory = String(finalized[0]?.programSha256 || "").trim().toLowerCase();
  return fromHistory || null;
}

function isStaleProgramUpgradeArtifact(
  project: ProgramProject | null | undefined,
  programIdValue: unknown,
  programSha256Value: unknown,
): boolean {
  const currentSha = String(programSha256Value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(currentSha)) return false;
  const lastSha = lastFinalizedProgramArtifactSha(project, programIdValue);
  return Boolean(lastSha && lastSha === currentSha);
}

function solscanTransactionUrl(signature: string, network: AppNetwork): string {
  const baseUrl = `https://solscan.io/tx/${encodeURIComponent(signature)}`;
  return network === "mainnet" ? baseUrl : `${baseUrl}?cluster=${network}`;
}

function formatTransactionDate(value: number | null | undefined): string {
  if (!value) return "Unknown Date";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value * 1000));
}

function formatTransactionTime(value: number | null | undefined): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}

function transactionAssetLabel(change: WalletTransactionChange, tokenSymbols?: Map<string, string>): string {
  if (change.asset === "SOL") return "SOL";
  const mint = change.mint?.trim();
  const localMetadata = localTokenMetadata(mint);
  if (localMetadata) return localMetadata.symbol;
  if (change.asset === WRAPPED_SOL_MINT) return "WSOL";
  if (mint) {
    const symbol = tokenSymbols?.get(mint)?.trim();
    if (symbol) return symbol;
  }
  return change.asset.length > 10 ? `${change.asset.slice(0, 4)}...${change.asset.slice(-4)}` : change.asset;
}

function transactionAmountLabel(change: WalletTransactionChange, tokenSymbols?: Map<string, string>): string {
  return `${change.ui_amount} ${transactionAssetLabel(change, tokenSymbols)}`;
}

function workspaceLabel(label: string | undefined, address: string): string {
  return label?.trim() || shortAddress(address);
}

function walletActor(wallet: SavedWallet | undefined): WorkspaceActor {
  if (!wallet) return {};
  return {
    createdBy: wallet.public_key,
    createdByLabel: wallet.name,
  };
}

function actorLabel(item: WorkspaceActor): string {
  return item.createdByLabel?.trim() || (item.createdBy ? shortAddress(item.createdBy) : "");
}

function walletAvatarText(wallet: SavedWallet | undefined): string {
  if (!wallet) return "?";
  const name = wallet.name.trim();
  return (name || wallet.public_key).slice(0, 2).toUpperCase();
}

function tokenDisplayName(token: WalletTokenAsset): string {
  const localMetadata = localTokenMetadata(token.mint);
  if (localMetadata) return localMetadata.name;
  return token.name?.trim() || token.symbol?.trim() || shortAddress(token.mint);
}

function tokenMetadataName(token: WalletTokenAsset): string | undefined {
  const localMetadata = localTokenMetadata(token.mint);
  return localMetadata?.name.trim() || token.name?.trim() || undefined;
}

function tokenDisplaySymbol(token: WalletTokenAsset): string {
  const localMetadata = localTokenMetadata(token.mint);
  if (localMetadata) return localMetadata.symbol;
  return token.symbol?.trim() || shortAddress(token.mint);
}

function tokenAvatarText(token: WalletTokenAsset): string {
  const source = tokenDisplaySymbol(token) || tokenDisplayName(token) || token.mint;
  return source.slice(0, 2).toUpperCase();
}

function tokenLogoUri(token: WalletTokenAsset): string | undefined {
  const localMetadata = localTokenMetadata(token.mint);
  if (localMetadata) return localMetadata.logoUri;
  return token.logo_uri?.trim() || undefined;
}

function tokenColorPair(value: string): { from: string; to: string } {
  const palettes = [
    { from: "#7c3aed", to: "#06b6d4" },
    { from: "#059669", to: "#f59e0b" },
    { from: "#dc2626", to: "#f97316" },
    { from: "#2563eb", to: "#a855f7" },
    { from: "#0f766e", to: "#84cc16" },
    { from: "#be123c", to: "#ec4899" },
  ];
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return palettes[hash % palettes.length];
}

function cleanOptionalTokenText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mergeTokenAssetMetadata(nextTokens: WalletTokenAsset[], previousTokens: WalletTokenAsset[]): WalletTokenAsset[] {
  const previousByAccount = new Map(previousTokens.map((token) => [token.account, token]));
  const previousByMint = new Map(previousTokens.map((token) => [token.mint, token]));
  return nextTokens.map((token) => {
    const previous = previousByAccount.get(token.account) || previousByMint.get(token.mint);
    const localMetadata = localTokenMetadata(token.mint);
    if (!previous && !localMetadata) return token;
    return {
      ...token,
      name: localMetadata?.name || cleanOptionalTokenText(token.name) || cleanOptionalTokenText(previous?.name),
      symbol: localMetadata?.symbol || cleanOptionalTokenText(token.symbol) || cleanOptionalTokenText(previous?.symbol),
      logo_uri: localMetadata?.logoUri || cleanOptionalTokenText(token.logo_uri) || cleanOptionalTokenText(previous?.logo_uri),
    };
  });
}

function uniqueAddressList(items: Array<string | number | undefined>): string[] {
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const item of items) {
    for (const address of parseAddressList(item)) {
      if (!seen.has(address)) {
        seen.add(address);
        addresses.push(address);
      }
    }
  }
  return addresses;
}

function defaultBackTarget(formId: string): string | null {
  switch (formId) {
    case "create-encrypted":
    case "create-keystore":
    case "import-keystore":
    case "import-mnemonic":
    case "decrypt":
      return "wallet-list";
    case "unlock":
    case "check-balance":
    case "get-pubkey":
    case "setup-2fa":
    case "create-tfa":
    case "unlock-tfa":
      return "wallet-list";
    case "transfer-sol":
    case "transfer-token":
      return "wallet-list";
    case "create-wsol-ata":
    case "wrap-sol":
    case "unwrap-sol":
    case "close-wsol-ata":
      return "wsol-workbench";
    case "pumpfun-sell":
    case "pumpswap-sell":
    case "pumpfun-cashback":
    case "pumpswap-cashback":
      return "pump-workbench";
    case "program-deploy":
    case "program-upgrade":
    case "program-invoke":
    case "program-info":
      return "program-workbench";
    case "program-invoke-standalone":
    case "external-sign":
      return "contract-tools";
    case "create-nonce":
      return "nonce-workbench";
    case "squads-proposals":
    case "squads-programs":
    case "squads-create":
    case "squads-info":
    case "squads-sol-transfer":
    case "squads-token-transfer":
    case "squads-prepare-upgrade-buffer":
    case "squads-program-upgrade":
    case "squads-set-authority":
    case "squads-approve":
    case "squads-reject":
    case "squads-execute":
      return "squads-workspace";
    default:
      return null;
  }
}

function keystoreMetadataName(keystoreJson: string): string | undefined {
  try {
    const parsed = JSON.parse(keystoreJson) as {
      metadata?: Record<string, unknown>;
    };
    const value = parsed.metadata?.name;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 滑点百分比（如 1 表示 1%）→ 后端 basis points（×100），空则默认 1% */
function slippagePercentToBasisPoints(v: string | number | undefined): number {
  if (v === undefined || v === "") return 100;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (Number.isNaN(n)) return 100;
  return Math.floor(Math.min(Math.max(n, 0), 100) * 100);
}

function slippageInputDisplay(v: string | number | undefined): string {
  if (v === undefined || v === "") return "1";
  return String(v);
}

function parsePositiveDecimal(value: string | number | undefined): string | null {
  if (value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(text)) return null;
  if (!/[1-9]/.test(text)) return null;
  return text;
}

function parseNonceCount(value: string | number | undefined): number {
  const raw = String(value ?? "1").trim();
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) return 1;
  return Math.min(count, 20);
}

function parseSellPercentBps(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized >= 1 && normalized <= 10_000 ? normalized : undefined;
}

function hasValidSellAmount(formState: FormState): boolean {
  return parsePositiveDecimal(formState.amount) !== null || parseSellPercentBps(formState.sell_percent) !== undefined;
}

type TokenBalanceSnapshot = { amount: string; rawAmount: string; decimals: number };
type TokenBalanceAdjustment = {
  mint: string;
  sourceAccount?: string;
  soldRawAmount: string;
  decimals: number;
};
type PendingTokenBalanceAdjustment = TokenBalanceAdjustment & {
  expectedRawAmount: string;
  createdAt: number;
};

function rawTokenAmountToUi(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0) return "";
  const padded = raw.padStart(decimals + 1, "0");
  const whole = decimals > 0 ? padded.slice(0, -decimals) : padded;
  const fractional = decimals > 0 ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return fractional ? `${whole}.${fractional}` : whole;
}

function uiTokenAmountToRaw(value: string | number | undefined, decimals: number): string | null {
  const text = parsePositiveDecimal(value);
  if (text === null || !Number.isInteger(decimals) || decimals < 0) return null;
  const [whole, fractional = ""] = text.split(".");
  if (fractional.length > decimals) return null;
  const raw = `${whole}${fractional.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return raw || "0";
}

function tokenBalanceSnapshotFromFormState(formState: FormState | null, mint: string): TokenBalanceSnapshot | null {
  if (!formState) return null;
  const formMint = String(formState.mint ?? "").trim();
  if (formMint && formMint !== mint) return null;
  const decimals =
    typeof formState.decimals === "number"
      ? formState.decimals
      : Number.parseInt(String(formState.decimals ?? ""), 10);
  if (!Number.isInteger(decimals) || decimals < 0) return null;

  const rawCandidate = String(formState.token_raw_amount ?? "").trim();
  const rawAmount = /^\d+$/.test(rawCandidate)
    ? rawCandidate
    : uiTokenAmountToRaw(formState.token_balance, decimals);
  if (!rawAmount) return null;

  return {
    amount: rawTokenAmountToUi(rawAmount, decimals),
    rawAmount,
    decimals,
  };
}

function aggregateTokenBalance(tokens: WalletTokenAsset[], mint: string): TokenBalanceSnapshot | null {
  const matchingTokens = tokens.filter((item) => String(item.mint).trim() === mint);
  if (matchingTokens.length === 0 || matchingTokens.some((item) => !/^\d+$/.test(item.amount))) {
    return null;
  }
  const decimals = matchingTokens[0]?.decimals;
  if (!Number.isInteger(decimals) || matchingTokens.some((item) => item.decimals !== decimals)) {
    return null;
  }
  const rawBalance = matchingTokens.reduce((total, item) => total + BigInt(item.amount), BigInt(0));
  return {
    amount: rawTokenAmountToUi(rawBalance.toString(), decimals),
    rawAmount: rawBalance.toString(),
    decimals,
  };
}

function normalizedRawAmount(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  return /^\d+$/.test(raw) ? raw : null;
}

function applyTokenBalanceAdjustmentToTokens(
  tokens: WalletTokenAsset[],
  adjustment?: TokenBalanceAdjustment,
): WalletTokenAsset[] {
  if (!adjustment) return tokens;
  const soldRawAmount = normalizedRawAmount(adjustment.soldRawAmount);
  if (!soldRawAmount || BigInt(soldRawAmount) <= BigInt(0)) return tokens;

  let remainingSoldRaw = BigInt(soldRawAmount);
  const sourceAccount = adjustment.sourceAccount?.trim();
  const matchingIndexes = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => {
      if (String(token.mint).trim() !== adjustment.mint || token.decimals !== adjustment.decimals) {
        return false;
      }
      return sourceAccount ? token.account === sourceAccount : true;
    })
    .map(({ index }) => index);
  const indexes = matchingIndexes.length > 0
    ? matchingIndexes
    : tokens
        .map((token, index) => ({ token, index }))
        .filter(({ token }) => String(token.mint).trim() === adjustment.mint && token.decimals === adjustment.decimals)
        .map(({ index }) => index);
  if (indexes.length === 0) return tokens;

  return tokens
    .map((token, index) => {
      if (!indexes.includes(index) || remainingSoldRaw <= BigInt(0) || !/^\d+$/.test(token.amount)) {
        return token;
      }
      const currentRaw = BigInt(token.amount);
      const deductedRaw = currentRaw < remainingSoldRaw ? currentRaw : remainingSoldRaw;
      remainingSoldRaw -= deductedRaw;
      const nextRaw = currentRaw - deductedRaw;
      return {
        ...token,
        amount: nextRaw.toString(),
        ui_amount_string: rawTokenAmountToUi(nextRaw.toString(), token.decimals),
      };
    })
    .filter((token) => token.amount !== "0");
}

function pendingAdjustmentFromAssets(
  assets: WalletAssetsState | null,
  adjustment?: TokenBalanceAdjustment,
): PendingTokenBalanceAdjustment | undefined {
  if (!assets || !adjustment) return undefined;
  const soldRawAmount = normalizedRawAmount(adjustment.soldRawAmount);
  if (!soldRawAmount) return undefined;
  const adjustedTokens = applyTokenBalanceAdjustmentToTokens(assets.tokens, adjustment);
  const balance = aggregateTokenBalance(adjustedTokens, adjustment.mint);
  return {
    ...adjustment,
    soldRawAmount,
    expectedRawAmount: balance?.rawAmount ?? "0",
    createdAt: Date.now(),
  };
}

function pendingAdjustmentFromFormState(
  formState: FormState,
  adjustment?: TokenBalanceAdjustment,
): PendingTokenBalanceAdjustment | undefined {
  if (!adjustment) return undefined;
  const currentRawAmount = normalizedRawAmount(formState.token_raw_amount);
  const soldRawAmount = normalizedRawAmount(adjustment.soldRawAmount);
  if (!currentRawAmount || !soldRawAmount) return undefined;
  const currentRaw = BigInt(currentRawAmount);
  const soldRaw = BigInt(soldRawAmount);
  return {
    ...adjustment,
    soldRawAmount,
    expectedRawAmount: (currentRaw > soldRaw ? currentRaw - soldRaw : BigInt(0)).toString(),
    createdAt: Date.now(),
  };
}

function applyPendingTokenBalanceAdjustmentToAssets(
  assets: WalletAssetsState,
  adjustment?: PendingTokenBalanceAdjustment,
): WalletAssetsState {
  if (!adjustment || Date.now() - adjustment.createdAt > 30_000) return assets;
  const balance = aggregateTokenBalance(assets.tokens, adjustment.mint);
  if (!balance || balance.decimals !== adjustment.decimals) return assets;
  if (BigInt(balance.rawAmount) <= BigInt(adjustment.expectedRawAmount)) return assets;
  const adjustedTokens = applyTokenBalanceAdjustmentToTokens(assets.tokens, {
    mint: adjustment.mint,
    sourceAccount: adjustment.sourceAccount,
    soldRawAmount: (BigInt(balance.rawAmount) - BigInt(adjustment.expectedRawAmount)).toString(),
    decimals: adjustment.decimals,
  });
  return {
    ...assets,
    tokens: adjustedTokens,
  };
}

function pendingTokenBalanceAdjustmentStillNeeded(
  assets: WalletAssetsState,
  adjustment?: PendingTokenBalanceAdjustment,
): boolean {
  if (!adjustment || Date.now() - adjustment.createdAt > 30_000) return false;
  const balance = aggregateTokenBalance(assets.tokens, adjustment.mint);
  return Boolean(
    balance &&
      balance.decimals === adjustment.decimals &&
      BigInt(balance.rawAmount) > BigInt(adjustment.expectedRawAmount),
  );
}

function pumpSellTokenAdjustment(formState: FormState, data: Record<string, unknown>): TokenBalanceAdjustment | undefined {
  const mint = String(formState.mint ?? "").trim();
  const soldRawAmount = normalizedRawAmount(data.sold_raw_amount);
  const decimals = Number(data.decimals);
  if (!mint || !soldRawAmount || !Number.isInteger(decimals) || decimals < 0) return undefined;
  const sourceAccount = typeof data.source_account === "string" && data.source_account.trim()
    ? data.source_account.trim()
    : undefined;
  return {
    mint,
    soldRawAmount,
    decimals,
    sourceAccount,
  };
}

function parseAddressList(value: string | number | undefined): string[] {
  return String(value ?? "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function Home() {
  const t = useTranslations();
  const tf = useCallback((key: string, fallback: string, vars?: Record<string, string | number>) => {
    const value = t(key, vars);
    return value === key ? fallback : value;
  }, [t]);

  const menuItems: MenuItem[] = [
    {
      id: "wallet-list",
      label: t("features.wallet-list.title"),
      icon: <Wallet className="w-5 h-5" />,
    },
    {
      id: "transfer-menu",
      label: t("features.transfer-menu.title"),
      icon: <Coins className="w-5 h-5" />,
      children: [
        {
          id: "pump-workbench",
          label: t("features.pump-workbench.title"),
          icon: <Coins className="w-4 h-4" />,
          network: true,
        },
        {
          id: "wsol-workbench",
          label: t("features.wsol-workbench.title"),
          icon: <RefreshCw className="w-4 h-4" />,
          network: true,
        },
        {
          id: "nonce-workbench",
          label: t("features.nonce-workbench.title"),
          icon: <RefreshCw className="w-4 h-4" />,
          network: true,
        },
        {
          id: "evm-workbench",
          label: tf("features.evm-workbench.title", "Multi-chain Wallet"),
          icon: <ArrowRightLeft className="w-4 h-4" />,
        },
      ],
    },
    {
      id: "contract-tools",
      label: tf("features.contract-tools.title", "合约工具"),
      icon: <Hash className="w-5 h-5" />,
      network: true,
      children: [
        {
          id: "program-workbench",
          label: t("features.program-workbench.title"),
          icon: <Hash className="w-4 h-4" />,
          network: true,
        },
        {
          id: "program-invoke-standalone",
          label: t("features.program-invoke.title"),
          icon: <Send className="w-4 h-4" />,
          network: true,
        },
        {
          id: "external-sign",
          label: t("features.external-sign.title"),
          icon: <ShieldCheck className="w-4 h-4" />,
          network: true,
        },
      ],
    },
    {
      id: "dapp-store",
      label: tf("features.dapp-store.title", "DApp Store"),
      icon: <Compass className="w-5 h-5" />,
      network: true,
    },
    {
      id: "squads-workspace",
      label: t("features.workspace.title"),
      icon: <ShieldCheck className="w-5 h-5" />,
      network: true,
    },
    {
      id: "settings",
      label: t("features.settings.title"),
      icon: <Settings className="w-5 h-5" />,
    },
  ];
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [selectedForm, setSelectedForm] = useState<string | null>("wallet-list");
  const [formData, setFormData] = useState<FormState>({});
  const [externalSignInputMode, setExternalSignInputMode] = useState<ExternalSignInputMode>("json");
  const [copied, setCopied] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [authMethod, setAuthMethod] = useState<{ [key: string]: "keystore" | "private" | "encrypted" }>({});
  const [wallets, setWallets] = useState<SavedWallet[]>([]);
  const [walletsLoading, setWalletsLoading] = useState(true);
  const [walletsLoadError, setWalletsLoadError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<SquadsWorkspace>(emptyWorkspace);
  const [selectedProgramProjectId, setSelectedProgramProjectId] = useState("");
  const [downloadHistory, setDownloadHistory] = useState<DownloadHistoryItem[]>([]);
  const [editingWalletId, setEditingWalletId] = useState<string | null>(null);
  const [rpcProfiles, setRpcProfiles] = useState<RpcProfile[]>(DEFAULT_RPC_PROFILES);
  const [selectedRpcId, setSelectedRpcId] = useState(defaultRpcProfileId(DEFAULT_NETWORK));
  const [settingsNetwork, setSettingsNetwork] = useState<AppNetwork>(DEFAULT_NETWORK);
  const [currentWalletId, setCurrentWalletId] = useState("");
  const [newRpcName, setNewRpcName] = useState("");
  const [newRpcUrl, setNewRpcUrl] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [appTheme, setAppTheme] = useState<AppUiTheme>("deep-sea");
  const [walletActionsMenuOpen, setWalletActionsMenuOpen] = useState<string | null>(null);
  const [walletFaucetMenuOpen, setWalletFaucetMenuOpen] = useState(false);
  const [exportedPrivateKey, setExportedPrivateKey] = useState<ExportedPrivateKeyPreview | null>(null);
  const [exportedMnemonic, setExportedMnemonic] = useState<ExportedMnemonicPreview | null>(null);
  const [sensitiveExportTab, setSensitiveExportTab] = useState<SensitiveExportKind>("private-key");
  const [exportBundleSelection, setExportBundleSelection] = useState<ExportBundleSelection>({
    keystore: true,
    "private-key": false,
    mnemonic: false,
  });
  const [privateKeyExportMode, setPrivateKeyExportMode] = useState<PrivateKeyExportMode>("simple");
  const [privateKeySegmentCount, setPrivateKeySegmentCount] = useState(DEFAULT_PRIVATE_KEY_SEGMENTS);
  const [privateKeyQrRevealed, setPrivateKeyQrRevealed] = useState(false);
  const [dappTabs, setDappTabs] = useState<DappBrowserTab[]>([DAPP_HOME_TAB]);
  const [activeDappTabId, setActiveDappTabId] = useState(DAPP_HOME_TAB_ID);
  const [dappConnectRequest, setDappConnectRequest] = useState<DappConnectRequestEvent | null>(null);
  const [dappConnectWalletId, setDappConnectWalletId] = useState("");
  const [dappSignRequest, setDappSignRequest] = useState<DappSignRequestEvent | null>(null);
  const [dappPassword, setDappPassword] = useState("");
  const [dappSaveBiometric, setDappSaveBiometric] = useState(false);
  const [dappSearch, setDappSearch] = useState("");
  const [dappCategory, setDappCategory] = useState<DappCategoryId>("trend");
  const [dappSignBusy, setDappSignBusy] = useState(false);
  const [dappTransactionPreview, setDappTransactionPreview] = useState<DappTransactionPreview | null>(null);
  const [dappTransactionPreviewError, setDappTransactionPreviewError] = useState<string | null>(null);
  const [dappTransactionPreviewLoading, setDappTransactionPreviewLoading] = useState(false);
  const [dappPreviewDetailsOpen, setDappPreviewDetailsOpen] = useState(false);
  const [biometricStatuses, setBiometricStatuses] = useState<Record<string, BiometricWalletStatus>>({});
  const [biometricBusyWalletId, setBiometricBusyWalletId] = useState<string | null>(null);
  const [savePasswordToBiometric, setSavePasswordToBiometric] = useState(false);
  const [backTarget, setBackTarget] = useState<string | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPromptRequest | null>(null);
  const [passwordPromptValue, setPasswordPromptValue] = useState("");
  const [masterPasswordPromptValue, setMasterPasswordPromptValue] = useState("");
  const [passwordConfirmationBusy, setPasswordConfirmationBusy] = useState(false);
  const [migrationNewPassword, setMigrationNewPassword] = useState("");
  const [migrationConfirmPassword, setMigrationConfirmPassword] = useState("");
  const [programDeploymentJournal, setProgramDeploymentJournal] = useState<ProgramDeploymentJournalState>(
    emptyProgramDeploymentJournalState,
  );
  const [lastProgramDeploymentIntent, setLastProgramDeploymentIntent] =
    useState<ProgramDeploymentJournalIntent | null>(null);
  const [programSourceLoading, setProgramSourceLoading] = useState(false);
  const [programDeployInlineError, setProgramDeployInlineError] = useState<{
    friendly: string;
    raw: string;
  } | null>(null);
  const [programUpgradeInlineError, setProgramUpgradeInlineError] = useState<{
    friendly: string;
    raw: string;
  } | null>(null);
  const [programUpgradeProgress, setProgramUpgradeProgress] = useState<{
    active: boolean;
    program_id: string;
    network: string;
    stage: string;
    message: string;
    write_completed: number;
    write_total: number;
    program_bytes: number;
    buffer_address?: string | null;
    last_signature?: string | null;
    error?: string | null;
    updated_at_ms: number;
  } | null>(null);
  const [programInvoke, setProgramInvoke] = useState<ProgramInvokeState>({
    idlJsonText: "",
    programId: "",
    selectedInstruction: "",
    argValues: {},
    accountValues: {},
    signerWalletIds: {},
    signerPasswords: {},
    loading: false,
  });
  const [programInvokeWalletPickerTarget, setProgramInvokeWalletPickerTarget] =
    useState<ProgramInvokeWalletPickerTarget | null>(null);
  const [historyDeletePrompt, setHistoryDeletePrompt] = useState<{
    projectId: string;
    recordId: string;
  } | null>(null);
  const [dismissedHistoryCardIds, setDismissedHistoryCardIds] = useState<string[]>([]);
  const [programDeploymentNowMs, setProgramDeploymentNowMs] = useState(() => Date.now());
  const [programKeypairMetadata, setProgramKeypairMetadata] = useState<ProgramKeypairMetadata | null>(null);
  const programKeypairBytesRef = useRef<Uint8Array | null>(null);
  const programSoInputRef = useRef<HTMLInputElement | null>(null);
  const programKeypairInputRef = useRef<HTMLInputElement | null>(null);
  const programInvokeIdlFileInputRef = useRef<HTMLInputElement | null>(null);
  const programKeypairReadVersionRef = useRef(0);
  const programSoReadVersionRef = useRef(0);
  const programKeypairArtifactRequestIdRef = useRef(0);
  const deploymentJournalRequestIdRef = useRef(0);
  const deploymentJournalLoadedIntentKeyRef = useRef("");
  const deploymentJournalInFlightIntentKeyRef = useRef("");
  const lastProgramDeploymentIntentRef = useRef<ProgramDeploymentJournalIntent | null>(null);
  const programDeploymentJournalRef = useRef<ProgramDeploymentJournalState>(emptyProgramDeploymentJournalState());
  const programDeploymentLogPanelRef = useRef<HTMLDivElement | null>(null);
  const privateKeyQrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dappBrowserShellRef = useRef<HTMLDivElement | null>(null);
  const dappBrowserTabBarRef = useRef<HTMLDivElement | null>(null);
  const dappBrowserAddressBarRef = useRef<HTMLDivElement | null>(null);
  const dappBrowserViewportRef = useRef<HTMLDivElement | null>(null);
  const programDeploymentWatchdogTrippedRef = useRef(false);
  lastProgramDeploymentIntentRef.current = lastProgramDeploymentIntent;
  programDeploymentJournalRef.current = programDeploymentJournal;
  const passwordConfirmationInFlightRef = useRef(false);
  const biometricPasswordPromptAttemptRef = useRef("");
  const biometricDappAttemptRef = useRef("");
  const approveDappSignRequestRef = useRef<((passwordOverride?: string) => Promise<void>) | null>(null);
  const confirmPasswordPromptRef = useRef<((passwordOverride?: string) => Promise<void>) | null>(null);
  const [walletAssets, setWalletAssets] = useState<WalletAssetsState | null>(null);
  const [walletSolBalanceCache, setWalletSolBalanceCache] = useState<Record<string, string>>({});
  const [walletTransactions, setWalletTransactions] = useState<WalletTransactionsState | null>(null);
  const [walletOverviewTab, setWalletOverviewTab] = useState<"assets" | "transactions">("assets");
  const [walletChainView, setWalletChainView] = useState<"solana" | "evm">("solana");
  const [visibleTokenCount, setVisibleTokenCount] = useState(TOKEN_ASSET_PAGE_SIZE);
  const clientSettingsLoadedRef = useRef(false);
  const walletAssetsRef = useRef<WalletAssetsState | null>(null);
  const walletTransactionsRef = useRef<WalletTransactionsState | null>(null);
  const walletAssetsInFlightRef = useRef<Map<string, Promise<WalletAssetsState | null>>>(new Map());
  const walletTransactionsInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const [evmChains, setEvmChains] = useState<DesktopEvmChainConfig[]>([]);
  const [evmCustomChainIds, setEvmCustomChainIds] = useState<number[]>([]);
  const [evmChainId, setEvmChainId] = useState("");
  const [evmWallet, setEvmWallet] = useState<DesktopEvmWalletSummary | null>(null);
  const [evmKeystoreJson, setEvmKeystoreJson] = useState("");
  const [evmPassword, setEvmPassword] = useState("");
  const [evmPrivateKey, setEvmPrivateKey] = useState("");
  const [evmRecipient, setEvmRecipient] = useState("");
  const [evmAmount, setEvmAmount] = useState("");
  const [evmTokenContract, setEvmTokenContract] = useState("");
  const [evmTokenContracts, setEvmTokenContracts] = useState<string[]>([]);
  const [evmNewTokenContract, setEvmNewTokenContract] = useState("");
  const [evmAssets, setEvmAssets] = useState<DesktopEvmAssetSnapshot | null>(null);
  const [evmPreview, setEvmPreview] = useState<DesktopEvmPaymentPreview | null>(null);
  const [evmSubmitResult, setEvmSubmitResult] = useState<DesktopEvmTransactionSubmitResult | null>(null);
  const [evmTransactionStatus, setEvmTransactionStatus] = useState<DesktopEvmTransactionStatus | null>(null);
  const [evmBusy, setEvmBusy] = useState(false);
  const [evmError, setEvmError] = useState<string | null>(null);
  const [evmNewChain, setEvmNewChain] = useState({
    chainId: "",
    name: "",
    nativeSymbol: "",
    rpcUrl: "",
    explorerUrl: "",
    testnet: true,
  });
  const [evmCustomChainEditorOpen, setEvmCustomChainEditorOpen] = useState(false);
  const nonceAccountsInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const pendingTokenBalanceAdjustmentRef = useRef<PendingTokenBalanceAdjustment | undefined>(undefined);
  const lastAssetRefreshRef = useRef<Map<string, number>>(new Map());
  const lastTransactionRefreshRef = useRef<Map<string, number>>(new Map());
  const lastNonceRefreshRef = useRef<Map<string, number>>(new Map());
  const activeWalletContextRef = useRef<{
    walletId: string;
    network: AppNetwork;
    rpcRequest: string;
  }>({ walletId: "", network: DEFAULT_NETWORK, rpcRequest: DEFAULT_NETWORK });
  const [tokenActionContext, setTokenActionContext] = useState<FormState | null>(null);
  const [nonceAccounts, setNonceAccounts] = useState<NonceAccountsState | null>(null);
  const [createdNonceAccounts, setCreatedNonceAccounts] = useState<CreatedNonceAccount[]>([]);
  const [nonceCreateOpen, setNonceCreateOpen] = useState(false);
  const [cashbackInfo, setCashbackInfo] = useState<CashbackInfoState | null>(null);
  const [tokenMintInfo, setTokenMintInfo] = useState<TokenMintInfoState | null>(null);
  const walletAuth = (formId: string): WalletAuthTab =>
    normalizeWalletAuth((authMethod[formId] ?? "keystore") as WalletAuthTab);
  const activeEvmChain =
    evmChains.find((chain) => String(chain.chain_id) === evmChainId) || evmChains[0];
  const activeEvmChainIsCustom =
    Boolean(activeEvmChain && evmCustomChainIds.includes(activeEvmChain.chain_id));

  const resetEvmChainScopedState = useCallback(() => {
    setEvmAssets(null);
    setEvmPreview(null);
    setEvmSubmitResult(null);
    setEvmTransactionStatus(null);
  }, []);

  const selectEvmChain = useCallback((chainId: string) => {
    setEvmChainId(chainId);
    setWalletChainView("evm");
    saveStoredDesktopEvmChainId(chainId);
    resetEvmChainScopedState();
  }, [resetEvmChainScopedState]);

  const loadEvmChains = useCallback(async () => {
    const response = await apiFetch("evm/chains", {});
    const data = await response.json();
    if (!response.ok || !Array.isArray(data)) {
      throw new Error(data?.error || "Failed to load chains");
    }
    const merged = new Map<number, DesktopEvmChainConfig>();
    for (const chain of data as DesktopEvmChainConfig[]) {
      merged.set(chain.chain_id, chain);
    }
    const customChains = loadStoredDesktopEvmChains();
    for (const chain of customChains) {
      merged.set(chain.chain_id, chain);
    }
    const chains = Array.from(merged.values()).sort((a, b) => {
      if (a.testnet !== b.testnet) return a.testnet ? 1 : -1;
      return a.chain_id - b.chain_id;
    });
    setEvmChains(chains);
    setEvmCustomChainIds(customChains.map((chain) => chain.chain_id));
    const storedChainId = loadStoredDesktopEvmChainId();
    setEvmChainId((previous) => {
      const candidate = previous || storedChainId;
      const nextChainId =
        candidate && chains.some((chain) => String(chain.chain_id) === candidate)
          ? candidate
          : String(chains[0]?.chain_id || "");
      saveStoredDesktopEvmChainId(nextChainId);
      return nextChainId;
    });
  }, []);

  useEffect(() => {
    void loadEvmChains().catch((error) => setEvmError(errorMessage(error, "Failed to load chains")));
  }, [loadEvmChains]);

  useEffect(() => {
    if (!activeEvmChain || !evmWallet) {
      setEvmTokenContracts([]);
      return;
    }
    setEvmTokenContracts(loadStoredDesktopEvmTokens(activeEvmChain.chain_id, evmWallet.address));
  }, [activeEvmChain, evmWallet]);

  const withEvmBusy = useCallback(async (run: () => Promise<void>) => {
    setEvmBusy(true);
    setEvmError(null);
    try {
      await run();
    } catch (error) {
      const message = errorMessage(error, "Chain operation failed");
      setEvmError(message);
      toast.error(message);
    } finally {
      setEvmBusy(false);
    }
  }, []);

  const createEvmWallet = () => withEvmBusy(async () => {
    if (!evmPassword.trim()) throw new Error("Wallet password is required");
    const response = await apiFetch("evm/wallet/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Multi-chain Wallet", password: evmPassword }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to create wallet");
    const created = data as DesktopEvmWalletKeystore;
    setEvmWallet(created.wallet);
    setEvmKeystoreJson(created.keystore_json);
    setEvmPreview(null);
    setEvmSubmitResult(null);
    setEvmPassword("");
    toast.success("Wallet created");
  });

  const importEvmPrivateKey = () => withEvmBusy(async () => {
    if (!evmPrivateKey.trim() || !evmPassword.trim()) {
      throw new Error("Private key and password are required");
    }
    const response = await apiFetch("evm/wallet/import-private-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Imported Multi-chain Wallet",
        private_key_hex: evmPrivateKey.trim(),
        password: evmPassword,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to import wallet");
    const imported = data as DesktopEvmWalletKeystore;
    setEvmWallet(imported.wallet);
    setEvmKeystoreJson(imported.keystore_json);
    setEvmPassword("");
    setEvmPrivateKey("");
    setEvmPreview(null);
    setEvmSubmitResult(null);
    toast.success("Wallet imported");
  });

  const addDesktopEvmChain = () => {
    const chainId = Number(evmNewChain.chainId);
    const rpcUrl = evmNewChain.rpcUrl.trim();
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || !evmNewChain.name.trim() || !evmNewChain.nativeSymbol.trim()) {
      setEvmError("Chain id, name, and native symbol are required");
      return;
    }
    if (!/^https?:\/\//.test(rpcUrl)) {
      setEvmError("RPC URL must start with http:// or https://");
      return;
    }
    const explorerUrl = evmNewChain.explorerUrl.trim();
    if (explorerUrl && !/^https?:\/\//.test(explorerUrl)) {
      setEvmError("Explorer URL must start with http:// or https://");
      return;
    }
    const nextChain: DesktopEvmChainConfig = {
      chain_id: chainId,
      name: evmNewChain.name.trim(),
      native_symbol: evmNewChain.nativeSymbol.trim(),
      rpc_url: rpcUrl,
      explorer_url: explorerUrl || null,
      testnet: evmNewChain.testnet,
    };
    const storedChains = new Map(loadStoredDesktopEvmChains().map((chain) => [chain.chain_id, chain]));
    storedChains.set(nextChain.chain_id, nextChain);
    const nextStoredChains = Array.from(storedChains.values()).sort((a, b) => a.chain_id - b.chain_id);
    saveStoredDesktopEvmChains(nextStoredChains);
    setEvmCustomChainIds(nextStoredChains.map((chain) => chain.chain_id));
    setEvmChains((previous) => {
      const merged = new Map(previous.map((chain) => [chain.chain_id, chain]));
      merged.set(nextChain.chain_id, nextChain);
      return Array.from(merged.values()).sort((a, b) => {
        if (a.testnet !== b.testnet) return a.testnet ? 1 : -1;
        return a.chain_id - b.chain_id;
      });
    });
    selectEvmChain(String(nextChain.chain_id));
    setEvmNewChain({ chainId: "", name: "", nativeSymbol: "", rpcUrl: "", explorerUrl: "", testnet: true });
    setEvmCustomChainEditorOpen(false);
    setEvmAssets(null);
  };

  const removeDesktopEvmChain = () => {
    if (!activeEvmChain || !activeEvmChainIsCustom) return;
    const customChains = loadStoredDesktopEvmChains().filter((chain) => chain.chain_id !== activeEvmChain.chain_id);
    saveStoredDesktopEvmChains(customChains);
    setEvmCustomChainIds(customChains.map((chain) => chain.chain_id));
    void loadEvmChains().then(() => {
      setEvmAssets(null);
      setEvmPreview(null);
      setEvmSubmitResult(null);
      setEvmTransactionStatus(null);
    });
  };

  const addDesktopEvmToken = () => {
    const contract = evmNewTokenContract.trim();
    if (!contract) return;
    if (!activeEvmChain || !evmWallet) {
      setEvmError("Select a chain and wallet before adding a token");
      return;
    }
    const next = Array.from(new Map([...evmTokenContracts, contract].map((item) => [item.toLowerCase(), item])).values());
    if (!isDesktopEvmAddress(contract)) {
      setEvmError("ERC-20 contract must be a 20-byte 0x address");
      return;
    }
    setEvmTokenContracts(next);
    saveStoredDesktopEvmTokens(activeEvmChain.chain_id, evmWallet.address, next);
    setEvmNewTokenContract("");
  };

  const removeDesktopEvmToken = (contract: string) => {
    if (!activeEvmChain || !evmWallet) return;
    const next = evmTokenContracts.filter((item) => item.toLowerCase() !== contract.toLowerCase());
    setEvmTokenContracts(next);
    saveStoredDesktopEvmTokens(activeEvmChain.chain_id, evmWallet.address, next);
    setEvmAssets((previous) => previous
      ? {
          ...previous,
          tokens: previous.tokens.filter((item) => item.contract_address.toLowerCase() !== contract.toLowerCase()),
        }
      : previous,
    );
  };

  const refreshEvmAssets = () => withEvmBusy(async () => {
    if (!activeEvmChain || !evmWallet) throw new Error("Select a chain and wallet first");
    const response = await apiFetch("evm/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: activeEvmChain,
        wallet_address: evmWallet.address,
        tokens: evmTokenContracts.map((contract_address) => ({ contract_address })),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to refresh chain assets");
    setEvmAssets(data as DesktopEvmAssetSnapshot);
  });

  const previewEvmPayment = () => withEvmBusy(async () => {
    if (!activeEvmChain || !evmWallet) throw new Error("Select a chain and wallet first");
    const response = await apiFetch("evm/payment/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: activeEvmChain,
        wallet_address: evmWallet.address,
        recipient: evmRecipient.trim(),
        amount_wei_or_units: evmAmount.trim(),
        token_contract: evmTokenContract.trim() || null,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to preview payment");
    setEvmPreview(data as DesktopEvmPaymentPreview);
    setEvmSubmitResult(null);
    setEvmTransactionStatus(null);
  });

  const submitEvmPayment = (approved: boolean) => withEvmBusy(async () => {
    if (!evmPreview) throw new Error("Create a payment preview first");
    if (!approved) {
      setEvmPreview(null);
      setEvmSubmitResult(null);
      setEvmTransactionStatus(null);
      setEvmPassword("");
      toast.success("Transaction rejected");
      return;
    }
    const response = await apiFetch("evm/payment/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview_id: evmPreview.preview_id,
        approved: true,
        chain: evmPreview.chain,
        wallet_address: evmPreview.wallet_address,
        keystore_json: evmKeystoreJson,
        password: evmPassword,
        recipient: evmPreview.recipient,
        amount_wei_or_units: evmPreview.amount_wei_or_units,
        token_contract: evmPreview.token_contract,
        gas_limit: evmPreview.gas_limit,
        gas_price_wei: evmPreview.gas_price_wei,
        max_fee_per_gas_wei: evmPreview.max_fee_per_gas_wei,
        max_priority_fee_per_gas_wei: evmPreview.max_priority_fee_per_gas_wei,
        nonce: evmPreview.nonce,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to submit payment");
    setEvmSubmitResult(data as DesktopEvmTransactionSubmitResult);
    setEvmPassword("");
    toast.success("Transaction submitted");
  });

  const refreshEvmTransactionStatus = () => withEvmBusy(async () => {
    if (!evmSubmitResult) throw new Error("Submit a transaction first");
    const response = await apiFetch("evm/transaction/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: evmSubmitResult.chain,
        transaction_hash: evmSubmitResult.transaction_hash,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load transaction status");
    setEvmTransactionStatus(data as DesktopEvmTransactionStatus);
  });

  useEffect(() => {
    setAppTheme(loadAppUiTheme());
  }, []);

  const selectAppTheme = useCallback((theme: AppUiTheme) => {
    setAppTheme(theme);
    saveAppUiTheme(theme);
  }, []);

  const clearPasswordPromptSecrets = useCallback(() => {
    setPasswordPromptValue("");
    setMasterPasswordPromptValue("");
    setMigrationNewPassword("");
    setMigrationConfirmPassword("");
    setProgramInvoke((prev) =>
      Object.keys(prev.signerPasswords).length === 0 ? prev : { ...prev, signerPasswords: {} },
    );
  }, []);

  const clearProgramKeypairMaterial = useCallback(() => {
    programKeypairReadVersionRef.current += 1;
    programKeypairArtifactRequestIdRef.current += 1;
    programKeypairBytesRef.current?.fill(0);
    programKeypairBytesRef.current = null;
    if (programKeypairInputRef.current) {
      programKeypairInputRef.current.value = "";
    }
    setProgramKeypairMetadata(null);
    setFormData((prev) => {
      if (!prev.programKeypairPath && (selectedForm !== "program-deploy" || !prev.expectedProgramId)) {
        return prev;
      }
      const next = { ...prev };
      delete next.programKeypairPath;
      if (selectedForm === "program-deploy") {
        delete next.expectedProgramId;
        delete next.resumeBufferAddress;
      }
      return next;
    });
  }, [selectedForm]);

  const resetProgramDeploySession = useCallback(() => {
    programSoReadVersionRef.current += 1;
    deploymentJournalRequestIdRef.current += 1;
    deploymentJournalLoadedIntentKeyRef.current = "";
    deploymentJournalInFlightIntentKeyRef.current = "";
    programDeploymentWatchdogTrippedRef.current = false;
    setLastProgramDeploymentIntent(null);
    setProgramDeploymentJournal(emptyProgramDeploymentJournalState());
    clearProgramKeypairMaterial();
  }, [clearProgramKeypairMaterial]);

  const clearProgramDeploymentProgress = useCallback(() => {
    deploymentJournalRequestIdRef.current += 1;
    deploymentJournalLoadedIntentKeyRef.current = "";
    deploymentJournalInFlightIntentKeyRef.current = "";
    programDeploymentWatchdogTrippedRef.current = false;
    setLastProgramDeploymentIntent(null);
    setProgramDeploymentJournal(emptyProgramDeploymentJournalState());
  }, []);

  const selectedRpc = rpcProfiles.find((profile) => profile.id === selectedRpcId) || rpcProfiles[0] || DEFAULT_RPC_PROFILES[0];
  const effectiveNetwork = currentNetwork(selectedRpc.network);
  const effectiveRpcRequest = rpcRequestValue(selectedRpc);
  const effectiveRpcLabel = selectedRpc.name;
  const effectiveNetworkLabel = networkLabel(t, effectiveNetwork);
  const visibleRpcProfiles = rpcProfiles.filter((profile) => profile.network === settingsNetwork);
  const effectiveWalletId = currentWalletId || wallets[0]?.id || "";
  const effectiveWallet = wallets.find((wallet) => wallet.id === effectiveWalletId);
  const effectiveProgramWorkspaceOwner = effectiveWallet?.public_key || "";
  const effectiveProgramWorkspaceOwnerLabel = effectiveWallet?.name || undefined;
  const effectiveWalletActor: WorkspaceActor = {
    createdBy: effectiveProgramWorkspaceOwner || undefined,
    createdByLabel: effectiveProgramWorkspaceOwnerLabel,
  };

  const biometricStatusFor = useCallback(
    (wallet?: SavedWallet): BiometricWalletStatus | undefined =>
      wallet ? biometricStatuses[wallet.id] : undefined,
    [biometricStatuses],
  );

  const supportsBiometricWallet = useCallback(
    (wallet?: SavedWallet): boolean =>
      Boolean(wallet && isTauriWebview() && wallet.keystore_version !== "unknown"),
    [],
  );

  const canUseBiometricWallet = useCallback(
    (wallet?: SavedWallet): boolean => {
      if (!supportsBiometricWallet(wallet)) return false;
      const status = biometricStatusFor(wallet);
      return status?.supported !== false;
    },
    [biometricStatusFor, supportsBiometricWallet],
  );

  const biometricConfiguredFor = useCallback(
    (wallet?: SavedWallet): boolean =>
      Boolean(supportsBiometricWallet(wallet) && biometricStatusFor(wallet)?.configured),
    [biometricStatusFor, supportsBiometricWallet],
  );

  const refreshBiometricWalletStatus = useCallback(async (wallet: SavedWallet): Promise<BiometricWalletStatus> => {
    if (!supportsBiometricWallet(wallet)) {
      const status = {
        supported: false,
        configured: false,
        reason: "Touch ID is available only for saved wallets in the desktop app.",
      };
      setBiometricStatuses((prev) => ({
        ...prev,
        [wallet.id]: status,
      }));
      return status;
    }
    try {
      const status = await invoke<BiometricWalletStatus>("biometric_wallet_status", {
        req: {
          wallet_id: wallet.id,
          public_key: wallet.public_key,
        },
      });
      setBiometricStatuses((prev) => ({ ...prev, [wallet.id]: status }));
      return status;
    } catch (error) {
      const status = {
        supported: false,
        configured: false,
        reason: errorMessage(error, t("features.biometric.statusFailed")),
      };
      setBiometricStatuses((prev) => {
        const previous = prev[wallet.id];
        return {
          ...prev,
          [wallet.id]: previous?.configured
            ? {
                ...previous,
                reason: status.reason,
              }
            : status,
        };
      });
      return status;
    }
  }, [supportsBiometricWallet, t]);

  const storeBiometricWalletPassword = useCallback(async (wallet: SavedWallet, password: string) => {
    if (!supportsBiometricWallet(wallet)) return false;
    setBiometricBusyWalletId(wallet.id);
    try {
      await invoke("biometric_wallet_store_password", {
        req: {
          wallet_id: wallet.id,
          public_key: wallet.public_key,
          password,
        },
      });
      setBiometricStatuses((prev) => ({
        ...prev,
        [wallet.id]: {
          supported: true,
          configured: true,
          reason: undefined,
        },
      }));
      toast.success(t("features.biometric.enabled"));
      return true;
    } catch (error) {
      toast.error(errorMessage(error, t("features.biometric.enableFailed")));
      return false;
    } finally {
      setBiometricBusyWalletId(null);
    }
  }, [supportsBiometricWallet, t]);

  const getBiometricWalletPassword = useCallback(async (wallet: SavedWallet): Promise<string | null> => {
    if (!supportsBiometricWallet(wallet)) return null;
    const cachedStatus = biometricStatusFor(wallet);
    const status =
      cachedStatus?.configured || cachedStatus?.supported === false
        ? cachedStatus
        : await refreshBiometricWalletStatus(wallet);
    if (!status.supported || !status.configured) return null;
    await waitForBiometricPromptReadiness();
    setBiometricBusyWalletId(wallet.id);
    try {
      return await invoke<string>("biometric_wallet_get_password", {
        req: {
          wallet_id: wallet.id,
          public_key: wallet.public_key,
        },
      });
    } catch (error) {
      const message = errorMessage(error, t("features.biometric.authFailed"));
      if (isResettableBiometricError(message)) {
        setBiometricStatuses((prev) => ({
          ...prev,
          [wallet.id]: {
            ...(prev[wallet.id] ?? { supported: true }),
            configured: false,
            reason: message,
          },
        }));
      }
      toast.error(message);
      return null;
    } finally {
      setBiometricBusyWalletId(null);
    }
  }, [biometricStatusFor, refreshBiometricWalletStatus, supportsBiometricWallet, t]);

  const deleteBiometricWalletPassword = useCallback(async (wallet: SavedWallet, options: { quiet?: boolean } = {}) => {
    if (!isTauriWebview()) return;
    setBiometricBusyWalletId(wallet.id);
    try {
      await invoke("biometric_wallet_delete_password", {
        req: {
          wallet_id: wallet.id,
          public_key: wallet.public_key,
        },
      });
      setBiometricStatuses((prev) => ({
        ...prev,
        [wallet.id]: {
          ...(prev[wallet.id] ?? { supported: true }),
          configured: false,
        },
      }));
      if (!options.quiet) toast.success(t("features.biometric.removed"));
    } catch (error) {
      if (!options.quiet) toast.error(errorMessage(error, t("features.biometric.removeFailed")));
    } finally {
      setBiometricBusyWalletId(null);
    }
  }, [t]);

  const scopedProgramProjectId = useCallback((sourceDir: string): string =>
    programProjectId(sourceDir, effectiveProgramWorkspaceOwner), [effectiveProgramWorkspaceOwner]);

  const isActiveProgramWorkspaceActor = useCallback((actor: WorkspaceActor | ProgramProject): boolean => {
    if (!effectiveProgramWorkspaceOwner) return false;
    const record = actor as WorkspaceActor & Partial<ProgramProject>;
    const owner = record.ownerWallet || record.createdBy;
    return owner === effectiveProgramWorkspaceOwner;
  }, [effectiveProgramWorkspaceOwner]);

  useEffect(() => {
    activeWalletContextRef.current = {
      walletId: effectiveWalletId,
      network: effectiveNetwork,
      rpcRequest: effectiveRpcRequest,
    };
  }, [effectiveNetwork, effectiveRpcRequest, effectiveWalletId]);

  useEffect(() => {
    if (!isTauriWebview()) return;
    wallets
      .filter((wallet) => wallet.keystore_version !== "unknown")
      .forEach((wallet) => {
        void refreshBiometricWalletStatus(wallet);
      });
  }, [refreshBiometricWalletStatus, wallets]);

  useEffect(() => {
    if (!isTauriWebview()) return;
    let unlisten: UnlistenFn | undefined;
    let unlistenConnect: UnlistenFn | undefined;
    const showConnectRequest = (request: DappConnectRequestEvent) => {
      void invoke("dapp_set_active_tab", {
        tabId: null,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }).catch(() => {});
      setDappConnectRequest(request);
      setDappConnectWalletId(effectiveWalletId);
      toast.message(tf("features.dapp-store.connectRequestToast", "DApp 请求连接钱包"));
    };
    const showSignRequest = (request: DappSignRequestEvent) => {
      void invoke("dapp_set_active_tab", {
        tabId: null,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }).catch(() => {});
      setDappSignRequest(request);
      setDappPassword("");
      setDappSaveBiometric(false);
      setDappTransactionPreview(null);
      setDappTransactionPreviewError(null);
      setDappTransactionPreviewLoading(request.method !== "signMessage");
      setDappPreviewDetailsOpen(false);
      toast.message(
        request.method === "signMessage"
          ? tf("features.dapp-store.messageRequestToast", "DApp 发起了消息签名请求")
          : tf("features.dapp-store.transactionRequestToast", "DApp 发起了交易签名请求"),
      );
    };
    void listen<DappConnectRequestEvent>("dapp://connect-request", (event) => {
      showConnectRequest(event.payload);
    }).then((cleanup) => {
      unlistenConnect = cleanup;
    }).catch(() => {
      // The web build has no Tauri event bridge.
    });
    void listen<DappSignRequestEvent>("dapp://sign-request", (event) => {
      showSignRequest(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    }).catch(() => {
      // The web build has no Tauri event bridge.
    });
    void invoke<DappConnectRequestEvent | null>("dapp_pending_connect_request")
      .then((request) => {
        if (request) showConnectRequest(request);
      })
      .catch(() => {});
    void invoke<DappSignRequestEvent | null>("dapp_pending_sign_request")
      .then((request) => {
        if (request) showSignRequest(request);
      })
      .catch(() => {});
    return () => {
      unlisten?.();
      unlistenConnect?.();
    };
  }, [effectiveWalletId, tf]);

  useEffect(() => {
    if (!dappSignRequest || dappSignRequest.method === "signMessage") {
      setDappTransactionPreview(null);
      setDappTransactionPreviewError(null);
      setDappTransactionPreviewLoading(false);
      return;
	    }
	    let cancelled = false;
	    setDappTransactionPreview(null);
	    setDappTransactionPreviewError(null);
	    setDappTransactionPreviewLoading(true);
	    void (async () => {
	      try {
	        const response = await apiFetch("external-sign/preview", {
	          method: "POST",
	          headers: { "Content-Type": "application/json" },
	          body: JSON.stringify({
	            required_signer: dappSignRequest.wallet_public_key,
	            transaction_base64: dappSignRequest.transaction_base64,
	            transaction_format: dappSignRequest.transaction_format || "auto",
	            known_programs: dappSignRequest.known_programs ?? [],
	          }),
	        });
	        const data = await response.json();
	        if (!response.ok) {
	          throw new Error(data.error || tf("features.dapp-store.previewFailed", "交易预览失败"));
	        }
	        if (!cancelled) {
	          setDappTransactionPreview(data as DappTransactionPreview);
	        }
	      } catch (error) {
	        if (!cancelled) {
	          setDappTransactionPreviewError(errorMessage(error, tf("features.dapp-store.previewFailed", "交易预览失败")));
	        }
	      } finally {
	        if (!cancelled) {
	          setDappTransactionPreviewLoading(false);
	        }
	      }
	    })();
	    return () => {
	      cancelled = true;
	    };
	  }, [dappSignRequest, tf]);

  const loadProgramDeploymentJournal = useCallback(async (
    intent: ProgramDeploymentJournalIntent,
    options: { preserveCurrent?: boolean } = {},
  ) => {
    const intentKey = programDeploymentIntentKey(intent);
    if (options.preserveCurrent && deploymentJournalInFlightIntentKeyRef.current === intentKey) {
      return;
    }
    deploymentJournalInFlightIntentKeyRef.current = intentKey;
    const requestId = deploymentJournalRequestIdRef.current + 1;
    deploymentJournalRequestIdRef.current = requestId;
    deploymentJournalLoadedIntentKeyRef.current = intentKey;
    setProgramDeploymentJournal((previous) =>
      options.preserveCurrent && previous.intentKey === intentKey
        ? { ...previous, loading: true, error: undefined }
        : {
            intentKey,
            network: intent.network,
            genesisHash: intent.genesisHash,
            writeChunkBytes: 0,
            writeChunkCount: 0,
            journal: null,
            deploymentAttempts: [],
            conflictingJournal: null,
            conflictingDeploymentAttempts: [],
            loading: true,
            error: undefined,
          },
    );

    try {
      const response = await apiFetch("program/deployment-journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: intent.requestNetwork,
          expected_genesis_hash: intent.genesisHash,
          expected_program_id: intent.programId,
          expected_program_sha256: intent.programSha256,
          program_len: intent.programLen,
          max_data_len: intent.maxDataLen,
          expected_upgrade_authority: intent.upgradeAuthority,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("features.program-deploy.journalLoadError"));
      }
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        data.network !== intent.network ||
        data.genesis_hash !== intent.genesisHash ||
        !Array.isArray(data.deployment_attempts) ||
        !Array.isArray(data.conflicting_deployment_attempts || []) ||
        (data.journal !== null && data.journal === undefined) ||
        (data.conflicting_journal !== null &&
          data.conflicting_journal !== undefined &&
          (typeof data.conflicting_journal !== "object" || Array.isArray(data.conflicting_journal)))
      ) {
        throw new Error(t("features.program-deploy.journalInvalid"));
      }
      const writeChunkBytes =
        Number.isSafeInteger(data.write_chunk_bytes) && Number(data.write_chunk_bytes) > 0
          ? Number(data.write_chunk_bytes)
          : FALLBACK_PROGRAM_WRITE_CHUNK_BYTES;
      const writeChunkCount =
        Number.isSafeInteger(data.write_chunk_count) && Number(data.write_chunk_count) >= 0
          ? Number(data.write_chunk_count)
          : Math.ceil(intent.programLen / writeChunkBytes);
      const journal = data.journal === null
        ? null
        : parseProgramDeploymentJournalRecord(data.journal, intent);
      const deploymentAttempts = data.deployment_attempts.map((attempt: unknown) =>
        parseProgramDeploymentAttemptRecord(attempt, intent),
      );
      const conflictingJournal =
        data.conflicting_journal === null || data.conflicting_journal === undefined
          ? null
          : parseProgramDeploymentJournalRecord(data.conflicting_journal, intent, { requireIntentMatch: false });
      const conflictingDeploymentAttempts = (data.conflicting_deployment_attempts || []).map((attempt: unknown) =>
        parseProgramDeploymentAttemptRecord(attempt, intent),
      );
      if (requestId !== deploymentJournalRequestIdRef.current) return;
      if (conflictingJournal && conflictingJournal.max_data_len !== intent.maxDataLen) {
        deploymentJournalLoadedIntentKeyRef.current = "";
        setFormData((prev) => {
          const programId = String(prev.expectedProgramId || "").trim();
          const programSha256 = String(prev.programSoSha256 || "").trim().toLowerCase();
          const programLen = Number(prev.programSoSize || 0);
          const upgradeAuthority = String(prev.expectedUpgradeAuthority || "").trim();
          if (
            programId !== intent.programId ||
            programSha256 !== intent.programSha256 ||
            programLen !== intent.programLen ||
            upgradeAuthority !== intent.upgradeAuthority ||
            conflictingJournal.max_data_len < programLen
          ) {
            return prev;
          }
          return {
            ...prev,
            max_data_len: String(conflictingJournal.max_data_len),
          };
        });
      }
      setProgramDeploymentJournal({
        intentKey,
        network: data.network,
        genesisHash: data.genesis_hash,
        writeChunkBytes,
        writeChunkCount,
        journal,
        deploymentAttempts,
        conflictingJournal,
        conflictingDeploymentAttempts,
        loading: false,
      });
    } catch (error) {
      if (requestId !== deploymentJournalRequestIdRef.current) return;
      const message = error instanceof Error ? error.message : t("features.program-deploy.journalLoadError");
      setProgramDeploymentJournal((previous) =>
        options.preserveCurrent && previous.intentKey === intentKey
          ? { ...previous, loading: false, error: message }
          : {
              intentKey,
              network: intent.network,
              genesisHash: intent.genesisHash,
              writeChunkBytes: 0,
              writeChunkCount: 0,
              journal: null,
              deploymentAttempts: [],
              conflictingJournal: null,
              conflictingDeploymentAttempts: [],
              loading: false,
              error: message,
            },
      );
    } finally {
      if (deploymentJournalInFlightIntentKeyRef.current === intentKey) {
        deploymentJournalInFlightIntentKeyRef.current = "";
      }
    }
  }, [t]);

  useEffect(() => {
    if (selectedForm !== "program-deploy") {
      programSoReadVersionRef.current += 1;
      clearProgramKeypairMaterial();
    }
  }, [clearProgramKeypairMaterial, selectedForm]);

  useEffect(() => () => {
    deploymentJournalRequestIdRef.current += 1;
    programSoReadVersionRef.current += 1;
    programKeypairReadVersionRef.current += 1;
    programKeypairBytesRef.current?.fill(0);
    programKeypairBytesRef.current = null;
    if (programKeypairInputRef.current) {
      programKeypairInputRef.current.value = "";
    }
    clearPasswordPromptSecrets();
  }, [clearPasswordPromptSecrets]);

  useEffect(() => {
    const selectedWallet = wallets.find(
      (wallet) => wallet.id === String(formData.wallet_id || "").trim(),
    );
    const programLen = Number(formData.programSoSize || 0);
    const requestedMaxDataLen = String(formData.max_data_len ?? "").trim();
    const maxDataLen = requestedMaxDataLen ? Number(requestedMaxDataLen) : programLen;
    const programId = String(formData.expectedProgramId || "").trim();
    const programSha256 = String(formData.programSoSha256 || "").trim().toLowerCase();
    const upgradeAuthority = String(
      selectedWallet?.public_key || formData.expectedUpgradeAuthority || "",
    ).trim();
    const intent: ProgramDeploymentJournalIntent = {
      requestNetwork: effectiveRpcRequest,
      network: effectiveNetwork,
      genesisHash: SOLANA_GENESIS_HASHES[effectiveNetwork],
      programId,
      programSha256,
      programLen,
      maxDataLen,
      upgradeAuthority,
    };
    const ready =
      selectedForm === "program-deploy" &&
      Boolean(formData.programSoBase64) &&
      programKeypairMetadata?.programId === programId &&
      isLikelySolanaPublicKey(programId) &&
      isLikelySolanaPublicKey(upgradeAuthority) &&
      /^[a-f0-9]{64}$/.test(programSha256) &&
      Number.isSafeInteger(programLen) &&
      programLen > 0 &&
      Number.isSafeInteger(maxDataLen) &&
      maxDataLen >= programLen &&
      maxDataLen <= MAX_PROGRAM_SO_FILE_BYTES;

    if (!ready) {
      if (selectedForm === "program-deploy" && lastProgramDeploymentIntent) {
        const fallbackIntentKey = programDeploymentIntentKey(lastProgramDeploymentIntent);
        if (deploymentJournalLoadedIntentKeyRef.current !== fallbackIntentKey) {
          void loadProgramDeploymentJournal(lastProgramDeploymentIntent, { preserveCurrent: true });
        }
        return;
      }
      deploymentJournalRequestIdRef.current += 1;
      deploymentJournalLoadedIntentKeyRef.current = "";
      setProgramDeploymentJournal((previous) =>
        previous.intentKey || previous.loading || previous.error || previous.journal
          ? {
              intentKey: "",
              network: "",
              genesisHash: "",
              writeChunkBytes: 0,
              writeChunkCount: 0,
              journal: null,
              deploymentAttempts: [],
              conflictingJournal: null,
              conflictingDeploymentAttempts: [],
              loading: false,
            }
          : previous,
      );
      return;
    }
    const intentKey = programDeploymentIntentKey(intent);
    if (deploymentJournalLoadedIntentKeyRef.current === intentKey) return;
    void loadProgramDeploymentJournal(intent);
    return () => {
      deploymentJournalRequestIdRef.current += 1;
    };
  }, [
    effectiveNetwork,
    effectiveRpcRequest,
    formData.expectedProgramId,
    formData.expectedUpgradeAuthority,
    formData.max_data_len,
    formData.programSoBase64,
    formData.programSoSha256,
    formData.programSoSize,
    formData.wallet_id,
    lastProgramDeploymentIntent,
    loadProgramDeploymentJournal,
    programKeypairMetadata?.programId,
    selectedForm,
    wallets,
  ]);

  useEffect(() => {
    const journal = programDeploymentJournal.journal;
    if (
      selectedForm !== "program-deploy" ||
      !journal ||
      !PROGRAM_BUFFER_RECOVERY_STATUSES.has(journal.status) ||
      !isLikelySolanaPublicKey(journal.buffer_address)
    ) {
      return;
    }
    setFormData((prev) => {
      const programId = String(prev.expectedProgramId || "").trim();
      const programSha256 = String(prev.programSoSha256 || "").trim().toLowerCase();
      const programLen = Number(prev.programSoSize || 0);
      if (
        programId !== journal.program_id ||
        programSha256 !== journal.program_sha256 ||
        programLen !== journal.program_len ||
        journal.max_data_len < programLen
      ) {
        return prev;
      }
      const nextMaxDataLen = String(journal.max_data_len);
      const currentMaxDataLen = String(prev.max_data_len ?? "").trim();
      const currentEffectiveMaxDataLen = currentMaxDataLen || String(programLen);
      const currentResumeBufferAddress = String(prev.resumeBufferAddress || "").trim();
      if (
        currentResumeBufferAddress === journal.buffer_address &&
        currentEffectiveMaxDataLen === nextMaxDataLen
      ) {
        return prev;
      }
      return {
        ...prev,
        resumeBufferAddress: journal.buffer_address,
        max_data_len: nextMaxDataLen,
      };
    });
  }, [programDeploymentJournal.journal, selectedForm]);

  useEffect(() => {
    const panel = programDeploymentLogPanelRef.current;
    if (!panel) return;
    panel.scrollTop = panel.scrollHeight;
  }, [
    programDeploymentJournal.deploymentAttempts.length,
    programDeploymentJournal.error,
    programDeploymentJournal.journal?.status,
    programDeploymentJournal.journal?.updated_at,
    programDeploymentJournal.loading,
    formData.sourceBuildError,
    formData.sourceBuildStatus,
    formData.sourceBuildStderr,
    formData.sourceBuildStdout,
    formData.sourceValidationErrors,
    formData.sourceImportWarnings,
    programSourceLoading,
  ]);

  useEffect(() => {
    if (selectedForm !== "program-deploy") return;
    const timer = window.setInterval(() => setProgramDeploymentNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [selectedForm]);

  useEffect(() => {
    walletTransactionsRef.current = walletTransactions;
  }, [walletTransactions]);

  useEffect(() => {
    walletAssetsRef.current = walletAssets;
  }, [walletAssets]);

  useEffect(() => {
    if (
      !walletAssets ||
      walletAssets.network !== effectiveNetwork ||
      !walletAssets.solBalance ||
      walletAssets.solBalance === "--"
    ) {
      return;
    }
    setWalletSolBalanceCache((prev) => {
      if (prev[walletAssets.address] === walletAssets.solBalance) return prev;
      return { ...prev, [walletAssets.address]: walletAssets.solBalance };
    });
  }, [effectiveNetwork, walletAssets]);

  useEffect(() => {
    const tokenCount = walletAssets?.tokens.length ?? 0;
    setVisibleTokenCount((count) => {
      if (tokenCount === 0) return TOKEN_ASSET_PAGE_SIZE;
      return Math.max(TOKEN_ASSET_PAGE_SIZE, Math.min(count, Math.ceil(tokenCount / TOKEN_ASSET_PAGE_SIZE) * TOKEN_ASSET_PAGE_SIZE));
    });
  }, [walletAssets?.address, walletAssets?.network, walletAssets?.tokens.length]);

  useEffect(() => {
    if (
      !walletAssets ||
      !selectedForm ||
      !CURRENT_WALLET_TOKEN_BALANCE_FORM_IDS.has(selectedForm) ||
      walletAssets.network !== effectiveNetwork
    ) {
      return;
    }
    const mint = String((tokenActionContext?.mint ?? formData.mint) || "").trim();
    if (!mint) return;
    const balance = aggregateTokenBalance(walletAssets.tokens, mint);
    if (!balance) return;
    setTokenActionContext((prev) => {
      if (!prev || String(prev.mint ?? "").trim() !== mint) return prev;
      if (String(prev.token_raw_amount ?? "") === balance.rawAmount) return prev;
      return {
        ...prev,
        amount: balance.amount,
        token_balance: balance.amount,
        token_raw_amount: balance.rawAmount,
        decimals: balance.decimals,
      };
    });
    setFormData((prev) => {
      const formMint = String(prev.mint ?? "").trim();
      if (formMint !== mint || String(prev.token_raw_amount ?? "") === balance.rawAmount) return prev;
      return {
        ...prev,
        token_balance: balance.amount,
        token_raw_amount: balance.rawAmount,
        decimals: balance.decimals,
      };
    });
  }, [effectiveNetwork, formData.mint, formData.token_raw_amount, selectedForm, tokenActionContext?.mint, walletAssets]);

  const requestNetwork = useCallback((value?: unknown): string => {
    const hasFormNetwork = typeof formData.network === "string" || typeof formData.network === "number";
    if (value === undefined && (!hasFormNetwork || currentNetwork(formData.network) === effectiveNetwork)) {
      return rpcRequestValue(selectedRpc);
    }
    const raw =
      typeof value === "string" || typeof value === "number"
        ? value
        : hasFormNetwork
        ? formData.network
        : effectiveNetwork;
    return typeof raw === "string" && raw.startsWith("rpc:") ? raw : currentNetwork(raw);
  }, [effectiveNetwork, formData.network, selectedRpc]);

  const pumpSellSuccessMessage = (
    data: { dex?: unknown },
    fallbackFormId: "pumpfun-sell" | "pumpswap-sell",
  ): string => {
    const dex = typeof data.dex === "string" ? data.dex : "";
    if (fallbackFormId === "pumpfun-sell" && dex === "pumpswap") {
      return t("features.pumpfun-sell.autoPumpswapSuccess");
    }
    if (dex === "pumpfun") return t("features.pumpfun-sell.success");
    if (dex === "pumpswap") return t("features.pumpswap-sell.success");
    return t(`features.${fallbackFormId}.success`);
  };

  const setCurrentWallet = useCallback((walletId: string) => {
    setCurrentWalletId(walletId);
    saveCurrentWalletId(walletId);
    setFormData((prev) => {
      if (!selectedForm || !authFormsWithWallets.has(selectedForm)) return prev;
      return walletId ? { ...prev, wallet_id: walletId } : prev;
    });
  }, [selectedForm]);

  const setAppRpc = useCallback((profileId: string) => {
    const profile = rpcProfiles.find((item) => item.id === profileId);
    if (!profile) return;
    setSelectedRpcId(profileId);
    setSettingsNetwork(profile.network);
    saveSelectedRpcProfileId(profileId);
    setFormData((prev) => ({ ...prev, network: profile.network }));
  }, [rpcProfiles]);

  const setAppNetwork = useCallback((network: AppNetwork) => {
    setSettingsNetwork(network);
    const nextProfile = rpcProfiles.find((profile) => profile.network === network && profile.id === selectedRpcId)
      || rpcProfiles.find((profile) => profile.network === network)
      || DEFAULT_RPC_PROFILES.find((profile) => profile.network === network)
      || DEFAULT_RPC_PROFILES[0];
    setSelectedRpcId(nextProfile.id);
    saveSelectedRpcProfileId(nextProfile.id);
    setFormData((prev) => ({ ...prev, network }));
  }, [rpcProfiles, selectedRpcId]);

  const handleAddRpcProfile = () => {
    const url = validateRpcUrl(newRpcUrl);
    const name = newRpcName.trim();
    if (!name || !url) {
      toast.error(t("features.settings.rpcInvalid"));
      return;
    }

    const nextProfile: RpcProfile = {
      id: `custom-${Date.now().toString(36)}`,
      name,
      url,
      network: settingsNetwork,
    };
    const nextProfiles = mergeRpcProfiles([...rpcProfiles.filter((profile) => profile.id !== nextProfile.id), nextProfile]);
    const existing = rpcProfiles.find((profile) => rpcProfileKey(profile) === rpcProfileKey(nextProfile));
    if (existing) {
      setAppRpc(existing.id);
      setNewRpcName("");
      setNewRpcUrl("");
      toast.success(t("features.settings.rpcSelected"));
      return;
    }

    setRpcProfiles(nextProfiles);
    saveCustomRpcProfiles(nextProfiles);
    setNewRpcName("");
    setNewRpcUrl("");
    setSelectedRpcId(nextProfile.id);
    saveSelectedRpcProfileId(nextProfile.id);
    setFormData((prev) => ({ ...prev, network: nextProfile.network }));
    toast.success(t("features.settings.rpcAdded"));
  };

  const handleRemoveRpcProfile = (profileId: string) => {
    const profile = rpcProfiles.find((item) => item.id === profileId);
    if (!profile || profile.builtin) return;
    const nextProfiles = rpcProfiles.filter((item) => item.id !== profileId);
    setRpcProfiles(nextProfiles);
    saveCustomRpcProfiles(nextProfiles);
    if (selectedRpcId === profileId) {
      const fallbackId = defaultRpcProfileId(profile.network);
      setSelectedRpcId(fallbackId);
      setSettingsNetwork(profile.network);
      saveSelectedRpcProfileId(fallbackId);
      setFormData((prev) => ({ ...prev, network: profile.network }));
    }
    toast.success(t("features.settings.rpcRemoved"));
  };

  const loadWallets = useCallback(async () => {
    setWalletsLoading(true);
    setWalletsLoadError(null);
    try {
      let lastError: unknown = null;
      let loadedWallets: SavedWallet[] | null = null;
      for (let attempt = 0; attempt <= WALLET_LIST_LOAD_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          loadedWallets = await fetchWallets();
          break;
        } catch (error) {
          lastError = error;
          const delayMs = WALLET_LIST_LOAD_RETRY_DELAYS_MS[attempt];
          if (delayMs === undefined) break;
          await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        }
      }
      if (!loadedWallets) {
        throw lastError ?? new Error(t("features.walletContext.walletsLoadFailed"));
      }
      setWalletsLoadError(null);
      setWallets(loadedWallets);
      const storedWalletId = loadStoredWalletId();
      const nextWalletId = loadedWallets.some((wallet) => wallet.id === storedWalletId)
        ? storedWalletId
        : loadedWallets[0]?.id || "";
      setCurrentWallet(nextWalletId);
      setFormData((prev) => {
        const prevWalletId = String(prev.wallet_id ?? "").trim();
        const prevWalletStillExists =
          !prevWalletId || loadedWallets.some((wallet) => wallet.id === prevWalletId);
        if (
          !selectedForm ||
          !authFormsWithWallets.has(selectedForm) ||
          String(prev.keystoreJson ?? "").trim()
        ) {
          return prevWalletStillExists ? prev : { ...prev, wallet_id: undefined };
        }
        if (!prevWalletStillExists) {
          return nextWalletId ? { ...prev, wallet_id: nextWalletId } : { ...prev, wallet_id: undefined };
        }
        if (!nextWalletId || prevWalletId) {
          return prev;
        }
        return { ...prev, wallet_id: nextWalletId };
      });
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : "";
      const message = rawMessage
        ? t("features.walletContext.walletsLoadFailedWithDetail", { message: rawMessage })
        : t("features.walletContext.walletsLoadFailed");
      setWalletsLoadError(message);
      toast.error(message);
    } finally {
      setWalletsLoading(false);
    }
  }, [selectedForm, setCurrentWallet, t]);

  const selectedSavedWallet = (): SavedWallet | undefined => {
    const walletId = String(formData.wallet_id ?? effectiveWalletId).trim();
    return walletId ? wallets.find((wallet) => wallet.id === walletId) : undefined;
  };

  const savedWalletFromForm = (state: FormState = formData): SavedWallet | undefined => {
    const walletId = String(state.wallet_id ?? "").trim();
    return walletId ? wallets.find((wallet) => wallet.id === walletId) : undefined;
  };

  const loadWalletAssets = useCallback(async (
    wallet?: SavedWallet,
    options: { refresh?: boolean; background?: boolean; force?: boolean } = {},
  ): Promise<WalletAssetsState | null> => {
    if (!wallet) {
      setWalletAssets(null);
      return null;
    }
    const refresh = options.refresh !== false;
    const background = options.background === true;
    const requestKey = `${wallet.public_key}:${effectiveRpcRequest}:${refresh ? "refresh" : "cache"}`;
    const walletKey = `${wallet.public_key}:${effectiveRpcRequest}`;
    if (refresh && !options.force) {
      const lastRefresh = lastAssetRefreshRef.current.get(walletKey) ?? 0;
      if (Date.now() - lastRefresh < ASSET_AUTO_REFRESH_TTL_MS) {
        const currentAssets = walletAssetsRef.current;
        return currentAssets?.address === wallet.public_key && currentAssets.network === effectiveNetwork
          ? currentAssets
          : null;
      }
    }
    const inFlight = walletAssetsInFlightRef.current.get(requestKey);
    if (inFlight) return inFlight;

    const request = (async (): Promise<WalletAssetsState | null> => {
      setWalletAssets((prev) => ({
        address: wallet.public_key,
        network: effectiveNetwork,
        solBalance:
          prev?.address === wallet.public_key && prev.network === effectiveNetwork ? prev.solBalance : "--",
        tokens: prev?.address === wallet.public_key && prev.network === effectiveNetwork ? prev.tokens : [],
        loading: !background,
        refreshing: background,
        cached: prev?.address === wallet.public_key && prev.network === effectiveNetwork ? prev.cached : undefined,
        updatedAt: prev?.address === wallet.public_key && prev.network === effectiveNetwork ? prev.updatedAt : undefined,
        error: prev?.address === wallet.public_key && prev.network === effectiveNetwork ? prev.error : undefined,
      }));

      const response = await apiFetch("wallet/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: wallet.public_key,
          network: effectiveRpcRequest,
          refresh,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("features.wallet-list.assetLoadFailed"));
      }
      if (!refresh && !data.updated_at) {
        setWalletAssets((prev) => ({
          address: wallet.public_key,
          network: effectiveNetwork,
          solBalance:
            prev?.address === wallet.public_key && prev.network === effectiveNetwork ? prev.solBalance : "--",
          tokens: prev?.address === wallet.public_key && prev.network === effectiveNetwork ? prev.tokens : [],
          loading: false,
          refreshing: false,
          cached: true,
        }));
        return null;
      }
      if (refresh) {
        lastAssetRefreshRef.current.set(walletKey, Date.now());
      }
      const nextAssetsBase: WalletAssetsState = {
        address: data.address || wallet.public_key,
        network: currentNetwork(data.network),
        solBalance: String(data.sol_balance ?? "0"),
        tokens: Array.isArray(data.tokens) ? data.tokens : [],
        loading: false,
        refreshing: false,
        cached: Boolean(data.cached),
        updatedAt: typeof data.updated_at === "number" ? data.updated_at : undefined,
        error: undefined,
      };
      const pendingAdjustment = pendingTokenBalanceAdjustmentRef.current;
      if (!pendingTokenBalanceAdjustmentStillNeeded(nextAssetsBase, pendingAdjustment)) {
        pendingTokenBalanceAdjustmentRef.current = undefined;
      }
      let nextAssets = applyPendingTokenBalanceAdjustmentToAssets(nextAssetsBase, pendingAdjustment);
      setWalletAssets((prev) => {
        const previousTokens =
          prev?.address === wallet.public_key && prev.network === effectiveNetwork ? prev.tokens : [];
        const mergedAssets = {
          ...nextAssetsBase,
          tokens: mergeTokenAssetMetadata(nextAssets.tokens, previousTokens),
        };
        nextAssets = applyPendingTokenBalanceAdjustmentToAssets(mergedAssets, pendingAdjustment);
        return nextAssets;
      });
      return nextAssets;
    })();

    walletAssetsInFlightRef.current.set(requestKey, request);
    try {
      return await request;
    } catch (err) {
      setWalletAssets((prev) => ({
        address: wallet.public_key,
        network: effectiveNetwork,
        solBalance: prev?.solBalance && prev.solBalance !== "--" ? prev.solBalance : "0",
        tokens: prev?.address === wallet.public_key ? prev.tokens : [],
        loading: false,
        refreshing: false,
        cached: prev?.address === wallet.public_key ? prev.cached : undefined,
        updatedAt: prev?.address === wallet.public_key ? prev.updatedAt : undefined,
        error: err instanceof Error ? err.message : "",
      }));
      return null;
    } finally {
      walletAssetsInFlightRef.current.delete(requestKey);
    }
  }, [effectiveNetwork, effectiveRpcRequest, t]);

  const loadCachedWalletSolBalances = useCallback(async (walletList: SavedWallet[]) => {
    if (walletList.length === 0) {
      setWalletSolBalanceCache({});
      return;
    }
    const cachedEntries = await Promise.all(
      walletList.map(async (wallet) => {
        try {
          const response = await apiFetch("wallet/assets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              address: wallet.public_key,
              network: effectiveRpcRequest,
              refresh: false,
            }),
          });
          const data = await response.json();
          if (!response.ok || data.updated_at == null) {
            return null;
          }
          return [wallet.public_key, String(data.sol_balance ?? "0")] as const;
        } catch {
          return null;
        }
      }),
    );

    const fromCache = new Map<string, string>();
    for (const entry of cachedEntries) {
      if (entry) fromCache.set(entry[0], entry[1]);
    }
    const live = walletAssetsRef.current;
    if (
      live &&
      live.network === effectiveNetwork &&
      live.solBalance &&
      live.solBalance !== "--" &&
      !fromCache.has(live.address)
    ) {
      fromCache.set(live.address, live.solBalance);
    }

    setWalletSolBalanceCache(Object.fromEntries(fromCache));

    const missing = walletList.filter((wallet) => !fromCache.has(wallet.public_key));
    if (missing.length === 0) return;

    const fetchedEntries = await Promise.all(
      missing.map(async (wallet) => {
        try {
          const response = await apiFetch("wallet/balance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              address: wallet.public_key,
              network: effectiveRpcRequest,
            }),
          });
          const data = await response.json();
          if (!response.ok || data.balance == null) return null;
          return [wallet.public_key, String(data.balance)] as const;
        } catch {
          return null;
        }
      }),
    );

    setWalletSolBalanceCache((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const entry of fetchedEntries) {
        if (!entry) continue;
        if (next[entry[0]] === entry[1]) continue;
        next[entry[0]] = entry[1];
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [effectiveNetwork, effectiveRpcRequest]);

  const loadWalletTransactions = useCallback(async (
    wallet?: SavedWallet,
    mode: "replace" | "append" = "replace",
    options: { force?: boolean } = {},
  ) => {
    if (!wallet) {
      setWalletTransactions(null);
      return;
    }
    const appendState =
      mode === "append" &&
      walletTransactionsRef.current?.address === wallet.public_key &&
      walletTransactionsRef.current.network === effectiveNetwork
        ? walletTransactionsRef.current
        : null;
    if (appendState && (!appendState.hasMore || appendState.loaded >= MAX_TRANSACTION_HISTORY || !appendState.nextBefore)) {
      return;
    }
    const before = appendState?.nextBefore;
    const walletKey = `${wallet.public_key}:${effectiveRpcRequest}`;
    const requestKey = `${walletKey}:${mode}:${before || ""}`;
    if (mode === "replace" && !options.force) {
      const lastRefresh = lastTransactionRefreshRef.current.get(walletKey) ?? 0;
      if (Date.now() - lastRefresh < TRANSACTION_AUTO_REFRESH_TTL_MS) {
        return;
      }
    }
    const inFlight = walletTransactionsInFlightRef.current.get(requestKey);
    if (inFlight) return inFlight;

    const request = (async () => {
      setWalletTransactions((prev) => ({
        address: wallet.public_key,
        network: effectiveNetwork,
        transactions:
          mode === "append" && prev?.address === wallet.public_key && prev.network === effectiveNetwork
            ? prev.transactions
            : [],
        nextBefore:
          mode === "append" && prev?.address === wallet.public_key && prev.network === effectiveNetwork
            ? prev.nextBefore
            : undefined,
        hasMore:
          mode === "append" && prev?.address === wallet.public_key && prev.network === effectiveNetwork
            ? prev.hasMore
            : true,
        loaded:
          mode === "append" && prev?.address === wallet.public_key && prev.network === effectiveNetwork
            ? prev.loaded
            : 0,
        loading: true,
      }));

      const response = await apiFetch("wallet/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: wallet.public_key,
          network: effectiveRpcRequest,
          limit: TRANSACTION_PAGE_SIZE,
          ...(before ? { before } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("features.wallet-list.transactionsLoadFailed"));
      }
      const nextPage = Array.isArray(data.transactions) ? data.transactions : [];
      const previous = appendState?.transactions ?? [];
      const seen = new Set(previous.map((item) => item.signature));
      const merged = [
        ...previous,
        ...nextPage.filter((item: WalletTransactionRecord) => !seen.has(item.signature)),
      ].slice(0, MAX_TRANSACTION_HISTORY);
      setWalletTransactions({
        address: data.address || wallet.public_key,
        network: currentNetwork(data.network),
        transactions: merged,
        nextBefore: typeof data.next_before === "string" ? data.next_before : undefined,
        hasMore: Boolean(data.has_more) && merged.length < MAX_TRANSACTION_HISTORY,
        loaded: merged.length,
        loading: false,
      });
      if (mode === "replace") {
        lastTransactionRefreshRef.current.set(walletKey, Date.now());
      }
    })();

    walletTransactionsInFlightRef.current.set(requestKey, request);
    try {
      return await request;
    } catch (err) {
      setWalletTransactions((prev) => ({
        address: wallet.public_key,
        network: effectiveNetwork,
        transactions: prev?.address === wallet.public_key ? prev.transactions : [],
        nextBefore: prev?.address === wallet.public_key ? prev.nextBefore : undefined,
        hasMore: prev?.address === wallet.public_key ? prev.hasMore : false,
        loaded: prev?.address === wallet.public_key ? prev.loaded : 0,
        loading: false,
        error: err instanceof Error ? err.message : "",
      }));
    } finally {
      walletTransactionsInFlightRef.current.delete(requestKey);
    }
  }, [effectiveNetwork, effectiveRpcRequest, t]);

  const loadNonceAccounts = useCallback(async (
    wallet?: SavedWallet,
    options: { force?: boolean } = {},
  ) => {
    if (!wallet) {
      setNonceAccounts(null);
      return;
    }
    const requestKey = `${wallet.public_key}:${effectiveRpcRequest}`;
    if (!options.force) {
      const lastRefresh = lastNonceRefreshRef.current.get(requestKey) ?? 0;
      if (Date.now() - lastRefresh < NONCE_AUTO_REFRESH_TTL_MS) {
        return;
      }
    }
    const inFlight = nonceAccountsInFlightRef.current.get(requestKey);
    if (inFlight) return inFlight;

    const request = (async () => {
      setNonceAccounts((prev) => ({
        owner: wallet.public_key,
        network: effectiveNetwork,
        nonceAccounts:
          prev?.owner === wallet.public_key && prev.network === effectiveNetwork ? prev.nonceAccounts : [],
        loading: true,
      }));

      const response = await apiFetch("nonce/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: wallet.public_key,
          network: effectiveRpcRequest,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("features.create-nonce.error"));
      }
      setNonceAccounts({
        owner: data.owner || wallet.public_key,
        network: currentNetwork(data.network),
        nonceAccounts: Array.isArray(data.nonce_accounts) ? data.nonce_accounts : [],
        loading: false,
      });
      lastNonceRefreshRef.current.set(requestKey, Date.now());
    })();

    nonceAccountsInFlightRef.current.set(requestKey, request);
    try {
      return await request;
    } catch (err) {
      setNonceAccounts((prev) => ({
        owner: wallet.public_key,
        network: effectiveNetwork,
        nonceAccounts: prev?.owner === wallet.public_key ? prev.nonceAccounts : [],
        loading: false,
        error: err instanceof Error ? err.message : "",
      }));
    } finally {
      nonceAccountsInFlightRef.current.delete(requestKey);
    }
  }, [effectiveNetwork, effectiveRpcRequest, t]);

  const loadCashbackInfo = useCallback(async (dex: "pumpfun" | "pumpswap", wallet?: SavedWallet) => {
    if (!wallet) {
      setCashbackInfo(null);
      return;
    }
    setCashbackInfo((prev) => ({
      owner: wallet.public_key,
      network: effectiveNetwork,
      dex,
      accumulator:
        prev?.owner === wallet.public_key && prev.network === effectiveNetwork && prev.dex === dex
          ? prev.accumulator
          : undefined,
      amountLamports:
        prev?.owner === wallet.public_key && prev.network === effectiveNetwork && prev.dex === dex
          ? prev.amountLamports
          : undefined,
      uiAmountString:
        prev?.owner === wallet.public_key && prev.network === effectiveNetwork && prev.dex === dex
          ? prev.uiAmountString
          : undefined,
      asset:
        prev?.owner === wallet.public_key && prev.network === effectiveNetwork && prev.dex === dex
          ? prev.asset
          : undefined,
      available:
        prev?.owner === wallet.public_key && prev.network === effectiveNetwork && prev.dex === dex
          ? prev.available
          : undefined,
      loading: true,
    }));
    try {
      const response = await apiFetch(`${dex}/cashback-info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: wallet.public_key,
          network: effectiveRpcRequest,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t(`features.${dex}-cashback.error`));
      }
      setCashbackInfo({
        owner: data.owner || wallet.public_key,
        network: currentNetwork(data.network),
        dex,
        accumulator: String(data.accumulator ?? ""),
        amountLamports: Number(data.amount_lamports ?? 0),
        uiAmountString: String(data.ui_amount_string ?? "0"),
        asset: String(data.asset ?? (dex === "pumpfun" ? "SOL" : "WSOL")),
        available: data.available === true,
        loading: false,
      });
    } catch (err) {
      setCashbackInfo({
        owner: wallet.public_key,
        network: effectiveNetwork,
        dex,
        loading: false,
        error: err instanceof Error ? err.message : "",
      });
    }
  }, [effectiveNetwork, effectiveRpcRequest, t]);

  useEffect(() => {
    if (!clientSettingsLoadedRef.current) {
      clientSettingsLoadedRef.current = true;
      const initialRpc = loadInitialRpcState();
      const initialRpcProfile =
        initialRpc.profiles.find((profile) => profile.id === initialRpc.selectedId) ||
        initialRpc.profiles[0] ||
        DEFAULT_RPC_PROFILES[0];
      setRpcProfiles(initialRpc.profiles);
      setSelectedRpcId(initialRpcProfile.id);
      setSettingsNetwork(initialRpcProfile.network || DEFAULT_NETWORK);
      setCurrentWalletId(loadStoredWalletId());
      setDownloadHistory(loadDownloadHistory());
    }
    void loadWallets();
  }, [loadWallets]);

  useEffect(() => {
    if (!effectiveWallet) {
      void loadWalletAssets(undefined);
      void loadWalletTransactions(undefined);
      void loadNonceAccounts(undefined);
      setVisibleTokenCount(TOKEN_ASSET_PAGE_SIZE);
      return;
    }
    void (async () => {
      await loadWalletAssets(effectiveWallet, { refresh: false });
      void loadWalletAssets(effectiveWallet, { refresh: true, background: true });
    })();
    setVisibleTokenCount(TOKEN_ASSET_PAGE_SIZE);
  }, [effectiveWallet, effectiveRpcRequest, loadWalletAssets, loadWalletTransactions, loadNonceAccounts]);

  useEffect(() => {
    setWalletSolBalanceCache({});
  }, [effectiveNetwork, effectiveRpcRequest]);

  useEffect(() => {
    void loadCachedWalletSolBalances(wallets);
  }, [wallets, effectiveNetwork, effectiveRpcRequest, loadCachedWalletSolBalances]);

  useEffect(() => {
    if (!effectiveWallet) return;
    const activeOperationForm =
      selectedForm !== "wallet-list" &&
      (
        CURRENT_WALLET_TOKEN_BALANCE_FORM_IDS.has(selectedForm || "") ||
        selectedForm === "transfer-sol" ||
        selectedForm === "wsol-workbench" ||
        selectedForm === "pump-workbench"
      );
    const intervalMs = activeOperationForm
      ? ACTIVE_OPERATION_ASSET_REFRESH_INTERVAL_MS
      : WALLET_ASSET_AUTO_REFRESH_INTERVAL_MS;
    const refresh = () => {
      void loadWalletAssets(effectiveWallet, { refresh: true, background: true, force: true });
    };
    const timer = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(timer);
  }, [effectiveWallet, effectiveRpcRequest, loadWalletAssets, selectedForm]);

  useEffect(() => {
    if (walletOverviewTab !== "transactions" || !effectiveWallet) {
      return;
    }
    const currentTransactions = walletTransactionsRef.current;
    const lastRefresh = lastTransactionRefreshRef.current.get(`${effectiveWallet.public_key}:${effectiveRpcRequest}`) ?? 0;
    if (
      currentTransactions?.address === effectiveWallet.public_key &&
      currentTransactions.network === effectiveNetwork &&
      Date.now() - lastRefresh < TRANSACTION_AUTO_REFRESH_TTL_MS
    ) {
      return;
    }
    void loadWalletTransactions(effectiveWallet);
  }, [effectiveWallet, effectiveNetwork, effectiveRpcRequest, walletOverviewTab, loadWalletTransactions]);

  useEffect(() => {
    if (selectedForm !== "nonce-workbench" && selectedForm !== "create-nonce") {
      return;
    }
    if (!effectiveWallet) {
      void loadNonceAccounts(undefined);
      return;
    }
    const currentNonceAccounts = nonceAccounts;
    const lastRefresh = lastNonceRefreshRef.current.get(`${effectiveWallet.public_key}:${effectiveRpcRequest}`) ?? 0;
    if (
      currentNonceAccounts?.owner === effectiveWallet.public_key &&
      currentNonceAccounts.network === effectiveNetwork &&
      Date.now() - lastRefresh < NONCE_AUTO_REFRESH_TTL_MS
    ) {
      return;
    }
    void loadNonceAccounts(effectiveWallet);
  }, [selectedForm, effectiveWallet, effectiveNetwork, effectiveRpcRequest, nonceAccounts, loadNonceAccounts]);

  useEffect(() => {
    if (selectedForm === "pumpfun-cashback") {
      void loadCashbackInfo("pumpfun", effectiveWallet);
    } else if (selectedForm === "pumpswap-cashback") {
      void loadCashbackInfo("pumpswap", effectiveWallet);
    }
  }, [selectedForm, effectiveWallet, loadCashbackInfo]);

  useEffect(() => {
    const needsMintInfo = selectedForm === "transfer-token" || selectedForm === "squads-token-transfer";
    const mint = String(formData.mint ?? "").trim();
    const network = currentNetwork(
      typeof formData.network === "string" || typeof formData.network === "number"
        ? formData.network
        : effectiveNetwork,
    );
    if (!needsMintInfo || !mint) {
      setTokenMintInfo(null);
      return;
    }

    let cancelled = false;
    setTokenMintInfo((prev) => ({
      mint,
      network,
      decimals: prev?.mint === mint && prev.network === network ? prev.decimals : undefined,
      supply: prev?.mint === mint && prev.network === network ? prev.supply : undefined,
      uiAmountString: prev?.mint === mint && prev.network === network ? prev.uiAmountString : undefined,
      loading: true,
    }));

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await apiFetch("token/mint-info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mint,
              network: network === effectiveNetwork ? effectiveRpcRequest : network,
            }),
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || t("features.transfer-token.mintInfoError"));
          }
          if (cancelled) return;
          const decimals = Number(data.decimals);
          setTokenMintInfo({
            mint: String(data.mint || mint),
            network: currentNetwork(data.network),
            decimals: Number.isInteger(decimals) ? decimals : undefined,
            supply: String(data.supply ?? ""),
            uiAmountString: String(data.ui_amount_string ?? ""),
            loading: false,
          });
          setFormData((prev) => {
            if (String(prev.mint ?? "").trim() !== mint) return prev;
            return {
              ...prev,
              decimals: Number.isInteger(decimals) ? decimals : undefined,
              tokenSupply: String(data.supply ?? ""),
              tokenUiSupply: String(data.ui_amount_string ?? ""),
            };
          });
        } catch (err) {
          if (cancelled) return;
          setTokenMintInfo({
            mint,
            network,
            loading: false,
            error: err instanceof Error ? err.message : t("features.transfer-token.mintInfoError"),
          });
          setFormData((prev) => {
            if (String(prev.mint ?? "").trim() !== mint) return prev;
            const next = { ...prev };
            delete next.decimals;
            delete next.tokenSupply;
            delete next.tokenUiSupply;
            return next;
          });
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedForm, formData.mint, formData.network, effectiveNetwork, effectiveRpcRequest, t]);

  useEffect(() => {
    setWorkspace(loadWorkspace());
  }, []);

  const programProjectSelectionScope = `${currentNetwork(effectiveNetwork)}|${effectiveProgramWorkspaceOwner}`;

  useEffect(() => {
    const [selectionNetwork, selectionOwner] = programProjectSelectionScope.split("|", 2);
    const visibleProjects = workspace.programProjects.filter((project) => {
      return project.network === selectionNetwork && project.ownerWallet === selectionOwner;
    });
    if (visibleProjects.length === 0) {
      if (selectedProgramProjectId) setSelectedProgramProjectId("");
      return;
    }
    if (!visibleProjects.some((project) => project.id === selectedProgramProjectId)) {
      setSelectedProgramProjectId(visibleProjects[0].id);
    }
  }, [programProjectSelectionScope, selectedProgramProjectId, workspace.programProjects]);

  useEffect(() => {
    if (!programInvoke.projectId) return;
    const project = workspace.programProjects.find((item) => item.id === programInvoke.projectId);
    if (
      project &&
      project.network === currentNetwork(effectiveNetwork) &&
      isActiveProgramWorkspaceActor(project)
    ) {
      return;
    }
    setProgramInvoke({
      idlJsonText: "",
      programId: "",
      selectedInstruction: "",
      argValues: {},
      accountValues: {},
      signerWalletIds: {},
      signerPasswords: {},
      loading: false,
    });
  }, [
    effectiveNetwork,
    isActiveProgramWorkspaceActor,
    programInvoke.projectId,
    workspace.programProjects,
  ]);

  useEffect(() => {
    const preventNumberInputWheel = (event: WheelEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== "number") {
        return;
      }
      event.preventDefault();
      target.blur();
    };

    window.addEventListener("wheel", preventNumberInputWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("wheel", preventNumberInputWheel, { capture: true });
    };
  }, []);

  const closeDropdownMenus = useCallback(() => {
    setWalletActionsMenuOpen(null);
    setWalletFaucetMenuOpen(false);
    document.querySelectorAll<HTMLDetailsElement>("details[data-close-on-outside][open]").forEach((details) => {
      details.open = false;
    });
  }, []);

  useEffect(() => {
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (!(target instanceof Element) || !target.closest("[data-wallet-actions-menu]")) {
        setWalletActionsMenuOpen(null);
      }
      if (!(target instanceof Element) || !target.closest("[data-wallet-faucet-menu]")) {
        setWalletFaucetMenuOpen(false);
      }

      document.querySelectorAll<HTMLDetailsElement>("details[data-close-on-outside][open]").forEach((details) => {
        if (!details.contains(target)) {
          details.open = false;
        }
      });
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDropdownMenus();
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeDropdownMenus]);

  const updateWorkspace = (updater: (prev: SquadsWorkspace) => SquadsWorkspace) => {
    setWorkspace((prev) => {
      const next = updater(prev);
      saveWorkspace(next);
      return next;
    });
  };

  useEffect(() => {
    if (!effectiveProgramWorkspaceOwner || (workspace.programProjects.length === 0 && workspace.programs.length === 0)) {
      return;
    }
    let changed = false;
    const migratedProjects = new Map<string, ProgramProject>();
    for (const project of workspace.programProjects) {
      if (project.ownerWallet) {
        migratedProjects.set(project.id, project);
        continue;
      }
      changed = true;
      const nextProjectId = scopedProgramProjectId(project.sourceDir);
      const migratedProject: ProgramProject = {
        ...project,
        id: nextProjectId,
        ownerWallet: effectiveProgramWorkspaceOwner,
        ownerWalletLabel: effectiveProgramWorkspaceOwnerLabel,
        plans: (project.plans || []).map((plan) => ({
          ...plan,
          id: programPlanId(nextProjectId, plan.kind, plan.network, plan.programId, plan.multisig),
          projectId: nextProjectId,
        })),
        history: (project.history || []).map((record) => ({
          ...record,
          projectId: nextProjectId,
        })),
      };
      const existing = migratedProjects.get(nextProjectId);
      migratedProjects.set(nextProjectId, existing
        ? {
            ...existing,
            ...migratedProject,
            plans: [...migratedProject.plans, ...(existing.plans || [])].slice(0, 20),
            history: dedupeProgramDeploymentHistory([
              ...(migratedProject.history || []),
              ...(existing.history || []),
            ]).slice(0, 100),
            updatedAt: Math.max(existing.updatedAt || 0, migratedProject.updatedAt || 0),
          }
        : migratedProject);
    }
    const migratedPrograms = workspace.programs.map((program) => {
      if (program.createdBy) return program;
      changed = true;
      return {
        ...program,
        createdBy: effectiveProgramWorkspaceOwner,
        createdByLabel: effectiveProgramWorkspaceOwnerLabel,
      };
    });
    if (!changed) return;
    updateWorkspace((prev) => ({
      ...prev,
      programs: migratedPrograms,
      programProjects: [...migratedProjects.values()],
    }));
  }, [
    effectiveProgramWorkspaceOwner,
    effectiveProgramWorkspaceOwnerLabel,
    scopedProgramProjectId,
    workspace.programProjects,
    workspace.programs,
  ]);

  useEffect(() => {
    const candidates = workspace.programProjects
      .filter((project) => isActiveProgramWorkspaceActor(project))
      .flatMap((project) =>
        (project.history || [])
          .filter((record) =>
            record.kind === "direct-deploy" &&
            isUnfinishedProgramDeploymentStatus(record.status) &&
            record.programId,
          )
          .map((record) => ({ project, record })),
      );
    if (candidates.length === 0) return;
    let cancelled = false;
    const reconcile = async () => {
      for (const { project, record } of candidates.slice(0, 5)) {
        const network = currentNetwork(record.network || project.network || effectiveNetwork);
        const intent: ProgramDeploymentJournalIntent = {
          requestNetwork: network,
          network,
          genesisHash: SOLANA_GENESIS_HASHES[network],
          programId: String(record.programId || ""),
          programSha256: "0".repeat(64),
          programLen: 1,
          maxDataLen: 1,
          upgradeAuthority: "11111111111111111111111111111112",
        };
        try {
          const response = await apiFetch("program/deployment-journal/by-program", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              network: intent.requestNetwork,
              expected_genesis_hash: intent.genesisHash,
              program_id: intent.programId,
            }),
          });
          const data = await response.json();
          if (cancelled || !response.ok || !data?.journal) continue;
          const journalIntent = {
            ...intent,
            programSha256: String(data.journal.program_sha256 || ""),
            programLen: Number(data.journal.program_len || 0),
            maxDataLen: Number(data.journal.max_data_len || 0),
            upgradeAuthority: String(data.journal.upgrade_authority || ""),
          };
          const journal = parseProgramDeploymentJournalRecord(data.journal, journalIntent);
          if (journal.status !== "finalized") continue;
          updateWorkspace((prev) => ({
            ...prev,
            programProjects: prev.programProjects.map((item) =>
              item.id !== project.id
                ? item
                : {
                    ...item,
                    history: dedupeProgramDeploymentHistory(
                      (item.history || []).map((historyItem) =>
                        historyItem.id !== record.id
                          ? historyItem
                          : mergeProgramDeploymentHistoryWithJournal(
                              historyItem,
                              programDeploymentJournalToHistoryItem(
                                item,
                                journal,
                                [],
                                network,
                                "finalized",
                              ),
                            ),
                      ),
                    ),
                  },
            ),
          }));
        } catch {
          // Best-effort local reconciliation; leave the saved history unchanged if the journal is unavailable.
        }
      }
    };
    void reconcile();
    return () => {
      cancelled = true;
    };
  }, [effectiveNetwork, isActiveProgramWorkspaceActor, workspace.programProjects]);

  const saveWorkspaceMultisig = (
    addressValue: unknown,
    vaultValue?: unknown,
    labelValue?: unknown,
    networkValue?: unknown,
    actor: WorkspaceActor = {},
  ) => {
    const address = String(addressValue ?? "").trim();
    if (!address) return;
    const vault = String(vaultValue ?? "").trim() || undefined;
    const label = String(labelValue ?? "").trim() || undefined;
    const network = currentNetwork(
      typeof networkValue === "string" || typeof networkValue === "number"
        ? networkValue
        : effectiveNetwork,
    );
    const updatedAt = Date.now();
    updateWorkspace((prev) => ({
      ...prev,
      multisigs: (() => {
        const existing = prev.multisigs.find((item) => item.address === address && item.network === network);
        return [
          {
            ...existing,
            address,
            vault,
            label: label ?? existing?.label,
            network,
            updatedAt,
            createdBy: actor.createdBy ?? existing?.createdBy,
            createdByLabel: actor.createdByLabel ?? existing?.createdByLabel,
          },
          ...prev.multisigs.filter((item) => item.address !== address || item.network !== network),
        ].slice(0, 50);
      })(),
    }));
  };

  const saveWorkspaceProgram = (addressValue: unknown, labelValue?: unknown, networkValue?: unknown) => {
    const address = String(addressValue ?? "").trim();
    if (!address) return;
    const label = String(labelValue ?? "").trim() || undefined;
    const network = currentNetwork(
      typeof networkValue === "string" || typeof networkValue === "number"
        ? networkValue
        : effectiveNetwork,
    );
    const updatedAt = Date.now();
    updateWorkspace((prev) => ({
      ...prev,
      programs: [
        {
          address,
          label,
          network,
          updatedAt,
          createdBy: effectiveWalletActor.createdBy,
          createdByLabel: effectiveWalletActor.createdByLabel,
        },
        ...prev.programs.filter((item) =>
          item.address !== address ||
          item.network !== network ||
          item.createdBy !== effectiveWalletActor.createdBy,
        ),
      ].slice(0, 50),
    }));
  };

  const saveProgramProjectFromSource = (
    source: ProgramDeploySourceResponse,
    overrides: {
      network?: AppNetwork;
      upgradeAuthority?: string;
      multisig?: string;
      vault?: string;
      status?: ProgramDeploymentPlanStatus;
    } = {},
  ) => {
    const sourceDir = String(source.source_dir || "").trim();
    if (!sourceDir) return;
    const network = overrides.network || currentNetwork(source.manifest_network || formData.network || effectiveNetwork);
    const projectId = scopedProgramProjectId(sourceDir);
    const programId = String(source.expected_program_id || source.manifest_program_id || "").trim() || undefined;
    const programSha256 = String(source.program_so_sha256 || "").trim().toLowerCase() || undefined;
    const programBytes = Number(source.program_so_size || 0) || undefined;
    const upgradeAuthority =
      String(overrides.upgradeAuthority || source.manifest_upgrade_authority || formData.expectedUpgradeAuthority || "").trim() ||
      undefined;
    const updatedAt = Date.now();
    updateWorkspace((prev) => {
      const existing = prev.programProjects.find((project) => project.id === projectId);
      const existingPlans = existing?.plans || [];
      // Only refresh artifact fields on already-started deploy plans.
      // Do not create draft/ready plans just because the deploy form was opened or source was imported.
      const plans = existingPlans.map((plan) => {
        if (plan.kind !== "direct-deploy" || plan.network !== network) return plan;
        if (!isUnfinishedProgramDeploymentStatus(plan.status) && plan.status !== "finalized") {
          return plan;
        }
        const sameProgram = !plan.programId || !programId || plan.programId === programId;
        if (!sameProgram) return plan;
        const preservesRecoveryIntent = Boolean(
          isUnfinishedProgramDeploymentStatus(plan.status) &&
            plan.programId === programId &&
            plan.programSha256 === programSha256 &&
            plan.programBytes === programBytes,
        );
        return {
          ...plan,
          programId: programId || plan.programId,
          programSha256: programSha256 || plan.programSha256,
          programBytes: programBytes || plan.programBytes,
          maxDataLen: preservesRecoveryIntent ? plan.maxDataLen : (programBytes || plan.maxDataLen),
          upgradeAuthority: upgradeAuthority || plan.upgradeAuthority,
          updatedAt,
        };
      });
      const project: ProgramProject = {
        ...existing,
        id: projectId,
        name: existing?.name || sourceDirProjectName(sourceDir),
        sourceDir,
        ownerWallet: effectiveWalletActor.createdBy,
        ownerWalletLabel: effectiveWalletActor.createdByLabel,
        network,
        // Prefer keypair-derived Program ID from the imported source over any
        // previously cached project address (stale local workspace history).
        programId: programId || existing?.programId,
        programSha256: programSha256 || existing?.programSha256,
        programBytes: programBytes || existing?.programBytes,
        programSoName: source.program_so_name || existing?.programSoName,
        programSoPath: source.program_so_path || existing?.programSoPath,
        programKeypairPath: source.program_keypair_path || existing?.programKeypairPath,
        upgradeAuthority: upgradeAuthority || existing?.upgradeAuthority,
        multisig: overrides.multisig || existing?.multisig,
        vault: overrides.vault || existing?.vault,
        updatedAt,
        plans,
        history: existing?.history || [],
      };
      return {
        ...prev,
        programProjects: [
          project,
          ...prev.programProjects.filter((item) => item.id !== projectId),
        ].slice(0, 30),
      };
    });
  };

  const upsertProgramProjectPlan = (
    sourceDirValue: unknown,
    plan: Omit<ProgramDeploymentPlan, "id" | "projectId" | "createdAt" | "updatedAt" | "sourceDir"> & {
      sourceDir?: string;
    },
  ) => {
    const sourceDir = String(plan.sourceDir || sourceDirValue || "").trim();
    if (!sourceDir) return;
    const projectId = scopedProgramProjectId(sourceDir);
    const updatedAt = Date.now();
    const id = programPlanId(projectId, plan.kind, plan.network, plan.programId, plan.multisig);
    updateWorkspace((prev) => {
      const existingProject = prev.programProjects.find((project) => project.id === projectId);
      const existingPlan = existingProject?.plans.find((candidate) => candidate.id === id);
      const nextPlan: ProgramDeploymentPlan = {
        ...existingPlan,
        ...plan,
        id,
        projectId,
        sourceDir,
        createdAt: existingPlan?.createdAt || updatedAt,
        updatedAt,
      };
      const project: ProgramProject = {
        ...existingProject,
        id: projectId,
        name: existingProject?.name || sourceDirProjectName(sourceDir),
        sourceDir,
        ownerWallet: effectiveWalletActor.createdBy,
        ownerWalletLabel: effectiveWalletActor.createdByLabel,
        network: plan.network,
        programId: plan.programId || existingProject?.programId,
        programSha256: plan.programSha256 || existingProject?.programSha256,
        programBytes: plan.programBytes || existingProject?.programBytes,
        upgradeAuthority: plan.upgradeAuthority || existingProject?.upgradeAuthority,
        multisig: plan.multisig || existingProject?.multisig,
        vault: plan.vault || existingProject?.vault,
        updatedAt,
        plans: [
          nextPlan,
          ...(existingProject?.plans || []).filter((candidate) => candidate.id !== id),
        ].slice(0, 20),
        history: existingProject?.history || [],
      };
      return {
        ...prev,
        programProjects: [
          project,
          ...prev.programProjects.filter((candidate) => candidate.id !== projectId),
        ].slice(0, 30),
      };
    });
  };

  const upsertProgramDeploymentHistory = (
    sourceDirValue: unknown,
    entry: Omit<ProgramDeploymentHistoryItem, "id" | "projectId" | "sourceDir" | "createdAt"> & {
      id?: string;
      sourceDir?: string;
      createdAt?: number;
    },
  ): string | null => {
    const sourceDir = String(entry.sourceDir || sourceDirValue || "").trim();
    if (!sourceDir) return null;
    const projectId = scopedProgramProjectId(sourceDir);
    const createdAt = entry.createdAt || Date.now();
    const signature =
      entry.deploySignature || entry.signature || entry.createBufferSignature || entry.authoritySignature || null;
    const id =
      entry.id ||
      programDeploymentHistoryId(
        projectId,
        entry.kind,
        entry.network,
        createdAt,
        entry.programId,
        signature,
      );
    const item: ProgramDeploymentHistoryItem = {
      ...entry,
      id,
      projectId,
      sourceDir,
      createdAt,
    };
    updateWorkspace((prev) => {
      const existingProject = prev.programProjects.find((project) => project.id === projectId);
      const existingHistoryItem = existingProject?.history.find((candidate) => candidate.id === id);
      const nextItem = {
        ...item,
        createdAt: entry.createdAt || existingHistoryItem?.createdAt || item.createdAt,
      };
      const history = [
        nextItem,
        ...(existingProject?.history || []).filter((candidate) => candidate.id !== id),
      ].slice(0, 100);
      const project: ProgramProject = {
        ...existingProject,
        id: projectId,
        name: existingProject?.name || sourceDirProjectName(sourceDir),
        sourceDir,
        ownerWallet: effectiveWalletActor.createdBy,
        ownerWalletLabel: effectiveWalletActor.createdByLabel,
        network: entry.network,
        programId: entry.programId || existingProject?.programId,
        programSha256: entry.programSha256 || existingProject?.programSha256,
        programBytes: entry.programBytes || existingProject?.programBytes,
        upgradeAuthority: entry.upgradeAuthority || existingProject?.upgradeAuthority,
        multisig: entry.multisig || existingProject?.multisig,
        vault: entry.vault || existingProject?.vault,
        updatedAt: Date.now(),
        plans: existingProject?.plans || [],
        history,
      };
      return {
        ...prev,
        programProjects: [
          project,
          ...prev.programProjects.filter((candidate) => candidate.id !== projectId),
        ].slice(0, 30),
      };
    });
    return id;
  };

  const removeProgramDeploymentHistoryRecord = (projectId: string, recordId: string) => {
    if (recordId.startsWith("journal-card:")) {
      setDismissedHistoryCardIds((prev) =>
        prev.includes(recordId) ? prev : [...prev, recordId],
      );
      toast.success(t("features.program-projects.historyRemoveJournalHidden"));
      return;
    }

    const project = workspace.programProjects.find((item) => item.id === projectId);
    if (!project) {
      toast.error(t("features.program-projects.historyRemoveMissing"));
      return;
    }

    if (recordId.startsWith("plan-card:")) {
      const planId = recordId.slice("plan-card:".length);
      const plan = (project.plans || []).find((item) => item.id === planId);
      if (!plan) {
        toast.error(t("features.program-projects.historyRemoveMissing"));
        return;
      }
      updateWorkspace((prev) => ({
        ...prev,
        programProjects: prev.programProjects.map((item) => {
          if (item.id !== projectId) return item;
          return {
            ...item,
            plans: (item.plans || []).filter((candidate) => candidate.id !== planId),
            history: (item.history || []).filter((candidate) => !planMatchesHistoryRecord(plan, candidate)),
            updatedAt: Date.now(),
          };
        }),
      }));
      toast.success(t("features.program-projects.historyRemoveSuccess"));
      return;
    }

    const historyItem = (project.history || []).find((item) => item.id === recordId);
    if (!historyItem) {
      toast.error(t("features.program-projects.historyRemoveMissing"));
      return;
    }

    updateWorkspace((prev) => ({
      ...prev,
      programProjects: prev.programProjects.map((item) => {
        if (item.id !== projectId) return item;
        return {
          ...item,
          history: (item.history || []).filter((candidate) => candidate.id !== recordId),
          plans: (item.plans || []).filter((plan) => !planMatchesHistoryRecord(plan, historyItem)),
          updatedAt: Date.now(),
        };
      }),
    }));
    toast.success(t("features.program-projects.historyRemoveSuccess"));
  };

  const requestRemoveProgramDeploymentHistoryRecord = (projectId: string, recordId: string) => {
    setHistoryDeletePrompt({ projectId, recordId });
  };

  const markProgramUpgradeHistoryExecuted = (
    proposalValue: unknown,
    multisigValue: unknown,
    signatureValue: unknown,
    networkValue?: unknown,
  ) => {
    const proposal = String(proposalValue || "").trim();
    const multisig = String(multisigValue || "").trim();
    if (!proposal || !multisig) return;
    const network = currentNetwork(
      typeof networkValue === "string" || typeof networkValue === "number"
        ? networkValue
        : effectiveNetwork,
    );
    const signature = String(signatureValue || "").trim() || null;
    updateWorkspace((prev) => ({
      ...prev,
      programProjects: prev.programProjects.map((project) => {
        const existing = (project.history || []).find(
          (item) =>
            item.kind === "squads-upgrade-proposal" &&
            item.proposal === proposal &&
            item.multisig === multisig &&
            item.network === network,
        );
        if (!existing) return project;
        const executed: ProgramDeploymentHistoryItem = {
          ...existing,
          id: programDeploymentHistoryId(
            project.id,
            "squads-upgrade-execute",
            network,
            Date.now(),
            existing.programId,
            signature,
          ),
          kind: "squads-upgrade-execute",
          status: "finalized",
          signature,
          completedAt: Date.now(),
        };
        return {
          ...project,
          updatedAt: Date.now(),
          history: [
            executed,
            ...(project.history || []).filter((item) => item.id !== executed.id),
          ].slice(0, 100),
          plans: project.plans.map((plan) =>
            plan.kind === "squads-upgrade" &&
            plan.proposal === proposal &&
            plan.multisig === multisig
              ? { ...plan, status: "finalized", updatedAt: Date.now() }
              : plan,
          ),
        };
      }),
    }));
  };

  const saveWorkspaceProposal = (
    addressValue: unknown,
    multisigValue: unknown,
    transactionIndexValue: unknown,
    kind?: string,
    status = "active",
    networkValue?: unknown,
    actor: WorkspaceActor = {},
  ) => {
    const address = String(addressValue ?? "").trim();
    const multisig = String(multisigValue ?? "").trim();
    if (!address || !multisig) return;
    const transactionIndex = String(transactionIndexValue ?? "").trim();
    const network = currentNetwork(
      typeof networkValue === "string" || typeof networkValue === "number"
        ? networkValue
        : effectiveNetwork,
    );
    const updatedAt = Date.now();
    updateWorkspace((prev) => ({
      ...prev,
      proposals: (() => {
        const existing = prev.proposals.find((item) => item.address === address && item.network === network);
        return [
          {
            ...existing,
            address,
            multisig,
            transactionIndex,
            status,
            kind: kind ?? existing?.kind,
            network,
            updatedAt,
            createdBy: actor.createdBy ?? existing?.createdBy,
            createdByLabel: actor.createdByLabel ?? existing?.createdByLabel,
          },
          ...prev.proposals.filter((item) => item.address !== address || item.network !== network),
        ].slice(0, 100);
      })(),
    }));
  };

  const removeWorkspaceItem = (
    kind: "multisigs" | "programs" | "proposals",
    address: string,
    network: AppNetwork,
  ) => {
    updateWorkspace((prev) => ({
      ...prev,
      [kind]: prev[kind].filter((item) => {
        if (item.address !== address || item.network !== network) return true;
        if (kind === "programs") {
          return item.createdBy !== effectiveWalletActor.createdBy;
        }
        return false;
      }),
    }));
  };

  const refreshWorkspaceProposals = async (multisig?: WorkspaceMultisig) => {
    const network = currentNetwork(effectiveNetwork);
    const targets = multisig ? [multisig] : workspace.multisigs.filter((item) => item.network === network);
    if (targets.length === 0) {
      toast.error(t("features.workspace.noSavedMultisigs"));
      return;
    }

    try {
      const fetched: WorkspaceProposal[] = [];
      for (const item of targets) {
        const response = await apiFetch("squads/proposals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            multisig: item.address,
            network: item.network,
            limit: 20,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || t("features.workspace.refreshFailed"));
        }
        saveWorkspaceMultisig(data.multisig, data.vault, undefined, data.network);
        if (Array.isArray(data.proposals)) {
          for (const proposal of data.proposals) {
            fetched.push({
              address: proposal.address,
              multisig: data.multisig,
              transactionIndex: String(proposal.transaction_index),
              status: proposal.status,
              network: currentNetwork(data.network),
              updatedAt: Date.now(),
            });
          }
        }
      }
      updateWorkspace((prev) => {
        const keys = new Set(fetched.map((item) => `${item.network}:${item.address}`));
        const merged = fetched.map((item) => {
          const existing = prev.proposals.find(
            (proposal) => proposal.address === item.address && proposal.network === item.network,
          );
          return {
            ...existing,
            ...item,
            kind: item.kind ?? existing?.kind,
            createdBy: existing?.createdBy,
            createdByLabel: existing?.createdByLabel,
          };
        });
        return {
          ...prev,
          proposals: [
            ...merged,
            ...prev.proposals.filter((item) => !keys.has(`${item.network}:${item.address}`)),
          ].slice(0, 100),
        };
      });
      toast.success(t("features.workspace.refreshSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("features.workspace.refreshFailed"));
    }
  };

  const handleWorkspaceProposalAction = async (
    proposal: WorkspaceProposal,
    action: WorkspaceProposalAction,
    formState: FormState = formData,
  ) => {
    const m = walletAuth("squads-workspace");
    if (!validateWalletAuth(m, formState, "private_key")) {
      toast.error(t("features.squads-vote.fillAllFields"));
      return;
    }

    const transactionIndex = parseInt(proposal.transactionIndex, 10);
    if (action === "execute" && !Number.isInteger(transactionIndex)) {
      toast.error(t("features.squads-execute.fillAllFields"));
      return;
    }

    setLoading(true);
    try {
      const requestBody: ApiRequestBody = {
        multisig: proposal.multisig,
        proposal: proposal.address,
        network: proposal.network,
      };
      if (action === "execute") {
        requestBody.transaction_index = transactionIndex;
      } else {
        requestBody.memo = formState.memo;
      }
      applyWalletAuth(requestBody, m, formState, "private_key");

      const endpoint =
        action === "approve"
          ? "squads/proposal/approve"
          : action === "reject"
            ? "squads/proposal/reject"
            : "squads/proposal/execute";
      const response = await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const data = await response.json();
      if (response.ok) {
        toast.success(
          action === "approve"
            ? t("features.squads-approve.success")
            : action === "reject"
              ? t("features.squads-reject.success")
              : t("features.squads-execute.success"),
        );
        saveWorkspaceProposal(
          proposal.address,
          proposal.multisig,
          proposal.transactionIndex,
          proposal.kind,
          action === "approve" ? "voted" : action === "reject" ? "rejected" : "executed",
          proposal.network,
          {
            createdBy: proposal.createdBy,
            createdByLabel: proposal.createdByLabel,
          },
        );
        if (action === "execute" && proposal.kind === "program-upgrade") {
          markProgramUpgradeHistoryExecuted(
            proposal.address,
            proposal.multisig,
            data.signature,
            data.network || proposal.network,
          );
        }
        setFormData((prev) => ({
          ...prev,
          multisig: proposal.multisig,
          proposal: proposal.address,
          transactionIndex: proposal.transactionIndex,
          signature: data.signature,
          network: data.network || proposal.network,
        }));
      } else {
        toast.error(
          data.error ||
            (action === "execute"
              ? t("features.squads-execute.error")
              : t("features.squads-vote.error")),
        );
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : t("errors.unknownError");
      toast.error(
        t("errors.requestFailedWithHint", {
          message,
          port: String(DEFAULT_API_PORT),
        }),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSaveWalletMetadata = async (wallet: SavedWallet) => {
    const name = String(formData[`walletName:${wallet.id}`] ?? wallet.name).trim();
    if (!name) {
      toast.error(t("formUi.walletNameRequired"));
      return;
    }

    setLoading(true);
    try {
      const response = await apiFetch(`wallets/${wallet.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("formUi.walletMetadataSaveFailed"));
      }
      toast.success(t("formUi.walletMetadataSaved"));
      await loadWallets();
      setEditingWalletId(null);
      setFormData((prev) => {
        const next = { ...prev };
        delete next[`walletName:${wallet.id}`];
        return next;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("formUi.walletMetadataSaveFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleCancelWalletMetadata = (wallet: SavedWallet) => {
    setEditingWalletId(null);
    setFormData((prev) => {
      const next = { ...prev };
      delete next[`walletName:${wallet.id}`];
      return next;
    });
  };

  const exportKeystoreWithPassword = async (wallet: SavedWallet, password: string) => {
    const response = await apiFetch(`wallets/${wallet.id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || t("features.settings.exportFailed"));
    }
    void downloadFile(
      data.keystore_json,
      `${safeFilename(wallet.name)}-${wallet.public_key.slice(0, 8)}-keystore.json`,
    );
  };

  const exportPrivateKeyWithPassword = async (
    wallet: SavedWallet,
    password: string,
  ): Promise<ExportedPrivateKeyPreview> => {
    const response = await apiFetch(`wallets/${wallet.id}/export-private-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || t("features.settings.exportPrivateKeyFailed"));
    }
    const privateKey = String(data.private_key || "").trim();
    if (!privateKey) {
      throw new Error(t("features.settings.exportPrivateKeyFailed"));
    }
    return {
      walletName: wallet.name,
      publicKey: wallet.public_key,
      privateKey,
    };
  };

  const exportMnemonicWithPassword = async (
    wallet: SavedWallet,
    password: string,
  ): Promise<ExportedMnemonicPreview> => {
    const response = await apiFetch(`wallets/${wallet.id}/export-mnemonic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || t("features.settings.exportMnemonicFailed"));
    }
    const mnemonic = String(data.mnemonic || "").trim();
    if (!mnemonic) {
      throw new Error(t("features.settings.exportMnemonicFailed"));
    }
    return {
      walletName: wallet.name,
      publicKey: wallet.public_key,
      mnemonic,
    };
  };

  const resetSensitiveExportDisplay = (tab: SensitiveExportKind = "private-key") => {
    setPrivateKeyExportMode("simple");
    setPrivateKeySegmentCount(DEFAULT_PRIVATE_KEY_SEGMENTS);
    setPrivateKeyQrRevealed(false);
    setSensitiveExportTab(tab);
  };

  const handleExportKeystore = async (wallet: SavedWallet, passwordValue: string) => {
    const password = passwordValue;
    if (password.length === 0) {
      toast.error(t("features.settings.exportPasswordRequired"));
      return;
    }

    setLoading(true);
    try {
      await exportKeystoreWithPassword(wallet, password);
      toast.success(t("features.settings.exportSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("features.settings.exportFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleExportPrivateKey = async (wallet: SavedWallet, passwordValue: string) => {
    const password = passwordValue;
    if (password.length === 0) {
      toast.error(t("features.settings.exportPasswordRequired"));
      return;
    }

    setLoading(true);
    try {
      const privateKey = await exportPrivateKeyWithPassword(wallet, password);
      resetSensitiveExportDisplay("private-key");
      setExportedMnemonic(null);
      setExportedPrivateKey(privateKey);
      toast.success(t("features.settings.exportPrivateKeySuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("features.settings.exportPrivateKeyFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleExportMnemonic = async (wallet: SavedWallet, passwordValue: string) => {
    const password = passwordValue;
    if (password.length === 0) {
      toast.error(t("features.settings.exportPasswordRequired"));
      return;
    }

    setLoading(true);
    try {
      const mnemonic = await exportMnemonicWithPassword(wallet, password);
      resetSensitiveExportDisplay("mnemonic");
      setExportedPrivateKey(null);
      setExportedMnemonic(mnemonic);
      toast.success(t("features.settings.exportMnemonicSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("features.settings.exportMnemonicFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleExportBundle = async (
    wallet: SavedWallet,
    passwordValue: string,
    selection: ExportBundleSelection,
  ) => {
    const password = passwordValue;
    if (password.length === 0) {
      toast.error(t("features.settings.exportPasswordRequired"));
      return;
    }
    if (!Object.values(selection).some(Boolean)) {
      toast.error(t("features.settings.exportBundleSelectRequired"));
      return;
    }

    setLoading(true);
    let privateKeyPreview: ExportedPrivateKeyPreview | null = null;
    let mnemonicPreview: ExportedMnemonicPreview | null = null;
    try {
      if (selection.keystore) {
        await exportKeystoreWithPassword(wallet, password);
      }
      if (selection["private-key"]) {
        privateKeyPreview = await exportPrivateKeyWithPassword(wallet, password);
      }
      if (selection.mnemonic) {
        mnemonicPreview = await exportMnemonicWithPassword(wallet, password);
      }

      setExportedPrivateKey(privateKeyPreview);
      setExportedMnemonic(mnemonicPreview);
      if (privateKeyPreview || mnemonicPreview) {
        resetSensitiveExportDisplay(privateKeyPreview ? "private-key" : "mnemonic");
      }
      toast.success(t("features.settings.exportBundleSuccess"));
    } catch (err) {
      setExportedPrivateKey(privateKeyPreview);
      setExportedMnemonic(mnemonicPreview);
      if (privateKeyPreview || mnemonicPreview) {
        resetSensitiveExportDisplay(privateKeyPreview ? "private-key" : "mnemonic");
      }
      toast.error(err instanceof Error ? err.message : t("features.settings.exportBundleFailed"));
    } finally {
      setLoading(false);
    }
  };

  const requestExportBundle = (wallet: SavedWallet) => {
    setPasswordPromptValue("");
    setExportBundleSelection({
      keystore: true,
      "private-key": false,
      mnemonic: false,
    });
    setPasswordPrompt({ kind: "export-bundle", wallet, formState: {} });
  };

  const handleMigrateKeystore = async (
    wallet: SavedWallet,
    currentPassword: string,
    newPassword: string,
  ) => {
    if (!currentPassword || !newPassword) {
      toast.error(t("features.settings.migratePasswordRequired"));
      return;
    }
    setLoading(true);
    try {
      const response = await apiFetch(`wallets/${wallet.id}/migrate-keystore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("features.settings.migrateFailed"));
      }
      await loadWallets();
      toast.success(t("features.settings.migrateSuccess"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("features.settings.migrateFailed"));
    } finally {
      setLoading(false);
    }
  };

  const requestMigrateKeystore = (wallet: SavedWallet) => {
    clearPasswordPromptSecrets();
    setPasswordPrompt({ kind: "migrate-keystore", wallet, formState: {} });
  };

  const requestEnableBiometricWallet = (wallet: SavedWallet) => {
    setPasswordPromptValue("");
    setMasterPasswordPromptValue("");
    setSavePasswordToBiometric(false);
    setPasswordPrompt({ kind: "enable-biometric", wallet, formState: { wallet_id: wallet.id } });
  };

  const handleDeleteWallet = async (wallet: SavedWallet) => {
    const confirmed = window.confirm(
      t("features.settings.deleteWalletConfirm", { name: wallet.name }),
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      const response = await apiFetch(`wallets/${wallet.id}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("features.settings.deleteWalletFailed"));
      }
      if (currentWalletId === wallet.id) {
        setCurrentWallet("");
      }
      setFormData((prev) => {
        const next = { ...prev };
        if (next.wallet_id === wallet.id) {
          delete next.wallet_id;
        }
        delete next[`walletName:${wallet.id}`];
        delete next[`exportPassword:${wallet.id}`];
        return next;
      });
      setEditingWalletId((prev) => (prev === wallet.id ? null : prev));
      await deleteBiometricWalletPassword(wallet, { quiet: true });
      await loadWallets();
      toast.success(t("features.settings.deleteWalletSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("features.settings.deleteWalletFailed"));
    } finally {
      setLoading(false);
    }
  };


  const toggleMenu = (menuId: string) => {
    setActiveMenu(activeMenu === menuId ? null : menuId);
  };

  const handleDesktopMenuClick = (item: MenuItem) => {
    if (desktopSidebarCollapsed && item.children?.length) {
      setDesktopSidebarCollapsed(false);
      setActiveMenu(item.id);
      return;
    }
    if (item.children) {
      toggleMenu(item.id);
    } else {
      handleSelectForm(item.id);
    }
  };

  const openParentMenuForForm = (formId: string) => {
    const menu = menuItems.find((item) => item.id === formId && item.children?.length);
    if (menu) {
      setActiveMenu(menu.id);
      return;
    }
    const parentMenu = menuItems.find((item) => item.children?.some((child) => child.id === formId));
    if (parentMenu) {
      setActiveMenu(parentMenu.id);
    }
  };

  const handleFormChange = (field: string, value: string | number | undefined) => {
    if (field === "password" || field === "master_password") {
      return;
    }
    if (field === "mint" && String(formData.mint ?? "").trim() !== String(value ?? "").trim()) {
      setTokenActionContext(null);
    }
    setFormData((prev) => {
      if (value === undefined) {
        const next = { ...prev };
        delete next[field];
        if (field === "mint") {
          delete next.decimals;
          delete next.tokenSupply;
          delete next.tokenUiSupply;
          delete next.token_balance;
          delete next.token_raw_amount;
          delete next.token_account;
          delete next.sell_percent;
        }
        return next;
      }
      if (field === "mint" && String(prev.mint ?? "").trim() !== String(value ?? "").trim()) {
        const next: FormState = { ...prev, [field]: value };
        delete next.decimals;
        delete next.tokenSupply;
        delete next.tokenUiSupply;
        delete next.token_balance;
        delete next.token_raw_amount;
        delete next.token_account;
        if (selectedForm === "pumpfun-sell" || selectedForm === "pumpswap-sell") {
          delete next.amount;
          delete next.sell_percent;
        }
        return next;
      }
      const next: FormState = { ...prev, [field]: value };
      if (field === "amount" && (selectedForm === "pumpfun-sell" || selectedForm === "pumpswap-sell")) {
        delete next.sell_percent;
      }
      return next;
    });
  };

  const hydrateExternalSignFormDataFromJson = (source: FormState): FormState => {
    const raw = String(source.externalSignRequestJson || "").trim();
    if (!raw) return source;
    const summary = parseExternalSignRequestSummary(raw);
    if (!summary?.valid) return source;
    const matchingWallet = summary.requiredSigner
      ? wallets.find((wallet) => wallet.public_key === summary.requiredSigner)
      : undefined;
    return {
      ...source,
      externalSignRequestJson: raw,
      ...(summary.requestId ? { requestId: summary.requestId } : {}),
      ...(summary.requiredSigner ? { requiredSigner: summary.requiredSigner } : {}),
      ...(summary.transactionBase64 ? { transactionBase64: summary.transactionBase64 } : {}),
      ...(summary.dataBase64 ? { dataBase64: summary.dataBase64 } : {}),
      ...(summary.expiresAt ? { expiresAt: summary.expiresAt } : {}),
      ...(summary.clusterGenesisHash ? { expectedGenesisHash: summary.clusterGenesisHash } : {}),
      ...(summary.recentBlockhash ? { recentBlockhash: summary.recentBlockhash } : {}),
      ...(summary.lastValidBlockHeight ? { lastValidBlockHeight: summary.lastValidBlockHeight } : {}),
      ...(summary.cluster || summary.network ? { network: summary.cluster || summary.network } : {}),
      ...(matchingWallet ? { wallet_id: matchingWallet.id, keystoreJson: undefined } : {}),
    };
  };

  const importExternalSignRequest = () => {
    const raw = String(formData.externalSignRequestJson || "").trim();
    if (!raw) {
      toast.error(t("features.external-sign.requestJsonRequired"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      toast.error(t("features.external-sign.invalidRequestJson"));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      toast.error(t("features.external-sign.invalidRequestJson"));
      return;
    }
    const request = parsed as Record<string, unknown>;
    const nestedTransaction =
      request.transaction && typeof request.transaction === "object" && !Array.isArray(request.transaction)
        ? (request.transaction as Record<string, unknown>)
        : undefined;
    const args =
      request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments)
        ? (request.arguments as Record<string, unknown>)
        : undefined;
    const accounts = Array.isArray(request.accounts)
      ? request.accounts
          .map((account) => (account && typeof account === "object" && !Array.isArray(account) ? account as Record<string, unknown> : null))
          .filter((account): account is Record<string, unknown> => Boolean(account))
      : [];
    const readString = (...keys: string[]) => {
      for (const key of keys) {
        const value = request[key] ?? nestedTransaction?.[key] ?? args?.[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
      }
      return "";
    };

    const requiredSigner =
      readString("requiredSigner", "required_signer", "signer", "signerPubkey", "signer_pubkey", "walletPublicKey", "wallet_public_key") ||
      String(accounts.find((account) => Boolean(account.isSigner ?? account.is_signer))?.pubkey || "").trim();
    const transactionBase64 = readString("transactionBase64", "transaction_base64", "txBase64", "tx_base64", "base64");
    const dataBase64 = readString("dataBase64", "data_base64", "instructionDataBase64", "instruction_data_base64");
    const requestId = readString("requestId", "request_id", "requestID", "id", "orderId", "order_id");
    const expiresAt = readString("expiresAt", "expires_at");
    const expectedGenesisHash = readString("expectedGenesisHash", "expected_genesis_hash", "clusterGenesisHash", "cluster_genesis_hash", "genesisHash", "genesis_hash");
    const recentBlockhash = readString("recentBlockhash", "recent_blockhash");
    const lastValidBlockHeight = readString("lastValidBlockHeight", "last_valid_block_height");
    const network = readString("network", "cluster");
    const matchingWallet = requiredSigner
      ? wallets.find((wallet) => wallet.public_key === requiredSigner)
      : undefined;

    setFormData((prev) => ({
      ...prev,
      externalSignRequestJson: raw,
      ...(requestId ? { requestId } : {}),
      ...(requiredSigner ? { requiredSigner } : {}),
      ...(transactionBase64 ? { transactionBase64 } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(expectedGenesisHash ? { expectedGenesisHash } : {}),
      ...(recentBlockhash ? { recentBlockhash } : {}),
      ...(lastValidBlockHeight ? { lastValidBlockHeight } : {}),
      ...(network ? { network } : {}),
      ...(matchingWallet ? { wallet_id: matchingWallet.id, keystoreJson: undefined } : {}),
    }));
    toast.success(t("features.external-sign.requestImported"));
  };

  const handleSellPercentShortcut = async (
    formId: "pumpfun-sell" | "pumpswap-sell",
    percent: number,
  ) => {
    const mint = String(formData.mint ?? "").trim();
    if (!mint) {
      toast.error(t(`features.${formId}.fillMintFirst`));
      return;
    }

    const wallet = selectedSavedWallet() ?? effectiveWallet;
    if (!wallet) {
      toast.error(t(`features.${formId}.balanceNotFound`));
      return;
    }

    const matchesWallet = walletAssets?.address === wallet.public_key && walletAssets.network === effectiveNetwork;
    let assets = matchesWallet && !walletAssets.loading ? walletAssets : null;
    let tokenBalance =
      tokenBalanceSnapshotFromFormState(formData, mint) ||
      tokenBalanceSnapshotFromFormState(tokenActionContext, mint) ||
      (assets ? aggregateTokenBalance(assets.tokens, mint) : null);

    if (!tokenBalance) {
      const refreshed = await loadWalletAssets(wallet, { refresh: true, force: true });
      if (!refreshed) {
        toast.error(t("features.wallet-list.assetLoadFailed"));
        return;
      }
      assets = refreshed;
      tokenBalance = aggregateTokenBalance(assets.tokens, mint);
    }

    if (!tokenBalance) {
      toast.error(t(`features.${formId}.balanceNotFound`));
      return;
    }

    const rawBalance = BigInt(tokenBalance.rawAmount);
    const rawAmount =
      percent >= 100
        ? rawBalance
        : (rawBalance * BigInt(percent)) / BigInt(100);
    if (rawAmount <= BigInt(0)) {
      toast.error(t(`features.${formId}.amountTooSmall`));
      return;
    }

    const amount = rawTokenAmountToUi(rawAmount.toString(), tokenBalance.decimals);
    if (!parsePositiveDecimal(amount)) {
      toast.error(t(`features.${formId}.amountTooSmall`));
      return;
    }
    setFormData((prev) => ({
      ...prev,
      amount,
      sell_percent: percent * 100,
    }));
  };

  const refreshWalletAfterMutation = useCallback((
    wallet?: SavedWallet,
    options: { tokenAdjustment?: TokenBalanceAdjustment; refreshDelaysMs?: number[]; formSnapshot?: FormState } = {},
  ) => {
    if (!wallet) return;
    const walletKey = `${wallet.public_key}:${effectiveRpcRequest}`;
    const syncCurrentTokenBalance = (assets: WalletAssetsState) => {
      setTokenActionContext((prev) => {
        const mint = String(prev?.mint ?? "").trim();
        if (!prev || !mint) return prev;
        const balance = aggregateTokenBalance(assets.tokens, mint);
        if (!balance) {
          return {
            ...prev,
            amount: "0",
            token_balance: "0",
            token_raw_amount: "0",
          };
        }
        return {
          ...prev,
          amount: balance.amount,
          token_balance: balance.amount,
          token_raw_amount: balance.rawAmount,
          decimals: balance.decimals,
        };
      });
      if (!selectedForm || !CURRENT_WALLET_TOKEN_BALANCE_FORM_IDS.has(selectedForm)) {
        return;
      }
      setFormData((prev) => {
        const mint = String(prev.mint ?? "").trim();
        if (!mint) return prev;
        const balance = aggregateTokenBalance(assets.tokens, mint);
        if (!balance) {
          return {
            ...prev,
            token_balance: "0",
            token_raw_amount: "0",
          };
        }
        return {
          ...prev,
          token_balance: balance.amount,
          token_raw_amount: balance.rawAmount,
          decimals: balance.decimals,
        };
      });
    };
    if (options.tokenAdjustment) {
      const fallbackPendingAdjustment = pendingAdjustmentFromFormState(
        options.formSnapshot ?? formData,
        options.tokenAdjustment,
      );
      setWalletAssets((prev) => {
        if (!prev || prev.address !== wallet.public_key || prev.network !== effectiveNetwork) {
          pendingTokenBalanceAdjustmentRef.current = fallbackPendingAdjustment;
          return prev;
        }
        const pendingAdjustment = pendingAdjustmentFromAssets(prev, options.tokenAdjustment);
        pendingTokenBalanceAdjustmentRef.current = pendingAdjustment ?? fallbackPendingAdjustment;
        const adjustedAssets = applyPendingTokenBalanceAdjustmentToAssets(
          prev,
          pendingAdjustment ?? fallbackPendingAdjustment,
        );
        syncCurrentTokenBalance(adjustedAssets);
        return adjustedAssets;
      });
      if (fallbackPendingAdjustment) {
        const fallbackBalance = rawTokenAmountToUi(
          fallbackPendingAdjustment.expectedRawAmount,
          fallbackPendingAdjustment.decimals,
        );
        setTokenActionContext((prev) => {
          const mint = String(prev?.mint ?? "").trim();
          if (!prev || mint !== fallbackPendingAdjustment.mint) return prev;
          return {
            ...prev,
            amount: fallbackBalance,
            token_balance: fallbackBalance,
            token_raw_amount: fallbackPendingAdjustment.expectedRawAmount,
            decimals: fallbackPendingAdjustment.decimals,
          };
        });
        setFormData((prev) => {
          const mint = String(prev.mint ?? "").trim();
          if (mint !== fallbackPendingAdjustment.mint) return prev;
          return {
            ...prev,
            token_balance: fallbackBalance,
            token_raw_amount: fallbackPendingAdjustment.expectedRawAmount,
            decimals: fallbackPendingAdjustment.decimals,
          };
        });
      }
    }
    const refreshAssets = () =>
      loadWalletAssets(wallet, { refresh: true, background: true, force: true }).then((assets) => {
        if (assets) syncCurrentTokenBalance(assets);
      });
    const refreshDelaysMs = options.refreshDelaysMs ?? DEFAULT_POST_MUTATION_ASSET_REFRESH_DELAYS_MS;
    lastAssetRefreshRef.current.delete(walletKey);
    refreshDelaysMs.forEach((delay) => {
      window.setTimeout(() => {
        walletAssetsInFlightRef.current.delete(`${wallet.public_key}:${effectiveRpcRequest}:refresh`);
        lastAssetRefreshRef.current.delete(walletKey);
        void refreshAssets();
      }, delay);
    });
    lastTransactionRefreshRef.current.delete(walletKey);
    if (walletOverviewTab === "transactions") {
      void loadWalletTransactions(wallet, "replace", { force: true });
    }
  }, [effectiveNetwork, effectiveRpcRequest, formData, loadWalletAssets, loadWalletTransactions, selectedForm, walletOverviewTab]);

  const openWalletFaucet = async (wallet: SavedWallet, faucet: "solana" | "circle") => {
    if (faucet === "solana" && effectiveNetwork !== "devnet" && effectiveNetwork !== "testnet") return;
    if (faucet === "circle" && effectiveNetwork !== "devnet") return;
    setWalletFaucetMenuOpen(false);
    const address = wallet.public_key.trim();
    const faucetUrl = faucet === "circle" ? CIRCLE_FAUCET_URL : SOLANA_FAUCET_URL;
    try {
      if (address) {
        if (navigator.clipboard?.writeText && window.isSecureContext) {
          await navigator.clipboard.writeText(address);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = address;
          textarea.setAttribute("readonly", "true");
          textarea.style.position = "fixed";
          textarea.style.left = "-9999px";
          textarea.style.top = "0";
          document.body.appendChild(textarea);
          textarea.select();
          textarea.setSelectionRange(0, address.length);
          document.execCommand("copy");
          document.body.removeChild(textarea);
        }
        setCopied(`wallet-${faucet}-faucet-address`);
        setTimeout(() => setCopied(null), 2000);
      }
      await openExternalUrl(faucetUrl);
      toast.success(t(`features.wallet-list.${faucet === "circle" ? "circleFaucetOpened" : "faucetAirdropOpened"}`));
    } catch {
      toast.error(t(`features.wallet-list.${faucet === "circle" ? "circleFaucetFailed" : "faucetAirdropFailed"}`));
    }
  };

  const activeDappTab = dappTabs.find((tab) => tab.id === activeDappTabId) ?? dappTabs[0] ?? DAPP_HOME_TAB;
  const dappSearchTerm = dappSearch.trim().toLowerCase();
  const dappStoreVisibleDapps = SOLANA_DAPP_CATALOG.filter((dapp) => {
    const matchesCategory = dappCategory === "trend" || dapp.category === dappCategory;
    if (!matchesCategory) return false;
    if (!dappSearchTerm) return true;
    const haystack = [dapp.name, dapp.description, dapp.category, dapp.chain, ...dapp.tags]
      .join(" ")
      .toLowerCase();
    return haystack.includes(dappSearchTerm);
  });
  const dappStoreFeaturedDapps = SOLANA_DAPP_CATALOG.slice(0, 3);

  const dappBrowserBounds = useCallback(() => {
    const shell = dappBrowserShellRef.current;
    if (!shell) return null;
    const rect = shell.getBoundingClientRect();
    const measuredTabBarHeight = Math.ceil(dappBrowserTabBarRef.current?.getBoundingClientRect().height ?? 0);
    const measuredAddressBarHeight = Math.ceil(dappBrowserAddressBarRef.current?.getBoundingClientRect().height ?? 0);
    const tabBarHeight = Math.max(measuredTabBarHeight, 40);
    const addressBarHeight = activeDappTab.showAddressBar ? Math.max(measuredAddressBarHeight, 56) : 0;
    const chromeHeight = tabBarHeight + addressBarHeight;
    const nativeTopOffset = dappNativeWindowTopOffset();
    const width = Math.max(0, Math.floor(rect.width));
    const height = Math.max(0, Math.floor(rect.height - chromeHeight));
    if (width < 40 || height < 40) return null;
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top + chromeHeight + nativeTopOffset),
      width,
      height,
    };
  }, [activeDappTab.showAddressBar]);

  const setActiveNativeDappTab = useCallback(async () => {
    if (!isTauriWebview()) return;
    const tab = dappTabs.find((item) => item.id === activeDappTabId);
    const bounds = dappBrowserBounds();
    const shouldShowNativeTab =
      selectedForm === "dapp-store" &&
      !dappSignRequest &&
      Boolean(tab?.webviewOpen) &&
      !tab?.loading &&
      Boolean(bounds);
    try {
      await invoke("dapp_set_active_tab", {
        tabId: shouldShowNativeTab ? activeDappTabId : null,
        x: bounds?.x ?? 0,
        y: bounds?.y ?? 0,
        width: bounds?.width ?? 0,
        height: bounds?.height ?? 0,
      });
    } catch {
      // A tab can be closed while React is still settling layout; the next sync will correct it.
    }
  }, [activeDappTabId, dappBrowserBounds, dappSignRequest, dappTabs, selectedForm]);

  const createDappWebview = useCallback(async (
    tabId: string,
    url: string,
    dapp?: DappCatalogItem,
  ) => {
    if (!isTauriWebview()) {
      toast.error(tf("features.dapp-store.tauriOnly", "DApp 自动连接需要在桌面客户端中使用。"));
      return;
    }
    const bounds = dappBrowserBounds();
    if (!bounds) {
      requestAnimationFrame(() => {
        void createDappWebview(tabId, url, dapp);
      });
      return;
    }
    const wallet = dapp ? effectiveWallet : undefined;
    if (dapp && !wallet) {
      toast.error(tf("features.dapp-store.noWallet", "请先选择一个钱包。"));
      return;
    }
    setDappTabs((tabs) => tabs.map((tab) =>
      tab.id === tabId ? { ...tab, webviewOpen: true, loading: true } : tab,
    ));
    try {
      await invoke("dapp_open_tab", {
        tabId,
        url,
        appId: dapp?.id ?? null,
        walletPublicKey: wallet?.public_key ?? null,
        network: effectiveRpcRequest,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
      setDappTabs((tabs) => tabs.map((tab) =>
        tab.id === tabId
          ? {
            ...tab,
            url,
            addressInput: url,
            appId: dapp?.id,
            walletConnected: Boolean(dapp && wallet),
            webviewOpen: true,
          }
          : tab,
      ));
    } catch (error) {
      setDappTabs((tabs) => tabs.map((tab) =>
        tab.id === tabId ? { ...tab, webviewOpen: false, loading: false } : tab,
      ));
      toast.error(errorMessage(error, tf("features.dapp-store.openFailed", "打开 DApp 失败")));
    }
  }, [dappBrowserBounds, effectiveRpcRequest, effectiveWallet, tf]);

  const openUrlInDappTab = useCallback((rawUrl: string, options: { dapp?: DappCatalogItem; tabId?: string; showAddressBar?: boolean } = {}) => {
    let url: string;
    try {
      url = normalizeDappBrowserUrl(rawUrl);
    } catch (error) {
      toast.error(errorMessage(error, "网址格式不正确"));
      return;
    }
    const matchedDapp = options.dapp ?? (effectiveWallet ? dappForUrl(url) : undefined);
    const tabId = options.tabId ?? newDappTabId();
    const title = matchedDapp?.name ?? new URL(url).hostname;
    setDappTabs((tabs) => {
      const existing = tabs.find((tab) => tab.id === tabId);
      if (existing) {
        return tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, title, url, addressInput: url, appId: matchedDapp?.id, walletConnected: false, loading: true }
            : tab,
        );
      }
      return [
        ...tabs,
        {
          id: tabId,
          title,
          url,
          addressInput: url,
          closable: true,
          showAddressBar: Boolean(options.showAddressBar),
          appId: matchedDapp?.id,
          walletConnected: false,
          webviewOpen: false,
          loading: true,
        },
      ];
    });
    setActiveDappTabId(tabId);
    requestAnimationFrame(() => {
      void createDappWebview(tabId, url, matchedDapp);
    });
  }, [createDappWebview, effectiveWallet]);

  const openDapp = async (dapp: DappCatalogItem) => {
    const wallet = effectiveWallet;
    if (!wallet) {
      toast.error(tf("features.dapp-store.noWallet", "请先选择一个钱包。"));
      return;
    }
    openUrlInDappTab(dapp.url, { dapp });
  };

  const addBlankDappTab = () => {
    const tabId = newDappTabId();
    setDappTabs((tabs) => [
      ...tabs,
      {
        id: tabId,
        title: "新标签页",
        url: "",
        addressInput: "",
        closable: true,
        showAddressBar: true,
        walletConnected: false,
        webviewOpen: false,
        loading: false,
      },
    ]);
    setActiveDappTabId(tabId);
  };

  const closeDappTab = (tabId: string) => {
    const tabIndex = dappTabs.findIndex((tab) => tab.id === tabId);
    const tab = dappTabs[tabIndex];
    if (!tab?.closable) return;
    const nextTabs = dappTabs.filter((item) => item.id !== tabId);
    setDappTabs(nextTabs);
    if (activeDappTabId === tabId) {
      setActiveDappTabId(nextTabs[Math.max(0, tabIndex - 1)]?.id ?? DAPP_HOME_TAB_ID);
    }
    if (isTauriWebview()) {
      void invoke("dapp_close_tab", { tabId }).catch(() => {});
    }
  };

  const submitDappAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const tab = activeDappTab;
    if (!tab) return;
    const value = tab.addressInput.trim();
    if (!value) return;
    if (tab.id === DAPP_HOME_TAB_ID || !tab.webviewOpen) {
      openUrlInDappTab(value, {
        tabId: tab.id === DAPP_HOME_TAB_ID ? undefined : tab.id,
        showAddressBar: tab.showAddressBar,
      });
      return;
    }
    let url: string;
    try {
      url = normalizeDappBrowserUrl(value);
    } catch (error) {
      toast.error(errorMessage(error, "网址格式不正确"));
      return;
    }
    setDappTabs((tabs) => tabs.map((item) =>
      item.id === tab.id ? { ...item, loading: true } : item,
    ));
    void invoke("dapp_navigate_tab", { tabId: tab.id, url })
      .then(() => {
        setDappTabs((tabs) => tabs.map((item) =>
          item.id === tab.id ? { ...item, url, addressInput: url, title: new URL(url).hostname } : item,
        ));
      })
      .catch((error) => {
        setDappTabs((tabs) => tabs.map((item) =>
          item.id === tab.id ? { ...item, loading: false } : item,
        ));
        toast.error(errorMessage(error, tf("features.dapp-store.openFailed", "打开 DApp 失败")));
      });
  };

  useEffect(() => {
    if (!isTauriWebview()) return;
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    Promise.all([
      listen<DappTabUrlEvent>("dapp://tab-url", (event) => {
        setDappTabs((tabs) => tabs.map((tab) =>
          tab.id === event.payload.tab_id
            ? {
              ...tab,
              url: event.payload.url,
              addressInput: event.payload.url,
              loading: event.payload.loaded ? false : tab.loading,
            }
            : tab,
        ));
      }),
      listen<DappTabTitleEvent>("dapp://tab-title", (event) => {
        setDappTabs((tabs) => tabs.map((tab) =>
          tab.id === event.payload.tab_id
            ? { ...tab, title: event.payload.title || tab.title }
            : tab,
        ));
      }),
      listen<DappNewWindowEvent>("dapp://new-window", (event) => {
        openUrlInDappTab(event.payload.url);
      }),
    ]).then((cleanups) => {
      if (cancelled) {
        cleanups.forEach((cleanup) => cleanup());
      } else {
        unlisteners.push(...cleanups);
      }
    }).catch(() => {
      // The web build has no Tauri event bridge.
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((cleanup) => cleanup());
    };
  }, [openUrlInDappTab]);

  useEffect(() => {
    void setActiveNativeDappTab();
  }, [setActiveNativeDappTab]);

  useEffect(() => {
    if (!isTauriWebview()) return;
    const timers = [60, 180, 360].map((delay) =>
      window.setTimeout(() => {
        void setActiveNativeDappTab();
      }, delay),
    );
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [activeDappTabId, activeDappTab.showAddressBar, selectedForm, setActiveNativeDappTab]);

  useEffect(() => {
    if (!isTauriWebview()) return;
    const sync = () => {
      void setActiveNativeDappTab();
    };
    const observedElements = [
      dappBrowserShellRef.current,
      dappBrowserTabBarRef.current,
      dappBrowserAddressBarRef.current,
      dappBrowserViewportRef.current,
    ].filter((element): element is HTMLDivElement => Boolean(element));
    const observer = typeof ResizeObserver !== "undefined" && observedElements.length > 0
      ? new ResizeObserver(sync)
      : null;
    observedElements.forEach((element) => observer?.observe(element));
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    const frame = requestAnimationFrame(sync);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      cancelAnimationFrame(frame);
    };
  }, [setActiveNativeDappTab]);

  const resolveDappSignRequest = async (request: DappSignRequestEvent, result: DappSignResult) => {
    await invoke("resolve_dapp_sign_request", {
      requestId: request.request_id,
      result,
    });
  };

  const resolveDappConnectRequest = async (request: DappConnectRequestEvent, result: DappSignResult) => {
    await invoke("resolve_dapp_connect_request", {
      requestId: request.request_id,
      result,
    });
  };

  const rejectDappConnectRequest = async () => {
    const request = dappConnectRequest;
    if (!request) return;
    setDappSignBusy(true);
    try {
      await resolveDappConnectRequest(request, {
        approved: false,
        error: "USER_REJECTED",
      });
      setDappConnectRequest(null);
      setDappConnectWalletId("");
    } catch (error) {
      toast.error(errorMessage(error, "拒绝 DApp 连接失败"));
    } finally {
      setDappSignBusy(false);
    }
  };

  const approveDappConnectRequest = async () => {
    const request = dappConnectRequest;
    if (!request) return;
    const wallet = wallets.find((item) => item.id === (dappConnectWalletId || effectiveWalletId)) || wallets[0];
    if (!wallet) {
      toast.error(tf("features.dapp-store.noWallet", "Select a wallet first."));
      return;
    }
    setDappSignBusy(true);
    try {
      setCurrentWallet(wallet.id);
      await resolveDappConnectRequest(request, {
        approved: true,
        public_key: wallet.public_key,
      });
      toast.success(tf("features.dapp-store.connectSuccess", "DApp 已连接钱包"));
      setDappConnectRequest(null);
      setDappConnectWalletId("");
    } catch (error) {
      toast.error(errorMessage(error, "DApp 连接失败"));
    } finally {
      setDappSignBusy(false);
    }
  };

  const rejectDappSignRequest = async () => {
    const request = dappSignRequest;
    if (!request) return;
    setDappSignBusy(true);
    try {
      await resolveDappSignRequest(request, {
        approved: false,
        error: "用户拒绝了 DApp 交易签名请求",
      });
      setDappSignRequest(null);
      setDappPassword("");
      setDappSaveBiometric(false);
      setDappTransactionPreview(null);
      setDappTransactionPreviewError(null);
      setDappTransactionPreviewLoading(false);
      setDappPreviewDetailsOpen(false);
    } catch (error) {
      toast.error(errorMessage(error, "拒绝 DApp 请求失败"));
    } finally {
      setDappSignBusy(false);
    }
  };

  const approveDappSignRequest = async (passwordOverride?: string) => {
    const request = dappSignRequest;
    if (!request) return;
    const wallet = wallets.find((item) => item.public_key === request.wallet_public_key);
    if (!wallet) {
      toast.error(tf("features.dapp-store.walletMissing", "这个请求指定的钱包不在当前钱包列表中。"));
      return;
    }
    const walletPassword = passwordOverride ?? dappPassword;
    if (!walletPassword) {
      toast.error(t("formUi.placeholderKeystorePassword"));
      return;
    }
    const isMessageSignature = request.method === "signMessage";
    if (!isMessageSignature) {
      if (dappTransactionPreviewLoading) {
        toast.error(tf("features.dapp-store.previewLoading", "交易预览仍在加载，请稍后再确认"));
        return;
      }
      if (dappTransactionPreviewError || !dappTransactionPreview) {
        toast.error(dappTransactionPreviewError || tf("features.dapp-store.previewRequired", "需要先完成交易预览"));
        return;
      }
      if (!dappTransactionPreview.required_signer_present) {
        toast.error(tf("features.dapp-store.signerMissing", "交易没有要求当前钱包签名，已拒绝"));
        return;
      }
    }
    const shouldSubmit = request.method === "sendTransaction" || request.method === "signAndSendTransaction";
    setDappSignBusy(true);
    try {
      const response = await apiFetch(
        isMessageSignature ? "external-sign/message" : shouldSubmit ? "external-sign/submit" : "external-sign/sign",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet_id: wallet.id,
            password: walletPassword,
            required_signer: request.wallet_public_key,
            ...(isMessageSignature
              ? { message_base64: request.message_base64 || "" }
              : {
                  transaction_base64: request.transaction_base64,
                  transaction_format: request.transaction_format || "auto",
                }),
            network: request.network || effectiveRpcRequest,
            request_id: request.request_id,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || tf("features.dapp-store.signFailed", "DApp 交易签名失败"));
      }
      const result: DappSignResult = {
        approved: true,
        signature: String(data.signature || "").trim() || undefined,
        raw_transaction: String(data.raw_transaction || data.rawTransaction || "").trim() || undefined,
        recent_blockhash: String(data.recent_blockhash || data.recentBlockhash || "").trim() || undefined,
      };
      await resolveDappSignRequest(request, result);
      if (!passwordOverride && dappSaveBiometric && supportsBiometricWallet(wallet)) {
        await storeBiometricWalletPassword(wallet, walletPassword);
      }
      toast.success(
        isMessageSignature
          ? tf("features.dapp-store.messageSignSuccess", "DApp 消息已签名")
          : shouldSubmit
          ? tf("features.dapp-store.submitSuccess", "DApp 交易已提交")
          : tf("features.dapp-store.signSuccess", "DApp 交易已签名"),
      );
      setDappSignRequest(null);
      setDappPassword("");
      setDappSaveBiometric(false);
      setDappTransactionPreview(null);
      setDappTransactionPreviewError(null);
      setDappTransactionPreviewLoading(false);
      setDappPreviewDetailsOpen(false);
      if (!isMessageSignature) refreshWalletAfterMutation(wallet);
    } catch (error) {
      toast.error(
        errorMessage(
          error,
          isMessageSignature
            ? tf("features.dapp-store.messageSignFailed", "DApp 消息签名失败")
            : tf("features.dapp-store.signFailed", "DApp 交易签名失败"),
        ),
      );
    } finally {
      setDappSignBusy(false);
    }
  };

  const approveDappSignRequestWithBiometric = async () => {
    const request = dappSignRequest;
    if (!request) return;
    const wallet = wallets.find((item) => item.public_key === request.wallet_public_key);
    if (!wallet) {
      toast.error(tf("features.dapp-store.walletMissing", "这个请求指定的钱包不在当前钱包列表中。"));
      return;
    }
    const password = await getBiometricWalletPassword(wallet);
    if (password) {
      await approveDappSignRequest(password);
    }
  };
  approveDappSignRequestRef.current = approveDappSignRequest;

  useEffect(() => {
    if (!dappSignRequest || walletsLoading) return;
    if (wallets.some((item) => item.public_key === dappSignRequest.wallet_public_key)) return;
    const request = dappSignRequest;
    void (async () => {
      try {
        await resolveDappSignRequest(request, {
          approved: false,
          error: "FNZSAFE_WALLET_NOT_FOUND",
        });
      } catch {
        // The request may have been cancelled by the user while wallets were loading.
      }
      toast.error(tf("features.dapp-store.walletMissing", "这个请求指定的钱包不在当前钱包列表中。"));
      setDappSignRequest(null);
      setDappPassword("");
      setDappSaveBiometric(false);
      setDappTransactionPreview(null);
      setDappTransactionPreviewError(null);
      setDappTransactionPreviewLoading(false);
      setDappPreviewDetailsOpen(false);
    })();
  }, [dappSignRequest, tf, wallets, walletsLoading]);

  useEffect(() => {
    if (!dappSignRequest) {
      biometricDappAttemptRef.current = "";
      return;
    }
    const wallet = wallets.find((item) => item.public_key === dappSignRequest.wallet_public_key);
    if (!wallet || !canUseBiometricWallet(wallet)) {
      return;
    }
    if (dappSignBusy || biometricBusyWalletId === wallet.id) {
      return;
    }
    if (dappSignRequest.method !== "signMessage") {
      if (dappTransactionPreviewLoading || dappTransactionPreviewError || !dappTransactionPreview) {
        return;
      }
      if (!dappTransactionPreview.required_signer_present) {
        return;
      }
    }
    const attemptKey = `${dappSignRequest.request_id}:${wallet.id}`;
    if (biometricDappAttemptRef.current === attemptKey) return;
    biometricDappAttemptRef.current = attemptKey;
    void (async () => {
      const password = await getBiometricWalletPassword(wallet);
      if (password) {
        await approveDappSignRequestRef.current?.(password);
      }
    })();
  }, [
      biometricBusyWalletId,
      canUseBiometricWallet,
      dappSignBusy,
      dappSignRequest,
      dappTransactionPreview,
      dappTransactionPreviewError,
      dappTransactionPreviewLoading,
      getBiometricWalletPassword,
      wallets,
    ]);

  const clearForm = () => {
    if (selectedForm === "program-deploy") {
      resetProgramDeploySession();
    } else {
      clearProgramKeypairMaterial();
    }
    setFormData({ network: effectiveNetwork });
  };

  const defaultFormPreset = (formId: string): FormState => {
    if (formId === "pumpfun-sell") {
      return { slippage: 1 };
    }
    if (formId === "create-nonce") {
      return { count: 1 };
    }
    if (isProgramInvokeForm(formId)) {
      return { programInvokeMode: "simulate" };
    }
    return {};
  };

  const freshProgramDeployFormState = (preset: FormState = {}): FormState => ({
    ...(effectiveWalletId ? { wallet_id: effectiveWalletId } : {}),
    network: effectiveNetwork,
    ...(effectiveWallet ? { expectedUpgradeAuthority: effectiveWallet.public_key } : {}),
    ...omitFormFields(preset, PROGRAM_DEPLOY_RESULT_FIELDS),
  });

  const programDeployStateWithProgramSize = (state: FormState, programSize: number): FormState => {
    if (!Number.isSafeInteger(programSize) || programSize <= 0) {
      return state;
    }
    const currentMaxDataLenText = String(state.max_data_len ?? "").trim();
    const currentMaxDataLen = currentMaxDataLenText ? Number(currentMaxDataLenText) : undefined;
    if (
      currentMaxDataLen !== undefined &&
      Number.isSafeInteger(currentMaxDataLen) &&
      currentMaxDataLen >= programSize
    ) {
      return state;
    }
    return {
      ...state,
      max_data_len: String(programSize),
    };
  };

  const normalizedProgramDeployFormState = (state: FormState): FormState =>
    programDeployStateWithProgramSize(state, Number(state.programSoSize || 0));

  const refreshCurrentWalletAssets = (wallet?: SavedWallet) => {
    const targetWallet = wallet ?? selectedSavedWallet() ?? effectiveWallet;
    if (!targetWallet) return;
    void loadWalletAssets(targetWallet, { refresh: true, background: true, force: true }).then((assets) => {
      if (!assets) return;
      const mint = String((tokenActionContext?.mint ?? formData.mint) || "").trim();
      if (!mint) return;
      const balance = aggregateTokenBalance(assets.tokens, mint);
      if (!balance) return;
      setTokenActionContext((prev) => {
        if (!prev || String(prev.mint ?? "").trim() !== mint) return prev;
        return {
          ...prev,
          amount: balance.amount,
          token_balance: balance.amount,
          token_raw_amount: balance.rawAmount,
          decimals: balance.decimals,
        };
      });
      if (selectedForm && CURRENT_WALLET_TOKEN_BALANCE_FORM_IDS.has(selectedForm)) {
        setFormData((prev) => ({
          ...prev,
          token_balance: balance.amount,
          token_raw_amount: balance.rawAmount,
          decimals: balance.decimals,
        }));
      }
    });
  };

  const handleSelectForm = (formId: string) => {
    setMobileMenuOpen(false);
    clearForm();
    if (formId === "program-deploy") {
      resetProgramDeploySession();
    }
    setTokenActionContext(null);
    setNonceCreateOpen(false);
    if (formId !== "create-nonce") {
      setCreatedNonceAccounts([]);
    }
    openParentMenuForForm(formId);
    setSelectedForm(formId);
    setBackTarget(defaultBackTarget(formId));
    if (formId === "program-invoke-standalone") {
      if (programInvokeIdlFileInputRef.current) {
        programInvokeIdlFileInputRef.current.value = "";
      }
      setProgramInvoke(emptyProgramInvokeState());
      setFormData({
        ...(effectiveWalletId ? { wallet_id: effectiveWalletId } : {}),
        network: effectiveNetwork,
        ...defaultFormPreset(formId),
      });
      setAuthMethod((prev) => ({ ...prev, [formId]: "keystore" }));
      return;
    }
    if (formId === "program-deploy") {
      setFormData(freshProgramDeployFormState());
      setAuthMethod((prev) => ({ ...prev, [formId]: "keystore" }));
      return;
    }
    if (authFormsWithWallets.has(formId)) {
      setAuthMethod({ ...authMethod, [formId]: "keystore" });
      if (effectiveWalletId) {
        setFormData({
          wallet_id: effectiveWalletId,
          network: effectiveNetwork,
          ...defaultFormPreset(formId),
          ...(formId === "program-deploy" && effectiveWallet
            ? { expectedUpgradeAuthority: effectiveWallet.public_key }
            : {}),
        });
      } else {
        setFormData({ network: effectiveNetwork, ...defaultFormPreset(formId) });
      }
    } else {
      setFormData({ network: effectiveNetwork, ...defaultFormPreset(formId) });
    }
  };

  const handleOpenForm = (formId: string, preset: FormState = {}, sourceForm?: string | null) => {
    if (formId === "program-deploy") {
      resetProgramDeploySession();
    } else {
      clearProgramKeypairMaterial();
    }
    setTokenActionContext(null);
    setNonceCreateOpen(false);
    if (formId !== "create-nonce") {
      setCreatedNonceAccounts([]);
    }
    openParentMenuForForm(defaultBackTarget(formId) ?? formId);
    setBackTarget(sourceForm === undefined ? selectedForm ?? defaultBackTarget(formId) : sourceForm);
    setSelectedForm(formId);
    if (formId === "program-invoke-standalone") {
      if (programInvokeIdlFileInputRef.current) {
        programInvokeIdlFileInputRef.current.value = "";
      }
      setProgramInvoke(emptyProgramInvokeState());
      setFormData({
        ...(effectiveWalletId ? { wallet_id: effectiveWalletId } : {}),
        network: effectiveNetwork,
        ...defaultFormPreset(formId),
        ...preset,
      });
      setAuthMethod((prev) => ({ ...prev, [formId]: "keystore" }));
      return;
    }
    if (formId === "program-deploy") {
      setFormData(freshProgramDeployFormState(preset));
      setAuthMethod((prev) => ({ ...prev, [formId]: "keystore" }));
      return;
    }
    setFormData({
      ...(authFormsWithWallets.has(formId) && effectiveWalletId ? { wallet_id: effectiveWalletId } : {}),
      network: effectiveNetwork,
      ...defaultFormPreset(formId),
      ...(formId === "program-deploy" && effectiveWallet
        ? { expectedUpgradeAuthority: effectiveWallet.public_key }
        : {}),
      ...preset,
    });
    if (authFormsWithWallets.has(formId)) {
      setAuthMethod((prev) => ({ ...prev, [formId]: "keystore" }));
    }
  };

  const bytesToBrowserBase64 = useCallback((bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, []);

  const bytesToBase58 = useCallback((bytes: Uint8Array): string => {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let zeroes = 0;
    while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
    const digits: number[] = [];
    for (let i = zeroes; i < bytes.length; i += 1) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j += 1) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = Math.floor(carry / 58);
      }
    }
    return `${alphabet[0].repeat(zeroes)}${digits.reverse().map((digit) => alphabet[digit]).join("")}`;
  }, []);

  const normalizeInvokeAccountName = useCallback((value: string): string =>
    value.replace(/[_\s-]/g, "").toLowerCase(), []);

  const isIdlPubkeyType = (type: unknown): boolean =>
    type === "pubkey" || type === "publicKey";

  const isWalletLikeInvokeAccount = (account: FlatAnchorAccount): boolean => {
    if (account.address || account.pda || defaultAccountAddress(account.name, account)) return false;
    const normalized = normalizeInvokeAccountName(account.name);
    const walletHints = [
      "authority",
      "executor",
      "owner",
      "payer",
      "recipient",
      "receiver",
      "user",
      "wallet",
    ];
    const nonWalletHints = [
      "associatedtoken",
      "bridge",
      "config",
      "mint",
      "program",
      "receipt",
      "sysvar",
      "token",
      "vault",
    ];
    return (
      walletHints.some((hint) => normalized.includes(hint)) &&
      !nonWalletHints.some((hint) => normalized.includes(hint))
    );
  };

  const openProgramInvokeWalletPicker = (target: ProgramInvokeWalletPickerTarget) => {
    setProgramInvokeWalletPickerTarget(target);
  };

  const selectProgramInvokeWalletAddress = (wallet: SavedWallet) => {
    const target = programInvokeWalletPickerTarget;
    if (!target) return;
    const primaryWallet = savedWalletFromForm(formData) ?? effectiveWallet;
    setProgramInvoke((prev) => {
      if (target.kind === "arg") {
        return {
          ...prev,
          argValues: { ...prev.argValues, [target.name]: wallet.public_key },
          result: undefined,
        };
      }

      const isPrimarySigner = target.signer && wallet.public_key === String(primaryWallet?.public_key || "").trim();
      return {
        ...prev,
        accountValues: { ...prev.accountValues, [target.path]: wallet.public_key },
        signerWalletIds: target.signer
          ? { ...prev.signerWalletIds, [target.path]: isPrimarySigner ? "" : wallet.id }
          : prev.signerWalletIds,
        signerPasswords: target.signer
          ? { ...prev.signerPasswords, [target.path]: "" }
          : prev.signerPasswords,
        result: undefined,
      };
    });
    setProgramInvokeWalletPickerTarget(null);
  };

  const idlConstSeedToBase64 = useCallback((value: unknown): string | null => {
    if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      return bytesToBrowserBase64(Uint8Array.from(value as number[]));
    }
    if (typeof value === "string" && value.length > 0) {
      return bytesToBrowserBase64(new TextEncoder().encode(value));
    }
    return null;
  }, [bytesToBrowserBase64]);

  const idlConstSeedToPubkey = useCallback((value: unknown): string => {
    if (Array.isArray(value) && value.length === 32 && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      return bytesToBase58(Uint8Array.from(value as number[]));
    }
    if (typeof value === "string" && isLikelySolanaPublicKey(value.trim())) {
      return value.trim();
    }
    return "";
  }, [bytesToBase58]);

  const seedAccountReference = useCallback((seed: { path?: string; account?: string }): string =>
    String(seed.path || seed.account || "").trim(), []);

  const seedArgReference = useCallback((seed: { path?: string; arg?: string }): string =>
    String(seed.path || seed.arg || "").trim(), []);

  const isProgramInvokeTokenAmountArg = useCallback((arg: AnchorIdlArg): boolean => {
    if (arg.type !== "u64" && arg.type !== "u128") return false;
    const normalized = normalizeInvokeAccountName(arg.name);
    return normalized === "amount" || normalized.endsWith("amount") || normalized === "quantity" || normalized === "qty";
  }, [normalizeInvokeAccountName]);

  const programInvokeSingleMintAccount = useCallback((
    instruction: AnchorIdlInstruction,
    accountValues: Record<string, string>,
  ): string => {
    const mints = new Set<string>();
    for (const account of flattenAnchorAccounts(instruction.accounts)) {
      const normalized = normalizeInvokeAccountName(account.name);
      if (normalized !== "mint" && !normalized.endsWith("mint")) continue;
      const value = resolveAnchorAccountAddress(String(accountValues[account.path] || ""), account);
      if (isValidAnchorAccountAddress(value)) {
        mints.add(value);
      }
    }
    return mints.size === 1 ? [...mints][0] : "";
  }, [normalizeInvokeAccountName]);

  const fetchProgramInvokeMintDecimals = useCallback(async (mint: string): Promise<number> => {
    const response = await apiFetch("token/mint-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mint,
        network: requestNetwork(formData.network),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || t("features.program-invoke.amountConversionFailed"));
    }
    const decimals = Number(data.decimals);
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new Error(t("features.program-invoke.amountConversionFailed"));
    }
    return decimals;
  }, [formData.network, requestNetwork, t]);

  const programInvokeDisplayArgsToRaw = useCallback(async (
    instruction: AnchorIdlInstruction,
    argValues: Record<string, string>,
    accountValues: Record<string, string>,
  ): Promise<Record<string, string>> => {
    const amountArgs = instruction.args.filter(isProgramInvokeTokenAmountArg);
    if (amountArgs.length === 0) return argValues;
    const mint = programInvokeSingleMintAccount(instruction, accountValues);
    const filledAmountArg = amountArgs.find((arg) => String(argValues[arg.name] || "").trim());
    if (!mint) {
      if (filledAmountArg) {
        throw new Error(t("features.program-invoke.tokenAmountMintRequired", { arg: filledAmountArg.name }));
      }
      return argValues;
    }
    const decimals = await fetchProgramInvokeMintDecimals(mint);
    const nextValues = { ...argValues };
    for (const arg of amountArgs) {
      const value = String(argValues[arg.name] || "").trim();
      if (!value) continue;
      const raw = uiTokenAmountToRaw(value, decimals);
      if (raw === null) {
        throw new Error(t("features.program-invoke.amountConversionFailedForArg", { arg: arg.name, decimals: String(decimals) }));
      }
      nextValues[arg.name] = raw;
    }
    return nextValues;
  }, [
    fetchProgramInvokeMintDecimals,
    isProgramInvokeTokenAmountArg,
    programInvokeSingleMintAccount,
    t,
  ]);

  const deriveProgramAddress = useCallback(async (
    programId: string,
    seeds: Array<{ kind: "bytes_base64" | "pubkey"; value: string }>,
  ): Promise<string> => {
    const response = await apiFetch("program/derive-address", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ program_id: programId, seeds }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || t("features.program-invoke.accountAutofillFailed"));
    }
    return String(data.address || "").trim();
  }, [t]);

  const buildProgramInvokeAccountDefaults = useCallback(async (
    instruction: AnchorIdlInstruction | undefined,
    programId: string,
    accountValues: Record<string, string> = {},
    argValues: Record<string, string> = {},
  ): Promise<Record<string, string>> => {
    if (!instruction) return {};
    const flatAccounts = flattenAnchorAccounts(instruction.accounts);
    const nextAccounts: Record<string, string> = { ...accountValues };
    const argByName = new Map(instruction.args.map((arg) => [arg.name, arg]));
    const argByNormalizedName = new Map(
      instruction.args.map((arg) => [normalizeInvokeAccountName(arg.name), arg]),
    );

    for (const account of flatAccounts) {
      if (!nextAccounts[account.path]) {
        nextAccounts[account.path] = defaultAccountAddress(account.name, account);
      }
    }

    const trimmedProgramId = programId.trim();
    if (!isLikelySolanaPublicKey(trimmedProgramId)) {
      return nextAccounts;
    }

    const accountByName = new Map(flatAccounts.map((account) => [account.name, account.path]));
    const accountByNormalizedName = new Map(
      flatAccounts.map((account) => [normalizeInvokeAccountName(account.name), account.path]),
    );
    const resolveSeedAccount = (pathOrName: string): string => {
      const direct = String(nextAccounts[pathOrName] || "").trim();
      if (isValidAnchorAccountAddress(direct)) return direct;
      const byName = accountByName.get(pathOrName);
      const named = byName ? String(nextAccounts[byName] || "").trim() : "";
      if (isValidAnchorAccountAddress(named)) return named;
      const byNormalizedName = accountByNormalizedName.get(normalizeInvokeAccountName(pathOrName));
      const normalized = byNormalizedName ? String(nextAccounts[byNormalizedName] || "").trim() : "";
      return isValidAnchorAccountAddress(normalized) ? normalized : "";
    };
    const resolveSeedArg = (pathOrName: string): string => {
      const directArg = argByName.get(pathOrName);
      const normalizedArg = argByNormalizedName.get(normalizeInvokeAccountName(pathOrName));
      const arg = directArg || normalizedArg;
      if (!arg) return "";
      const rawValue = String(argValues[arg.name] || "").trim();
      if (!rawValue) return "";
      try {
        return encodeAnchorSeedArgToBase64(arg.type, rawValue);
      } catch {
        return "";
      }
    };
    const pdaProgramId = (account: FlatAnchorAccount): string => {
      const programSeed = account.pda?.program;
      if (!programSeed) return trimmedProgramId;
      if (programSeed.kind === "const") {
        return idlConstSeedToPubkey(programSeed.value);
      }
      if (programSeed.kind === "account") {
        return resolveSeedAccount(seedAccountReference(programSeed));
      }
      return "";
    };

    for (let pass = 0; pass < flatAccounts.length; pass += 1) {
      let changed = false;
      await Promise.all(flatAccounts.map(async (account: FlatAnchorAccount) => {
      const normalizedName = normalizeInvokeAccountName(account.name);

      if (!nextAccounts[account.path] && normalizedName === "programdata") {
        nextAccounts[account.path] = await deriveProgramAddress(UPGRADEABLE_LOADER_ID, [
          { kind: "pubkey", value: trimmedProgramId },
        ]);
        changed = true;
        return;
      }

      const seeds = account.pda?.seeds;
      if (!Array.isArray(seeds) || seeds.length === 0) return;
      const seedPayload = [];
      let seedPayloadComplete = true;
      for (const seed of seeds) {
        if (seed.kind === "const") {
          const encoded = idlConstSeedToBase64(seed.value);
          if (!encoded) {
            seedPayloadComplete = false;
            break;
          }
          seedPayload.push({ kind: "bytes_base64" as const, value: encoded });
          continue;
        }
        if (seed.kind === "account") {
          const pubkey = resolveSeedAccount(seedAccountReference(seed));
          if (!pubkey) {
            seedPayloadComplete = false;
            break;
          }
          seedPayload.push({ kind: "pubkey" as const, value: pubkey });
          continue;
        }
        if (seed.kind === "arg") {
          const encoded = resolveSeedArg(seedArgReference(seed));
          if (!encoded) {
            seedPayloadComplete = false;
            break;
          }
          seedPayload.push({ kind: "bytes_base64" as const, value: encoded });
          continue;
        }
        seedPayloadComplete = false;
        break;
      }
      if (!seedPayloadComplete) {
        if (nextAccounts[account.path]) {
          nextAccounts[account.path] = "";
          changed = true;
        }
        return;
      }
      const programForPda = pdaProgramId(account);
      if (!isLikelySolanaPublicKey(programForPda)) {
        if (nextAccounts[account.path]) {
          nextAccounts[account.path] = "";
          changed = true;
        }
        return;
      }
      const derived = await deriveProgramAddress(programForPda, seedPayload);
      if (derived && nextAccounts[account.path] !== derived) {
        nextAccounts[account.path] = derived;
        changed = true;
      }
      }));
      if (!changed) break;
    }

    return nextAccounts;
  }, [
    deriveProgramAddress,
    idlConstSeedToBase64,
    idlConstSeedToPubkey,
    normalizeInvokeAccountName,
    seedArgReference,
    seedAccountReference,
  ]);

  const selectProgramInvokeInstruction = async (instruction: AnchorIdlInstruction | undefined) => {
    if (!instruction) {
      setProgramInvoke((prev) => ({
        ...prev,
        selectedInstruction: "",
        argValues: {},
        accountValues: {},
        signerWalletIds: {},
        signerPasswords: {},
      }));
      return;
    }
    let nextAccounts: Record<string, string> = {};
    const nextArgValues = Object.fromEntries(instruction.args.map((arg) => [arg.name, ""]));
    try {
      nextAccounts = await buildProgramInvokeAccountDefaults(
        instruction,
        programInvoke.programId,
        {},
        nextArgValues,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("features.program-invoke.accountAutofillFailed"));
      nextAccounts = Object.fromEntries(
        flattenAnchorAccounts(instruction.accounts).map((account) => [
          account.path,
          defaultAccountAddress(account.name, account),
        ]),
      );
    }
    setProgramInvoke((prev) => ({
      ...prev,
      selectedInstruction: instruction.name,
      argValues: nextArgValues,
      accountValues: nextAccounts,
      signerWalletIds: {},
      signerPasswords: {},
      result: undefined,
      error: undefined,
    }));
  };

  useEffect(() => {
    if (!programInvoke.idl || programInvoke.loading || !programInvoke.selectedInstruction) return;
    const instruction = programInvoke.idl.instructions.find(
      (item) => item.name === programInvoke.selectedInstruction,
    );
    if (!instruction) return;
    let cancelled = false;
    void buildProgramInvokeAccountDefaults(
      instruction,
      programInvoke.programId,
      programInvoke.accountValues,
      programInvoke.argValues,
    )
      .then((nextAccounts) => {
        if (cancelled) return;
        setProgramInvoke((prev) => {
          if (prev.selectedInstruction !== instruction.name) return prev;
          const prevSerialized = JSON.stringify(prev.accountValues);
          const nextSerialized = JSON.stringify(nextAccounts);
          return prevSerialized === nextSerialized
            ? prev
            : { ...prev, accountValues: nextAccounts, result: undefined };
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    buildProgramInvokeAccountDefaults,
    programInvoke.accountValues,
    programInvoke.argValues,
    programInvoke.idl,
    programInvoke.loading,
    programInvoke.programId,
    programInvoke.selectedInstruction,
  ]);

  const loadProgramInvokeIdl = async (project: ProgramProject) => {
    setProgramInvoke((prev) => ({ ...prev, loading: true, error: undefined, result: undefined }));
    try {
      const response = await apiFetch("program/idl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_dir: project.sourceDir,
          artifact_stem: project.programSoName?.replace(/\.so$/i, ""),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("features.program-invoke.idlLoadFailed"));
      }
      const idlJsonText = JSON.stringify(data.idl_json, null, 2);
      const idl = parseAnchorIdlJson(idlJsonText);
      const programId = project.programId || anchorIdlProgramId(idl);
      const firstInstruction = idl.instructions[0];
      const firstArgValues = Object.fromEntries((firstInstruction?.args || []).map((arg) => [arg.name, ""]));
      const firstAccounts = await buildProgramInvokeAccountDefaults(
        firstInstruction,
        programId,
        {},
        firstArgValues,
      );
      setProgramInvoke({
        projectId: project.id,
        sourceDir: project.sourceDir,
        idlPath: String(data.idl_path || ""),
        idlJsonText,
        idl,
        programId,
        selectedInstruction: firstInstruction?.name || "",
        argValues: firstArgValues,
        accountValues: firstAccounts,
        signerWalletIds: {},
        signerPasswords: {},
        loading: false,
      });
    } catch (error) {
      setProgramInvoke((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : t("features.program-invoke.idlLoadFailed"),
      }));
    }
  };

  const loadStandaloneProgramInvokeIdl = async (idlJsonText: string, idlFileName: string) => {
    setProgramInvoke((prev) => ({ ...prev, loading: true, error: undefined, result: undefined }));
    try {
      const idl = parseAnchorIdlJson(idlJsonText);
      const programId = anchorIdlProgramId(idl);
      const firstInstruction = idl.instructions[0];
      const firstArgValues = Object.fromEntries((firstInstruction?.args || []).map((arg) => [arg.name, ""]));
      const firstAccounts = await buildProgramInvokeAccountDefaults(
        firstInstruction,
        programId,
        {},
        firstArgValues,
      );
      setProgramInvoke({
        idlPath: idlFileName,
        idlFileName,
        idlJsonText,
        idl,
        programId,
        selectedInstruction: firstInstruction?.name || "",
        argValues: firstArgValues,
        accountValues: firstAccounts,
        signerWalletIds: {},
        signerPasswords: {},
        loading: false,
      });
    } catch (error) {
      setProgramInvoke(
        emptyProgramInvokeState({
          idlPath: idlFileName,
          idlFileName,
          idlJsonText,
          loading: false,
          error: error instanceof Error ? error.message : t("features.program-invoke.idlLoadFailed"),
        }),
      );
    }
  };

  const handleProgramInvokeIdlFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      await loadStandaloneProgramInvokeIdl(text, file.name);
    } catch (error) {
      setProgramInvoke((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : t("features.program-invoke.idlLoadFailed"),
      }));
    }
  };

  const openProgramInvoke = (project: ProgramProject) => {
    clearProgramKeypairMaterial();
    setTokenActionContext(null);
    setNonceCreateOpen(false);
    openParentMenuForForm("program-workbench");
    setBackTarget("program-workbench");
    setSelectedForm("program-invoke");
    setFormData({
      wallet_id: effectiveWalletId,
      network: project.network || effectiveNetwork,
    });
    setAuthMethod((prev) => ({ ...prev, "program-invoke": "keystore" }));
    setProgramInvoke({
      projectId: project.id,
      sourceDir: project.sourceDir,
      idlJsonText: "",
      programId: project.programId || "",
      selectedInstruction: "",
      argValues: {},
      accountValues: {},
      signerWalletIds: {},
      signerPasswords: {},
      loading: true,
    });
    void loadProgramInvokeIdl(project);
  };

  const tokenActionPreset = (token: WalletTokenAsset): FormState => ({
    wallet_id: effectiveWalletId,
    network: effectiveNetwork,
    mint: token.mint,
    amount: token.ui_amount_string,
    token_balance: token.ui_amount_string,
    token_raw_amount: token.amount,
    decimals: token.decimals,
    token_account: token.account,
    sell_percent: 10000,
  });

  const openTokenActions = (token: WalletTokenAsset) => {
    const preset = tokenActionPreset(token);
    setCreatedNonceAccounts([]);
    setTokenActionContext(preset);
    openParentMenuForForm("wallet-list");
    setBackTarget("wallet-list");
    setSelectedForm("pumpfun-sell");
    setFormData({
      network: effectiveNetwork,
      ...defaultFormPreset("pumpfun-sell"),
      ...preset,
    });
    setAuthMethod((prev) => ({
      ...prev,
      "pumpfun-sell": "keystore",
      "transfer-token": "keystore",
    }));
  };

  const switchTokenAction = (formId: "pumpfun-sell" | "transfer-token") => {
    const context: FormState = tokenActionContext ?? {};
    const tokenBalance = String(context.token_balance ?? context.amount ?? formData.token_balance ?? formData.amount ?? "");
    const currentAmount = String(formData.amount ?? "").trim();
    const next: FormState = {
      wallet_id: formData.wallet_id || context.wallet_id || effectiveWalletId,
      network: formData.network || context.network || effectiveNetwork,
      mint: formData.mint || context.mint,
      amount: currentAmount || tokenBalance,
      token_balance: context.token_balance || tokenBalance,
      token_raw_amount: context.token_raw_amount || formData.token_raw_amount,
      token_account: context.token_account || formData.token_account,
      decimals: formData.decimals ?? context.decimals,
      ...defaultFormPreset(formId),
    };

    if (formId === "pumpfun-sell") {
      if (String(next.amount ?? "") === tokenBalance) {
        next.sell_percent = 10000;
      }
      next.slippage = formData.slippage ?? context.slippage ?? next.slippage;
    } else {
      delete next.sell_percent;
      delete next.slippage;
      next.to_address = formData.to_address;
    }

    setTokenActionContext((prev) => prev || context);
    setBackTarget("wallet-list");
    setSelectedForm(formId);
    setFormData(next);
    setAuthMethod((prev) => ({
      ...prev,
      [formId]: prev[formId] || "keystore",
    }));
  };

  const openNonceCreateDialog = () => {
    setCreatedNonceAccounts([]);
    setAuthMethod((prev) => ({ ...prev, "create-nonce": "keystore" }));
    setFormData({
      wallet_id: effectiveWalletId,
      network: effectiveNetwork,
      ...defaultFormPreset("create-nonce"),
    });
    setNonceCreateOpen(true);
  };

  const closeNonceCreateDialog = () => {
    if (loading) return;
    setNonceCreateOpen(false);
  };

  const handleOpenSquadsForm = (formId: string, preset: FormState = {}) => {
    setBackTarget(selectedForm ?? "squads-workspace");
    setSelectedForm(formId);
    const method = walletAuth("squads-workspace");
    const defaultStepIndex = new Set([
      "squads-sol-transfer",
      "squads-token-transfer",
      "squads-prepare-upgrade-buffer",
      "squads-program-upgrade",
    ]).has(formId)
      ? 1
      : 0;
    setAuthMethod((prev) => ({ ...prev, "squads-workspace": method, [formId]: method }));
    setFormData((prev) => {
      const defaultMembers =
        formId === "squads-create"
          ? uniqueAddressList([preset.members, prev.members, effectiveWallet?.public_key]).join("\n")
          : undefined;
      const next: FormState = {
        wallet_id: prev.wallet_id || effectiveWalletId,
        keystoreJson: prev.keystoreJson,
        encrypted_key: prev.encrypted_key,
        private_key: prev.private_key,
        network: preset.network || prev.network || effectiveNetwork,
        stepIndex: defaultStepIndex,
        ...(formId === "squads-create"
          ? { members: defaultMembers, threshold: preset.threshold || prev.threshold || "1" }
          : {}),
        ...preset,
      };
      return next;
    });
  };

  const walletAuthFormData = (base: FormState = formData): FormState => ({
    ...base,
    wallet_id: String(base.wallet_id ?? effectiveWalletId).trim() || undefined,
    network: base.network || effectiveNetwork,
  });

  const expectedGenesisHashFor = (state: FormState): string =>
    SOLANA_GENESIS_HASHES[currentNetwork(state.network || effectiveNetwork)];

  const programDeploymentJournalIntentFor = useCallback((
    state: FormState,
  ): ProgramDeploymentJournalIntent | null => {
    const programLen = Number(state.programSoSize || 0);
    const maxDataLen =
      state.max_data_len === undefined || state.max_data_len === ""
        ? programLen
        : Number(state.max_data_len);
    const programId = String(state.expectedProgramId || "").trim();
    const programSha256 = String(state.programSoSha256 || "").trim().toLowerCase();
    const upgradeAuthority = String(state.expectedUpgradeAuthority || "").trim();
    if (
      !state.programSoBase64 ||
      !isLikelySolanaPublicKey(programId) ||
      !isLikelySolanaPublicKey(upgradeAuthority) ||
      !/^[a-f0-9]{64}$/.test(programSha256) ||
      !Number.isSafeInteger(programLen) ||
      programLen <= 0 ||
      !Number.isSafeInteger(maxDataLen) ||
      maxDataLen < programLen ||
      maxDataLen > MAX_PROGRAM_SO_FILE_BYTES
    ) {
      return null;
    }
    const network = currentNetwork(state.network || effectiveNetwork);
    return {
      requestNetwork:
        network === effectiveNetwork ? effectiveRpcRequest : requestNetwork(state.network),
      network,
      genesisHash: SOLANA_GENESIS_HASHES[network],
      programId,
      programSha256,
      programLen,
      maxDataLen,
      upgradeAuthority,
    };
  }, [effectiveNetwork, effectiveRpcRequest, requestNetwork]);

  useEffect(() => {
    if (selectedForm !== "program-deploy") return;
    const intent = lastProgramDeploymentIntentRef.current || (loading ? programDeploymentJournalIntentFor(formData) : null);
    if (!intent) return;
    const intentKey = programDeploymentIntentKey(intent);
    const journalState = programDeploymentJournalRef.current;
    const journalMatchesIntent = journalState.intentKey === intentKey;
    if (!loading && journalMatchesIntent && journalState.journal?.status === "finalized") {
      return;
    }

    const refresh = () => {
      void loadProgramDeploymentJournal(intent, { preserveCurrent: true });
    };
    refresh();
    const interval = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(interval);
  }, [
    formData,
    loadProgramDeploymentJournal,
    loading,
    programDeploymentJournalIntentFor,
    selectedForm,
  ]);

  useEffect(() => {
    if (!loading || selectedForm !== "program-deploy") {
      programDeploymentWatchdogTrippedRef.current = false;
      return;
    }
    const journal = programDeploymentJournal.journal;
    if (!journal || journal.status === "finalized") {
      programDeploymentWatchdogTrippedRef.current = false;
      return;
    }
    const lastAttemptActivitySeconds = programDeploymentJournal.deploymentAttempts.reduce(
      (latest, attempt) => Math.max(latest, attempt.updated_at || attempt.created_at || 0),
      0,
    );
    const lastActivitySeconds = Math.max(journal.updated_at || 0, lastAttemptActivitySeconds);
    if (!lastActivitySeconds) return;
    const ageMs = programDeploymentNowMs - lastActivitySeconds * 1000;
    if (
      ageMs < PROGRAM_DEPLOY_STALLED_MS ||
      programDeploymentWatchdogTrippedRef.current
    ) {
      return;
    }
    programDeploymentWatchdogTrippedRef.current = true;
    setLoading(false);
    const stalledMessage = t("features.program-deploy.journalStalledToast");
    setProgramDeployInlineError({
      friendly: t("features.program-deploy.friendlyJournalStalled"),
      raw: stalledMessage,
    });
  }, [
    loading,
    programDeploymentJournal.deploymentAttempts,
    programDeploymentJournal.journal,
    programDeploymentNowMs,
    selectedForm,
    t,
  ]);

  useEffect(() => {
    if (!loading || selectedForm !== "program-upgrade") {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await apiFetch("program/upgrade/progress", { method: "GET" });
        const data = await response.json();
        if (cancelled || !response.ok) return;
        setProgramUpgradeProgress({
          active: Boolean(data.active),
          program_id: String(data.program_id || ""),
          network: String(data.network || ""),
          stage: String(data.stage || "idle"),
          message: String(data.message || ""),
          write_completed: Number(data.write_completed || 0),
          write_total: Number(data.write_total || 0),
          program_bytes: Number(data.program_bytes || 0),
          buffer_address: data.buffer_address ?? null,
          last_signature: data.last_signature ?? null,
          error: data.error ?? null,
          updated_at_ms: Number(data.updated_at_ms || 0),
        });
        if (data.message) {
          setFormData((prev) =>
            prev.message === data.message ? prev : { ...prev, message: String(data.message) },
          );
        }
      } catch {
        // Keep the static upgrading UI if progress polling fails.
      }
    };
    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loading, selectedForm]);

  const programDeployValidationError = (state: FormState): string | null => {
    const sourceValidationErrors = String(state.sourceValidationErrors || "").trim();
    if (sourceValidationErrors) {
      return t("features.program-deploy.sourceValidationBlocked");
    }
    if (!state.programSoBase64) {
      return t("features.program-deploy.selectFileFirst");
    }
    if (!/^[a-f0-9]{64}$/.test(String(state.programSoSha256 ?? ""))) {
      return t("features.program-deploy.programHashUnavailable");
    }
    const programKeypairPath = String(state.programKeypairPath ?? "").trim();
    if (!programKeypairBytesRef.current && !programKeypairPath) {
      return t("features.program-deploy.selectProgramKeypairFirst");
    }

    const expectedProgramId = String(state.expectedProgramId ?? "").trim();
    if (!isLikelySolanaPublicKey(expectedProgramId)) {
      return t("features.program-deploy.invalidExpectedProgramId");
    }
    if (programKeypairMetadata && expectedProgramId !== programKeypairMetadata.programId) {
      return t("features.program-deploy.expectedProgramIdMismatch");
    }

    const expectedUpgradeAuthority = String(state.expectedUpgradeAuthority ?? "").trim();
    if (!isLikelySolanaPublicKey(expectedUpgradeAuthority)) {
      return t("features.program-deploy.invalidExpectedUpgradeAuthority");
    }
    const deploymentWallet = walletAuth("program-deploy") === "keystore"
      ? savedWalletFromForm(state)
      : undefined;
    if (
      deploymentWallet &&
      expectedUpgradeAuthority !== deploymentWallet.public_key
    ) {
      return t("features.program-deploy.expectedUpgradeAuthorityMismatch");
    }

    const maxDataLen =
      state.max_data_len === undefined || state.max_data_len === ""
        ? undefined
        : Number(state.max_data_len);
    if (
      maxDataLen !== undefined &&
      (!Number.isInteger(maxDataLen) || maxDataLen <= 0 || maxDataLen > MAX_PROGRAM_SO_FILE_BYTES)
    ) {
      return t("features.program-deploy.invalidMaxDataLen");
    }
    const resumeBufferAddress = String(state.resumeBufferAddress ?? "").trim();
    if (resumeBufferAddress && !isLikelySolanaPublicKey(resumeBufferAddress)) {
      return t("features.program-deploy.invalidResumeBufferAddress");
    }
    return null;
  };

  const formatLamportsAsSol = (lamports: string | number): string => {
    const value = typeof lamports === "number" ? lamports : Number(lamports);
    if (!Number.isFinite(value)) return String(lamports);
    return (value / 1_000_000_000).toFixed(4);
  };

  const programDeployFriendlyError = useCallback((rawMessage: unknown): string => {
    const raw = String(rawMessage || "").trim();
    if (!raw) return t("features.program-deploy.error");
    const normalized = raw.toLowerCase();

    const backendSolMatch = raw.match(
      /当前\s*([0-9.]+)\s*SOL[\s\S]*至少需要约\s*([0-9.]+)\s*SOL/i,
    );
    if (backendSolMatch) {
      const currentSol = backendSolMatch[1];
      const neededSol = backendSolMatch[2];
      const shortfall = Math.max(0, Number(neededSol) - Number(currentSol));
      return t("features.program-deploy.friendlyInsufficientBalance", {
        currentSol,
        neededSol,
        shortfallSol: Number.isFinite(shortfall) ? shortfall.toFixed(4) : neededSol,
      });
    }

    const backendLamportsMatch = raw.match(
      /当前\s*(\d+)\s*lamports[\s\S]*至少需要\s*(\d+)\s*lamports/i,
    );
    if (backendLamportsMatch) {
      const current = Number(backendLamportsMatch[1]);
      const needed = Number(backendLamportsMatch[2]);
      return t("features.program-deploy.friendlyInsufficientBalance", {
        currentSol: formatLamportsAsSol(current),
        neededSol: formatLamportsAsSol(needed),
        shortfallSol: formatLamportsAsSol(Math.max(0, needed - current)),
      });
    }

    const lamportsMatch = raw.match(/insufficient lamports\s+(\d+),\s*need\s+(\d+)/i);
    if (lamportsMatch) {
      const current = Number(lamportsMatch[1]);
      const needed = Number(lamportsMatch[2]);
      return t("features.program-deploy.friendlyInsufficientBalance", {
        currentSol: formatLamportsAsSol(current),
        neededSol: formatLamportsAsSol(needed),
        shortfallSol: formatLamportsAsSol(Math.max(0, needed - current)),
      });
    }
    if (
      normalized.includes("insufficient funds")
      || normalized.includes("insufficient lamports")
      || raw.includes("余额不足")
    ) {
      return t("features.program-deploy.friendlyInsufficientFunds");
    }
    if (normalized.includes("attempt to debit an account but found no record of a prior credit")) {
      return t("features.program-deploy.friendlyMissingPayerAccount");
    }
    if (normalized.includes("genesis hash") || raw.includes("创世哈希")) {
      return t("features.program-deploy.friendlyGenesisMismatch");
    }
    if (normalized.includes("busy") || raw.includes("正在进行")) {
      return t("features.program-deploy.friendlyBusy");
    }
    if (normalized.includes("sha-256") || normalized.includes("sha256") || raw.includes("SHA-256")) {
      return t("features.program-deploy.friendlySha256Mismatch");
    }
    if (
      normalized.includes("already in use")
      || normalized.includes("account already exists")
      || raw.includes("已存在")
    ) {
      return t("features.program-deploy.friendlyAccountAlreadyInUse");
    }
    if (
      normalized.includes("runtime loader rejected")
      || normalized.includes("requisiteverifier")
      || normalized.includes("sbf verifier")
    ) {
      return t("features.program-deploy.friendlySbfRejected");
    }
    if (normalized.includes("resume buffer") || raw.includes("恢复 Buffer")) {
      return t("features.program-deploy.friendlyResumeBuffer");
    }
    if (raw.includes("长时间没有新进展") || normalized.includes("stalled")) {
      return t("features.program-deploy.friendlyJournalStalled");
    }
    return raw;
  }, [t]);

  const showProgramDeployInlineError = (message: unknown) => {
    const raw = String(message || t("features.program-deploy.error")).trim()
      || t("features.program-deploy.error");
    setProgramDeployInlineError({
      friendly: programDeployFriendlyError(raw),
      raw,
    });
  };

  const programUpgradeFriendlyError = useCallback((rawMessage: unknown): string => {
    const raw = String(rawMessage || "").trim();
    if (!raw) return t("features.program-upgrade.error");
    const normalized = raw.toLowerCase();

    const backendBalanceMatch = raw.match(
      /当前\s*([0-9.]+)\s*SOL[\s\S]*至少需要约\s*([0-9.]+)\s*SOL/i,
    );
    if (backendBalanceMatch) {
      const currentSol = backendBalanceMatch[1];
      const neededSol = backendBalanceMatch[2];
      const shortfall = Math.max(0, Number(neededSol) - Number(currentSol));
      return t("features.program-upgrade.friendlyInsufficientBalance", {
        currentSol,
        neededSol,
        shortfallSol: Number.isFinite(shortfall) ? shortfall.toFixed(4) : neededSol,
      });
    }

    const lamportsMatch = raw.match(/insufficient lamports\s+(\d+),\s*need\s+(\d+)/i);
    if (lamportsMatch) {
      const current = Number(lamportsMatch[1]);
      const needed = Number(lamportsMatch[2]);
      return t("features.program-upgrade.friendlyInsufficientBalance", {
        currentSol: formatLamportsAsSol(current),
        neededSol: formatLamportsAsSol(needed),
        shortfallSol: formatLamportsAsSol(Math.max(0, needed - current)),
      });
    }
    if (normalized.includes("insufficient funds") || normalized.includes("insufficient lamports") || raw.includes("余额不足")) {
      return t("features.program-upgrade.friendlyInsufficientFunds");
    }
    if (raw.includes("超过 ProgramData 容量") || normalized.includes("max_data_len")) {
      return t("features.program-upgrade.friendlyProgramDataTooSmall");
    }
    if (raw.includes("upgrade authority") || raw.includes("Upgrade Authority") || raw.includes("升级权限")) {
      return t("features.program-upgrade.friendlyAuthorityMismatch");
    }
    if (normalized.includes("genesis hash") || raw.includes("创世哈希")) {
      return t("features.program-upgrade.friendlyGenesisMismatch");
    }
    if (
      normalized.includes("未能在超时前确认") ||
      normalized.includes("timeout") ||
      normalized.includes("timed out")
    ) {
      return t("features.program-upgrade.friendlyTimeout");
    }
    if (normalized.includes("busy") || raw.includes("正在进行")) {
      return t("features.program-upgrade.friendlyBusy");
    }
    return raw;
  }, [t]);

  const showProgramUpgradeInlineError = (message: unknown) => {
    const raw = String(message || t("features.program-upgrade.error")).trim()
      || t("features.program-upgrade.error");
    setProgramUpgradeInlineError({
      friendly: programUpgradeFriendlyError(raw),
      raw,
    });
  };

  const programInvokeFriendlyError = useCallback((
    rawMessage: unknown,
    logs: string[] = [],
  ): string => {
    const raw = String(rawMessage || "").trim();
    const combined = [raw, ...logs].filter(Boolean).join("\n");
    const normalized = combined.toLowerCase();
    if (!combined.trim()) return t("features.program-invoke.error");

    const anchorMatch = combined.match(
      /Error Code:\s*([A-Za-z0-9_]+)\.?\s*Error Number:\s*(\d+)\.?\s*Error Message:\s*([^\n]+)/,
    );
    if (anchorMatch) {
      const [, code, number, message] = anchorMatch;
      const hintKey = `features.program-invoke.anchorErrorHints.${code}`;
      const hintValue = t(hintKey);
      const hint = hintValue === hintKey ? "" : hintValue;
      return hint
        ? t("features.program-invoke.friendlyAnchorErrorWithHint", { code, number, message: message.trim(), hint })
        : t("features.program-invoke.friendlyAnchorError", { code, number, message: message.trim() });
    }

    if (normalized.includes("declaredprogramidmismatch")) {
      return t("features.program-invoke.friendlyDeclaredProgramIdMismatch");
    }
    if (normalized.includes("attempt to debit an account but found no record of a prior credit")) {
      return t("features.program-invoke.friendlyMissingPayerAccount");
    }
    const lamportsMatch = combined.match(/insufficient lamports\s+(\d+),\s*need\s+(\d+)/i);
    if (lamportsMatch) {
      return t("features.program-invoke.friendlyInsufficientLamports", {
        current: lamportsMatch[1],
        needed: lamportsMatch[2],
      });
    }
    if (normalized.includes("insufficient funds") || normalized.includes("insufficient lamports")) {
      return t("features.program-invoke.friendlyInsufficientFunds");
    }
    const accountNotFoundMatch = combined.match(/AccountNotFound:\s*pubkey=([1-9A-HJ-NP-Za-km-z]+)/i);
    if (accountNotFoundMatch) {
      return t("features.program-invoke.friendlyAccountNotFound", { account: accountNotFoundMatch[1] });
    }
    if (normalized.includes("blockhash not found")) {
      return t("features.program-invoke.friendlyBlockhashNotFound");
    }
    if (normalized.includes("signature verification failed")) {
      return t("features.program-invoke.friendlySignatureVerificationFailed");
    }
    if (normalized.includes("unauthorized signer") || normalized.includes("privilege escalation")) {
      return t("features.program-invoke.friendlyAccountPrivilege");
    }
    if (normalized.includes("invalid account data") || normalized.includes("account did not deserialize")) {
      return t("features.program-invoke.friendlyInvalidAccountData");
    }
    if (normalized.includes("already in use")) {
      return t("features.program-invoke.friendlyAccountAlreadyInUse");
    }
    if (normalized.includes("computational budget exceeded") || normalized.includes("exceeded maximum number of instructions")) {
      return t("features.program-invoke.friendlyComputeBudgetExceeded");
    }
    const customProgramErrorMatch = combined.match(/custom program error:\s*(0x[0-9a-f]+)/i);
    if (customProgramErrorMatch) {
      return t("features.program-invoke.friendlyCustomProgramError", { code: customProgramErrorMatch[1] });
    }
    return raw || t("features.program-invoke.error");
  }, [t]);

  const validateBeforePasswordPrompt = (formId: string, nextFormData: FormState): boolean => {
    const fail = (message: string) => {
      if (formId === "program-upgrade") {
        showProgramUpgradeInlineError(message);
        return false;
      }
      toast.error(message);
      return false;
    };
    const amount = parsePositiveDecimal(nextFormData.amount);

    switch (formId) {
      case "transfer-sol":
        return nextFormData.to_address && amount !== null
          ? true
          : fail(t("features.transfer-sol.fillAllFields"));
      case "transfer-token":
        return nextFormData.to_address && nextFormData.mint && amount !== null
          ? true
          : fail(t("features.transfer-token.fillAllFields"));
      case "wrap-sol":
        return amount !== null ? true : fail(t("features.wrap-sol.fillAllFields"));
      case "program-deploy": {
        const error = programDeployValidationError(nextFormData);
        if (error) {
          showProgramDeployInlineError(error);
          return false;
        }
        return true;
      }
      case "program-upgrade": {
        setProgramUpgradeInlineError(null);
        const programId = String(nextFormData.programId || nextFormData.expectedProgramId || "").trim();
        if (!programId) return fail(t("features.program-upgrade.programIdRequired"));
        if (!isLikelySolanaPublicKey(programId)) return fail(t("features.program-upgrade.invalidProgramId"));
        if (!nextFormData.programSoBase64) return fail(t("features.program-upgrade.fillAllFields"));
        const sourceDir = String(nextFormData.programSourceDir || "").trim();
        const projectForUpgrade = sourceDir
          ? workspace.programProjects.find((item) => item.id === scopedProgramProjectId(sourceDir))
          : workspace.programProjects.find((item) => String(item.programId || "").trim() === programId);
        if (isStaleProgramUpgradeArtifact(projectForUpgrade, programId, nextFormData.programSoSha256)) {
          return fail(t("features.program-upgrade.staleArtifactBlocked"));
        }
        return true;
      }
      case "program-invoke":
      case "program-invoke-standalone": {
        const failProgramInvoke = (message: string) => {
          const displayMessage = programInvokeFriendlyError(message);
          setProgramInvoke((prev) => ({
            ...prev,
            result: {
              status: "validation_failed",
              errorMessage: displayMessage,
              rawErrorMessage: displayMessage === message ? undefined : message,
              logs: [],
            },
          }));
          return false;
        };
        if (programInvoke.loading) return failProgramInvoke(t("features.program-invoke.idlLoading"));
        if (!programInvoke.idl || programInvoke.error) {
          return failProgramInvoke(programInvoke.error || (formId === "program-invoke-standalone"
            ? tf("features.program-invoke.noStandaloneIdl", "请先选择一个 Anchor IDL JSON 文件。")
            : t("features.program-invoke.noIdl")));
        }
        if (!isLikelySolanaPublicKey(programInvoke.programId)) {
          return failProgramInvoke(t("features.program-invoke.invalidProgramId"));
        }
        const instruction = programInvoke.idl.instructions.find(
          (item) => item.name === programInvoke.selectedInstruction,
        );
        if (!instruction) return failProgramInvoke(t("features.program-invoke.noInstruction"));
        if (instruction.args.some((arg) => isUnsupportedIdlType(arg.type))) {
          return failProgramInvoke(t("features.program-invoke.unsupportedType"));
        }
        const primaryInvokeWallet = savedWalletFromForm(nextFormData) ?? effectiveWallet;
        for (const account of flattenAnchorAccounts(instruction.accounts)) {
          const value = resolveAnchorAccountAddress(String(programInvoke.accountValues[account.path] || ""), account);
          if (!isValidAnchorAccountAddress(value)) {
            return failProgramInvoke(t("features.program-invoke.accountInvalid", { account: account.path }));
          }
          if (account.isSigner && value !== String(primaryInvokeWallet?.public_key || "").trim()) {
            const walletId = String(programInvoke.signerWalletIds[account.path] || "").trim();
            const password = String(programInvoke.signerPasswords[account.path] || "");
            const wallet = wallets.find((item) => item.id === walletId);
            if (!walletId || !password) {
              return failProgramInvoke(t("features.program-invoke.signerWalletRequired", { account: account.path }));
            }
            if (wallet && wallet.public_key !== value) {
              return failProgramInvoke(t("features.program-invoke.signerWalletMismatch", { account: account.path }));
            }
          }
        }
        return true;
      }
      case "external-sign": {
        const requiredSigner = String(nextFormData.requiredSigner || "").trim();
        const transactionBase64 = String(nextFormData.transactionBase64 || "").trim();
        const instructionRequest = parseExternalSignInstructionRequest(String(nextFormData.externalSignRequestJson || ""));
        if (!requiredSigner || (!transactionBase64 && !instructionRequest)) {
          return fail(t("features.external-sign.fillAllFields"));
        }
        if (!isLikelySolanaPublicKey(requiredSigner)) {
          return fail(t("features.external-sign.invalidRequiredSigner"));
        }
        const selectedWallet = savedWalletFromForm(nextFormData) ?? effectiveWallet;
        if (selectedWallet && selectedWallet.public_key !== requiredSigner) {
          return fail(t("features.external-sign.walletMismatch", {
            wallet: selectedWallet.public_key,
            signer: requiredSigner,
          }));
        }
        const expiresAt = String(nextFormData.expiresAt || "").trim();
        if (expiresAt && !/^\d+$/.test(expiresAt)) {
          return fail(t("features.external-sign.invalidExpiresAt"));
        }
        const expectedGenesisHash = String(nextFormData.expectedGenesisHash || "").trim();
        if (expectedGenesisHash && !isLikelySolanaGenesisHash(expectedGenesisHash)) {
          return fail(t("features.external-sign.invalidGenesisHash"));
        }
        return true;
      }
      case "squads-create": {
        const members = parseAddressList(nextFormData.members);
        const threshold = parseInt(String(nextFormData.threshold || ""), 10);
        const signer = String(effectiveWallet?.public_key ?? "").trim();
        const timeLock =
          nextFormData.time_lock === undefined || nextFormData.time_lock === ""
            ? undefined
            : parseInt(String(nextFormData.time_lock), 10);
        if (members.length === 0 || !Number.isInteger(threshold)) {
          return fail(t("features.squads-create.fillAllFields"));
        }
        if (threshold <= 0 || threshold > members.length) {
          return fail(t("features.squads-create.invalidThreshold"));
        }
        if (signer && !members.includes(signer)) {
          return fail(t("features.squads-create.signerMustBeMember"));
        }
        return timeLock === undefined || (Number.isInteger(timeLock) && timeLock >= 0)
          ? true
          : fail(t("features.squads-create.invalidTimeLock"));
      }
      case "squads-sol-transfer":
        return nextFormData.multisig && nextFormData.to_address && amount !== null
          ? true
          : fail(t("features.squads-sol-transfer.fillAllFields"));
      case "squads-token-transfer": {
        return nextFormData.multisig &&
          nextFormData.mint &&
          nextFormData.recipient &&
          amount !== null
          ? true
          : fail(t("features.squads-token-transfer.fillAllFields"));
      }
      case "squads-prepare-upgrade-buffer":
        return nextFormData.multisig && nextFormData.programSoBase64
          ? true
          : fail(t("features.squads-prepare-upgrade-buffer.fillAllFields"));
      case "squads-program-upgrade":
        return nextFormData.multisig && nextFormData.programId && nextFormData.bufferAddress
          ? true
          : fail(t("features.squads-program-upgrade.fillAllFields"));
      case "squads-set-authority":
        return nextFormData.multisig && nextFormData.programId
          ? true
          : fail(t("features.squads-set-authority.fillAllFields"));
      case "squads-approve":
      case "squads-reject":
        return nextFormData.multisig && nextFormData.proposal
          ? true
          : fail(t("features.squads-vote.fillAllFields"));
      case "squads-execute": {
        const transactionIndex = parseInt(String(nextFormData.transactionIndex || ""), 10);
        return nextFormData.multisig &&
          nextFormData.proposal &&
          Number.isInteger(transactionIndex)
          ? true
          : fail(t("features.squads-execute.fillAllFields"));
      }
      case "pumpfun-sell":
        return nextFormData.mint && hasValidSellAmount(nextFormData)
          ? true
          : fail(t("features.pumpfun-sell.fillAllFields"));
      case "pumpswap-sell":
        return nextFormData.mint && hasValidSellAmount(nextFormData)
          ? true
          : fail(t("features.pumpswap-sell.fillAllFields"));
      case "setup-2fa":
        return nextFormData.hardware_fingerprint
          ? true
          : fail(t("features.setup-2fa.fillAllFields"));
      case "create-tfa": {
        const method = walletAuth("create-tfa");
        const hasWalletMaterial =
          method === "keystore"
            ? String(nextFormData.wallet_id ?? "").trim() || String(nextFormData.keystoreJson ?? "").trim()
            : method === "encrypted"
              ? String(nextFormData.encrypted_key ?? nextFormData.encryptedKey ?? "").trim()
              : String(nextFormData.private_key ?? "").trim();
        const questionIndex =
          typeof nextFormData.question_index === "number"
            ? nextFormData.question_index
            : parseInt(String(nextFormData.question_index ?? ""), 10);
        if (
          !hasWalletMaterial ||
          !nextFormData.totp_secret ||
          !nextFormData.hardware_fingerprint ||
          nextFormData.question_index === undefined ||
          !nextFormData.security_answer
        ) {
          return fail(t("features.create-tfa.fillAllFields"));
        }
        return Number.isInteger(questionIndex) && questionIndex >= 0 && questionIndex <= 7
          ? true
          : fail(t("features.create-tfa.questionIndexError"));
      }
      case "unlock-tfa":
        return nextFormData.encrypted_wallet &&
          nextFormData.hardware_fingerprint &&
          nextFormData.security_answer &&
          nextFormData.totp_code
          ? true
          : fail(t("features.unlock-tfa.fillAllFields"));
      default:
        return true;
    }
  };

  const shouldPromptForWalletPassword = (formId: string): boolean => {
    if (!WALLET_PASSWORD_FORM_IDS.has(formId)) return false;
    const method = walletAuth(formId);
    return method === "keystore" || method === "encrypted";
  };

  const shouldPromptForMasterPassword = (formId: string): boolean =>
    MASTER_PASSWORD_FORM_IDS.has(formId);

  const requestCreatePasswordSubmit = (formId: string) => {
    if (!CREATE_PASSWORD_FORM_IDS.has(formId)) {
      void handleSubmit(formId);
      return;
    }

    const nextFormData = { ...formData };
    if (formId === "create-keystore" && !String(nextFormData.name ?? "").trim()) {
      toast.error(t("formUi.walletNameRequired"));
      return;
    }
    if (formId === "import-keystore" && !String(nextFormData.keystoreJson ?? "").trim()) {
      toast.error(t("features.import-keystore.fillAllFields"));
      return;
    }
    if (formId === "import-mnemonic" && !String(nextFormData.mnemonic ?? "").trim()) {
      toast.error(t("features.import-mnemonic.fillAllFields"));
      return;
    }

    setPasswordPromptValue("");
    setMasterPasswordPromptValue("");
    setMigrationNewPassword("");
    setMigrationConfirmPassword("");
    setPasswordPrompt({ kind: "create-password", formId, formState: nextFormData });
  };

  const requestPasswordSubmit = (formId: string, formOverride?: FormState) => {
    if (formId === "program-deploy") {
      setProgramDeployInlineError(null);
    }
    if (formId === "program-upgrade") {
      setProgramUpgradeInlineError(null);
    }
    const needsWalletPassword = shouldPromptForWalletPassword(formId);
    const needsMasterPassword = shouldPromptForMasterPassword(formId);

    if (!needsWalletPassword && !needsMasterPassword) {
      const requestSource = formId === "external-sign"
        ? hydrateExternalSignFormDataFromJson(formOverride ?? formData)
        : formOverride ?? formData;
      const nextFormData = formId === "program-deploy"
        ? normalizedProgramDeployFormState(requestSource)
        : requestSource;
      void handleSubmit(formId, nextFormData);
      return;
    }

    const requestSource = formId === "external-sign"
      ? hydrateExternalSignFormDataFromJson(formOverride ?? formData)
      : formOverride ?? formData;
    const nextFormData = formId === "program-deploy"
      ? normalizedProgramDeployFormState(walletAuthFormData(requestSource))
      : walletAuthFormData(requestSource);
    const method = walletAuth(formId);
    if (needsWalletPassword &&
      method === "keystore" &&
      !String(nextFormData.wallet_id ?? "").trim() &&
      !String(nextFormData.keystoreJson ?? "").trim()
    ) {
      if (formId === "program-deploy") {
        showProgramDeployInlineError(t("features.walletContext.noWallet"));
      } else {
        toast.error(t("features.walletContext.noWallet"));
      }
      return;
    }
    if (
      needsWalletPassword &&
      method === "encrypted" &&
      !String(nextFormData.encrypted_key ?? nextFormData.encryptedKey ?? "").trim()
    ) {
      if (formId === "program-deploy") {
        showProgramDeployInlineError(t("features.decrypt.fillAllFields"));
      } else {
        toast.error(t("features.decrypt.fillAllFields"));
      }
      return;
    }
    if (!validateBeforePasswordPrompt(formId, nextFormData)) {
      return;
    }

    setFormData(nextFormData);
    setPasswordPromptValue("");
    setMasterPasswordPromptValue("");
    setSavePasswordToBiometric(false);
    setPasswordPrompt({
      kind: "form",
      formId,
      formState: nextFormData,
      fields: [
        ...(needsWalletPassword ? (["password"] as PasswordPromptField[]) : []),
        ...(needsMasterPassword ? (["master_password"] as PasswordPromptField[]) : []),
      ],
    });
  };

  const requestProposalPasswordSubmit = (
    proposal: WorkspaceProposal,
    action: WorkspaceProposalAction,
  ) => {
    if (walletAuth("squads-workspace") !== "keystore") {
      void handleWorkspaceProposalAction(proposal, action);
      return;
    }

    const nextFormData = walletAuthFormData();
    if (!String(nextFormData.wallet_id ?? "").trim() && !String(nextFormData.keystoreJson ?? "").trim()) {
      toast.error(t("features.walletContext.noWallet"));
      return;
    }

    setFormData(nextFormData);
    setPasswordPromptValue("");
    setMasterPasswordPromptValue("");
    setSavePasswordToBiometric(false);
    setPasswordPrompt({ kind: "proposal", proposal, action, formState: nextFormData });
  };

  const closePasswordPrompt = () => {
    if (loading || passwordConfirmationInFlightRef.current) return;
    if (passwordPrompt?.kind === "form" && passwordPrompt.formId === "program-deploy") {
      clearProgramKeypairMaterial();
    }
    setPasswordPrompt(null);
    setSavePasswordToBiometric(false);
    clearPasswordPromptSecrets();
  };

  const passwordPromptFields = passwordPrompt?.kind === "form"
    ? passwordPrompt.fields ?? ["password"]
    : passwordPrompt?.kind === "master-password"
      ? (["master_password"] as PasswordPromptField[])
      : (["password"] as PasswordPromptField[]);
  const showWalletPasswordPrompt = passwordPromptFields.includes("password");
  const showMasterPasswordPrompt = passwordPromptFields.includes("master_password");
  const showMigrationPasswords = passwordPrompt?.kind === "migrate-keystore";
  const showExportBundlePrompt = passwordPrompt?.kind === "export-bundle";
  const passwordPromptIsBusy = loading || passwordConfirmationBusy;
  const passwordPromptWallet =
    passwordPrompt && "wallet" in passwordPrompt
      ? passwordPrompt.wallet
      : passwordPrompt && "formState" in passwordPrompt
      ? savedWalletFromForm(passwordPrompt.formState)
      : undefined;
  const showPasswordPromptBiometric =
    showWalletPasswordPrompt &&
    !showMigrationPasswords &&
    passwordPrompt?.kind !== "create-password" &&
    Boolean(passwordPromptWallet) &&
    canUseBiometricWallet(passwordPromptWallet);
  const passwordPromptBiometricConfigured = biometricConfiguredFor(passwordPromptWallet);
  const passwordPromptBiometricBusy =
    Boolean(passwordPromptWallet && biometricBusyWalletId === passwordPromptWallet.id);
  const isProgramDeploymentPasswordPrompt =
    passwordPrompt?.kind === "form" && passwordPrompt.formId === "program-deploy";
  const isProgramUpgradePasswordPrompt =
    passwordPrompt?.kind === "form" && passwordPrompt.formId === "program-upgrade";
  const isLongRunningProgramPasswordPrompt =
    isProgramDeploymentPasswordPrompt || isProgramUpgradePasswordPrompt;

  const passwordPromptTitle =
    passwordPrompt?.kind === "export-bundle"
      ? t("features.settings.exportBundleTitle")
      : passwordPrompt?.kind === "export-keystore"
      ? t("features.settings.exportPasswordTitle")
      : passwordPrompt?.kind === "export-private-key"
        ? t("features.settings.exportPrivateKeyTitle")
      : passwordPrompt?.kind === "export-mnemonic"
        ? t("features.settings.exportMnemonicTitle")
      : passwordPrompt?.kind === "enable-biometric"
        ? t("features.biometric.enableTitle")
      : passwordPrompt?.kind === "migrate-keystore"
        ? t("features.settings.migrateTitle")
      : passwordPrompt?.kind === "create-password"
        ? t("formUi.passwordPromptTitle")
      : showWalletPasswordPrompt && showMasterPasswordPrompt
        ? t("formUi.passwordsPromptTitle")
      : showMasterPasswordPrompt
        ? t("formUi.masterPasswordPromptTitle")
      : passwordPrompt?.kind === "master-password"
        ? t("formUi.masterPasswordPromptTitle")
      : t("formUi.confirmPasswordTitle");
  const passwordPromptHint =
    passwordPrompt?.kind === "export-bundle"
      ? t("features.settings.exportBundleHint")
      : passwordPrompt?.kind === "export-keystore"
      ? t("features.settings.exportPasswordHint")
      : passwordPrompt?.kind === "export-private-key"
        ? t("features.settings.exportPrivateKeyHint")
      : passwordPrompt?.kind === "export-mnemonic"
        ? t("features.settings.exportMnemonicHint")
      : passwordPrompt?.kind === "enable-biometric"
        ? t("features.biometric.enableHint")
      : passwordPrompt?.kind === "migrate-keystore"
        ? t("features.settings.migrateHint")
      : passwordPrompt?.kind === "create-password"
        ? t("formUi.passwordPromptHint")
      : showWalletPasswordPrompt && showMasterPasswordPrompt
        ? t("formUi.passwordsPromptHint")
      : showMasterPasswordPrompt
        ? t("formUi.masterPasswordPromptHint")
      : passwordPrompt?.kind === "master-password"
        ? t("formUi.masterPasswordPromptHint")
      : t("formUi.confirmPasswordHint");
  const passwordPromptButton =
    passwordPrompt?.kind === "export-bundle"
      ? t("features.settings.exportBundleButton")
      : passwordPrompt?.kind === "export-keystore"
      ? t("features.settings.exportPasswordButton")
      : passwordPrompt?.kind === "export-private-key"
        ? t("features.settings.exportPrivateKeyButton")
      : passwordPrompt?.kind === "export-mnemonic"
        ? t("features.settings.exportMnemonicButton")
      : passwordPrompt?.kind === "enable-biometric"
        ? t("features.biometric.enableButton")
      : passwordPrompt?.kind === "migrate-keystore"
        ? t("features.settings.migrateButton")
      : passwordPrompt?.kind === "create-password"
        ? t("formUi.passwordPromptButton")
      : showWalletPasswordPrompt && showMasterPasswordPrompt
        ? t("formUi.passwordsPromptButton")
      : showMasterPasswordPrompt
        ? t("formUi.masterPasswordPromptButton")
      : passwordPrompt?.kind === "master-password"
        ? t("formUi.masterPasswordPromptButton")
      : t("formUi.confirmPasswordButton");

  const validateProgramDeployWalletPassword = async (state: FormState): Promise<boolean> => {
    const method = walletAuth("program-deploy");
    if (method !== "keystore" && method !== "encrypted") return true;
    const requestBody: ApiRequestBody = {};
    applyWalletAuth(requestBody, method, state, "private_key");
    const response = await apiFetch("wallet/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const data = await response.json();
    if (!response.ok) {
      showProgramDeployInlineError(data.error || t("features.program-deploy.passwordInvalid"));
      return false;
    }
    const publicKey = String(data.public_key || "").trim();
    const expectedAuthority = String(state.expectedUpgradeAuthority || "").trim();
    if (expectedAuthority && publicKey && publicKey !== expectedAuthority) {
      showProgramDeployInlineError(t("features.program-deploy.passwordWalletMismatch", {
        wallet: publicKey,
        authority: expectedAuthority,
      }));
      return false;
    }
    return true;
  };

  const validateProgramUpgradeWalletPassword = async (state: FormState): Promise<boolean> => {
    const method = walletAuth("program-upgrade");
    if (method !== "keystore" && method !== "encrypted") return true;
    const requestBody: ApiRequestBody = {};
    applyWalletAuth(requestBody, method, state, "private_key");
    const response = await apiFetch("wallet/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const data = await response.json();
    if (!response.ok) {
      showProgramUpgradeInlineError(data.error || t("features.program-upgrade.passwordInvalid"));
      return false;
    }
    const publicKey = String(data.public_key || "").trim();
    const expectedAuthority = String(
      state.expectedUpgradeAuthority ||
        savedWalletFromForm(state)?.public_key ||
        effectiveWallet?.public_key ||
        "",
    ).trim();
    if (expectedAuthority && publicKey && publicKey !== expectedAuthority) {
      showProgramUpgradeInlineError(t("features.program-upgrade.passwordWalletMismatch", {
        wallet: publicKey,
        authority: expectedAuthority,
      }));
      return false;
    }
    return true;
  };

  const validateProgramInvokeWalletPassword = async (state: FormState, formId = "program-invoke"): Promise<boolean> => {
    const method = walletAuth(formId);
    if (method !== "keystore" && method !== "encrypted") return true;
    const requestBody: ApiRequestBody = {};
    applyWalletAuth(requestBody, method, state, "private_key");
    const response = await apiFetch("wallet/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const data = await response.json();
    if (!response.ok) {
      const rawMessage = data.error || t("features.program-invoke.passwordInvalid");
      const displayMessage = programInvokeFriendlyError(rawMessage);
      setProgramInvoke((prev) => ({
        ...prev,
        result: {
          status: "password_failed",
          errorMessage: displayMessage,
          rawErrorMessage: displayMessage === rawMessage ? undefined : String(rawMessage),
          logs: [],
        },
      }));
      return false;
    }
    return true;
  };

  const verifyAndStoreBiometricWalletPassword = async (
    wallet: SavedWallet | undefined,
    password: string,
  ): Promise<boolean> => {
    if (!savePasswordToBiometric || !wallet || !supportsBiometricWallet(wallet)) return true;
    const response = await apiFetch("wallet/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet_id: wallet.id,
        password,
      }),
    });
    const data = await response.json();
    if (!response.ok || String(data.public_key || "").trim() !== wallet.public_key) {
      toast.error(data.error || t("features.biometric.passwordInvalid"));
      return false;
    }
    return storeBiometricWalletPassword(wallet, password);
  };

  const confirmPasswordPrompt = async (passwordOverride?: string) => {
    if (!passwordPrompt || passwordConfirmationInFlightRef.current) return;
    const password = passwordOverride ?? passwordPromptValue;
    const masterPassword = masterPasswordPromptValue;
    if (showWalletPasswordPrompt && password.length === 0) {
      toast.error(t("formUi.confirmPasswordRequired"));
      return;
    }
    if (showMasterPasswordPrompt && masterPassword.length === 0) {
      toast.error(t("formUi.masterPasswordRequired"));
      return;
    }
    if (showMigrationPasswords) {
      const newPasswordBytes = new TextEncoder().encode(migrationNewPassword).byteLength;
      const newPasswordScalarCount = Array.from(migrationNewPassword).length;
      if (newPasswordScalarCount < 10 || newPasswordBytes > 1024) {
        toast.error(t("features.settings.migrateNewPasswordInvalid"));
        return;
      }
      if (migrationNewPassword !== migrationConfirmPassword) {
        toast.error(t("features.settings.migratePasswordMismatch"));
        return;
      }
    }

    passwordConfirmationInFlightRef.current = true;
    setPasswordConfirmationBusy(true);
    try {
      if (passwordPrompt.kind === "form") {
        let nextFormData = walletAuthFormData({
          ...passwordPrompt.formState,
          ...(showWalletPasswordPrompt ? { password } : {}),
          ...(showMasterPasswordPrompt ? { master_password: masterPassword } : {}),
        });
        if (passwordPrompt.formId === "program-deploy") {
          nextFormData = normalizedProgramDeployFormState(nextFormData);
          const passwordOk = await validateProgramDeployWalletPassword(nextFormData);
          if (!passwordOk) {
            setPasswordPrompt(null);
            clearPasswordPromptSecrets();
            return;
          }
          setPasswordPrompt(null);
          clearPasswordPromptSecrets();
        } else if (passwordPrompt.formId === "program-upgrade") {
          const passwordOk = await validateProgramUpgradeWalletPassword(nextFormData);
          if (!passwordOk) {
            setPasswordPrompt(null);
            clearPasswordPromptSecrets();
            return;
          }
          setPasswordPrompt(null);
          clearPasswordPromptSecrets();
        } else if (isProgramInvokeForm(passwordPrompt.formId)) {
          const passwordOk = await validateProgramInvokeWalletPassword(nextFormData, passwordPrompt.formId);
          if (!passwordOk) return;
        }
        const biometricStored = await verifyAndStoreBiometricWalletPassword(
          savedWalletFromForm(nextFormData),
          password,
        );
        if (!biometricStored) return;
        await handleSubmit(passwordPrompt.formId, nextFormData);
      } else if (passwordPrompt.kind === "create-password") {
        await handleSubmit(passwordPrompt.formId, { ...passwordPrompt.formState, password });
      } else if (passwordPrompt.kind === "master-password") {
        await handleSubmit(passwordPrompt.formId, {
          ...passwordPrompt.formState,
          master_password: masterPassword,
        });
      } else if (passwordPrompt.kind === "proposal") {
        const nextFormData = walletAuthFormData({ ...passwordPrompt.formState, password });
        const biometricStored = await verifyAndStoreBiometricWalletPassword(
          savedWalletFromForm(nextFormData),
          password,
        );
        if (!biometricStored) return;
        await handleWorkspaceProposalAction(passwordPrompt.proposal, passwordPrompt.action, nextFormData);
      } else if (passwordPrompt.kind === "enable-biometric") {
        const wallet = passwordPrompt.wallet;
        const response = await apiFetch("wallet/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet_id: wallet.id,
            password,
          }),
        });
        const data = await response.json();
        if (!response.ok || String(data.public_key || "").trim() !== wallet.public_key) {
          toast.error(data.error || t("features.biometric.passwordInvalid"));
          return;
        }
        const biometricStored = await storeBiometricWalletPassword(wallet, password);
        if (!biometricStored) return;
      } else if (passwordPrompt.kind === "export-bundle") {
        await handleExportBundle(passwordPrompt.wallet, password, exportBundleSelection);
      } else if (passwordPrompt.kind === "export-keystore") {
        await handleExportKeystore(passwordPrompt.wallet, password);
      } else if (passwordPrompt.kind === "export-private-key") {
        await handleExportPrivateKey(passwordPrompt.wallet, password);
      } else if (passwordPrompt.kind === "export-mnemonic") {
        await handleExportMnemonic(passwordPrompt.wallet, password);
      } else {
        await handleMigrateKeystore(passwordPrompt.wallet, password, migrationNewPassword);
      }

      setPasswordPrompt(null);
      clearPasswordPromptSecrets();
      setFormData((prev) => {
        const next = { ...prev };
        delete next.password;
        delete next.master_password;
        return next;
      });
      setSavePasswordToBiometric(false);
    } finally {
      passwordConfirmationInFlightRef.current = false;
      setPasswordConfirmationBusy(false);
    }
  };
  confirmPasswordPromptRef.current = confirmPasswordPrompt;

  useEffect(() => {
    if (!passwordPrompt) {
      biometricPasswordPromptAttemptRef.current = "";
      return;
    }
    if (
      !passwordPromptWallet ||
      !showPasswordPromptBiometric ||
      passwordPromptIsBusy ||
      passwordPromptBiometricBusy
    ) {
      return;
    }
    const promptKind =
      passwordPrompt.kind === "form"
        ? `${passwordPrompt.kind}:${passwordPrompt.formId}`
        : passwordPrompt.kind === "proposal"
          ? `${passwordPrompt.kind}:${passwordPrompt.action}:${passwordPrompt.proposal.address}:${passwordPrompt.proposal.transactionIndex}`
          : passwordPrompt.kind;
    const attemptKey = `${promptKind}:${passwordPromptWallet.id}`;
    if (biometricPasswordPromptAttemptRef.current === attemptKey) return;
    biometricPasswordPromptAttemptRef.current = attemptKey;
    void (async () => {
      const password = await getBiometricWalletPassword(passwordPromptWallet);
      if (password) {
        await confirmPasswordPromptRef.current?.(password);
      }
    })();
  }, [
    getBiometricWalletPassword,
    passwordPrompt,
    passwordPromptBiometricBusy,
    passwordPromptIsBusy,
    passwordPromptWallet,
    showPasswordPromptBiometric,
  ]);

  const handleBack = () => {
    const target = backTarget || (selectedForm ? defaultBackTarget(selectedForm) : null);
    if (!target) return;
    clearProgramKeypairMaterial();
    if (target === "wallet-list") {
      setTokenActionContext(null);
    }
    setSelectedForm(target);
    setBackTarget(defaultBackTarget(target));
    setFormData(() => ({
      network: effectiveNetwork,
      ...defaultFormPreset(target),
      ...(authFormsWithWallets.has(target) && effectiveWalletId ? { wallet_id: effectiveWalletId } : {}),
    }));
  };

  const copyToClipboard = async (text: string, id: string) => {
    if (!text) {
      toast.error(t("errors.copyFailed"));
      return;
    }
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, text.length);
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!copied) {
          throw new Error("copy failed");
        }
      }
      setCopied(id);
      toast.success(t("common.copiedToClipboard"));
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error(t("errors.copyFailed"));
    }
  };

  const recordDownload = (item: DownloadHistoryItem) => {
    setDownloadHistory((previous) => {
      const next = [item, ...previous.filter((candidate) => candidate.path !== item.path)]
        .slice(0, MAX_DOWNLOAD_HISTORY);
      saveDownloadHistory(next);
      return next;
    });
  };

  const downloadFile = async (content: string, filename: string, type = "application/json") => {
    if (isTauriWebview()) {
      try {
        const savedPath = await invoke<string>("save_download_file", { filename, content });
        recordDownload({
          id: `${Date.now().toString(36)}:${filename}`,
          filename,
          path: savedPath,
          createdAt: Date.now(),
          type,
        });
        toast.success(t("common.downloadedTo", { path: savedPath }));
        return;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("errors.downloadFailed"));
        return;
      }
    }

    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(t("common.downloaded", { filename }));
  };

  const sensitiveExportPreviews: SensitiveExportPreview[] = [
    exportedPrivateKey
      ? {
        kind: "private-key",
        walletName: exportedPrivateKey.walletName,
        publicKey: exportedPrivateKey.publicKey,
        value: exportedPrivateKey.privateKey,
        title: t("features.settings.exportPrivateKeyQrTitle"),
        hint: t("features.settings.exportPrivateKeyQrHint"),
        warning: t("features.settings.exportPrivateKeyQrWarning"),
        qrCanvasLabel: t("features.settings.exportPrivateKeyQrCanvas"),
        plaintextLabel: t("features.settings.exportPrivateKeyPlaintextLabel"),
        temporaryHint: t("features.settings.exportPrivateKeyTemporaryHint"),
        hiddenLabel: t("features.settings.exportPrivateKeyHidden"),
        segmentsTitle: t("features.settings.exportPrivateKeySegmentsTitle"),
        segmentsHelp: t("features.settings.exportPrivateKeySegmentsHelp"),
        segmentsHint: t("features.settings.exportPrivateKeySegmentsHint"),
        copyLabel: t("features.settings.exportPrivateKeyCopy"),
        downloadLabel: t("features.settings.exportPrivateKeyDownloadPlaintext"),
        downloadSuffix: "private-key",
        copyId: "export-private-key",
        segmentCopyPrefix: "export-private-key-segment",
        qrFailedMessage: t("features.settings.exportPrivateKeyQrFailed"),
      }
      : null,
    exportedMnemonic
      ? {
          kind: "mnemonic",
          walletName: exportedMnemonic.walletName,
          publicKey: exportedMnemonic.publicKey,
          value: exportedMnemonic.mnemonic,
          title: t("features.settings.exportMnemonicQrTitle"),
          hint: t("features.settings.exportMnemonicQrHint"),
          warning: t("features.settings.exportMnemonicQrWarning"),
          qrCanvasLabel: t("features.settings.exportMnemonicQrCanvas"),
          plaintextLabel: t("features.settings.exportMnemonicPlaintextLabel"),
          temporaryHint: t("features.settings.exportMnemonicTemporaryHint"),
          hiddenLabel: t("features.settings.exportMnemonicHidden"),
          segmentsTitle: t("features.settings.exportMnemonicSegmentsTitle"),
          segmentsHelp: t("features.settings.exportMnemonicSegmentsHelp"),
          segmentsHint: t("features.settings.exportMnemonicSegmentsHint"),
          copyLabel: t("features.settings.exportMnemonicCopy"),
          downloadLabel: t("features.settings.exportMnemonicDownloadPlaintext"),
          downloadSuffix: "mnemonic",
          copyId: "export-mnemonic",
          segmentCopyPrefix: "export-mnemonic-segment",
          qrFailedMessage: t("features.settings.exportMnemonicQrFailed"),
        }
      : null,
  ].filter((preview): preview is SensitiveExportPreview => Boolean(preview));
  const sensitiveExport =
    sensitiveExportPreviews.find((preview) => preview.kind === sensitiveExportTab) ||
    sensitiveExportPreviews[0] ||
    null;
  const sensitiveExportValue = sensitiveExport?.value ?? null;

  const sensitiveExportContent = (preview: SensitiveExportPreview): string => [
    preview.kind === "mnemonic"
      ? "FnzSafe plaintext mnemonic export"
      : "FnzSafe plaintext private key export",
    `Wallet: ${preview.walletName}`,
    `Public Key: ${preview.publicKey}`,
    "",
    preview.kind === "mnemonic" ? "Mnemonic phrase:" : "Private Key (base58):",
    preview.value,
    "",
    preview.kind === "mnemonic"
      ? "Keep this file offline. Anyone with this mnemonic phrase can restore and spend assets in this wallet."
      : "Keep this file offline. Anyone with this private key can spend assets in this wallet.",
  ].join("\n");

  const clearPrivateKeyQrCanvas = useCallback(() => {
    const canvas = privateKeyQrCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const closeSensitiveExport = useCallback(() => {
    clearPrivateKeyQrCanvas();
    setExportedPrivateKey(null);
    setExportedMnemonic(null);
    setPrivateKeyExportMode("simple");
    setPrivateKeySegmentCount(DEFAULT_PRIVATE_KEY_SEGMENTS);
    setPrivateKeyQrRevealed(false);
    setSensitiveExportTab("private-key");
  }, [clearPrivateKeyQrCanvas]);

  const changePrivateKeySegmentCount = (delta: number) => {
    setPrivateKeySegmentCount((current) => clampPrivateKeySegmentCount(current + delta));
  };

  useEffect(() => {
    const canvas = privateKeyQrCanvasRef.current;
    if (!privateKeyQrRevealed) {
      clearPrivateKeyQrCanvas();
      return;
    }
    if (!canvas || !sensitiveExportValue) return;
    let cancelled = false;
    void QRCode.toCanvas(canvas, sensitiveExportValue, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: "M",
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    }).catch(() => {
      if (!cancelled) {
        toast.error(sensitiveExport?.qrFailedMessage ?? t("features.settings.exportPrivateKeyQrFailed"));
      }
    });

    return () => {
      cancelled = true;
      clearPrivateKeyQrCanvas();
    };
  }, [clearPrivateKeyQrCanvas, privateKeyQrRevealed, sensitiveExport?.qrFailedMessage, sensitiveExportValue, t]);

  const openDownloadLocation = async (path: string) => {
    try {
      await invoke("open_download_file_location", { path });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("features.settings.downloadOpenFailed"));
    }
  };

  const clearDownloadHistory = () => {
    setDownloadHistory([]);
    saveDownloadHistory([]);
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.size > MAX_KEYSTORE_FILE_BYTES) {
        toast.error(t("errors.keystoreFileTooLarge"));
        event.target.value = "";
        return;
      }
      if (file.type && file.type !== "application/json" && !file.name.toLowerCase().endsWith(".json")) {
        toast.error(t("errors.invalidKeystoreFile"));
        event.target.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setFormData((prev) => ({
          ...prev,
          keystoreJson: content,
          ...(selectedForm === "import-keystore" && !String(prev.name ?? "").trim()
            ? { name: keystoreMetadataName(content) }
            : {}),
        }));
        toast.success(t("features.import-keystore.fileUploaded"));
      };
      reader.readAsText(file);
    }
  };

  const autoLoadProgramKeypairArtifact = async (
    sourceDir: string,
    programSoName: string,
    programSoReadVersion: number,
  ) => {
    const cleanSourceDir = sourceDir.trim();
    const cleanProgramSoName = programSoName.trim();
    if (!cleanSourceDir || !cleanProgramSoName) return;
    const requestId = programKeypairArtifactRequestIdRef.current + 1;
    programKeypairArtifactRequestIdRef.current = requestId;
    try {
      const response = await apiFetch("program/keypair-artifact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_dir: cleanSourceDir,
          program_so_name: cleanProgramSoName,
          artifact_stem: cleanProgramSoName.replace(/\.so$/i, ""),
        }),
      });
      const data = (await response.json()) as ProgramKeypairArtifactResponse & { error?: string };
      if (
        requestId !== programKeypairArtifactRequestIdRef.current ||
        programSoReadVersion !== programSoReadVersionRef.current ||
        selectedForm !== "program-deploy"
      ) {
        return;
      }
      if (!response.ok) {
        throw new Error(data.error || t("features.program-deploy.programKeypairAutoLoadFailed"));
      }
      const programKeypairPath = String(data.program_keypair_path || "").trim();
      const programId = String(data.expected_program_id || "").trim();
      if (!programKeypairPath || !programId) {
        return;
      }
      programKeypairReadVersionRef.current += 1;
      programKeypairBytesRef.current?.fill(0);
      programKeypairBytesRef.current = null;
      if (programKeypairInputRef.current) {
        programKeypairInputRef.current.value = "";
      }
      setProgramKeypairMetadata({
        filename: programKeypairPath.split(/[\\/]/).pop() || programKeypairPath,
        programId,
      });
      setFormData((prev) => {
        const next: FormState = {
          ...omitFormFields(prev, PROGRAM_DEPLOY_RESULT_FIELDS),
          programKeypairPath,
          expectedProgramId: programId,
          programId,
        };
        delete next.resumeBufferAddress;
        return next;
      });
      saveWorkspaceProgram(programId);
      toast.success(t("features.program-deploy.programKeypairAutoLoaded"));
    } catch (error) {
      if (
        requestId === programKeypairArtifactRequestIdRef.current &&
        programSoReadVersion === programSoReadVersionRef.current
      ) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("features.program-deploy.programKeypairAutoLoadFailed"),
        );
      }
    }
  };

  const handleProgramFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const readVersion = programSoReadVersionRef.current + 1;
    programSoReadVersionRef.current = readVersion;
    programKeypairArtifactRequestIdRef.current += 1;
    programKeypairReadVersionRef.current += 1;
    programKeypairBytesRef.current?.fill(0);
    programKeypairBytesRef.current = null;
    if (programKeypairInputRef.current) {
      programKeypairInputRef.current.value = "";
    }
    setProgramKeypairMetadata(null);
    clearProgramDeploymentProgress();
    const sourceDirForArtifactLookup = String(formData.programSourceDir || "").trim();
    setFormData((prev) => {
      const next = omitFormFields(prev, PROGRAM_DEPLOY_RESULT_FIELDS);
      delete next.programSoBase64;
      delete next.programSoName;
      delete next.programSoSize;
      delete next.programSoSha256;
      delete next.programKeypairPath;
      delete next.expectedProgramId;
      delete next.resumeBufferAddress;
      return next;
    });
    if (file.size > MAX_PROGRAM_SO_FILE_BYTES) {
      toast.error(t("errors.programFileTooLarge"));
      input.value = "";
      return;
    }
    if (!file.name.toLowerCase().endsWith(".so")) {
      toast.error(t("errors.invalidProgramFile"));
      input.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      if (readVersion !== programSoReadVersionRef.current) return;
      const result = e.target?.result;
      if (!(result instanceof ArrayBuffer)) {
        toast.error(t("errors.invalidProgramFile"));
        return;
      }
      try {
        const programSoSha256 = await sha256Hex(result);
        if (readVersion !== programSoReadVersionRef.current) return;
        const bytes = new Uint8Array(result);
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        const programSoBase64 = btoa(binary);
        setFormData((prev) =>
          programDeployStateWithProgramSize(
            {
              ...prev,
              programSoBase64,
              programSoName: file.name,
              programSoSize: file.size,
              programSoSha256,
            },
            file.size,
          ),
        );
        binary = "";
        toast.success(t("features.program-deploy.fileUploaded"));
        void autoLoadProgramKeypairArtifact(sourceDirForArtifactLookup, file.name, readVersion);
      } catch {
        if (readVersion === programSoReadVersionRef.current) {
          input.value = "";
          toast.error(t("features.program-deploy.programHashUnavailable"));
        }
      }
    };
    reader.onerror = () => {
      if (readVersion === programSoReadVersionRef.current) {
        input.value = "";
        toast.error(t("errors.invalidProgramFile"));
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleProgramKeypairFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    clearProgramKeypairMaterial();
    clearProgramDeploymentProgress();
    if (!file) return;

    const readVersion = programKeypairReadVersionRef.current;
    if (file.size > MAX_PROGRAM_KEYPAIR_FILE_BYTES) {
      toast.error(t("features.program-deploy.programKeypairTooLarge"));
      return;
    }
    if (!file.name.toLowerCase().endsWith(".json")) {
      toast.error(t("features.program-deploy.invalidProgramKeypair"));
      return;
    }

    let fileBytes: Uint8Array | null = null;
    let contents = "";
    let keypairBytes: Uint8Array | null = null;
    try {
      fileBytes = new Uint8Array(await file.arrayBuffer());
      contents = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
      keypairBytes = parseProgramKeypairJson(contents);
      const programId = programIdFromKeypairBytes(keypairBytes);

      if (readVersion !== programKeypairReadVersionRef.current) {
        keypairBytes.fill(0);
        return;
      }

      programKeypairBytesRef.current = keypairBytes;
      keypairBytes = null;
      setProgramKeypairMetadata({ filename: file.name, programId });
      setFormData((prev) => {
        const next: FormState = {
          ...omitFormFields(prev, PROGRAM_DEPLOY_RESULT_FIELDS),
          expectedProgramId: programId,
        };
        delete next.programKeypairPath;
        delete next.resumeBufferAddress;
        return next;
      });
      toast.success(t("features.program-deploy.programKeypairLoaded"));
    } catch {
      keypairBytes?.fill(0);
      if (readVersion === programKeypairReadVersionRef.current) {
        clearProgramKeypairMaterial();
        toast.error(t("features.program-deploy.invalidProgramKeypair"));
      }
    } finally {
      fileBytes?.fill(0);
      contents = "";
    }
  };

  const handleProgramSourceImport = async (build: boolean, sourceDirOverride?: string) => {
    const sourceDir = String(sourceDirOverride || formData.programSourceDir || "").trim();
    if (!sourceDir) {
      toast.error(t("features.program-deploy.sourceDirRequired"));
      return;
    }
    if (build && !window.confirm(t("features.program-deploy.sourceBuildConfirm"))) {
      return;
    }
    setProgramSourceLoading(true);
    setProgramDeployInlineError(null);
    clearProgramDeploymentProgress();
    try {
      const response = await apiFetch("program/deploy-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
	        body: JSON.stringify({
	          source_dir: sourceDir,
	          build,
	          confirm_untrusted_build: build,
	          network: effectiveRpcRequest,
	        }),
      });
      const data = (await response.json()) as ProgramDeploySourceResponse & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || t("features.program-deploy.sourceImportError"));
      }

      const applySourceData = (nextData: ProgramDeploySourceResponse) => {
        const sourceProgramId = String(nextData.expected_program_id || "").trim();
        const sourceProgramKeypairPath = String(nextData.program_keypair_path || "").trim();
        const programId = sourceProgramId;
        const programKeypairPath = sourceProgramKeypairPath;
        const programSoBase64 = String(nextData.program_so_base64 || "").trim();
        const programSoSha256 = String(nextData.program_so_sha256 || "").trim().toLowerCase();
        const programSoSize = Number(nextData.program_so_size || 0);
        const manifestNetwork =
          nextData.manifest_network === "mainnet" ||
          nextData.manifest_network === "devnet" ||
          nextData.manifest_network === "testnet"
            ? nextData.manifest_network
            : undefined;
        const network = manifestNetwork
          ? currentNetwork(manifestNetwork)
          : currentNetwork(formData.network || effectiveNetwork);

        programSoReadVersionRef.current += 1;
        programKeypairReadVersionRef.current += 1;
        programKeypairBytesRef.current?.fill(0);
        programKeypairBytesRef.current = null;
        if (programKeypairInputRef.current) {
          programKeypairInputRef.current.value = "";
        }
        if (programId) {
          setProgramKeypairMetadata({
            filename: programKeypairPath
              ? programKeypairPath.split(/[\\/]/).pop() || programKeypairPath
              : t("features.program-deploy.importedProgramKeypair"),
            programId,
          });
        } else {
          setProgramKeypairMetadata(null);
        }
        setFormData((prev) => {
          const cleanPrevious = omitFormFields(prev, PROGRAM_DEPLOY_RESULT_FIELDS);
          return programDeployStateWithProgramSize(
            {
              ...cleanPrevious,
              programSourceDir: nextData.source_dir || sourceDir,
              network,
              programSoBase64: programSoBase64 || undefined,
              programSoName: nextData.program_so_name || nextData.program_so_path || undefined,
              programSoSize: programSoSize || undefined,
              programSoSha256: programSoSha256 || undefined,
              programKeypairPath: programKeypairPath ||
                (programId && programId === String(prev.expectedProgramId || "").trim()
                  ? String(prev.programKeypairPath || "").trim()
                  : "") ||
                undefined,
              // Keep upgrade "Program ID" / saved-contract picker in lockstep with
              // target/deploy/<name>-keypair.json. Stale workspace entries (e.g. old
              // EtKkk…) must not remain selected after a fresh source import.
              ...(programId
                ? {
                    programId,
                    expectedProgramId: programId,
                  }
                : {
                    expectedProgramId: undefined,
                  }),
              sourceBuildCommand: nextData.build_command || undefined,
              sourceBuildTemplate: nextData.build_template || undefined,
              sourceBuildStatus: nextData.build_status || undefined,
              sourceBuildStdout: nextData.build_stdout || undefined,
              sourceBuildStderr: nextData.build_stderr || undefined,
              sourceBuildError: nextData.build_error || undefined,
              sourceBuildBlockedReason: nextData.build_blocked_reason || undefined,
              sourceValidationErrors: [
                ...(Array.isArray(nextData.source_validation_errors) ? nextData.source_validation_errors : []),
              ].join("\n") || undefined,
              sourceImportWarnings: [
                ...(Array.isArray(nextData.warnings) ? nextData.warnings : []),
                ...(nextData.build_error ? [nextData.build_error] : []),
              ].join("\n") || undefined,
            },
            programSoSize,
          );
        });
        if (programId) {
          saveWorkspaceProgram(programId, undefined, network);
        }
        saveProgramProjectFromSource(nextData, {
          network,
          upgradeAuthority: String(formData.expectedUpgradeAuthority || "").trim() || undefined,
        });
      };

      applySourceData(data);
      let finalData = data;
      const buildJobId = String(data.build_job_id || "").trim();
      if (build && buildJobId && data.build_status === "running") {
        toast.success(t("features.program-deploy.sourceBuildStarted"));
        for (let attempt = 0; attempt < 900; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
          const statusResponse = await apiFetch(`program/deploy-source/build/${encodeURIComponent(buildJobId)}`, {
            method: "GET",
          });
          const statusData = (await statusResponse.json()) as ProgramDeploySourceResponse & { error?: string };
          if (!statusResponse.ok) {
            throw new Error(statusData.error || t("features.program-deploy.sourceImportError"));
          }
          applySourceData(statusData);
          finalData = statusData;
          if (statusData.build_status === "completed") break;
          if (statusData.build_status === "failed") {
            throw new Error(statusData.build_error || statusData.warnings?.[0] || t("features.program-deploy.sourceImportError"));
          }
        }
        if (finalData.build_status === "running") {
          throw new Error(t("features.program-deploy.sourceBuildTimeout"));
        }
      }

      if (Array.isArray(finalData.source_validation_errors) && finalData.source_validation_errors.length > 0) {
        showProgramDeployInlineError(finalData.source_validation_errors.join("\n"));
      } else if (Array.isArray(finalData.warnings) && finalData.warnings.length > 0) {
        toast.warning(finalData.warnings[0]);
      } else {
        toast.success(
          build
            ? t("features.program-deploy.sourceBuildSuccess")
            : t("features.program-deploy.sourceImportSuccess"),
        );
      }
    } catch (error) {
      showProgramDeployInlineError(error instanceof Error ? error.message : t("features.program-deploy.sourceImportError"));
    } finally {
      setProgramSourceLoading(false);
    }
  };

  const handleGenerateProgramKeypair = async () => {
    const sourceDir = String(formData.programSourceDir || "").trim();
    if (!sourceDir) {
      toast.error(t("features.program-deploy.sourceDirRequired"));
      return;
    }
    setProgramSourceLoading(true);
    setProgramDeployInlineError(null);
    clearProgramDeploymentProgress();
    try {
      const programSoName = String(formData.programSoName || "").trim();
      const response = await apiFetch("program/generate-keypair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_dir: sourceDir,
          program_so_name: programSoName || undefined,
          artifact_stem: programSoName ? programSoName.replace(/\.so$/i, "") : undefined,
          update_source: true,
        }),
      });
      const data = (await response.json()) as ProgramGenerateKeypairResponse & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || t("features.program-deploy.generateProgramKeypairError"));
      }
      const programKeypairPath = String(data.program_keypair_path || "").trim();
      const programId = String(data.expected_program_id || "").trim();
      programKeypairReadVersionRef.current += 1;
      programKeypairBytesRef.current?.fill(0);
      programKeypairBytesRef.current = null;
      if (programKeypairInputRef.current) {
        programKeypairInputRef.current.value = "";
      }
      setProgramKeypairMetadata({
        filename: programKeypairPath.split(/[\\/]/).pop() || programKeypairPath,
        programId,
      });
      setFormData((prev) => {
        const warnings = [
          ...(Array.isArray(data.warnings) ? data.warnings : []),
          ...(data.backup_program_keypair_path
            ? [t("features.program-deploy.generateProgramKeypairBackup", { path: data.backup_program_keypair_path })]
            : []),
          ...(Array.isArray(data.updated_source_files) && data.updated_source_files.length > 0
            ? [t("features.program-deploy.generateProgramKeypairUpdatedFiles", { count: data.updated_source_files.length })]
            : []),
        ];
        return {
          ...omitFormFields(prev, PROGRAM_DEPLOY_RESULT_FIELDS),
          programSourceDir: data.source_dir || sourceDir,
          programKeypairPath,
          expectedProgramId: programId,
          programId,
          sourceImportWarnings: warnings.join("\n") || undefined,
          sourceValidationErrors: undefined,
        };
      });
      if (programId) {
        saveWorkspaceProgram(programId);
      }
      toast.success(t("features.program-deploy.generateProgramKeypairSuccess"));
      await handleProgramSourceImport(true, data.source_dir || sourceDir);
    } catch (error) {
      showProgramDeployInlineError(
        error instanceof Error ? error.message : t("features.program-deploy.generateProgramKeypairError"),
      );
    } finally {
      setProgramSourceLoading(false);
    }
  };

  const handlePickProgramSourceDir = async () => {
    if (!isTauriWebview()) {
      toast.error(t("features.program-deploy.sourceDirPickerUnavailable"));
      return;
    }
    try {
      const selected = await invoke<string | null>("pick_source_directory");
      const sourceDir = String(selected || "").trim();
      if (sourceDir) {
        handleFormChange("programSourceDir", sourceDir);
        await handleProgramSourceImport(false, sourceDir);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("features.program-deploy.sourceDirPickerError"));
    }
  };

  const autoReadProgramProjectSource = (sourceDir: string) => {
    const trimmedSourceDir = String(sourceDir || "").trim();
    if (!trimmedSourceDir) return;
    window.setTimeout(() => {
      void handleProgramSourceImport(false, trimmedSourceDir);
    }, 0);
  };

  const handleSubmit = async (formId: string, submitFormData: FormState = formData) => {
    const formData = formId === "program-deploy"
      ? normalizedProgramDeployFormState(submitFormData)
      : submitFormData;
    const submitNetwork = () => requestNetwork(formData.network);
    setLoading(true);
    if (formId === "program-deploy") {
      setProgramDeployInlineError(null);
    }

    try {
      switch (formId) {
        case "create-plain": {
          const response = await apiFetch("keys/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: formData.name || "default" }),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.create-plain.success"));
            setFormData((prev) => {
              const next: FormState = {
                ...prev,
                publicKey: data.public_key,
              };
              delete next.secretKey;
              delete next.private_key;
              return next;
            });
          } else {
            toast.error(data.error || t("errors.createFailed"));
          }
          break;
        }

        case "create-encrypted": {
          const password = String(formData.password || "");
          if (password.length < 10 || new TextEncoder().encode(password).byteLength > 1024) {
            toast.error(t("errors.passwordLength"));
            setLoading(false);
            return;
          }

          const response = await apiFetch("keys/create-encrypted", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.create-encrypted.success"));
            setFormData((prev) => ({
              ...prev,
              publicKey: data.public_key,
              encryptedKey: data.encrypted_key,
            }));
          } else {
            toast.error(data.error || t("features.create-encrypted.encryptFailed"));
          }
          break;
        }

        case "create-keystore": {
          const password = String(formData.password || "");
          const name = String(formData.name || "").trim();
          if (!name) {
            toast.error(t("formUi.walletNameRequired"));
            setLoading(false);
            return;
          }
          if (!password || password.length < 10) {
            toast.error(t("features.create-keystore.passwordError"));
            setLoading(false);
            return;
          }

          const derivationPath = String(formData.derivationPath || "").trim();
          const response = await apiFetch("keys/create-mnemonic-keystore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              password,
              name,
              derivation_path: derivationPath || undefined,
            }),
          });
          const data = await response.json();

          if (response.ok) {
            let walletId: string | undefined;
            const saveResponse = await apiFetch("wallets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                keystore_json: data.keystore_json,
                password,
                name,
              }),
            });
            const saveData = await saveResponse.json();
            if (saveResponse.ok) {
              walletId = saveData.wallet?.id;
              if (walletId) {
                setCurrentWallet(walletId);
              }
              await loadWallets();
              toast.success(t("features.create-keystore.success"));
              const mnemonic = String(data.mnemonic || "").trim();
              if (mnemonic) {
                setPrivateKeyExportMode("simple");
                setPrivateKeySegmentCount(DEFAULT_PRIVATE_KEY_SEGMENTS);
                setPrivateKeyQrRevealed(false);
                setExportedPrivateKey(null);
                setExportedMnemonic({
                  walletName: name,
                  publicKey: data.public_key,
                  mnemonic,
                });
              }
            } else {
              toast.error(saveData.error || t("features.create-keystore.saveFailed"));
            }
            setFormData((prev) => ({
              ...prev,
              publicKey: data.public_key,
              keystoreJson: data.keystore_json,
              derivationPath: data.derivation_path || derivationPath,
              wallet_id: walletId,
              name,
            }));
          } else {
            toast.error(data.error || t("errors.createFailed"));
          }
          break;
        }

        case "import-mnemonic": {
          const password = String(formData.password || "");
          const name = String(formData.name || "").trim();
          const mnemonic = String(formData.mnemonic || "").trim();
          const derivationPath = String(formData.derivationPath || "").trim();
          if (!name) {
            toast.error(t("formUi.walletNameRequired"));
            setLoading(false);
            return;
          }
          if (!mnemonic || !password) {
            toast.error(t("features.import-mnemonic.fillAllFields"));
            setLoading(false);
            return;
          }

          const response = await apiFetch("keys/import-mnemonic-keystore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mnemonic,
              password,
              name,
              derivation_path: derivationPath || undefined,
            }),
          });
          const data = await response.json();

          if (response.ok) {
            const saveResponse = await apiFetch("wallets", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                keystore_json: data.keystore_json,
                password,
                name,
              }),
            });
            const saveData = await saveResponse.json();
            if (saveResponse.ok) {
              toast.success(t("features.import-mnemonic.success"));
              setCurrentWallet(saveData.wallet.id);
              await loadWallets();
              setFormData((prev) => {
                const next: FormState = {
                  ...prev,
                  publicKey: saveData.wallet.public_key,
                  wallet_id: saveData.wallet.id,
                  derivationPath: data.derivation_path || derivationPath,
                  name,
                };
                delete next.password;
                delete next.mnemonic;
                delete next.keystoreJson;
                delete next.secretKey;
                delete next.private_key;
                return next;
              });
            } else {
              toast.error(saveData.error || t("features.create-keystore.saveFailed"));
            }
          } else {
            toast.error(data.error || t("features.import-mnemonic.error"));
          }
          break;
        }

        case "import-keystore": {
          const password = String(formData.password || "");
          if (!formData.keystoreJson || !password) {
            toast.error(t("features.import-keystore.fillAllFields"));
            setLoading(false);
            return;
          }

          const response = await apiFetch("wallets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              keystore_json: formData.keystoreJson,
              password,
              name: formData.name || undefined,
            }),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.import-keystore.success"));
            setCurrentWallet(data.wallet.id);
            await loadWallets();
            setFormData((prev) => {
              const next: FormState = {
                ...prev,
                publicKey: data.wallet.public_key,
                wallet_id: data.wallet.id,
              };
              delete next.password;
              delete next.keystoreJson;
              delete next.secretKey;
              delete next.private_key;
              delete next.name;
              return next;
            });
          } else {
            toast.error(data.error || t("features.import-keystore.error"));
          }
          break;
        }

        case "decrypt": {
          const dm = walletAuth("decrypt");
          if (!validateWalletAuth(dm, formData, "private_key")) {
            toast.error(t("features.decrypt.fillAllFields"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {};
          applyWalletAuth(requestBody, dm, formData, "private_key");
          const response = await apiFetch("wallet/unlock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.decrypt.success"));
            setFormData((prev) => {
              const next: FormState = {
                ...prev,
                publicKey: data.public_key,
                unlocked: data.unlocked ? "true" : undefined,
              };
              delete next.secretKey;
              delete next.private_key;
              return next;
            });
          } else {
            toast.error(data.error || t("features.decrypt.error"));
          }
          break;
        }

        case "unlock": {
          const um = walletAuth("unlock");
          if (!validateWalletAuth(um, formData, "secret_key")) {
            toast.error(t("features.unlock.fillAllFields"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {};
          applyWalletAuth(requestBody, um, formData, "secret_key");
          const response = await apiFetch("wallet/unlock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.unlock.success"));
            setFormData((prev) => {
              const next: FormState = {
                ...prev,
                publicKey: data.public_key,
                unlocked: data.unlocked ? "true" : undefined,
              };
              delete next.secretKey;
              delete next.private_key;
              return next;
            });
          } else {
            toast.error(data.error || t("features.unlock.error"));
          }
          break;
        }

        case "check-balance": {
          if (!formData.address) {
            toast.error(t("features.check-balance.enterAddress"));
            setLoading(false);
            return;
          }

          const response = await apiFetch("wallet/balance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              address: formData.address,
              network: submitNetwork(),
            }),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(
              t("features.check-balance.success", {
                balance: data.balance,
                network: data.network,
              }),
            );
            setFormData((prev) => ({
              ...prev,
              balance: data.balance.toString(),
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.check-balance.error"));
          }
          break;
        }

        case "get-pubkey": {
          const method = walletAuth("get-pubkey");
          if (!validateWalletAuth(method, formData, "secret_key")) {
            toast.error(
              method === "keystore"
                ? t("features.get-pubkey.uploadKeystore")
                : method === "encrypted"
                  ? t("features.get-pubkey.enterEncrypted")
                  : t("features.get-pubkey.enterPrivateKey"),
            );
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {};
          applyWalletAuth(requestBody, method, formData, "secret_key");

          const response = await apiFetch("wallet/get-pubkey", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.get-pubkey.success"));
            setFormData((prev) => ({
              ...prev,
              publicKey: data.public_key,
            }));
          } else {
            toast.error(data.error || t("features.get-pubkey.error"));
          }
          break;
        }

        case "transfer-sol": {
          const m = walletAuth("transfer-sol");
          const amount = parsePositiveDecimal(formData.amount);
          if (!formData.to_address || amount === null) {
            toast.error(t("features.transfer-sol.fillAllFields"));
            setLoading(false);
            return;
          }
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(t("features.transfer-sol.fillAllFields"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {
            to_address: formData.to_address,
            amount,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("transfer/sol", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.transfer-sol.success", { signature: data.signature }));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            setFormData((prev) => ({
              ...prev,
              signature: data.signature,
            }));
          } else {
            toast.error(data.error || t("features.transfer-sol.error"));
          }
          break;
        }

        case "transfer-token": {
          const m = walletAuth("transfer-token");
          const amount = parsePositiveDecimal(formData.amount);
          if (!formData.to_address || !formData.mint || amount === null) {
            toast.error(t("features.transfer-token.fillAllFields"));
            setLoading(false);
            return;
          }
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(t("features.transfer-token.fillAllFields"));
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {
            to_address: formData.to_address,
            mint: formData.mint,
            amount,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("transfer/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.transfer-token.success", { signature: data.signature }));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            setFormData((prev) => ({
              ...prev,
              signature: data.signature,
            }));
          } else {
            toast.error(data.error || t("features.transfer-token.error"));
          }
          break;
        }

        case "create-wsol-ata": {
          const m = walletAuth("create-wsol-ata");
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(
              m === "keystore"
                ? t("features.create-wsol-ata.uploadKeystore")
                : m === "encrypted"
                  ? t("features.decrypt.fillAllFields")
                  : t("features.create-wsol-ata.enterPrivateKey"),
            );
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("wsol/create-ata", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.create-wsol-ata.success", { signature: data.signature }));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            setFormData((prev) => ({
              ...prev,
              signature: data.signature,
            }));
          } else {
            toast.error(data.error || t("features.create-wsol-ata.error"));
          }
          break;
        }

        case "wrap-sol": {
          const m = walletAuth("wrap-sol");
          const amount = parsePositiveDecimal(formData.amount);
          if (amount === null) {
            toast.error(t("features.wrap-sol.fillAllFields"));
            setLoading(false);
            return;
          }
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(t("features.wrap-sol.fillAllFields"));
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {
            amount,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("wsol/wrap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.wrap-sol.success", { signature: data.signature }));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            setFormData((prev) => ({
              ...prev,
              signature: data.signature,
            }));
          } else {
            toast.error(data.error || t("features.wrap-sol.error"));
          }
          break;
        }

        case "unwrap-sol": {
          const m = walletAuth("unwrap-sol");
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(
              m === "keystore"
                ? t("features.unwrap-sol.uploadKeystore")
                : m === "encrypted"
                  ? t("features.decrypt.fillAllFields")
                  : t("features.unwrap-sol.enterPrivateKey"),
            );
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("wsol/unwrap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.unwrap-sol.success", { signature: data.signature }));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            setFormData((prev) => ({
              ...prev,
              signature: data.signature,
            }));
          } else {
            toast.error(data.error || t("features.unwrap-sol.error"));
          }
          break;
        }

        case "create-nonce": {
          const m = walletAuth("create-nonce");
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(
              m === "keystore"
                ? t("features.create-nonce.uploadKeystore")
                : m === "encrypted"
                  ? t("features.decrypt.fillAllFields")
                  : t("features.create-nonce.enterPrivateKey"),
            );
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {
            network: submitNetwork(),
            count: parseNonceCount(formData.count),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("nonce/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.create-nonce.success", { count: data.count ?? 1, signature: data.signature }));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            setFormData((prev) => ({
              ...prev,
              nonceAccount: data.nonce_account,
              signature: data.signature,
            }));
            setCreatedNonceAccounts(Array.isArray(data.nonce_accounts) ? data.nonce_accounts : []);
            setNonceCreateOpen(false);
            await loadNonceAccounts(savedWalletFromForm(formData) ?? effectiveWallet, { force: true });
          } else {
            toast.error(data.error || t("features.create-nonce.error"));
          }
          break;
        }

        case "program-deploy": {
          const m = walletAuth("program-deploy");
          const validationError = programDeployValidationError(formData);
          if (validationError) {
            showProgramDeployInlineError(validationError);
            setLoading(false);
            return;
          }
          if (!validateWalletAuth(m, formData, "private_key")) {
            showProgramDeployInlineError(t("features.program-deploy.fillAllFields"));
            setLoading(false);
            return;
          }
          const deploymentIntent = programDeploymentJournalIntentFor(formData);
          if (!deploymentIntent) {
            showProgramDeployInlineError(t("features.program-deploy.journalNotReady"));
            setLoading(false);
            return;
          }
          const receiptExpectations = {
            network: deploymentIntent.network,
            genesisHash: deploymentIntent.genesisHash,
            programId: deploymentIntent.programId,
            upgradeAuthority: deploymentIntent.upgradeAuthority,
            programSha256: deploymentIntent.programSha256,
            programBytes: deploymentIntent.programLen,
          };
          const submittedWallet = savedWalletFromForm(formData) ?? effectiveWallet;

          const maxDataLen = deploymentIntent.maxDataLen;
          const programKeypairBytes = programKeypairBytesRef.current;
          const programKeypairPath = String(formData.programKeypairPath || "").trim();
          if (!programKeypairBytes && !programKeypairPath) {
            showProgramDeployInlineError(t("features.program-deploy.selectProgramKeypairFirst"));
            setLoading(false);
            return;
          }

          let serializedKeypair = "";
          if (programKeypairBytes) {
            serializedKeypair = serializeProgramKeypairJson(programKeypairBytes);
          }

          const requestBody: ApiRequestBody = {
            program_so_base64: formData.programSoBase64,
            expected_program_id: deploymentIntent.programId,
            expected_upgrade_authority: deploymentIntent.upgradeAuthority,
            expected_genesis_hash: deploymentIntent.genesisHash,
            expected_program_sha256: deploymentIntent.programSha256,
            network: deploymentIntent.requestNetwork,
            max_data_len: maxDataLen,
            resume_buffer_address: String(formData.resumeBufferAddress || "").trim() || undefined,
          };
          if (programKeypairPath) {
            requestBody.program_keypair_path = programKeypairPath;
          } else {
            requestBody.program_keypair_json = serializedKeypair;
          }
          applyWalletAuth(requestBody, m, formData, "private_key");
          const requestInit: RequestInit = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          };
          const deploymentIntentKey = programDeploymentIntentKey(deploymentIntent);
          let deploymentSucceeded = false;
          setLastProgramDeploymentIntent(deploymentIntent);
          deploymentJournalLoadedIntentKeyRef.current = deploymentIntentKey;
          setProgramDeploymentJournal((previous) =>
            previous.intentKey === deploymentIntentKey
              ? { ...previous, loading: true, error: undefined }
              : {
                  intentKey: deploymentIntentKey,
                  network: deploymentIntent.network,
                  genesisHash: deploymentIntent.genesisHash,
                  writeChunkBytes: 0,
                  writeChunkCount: 0,
                  journal: null,
                  deploymentAttempts: [],
                  conflictingJournal: null,
                  conflictingDeploymentAttempts: [],
                  loading: true,
                  error: undefined,
                },
          );
          let directDeploymentHistoryId: string | null = null;
          if (formData.programSourceDir) {
            upsertProgramProjectPlan(formData.programSourceDir, {
              kind: "direct-deploy",
              network: deploymentIntent.network,
              programId: deploymentIntent.programId,
              programSha256: deploymentIntent.programSha256,
              programBytes: deploymentIntent.programLen,
              maxDataLen: deploymentIntent.maxDataLen,
              upgradeAuthority: deploymentIntent.upgradeAuthority,
              status: "running",
            });
            directDeploymentHistoryId = upsertProgramDeploymentHistory(formData.programSourceDir, {
              kind: "direct-deploy",
              network: deploymentIntent.network,
              programId: deploymentIntent.programId,
              programSha256: deploymentIntent.programSha256,
              programBytes: deploymentIntent.programLen,
              maxDataLen: deploymentIntent.maxDataLen,
              upgradeAuthority: deploymentIntent.upgradeAuthority,
              status: "running",
            });
          }

          try {
            const response = await apiFetch("program/deploy", requestInit);
            const data = await response.json();

            if (response.ok) {
              deploymentSucceeded = true;
              setProgramDeployInlineError(null);
              const deploymentReceiptJson = buildProgramDeploymentReceiptJson(
                data,
                receiptExpectations,
              );
              const deploymentReceiptSha256 = await sha256Hex(
                new TextEncoder().encode(deploymentReceiptJson),
              );
              const deploymentResult: ProgramDeploymentResult = {
                programId: String(data.program_id || deploymentIntent.programId),
                programdataAddress: String(data.programdata_address || "") || undefined,
                bufferAddress: String(data.buffer_address || "") || undefined,
                authority: String(data.authority || deploymentIntent.upgradeAuthority) || undefined,
                deploySignature: typeof data.deploy_signature === "string" ? data.deploy_signature : null,
                createBufferSignature: typeof data.create_buffer_signature === "string" ? data.create_buffer_signature : null,
                writeCount: Array.isArray(data.write_signatures) ? data.write_signatures.length : 0,
                skippedWriteCount: Number(data.skipped_write_chunks || 0),
                rentLamports: Number(data.rent_lamports || 0),
                estimatedFeesLamports: Number(data.estimated_transaction_fees_lamports || 0),
                feeRateReserveLamports: Number(data.fee_rate_reserve_lamports || 0),
                recoveryWriteReserveLamports: Number(data.recovery_write_reserve_lamports || 0),
                totalFeeBudgetLamports: Number(data.total_fee_budget_lamports || 0),
                estimatedRequiredBalanceLamports: Number(data.estimated_required_balance_lamports || 0),
                programBytes: Number(data.program_bytes || deploymentIntent.programLen),
                programSha256: String(data.program_sha256 || deploymentIntent.programSha256),
                genesisHash: String(data.genesis_hash || deploymentIntent.genesisHash),
                deployedSlot: data.deployed_slot === undefined ? undefined : Number(data.deployed_slot),
                finalizedSlot: data.finalized_slot === undefined ? undefined : Number(data.finalized_slot),
                readbackVerified: data.readback_verified === true,
                receiptJson: deploymentReceiptJson,
                receiptSha256: deploymentReceiptSha256,
                network: currentNetwork(data.network || deploymentIntent.network),
                completedAt: Date.now(),
              };
              toast.success(t("features.program-deploy.success"));
              refreshWalletAfterMutation(submittedWallet);
              saveWorkspaceProgram(data.program_id);
              if (formData.programSourceDir) {
                upsertProgramProjectPlan(formData.programSourceDir, {
                  kind: "direct-deploy",
                  network: deploymentIntent.network,
                  programId: deploymentIntent.programId,
                  programSha256: deploymentIntent.programSha256,
                  programBytes: deploymentIntent.programLen,
                  maxDataLen: deploymentIntent.maxDataLen,
                  upgradeAuthority: deploymentIntent.upgradeAuthority,
                  bufferAddress: data.buffer_address,
                  result: deploymentResult,
                  status: "finalized",
                });
                upsertProgramDeploymentHistory(formData.programSourceDir, {
                  id: directDeploymentHistoryId || undefined,
                  kind: "direct-deploy",
                  network: deploymentResult.network,
                  programId: deploymentResult.programId,
                  programdataAddress: deploymentResult.programdataAddress,
                  programSha256: deploymentResult.programSha256,
                  programBytes: deploymentResult.programBytes,
                  maxDataLen: deploymentIntent.maxDataLen,
                  upgradeAuthority: deploymentResult.authority,
                  bufferAddress: deploymentResult.bufferAddress,
                  deploySignature: deploymentResult.deploySignature,
                  createBufferSignature: deploymentResult.createBufferSignature,
                  receiptJson: deploymentResult.receiptJson,
                  receiptSha256: deploymentResult.receiptSha256,
                  deployedSlot: deploymentResult.deployedSlot,
                  finalizedSlot: deploymentResult.finalizedSlot,
                  readbackVerified: deploymentResult.readbackVerified,
                  status: "finalized",
                  completedAt: deploymentResult.completedAt,
                });
              }
              setFormData({
                wallet_id: formData.wallet_id,
                programId: data.program_id,
                programdataAddress: data.programdata_address,
                bufferAddress: data.buffer_address,
                authority: data.authority,
                signature: data.deploy_signature,
                writeCount: String(Array.isArray(data.write_signatures) ? data.write_signatures.length : 0),
                skippedWriteCount: String(data.skipped_write_chunks || 0),
                rentLamports: String(data.rent_lamports),
                estimatedFeesLamports: String(data.estimated_transaction_fees_lamports || 0),
                feeRateReserveLamports: String(data.fee_rate_reserve_lamports || 0),
                recoveryWriteReserveLamports: String(data.recovery_write_reserve_lamports || 0),
                totalFeeBudgetLamports: String(data.total_fee_budget_lamports || 0),
                estimatedRequiredBalanceLamports: String(data.estimated_required_balance_lamports || 0),
                createBufferSignature: data.create_buffer_signature,
                programBytes: String(data.program_bytes),
                programSha256: data.program_sha256,
                genesisHash: data.genesis_hash,
                deployedSlot: data.deployed_slot === undefined ? undefined : String(data.deployed_slot),
                finalizedSlot: data.finalized_slot === undefined ? undefined : String(data.finalized_slot),
                readbackVerified: data.readback_verified === true
                  ? t("features.program-deploy.readbackPassed")
                  : t("features.program-deploy.readbackFailed"),
                deploymentReceiptJson,
                deploymentReceiptSha256,
                network: data.network,
              });
            } else {
              if (formData.programSourceDir) {
                upsertProgramProjectPlan(formData.programSourceDir, {
                  kind: "direct-deploy",
                  network: deploymentIntent.network,
                  programId: deploymentIntent.programId,
                  programSha256: deploymentIntent.programSha256,
                  programBytes: deploymentIntent.programLen,
                  maxDataLen: deploymentIntent.maxDataLen,
                  upgradeAuthority: deploymentIntent.upgradeAuthority,
                  status: "failed",
                });
                upsertProgramDeploymentHistory(formData.programSourceDir, {
                  id: directDeploymentHistoryId || undefined,
                  kind: "direct-deploy",
                  network: deploymentIntent.network,
                  programId: deploymentIntent.programId,
                  programSha256: deploymentIntent.programSha256,
                  programBytes: deploymentIntent.programLen,
                  maxDataLen: deploymentIntent.maxDataLen,
                  upgradeAuthority: deploymentIntent.upgradeAuthority,
                  status: "failed",
                  completedAt: Date.now(),
                });
              }
              setProgramDeploymentJournal((previous) =>
                previous.intentKey === deploymentIntentKey
                  ? {
                      ...previous,
                      loading: false,
                      error: data.error || t("features.program-deploy.error"),
                    }
                  : previous,
              );
              showProgramDeployInlineError(data.error || t("features.program-deploy.error"));
            }
          } catch (error) {
            const message = error instanceof Error
              ? error.message
              : t("features.program-deploy.error");
            if (formData.programSourceDir) {
              upsertProgramProjectPlan(formData.programSourceDir, {
                kind: "direct-deploy",
                network: deploymentIntent.network,
                programId: deploymentIntent.programId,
                programSha256: deploymentIntent.programSha256,
                programBytes: deploymentIntent.programLen,
                maxDataLen: deploymentIntent.maxDataLen,
                upgradeAuthority: deploymentIntent.upgradeAuthority,
                status: "failed",
              });
              upsertProgramDeploymentHistory(formData.programSourceDir, {
                id: directDeploymentHistoryId || undefined,
                kind: "direct-deploy",
                network: deploymentIntent.network,
                programId: deploymentIntent.programId,
                programSha256: deploymentIntent.programSha256,
                programBytes: deploymentIntent.programLen,
                maxDataLen: deploymentIntent.maxDataLen,
                upgradeAuthority: deploymentIntent.upgradeAuthority,
                status: "failed",
                completedAt: Date.now(),
              });
            }
            setProgramDeploymentJournal((previous) =>
              previous.intentKey === deploymentIntentKey
                ? {
                    ...previous,
                    loading: false,
                    error: message,
                  }
                : previous,
            );
            showProgramDeployInlineError(message);
          } finally {
            requestBody.program_keypair_json = "";
            requestBody.program_keypair_path = "";
            requestInit.body = null;
            serializedKeypair = "";
            if (deploymentSucceeded && !programKeypairPath) {
              clearProgramKeypairMaterial();
            }
          }
          break;
        }

        case "program-invoke":
        case "program-invoke-standalone": {
          const m = walletAuth(formId);
          if (!validateWalletAuth(m, formData, "private_key")) {
            const rawMessage = t("features.program-invoke.fillAllFields");
            const message = programInvokeFriendlyError(rawMessage);
            setProgramInvoke((prev) => ({
              ...prev,
              result: {
                status: "validation_failed",
                errorMessage: message,
                rawErrorMessage: message === rawMessage ? undefined : rawMessage,
                logs: [],
              },
            }));
            setLoading(false);
            return;
          }
          const instruction = programInvoke.idl?.instructions.find(
            (item) => item.name === programInvoke.selectedInstruction,
          );
          if (!instruction) {
            const rawMessage = t("features.program-invoke.noInstruction");
            const message = programInvokeFriendlyError(rawMessage);
            setProgramInvoke((prev) => ({
              ...prev,
              result: {
                status: "validation_failed",
                errorMessage: message,
                rawErrorMessage: message === rawMessage ? undefined : rawMessage,
                logs: [],
              },
            }));
            setLoading(false);
            return;
          }

          let encoded;
          try {
            const encodedArgValues = await programInvokeDisplayArgsToRaw(
              instruction,
              programInvoke.argValues,
              programInvoke.accountValues,
            );
            encoded = await encodeAnchorInstruction(
              programInvoke.programId,
              instruction,
              encodedArgValues,
              programInvoke.accountValues,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            const rawDisplayMessage = message.startsWith("invalid-account:")
              ? t("features.program-invoke.accountInvalid", { account: message.replace("invalid-account:", "") })
              : message || t("features.program-invoke.encodeFailed");
            const displayMessage = programInvokeFriendlyError(rawDisplayMessage);
            setProgramInvoke((prev) => ({
              ...prev,
              result: {
                status: "encode_failed",
                errorMessage: displayMessage,
                rawErrorMessage: displayMessage === rawDisplayMessage ? undefined : rawDisplayMessage,
                logs: [],
              },
            }));
            setLoading(false);
            return;
          }

          const mode = String(formData.programInvokeMode || "simulate") === "send" ? "send" : "simulate";
          const additionalSigners = flattenAnchorAccounts(instruction.accounts)
            .filter((account) => {
              const pubkey = resolveAnchorAccountAddress(String(programInvoke.accountValues[account.path] || ""), account);
              return account.isSigner && pubkey && pubkey !== String(savedWalletFromForm(formData)?.public_key || effectiveWallet?.public_key || "").trim();
            })
            .map((account) => ({
              pubkey: resolveAnchorAccountAddress(String(programInvoke.accountValues[account.path] || ""), account),
              wallet_id: String(programInvoke.signerWalletIds[account.path] || "").trim(),
              password: String(programInvoke.signerPasswords[account.path] || ""),
            }));
          const requestBody: Record<string, unknown> = {
            program_id: encoded.programId,
            instruction_name: instruction.name,
            accounts: encoded.accounts,
            data_base64: encoded.dataBase64,
            network: submitNetwork(),
            mode,
            additional_signers: additionalSigners,
          };
          applyWalletAuth(requestBody as ApiRequestBody, m, formData, "private_key");
          const response = await apiFetch("program/invoke", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          const logs = Array.isArray(data.logs) ? data.logs.map((line: unknown) => String(line)) : [];
          const rawErrorMessage = response.ok
            ? undefined
            : typeof data.error === "string" && data.error.trim()
              ? data.error.trim()
              : t("features.program-invoke.error");
          const rawSimulationError =
            typeof data.simulation_error === "string" && data.simulation_error.trim()
              ? data.simulation_error.trim()
              : undefined;
          const errorMessage = rawErrorMessage
            ? programInvokeFriendlyError(rawErrorMessage, logs)
            : undefined;
          const simulationError = rawSimulationError
            ? programInvokeFriendlyError(rawSimulationError, logs)
            : undefined;
          const result = {
            status: String(data.status || ""),
            signature: typeof data.signature === "string" ? data.signature : undefined,
            simulationError,
            rawSimulationError: rawSimulationError && rawSimulationError !== simulationError
              ? rawSimulationError
              : undefined,
            errorMessage,
            rawErrorMessage: rawErrorMessage && rawErrorMessage !== errorMessage
              ? rawErrorMessage
              : undefined,
            logs,
          };
          setProgramInvoke((prev) => ({ ...prev, result }));
          if (response.ok) {
            if (mode === "send") {
              toast.success(t("features.program-invoke.sendSucceeded"));
              refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            } else if (result.simulationError) {
              // The inline warning panel and terminal log carry the details.
            } else {
              toast.success(t("features.program-invoke.simulationSucceeded"));
            }
          }
          setProgramInvoke((prev) => ({ ...prev, signerPasswords: {} }));
          break;
        }

        case "external-sign": {
          const m = walletAuth("external-sign");
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(t("features.external-sign.fillAllFields"));
            setLoading(false);
            return;
          }
          const instructionRequest = parseExternalSignInstructionRequest(String(formData.externalSignRequestJson || ""));
          const transactionBase64 = String(formData.transactionBase64 || "").trim();
          if (!transactionBase64 && instructionRequest) {
            const requestBody: Record<string, unknown> = {
              program_id: instructionRequest.programId,
              instruction_name: instructionRequest.instructionName,
              accounts: instructionRequest.accounts,
              data_base64: instructionRequest.dataBase64,
              network: requestNetwork(instructionRequest.network || formData.network),
              mode: "send",
              additional_signers: [],
            };
            applyWalletAuth(requestBody as ApiRequestBody, m, formData, "private_key");
            const response = await apiFetch("program/invoke", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(requestBody),
            });
            const data = await response.json();
            if (response.ok) {
              const signature = String(data.signature || "").trim();
              toast.success(t("features.external-sign.success"));
              setFormData((prev) => ({
                ...prev,
                status: data.status,
                signature,
                signedBy: instructionRequest.requiredSigner || String(formData.requiredSigner || "").trim(),
                externalSignNetwork: requestNetwork(instructionRequest.network || formData.network),
                requestId: instructionRequest.requestId || String(formData.requestId || "").trim(),
                externalSignBackfillJson: JSON.stringify({
                  signature,
                  programId: instructionRequest.programId,
                  instructionName: instructionRequest.instructionName,
                  dataBase64: instructionRequest.dataBase64,
                }, null, 2),
              }));
              refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            } else {
              toast.error(data.error || t("features.external-sign.error"));
            }
            break;
          }
          const requestBody: ApiRequestBody = {
            required_signer: String(formData.requiredSigner || "").trim(),
            transaction_base64: transactionBase64,
            network: submitNetwork(),
          };
          const requestId = String(formData.requestId || "").trim();
          const expiresAt = String(formData.expiresAt || "").trim();
          const expectedGenesisHash = String(formData.expectedGenesisHash || "").trim();
          const recentBlockhash = String(formData.recentBlockhash || "").trim();
          const lastValidBlockHeight = String(formData.lastValidBlockHeight || "").trim();
          if (requestId) requestBody.request_id = requestId;
          if (expiresAt) requestBody.expires_at = Number(expiresAt);
          if (expectedGenesisHash) requestBody.expected_genesis_hash = expectedGenesisHash;
          if (recentBlockhash) requestBody.recent_blockhash = recentBlockhash;
          if (lastValidBlockHeight) requestBody.last_valid_block_height = Number(lastValidBlockHeight);
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("external-sign/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.external-sign.success"));
            const backfillPayload = {
              signature: String(data.signature || "").trim(),
              rawTransaction: String(data.raw_transaction || data.rawTransaction || "").trim(),
              recentBlockhash: String(data.recent_blockhash || data.recentBlockhash || "").trim(),
              lastValidBlockHeight: Number(data.last_valid_block_height ?? data.lastValidBlockHeight ?? 0),
            };
            setFormData((prev) => ({
              ...prev,
              status: data.status,
              signature: data.signature,
              externalSignSlot: data.slot,
              signedBy: data.signed_by,
              externalSignNetwork: data.network,
              requestId: data.request_id || requestId,
              externalSignBackfillJson: JSON.stringify(backfillPayload, null, 2),
            }));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
          } else {
            toast.error(data.error || t("features.external-sign.error"));
          }
          break;
        }

        case "program-info": {
          if (!formData.programId) {
            toast.error(t("features.program-info.enterProgramId"));
            setLoading(false);
            return;
          }

          const response = await apiFetch("program/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              program_id: formData.programId,
              network: submitNetwork(),
            }),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.program-info.success"));
            if (data.exists) {
              saveWorkspaceProgram(data.program_id);
            }
            setFormData((prev) => ({
              ...prev,
              programId: data.program_id,
              programdataAddress: data.programdata_address,
              executable: data.executable ? "true" : "false",
              programExists: data.exists ? "true" : "false",
              programInfoChecked: "true",
              owner: data.owner,
              lamports: String(data.lamports),
              dataLen: String(data.data_len),
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.program-info.error"));
          }
          break;
        }

        case "squads-create": {
          const m = walletAuth("squads-create");
          const members = parseAddressList(formData.members);
          const threshold = parseInt(String(formData.threshold || ""), 10);
          const signer = String(effectiveWallet?.public_key ?? "").trim();
          const timeLock =
            formData.time_lock === undefined || formData.time_lock === ""
              ? undefined
              : parseInt(String(formData.time_lock), 10);
          if (!validateWalletAuth(m, formData, "private_key") || members.length === 0 || !Number.isInteger(threshold)) {
            toast.error(t("features.squads-create.fillAllFields"));
            setLoading(false);
            return;
          }
          if (threshold <= 0 || threshold > members.length) {
            toast.error(t("features.squads-create.invalidThreshold"));
            setLoading(false);
            return;
          }
          if (signer && !members.includes(signer)) {
            toast.error(t("features.squads-create.signerMustBeMember"));
            setLoading(false);
            return;
          }
          if (timeLock !== undefined && (!Number.isInteger(timeLock) || timeLock < 0)) {
            toast.error(t("features.squads-create.invalidTimeLock"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {
            members: members.join(","),
            threshold,
            time_lock: timeLock,
            memo: formData.memo,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");
          const actor = walletActor(m === "keystore" ? selectedSavedWallet() : undefined);
          const response = await apiFetch("squads/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...requestBody, members }),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.squads-create.success"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            saveWorkspaceMultisig(data.multisig, data.vault, undefined, undefined, actor);
            setFormData((prev) => ({
              ...prev,
              multisig: data.multisig,
              vault: data.vault,
              createKey: data.create_key,
              signature: data.signature,
              creationFeeLamports: String(data.creation_fee_lamports),
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.squads-create.error"));
          }
          break;
        }

        case "squads-info": {
          if (!formData.multisig) {
            toast.error(t("features.squads-info.enterMultisig"));
            setLoading(false);
            return;
          }
          const response = await apiFetch("squads/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              multisig: formData.multisig,
              proposal: formData.proposal || undefined,
              network: submitNetwork(),
            }),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.squads-info.success"));
            saveWorkspaceMultisig(data.multisig, data.vault);
            if (data.proposal?.address) {
              saveWorkspaceProposal(
                data.proposal.address,
                data.multisig,
                data.proposal.transaction_index,
                undefined,
                data.proposal.status,
              );
            }
            setFormData((prev) => ({
              ...prev,
              multisig: data.multisig,
              vault: data.vault,
              createKey: data.create_key,
              threshold: String(data.threshold),
              transactionIndex: String(data.transaction_index),
              membersText: Array.isArray(data.members)
                ? data.members.map((member: { key: string }) => member.key).join("\n")
                : "",
              proposalStatus: data.proposal?.status,
              proposalTxIndex: data.proposal ? String(data.proposal.transaction_index) : undefined,
              approvedText: Array.isArray(data.proposal?.approved) ? data.proposal.approved.join("\n") : undefined,
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.squads-info.error"));
          }
          break;
        }

        case "squads-sol-transfer": {
          const m = walletAuth("squads-sol-transfer");
          const amount = parsePositiveDecimal(formData.amount);
          if (!validateWalletAuth(m, formData, "private_key") || !formData.multisig || !formData.to_address || amount === null) {
            toast.error(t("features.squads-sol-transfer.fillAllFields"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {
            multisig: formData.multisig,
            to_address: formData.to_address,
            amount,
            memo: formData.memo,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");
          const actor = walletActor(m === "keystore" ? selectedSavedWallet() : undefined);
          const response = await apiFetch("squads/proposal/sol-transfer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.squads-sol-transfer.success"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            saveWorkspaceMultisig(formData.multisig, data.vault);
            saveWorkspaceProposal(
              data.proposal,
              formData.multisig,
              data.transaction_index,
              "sol-transfer",
              "active",
              undefined,
              actor,
            );
            setFormData((prev) => ({
              ...prev,
              vault: data.vault,
              transaction: data.transaction,
              proposal: data.proposal,
              transactionIndex: String(data.transaction_index),
              signature: data.signature,
              transactionKind: "sol-transfer",
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.squads-sol-transfer.error"));
          }
          break;
        }

        case "squads-token-transfer": {
          const m = walletAuth("squads-token-transfer");
          const amount = parsePositiveDecimal(formData.amount);
          if (
            !validateWalletAuth(m, formData, "private_key") ||
            !formData.multisig ||
            !formData.mint ||
            !formData.recipient ||
            amount === null
          ) {
            toast.error(t("features.squads-token-transfer.fillAllFields"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {
            multisig: formData.multisig,
            mint: formData.mint,
            recipient: formData.recipient,
            amount,
            memo: formData.memo,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");
          const actor = walletActor(m === "keystore" ? selectedSavedWallet() : undefined);
          const response = await apiFetch("squads/proposal/token-transfer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.squads-token-transfer.success"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            saveWorkspaceMultisig(formData.multisig, data.vault);
            saveWorkspaceProposal(
              data.proposal,
              formData.multisig,
              data.transaction_index,
              "token-transfer",
              "active",
              undefined,
              actor,
            );
            setFormData((prev) => ({
              ...prev,
              vault: data.vault,
              transaction: data.transaction,
              proposal: data.proposal,
              transactionIndex: String(data.transaction_index),
              signature: data.signature,
              transactionKind: "token-transfer",
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.squads-token-transfer.error"));
          }
          break;
        }

        case "program-upgrade": {
          const m = walletAuth("program-upgrade");
          const programId = String(formData.programId || formData.expectedProgramId || "").trim();
          const programSha256 = String(formData.programSoSha256 || "").trim().toLowerCase();
          const upgradeAuthority =
            String(
              savedWalletFromForm(formData)?.public_key ||
                formData.expectedUpgradeAuthority ||
                effectiveWallet?.public_key ||
                "",
            ).trim();
          if (
            !validateWalletAuth(m, formData, "private_key") ||
            !programId ||
            !isLikelySolanaPublicKey(programId) ||
            !formData.programSoBase64 ||
            !programSha256 ||
            !upgradeAuthority
          ) {
            showProgramUpgradeInlineError(t("features.program-upgrade.fillAllFields"));
            setLoading(false);
            return;
          }
          const upgradeSourceDir = String(formData.programSourceDir || "").trim();
          const projectForUpgrade = upgradeSourceDir
            ? workspace.programProjects.find((item) => item.id === scopedProgramProjectId(upgradeSourceDir))
            : workspace.programProjects.find((item) => String(item.programId || "").trim() === programId);
          if (isStaleProgramUpgradeArtifact(projectForUpgrade, programId, programSha256)) {
            showProgramUpgradeInlineError(t("features.program-upgrade.staleArtifactBlocked"));
            setLoading(false);
            return;
          }
          const requestNetwork = submitNetwork();
          const network = currentNetwork(requestNetwork);
          const expectedGenesisHash = expectedGenesisHashFor({
            ...formData,
            network,
          });
          const requestBody: ApiRequestBody = {
            program_id: programId,
            expected_upgrade_authority: upgradeAuthority,
            expected_genesis_hash: expectedGenesisHash,
            expected_program_sha256: programSha256,
            program_so_base64: formData.programSoBase64,
            network: requestNetwork,
            spill_address: String(formData.spillAddress || "").trim() || undefined,
          };
          applyWalletAuth(requestBody, m, formData, "private_key");
          setProgramUpgradeInlineError(null);
          const estimatedWriteChunks = Math.max(
            1,
            Math.ceil((Number(formData.programSoSize || 0) || 0) / FALLBACK_PROGRAM_WRITE_CHUNK_BYTES),
          );
          setProgramUpgradeProgress({
            active: true,
            program_id: programId,
            network,
            stage: "preparing",
            message: t("features.program-upgrade.upgradeStarted", {
              writes: estimatedWriteChunks,
              bytes: Number(formData.programSoSize || 0) || 0,
            }),
            write_completed: 0,
            write_total: estimatedWriteChunks,
            program_bytes: Number(formData.programSoSize || 0) || 0,
            buffer_address: null,
            last_signature: null,
            error: null,
            updated_at_ms: Date.now(),
          });
          setFormData((prev) => ({
            ...prev,
            message: t("features.program-upgrade.upgradeStarted", {
              writes: estimatedWriteChunks,
              bytes: Number(formData.programSoSize || 0) || 0,
            }),
            signature: undefined,
          }));
          if (formData.programSourceDir) {
            upsertProgramProjectPlan(formData.programSourceDir, {
              kind: "direct-upgrade",
              network,
              programId,
              programSha256,
              programBytes: Number(formData.programSoSize || 0) || undefined,
              upgradeAuthority,
              status: "running",
            });
            upsertProgramDeploymentHistory(formData.programSourceDir, {
              kind: "direct-upgrade",
              network,
              programId,
              programSha256,
              programBytes: Number(formData.programSoSize || 0) || undefined,
              upgradeAuthority,
              status: "running",
            });
          }
          const response = await apiFetch("program/upgrade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            setProgramUpgradeInlineError(null);
            setProgramUpgradeProgress({
              active: false,
              program_id: data.program_id || programId,
              network: currentNetwork(data.network || network),
              stage: "finalized",
              message: t("features.program-upgrade.success"),
              write_completed: Array.isArray(data.write_signatures) ? data.write_signatures.length : 0,
              write_total: Array.isArray(data.write_signatures) ? data.write_signatures.length : 0,
              program_bytes: Number(data.program_bytes || formData.programSoSize || 0) || 0,
              buffer_address: data.buffer_address ?? null,
              last_signature: data.upgrade_signature ?? null,
              error: null,
              updated_at_ms: Date.now(),
            });
            toast.success(t("features.program-upgrade.success"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            if (formData.programSourceDir) {
              upsertProgramProjectPlan(formData.programSourceDir, {
                kind: "direct-upgrade",
                network: currentNetwork(data.network || network),
                programId: data.program_id || programId,
                programSha256: data.program_sha256 || programSha256,
                programBytes: Number(data.program_bytes || formData.programSoSize || 0) || undefined,
                upgradeAuthority: data.authority || upgradeAuthority,
                bufferAddress: data.buffer_address,
                status: "finalized",
                result: {
                  programId: data.program_id || programId,
                  programdataAddress: data.programdata_address,
                  bufferAddress: data.buffer_address,
                  authority: data.authority,
                  deploySignature: data.upgrade_signature,
                  createBufferSignature: data.create_buffer_signature,
                  writeCount: Array.isArray(data.write_signatures) ? data.write_signatures.length : undefined,
                  rentLamports: Number(data.rent_lamports || 0) || undefined,
                  programBytes: Number(data.program_bytes || 0) || undefined,
                  programSha256: data.program_sha256 || programSha256,
                  genesisHash: data.genesis_hash,
                  deployedSlot: Number(data.deployed_slot || 0) || undefined,
                  readbackVerified: Boolean(data.readback_verified),
                  network: currentNetwork(data.network || network),
                  completedAt: Date.now(),
                },
              });
              upsertProgramDeploymentHistory(formData.programSourceDir, {
                kind: "direct-upgrade",
                network: currentNetwork(data.network || network),
                programId: data.program_id || programId,
                programdataAddress: data.programdata_address,
                programSha256: data.program_sha256 || programSha256,
                programBytes: Number(data.program_bytes || formData.programSoSize || 0) || undefined,
                upgradeAuthority: data.authority || upgradeAuthority,
                bufferAddress: data.buffer_address,
                createBufferSignature: data.create_buffer_signature,
                deploySignature: data.upgrade_signature,
                signature: data.upgrade_signature,
                deployedSlot: Number(data.deployed_slot || 0) || undefined,
                readbackVerified: Boolean(data.readback_verified),
                status: "finalized",
                completedAt: Date.now(),
              });
            }
            setFormData((prev) => ({
              ...prev,
              signature: data.upgrade_signature,
              programId: data.program_id || programId,
              bufferAddress: data.buffer_address,
              message: t("features.program-upgrade.stats", {
                writes: Array.isArray(data.write_signatures) ? data.write_signatures.length : 0,
                bytes: data.program_bytes || 0,
                rent: data.rent_lamports || 0,
              }),
            }));
          } else {
            if (formData.programSourceDir) {
              upsertProgramDeploymentHistory(formData.programSourceDir, {
                kind: "direct-upgrade",
                network,
                programId,
                programSha256,
                programBytes: Number(formData.programSoSize || 0) || undefined,
                upgradeAuthority,
                status: "failed",
              });
            }
            setFormData((prev) => ({
              ...prev,
              message: undefined,
              signature: undefined,
            }));
            setProgramUpgradeProgress((prev) =>
              prev
                ? {
                    ...prev,
                    active: false,
                    stage: "failed",
                    message: String(data.error || t("features.program-upgrade.error")),
                    error: String(data.error || t("features.program-upgrade.error")),
                    updated_at_ms: Date.now(),
                  }
                : prev,
            );
            showProgramUpgradeInlineError(data.error || t("features.program-upgrade.error"));
          }
          break;
        }

        case "squads-prepare-upgrade-buffer": {
          const m = walletAuth("squads-prepare-upgrade-buffer");
          if (!validateWalletAuth(m, formData, "private_key") || !formData.multisig || !formData.programSoBase64) {
            toast.error(t("features.squads-prepare-upgrade-buffer.fillAllFields"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {
            multisig: formData.multisig,
            program_so_base64: formData.programSoBase64,
            expected_program_id: formData.programId,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");
          const response = await apiFetch("squads/program/prepare-upgrade-buffer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.squads-prepare-upgrade-buffer.success"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            saveWorkspaceMultisig(data.multisig, data.vault);
            if (formData.programSourceDir) {
              upsertProgramProjectPlan(formData.programSourceDir, {
                kind: "squads-upgrade",
                network: currentNetwork(data.network),
                programId: String(formData.expectedProgramId || formData.programId || "").trim() || undefined,
                programSha256: String(formData.programSoSha256 || "").trim().toLowerCase() || undefined,
                programBytes: Number(data.program_bytes || formData.programSoSize || 0) || undefined,
                multisig: data.multisig,
                vault: data.vault,
                bufferAddress: data.buffer_address,
                status: "buffer-ready",
              });
              upsertProgramDeploymentHistory(formData.programSourceDir, {
                kind: "squads-upgrade-buffer",
                network: currentNetwork(data.network),
                programId: String(formData.expectedProgramId || formData.programId || "").trim() || undefined,
                programSha256: String(formData.programSoSha256 || "").trim().toLowerCase() || undefined,
                programBytes: Number(data.program_bytes || formData.programSoSize || 0) || undefined,
                multisig: data.multisig,
                vault: data.vault,
                bufferAddress: data.buffer_address,
                createBufferSignature: data.create_signature,
                authoritySignature: data.authority_signature,
                status: "buffer-ready",
                completedAt: Date.now(),
              });
            }
            setFormData((prev) => ({
              ...prev,
              multisig: data.multisig,
              vault: data.vault,
              bufferAddress: data.buffer_address,
              signature: undefined,
              createSignature: data.create_signature,
              authoritySignature: data.authority_signature,
              writeCount: String(Array.isArray(data.write_signatures) ? data.write_signatures.length : 0),
              rentLamports: String(data.rent_lamports),
              programBytes: String(data.program_bytes),
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.squads-prepare-upgrade-buffer.error"));
          }
          break;
        }

        case "squads-program-upgrade": {
          const m = walletAuth("squads-program-upgrade");
          if (!validateWalletAuth(m, formData, "private_key") || !formData.multisig || !formData.programId || !formData.bufferAddress) {
            toast.error(t("features.squads-program-upgrade.fillAllFields"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {
            multisig: formData.multisig,
            program_id: formData.programId,
            buffer_address: formData.bufferAddress,
            spill_address: formData.spillAddress,
            memo: formData.memo,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");
          const actor = walletActor(m === "keystore" ? selectedSavedWallet() : undefined);
          const response = await apiFetch("squads/proposal/program-upgrade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.squads-program-upgrade.success"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            saveWorkspaceMultisig(formData.multisig, data.vault);
            saveWorkspaceProgram(formData.programId);
            if (formData.programSourceDir) {
              upsertProgramProjectPlan(formData.programSourceDir, {
                kind: "squads-upgrade",
                network: currentNetwork(data.network),
                programId: String(formData.programId || "").trim(),
                programSha256: String(formData.programSoSha256 || "").trim().toLowerCase() || undefined,
                programBytes: Number(formData.programSoSize || 0) || undefined,
                multisig: String(formData.multisig || "").trim(),
                vault: data.vault,
                bufferAddress: String(formData.bufferAddress || "").trim(),
                proposal: data.proposal,
                transactionIndex: String(data.transaction_index),
                status: "proposal-created",
              });
              upsertProgramDeploymentHistory(formData.programSourceDir, {
                kind: "squads-upgrade-proposal",
                network: currentNetwork(data.network),
                programId: String(formData.programId || "").trim(),
                programSha256: String(formData.programSoSha256 || "").trim().toLowerCase() || undefined,
                programBytes: Number(formData.programSoSize || 0) || undefined,
                multisig: String(formData.multisig || "").trim(),
                vault: data.vault,
                bufferAddress: String(formData.bufferAddress || "").trim(),
                proposal: data.proposal,
                transactionIndex: String(data.transaction_index),
                signature: data.signature,
                status: "proposal-created",
                completedAt: Date.now(),
              });
            }
            saveWorkspaceProposal(
              data.proposal,
              formData.multisig,
              data.transaction_index,
              "program-upgrade",
              "active",
              undefined,
              actor,
            );
            setFormData((prev) => ({
              ...prev,
              vault: data.vault,
              transaction: data.transaction,
              proposal: data.proposal,
              transactionIndex: String(data.transaction_index),
              signature: data.signature,
              transactionKind: "program-upgrade",
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.squads-program-upgrade.error"));
          }
          break;
        }

        case "squads-set-authority": {
          const m = walletAuth("squads-set-authority");
          if (!validateWalletAuth(m, formData, "private_key") || !formData.multisig || !formData.programId) {
            toast.error(t("features.squads-set-authority.fillAllFields"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {
            multisig: formData.multisig,
            program_id: formData.programId,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");
          const actor = walletActor(m === "keystore" ? selectedSavedWallet() : undefined);
          const response = await apiFetch("squads/program/set-authority", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.squads-set-authority.success"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            saveWorkspaceMultisig(formData.multisig, data.new_authority, undefined, undefined, actor);
            saveWorkspaceProgram(data.program_id);
            setFormData((prev) => ({
              ...prev,
              vault: data.new_authority,
              programdataAddress: data.programdata_address,
              signature: data.signature,
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.squads-set-authority.error"));
          }
          break;
        }

        case "squads-approve":
        case "squads-reject": {
          const m = walletAuth(formId);
          if (!validateWalletAuth(m, formData, "private_key") || !formData.multisig || !formData.proposal) {
            toast.error(t("features.squads-vote.fillAllFields"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {
            multisig: formData.multisig,
            proposal: formData.proposal,
            memo: formData.memo,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");
          const response = await apiFetch(formId === "squads-approve" ? "squads/proposal/approve" : "squads/proposal/reject", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(formId === "squads-approve" ? t("features.squads-approve.success") : t("features.squads-reject.success"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            saveWorkspaceProposal(
              formData.proposal,
              formData.multisig,
              formData.transactionIndex,
              undefined,
              formId === "squads-approve" ? "voted" : "rejected",
              undefined,
            );
            setFormData((prev) => ({
              ...prev,
              signature: data.signature,
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.squads-vote.error"));
          }
          break;
        }

        case "squads-execute": {
          const m = walletAuth("squads-execute");
          const transactionIndex = parseInt(String(formData.transactionIndex || ""), 10);
          if (!validateWalletAuth(m, formData, "private_key") || !formData.multisig || !formData.proposal || !Number.isInteger(transactionIndex)) {
            toast.error(t("features.squads-execute.fillAllFields"));
            setLoading(false);
            return;
          }
          const requestBody: ApiRequestBody = {
            multisig: formData.multisig,
            proposal: formData.proposal,
            transaction_index: transactionIndex,
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");
          const response = await apiFetch("squads/proposal/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();
          if (response.ok) {
            toast.success(t("features.squads-execute.success"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            saveWorkspaceProposal(
              formData.proposal,
              formData.multisig,
              transactionIndex,
              undefined,
              "executed",
              undefined,
            );
            markProgramUpgradeHistoryExecuted(
              formData.proposal,
              formData.multisig,
              data.signature,
              data.network || submitNetwork(),
            );
            setFormData((prev) => ({
              ...prev,
              signature: data.signature,
              network: data.network,
            }));
          } else {
            toast.error(data.error || t("features.squads-execute.error"));
          }
          break;
        }

        case "setup-2fa": {
          const masterPassword = String(formData.master_password || "");
          if (!formData.hardware_fingerprint || !masterPassword) {
            toast.error(t("features.setup-2fa.fillAllFields"));
            setLoading(false);
            return;
          }

          const response = await apiFetch("2fa/setup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              hardware_fingerprint: formData.hardware_fingerprint,
              master_password: masterPassword,
              account: formData.account || "fnzero-safe",
              issuer: formData.issuer || "FnzSafe",
            }),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.setup-2fa.success"));
            setFormData((prev) => ({
              ...prev,
              totp_secret: data.totp_secret,
              qr_code_url: data.qr_code_url,
            }));
          } else {
            toast.error(data.error || t("features.setup-2fa.error"));
          }
          break;
        }

        case "create-tfa": {
          const m = walletAuth("create-tfa");
          const masterPassword = String(formData.master_password || "");
          if (
            !formData.totp_secret ||
            !formData.hardware_fingerprint ||
            !masterPassword ||
            formData.question_index === undefined ||
            !formData.security_answer
          ) {
            toast.error(t("features.create-tfa.fillAllFields"));
            setLoading(false);
            return;
          }
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(t("features.create-tfa.fillAllFields"));
            setLoading(false);
            return;
          }
          const questionIndex =
            typeof formData.question_index === "number"
              ? formData.question_index
              : parseInt(String(formData.question_index), 10);
          if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex > 7) {
            toast.error(t("features.create-tfa.questionIndexError"));
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {
            totp_secret: formData.totp_secret,
            hardware_fingerprint: formData.hardware_fingerprint,
            master_password: masterPassword,
            question_index: questionIndex,
            security_answer: formData.security_answer,
          };
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("2fa/create-tfa", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.create-tfa.success"));
            setFormData((prev) => ({
              ...prev,
              encrypted_wallet: data.encrypted_wallet,
              publicKey: data.public_key,
            }));
          } else {
            toast.error(data.error || t("features.create-tfa.error"));
          }
          break;
        }

        case "unlock-tfa": {
          const masterPassword = String(formData.master_password || "");
          if (!formData.encrypted_wallet || !formData.hardware_fingerprint || !masterPassword ||
              !formData.security_answer || !formData.totp_code) {
            toast.error(t("features.unlock-tfa.fillAllFields"));
            setLoading(false);
            return;
          }

          const response = await apiFetch("2fa/unlock-tfa", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              encrypted_wallet: formData.encrypted_wallet,
              hardware_fingerprint: formData.hardware_fingerprint,
              master_password: masterPassword,
              security_answer: formData.security_answer,
              totp_code: formData.totp_code,
            }),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.unlock-tfa.success"));
            setFormData((prev) => {
              const next: FormState = {
                ...prev,
                publicKey: data.public_key,
                unlocked: data.unlocked ? "true" : undefined,
              };
              delete next.private_key;
              delete next.secretKey;
              return next;
            });
          } else {
            toast.error(data.error || t("features.unlock-tfa.error"));
          }
          break;
        }

        case "close-wsol-ata": {
          const m = walletAuth("close-wsol-ata");
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(
              m === "keystore"
                ? t("features.close-wsol-ata.uploadKeystore")
                : m === "encrypted"
                  ? t("features.decrypt.fillAllFields")
                  : t("features.close-wsol-ata.enterPrivateKey"),
            );
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("wsol/close-ata", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(t("features.close-wsol-ata.success", { signature: data.signature }));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet);
            setFormData((prev) => ({
              ...prev,
              signature: data.signature,
            }));
          } else {
            toast.error(data.error || t("features.close-wsol-ata.error"));
          }
          break;
        }

        case "pumpfun-sell": {
          const m = walletAuth("pumpfun-sell");
          const amount = parsePositiveDecimal(formData.amount);
          const sellPercent = parseSellPercentBps(formData.sell_percent);
          if (!formData.mint || (amount === null && sellPercent === undefined)) {
            toast.error(t("features.pumpfun-sell.fillAllFields"));
            setLoading(false);
            return;
          }
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(t("features.pumpfun-sell.fillAllFields"));
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {
            mint: formData.mint,
            slippage: slippagePercentToBasisPoints(formData.slippage),
            network: submitNetwork(),
          };
          if (sellPercent !== undefined) requestBody.sell_percent = sellPercent;
          else if (amount !== null) requestBody.amount = amount;
          else {
            toast.error(t("features.pumpfun-sell.fillAllFields"));
            setLoading(false);
            return;
          }
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("pumpfun/sell", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(pumpSellSuccessMessage(data, "pumpfun-sell"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet, {
              tokenAdjustment: pumpSellTokenAdjustment(formData, data),
              refreshDelaysMs: POST_SELL_ASSET_REFRESH_DELAYS_MS,
              formSnapshot: formData,
            });
            setFormData((prev) => ({
              ...prev,
              status: data.status,
              signature: data.signature,
              dex: data.dex,
              market: data.market,
            }));
          } else {
            toast.error(data.error || t("features.pumpfun-sell.error"));
          }
          break;
        }

        case "pumpswap-sell": {
          const m = walletAuth("pumpswap-sell");
          const amount = parsePositiveDecimal(formData.amount);
          const sellPercent = parseSellPercentBps(formData.sell_percent);
          if (!formData.mint || (amount === null && sellPercent === undefined)) {
            toast.error(t("features.pumpswap-sell.fillAllFields"));
            setLoading(false);
            return;
          }
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(t("features.pumpswap-sell.fillAllFields"));
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {
            mint: formData.mint,
            slippage: slippagePercentToBasisPoints(formData.slippage),
            network: submitNetwork(),
          };
          if (sellPercent !== undefined) requestBody.sell_percent = sellPercent;
          else if (amount !== null) requestBody.amount = amount;
          else {
            toast.error(t("features.pumpswap-sell.fillAllFields"));
            setLoading(false);
            return;
          }
          applyWalletAuth(requestBody, m, formData, "private_key");

          const response = await apiFetch("pumpswap/sell", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(pumpSellSuccessMessage(data, "pumpswap-sell"));
            refreshWalletAfterMutation(savedWalletFromForm(formData) ?? effectiveWallet, {
              tokenAdjustment: pumpSellTokenAdjustment(formData, data),
              refreshDelaysMs: POST_SELL_ASSET_REFRESH_DELAYS_MS,
              formSnapshot: formData,
            });
            setFormData((prev) => ({
              ...prev,
              status: data.status,
              signature: data.signature,
              dex: data.dex,
              market: data.market,
            }));
          } else {
            toast.error(data.error || t("features.pumpswap-sell.error"));
          }
          break;
        }

        case "pumpfun-cashback":
        case "pumpswap-cashback": {
          const m = walletAuth(formId);
          if (!validateWalletAuth(m, formData, "private_key")) {
            toast.error(
              m === "keystore"
                ? t("features.pumpfun-cashback.uploadKeystore")
                : m === "encrypted"
                  ? t("features.decrypt.fillAllFields")
                  : t("features.pumpfun-cashback.enterPrivateKey"),
            );
            setLoading(false);
            return;
          }

          const requestBody: ApiRequestBody = {
            network: submitNetwork(),
          };
          applyWalletAuth(requestBody, m, formData, "private_key");

          const apiUrlPath = formId === "pumpfun-cashback" ? "/pumpfun/cashback" : "/pumpswap/cashback";
          const response = await apiFetch(apiUrlPath.replace(/^\//, ""), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = await response.json();

          if (response.ok) {
            toast.success(
              formId === "pumpfun-cashback"
                ? t("features.pumpfun-cashback.success")
                : t("features.pumpswap-cashback.success"),
            );
            setFormData((prev) => ({
              ...prev,
              message: data.message,
              status: data.status,
              signature: data.signature,
              cashbackAmount: data.ui_amount_string,
              cashbackAsset: data.asset,
            }));
            const submittedWallet = savedWalletFromForm(formData) ?? effectiveWallet;
            refreshWalletAfterMutation(submittedWallet);
            await loadCashbackInfo(formId === "pumpfun-cashback" ? "pumpfun" : "pumpswap", submittedWallet);
          } else {
            toast.error(
              data.error ||
                (formId === "pumpfun-cashback"
                  ? t("features.pumpfun-cashback.error")
                  : t("features.pumpswap-cashback.error")),
            );
          }
          break;
        }

        default:
          toast.error(t("errors.unknownFeature"));
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : t("errors.unknownError");
      if (formId === "program-deploy") {
        showProgramDeployInlineError(
          t("errors.requestFailedWithHint", {
            message,
            port: String(DEFAULT_API_PORT),
          }),
        );
        return;
      }
      if (formId === "program-upgrade") {
        showProgramUpgradeInlineError(
          t("errors.requestFailedWithHint", {
            message,
            port: String(DEFAULT_API_PORT),
          }),
        );
        return;
      }
      if (isProgramInvokeForm(formId)) {
        const displayMessage = t("errors.requestFailedWithHint", {
          message,
          port: String(DEFAULT_API_PORT),
        });
        setProgramInvoke((prev) => ({
          ...prev,
          result: {
            status: "request_failed",
            errorMessage: displayMessage,
            logs: [],
          },
        }));
        toast.error(displayMessage);
        return;
      }
      toast.error(
        t("errors.requestFailedWithHint", {
          message,
          port: String(DEFAULT_API_PORT),
        }),
      );
    } finally {
      setLoading(false);
    }
  };

  const renderForm = (formId: string) => {
    const renderCopyRow = (id: string, label: string, value: unknown) => {
      if (!value) return null;
      return (
        <div>
          <label className="block text-sm font-medium mb-2">{label}</label>
          <div className="flex min-w-0 gap-2">
            <code className="min-w-0 flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
              {String(value)}
            </code>
            <button
              type="button"
              onClick={() => copyToClipboard(String(value), id)}
              className="shrink-0 px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
              aria-label={t("common.copy")}
              title={t("common.copy")}
            >
              {copied === id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
      );
    };

    const openAction = (form: string, preset: FormState = {}) => () => {
      handleOpenForm(form, {
        network: requestNetwork(),
        ...preset,
      });
    };

    const renderActionGrid = (
      actions: Array<{
        id: string;
        title: string;
        icon: React.ReactNode;
        preset?: FormState;
      }>,
    ) => (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={openAction(action.id, action.preset)}
            className="flex items-center gap-3 p-4 bg-white/5 border border-white/10 rounded-lg text-left hover:bg-white/10 transition-colors"
          >
            <span className="shrink-0 text-gray-300">{action.icon}</span>
            <span className="min-w-0 text-sm font-medium">{action.title}</span>
          </button>
        ))}
      </div>
    );

    const renderWalletAccountManager = () => (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">{t("features.settings.walletTitle")}</h3>
            <p className="mt-1 text-xs text-gray-500">{t("features.settings.walletHint")}</p>
          </div>
          <button
            type="button"
            onClick={() => void loadWallets()}
            className="shrink-0 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/20 transition-colors"
          >
            {walletsLoading ? t("common.loading") : t("formUi.refreshWallets")}
          </button>
        </div>
        {wallets.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-400">
            {walletsLoading
              ? t("features.wallet-list.loading")
              : walletsLoadError || t("features.walletContext.empty")}
          </div>
        ) : (
          <div className="space-y-3">
            {wallets.map((wallet) => {
              const isCurrent = wallet.id === effectiveWalletId;
              const liveSolBalance =
                walletAssets?.address === wallet.public_key &&
                walletAssets.network === effectiveNetwork &&
                walletAssets.solBalance !== "--"
                  ? walletAssets.solBalance
                  : undefined;
              const walletSolBalance = liveSolBalance ?? walletSolBalanceCache[wallet.public_key] ?? "--";
              const copyId = `settings-wallet:${wallet.id}`;
              return (
                <div
                  role="button"
                  tabIndex={0}
                  key={wallet.id}
                  onClick={() => {
                    if (!isCurrent) {
                      setCurrentWallet(wallet.id);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (isCurrent) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setCurrentWallet(wallet.id);
                    }
                  }}
                  className={`block w-full rounded-xl border p-3 text-left transition-colors sm:p-4 ${
                    isCurrent ? "border-violet-300/30 bg-violet-400/10" : "border-white/10 bg-white/[0.04] hover:bg-white/[0.07]"
                  }`}
                >
                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                    <div className="flex min-w-0 gap-3">
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white sm:h-11 sm:w-11">
                        {walletAvatarText(wallet)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p
                            className="max-w-full cursor-text truncate text-base font-semibold text-white select-text"
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                          >
                            {wallet.name}
                          </p>
                          {isCurrent && (
                            <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-xs text-emerald-200">
                              {t("features.walletContext.current")}
                            </span>
                          )}
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              wallet.keystore_version === "v2"
                                ? "bg-emerald-400/15 text-emerald-200"
                                : "bg-amber-400/15 text-amber-200"
                            }`}
                          >
                            {wallet.keystore_version === "v2"
                              ? t("features.settings.keystoreV2")
                              : t("features.settings.keystoreLegacy")}
                          </span>
                          {biometricConfiguredFor(wallet) && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-sky-400/15 px-2 py-0.5 text-xs text-sky-100">
                              <Fingerprint className="h-3 w-3" />
                              {t("features.biometric.touchId")}
                            </span>
                          )}
                        </div>
                        <div className="mt-2 flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              copyToClipboard(wallet.public_key, copyId);
                            }}
                            className="min-w-0 truncate text-left font-mono text-xs text-gray-400 hover:text-white sm:rounded-lg sm:border sm:border-white/10 sm:bg-black/20 sm:px-2.5 sm:py-1.5 sm:text-gray-300 sm:hover:bg-white/10"
                            title={wallet.public_key}
                          >
                            <span className="sm:hidden">{shortAddress(wallet.public_key)}</span>
                            <span className="hidden sm:inline">{wallet.public_key}</span>
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              copyToClipboard(wallet.public_key, copyId);
                            }}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white sm:h-8 sm:w-8 sm:border sm:border-white/10"
                            title={t("features.walletContext.copyAddress")}
                            aria-label={t("features.walletContext.copyAddress")}
                          >
                            {copied === copyId ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2 lg:justify-end">
                      <div className="hidden min-w-28 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-right sm:block">
                        <p className="text-[11px] uppercase tracking-normal text-gray-500">{t("features.wallet-list.solBalance")}</p>
                        <p className="mt-0.5 truncate text-sm font-semibold text-white">{walletSolBalance} SOL</p>
                      </div>
                      <div className="relative" data-wallet-actions-menu>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setWalletActionsMenuOpen((open) => (open === wallet.id ? null : wallet.id));
                          }}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
                          title={t("features.wallet-list.actions")}
                          aria-label={t("features.wallet-list.actions")}
                        >
                          <Menu className="h-4 w-4" />
                        </button>
                        {walletActionsMenuOpen === wallet.id && (
                          <div className="absolute right-0 z-50 mt-2 w-48 overflow-hidden rounded-xl border border-white/10 bg-zinc-950 p-1 shadow-2xl">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setWalletActionsMenuOpen(null);
                                setEditingWalletId(wallet.id);
                                setFormData((prev) => ({
                                  ...prev,
                                  [`walletName:${wallet.id}`]: wallet.name,
                                }));
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-gray-200 hover:bg-white/10"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              {t("formUi.editWalletMetadata")}
                            </button>
                            {wallet.keystore_version === "legacy_v1" && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setWalletActionsMenuOpen(null);
                                  requestMigrateKeystore(wallet);
                                }}
                                disabled={loading}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-emerald-100 hover:bg-emerald-500/10 disabled:opacity-50"
                              >
                                <ShieldCheck className="h-3.5 w-3.5" />
                                {t("features.settings.migrateKeystore")}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setWalletActionsMenuOpen(null);
                                requestExportBundle(wallet);
                              }}
                              disabled={loading}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50"
                            >
                              <Download className="h-3.5 w-3.5" />
                              {t("features.settings.exportBundleMenu")}
                            </button>
                            {biometricConfiguredFor(wallet) && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setWalletActionsMenuOpen(null);
                                  void deleteBiometricWalletPassword(wallet);
                                }}
                                disabled={loading || biometricBusyWalletId === wallet.id}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-sky-100 hover:bg-sky-500/10 disabled:opacity-50"
                              >
                                <Fingerprint className="h-3.5 w-3.5" />
                                {t("features.biometric.removeTouchId")}
                              </button>
                            )}
                            {canUseBiometricWallet(wallet) && !biometricConfiguredFor(wallet) && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setWalletActionsMenuOpen(null);
                                  requestEnableBiometricWallet(wallet);
                                }}
                                disabled={loading || biometricBusyWalletId === wallet.id}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-sky-100 hover:bg-sky-500/10 disabled:opacity-50"
                              >
                                <Fingerprint className="h-3.5 w-3.5" />
                                {t("features.biometric.enableTouchId")}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setWalletActionsMenuOpen(null);
                                void handleDeleteWallet(wallet);
                              }}
                              disabled={loading}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-red-200 hover:bg-red-500/10 disabled:opacity-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {t("features.settings.deleteWallet")}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  {editingWalletId === wallet.id && (
                    <div
                      className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_auto]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <input
                        type="text"
                        value={formData[`walletName:${wallet.id}`] ?? wallet.name}
                        onChange={(e) => handleFormChange(`walletName:${wallet.id}`, e.target.value)}
                        className="min-w-0 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/20"
                        placeholder={t("formUi.walletNamePlaceholder")}
                      />
                      <button
                        type="button"
                        onClick={() => void handleSaveWalletMetadata(wallet)}
                        disabled={loading}
                        className="inline-flex items-center justify-center gap-1 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/20 disabled:opacity-50"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {t("formUi.saveWalletMetadata")}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCancelWalletMetadata(wallet)}
                        disabled={loading}
                        className="rounded-lg bg-white/5 px-3 py-2 text-xs hover:bg-white/10 disabled:opacity-50"
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );

    const renderWalletListPanel = () => {
      const renderChainViewTabs = () => (
        <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-1">
          {[
            { id: "solana" as const, label: t("features.wallet-list.chainViewSolana") },
            { id: "evm" as const, label: activeEvmChain?.name || t("features.wallet-list.chainViewOtherChains") },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setWalletChainView(item.id)}
              className={`rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
                walletChainView === item.id
                  ? "bg-white text-black"
                  : "text-gray-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      );

      const renderEvmWalletPanel = () => {
        const currentEvmAssets =
          evmWallet &&
          activeEvmChain &&
          evmAssets?.wallet_address.toLowerCase() === evmWallet.address.toLowerCase() &&
          evmAssets.chain.chain_id === activeEvmChain.chain_id
            ? evmAssets
            : null;
        const evmNativeBalance = currentEvmAssets?.native_balance_wei ?? "--";
        const evmTokens = currentEvmAssets?.tokens ?? [];
        const evmTransactions = currentEvmAssets?.recent_transactions ?? [];
        return (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {renderChainViewTabs()}
              <button
                type="button"
                onClick={() => handleSelectForm("evm-workbench")}
                className="inline-flex w-fit items-center justify-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-black hover:bg-gray-200"
              >
                <ArrowRightLeft className="h-4 w-4" />
                {t("features.wallet-list.otherChainsOpenWorkbench")}
              </button>
            </div>

            {!evmWallet ? (
              <section className="rounded-2xl border border-white/10 bg-black/40 p-6 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-400/10">
                  <Wallet className="h-8 w-8 text-emerald-100" />
                </div>
                <h3 className="mt-5 text-xl font-semibold">{t("features.wallet-list.otherChainsNoWalletTitle")}</h3>
                <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">{t("features.wallet-list.otherChainsNoWalletHint")}</p>
                <button
                  type="button"
                  onClick={() => {
                    setEvmCustomChainEditorOpen(false);
                    handleSelectForm("evm-workbench");
                  }}
                  className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-black hover:bg-gray-200"
                >
                  <Wallet className="h-4 w-4" />
                  {t("features.wallet-list.otherChainsCreateImport")}
                </button>
              </section>
            ) : (
              <>
                <section className="overflow-hidden border-white/10 bg-transparent lg:rounded-xl lg:border lg:bg-black/50">
                  <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-emerald-500 to-sky-700 p-5 shadow-xl shadow-black/20 lg:rounded-none lg:border-0 lg:bg-none lg:p-4 lg:shadow-none">
                    <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-200 text-sm font-bold text-black lg:flex">
                          {activeEvmChain?.native_symbol || "CHAIN"}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="max-w-full truncate text-lg font-semibold">{evmWallet.name}</h3>
                            <span className="rounded-full border border-white/15 bg-white/15 px-2 py-0.5 text-xs text-white/80 lg:border-white/10 lg:bg-white/5 lg:text-gray-300">
                              {activeEvmChain?.name || t("features.wallet-list.currentPublicChain")}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(evmWallet.address, "evm-wallet-home-address")}
                            className="mt-1 block max-w-full truncate text-left font-mono text-xs text-white/75 hover:text-white lg:text-gray-400"
                          >
                            <span className="lg:hidden">{shortAddress(evmWallet.address)}</span>
                            <span className="hidden lg:inline">{evmWallet.address}</span>
                          </button>
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-white/70 lg:text-gray-400">
                            {t("features.wallet-list.chainNativeBalance", { symbol: activeEvmChain?.native_symbol || "Native" })}
                          </p>
                          <button
                            type="button"
                            onClick={refreshEvmAssets}
                            disabled={evmBusy || !activeEvmChain}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-white/20 text-white hover:bg-white/30 disabled:opacity-50 lg:bg-white/10 lg:text-gray-300 lg:hover:bg-white/20"
                            title={t("features.wallet-list.chainRefreshAssets")}
                            aria-label={t("features.wallet-list.chainRefreshAssets")}
                          >
                            <RefreshCw className={`h-3.5 w-3.5 ${evmBusy ? "animate-spin" : ""}`} />
                          </button>
                        </div>
                        <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                          <p className="max-w-full truncate text-4xl font-semibold tracking-normal lg:text-3xl">{evmNativeBalance}</p>
                          <p className="text-sm text-white/75 lg:text-gray-400">wei</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-3 lg:mt-0 lg:gap-0 lg:border-t lg:border-white/10 lg:bg-white/[0.03]">
                    <button
                      type="button"
                      onClick={() => handleSelectForm("evm-workbench")}
                      className="flex h-20 min-w-0 flex-col items-center justify-center gap-2 rounded-xl bg-white/10 px-2 text-xs font-semibold text-gray-200 hover:bg-white/15 lg:h-16 lg:rounded-none lg:border-r lg:border-white/10 lg:bg-transparent lg:hover:bg-white/10 sm:h-14 sm:flex-row sm:gap-2 sm:text-sm"
                    >
                      <Send className="h-5 w-5" />
                      {t("features.wallet-list.send")}
                    </button>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(evmWallet.address, "evm-wallet-receive-address")}
                      className="flex h-20 min-w-0 flex-col items-center justify-center gap-2 rounded-xl bg-white/10 px-2 text-xs font-semibold text-gray-200 hover:bg-white/15 lg:h-16 lg:rounded-none lg:border-r lg:border-white/10 lg:bg-transparent lg:hover:bg-white/10 sm:h-14 sm:flex-row sm:gap-2 sm:text-sm"
                    >
                      <Download className="h-5 w-5" />
                      {t("features.wallet-list.receive")}
                    </button>
                    <button
                      type="button"
                      onClick={refreshEvmAssets}
                      disabled={evmBusy || !activeEvmChain}
                      className="flex h-20 min-w-0 flex-col items-center justify-center gap-2 rounded-xl bg-white/10 px-2 text-xs font-semibold text-gray-200 hover:bg-white/15 disabled:opacity-50 lg:h-16 lg:rounded-none lg:bg-transparent lg:hover:bg-white/10 sm:h-14 sm:flex-row sm:gap-2 sm:text-sm"
                    >
                      <RefreshCw className={`h-5 w-5 ${evmBusy ? "animate-spin" : ""}`} />
                      {t("features.wallet-list.refreshAssets")}
                    </button>
                  </div>
                </section>

                <section className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold text-gray-200">{t("features.wallet-list.assets")}</h3>
                      <span className="rounded bg-white/10 px-2 py-1 text-xs text-gray-400">
                        {activeEvmChain?.name || t("features.wallet-list.currentPublicChain")}
                      </span>
                    </div>
                    {evmTokens.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-white/10 bg-black/20 p-4 text-sm text-gray-500">
                        {t("features.wallet-list.otherChainsAssetsEmpty")}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {evmTokens.map((token) => (
                          <div key={token.contract_address} className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
                            <p className="font-medium text-white">{token.symbol} {token.balance}</p>
                            <p className="mt-1 break-all text-xs text-gray-500">{token.name} · {token.contract_address}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <h3 className="text-sm font-semibold text-gray-200">
                      {t("features.wallet-list.chainHistory", { chain: activeEvmChain?.name || t("features.wallet-list.currentPublicChain") })}
                    </h3>
                    {evmTransactions.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-white/10 bg-black/20 p-4 text-sm text-gray-500">
                        {t("features.wallet-list.otherChainsNoHistory")}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {evmTransactions.map((entry) => (
                          <div key={entry.hash} className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
                            <p className="text-white">{entry.status} · block {entry.block_number ?? "-"}</p>
                            <p className="mt-1 break-all text-xs text-gray-500">{entry.hash}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {currentEvmAssets?.history_message && (
                      <p className="text-xs text-yellow-200">{currentEvmAssets.history_message}</p>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
        );
      };

      if (walletChainView === "evm") {
        return renderEvmWalletPanel();
      }

      const assets =
        effectiveWallet &&
        walletAssets?.address === effectiveWallet.public_key &&
        walletAssets.network === effectiveNetwork
          ? walletAssets
          : null;
      const solBalance = assets?.solBalance && assets.solBalance !== "--" ? assets.solBalance : "--";
      const tokenAssets = assets?.tokens ?? [];
      const visibleTokenAssets = tokenAssets.slice(0, visibleTokenCount);
      const hiddenTokenCount = Math.max(0, tokenAssets.length - visibleTokenAssets.length);
      const tokenSymbols = new Map(tokenAssets.map((token) => [token.mint, tokenDisplaySymbol(token)]));
      const assetsLoading = Boolean(assets?.loading || assets?.refreshing);
      const activeWalletAddress = effectiveWallet?.public_key ?? "";
      const currentTransactions =
        activeWalletAddress !== "" &&
        walletTransactions?.address === activeWalletAddress &&
        walletTransactions.network === effectiveNetwork
          ? walletTransactions
          : null;
      const transactionsLoading = Boolean(currentTransactions?.loading);

      if (!effectiveWallet) {
        const emptyTitle = walletsLoading
          ? t("features.wallet-list.loadingTitle")
          : walletsLoadError
            ? t("features.wallet-list.loadFailedTitle")
            : t("features.wallet-list.emptyTitle");
        const emptyDescription = walletsLoading
          ? t("features.wallet-list.loading")
          : walletsLoadError || t("features.wallet-list.empty");
        return (
          <div className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-black/40 p-6 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-white/10">
                <Wallet className={`h-8 w-8 text-gray-300 ${walletsLoading ? "animate-pulse" : ""}`} />
              </div>
              <h3 className="mt-5 text-xl font-semibold">{emptyTitle}</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">{emptyDescription}</p>
              {!walletsLoading && (
                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (walletsLoadError) {
                        void loadWallets();
                        return;
                      }
                      handleOpenForm("create-keystore", {}, "wallet-list");
                    }}
                    className="rounded-xl bg-white px-4 py-3 text-sm font-semibold text-black hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {walletsLoadError ? t("formUi.refreshWallets") : t("features.walletContext.createWallet")}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenForm("import-keystore", {}, "wallet-list")}
                    disabled={Boolean(walletsLoadError)}
                    className="rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm font-semibold hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t("features.walletContext.importWallet")}
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      }

      const walletActions = [
        {
          id: "send",
          title: t("features.wallet-list.send"),
          icon: <Send className="h-5 w-5" />,
          onClick: () => handleOpenForm("transfer-sol", { wallet_id: effectiveWallet.id, network: effectiveNetwork }, "wallet-list"),
        },
        {
          id: "receive",
          title: t("features.wallet-list.receive"),
          icon: <Download className="h-5 w-5" />,
          onClick: () => copyToClipboard(effectiveWallet.public_key, "wallet-receive-address"),
        },
        {
          id: "trade",
          title: t("features.wallet-list.trade"),
          icon: <ArrowRightLeft className="h-5 w-5" />,
          onClick: () => handleOpenForm("pump-workbench", { wallet_id: effectiveWallet.id, network: effectiveNetwork }, "wallet-list"),
        },
        {
          id: "token",
          title: t("features.wallet-list.tokenSend"),
          icon: <Coins className="h-5 w-5" />,
          onClick: () => handleOpenForm("transfer-token", { wallet_id: effectiveWallet.id, network: effectiveNetwork }, "wallet-list"),
        },
        {
          id: "history",
          title: t("features.wallet-list.transactions"),
          icon: <ArrowRightLeft className="h-5 w-5" />,
          onClick: () => {
            setWalletOverviewTab("transactions");
            document.getElementById("wallet-overview-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
          },
        },
      ];

      return (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {renderChainViewTabs()}
          </div>
          <section className="overflow-hidden border-white/10 bg-transparent lg:rounded-xl lg:border lg:bg-black/50">
            <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-blue-500 to-violet-700 p-5 shadow-xl shadow-black/20 lg:rounded-none lg:border-0 lg:bg-none lg:p-4 lg:shadow-none">
              <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-full bg-violet-300 text-sm font-bold text-black lg:flex">
                    {walletAvatarText(effectiveWallet)}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="max-w-full truncate text-lg font-semibold lg:text-lg">{effectiveWallet.name}</h3>
                      <span className="rounded-full border border-white/15 bg-white/15 px-2 py-0.5 text-xs text-white/80 lg:border-white/10 lg:bg-white/5 lg:text-gray-300">
                        <span className="lg:hidden">{effectiveNetworkLabel}</span>
                        <span className="hidden lg:inline">{effectiveRpcLabel}</span>
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(effectiveWallet.public_key, "wallet-home-address")}
                      className="mt-1 block max-w-full truncate text-left font-mono text-xs text-white/75 hover:text-white lg:text-gray-400"
                    >
                      <span className="lg:hidden">{shortAddress(effectiveWallet.public_key)}</span>
                      <span className="hidden lg:inline">{effectiveWallet.public_key}</span>
                    </button>
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-white/70 lg:text-gray-400">{t("features.wallet-list.solBalance")}</p>
                    <button
                      type="button"
                      onClick={() => refreshCurrentWalletAssets(effectiveWallet)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-white/20 text-white hover:bg-white/30 lg:bg-white/10 lg:text-gray-300 lg:hover:bg-white/20"
                      title={t("features.wallet-list.refreshAssets")}
                      aria-label={t("features.wallet-list.refreshAssets")}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${assetsLoading ? "animate-spin" : ""}`} />
                    </button>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <p className="max-w-full truncate text-4xl font-semibold tracking-normal lg:text-3xl">{solBalance}</p>
                    <p className="text-sm text-white/75 lg:text-gray-400">SOL</p>
                  </div>
                  {assets?.error && (
                    <p className="mt-2 text-xs text-yellow-100 lg:text-yellow-200">
                      {assets.error || t("features.wallet-list.assetLoadFailed")}
                    </p>
                  )}
                  {(effectiveNetwork === "devnet" || effectiveNetwork === "testnet") && (
                    <div className="mt-3 flex min-w-0 items-center gap-2">
                      <div className="relative" data-wallet-faucet-menu>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setWalletFaucetMenuOpen((open) => !open);
                          }}
                          className="inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-3 text-xs font-semibold text-emerald-950 transition-colors hover:bg-emerald-200"
                          aria-expanded={walletFaucetMenuOpen}
                          aria-haspopup="menu"
                        >
                          <ExternalLink aria-hidden="true" className="h-4 w-4 shrink-0" />
                          <span className="truncate">{t("features.wallet-list.faucetMenu")}</span>
                          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                        </button>
                        {walletFaucetMenuOpen && (
                          <div
                            role="menu"
                            className="absolute left-0 z-50 mt-2 w-44 overflow-hidden rounded-xl border border-white/10 bg-zinc-950 p-1 shadow-2xl"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={(event) => {
                                event.stopPropagation();
                                void openWalletFaucet(effectiveWallet, "solana");
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-gray-200 hover:bg-white/10"
                            >
                              <Coins className="h-3.5 w-3.5 text-emerald-300" />
                              {t("features.wallet-list.faucetAirdrop")}
                            </button>
                            {effectiveNetwork === "devnet" && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void openWalletFaucet(effectiveWallet, "circle");
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-gray-200 hover:bg-white/10"
                              >
                                <Coins className="h-3.5 w-3.5 text-sky-300" />
                                {t("features.wallet-list.circleFaucet")}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      <FieldHelp
                        description={
                          effectiveNetwork === "devnet"
                            ? t("features.wallet-list.faucetMenuTooltip")
                            : t("features.wallet-list.faucetAirdropTooltip")
                        }
                        label={t("features.wallet-list.faucetMenuHelpAriaLabel")}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-3 lg:mt-0 lg:grid-cols-5 lg:gap-0 lg:border-t lg:border-white/10 lg:bg-white/[0.03]">
              {walletActions.map((action, index) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={action.onClick}
                  className={`${index === 4 ? "hidden lg:flex" : "flex"} h-20 min-w-0 flex-col items-center justify-center gap-2 rounded-xl bg-white/10 px-2 text-xs font-semibold text-gray-200 hover:bg-white/15 lg:h-16 lg:rounded-none lg:border-r lg:border-white/10 lg:bg-transparent lg:last:border-r-0 lg:hover:bg-white/10 sm:h-14 sm:flex-row sm:gap-2 sm:text-sm`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/25 text-violet-100 lg:h-8 lg:w-8 lg:bg-black/30 sm:h-7 sm:w-7">
                    {action.icon}
                  </span>
                  <span className="max-w-full truncate">{action.title}</span>
                </button>
              ))}
            </div>
          </section>

          <section id="wallet-overview-tabs" className="space-y-4 scroll-mt-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-1">
                {[
                  { id: "assets" as const, label: t("features.wallet-list.assets") },
                  { id: "transactions" as const, label: t("features.wallet-list.transactions") },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setWalletOverviewTab(tab.id)}
                    className={`rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
                      walletOverviewTab === tab.id
                        ? "bg-white text-black"
                        : "text-gray-300 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {walletOverviewTab === "assets" ? (
                <button
                  type="button"
                  onClick={() => void loadWalletAssets(effectiveWallet, { refresh: true, force: true })}
                  className="inline-flex w-fit items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/20"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${assetsLoading ? "animate-spin" : ""}`} />
                  {t("features.wallet-list.refreshAssets")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void loadWalletTransactions(effectiveWallet, "replace", { force: true })}
                  className="inline-flex w-fit items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/20"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${transactionsLoading ? "animate-spin" : ""}`} />
                  {t("features.wallet-list.refreshTransactions")}
                </button>
              )}
            </div>

            {walletOverviewTab === "assets" ? (
              <div className="space-y-2 lg:space-y-3">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4 border-b border-white/10 bg-transparent px-1 py-3 lg:rounded-xl lg:border lg:bg-white/10 lg:p-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-black p-2 ring-1 ring-white/10">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={SOLANA_TOKEN_LOGO_URI}
                          alt=""
                          className="h-full w-full object-contain"
                          loading="eager"
                        />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-base font-semibold">SOL</p>
                          <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs text-gray-300">
                            {t("features.wallet-list.solana")}
                          </span>
                        </div>
                        <p className="mt-1 hidden truncate text-xs text-gray-400 lg:block">{t("features.wallet-list.nativeToken")}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold">{solBalance}</p>
                      <p className="hidden text-xs text-gray-500 lg:block">{effectiveRpcLabel}</p>
                    </div>
                  </div>
                  {visibleTokenAssets.map((token) => {
                    const colors = tokenColorPair(token.mint);
                    const tokenSymbol = tokenDisplaySymbol(token);
                    const tokenName = tokenMetadataName(token);
                    const logoUri = tokenLogoUri(token);
                    const usesSolanaLogo = logoUri === SOLANA_TOKEN_LOGO_URI;
                    return (
                      <div
                        key={token.account}
                        className="flex gap-3 border-b border-white/10 bg-transparent px-1 py-3 transition-colors hover:bg-white/5 focus-within:bg-white/5 lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:rounded-xl lg:border lg:bg-white/10 lg:p-4 lg:hover:bg-white/15 lg:focus-within:bg-white/15"
                      >
                        <button
                          type="button"
                          onClick={() => openTokenActions(token)}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left lg:gap-4"
                        >
                          <span
                            className={`relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold text-white ring-1 ring-white/15 lg:h-14 lg:w-14 ${usesSolanaLogo ? "bg-black p-2" : ""}`}
                            style={usesSolanaLogo ? undefined : { background: `linear-gradient(135deg, ${colors.from}, ${colors.to})` }}
                          >
                            {logoUri ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={logoUri}
                                alt=""
                                className={`h-full w-full ${usesSolanaLogo ? "object-contain" : "object-cover"}`}
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <span>{tokenAvatarText(token)}</span>
                            )}
                          </span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-base font-semibold">{tokenSymbol}</p>
                              {tokenName && (
                                <span
                                  className="max-w-[18rem] truncate rounded-md bg-white/10 px-2 py-0.5 text-xs text-gray-300"
                                  title={tokenName}
                                >
                                  {tokenName}
                                </span>
                              )}
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                              <span className="hidden max-w-full truncate font-mono lg:block" title={token.mint}>
                                {token.mint}
                              </span>
                            </div>
                          </div>
                        </button>
                        <div className="flex shrink-0 items-center justify-end gap-3">
                          <div className="text-right">
                            <p className="text-lg font-semibold">{token.ui_amount_string}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(token.mint, `token-mint:${token.account}`)}
                            className="hidden h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white lg:inline-flex"
                            title={t("features.token-actions.copyMint")}
                            aria-label={t("features.token-actions.copyMint")}
                          >
                            {copied === `token-mint:${token.account}` ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => openTokenActions(token)}
                            className="hidden h-9 items-center gap-1 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20 lg:inline-flex"
                          >
                            {t("features.wallet-list.actions")}
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {hiddenTokenCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setVisibleTokenCount((count) => count + TOKEN_ASSET_PAGE_SIZE)}
                      className="flex w-full items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-gray-200 hover:bg-white/10"
                    >
                      {t("features.wallet-list.loadMoreTokens", {
                        count: Math.min(TOKEN_ASSET_PAGE_SIZE, hiddenTokenCount),
                      })}
                    </button>
                  )}
                  {!assetsLoading && tokenAssets.length === 0 && (
                    <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.03] p-6 text-center text-sm text-gray-400">
                      {t("features.wallet-list.noTokens")}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {renderTransactionList(
                  currentTransactions,
                  () => void loadWalletTransactions(effectiveWallet, "append"),
                  t("features.wallet-list.noTransactions"),
                  t("features.wallet-list.transactionsLoadFailed"),
                  tokenSymbols,
                )}
              </div>
            )}
          </section>
        </div>
      );
    };

    const renderProgramWorkspacePanel = (showWorkspaceHeader = false) => (
      <div className="space-y-4">
        {showWorkspaceHeader && renderSquadsWorkspaceHeader()}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-300">{t("features.program-projects.title")}</h3>
            <button
              type="button"
              onClick={() => handleOpenForm("program-deploy")}
              className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
            >
              <FolderOpen className="h-4 w-4" />
              {t("features.program-projects.addProject")}
            </button>
          </div>
          {currentProgramProjects.length === 0 ? (
            <p className="text-xs text-gray-500">{t("features.program-projects.empty")}</p>
          ) : (() => {
            const project =
              currentProgramProjects.find((item) => item.id === selectedProgramProjectId) ||
              currentProgramProjects[0];
            const latestDirectPlan = project.plans.find((plan) => plan.kind === "direct-deploy");
            const latestDirectUpgradePlan = project.plans.find((plan) => plan.kind === "direct-upgrade");
            const latestUpgradePlan = project.plans.find((plan) => plan.kind === "squads-upgrade");
            const journalRecord =
              programDeploymentJournal.journal || programDeploymentJournal.conflictingJournal;
            const journalAttempts =
              programDeploymentJournal.journal
                ? programDeploymentJournal.deploymentAttempts
                : programDeploymentJournal.conflictingDeploymentAttempts;
            const journalDeploymentCard = journalRecord
              ? programDeploymentJournalToHistoryItem(
                  project,
                  journalRecord,
                  journalAttempts,
                  currentNetwork(project.network || effectiveNetwork),
                  journalRecord.status === "finalized" ? "finalized" : "running",
                )
              : null;
            const deploymentHistory = dedupeProgramDeploymentHistory(
              [...(project.history || [])].map((record) =>
                mergeProgramDeploymentHistoryWithJournal(record, journalDeploymentCard),
              ),
            ).sort((a, b) => b.createdAt - a.createdAt);
            const fallbackDeploymentCards = [latestDirectPlan, latestDirectUpgradePlan, latestUpgradePlan]
              .filter((plan): plan is ProgramDeploymentPlan => Boolean(plan))
              .filter((plan) => plan.status !== "draft" && plan.status !== "ready")
              .filter((plan) => {
                const planProgramId = plan.result?.programId || plan.programId || "";
                return !deploymentHistory.some((record) => {
                  const sameProgram = !planProgramId || !record.programId || record.programId === planProgramId;
                  const sameKind = plan.kind === "direct-deploy"
                    ? record.kind === "direct-deploy"
                    : plan.kind === "direct-upgrade"
                      ? record.kind === "direct-upgrade"
                      : record.kind.startsWith("squads-upgrade");
                  return sameProgram && sameKind;
                });
              })
              .map((plan): ProgramDeploymentHistoryItem => ({
                id: `plan-card:${plan.id}`,
                projectId: project.id,
                kind: plan.kind === "direct-deploy"
                  ? "direct-deploy"
                  : plan.kind === "direct-upgrade"
                    ? "direct-upgrade"
                  : plan.proposal
                    ? "squads-upgrade-proposal"
                    : "squads-upgrade-buffer",
                status: plan.status,
                network: plan.network,
                sourceDir: project.sourceDir,
                programId: plan.result?.programId || plan.programId,
                programdataAddress: plan.result?.programdataAddress,
                upgradeAuthority: plan.result?.authority || plan.upgradeAuthority,
                multisig: plan.multisig,
                vault: plan.vault,
                bufferAddress: plan.result?.bufferAddress || plan.bufferAddress,
                proposal: plan.proposal,
                transactionIndex: plan.transactionIndex,
                programSha256: plan.result?.programSha256 || plan.programSha256,
                programBytes: plan.result?.programBytes || plan.programBytes,
                maxDataLen: plan.maxDataLen,
                deploySignature: plan.result?.deploySignature,
                createBufferSignature: plan.result?.createBufferSignature,
                receiptJson: plan.result?.receiptJson,
                receiptSha256: plan.result?.receiptSha256,
                deployedSlot: plan.result?.deployedSlot,
                finalizedSlot: plan.result?.finalizedSlot,
                readbackVerified: plan.result?.readbackVerified,
                createdAt: plan.createdAt,
                completedAt: plan.result?.completedAt,
              }));
            const journalFallbackCards =
              journalDeploymentCard &&
              !deploymentHistory.some((record) => record.id === journalDeploymentCard.id) &&
              !fallbackDeploymentCards.some((record) => record.id === journalDeploymentCard.id)
                ? [journalDeploymentCard]
                : [];
            const deploymentCards = [...deploymentHistory, ...fallbackDeploymentCards, ...journalFallbackCards]
              .filter((record) => !dismissedHistoryCardIds.includes(record.id))
              .sort(
              (a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt),
            );
            const projectJournalMatches = Boolean(
              latestDirectPlan?.programId &&
                latestDirectPlan.programSha256 &&
                programDeploymentJournal.journal?.program_id === latestDirectPlan.programId &&
                programDeploymentJournal.journal.program_sha256 === latestDirectPlan.programSha256,
            );
            const writeProgress = projectJournalMatches && programDeploymentJournal.writeChunkCount > 0
              ? Math.min(
                  programDeploymentJournal.writeChunkCount,
                  Math.max(
                    programDeploymentJournal.journal?.last_write_chunk_index === null ||
                      programDeploymentJournal.journal?.last_write_chunk_index === undefined
                      ? 0
                      : programDeploymentJournal.journal.last_write_chunk_index + 1,
                    programDeploymentJournal.journal?.completed_writes || 0,
                  ),
                )
              : 0;
            return (
              <div className="grid gap-4 xl:grid-cols-[17rem_minmax(0,1fr)] 2xl:grid-cols-[18rem_minmax(0,1fr)]">
                <aside className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
                      {t("features.program-projects.projectListTitle")}
                    </p>
                    <span className="rounded-full bg-black/30 px-2 py-0.5 text-xs text-gray-400">
                      {currentProgramProjects.length}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {currentProgramProjects.map((item) => {
                      const isSelected = item.id === project.id;
                      const itemHistoryCount = item.history?.length || 0;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setSelectedProgramProjectId(item.id)}
                          className={`w-full rounded-lg border p-3 text-left transition-colors ${
                            isSelected
                              ? "border-cyan-300/30 bg-cyan-300/10 text-white"
                              : "border-white/10 bg-black/20 text-gray-300 hover:bg-white/10"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold">{item.name}</p>
                              <p className="mt-1 truncate text-xs text-gray-500">{item.sourceDir}</p>
                            </div>
                            <span className="shrink-0 rounded bg-black/30 px-2 py-0.5 text-xs text-gray-400">
                              {itemHistoryCount}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1 text-xs text-gray-400">
                            <span className="rounded bg-black/30 px-2 py-0.5">{networkLabel(t, item.network)}</span>
                            {item.programId && (
                              <span className="rounded bg-black/30 px-2 py-0.5">{shortAddress(item.programId)}</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </aside>

                <div className="min-w-0 space-y-3">
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
                          {t("features.program-projects.selectedProjectTitle")}
                        </p>
                        <h4 className="mt-1 text-lg font-semibold text-gray-100">{project.name}</h4>
                        <code className="mt-1 block break-all text-xs text-gray-500">{project.sourceDir}</code>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-400">
                          <span className="rounded bg-black/30 px-2 py-1">{networkLabel(t, project.network)}</span>
                          {project.programBytes ? (
                            <span className="rounded bg-black/30 px-2 py-1">
                              {t("features.program-projects.programBytes", { bytes: project.programBytes })}
                            </span>
                          ) : null}
                          <span className="rounded bg-black/30 px-2 py-1">
                            {t("features.program-projects.historyCount", { count: deploymentHistory.length })}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 justify-start sm:justify-end">
                        <details data-close-on-outside className="relative">
                          <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-1 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20">
                            {t("features.workspace.actions")}
                            <ChevronDown className="h-3.5 w-3.5" />
                          </summary>
                          <div className="absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-xl">
                            {[
                              {
                                id: "deploy",
                                icon: <Plus className="h-3.5 w-3.5" />,
                                label: t("features.program-projects.openDeployPlan"),
                                onClick: () => openProgramProjectDeploy(project),
                              },
                              {
                                id: "direct-upgrade",
                                icon: <Upload className="h-3.5 w-3.5" />,
                                label: t("features.program-projects.openDirectUpgrade"),
                                onClick: () => openProgramProjectDirectUpgrade(project),
                              },
                              {
                                id: "invoke",
                                icon: <Send className="h-3.5 w-3.5" />,
                                label: t("features.program-projects.invokeProgram"),
                                onClick: () => openProgramInvoke(project),
                              },
                              {
                                id: "prepare-upgrade",
                                icon: <ShieldCheck className="h-3.5 w-3.5" />,
                                label: t("features.program-projects.prepareUpgradePlan"),
                                onClick: () => openProgramProjectPrepareUpgrade(project),
                              },
                              {
                                id: "upgrade-proposal",
                                icon: <ShieldCheck className="h-3.5 w-3.5" />,
                                label: t("features.program-projects.createUpgradeProposal"),
                                onClick: () => openProgramProjectUpgradeProposal(project, latestUpgradePlan),
                              },
                              {
                                id: "download-history",
                                icon: <Download className="h-3.5 w-3.5" />,
                                label: t("features.program-projects.downloadAllHistory"),
                                onClick: () =>
                                  void downloadFile(
                                    programProjectDeploymentHistoryToJson(project),
                                    `program-history-${safeFilename(project.name)}.json`,
                                  ),
                              },
                            ].map((action) => (
                              <button
                                key={action.id}
                                type="button"
                                onClick={() => {
                                  closeDropdownMenus();
                                  action.onClick();
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-200 hover:bg-white/10"
                              >
                                {action.icon}
                                {action.label}
                              </button>
                            ))}
                            <div className="my-1 border-t border-white/10" />
                            <button
                              type="button"
                              onClick={() => {
                                closeDropdownMenus();
                                if (!window.confirm(t("features.program-projects.removeConfirm", { name: project.name }))) return;
                                updateWorkspace((prev) => ({
                                  ...prev,
                                  programProjects: prev.programProjects.filter((item) => item.id !== project.id),
                                }));
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-200 hover:bg-red-500/10"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {t("features.program-projects.removeProject")}
                            </button>
                          </div>
                        </details>
                      </div>
                    </div>

                    {project.programId && (
                      <code className="mt-3 block break-all rounded bg-black/30 px-3 py-2 text-xs text-gray-300">
                        {project.programId}
                      </code>
                    )}
                    {project.programSha256 && (
                      <code className="mt-2 block break-all rounded bg-black/30 px-3 py-2 text-xs text-gray-500">
                        {project.programSha256}
                      </code>
                    )}
                  </div>

                  <div className="space-y-2 rounded-xl border border-cyan-300/15 bg-cyan-400/5 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-cyan-100">
                          {t("features.program-projects.historyTitle")}
                        </p>
                        <p className="mt-1 text-xs text-cyan-100/60">
                          {t("features.program-projects.historyHint", { count: deploymentCards.length })}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          void downloadFile(
                            programProjectDeploymentHistoryToJson(project),
                            `program-history-${safeFilename(project.name)}.json`,
                          )
                        }
                        className="inline-flex h-8 items-center gap-1 rounded-lg bg-white/10 px-2 text-xs font-semibold text-gray-200 hover:bg-white/20"
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t("features.program-projects.downloadAllHistory")}
                      </button>
                    </div>

                    {deploymentCards.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-white/10 bg-black/20 p-6 text-center text-sm text-gray-400">
                        {t("features.program-projects.historyEmpty")}
                      </div>
                    ) : (
                      <div className="grid gap-3 2xl:grid-cols-2">
                        {deploymentCards.map((record) => {
                          const signature = programDeploymentHistorySignature(record);
                          const canResumeDirectDeploy =
                            record.kind === "direct-deploy" &&
                            isUnfinishedProgramDeploymentStatus(record.status);
                          const resumeDeployLabel =
                            record.status === "failed"
                              ? t("features.program-projects.redeployRecord")
                              : t("features.program-projects.continueDeployment");
                          const statusTone =
                            record.status === "finalized"
                              ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-200"
                              : record.status === "failed"
                                ? "border-red-300/25 bg-red-500/10 text-red-200"
                                : record.status === "running"
                                  ? "border-cyan-300/25 bg-cyan-400/10 text-cyan-100"
                                  : "border-amber-300/25 bg-amber-400/10 text-amber-100";
                          const StatusIcon =
                            record.status === "finalized"
                              ? CheckCircle2
                              : record.status === "failed"
                                ? XCircle
                                : record.status === "running"
                                  ? RefreshCw
                                  : AlertTriangle;
                          const recordFields = [
                            record.programId
                              ? [t("features.program-deploy.programId"), record.programId]
                              : null,
                            record.programdataAddress
                              ? [t("features.program-projects.programdata"), record.programdataAddress]
                              : null,
                            record.programSha256
                              ? [t("features.program-deploy.programSha256"), record.programSha256]
                              : null,
                            record.programBytes
                              ? [t("features.program-projects.programBytes", { bytes: record.programBytes }), ""]
                              : null,
                            record.maxDataLen
                              ? [t("features.program-deploy.maxDataLen"), String(record.maxDataLen)]
                              : null,
                            record.upgradeAuthority
                              ? [t("features.program-deploy.authority"), record.upgradeAuthority]
                              : null,
                            record.multisig
                              ? [t("features.squads.multisig"), record.multisig]
                              : null,
                            record.vault
                              ? [t("features.squads.vault"), record.vault]
                              : null,
                            record.bufferAddress
                              ? [t("features.squads.buffer"), record.bufferAddress]
                              : null,
                            record.proposal
                              ? [t("features.squads.proposal"), record.proposal]
                              : null,
                            record.transactionIndex
                              ? [t("features.squads.transactionIndex"), record.transactionIndex]
                              : null,
                            record.deployedSlot !== undefined
                              ? [t("features.program-deploy.deployedSlot"), String(record.deployedSlot)]
                              : null,
                            record.finalizedSlot !== undefined
                              ? [t("features.program-deploy.finalizedSlot"), String(record.finalizedSlot)]
                              : null,
                            record.readbackVerified !== undefined
                              ? [
                                  t("features.program-deploy.readbackVerification"),
                                  record.readbackVerified
                                    ? t("features.program-deploy.readbackPassed")
                                    : t("features.program-deploy.readbackFailed"),
                                ]
                              : null,
                            record.createBufferSignature
                              ? [t("features.program-deploy.createBufferSignature"), record.createBufferSignature]
                              : null,
                            record.authoritySignature
                              ? [t("features.program-projects.authoritySignature"), record.authoritySignature]
                              : null,
                            record.deploySignature
                              ? [t("features.program-projects.deploySignature"), record.deploySignature]
                              : null,
                            record.signature
                              ? [t("features.program-projects.signature"), record.signature]
                              : null,
                          ].filter((field): field is [string, string] => Boolean(field));
                          const summaryAddress =
                            record.programId || record.bufferAddress || record.proposal || signature || "";
                          return (
                            <details
                              key={record.id}
                              className={`group rounded-xl border p-3 ${
                                record.status === "finalized"
                                  ? "border-emerald-300/15 bg-emerald-400/[0.04]"
                                  : record.status === "failed"
                                    ? "border-red-300/15 bg-red-500/[0.04]"
                                    : "border-white/10 bg-black/25"
                              }`}
                            >
                              <summary className="flex cursor-pointer list-none flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex min-w-0 flex-1 items-start gap-3">
                                  <span className="mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10 text-gray-300 group-open:bg-cyan-300/10 group-open:text-cyan-100">
                                    <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
                                  </span>
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="rounded-lg bg-cyan-300/10 px-2.5 py-1 text-xs font-semibold text-cyan-100">
                                        {t(`features.program-projects.historyKinds.${record.kind}`)}
                                      </span>
                                      <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${statusTone}`}>
                                        <StatusIcon
                                          className={`h-3.5 w-3.5 ${
                                            record.status === "running" ? "animate-spin" : ""
                                          }`}
                                        />
                                        {t(`features.program-projects.planStatuses.${record.status}`)}
                                      </span>
                                      {summaryAddress && (
                                        <span className="rounded-lg bg-black/30 px-2.5 py-1 font-mono text-xs text-gray-400">
                                          {shortSignature(summaryAddress)}
                                        </span>
                                      )}
                                    </div>
                                    <p className="mt-1 truncate text-sm font-semibold text-gray-100">
                                      {record.completedAt
                                        ? t("features.program-projects.recordCompletedAt", {
                                            time: new Date(record.completedAt).toLocaleString(),
                                          })
                                        : t("features.program-projects.recordCreatedAt", {
                                            time: new Date(record.createdAt).toLocaleString(),
                                          })}
                                    </p>
                                  </div>
                                </div>
                              </summary>
                              {recordFields.length > 0 && (
                                <div className="mt-4 grid gap-2 md:grid-cols-2">
                                  {recordFields.map(([label, value]) => (
                                    <div key={`${record.id}:${label}`} className="rounded-lg bg-black/25 px-3 py-2">
                                      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                                        {label}
                                      </p>
                                      {value ? (
                                        <button
                                          type="button"
                                          onClick={() => copyToClipboard(value, `program-history-field:${record.id}:${label}`)}
                                          className="mt-1 block max-w-full truncate text-left font-mono text-xs text-gray-300 hover:text-white"
                                          title={value}
                                        >
                                          {copied === `program-history-field:${record.id}:${label}`
                                            ? t("common.copied")
                                            : value}
                                        </button>
                                      ) : (
                                        <p className="mt-1 text-xs text-gray-300">{label}</p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3">
                                {canResumeDirectDeploy && (
                                  <button
                                    type="button"
                                    onClick={() => openProgramDeploymentRecord(project, record)}
                                    className="inline-flex h-8 items-center gap-1 rounded-lg bg-cyan-400/15 px-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/25"
                                  >
                                    {record.status === "failed" ? (
                                      <RefreshCw className="h-3.5 w-3.5" />
                                    ) : (
                                      <ArrowRightLeft className="h-3.5 w-3.5" />
                                    )}
                                    {resumeDeployLabel}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() =>
                                    void downloadFile(
                                      programDeploymentHistoryToJson(record),
                                      programDeploymentHistoryFilename(record),
                                    )
                                  }
                                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-white/10 px-2 text-xs hover:bg-white/20"
                                >
                                  <Download className="h-3.5 w-3.5" />
                                  {t("features.program-projects.downloadRecordJson")}
                                </button>
                                {record.receiptJson && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void downloadFile(
                                        compactProgramDeploymentReceiptJson(record),
                                        deploymentReceiptFilename(record.programId),
                                      )
                                    }
                                    className="inline-flex h-8 items-center gap-1 rounded-lg bg-white/10 px-2 text-xs hover:bg-white/20"
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                    {t("features.program-projects.downloadReceipt")}
                                  </button>
                                )}
                                {signature && (
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(signature, `program-history-signature:${record.id}`)}
                                    className="inline-flex h-8 items-center gap-1 rounded-lg bg-white/10 px-2 text-xs hover:bg-white/20"
                                  >
                                    {copied === `program-history-signature:${record.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                    {t("features.program-projects.copySignature")}
                                  </button>
                                )}
                                {record.programId && (
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(record.programId || "", `program-history-id:${record.id}`)}
                                    className="inline-flex h-8 items-center gap-1 rounded-lg bg-white/10 px-2 text-xs hover:bg-white/20"
                                  >
                                    {copied === `program-history-id:${record.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                    {t("features.program-projects.copyProgramId")}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    requestRemoveProgramDeploymentHistoryRecord(project.id, record.id);
                                  }}
                                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-red-500/10 px-2 text-xs font-semibold text-red-200 hover:bg-red-500/20"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  {t("features.program-projects.removeHistoryRecord")}
                                </button>
                              </div>
                            </details>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {projectJournalMatches && programDeploymentJournal.writeChunkCount > 0 && (
                    <p className="text-xs text-cyan-200">
                      {t("features.program-projects.journalProgress", {
                        completed: writeProgress,
                        total: programDeploymentJournal.writeChunkCount,
                        status: programDeploymentJournal.journal?.status || "-",
                      })}
                    </p>
                  )}
                </div>
              </div>
            );
          })()}
        </section>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">{t("features.workspace.savedPrograms")}</h3>
          {currentPrograms.length === 0 ? (
            <p className="text-xs text-gray-500">{t("features.workspace.emptyPrograms")}</p>
          ) : currentPrograms.map((item) => (
            <div key={`${item.network}-${item.address}`} className="p-3 bg-white/5 border border-white/10 rounded-lg space-y-3">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{workspaceLabel(item.label, item.address)}</p>
                  <code className="block text-xs text-gray-400 break-all">{item.address}</code>
                </div>
                <details data-close-on-outside className="relative shrink-0">
                  <summary
                    className="inline-flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-lg bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white"
                    title={t("features.workspace.actions")}
                    aria-label={t("features.workspace.actions")}
                  >
                    <Menu className="h-4 w-4" />
                  </summary>
                  <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-xl">
                    {[
                      { id: "info", label: t("features.program-info.queryButton"), onClick: () => handleOpenForm("program-info", { programId: item.address, network: item.network }) },
                      { id: "remove", label: t("features.workspace.remove"), onClick: () => removeWorkspaceItem("programs", item.address, item.network) },
                    ].map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        onClick={() => {
                          action.onClick();
                          closeDropdownMenus();
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-white/10"
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </details>
              </div>
            </div>
          ))}
        </div>
      </div>
    );

    const renderNonceCreateForm = () => {
      const nonceAuth = walletAuth("create-nonce");
      return (
        <div className="space-y-4">
          <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
            <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
            <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
              <button type="button"
                onClick={() => {
                  setAuthMethod({ ...authMethod, "create-nonce": "keystore" });
                  const newFormData = { ...formData };
                  delete newFormData.private_key;
                  delete newFormData.encrypted_key;
                  setFormData(newFormData);
                }}
                className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                  nonceAuth === "keystore"
                    ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                    : "bg-white/5 text-gray-400 hover:bg-white/10"
                }`}
              >
                {t("formUi.tabKeystore")}
              </button>
              <button type="button"
                onClick={() => {
                  setAuthMethod({ ...authMethod, "create-nonce": "encrypted" });
                  const newFormData = { ...formData };
                  delete newFormData.private_key;
                  delete newFormData.keystoreJson;
                  setFormData(newFormData);
                }}
                className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                  nonceAuth === "encrypted"
                    ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                    : "bg-white/5 text-gray-400 hover:bg-white/10"
                }`}
              >
                {t("formUi.tabEncrypted")}
              </button>
              <button type="button"
                onClick={() => {
                  setAuthMethod({ ...authMethod, "create-nonce": "private" });
                  const newFormData = { ...formData };
                  delete newFormData.keystoreJson;
                  delete newFormData.encrypted_key;
                  delete newFormData.password;
                  setFormData(newFormData);
                }}
                className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                  nonceAuth === "private"
                    ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                    : "bg-white/5 text-gray-400 hover:bg-white/10"
                }`}
              >
                {t("formUi.tabPrivateKey")}
              </button>
            </div>
          </div>

          {nonceAuth === "keystore" && (
            <div className={formData.wallet_id ? "hidden" : undefined}>
              <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
              <input
                key={`create-nonce-${nonceAuth}`}
                type="file"
                accept=".json,application/json"
                onChange={handleFileUpload}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
              />
              {formData.keystoreJson && (
                <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
              )}
            </div>
          )}

          {ALLOW_DIRECT_SECRET_INPUT && nonceAuth === "encrypted" && (
            <div>
              <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
              <textarea
                value={formData.encrypted_key || ""}
                onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                placeholder={t("formUi.placeholderEncryptedKey")}
              />
            </div>
          )}

          {ALLOW_DIRECT_SECRET_INPUT && nonceAuth === "private" && (
            <div>
              <label className="block text-sm font-medium mb-2">{t("formUi.privateKey")}</label>
              <input
                type="password"
                value={formData.private_key || ""}
                onChange={(e) => handleFormChange("private_key", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("formUi.placeholderPrivateKeyBase58")}
              />
              <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-2">{t("features.create-nonce.count")}</label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={formData.count ?? 1}
              onChange={(e) => handleFormChange("count", e.target.value.replace(/[^\d]/g, ""))}
              className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
              placeholder={t("features.create-nonce.countPlaceholder")}
            />
            <p className="mt-1 text-xs text-gray-500">{t("features.create-nonce.countHint")}</p>
          </div>

          <button type="button"
            onClick={() => requestPasswordSubmit("create-nonce")}
            disabled={loading}
            className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
          >
            {loading ? t("features.create-nonce.creating") : t("features.create-nonce.createButton")}
          </button>
        </div>
      );
    };

    const renderNonceCreateResult = () => (
      <>
        {createdNonceAccounts.length > 0 && (
          <div className="space-y-3 rounded-lg bg-white/5 p-4">
            <label className="block text-sm font-medium">{t("features.create-nonce.createdAccounts")}</label>
            {createdNonceAccounts.map((item, index) => (
              <div key={`${item.nonce_account}-${index}`} className="rounded-lg bg-black/30 p-3">
                <div className="flex gap-2">
                  <code className="flex-1 text-xs break-all">{item.nonce_account}</code>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(String(item.nonce_account ?? ""), `nonce-created:${index}`)}
                    className="rounded bg-white/10 px-2 py-1 transition-colors hover:bg-white/20"
                  >
                    {copied === `nonce-created:${index}` ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-2 break-all font-mono text-xs text-gray-500">{item.signature}</p>
              </div>
            ))}
          </div>
        )}
        {createdNonceAccounts.length === 0 && formData.signature && (
          <div className="space-y-3 rounded-lg bg-white/5 p-4">
            <div>
              <label className="mb-2 block text-sm font-medium">{t("features.create-nonce.nonceAccount")}</label>
              <div className="flex gap-2">
                <code className="flex-1 rounded bg-black/30 px-3 py-2 text-xs break-all">
                  {formData.nonceAccount}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(formData.nonceAccount as string, "nonce-addr")}
                  className="rounded bg-white/10 px-3 py-2 transition-colors hover:bg-white/20"
                >
                  {copied === "nonce-addr" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium">{t("formUi.txSignature")}</label>
              <div className="flex gap-2">
                <code className="flex-1 rounded bg-black/30 px-3 py-2 text-xs break-all">
                  {formData.signature}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(formData.signature as string, "nonce-sig")}
                  className="rounded bg-white/10 px-3 py-2 transition-colors hover:bg-white/20"
                >
                  {copied === "nonce-sig" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );

    const renderNonceAccountList = () => {
      const currentNonceAccounts =
        effectiveWallet &&
        nonceAccounts?.owner === effectiveWallet.public_key &&
        nonceAccounts.network === effectiveNetwork
          ? nonceAccounts.nonceAccounts
          : [];
      const nonceLoading =
        effectiveWallet &&
        nonceAccounts?.owner === effectiveWallet.public_key &&
        nonceAccounts.network === effectiveNetwork &&
        nonceAccounts.loading;
      const nonceError =
        effectiveWallet &&
        nonceAccounts?.owner === effectiveWallet.public_key &&
        nonceAccounts.network === effectiveNetwork
          ? nonceAccounts.error
          : undefined;

      return (
        <div className="space-y-4">
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => void loadNonceAccounts(effectiveWallet, { force: true })}
              className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
            >
              <RefreshCw className={`h-4 w-4 ${nonceLoading ? "animate-spin" : ""}`} />
              {t("features.create-nonce.refreshAccounts")}
            </button>
            <button
              type="button"
              onClick={openNonceCreateDialog}
              disabled={!effectiveWallet}
              className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-black hover:bg-gray-200 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {t("features.create-nonce.createButton")}
            </button>
          </div>

          {!effectiveWallet && (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-6 text-center text-sm text-gray-400">
              {t("features.walletContext.importHint")}
            </div>
          )}
          {nonceError && (
            <p className="text-sm text-yellow-200">{nonceError}</p>
          )}
          {currentNonceAccounts.length > 0 ? (
            <div className="space-y-3">
              {currentNonceAccounts.map((item) => (
                <div key={item.id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-200">{t("features.create-nonce.nonceAccount")}</p>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(item.nonce_account, `nonce-saved:${item.id}`)}
                        className="mt-2 block max-w-full truncate text-left font-mono text-xs text-gray-300 hover:text-white"
                      >
                        {item.nonce_account}
                      </button>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(item.signature, `nonce-signature:${item.id}`)}
                        className="mt-2 block max-w-full truncate text-left font-mono text-xs text-gray-500 hover:text-white"
                      >
                        {item.signature}
                      </button>
                    </div>
                    <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-gray-300">
                      {effectiveRpcLabel}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : effectiveWallet && !nonceLoading ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-6 text-center text-sm text-gray-400">
              {t("features.create-nonce.noSavedAccounts")}
            </div>
          ) : null}
        </div>
      );
    };

    const currentMultisigs = workspace.multisigs.filter(
      (item) => item.network === currentNetwork(effectiveNetwork),
    );
    const currentPrograms = workspace.programs.filter(
      (item) => item.network === currentNetwork(effectiveNetwork) && isActiveProgramWorkspaceActor(item),
    );
    const currentProposals = workspace.proposals.filter(
      (item) => item.network === currentNetwork(effectiveNetwork),
    );
    const currentProgramProjects = workspace.programProjects.filter(
      (item) => item.network === currentNetwork(effectiveNetwork) && isActiveProgramWorkspaceActor(item),
    );

    const activeProgramArtifactForProject = (project: ProgramProject): FormState =>
      String(formData.programSourceDir || "").trim() === project.sourceDir
        ? {
            programSoBase64: formData.programSoBase64,
            programSoName: formData.programSoName,
            programSoSize: formData.programSoSize,
            programSoSha256: formData.programSoSha256,
          }
        : {};

    const openProgramProjectDeploy = (project: ProgramProject) => {
      const plannedUpgradeAuthority = project.upgradeAuthority || effectiveWallet?.public_key;
      const deploymentPlanWalletId =
        wallets.find((wallet) => wallet.public_key === plannedUpgradeAuthority)?.id || effectiveWalletId;
      handleOpenForm("program-deploy", {
        wallet_id: deploymentPlanWalletId,
        network: project.network,
        programSourceDir: project.sourceDir,
        expectedUpgradeAuthority: plannedUpgradeAuthority,
      });
      autoReadProgramProjectSource(project.sourceDir);
    };

    const openProgramProjectDirectUpgrade = (project: ProgramProject) => {
      const plannedUpgradeAuthority = project.upgradeAuthority || effectiveWallet?.public_key;
      const upgradeWalletId =
        wallets.find((wallet) => wallet.public_key === plannedUpgradeAuthority)?.id || effectiveWalletId;
      // Do not seed the previous deploy/upgrade artifact into the form.
      // Re-read from disk, then warn/block if SHA still matches the last finalized build.
      handleOpenForm("program-upgrade", {
        wallet_id: upgradeWalletId,
        network: project.network,
        programSourceDir: project.sourceDir,
        // Do not seed a cached project.programId here — it may be a stale
        // workspace address (e.g. old EtKkk…). Source import fills programId
        // from target/deploy/<name>-keypair.json.
        expectedUpgradeAuthority: plannedUpgradeAuthority,
      });
      autoReadProgramProjectSource(project.sourceDir);
    };

    const openProgramDeploymentRecord = (
      project: ProgramProject,
      record: ProgramDeploymentHistoryItem,
    ) => {
      const plannedUpgradeAuthority =
        record.upgradeAuthority || project.upgradeAuthority || effectiveWallet?.public_key;
      const deploymentPlanWalletId =
        wallets.find((wallet) => wallet.public_key === plannedUpgradeAuthority)?.id || effectiveWalletId;
      handleOpenForm("program-deploy", {
        wallet_id: deploymentPlanWalletId,
        network: record.network || project.network,
        programSourceDir: record.sourceDir || project.sourceDir,
        expectedUpgradeAuthority: plannedUpgradeAuthority,
        programSoName: project.programSoName,
        programSoSize: record.programBytes || project.programBytes,
        programSoSha256: record.programSha256 || project.programSha256,
        expectedProgramId: record.programId,
        max_data_len: record.maxDataLen ? String(record.maxDataLen) : undefined,
        resumeBufferAddress: record.bufferAddress,
        ...activeProgramArtifactForProject(project),
      });
      autoReadProgramProjectSource(record.sourceDir || project.sourceDir);
    };

    const openProgramProjectPrepareUpgrade = (project: ProgramProject) => {
      const multisig = project.multisig || currentMultisigs[0]?.address || "";
      handleOpenForm("squads-prepare-upgrade-buffer", {
        wallet_id: effectiveWalletId,
        network: project.network,
        programSourceDir: project.sourceDir,
        multisig,
        programId: project.programId,
        expectedProgramId: project.programId,
        programSoName: project.programSoName,
        programSoSize: project.programBytes,
        programSoSha256: project.programSha256,
        ...activeProgramArtifactForProject(project),
      });
      autoReadProgramProjectSource(project.sourceDir);
    };

    const openProgramProjectUpgradeProposal = (project: ProgramProject, plan?: ProgramDeploymentPlan) => {
      const multisig = plan?.multisig || project.multisig || currentMultisigs[0]?.address || "";
      handleOpenForm("squads-program-upgrade", {
        wallet_id: effectiveWalletId,
        network: project.network,
        programSourceDir: project.sourceDir,
        multisig,
        programId: plan?.programId || project.programId,
        bufferAddress: plan?.bufferAddress,
        programSoSha256: plan?.programSha256 || project.programSha256,
        programSoSize: plan?.programBytes || project.programBytes,
      });
    };

    const renderSavedMultisigPicker = (field = "multisig") => (
      currentMultisigs.length > 0 ? (
        <div>
          <label className="block text-sm font-medium mb-2">{t("features.workspace.savedMultisigs")}</label>
          <select
            value={String(formData[field] ?? "")}
            onChange={(e) => handleFormChange(field, e.target.value || undefined)}
            className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
          >
            <option value="">{t("features.workspace.selectSavedMultisig")}</option>
            {currentMultisigs.map((item) => (
              <option key={`${item.network}-${item.address}`} value={item.address}>
                {workspaceLabel(item.label, item.address)}
              </option>
            ))}
          </select>
        </div>
      ) : null
    );

    const renderTokenMintInfo = () => {
      const mint = String(formData.mint ?? "").trim();
      if (!mint || !tokenMintInfo || tokenMintInfo.mint !== mint || tokenMintInfo.loading) {
        return null;
      }
      if (tokenMintInfo.error) {
        return (
          <p className="mt-2 text-xs text-red-300">
            {t("features.transfer-token.mintInfoErrorDetail", { message: tokenMintInfo.error })}
          </p>
        );
      }
      return null;
    };

    const renderMultisigInput = () => (
      <div className="space-y-2">
        {renderSavedMultisigPicker("multisig")}
        <div>
          <label className="block text-sm font-medium mb-2">{t("features.squads.multisig")}</label>
          <div className="flex gap-2">
            <input
              value={formData.multisig || ""}
              onChange={(e) => handleFormChange("multisig", e.target.value)}
              className="flex-1 px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
              placeholder={t("features.squads.multisigPlaceholder")}
            />
            <button
              type="button"
              onClick={() => saveWorkspaceMultisig(formData.multisig, formData.vault)}
              disabled={!formData.multisig}
              className="px-3 py-2 bg-white/10 rounded-lg hover:bg-white/20 transition-colors disabled:opacity-40"
            >
              {t("features.workspace.save")}
            </button>
          </div>
        </div>
      </div>
    );

    const renderProposalInput = () => (
      <div className="space-y-2">
        {currentProposals.length > 0 && (
          <div>
            <label className="block text-sm font-medium mb-2">{t("features.workspace.savedProposals")}</label>
            <select
              value={String(formData.proposal ?? "")}
              onChange={(e) => {
                const selected = currentProposals.find((item) => item.address === e.target.value);
                handleFormChange("proposal", e.target.value || undefined);
                if (selected) {
                  handleFormChange("multisig", selected.multisig);
                  handleFormChange("transactionIndex", selected.transactionIndex);
                }
              }}
              className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
            >
              <option value="">{t("features.workspace.selectSavedProposal")}</option>
              {currentProposals.map((item) => (
                <option key={`${item.network}-${item.address}`} value={item.address}>
                  {`${item.kind || "proposal"} #${item.transactionIndex || "-"} - ${item.status || "unknown"}`}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="block text-sm font-medium mb-2">{t("features.squads.proposal")}</label>
          <input
            value={formData.proposal || ""}
            onChange={(e) => handleFormChange("proposal", e.target.value)}
            className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
            placeholder={t("features.squads.proposalPlaceholder")}
          />
        </div>
      </div>
    );

    const renderProgramIdInput = () => (
      <div className="space-y-2">
        {currentPrograms.length > 0 && (
          <div>
            <label className="block text-sm font-medium mb-2">{t("features.workspace.savedPrograms")}</label>
            <select
              value={String(formData.programId ?? "")}
              onChange={(e) => handleFormChange("programId", e.target.value || undefined)}
              className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
            >
              <option value="">{t("features.workspace.selectSavedProgram")}</option>
              {currentPrograms.map((item) => (
                <option key={`${item.network}-${item.address}`} value={item.address}>
                  {workspaceLabel(item.label, item.address)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="block text-sm font-medium mb-2">{t("features.program-info.programId")}</label>
          <div className="flex gap-2">
            <input
              value={formData.programId || ""}
              onChange={(e) => handleFormChange("programId", e.target.value)}
              className="flex-1 px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
              placeholder={t("features.program-info.programIdPlaceholder")}
            />
            <button
              type="button"
              onClick={() => saveWorkspaceProgram(formData.programId)}
              disabled={!formData.programId}
              className="px-3 py-2 bg-white/10 rounded-lg hover:bg-white/20 transition-colors disabled:opacity-40"
            >
              {t("features.workspace.save")}
            </button>
          </div>
        </div>
      </div>
    );

    const renderBufferInput = () => (
      <div>
        <label className="block text-sm font-medium mb-2">{t("features.squads.buffer")}</label>
        <input
          value={formData.bufferAddress || ""}
          onChange={(e) => handleFormChange("bufferAddress", e.target.value)}
          className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
          placeholder={t("features.squads.bufferPlaceholder")}
        />
      </div>
    );

    const renderProgramDeployHelpLabel = (
      label: string,
      description: string,
      options: { compact?: boolean; inputId?: string; margin?: boolean } = {},
    ) => {
      const labelClassName = options.compact
        ? "min-w-0 text-xs text-gray-400"
        : "min-w-0 text-sm font-medium";
      const marginClassName = options.margin === false
        ? ""
        : options.compact
          ? "mb-1"
          : "mb-2";
      const labelElement = options.inputId ? (
        <label htmlFor={options.inputId} className={labelClassName}>
          {label}
        </label>
      ) : (
        <span className={labelClassName}>{label}</span>
      );

      return (
        <div className={`flex min-w-0 items-center gap-1.5 ${marginClassName}`}>
          {labelElement}
          <FieldHelp
            description={description}
            label={t("features.program-deploy.helpAriaLabel", { field: label })}
          />
        </div>
      );
    };

    const renderProgramSourceImport = () => (
      <section className="space-y-3 border-b border-white/10 pb-4">
        <div>
          {renderProgramDeployHelpLabel(
            t("features.program-deploy.sourceDir"),
            t("features.program-deploy.sourceDirTooltip"),
            { inputId: "program-source-dir" },
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
            <input
              id="program-source-dir"
              value={formData.programSourceDir || ""}
              onChange={(event) => handleFormChange("programSourceDir", event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="w-full min-w-0 px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
              placeholder={t("features.program-deploy.sourceDirPlaceholder")}
            />
            <button
              type="button"
              onClick={() => void handlePickProgramSourceDir()}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
              title={t("features.program-deploy.sourceDirPicker")}
              aria-label={t("features.program-deploy.sourceDirPicker")}
            >
              <FolderOpen className="h-4 w-4" />
              {t("features.program-deploy.sourceDirPicker")}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => void handleProgramSourceImport(false)}
            disabled={programSourceLoading || loading}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
          >
            {programSourceLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {t("features.program-deploy.sourceImportButton")}
          </button>
          <button
            type="button"
            onClick={() => void handleProgramSourceImport(true)}
            disabled={programSourceLoading || loading}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
          >
            {programSourceLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("features.program-deploy.sourceBuildButton")}
          </button>
        </div>
        {(formData.sourceBuildCommand || formData.sourceBuildTemplate || formData.sourceBuildBlockedReason || formData.sourceValidationErrors || formData.sourceImportWarnings) && (
          <div className="space-y-2 rounded-lg bg-black/30 p-3 text-xs text-gray-300">
            {formData.sourceBuildTemplate && (
              <p>
                {t("features.program-deploy.sourceBuildTemplate")}:{" "}
                <span>{formData.sourceBuildTemplate}</span>
              </p>
            )}
            {formData.sourceBuildCommand && (
              <p>
                {t("features.program-deploy.sourceBuildCommand")}:{" "}
                <code>{formData.sourceBuildCommand}</code>
              </p>
            )}
            {formData.sourceBuildBlockedReason && (
              <p className="text-yellow-300">{formData.sourceBuildBlockedReason}</p>
            )}
            {formData.sourceValidationErrors && (
              <div className="space-y-2 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-red-100">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-200" />
                    <p className="font-semibold">{t("features.program-deploy.sourceValidationTitle")}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(String(formData.sourceValidationErrors || ""), "program-source-validation-errors")}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-red-400/15 px-2 py-1 text-[11px] font-medium text-red-50 hover:bg-red-400/25"
                  >
                    {copied === "program-source-validation-errors" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {t("features.program-deploy.sourceValidationCopy")}
                  </button>
                </div>
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/40 p-2 font-mono text-[11px] leading-5 text-red-100">
                  {String(formData.sourceValidationErrors)}
                </pre>
              </div>
            )}
            {formData.sourceImportWarnings && (
              <p className="whitespace-pre-wrap text-yellow-300">{formData.sourceImportWarnings}</p>
            )}
          </div>
        )}
      </section>
    );

    const renderProgramFileInput = () => (
      <div>
        {renderProgramDeployHelpLabel(
          t("features.program-deploy.programFile"),
          t("features.program-deploy.programFileTooltip"),
          { inputId: "program-so-file" },
        )}
        <input
          id="program-so-file"
          ref={programSoInputRef}
          type="file"
          accept=".so,application/octet-stream"
          onChange={handleProgramFileUpload}
          className="hidden"
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => programSoInputRef.current?.click()}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20"
          >
            <Upload className="h-4 w-4" />
            {t("features.program-deploy.chooseProgramFile")}
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">
            {formData.programSoName ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />
            ) : (
              <Upload className="h-4 w-4 shrink-0 text-gray-500" />
            )}
            <span className={formData.programSoName ? "min-w-0 truncate text-green-300" : "min-w-0 truncate text-gray-500"}>
              {formData.programSoName
                ? t("features.program-deploy.fileReady", {
                    filename: String(formData.programSoName),
                    size: String(formData.programSoSize || 0),
                  })
                : t("features.program-deploy.noProgramFileSelected")}
            </span>
          </div>
        </div>
        {formData.programSoName && (
          <div className="mt-2 space-y-2">
            {formData.programSoSha256 && (
              <div>
                {renderProgramDeployHelpLabel(
                  t("features.program-deploy.uploadedProgramSha256"),
                  t("features.program-deploy.uploadedProgramSha256Tooltip"),
                  { compact: true },
                )}
                <div className="flex gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-black/30 px-3 py-2 text-xs">
                    {formData.programSoSha256}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(String(formData.programSoSha256), "uploaded-program-sha256")}
                    className="shrink-0 rounded bg-white/10 px-3 py-2 hover:bg-white/20"
                    aria-label={t("common.copy")}
                  >
                    {copied === "uploaded-program-sha256" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );

    const renderProgramKeypairFileInput = () => (
      <div>
        {renderProgramDeployHelpLabel(
          t("features.program-deploy.programKeypairFile"),
          t("features.program-deploy.programKeypairFileTooltip"),
          { inputId: "program-keypair-file" },
        )}
        <input
          id="program-keypair-file"
          ref={programKeypairInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleProgramKeypairFileUpload}
          className="hidden"
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => programKeypairInputRef.current?.click()}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20"
          >
            <Key className="h-4 w-4" />
            {t("features.program-deploy.chooseProgramKeypair")}
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm">
            {programKeypairMetadata ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />
            ) : (
              <Key className="h-4 w-4 shrink-0 text-gray-500" />
            )}
            <span className={programKeypairMetadata ? "min-w-0 flex-1 truncate text-green-300" : "min-w-0 flex-1 truncate text-gray-500"}>
              {programKeypairMetadata
                ? t("features.program-deploy.programKeypairReady", {
                    filename: programKeypairMetadata.filename,
                  })
                : t("features.program-deploy.noProgramKeypairSelected")}
            </span>
            {programKeypairMetadata && (
              <button
                type="button"
                onClick={clearProgramKeypairMaterial}
                className="shrink-0 rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white"
                aria-label={t("features.program-deploy.clearProgramKeypair")}
                title={t("features.program-deploy.clearProgramKeypair")}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleGenerateProgramKeypair()}
          disabled={programSourceLoading || loading || !String(formData.programSourceDir || "").trim()}
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
        >
          {programSourceLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Key className="h-4 w-4" />}
          {t("features.program-deploy.generateProgramKeypairButton")}
        </button>
        <p className="mt-2 text-xs text-gray-500">
          {t("features.program-deploy.generateProgramKeypairHint")}
        </p>
        {programKeypairMetadata && (
          <div className="mt-2 space-y-2">
            {formData.programKeypairPath && (
              <code className="block break-all rounded bg-black/30 px-3 py-2 text-xs text-gray-300">
                {formData.programKeypairPath}
              </code>
            )}
            <div>
              {renderProgramDeployHelpLabel(
                t("features.program-deploy.derivedProgramId"),
                t("features.program-deploy.derivedProgramIdTooltip"),
                { compact: true },
              )}
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-black/30 px-3 py-2 text-xs">
                  {programKeypairMetadata.programId}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(programKeypairMetadata.programId, "derived-program-id")}
                  className="shrink-0 rounded bg-white/10 px-3 py-2 hover:bg-white/20"
                  aria-label={t("common.copy")}
                >
                  {copied === "derived-program-id" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );

    const renderSpillInput = () => (
      <div>
        <label className="block text-sm font-medium mb-2">{t("features.squads.spill")}</label>
        <input
          value={formData.spillAddress || ""}
          onChange={(e) => handleFormChange("spillAddress", e.target.value)}
          className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
          placeholder={t("features.squads.spillPlaceholder")}
        />
      </div>
    );

    const renderMemoInput = () => (
      <div>
        <label className="block text-sm font-medium mb-2">{t("features.squads.memo")}</label>
        <input
          value={formData.memo || ""}
          onChange={(e) => handleFormChange("memo", e.target.value)}
          className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
          placeholder={t("features.squads.memoPlaceholder")}
        />
      </div>
    );

    const renderSquadsResult = () => {
      if (!formData.signature && !formData.vault && !formData.proposal) return null;
      return (
        <div className="space-y-3 p-4 bg-white/5 rounded-lg">
          {renderCopyRow("squads-multisig", t("features.squads.multisig"), formData.multisig)}
          {renderCopyRow("squads-vault", t("features.squads.vault"), formData.vault)}
          {renderCopyRow("squads-buffer", t("features.squads.buffer"), formData.bufferAddress)}
          {renderCopyRow("squads-proposal", t("features.squads.proposal"), formData.proposal)}
          {renderCopyRow("squads-transaction", t("features.squads.transaction"), formData.transaction)}
          {renderCopyRow("squads-programdata", t("features.program-info.programdataAddress"), formData.programdataAddress)}
          {renderCopyRow("squads-create-signature", t("features.squads.createSignature"), formData.createSignature)}
          {renderCopyRow("squads-authority-signature", t("features.squads.authoritySignature"), formData.authoritySignature)}
          {renderCopyRow("squads-signature", t("formUi.txSignature"), formData.signature)}
          {formData.transactionIndex && (
            <p className="text-xs text-gray-400">
              {t("features.squads.transactionIndexValue", { index: String(formData.transactionIndex) })}
            </p>
          )}
          {formData.creationFeeLamports && (
            <p className="text-xs text-gray-400">
              {t("features.squads-create.creationFee", { lamports: String(formData.creationFeeLamports) })}
            </p>
          )}
          {formData.writeCount && (
            <p className="text-xs text-gray-400">
              {t("features.squads-prepare-upgrade-buffer.stats", {
                writes: String(formData.writeCount || 0),
                bytes: String(formData.programBytes || 0),
                rent: String(formData.rentLamports || 0),
              })}
            </p>
          )}
        </div>
      );
    };

    const openSquadsWorkspace = () => {
      setSelectedForm("squads-workspace");
      setBackTarget(null);
      handleFormChange("network", effectiveNetwork);
    };

    const openSquadsPrograms = () => {
      setSelectedForm("squads-programs");
      setBackTarget(null);
      handleFormChange("network", effectiveNetwork);
    };

    const openSquadsProposals = () => {
      setSelectedForm("squads-proposals");
      setBackTarget(null);
      handleFormChange("network", effectiveNetwork);
    };

    const squadsActionButtonClass = (active: boolean) =>
      `px-3 py-2 rounded-lg text-sm border transition-colors ${
        active
          ? "bg-gradient-to-r from-purple-500 to-pink-500 border-pink-300/40 text-white font-semibold shadow-sm shadow-purple-950/40"
          : "bg-white/10 border-white/10 text-gray-300 hover:bg-white/20 hover:text-white"
      }`;

    const renderTransactionList = (
      state: WalletTransactionsState | null,
      loadMore: () => void,
      emptyText: string,
      errorFallback: string,
      tokenSymbols?: Map<string, string>,
    ) => {
      const items = state?.transactions ?? [];
      const isLoading = Boolean(state?.loading);
      const canLoadMore = Boolean(state?.hasMore && !isLoading && items.length < MAX_TRANSACTION_HISTORY);
      const groupedItems = items.reduce<Array<{ date: string; transactions: WalletTransactionRecord[] }>>(
        (groups, transaction) => {
          const date = formatTransactionDate(transaction.block_time);
          const group = groups.find((item) => item.date === date);
          if (group) {
            group.transactions.push(transaction);
          } else {
            groups.push({ date, transactions: [transaction] });
          }
          return groups;
        },
        [],
      );

      return (
        <div className="space-y-4">
          {state?.error && (
            <p className="text-sm text-yellow-200">
              {state.error || errorFallback}
            </p>
          )}
          {groupedItems.map((group) => (
            <div key={group.date} className="space-y-2">
              <h4 className="px-1 text-sm font-semibold text-gray-400">{group.date}</h4>
              {group.transactions.map((transaction) => {
                const failed = Boolean(transaction.err);
                const solscanUrl = solscanTransactionUrl(transaction.signature, state?.network ?? effectiveNetwork);
                const changes = transaction.changes ?? [];
                const primaryIn = changes.find((change) => change.direction === "in");
                const primaryOut = changes.find((change) => change.direction === "out");
                const actionKey = failed ? "failed" : transaction.action || "transaction";
                const actionLabel = t(`features.wallet-list.transactionAction.${actionKey}`);
                const subtitle =
                  transaction.summary ||
                  (transaction.counterparty
                    ? t("features.wallet-list.transactionTo", { address: shortAddress(transaction.counterparty) })
                    : shortSignature(transaction.signature));
                return (
                  <div key={transaction.signature} className="rounded-xl bg-white/10 p-4 hover:bg-white/15">
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-black/40 text-sm font-bold text-violet-200 ring-1 ring-white/10">
                        {failed ? "!" : transaction.action === "swap" ? <ArrowRightLeft className="h-5 w-5" /> : transaction.action === "receive" ? <Download className="h-5 w-5" /> : <Send className="h-5 w-5" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-base font-semibold text-gray-100">{actionLabel}</p>
                          {transaction.confirmation_status && (
                            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-gray-400">
                              {transaction.confirmation_status}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-sm text-gray-400">{subtitle}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        {primaryIn && (
                          <p className="text-base font-semibold text-emerald-300">{transactionAmountLabel(primaryIn, tokenSymbols)}</p>
                        )}
                        {primaryOut && (
                          <p className={primaryIn ? "mt-1 text-sm text-gray-200" : "text-base font-semibold text-gray-200"}>
                            {transactionAmountLabel(primaryOut, tokenSymbols)}
                          </p>
                        )}
                        {!primaryIn && !primaryOut && (
                          <p className="text-sm text-gray-400">{formatTransactionTime(transaction.block_time) || t("features.wallet-list.transactionUnknownAmount")}</p>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                      {transaction.counterparty && (
                        <span>{t("features.wallet-list.transactionCounterparty", { address: shortAddress(transaction.counterparty) })}</span>
                      )}
                      <span>{formatTransactionTime(transaction.block_time)}</span>
                      <span>{t("features.wallet-list.transactionSlot", { slot: transaction.slot })}</span>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(transaction.signature, `wallet-tx:${transaction.signature}`)}
                        className="font-mono hover:text-white"
                        title={transaction.signature}
                      >
                        {copied === `wallet-tx:${transaction.signature}` ? t("common.copied") : shortSignature(transaction.signature)}
                      </button>
                      <button
                        type="button"
                        onClick={() => void openExternalUrl(solscanUrl)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-white/10 text-gray-300 transition-colors hover:bg-white/20 hover:text-white"
                        title="Solscan"
                        aria-label="Open transaction in Solscan"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {transaction.memo && (
                      <p className="mt-2 text-xs text-gray-500">{transaction.memo}</p>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {!isLoading && items.length === 0 && (
            <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.03] p-6 text-center text-sm text-gray-400">
              {emptyText}
            </div>
          )}
          {(isLoading || canLoadMore) && (
            <button
              type="button"
              onClick={loadMore}
              disabled={isLoading}
              className="w-full rounded-lg bg-white/10 px-4 py-3 text-sm font-semibold text-gray-200 hover:bg-white/20 disabled:opacity-50"
            >
              {isLoading
                ? t("common.loading")
                : t("features.wallet-list.loadMoreTransactions", {
                    count: Math.min(TRANSACTION_PAGE_SIZE, MAX_TRANSACTION_HISTORY - items.length),
                  })}
            </button>
          )}
        </div>
      );
    };

    const renderSquadsWorkspaceHeader = () => (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={openSquadsWorkspace}
          className={squadsActionButtonClass(formId === "squads-workspace")}
        >
          {t("features.workspace.savedMultisigs")}
        </button>
        <button
          type="button"
          onClick={openSquadsProposals}
          className={squadsActionButtonClass(formId === "squads-proposals")}
        >
          {t("features.workspace.savedProposals")}
        </button>
        <button
          type="button"
          onClick={openSquadsPrograms}
          className={squadsActionButtonClass(formId === "squads-programs")}
        >
          {t("features.workspace.savedPrograms")}
        </button>
        <details data-close-on-outside className="relative ml-auto">
          <summary className="cursor-pointer list-none px-3 py-2 bg-white/10 rounded-lg text-sm hover:bg-white/20">
            {t("features.workspace.actions")}
          </summary>
          <div className="absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-xl">
            {[
              { id: "squads-create", label: t("features.squads-create.title"), onClick: () => handleOpenSquadsForm("squads-create") },
              { id: "squads-info", label: t("features.squads-info.title"), onClick: () => handleOpenSquadsForm("squads-info") },
              { id: "squads-sol-transfer", label: t("features.squads-sol-transfer.title"), onClick: () => handleOpenSquadsForm("squads-sol-transfer") },
              { id: "squads-token-transfer", label: t("features.squads-token-transfer.title"), onClick: () => handleOpenSquadsForm("squads-token-transfer") },
            ].map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => {
                  action.onClick();
                  closeDropdownMenus();
                }}
                className="block w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-white/10"
              >
                {action.label}
              </button>
            ))}
          </div>
        </details>
      </div>
    );

    const terminalProposalStatuses = new Set(["executed", "rejected", "cancelled"]);
    const activeProposals = currentProposals.filter(
      (item) => !terminalProposalStatuses.has(String(item.status || "").toLowerCase()),
    );
    const historicalProposals = currentProposals.filter(
      (item) => terminalProposalStatuses.has(String(item.status || "").toLowerCase()),
    );

    const renderStatusBadge = (status: string | undefined) => {
      const value = status || "unknown";
      const normalized = value.toLowerCase();
      const tone = normalized === "executed"
        ? "bg-green-500/15 text-green-300 border-green-400/20"
        : normalized === "rejected" || normalized === "cancelled"
          ? "bg-red-500/15 text-red-300 border-red-400/20"
          : "bg-yellow-500/15 text-yellow-200 border-yellow-400/20";
      return (
        <span className={`px-2 py-0.5 rounded border text-xs ${tone}`}>
          {value}
        </span>
      );
    };

    const renderProposalRecord = (item: WorkspaceProposal, showActions: boolean) => (
      <div key={`${item.network}-${item.address}`} className="p-3 bg-white/5 rounded-lg space-y-3">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{`${item.kind || "proposal"} #${item.transactionIndex || "-"}`}</p>
              {renderStatusBadge(item.status)}
            </div>
            <p className="text-xs text-gray-500">{t("features.workspace.proposalMultisig", { multisig: shortAddress(item.multisig) })}</p>
            {actorLabel(item) && (
              <p className="text-xs text-gray-500">{t("features.workspace.createdBy", { wallet: actorLabel(item) })}</p>
            )}
            <code className="block text-xs text-gray-400 break-all">{item.address}</code>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            {showActions && (
              <>
                <button type="button" onClick={() => requestProposalPasswordSubmit(item, "approve")} disabled={loading} className="px-2 py-1 bg-white/10 rounded text-xs hover:bg-white/20 disabled:opacity-40">
                  {t("features.squads-approve.approveButton")}
                </button>
                <button type="button" onClick={() => requestProposalPasswordSubmit(item, "reject")} disabled={loading} className="px-2 py-1 bg-white/10 rounded text-xs hover:bg-white/20 disabled:opacity-40">
                  {t("features.squads-reject.rejectButton")}
                </button>
                <button type="button" onClick={() => requestProposalPasswordSubmit(item, "execute")} disabled={loading} className="px-2 py-1 bg-white/10 rounded text-xs hover:bg-white/20 disabled:opacity-40">
                  {t("features.squads-execute.executeButton")}
                </button>
              </>
            )}
            <button type="button" onClick={() => removeWorkspaceItem("proposals", item.address, item.network)} className="px-2 py-1 bg-white/10 rounded text-xs hover:bg-white/20">
              {t("features.workspace.remove")}
            </button>
          </div>
        </div>
      </div>
    );

    const renderWorkspacePanel = () => (
      <div className="space-y-4">
        {renderSquadsWorkspaceHeader()}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-300">{t("features.workspace.savedMultisigs")}</h3>
            <span className="text-xs text-gray-500">{currentMultisigs.length}</span>
          </div>
          {currentMultisigs.length === 0 ? (
            <p className="text-xs text-gray-500">{t("features.workspace.emptyMultisigs")}</p>
          ) : currentMultisigs.map((item) => (
            <div key={`${item.network}-${item.address}`} className="p-3 bg-white/5 rounded-lg space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{workspaceLabel(item.label, item.address)}</p>
                  {actorLabel(item) && (
                    <p className="text-xs text-gray-500">{t("features.workspace.createdBy", { wallet: actorLabel(item) })}</p>
                  )}
                  <code className="block text-xs text-gray-400 break-all">{item.address}</code>
                </div>
                <details data-close-on-outside className="relative shrink-0">
                  <summary className="cursor-pointer list-none px-3 py-1.5 bg-white/10 rounded text-xs hover:bg-white/20">
                    {t("features.workspace.actions")}
                  </summary>
                  <div className="absolute right-0 z-20 mt-2 w-64 overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-xl">
                    {[
                      { id: "info", label: t("features.squads-info.queryButton"), onClick: () => handleOpenSquadsForm("squads-info", { multisig: item.address, network: item.network }) },
                      { id: "refresh", label: t("features.workspace.refresh"), onClick: () => void refreshWorkspaceProposals(item) },
                      { id: "sol", label: t("features.squads-sol-transfer.createButton"), onClick: () => handleOpenSquadsForm("squads-sol-transfer", { multisig: item.address, network: item.network }) },
                      { id: "token", label: t("features.squads-token-transfer.createButton"), onClick: () => handleOpenSquadsForm("squads-token-transfer", { multisig: item.address, network: item.network }) },
                      { id: "remove", label: t("features.workspace.remove"), onClick: () => removeWorkspaceItem("multisigs", item.address, item.network) },
                    ].map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        onClick={() => {
                          action.onClick();
                          closeDropdownMenus();
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-white/10"
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </details>
              </div>
            </div>
          ))}
        </div>
        {renderSquadsResult()}
      </div>
    );

    const renderProposalWorkspacePanel = () => (
      <div className="space-y-4">
        {renderSquadsWorkspaceHeader()}
        <div>
          <label className="block text-sm font-medium mb-2">{t("features.squads.memo")}</label>
          <input
            value={formData.memo || ""}
            onChange={(e) => handleFormChange("memo", e.target.value)}
            className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
            placeholder={t("features.workspace.voteMemoPlaceholder")}
          />
        </div>
        <button
          type="button"
          onClick={() => void refreshWorkspaceProposals()}
          className="px-3 py-2 bg-white/10 rounded-lg hover:bg-white/20 transition-colors"
        >
          {t("features.workspace.refreshProposals")}
        </button>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">{t("features.workspace.activeProposals")}</h3>
          {activeProposals.length === 0 ? (
            <p className="text-xs text-gray-500">{t("features.workspace.emptyActiveProposals")}</p>
          ) : activeProposals.map((item) => renderProposalRecord(item, true))}
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">{t("features.workspace.proposalHistory")}</h3>
          {historicalProposals.length === 0 ? (
            <p className="text-xs text-gray-500">{t("features.workspace.emptyProposalHistory")}</p>
          ) : historicalProposals.map((item) => renderProposalRecord(item, false))}
        </div>
        {renderSquadsResult()}
      </div>
    );

    const renderStepForm = (steps: Array<{ title: string; content: React.ReactNode }>) => {
      const rawStep = Number(formData.stepIndex || 0);
      const stepIndex = Number.isInteger(rawStep)
        ? Math.min(Math.max(rawStep, 0), steps.length - 1)
        : 0;

      return (
        <div className="space-y-4">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {steps.map((step, index) => (
              <button
                key={step.title}
                type="button"
                onClick={() => handleFormChange("stepIndex", index)}
                className={`min-w-[7rem] flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  index === stepIndex
                    ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                    : "bg-white/5 text-gray-400 hover:bg-white/10"
                }`}
              >
                {index + 1}. {step.title}
              </button>
            ))}
          </div>
          <div className="space-y-4">{steps[stepIndex]?.content}</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleFormChange("stepIndex", stepIndex - 1)}
              disabled={stepIndex === 0}
              className="px-3 py-2 bg-white/10 rounded-lg hover:bg-white/20 transition-colors disabled:opacity-40"
            >
              {t("features.workspace.prevStep")}
            </button>
            <button
              type="button"
              onClick={() => handleFormChange("stepIndex", stepIndex + 1)}
              disabled={stepIndex >= steps.length - 1}
              className="px-3 py-2 bg-white/10 rounded-lg hover:bg-white/20 transition-colors disabled:opacity-40"
            >
              {t("features.workspace.nextStep")}
            </button>
          </div>
        </div>
      );
    };

    const renderEvmWorkbench = () => (
      <div className="space-y-5">
        <section className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase text-emerald-300">{activeEvmChain?.name || t("features.wallet-list.currentPublicChain")}</p>
              <h2 className="text-2xl font-semibold text-white">{tf("features.evm-workbench.title", "Multi-chain Wallet")}</h2>
              <p className="mt-1 text-sm text-gray-400">
                {tf("features.evm-workbench.subtitle", "Ethereum, BNB Smart Chain, Polygon, Base, Arbitrum, and other supported public chains.")}
              </p>
            </div>
            <button type="button" onClick={() => void loadEvmChains()} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-gray-200 hover:bg-white/10">
              <RefreshCw className="h-4 w-4" />
              Refresh chains
            </button>
          </div>
          {evmError && <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">{evmError}</div>}
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <label className="space-y-1 text-sm text-gray-300">
              Chain
              <select
                value={evmChainId}
                onChange={(event) => selectEvmChain(event.target.value)}
                className="h-10 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none"
              >
                {evmChains.map((chain) => (
                  <option key={chain.chain_id} value={chain.chain_id}>
                    {chain.name} ({chain.chain_id}) {chain.testnet ? "testnet" : "mainnet"}
                  </option>
                ))}
              </select>
            </label>
            <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-gray-300">
              <p className="font-medium text-white">{activeEvmChain?.native_symbol || t("features.wallet-list.currentPublicChain")}</p>
              <p className="mt-1 break-all text-xs text-gray-500">{activeEvmChain?.rpc_url || "No RPC selected"}</p>
              <p className="mt-1 break-all text-xs text-gray-500">{activeEvmChain?.explorer_url || "No explorer configured"}</p>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <h3 className="text-lg font-semibold text-white">Wallet</h3>
            <input value={evmPassword} onChange={(event) => setEvmPassword(event.target.value)} type="password" placeholder="Wallet password" className="h-10 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none" />
            <textarea value={evmPrivateKey} onChange={(event) => setEvmPrivateKey(event.target.value)} placeholder="Private key hex for import" rows={3} className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none" />
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={createEvmWallet} disabled={evmBusy} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-black disabled:opacity-50">
                <Wallet className="h-4 w-4" />
                Create
              </button>
              <button type="button" onClick={importEvmPrivateKey} disabled={evmBusy} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-gray-100 hover:bg-white/10 disabled:opacity-50">
                <Upload className="h-4 w-4" />
                Import
              </button>
            </div>
            {evmWallet && (
              <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
                <p className="font-medium text-white">{evmWallet.name}</p>
                <p className="mt-1 break-all text-gray-400">{evmWallet.address}</p>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <button
              type="button"
              onClick={() => setEvmCustomChainEditorOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-3 text-left text-lg font-semibold text-white"
              aria-expanded={evmCustomChainEditorOpen}
            >
              <span>Custom chain</span>
              {evmCustomChainEditorOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            {evmCustomChainEditorOpen && (
              <div className="grid gap-2 lg:grid-cols-2">
                <input value={evmNewChain.chainId} onChange={(event) => setEvmNewChain((prev) => ({ ...prev, chainId: event.target.value }))} placeholder="Chain ID" className="h-10 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none" />
                <input value={evmNewChain.name} onChange={(event) => setEvmNewChain((prev) => ({ ...prev, name: event.target.value }))} placeholder="Name" className="h-10 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none" />
                <input value={evmNewChain.nativeSymbol} onChange={(event) => setEvmNewChain((prev) => ({ ...prev, nativeSymbol: event.target.value }))} placeholder="Symbol" className="h-10 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none" />
                <input value={evmNewChain.rpcUrl} onChange={(event) => setEvmNewChain((prev) => ({ ...prev, rpcUrl: event.target.value }))} placeholder="RPC URL" className="h-10 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none" />
                <input value={evmNewChain.explorerUrl} onChange={(event) => setEvmNewChain((prev) => ({ ...prev, explorerUrl: event.target.value }))} placeholder="Explorer URL optional" className="h-10 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none" />
                <label className="flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-gray-200">
                  <input
                    type="checkbox"
                    checked={evmNewChain.testnet}
                    onChange={(event) => setEvmNewChain((prev) => ({ ...prev, testnet: event.target.checked }))}
                  />
                  Testnet
                </label>
                <button type="button" onClick={addDesktopEvmChain} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-black hover:bg-emerald-400">
                  <Plus className="h-4 w-4" />
                  Add
                </button>
                <button
                  type="button"
                  onClick={removeDesktopEvmChain}
                  disabled={!activeEvmChainIsCustom}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-gray-100 hover:bg-white/10 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete custom
                </button>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">Assets</h3>
              <button type="button" onClick={refreshEvmAssets} disabled={evmBusy || !evmWallet} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-gray-100 hover:bg-white/10 disabled:opacity-50">
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
            </div>
            <div className="flex gap-2">
              <input value={evmNewTokenContract} onChange={(event) => setEvmNewTokenContract(event.target.value)} placeholder="ERC-20 contract" className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none" />
              <button type="button" onClick={addDesktopEvmToken} className="inline-flex h-10 items-center justify-center rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-black hover:bg-emerald-400">
                Add token
              </button>
            </div>
            {evmTokenContracts.length > 0 && (
              <div className="space-y-2">
                {evmTokenContracts.map((contract) => (
                  <div key={contract} className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 p-2 text-xs text-gray-400">
                    <span className="min-w-0 flex-1 break-all">{contract}</span>
                    <button
                      type="button"
                      onClick={() => removeDesktopEvmToken(contract)}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 text-gray-300 hover:bg-white/10 hover:text-white"
                      aria-label="Remove token"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-gray-300">
              <p>{activeEvmChain?.native_symbol || "Native"} balance: {evmAssets?.native_balance_wei ?? "-"} wei</p>
              <p className="mt-1 text-xs text-gray-500">History: {evmAssets?.history_status ?? "not loaded"} {evmAssets?.history_message ? `- ${evmAssets.history_message}` : ""}</p>
            </div>
            <div className="space-y-2">
              {(evmAssets?.tokens || []).map((token) => (
                <div key={token.contract_address} className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
                  <p className="font-medium text-white">{token.symbol} {token.balance}</p>
                  <p className="break-all text-xs text-gray-500">{token.name} · {token.contract_address}</p>
                </div>
              ))}
              {(evmAssets?.recent_transactions || []).map((entry) => (
                <div key={entry.hash} className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
                  <p className="text-white">{entry.status} · block {entry.block_number ?? "-"}</p>
                  <p className="break-all text-xs text-gray-500">{entry.hash}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <h3 className="text-lg font-semibold text-white">Transfer Preview</h3>
          <div className="grid gap-3 lg:grid-cols-3">
            <input value={evmRecipient} onChange={(event) => setEvmRecipient(event.target.value)} placeholder="Recipient" className="h-10 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none" />
            <input value={evmAmount} onChange={(event) => setEvmAmount(event.target.value)} placeholder="Amount in wei or token units" className="h-10 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none" />
            <input value={evmTokenContract} onChange={(event) => setEvmTokenContract(event.target.value)} placeholder="ERC-20 contract optional" className="h-10 rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={previewEvmPayment} disabled={evmBusy || !evmWallet} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-black disabled:opacity-50">
              <ShieldCheck className="h-4 w-4" />
              Preview
            </button>
            <button type="button" onClick={() => void submitEvmPayment(true)} disabled={evmBusy || !evmPreview} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-black hover:bg-emerald-400 disabled:opacity-50">
              <Send className="h-4 w-4" />
              Confirm submit
            </button>
            <button type="button" onClick={() => void submitEvmPayment(false)} disabled={evmBusy || !evmPreview} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-gray-100 hover:bg-white/10 disabled:opacity-50">
              <X className="h-4 w-4" />
              Reject
            </button>
          </div>
          {evmPreview && (
            <div className="grid gap-2 rounded-lg border border-emerald-300/20 bg-emerald-300/10 p-3 text-sm text-emerald-50 lg:grid-cols-2">
              <p>Chain ID: {evmPreview.chain.chain_id}</p>
              <p>Nonce: {evmPreview.nonce}</p>
              <p>Gas limit: {evmPreview.gas_limit}</p>
              <p>Fee model: {evmPreview.fee_model}</p>
              <p>Gas price: {evmPreview.gas_price_wei} wei</p>
              <p>Estimated fee: {evmPreview.estimated_fee_wei} wei</p>
              <p className="break-all lg:col-span-2">Recipient: {evmPreview.recipient}</p>
              {evmPreview.token_contract && <p className="break-all lg:col-span-2">Token: {evmPreview.token_contract}</p>}
            </div>
          )}
          {evmSubmitResult && (
            <div className="space-y-3 rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-gray-300">
              <p>Status: {evmSubmitResult.status}</p>
              <p className="break-all">Hash: {evmSubmitResult.transaction_hash}</p>
              <button type="button" onClick={refreshEvmTransactionStatus} disabled={evmBusy} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-gray-100 hover:bg-white/10 disabled:opacity-50">
                <RefreshCw className="h-4 w-4" />
                Check receipt
              </button>
              {evmTransactionStatus && (
                <div className="grid gap-1 text-xs text-gray-400 lg:grid-cols-2">
                  <p>Status: {evmTransactionStatus.status}</p>
                  <p>Block: {evmTransactionStatus.block_number ?? "-"}</p>
                  <p>Gas used: {evmTransactionStatus.gas_used ?? "-"}</p>
                  <p>Effective gas: {evmTransactionStatus.effective_gas_price_wei ?? "-"}</p>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    );

    const renderFormBody = () => {
      switch (formId) {
      case "wallet-list":
        return renderWalletListPanel();

      case "evm-workbench":
        return renderEvmWorkbench();

      case "dapp-store":
        return (
          <div ref={dappBrowserShellRef} className="app-dapp-browser flex h-full min-h-0 flex-col overflow-hidden bg-zinc-950">
            <div ref={dappBrowserTabBarRef} className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-white/10 bg-black/35 px-2 pt-1">
              {dappTabs.map((tab, index) => {
                const active = tab.id === activeDappTabId;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveDappTabId(tab.id)}
                    className={`group flex h-9 min-w-0 max-w-52 items-center gap-2 rounded-t-lg border px-3 text-left text-sm transition-colors ${
                      active
                        ? "border-white/10 border-b-zinc-950 bg-zinc-950 text-white"
                        : "border-transparent bg-white/[0.04] text-gray-400 hover:bg-white/[0.08] hover:text-gray-100"
                    } ${index === 0 ? "shrink-0" : "shrink"} `}
                    title={tab.title}
                  >
                    <Compass className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{tab.title}</span>
                    {tab.closable && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeDappTab(tab.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            closeDappTab(tab.id);
                          }
                        }}
                        className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-gray-500 opacity-70 hover:bg-white/10 hover:text-white group-hover:opacity-100"
                        aria-label={t("common.cancel")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={addBlankDappTab}
                className="app-dapp-new-tab-button mb-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent bg-[#111a24] text-[#9aa8bb] hover:border-[#28405c] hover:bg-[#172536] hover:text-[#e7eef8]"
                aria-label="New tab"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>

            {activeDappTab.showAddressBar && (
              <div ref={dappBrowserAddressBarRef} className="shrink-0 border-b border-white/10 bg-zinc-950 px-2 py-2">
                <form onSubmit={submitDappAddress}>
                  <div className="app-dapp-address-field flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-white/10 bg-black/35 px-4">
                    <ExternalLink className="h-4 w-4 shrink-0 text-gray-500" />
                    <input
                      value={activeDappTab.addressInput}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDappTabs((tabs) => tabs.map((tab) =>
                          tab.id === activeDappTab.id ? { ...tab, addressInput: value } : tab,
                        ));
                      }}
                      className="app-dapp-address-input h-10 min-w-0 flex-1 bg-transparent pl-1 pr-3 text-sm text-gray-100 outline-none placeholder:text-gray-600"
                      placeholder="https://"
                      spellCheck={false}
                      autoCapitalize="none"
                    />
                  </div>
                </form>
              </div>
            )}

            <div
              ref={dappBrowserViewportRef}
              className="relative min-h-0 flex-1 overflow-hidden bg-black"
            >
              {activeDappTab.id === DAPP_HOME_TAB_ID ? (
                <div className="app-dapp-store-home h-full overflow-y-auto bg-[#081019] p-4 text-gray-100">
                  <div className="mx-auto flex max-w-6xl flex-col gap-4">
                    <section className="grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,0.55fr)]">
                      <div className="app-dapp-store-panel min-w-0 rounded-lg border border-white/10 bg-[#101a25] p-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-emerald-300/25 bg-emerald-300/10 px-2.5 py-1 text-xs font-semibold text-emerald-100">
                              <Flame className="h-3.5 w-3.5" />
                              {tf("features.dapp-store.solanaOnly", "Solana Only")}
                            </div>
                            <h2 className="text-2xl font-semibold text-white sm:text-3xl">
                              {tf("features.dapp-store.homeTitle", "DApp Store")}
                            </h2>
                            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-400">
                              {tf("features.dapp-store.homeSubtitle", "Trending Solana trading, DeFi, NFT, and staking apps.")}
                            </p>
                          </div>
                          <div className="grid min-w-[220px] grid-cols-2 gap-2">
                            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                              <p className="text-[11px] font-medium uppercase text-gray-500">{tf("features.dapp-store.chain", "Chain")}</p>
                              <p className="mt-1 text-lg font-semibold text-white">Solana</p>
                            </div>
                            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                              <p className="text-[11px] font-medium uppercase text-gray-500">{tf("features.dapp-store.apps", "Apps")}</p>
                              <p className="mt-1 text-lg font-semibold text-white">{SOLANA_DAPP_CATALOG.length}</p>
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
                          <div className="app-dapp-search-field flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3">
                            <Search className="h-4 w-4 shrink-0 text-gray-500" />
                            <input
                              value={dappSearch}
                              onChange={(event) => setDappSearch(event.target.value)}
                              className="app-dapp-search-input h-10 min-w-0 flex-1 bg-transparent text-sm text-gray-100 outline-none placeholder:text-gray-600"
                              placeholder={tf("features.dapp-store.searchPlaceholder", "Search Solana DApps")}
                              spellCheck={false}
                            />
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            {DAPP_CATEGORIES.map((category) => {
                              const active = category === dappCategory;
                              return (
                                <button
                                  key={category}
                                  type="button"
                                  onClick={() => setDappCategory(category)}
                                  className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${
                                    active
                                      ? "border-emerald-300/40 bg-emerald-300 text-zinc-950"
                                      : "border-white/10 bg-white/[0.04] text-gray-300 hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                                  }`}
                                >
                                  {category === "trend" ? <Flame className="h-4 w-4" /> : <BarChart3 className="h-4 w-4" />}
                                  {tf(`features.dapp-store.categories.${category}`, category)}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      <div className="app-dapp-store-panel rounded-lg border border-white/10 bg-[#101a25] p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-white">{tf("features.dapp-store.walletStatus", "Wallet")}</p>
                            <p className="mt-1 max-w-full truncate text-xs text-gray-500">
                              {effectiveWallet ? walletLabel(effectiveWallet) : tf("features.dapp-store.noWallet", "Select a wallet first.")}
                            </p>
                          </div>
                          <Wallet className="h-5 w-5 shrink-0 text-emerald-200" />
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-2">
                          {dappStoreFeaturedDapps.slice(0, 2).map((dapp) => (
                            <button
                              key={dapp.id}
                              type="button"
                              onClick={() => void openDapp(dapp)}
                              disabled={!effectiveWallet}
                              className="min-w-0 rounded-lg border border-white/10 bg-black/20 p-3 text-left transition-colors hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <DappLogo dapp={dapp} size="sm" />
                              <span className="mt-2 block truncate text-sm font-semibold text-white">{dapp.name}</span>
                              <span className="mt-0.5 block truncate text-xs text-gray-500">{dapp.metricValue}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </section>

                    <section className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-gray-200">{tf("features.dapp-store.trending", "Trending on Solana")}</h3>
                        <span className="text-xs text-gray-500">{tf("features.dapp-store.filtered", "Non-Solana DApps filtered")}</span>
                      </div>
                      <div className="grid gap-3 lg:grid-cols-3">
                        {dappStoreFeaturedDapps.map((dapp) => (
                          <button
                            key={dapp.id}
                            type="button"
                            onClick={() => void openDapp(dapp)}
                            disabled={!effectiveWallet}
                            className="app-dapp-store-panel app-dapp-store-card overflow-hidden rounded-lg border border-white/10 bg-[#101a25] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <div className={`h-1.5 bg-gradient-to-r ${dapp.accentClass}`} />
                            <div className="p-4">
                              <div className="flex items-start gap-3">
                                <DappLogo dapp={dapp} size="lg" />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-semibold text-gray-300">#{dapp.rank}</span>
                                    <h4 className="min-w-0 truncate text-base font-semibold text-white">{dapp.name}</h4>
                                  </div>
                                  <p className="mt-1 text-sm leading-5 text-gray-400">{dapp.description}</p>
                                </div>
                              </div>
                              <div className="mt-4 flex flex-wrap gap-2">
                                {dapp.tags.slice(0, 3).map((tag) => (
                                  <span key={tag} className="rounded border border-white/10 bg-black/20 px-2 py-1 text-xs text-gray-400">
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-gray-200">{tf("features.dapp-store.allSolana", "All Solana DApps")}</h3>
                        <span className="text-xs text-gray-500">
                          {dappStoreVisibleDapps.length} / {SOLANA_DAPP_CATALOG.length}
                        </span>
                      </div>
                      {dappStoreVisibleDapps.length > 0 ? (
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {dappStoreVisibleDapps.map((dapp) => (
                            <button
                              key={dapp.id}
                              type="button"
                              onClick={() => void openDapp(dapp)}
                              disabled={!effectiveWallet}
                              className="app-dapp-store-card overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <div className={`h-1 bg-gradient-to-r ${dapp.accentClass}`} />
                              <div className="p-4">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex min-w-0 items-center gap-3">
                                    <DappLogo dapp={dapp} />
                                    <div className="min-w-0">
                                      <h4 className="truncate text-base font-semibold text-gray-100">{dapp.name}</h4>
                                      <p className="mt-0.5 truncate text-xs text-gray-500">{dapp.url.replace(/^https?:\/\//, "")}</p>
                                    </div>
                                  </div>
                                  <Star className="h-4 w-4 shrink-0 text-amber-200" />
                                </div>
                                <p className="mt-3 min-h-[60px] text-sm leading-5 text-gray-400">{dapp.description}</p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {dapp.tags.map((tag) => (
                                    <span key={tag} className="rounded border border-white/10 bg-black/20 px-2 py-1 text-xs text-gray-400">
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                                <div className="mt-3 flex items-center justify-between gap-2">
                                  <span className="rounded border border-white/10 bg-black/20 px-2 py-1 text-xs font-medium text-gray-300">
                                    {dapp.metricValue}
                                  </span>
                                  <span className="truncate text-xs text-gray-500">{dapp.chain}</span>
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-white/10 bg-white/[0.04] p-8 text-center text-sm text-gray-500">
                          {tf("features.dapp-store.noResults", "No Solana DApps match this search.")}
                        </div>
                      )}
                    </section>
                  </div>
                </div>
              ) : activeDappTab.webviewOpen ? (
                <div className="absolute inset-0 bg-black">
                  {activeDappTab.loading && (
                    <div className="flex h-full items-center justify-center text-gray-500">
                      <RefreshCw className="h-5 w-5 animate-spin" />
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-sm text-gray-500">
                  {activeDappTab.title}
                </div>
              )}
            </div>
          </div>
        );

      case "settings":
        return (
          <div className="space-y-6">
            <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-200">{t("features.settings.networkTitle")}</h3>
                <p className="mt-1 text-xs text-gray-500">{t("features.settings.networkHint")}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 rounded-xl border border-white/10 bg-black/20 p-1">
                {(["mainnet", "devnet", "testnet"] as AppNetwork[]).map((network) => {
                  const isNetworkSelected = settingsNetwork === network;
                  return (
                    <button
                      key={network}
                      type="button"
                      onClick={() => setAppNetwork(network)}
                      className={`h-10 rounded-lg text-sm font-medium transition-colors ${
                        isNetworkSelected
                          ? "bg-white text-black shadow-sm"
                          : "text-gray-300 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      {networkLabel(t, network)}
                    </button>
                  );
                })}
              </div>
              <div className="space-y-2">
                {visibleRpcProfiles.map((profile) => {
                  const isSelected = selectedRpcId === profile.id;
                  return (
                    <div
                      key={profile.id}
                      className={`rounded-lg border p-3 transition-colors ${
                        isSelected
                          ? "border-violet-300/50 bg-violet-400/15"
                          : "border-white/10 bg-white/5"
                      }`}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <button
                          type="button"
                          onClick={() => setAppRpc(profile.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-gray-100">{profile.name}</span>
                            <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[11px] text-gray-400">
                              {profile.builtin ? t("features.settings.rpcBuiltin") : t("features.settings.rpcCustom")}
                            </span>
                            {isSelected && (
                              <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-medium text-emerald-200">
                                {t("features.settings.rpcActive")}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 truncate font-mono text-xs text-gray-500">{profile.url}</p>
                        </button>
                        {!profile.builtin && (
                          <button
                            type="button"
                            onClick={() => handleRemoveRpcProfile(profile.id)}
                            className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 text-xs text-gray-300 hover:bg-red-500/15 hover:text-red-100"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t("features.settings.rpcRemove")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="grid gap-2 border-t border-white/10 pt-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto]">
                <input
                  type="text"
                  value={newRpcName}
                  onChange={(event) => setNewRpcName(event.target.value)}
                  className="h-10 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:ring-2 focus:ring-white/20"
                  placeholder={t("features.settings.rpcNamePlaceholder")}
                />
                <input
                  type="url"
                  value={newRpcUrl}
                  onChange={(event) => setNewRpcUrl(event.target.value)}
                  className="h-10 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:ring-2 focus:ring-white/20"
                  placeholder={t("features.settings.rpcUrlPlaceholder")}
                />
                <button
                  type="button"
                  onClick={handleAddRpcProfile}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-black hover:bg-gray-200"
                >
                  <Plus className="h-4 w-4" />
                  {t("features.settings.rpcAdd")}
                </button>
              </div>
              <p className="text-xs text-gray-500">
                {t("features.settings.rpcAddHint", { network: networkLabel(t, settingsNetwork) })}
              </p>
            </section>

            <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-200">{t("features.settings.evmChainTitle")}</h3>
                  <p className="mt-1 text-xs text-gray-500">{t("features.settings.evmChainHint")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadEvmChains()}
                  disabled={evmBusy}
                  className="inline-flex h-9 w-fit items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${evmBusy ? "animate-spin" : ""}`} />
                  {t("features.settings.evmChainRefresh")}
                </button>
              </div>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <label className="space-y-1 text-sm text-gray-300">
                  {t("features.settings.evmChainSelect")}
                  <select
                    value={evmChainId}
                    onChange={(event) => selectEvmChain(event.target.value)}
                    disabled={evmChains.length === 0}
                    className="h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-50"
                  >
                    {evmChains.map((chain) => (
                      <option key={chain.chain_id} value={chain.chain_id}>
                        {chain.name} ({chain.chain_id}) {chain.testnet ? t("features.settings.evmChainTestnet") : t("features.settings.evmChainMainnet")}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => handleSelectForm("evm-workbench")}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-black hover:bg-gray-200"
                >
                  <ArrowRightLeft className="h-4 w-4" />
                  {t("features.settings.evmOpenWallet")}
                </button>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-gray-400">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-2 py-0.5 font-medium text-emerald-100">
                    {activeEvmChain ? `${activeEvmChain.name} · ${activeEvmChain.native_symbol}` : t("features.settings.evmChainNone")}
                  </span>
                  {activeEvmChainIsCustom && (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-gray-300">
                      {t("features.settings.evmChainCustom")}
                    </span>
                  )}
                </div>
                <p className="mt-2 break-all">{activeEvmChain?.rpc_url || t("features.settings.evmChainNoRpc")}</p>
              </div>
            </section>

            <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
              {renderWalletAccountManager()}
            </section>

            <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-200">{t("features.settings.walletToolsTitle")}</h3>
                <p className="mt-1 text-xs text-gray-500">{t("features.settings.walletToolsHint")}</p>
              </div>
              {renderActionGrid([
                { id: "create-keystore", title: t("features.create-keystore.title"), icon: <Key className="w-4 h-4" /> },
                { id: "import-keystore", title: t("features.import-keystore.title"), icon: <Upload className="w-4 h-4" /> },
                { id: "import-mnemonic", title: t("features.import-mnemonic.title"), icon: <Hash className="w-4 h-4" /> },
              ])}
            </section>

            <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-200">{t("features.settings.downloadsTitle")}</h3>
                  <p className="mt-1 text-xs text-gray-500">{t("features.settings.downloadsHint")}</p>
                </div>
                {downloadHistory.length > 0 && (
                  <button
                    type="button"
                    onClick={clearDownloadHistory}
                    className="inline-flex h-8 w-fit items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 text-xs text-gray-300 hover:bg-white/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t("features.settings.downloadsClear")}
                  </button>
                )}
              </div>
              {downloadHistory.length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/10 bg-black/20 p-4 text-sm text-gray-500">
                  {t("features.settings.downloadsEmpty")}
                </p>
              ) : (
                <div className="space-y-2">
                  {downloadHistory.map((item) => (
                    <div key={item.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <Download className="h-4 w-4 shrink-0 text-cyan-200" />
                            <p className="min-w-0 truncate text-sm font-semibold text-gray-100" title={item.filename}>
                              {item.filename}
                            </p>
                          </div>
                          <p className="mt-1 text-xs text-gray-500">
                            {new Date(item.createdAt).toLocaleString()}
                          </p>
                          <code className="mt-2 block break-all rounded bg-black/30 px-2 py-1.5 text-xs text-gray-400">
                            {item.path}
                          </code>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => copyToClipboard(item.path, `download-path:${item.id}`)}
                            className="inline-flex h-9 items-center justify-center gap-1 rounded-lg bg-white/10 px-3 text-xs text-gray-200 hover:bg-white/20"
                          >
                            {copied === `download-path:${item.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                            {t("features.settings.downloadsCopyPath")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void openDownloadLocation(item.path)}
                            className="inline-flex h-9 items-center justify-center gap-1 rounded-lg bg-white/10 px-3 text-xs text-gray-200 hover:bg-white/20"
                          >
                            <FolderOpen className="h-3.5 w-3.5" />
                            {t("features.settings.downloadsShowInFolder")}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-200">{t("features.settings.securityTitle")}</h3>
                <p className="mt-1 text-xs text-gray-500">{t("features.settings.securityHint")}</p>
              </div>
              {renderActionGrid([
                { id: "setup-2fa", title: t("features.setup-2fa.title"), icon: <Lock className="w-4 h-4" /> },
                { id: "create-tfa", title: t("features.create-tfa.title"), icon: <ShieldCheck className="w-4 h-4" /> },
                { id: "unlock-tfa", title: t("features.unlock-tfa.title"), icon: <Unlock className="w-4 h-4" /> },
              ])}
            </section>
          </div>
        );

      case "wsol-workbench":
        return (
          <div className="space-y-4">
            {renderActionGrid([
              { id: "create-wsol-ata", title: t("features.create-wsol-ata.title"), icon: <Hash className="w-4 h-4" />, preset: { wallet_id: effectiveWalletId, network: effectiveNetwork } },
              { id: "wrap-sol", title: t("features.wrap-sol.title"), icon: <RefreshCw className="w-4 h-4" />, preset: { wallet_id: effectiveWalletId, network: effectiveNetwork } },
              { id: "unwrap-sol", title: t("features.unwrap-sol.title"), icon: <ArrowRightLeft className="w-4 h-4" />, preset: { wallet_id: effectiveWalletId, network: effectiveNetwork } },
              { id: "close-wsol-ata", title: t("features.close-wsol-ata.title"), icon: <X className="w-4 h-4" />, preset: { wallet_id: effectiveWalletId, network: effectiveNetwork } },
            ])}
          </div>
        );

      case "pump-workbench":
        return (
          <div className="space-y-4">
            {renderActionGrid([
              { id: "pumpfun-sell", title: t("features.pumpfun-sell.title"), icon: <Coins className="w-4 h-4" />, preset: { wallet_id: effectiveWalletId, network: effectiveNetwork } },
              { id: "pumpswap-sell", title: t("features.pumpswap-sell.title"), icon: <Coins className="w-4 h-4" />, preset: { wallet_id: effectiveWalletId, network: effectiveNetwork } },
              { id: "pumpfun-cashback", title: t("features.pumpfun-cashback.title"), icon: <Download className="w-4 h-4" />, preset: { wallet_id: effectiveWalletId, network: effectiveNetwork } },
              { id: "pumpswap-cashback", title: t("features.pumpswap-cashback.title"), icon: <Download className="w-4 h-4" />, preset: { wallet_id: effectiveWalletId, network: effectiveNetwork } },
            ])}
          </div>
        );

      case "contract-tools":
        return (
          <div className="space-y-4">
            {renderActionGrid([
              {
                id: "program-workbench",
                title: t("features.program-workbench.title"),
                icon: <Hash className="w-4 h-4" />,
                preset: { network: effectiveNetwork },
              },
              {
                id: "program-invoke-standalone",
                title: t("features.program-invoke.title"),
                icon: <Send className="w-4 h-4" />,
                preset: { wallet_id: effectiveWalletId, network: effectiveNetwork },
              },
              {
                id: "external-sign",
                title: t("features.external-sign.title"),
                icon: <ShieldCheck className="w-4 h-4" />,
                preset: { wallet_id: effectiveWalletId, network: effectiveNetwork },
              },
            ])}
          </div>
        );

      case "program-workbench":
        return renderProgramWorkspacePanel();

      case "create-nonce":
      case "nonce-workbench":
        return (
          <>
            {renderNonceAccountList()}
            {nonceCreateOpen &&
              typeof document !== "undefined" &&
              createPortal(
                <div
                  className="fixed inset-0 z-[190] flex items-end bg-black/60"
                  onClick={closeNonceCreateDialog}
                >
                  <div
                    className="relative max-h-[90vh] w-full overflow-y-auto border-t border-white/10 bg-zinc-950 px-4 py-5 shadow-2xl"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="mx-auto max-w-xl space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <h3 className="text-lg font-semibold">{t("features.create-nonce.createButton")}</h3>
                        </div>
                        <button
                          type="button"
                          onClick={closeNonceCreateDialog}
                          disabled={loading}
                          className="rounded-lg bg-white/10 p-2 text-gray-300 hover:bg-white/20 disabled:opacity-50"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                      {renderNonceCreateForm()}
                      {renderNonceCreateResult()}
                    </div>
                  </div>
                </div>,
                document.body,
              )}
          </>
        );

      case "squads-workspace":
        return renderWorkspacePanel();

      case "squads-proposals":
        return renderProposalWorkspacePanel();

      case "squads-programs":
        return renderProgramWorkspacePanel(true);

      case "create-plain":
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.create-plain.name")}</label>
              <input
                type="text"
                value={formData.name || ""}
                onChange={(e) => handleFormChange("name", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.create-plain.namePlaceholder")}
              />
            </div>
            <button type="button"
              onClick={() => handleSubmit("create-plain")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.create-plain.creating") : t("features.create-plain.createButton")}
            </button>
            {formData.publicKey && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.publicKey")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.publicKey}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.publicKey as string, "pubkey")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "pubkey" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.secretKey")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.secretKey}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.secretKey as string, "privkey")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "privkey" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case "create-encrypted":
        return (
          <div className="space-y-4">
            <button type="button"
              onClick={() => requestCreatePasswordSubmit("create-encrypted")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.create-encrypted.creating") : t("features.create-encrypted.createButton")}
            </button>
            {formData.publicKey && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.publicKey")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.publicKey}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.publicKey as string, "enc-pubkey")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "enc-pubkey" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-encrypted.encryptedKey")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.encryptedKey}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.encryptedKey as string, "enc-privkey")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "enc-privkey" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case "create-keystore":
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">{t("formUi.walletNameRequiredLabel")}</label>
              <input
                type="text"
                value={formData.name || ""}
                onChange={(e) => handleFormChange("name", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("formUi.walletNamePlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.create-keystore.derivationPath")}</label>
              <input
                type="text"
                value={formData.derivationPath || ""}
                onChange={(e) => handleFormChange("derivationPath", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.create-keystore.derivationPathPlaceholder")}
              />
              <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("features.create-keystore.mnemonicHint")}</p>
            </div>
            <button type="button"
              onClick={() => requestCreatePasswordSubmit("create-keystore")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.create-keystore.creating") : t("features.create-keystore.createButton")}
            </button>
            {formData.publicKey && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.publicKey")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.publicKey}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.publicKey as string, "ks-pubkey")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "ks-pubkey" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <p className="text-sm text-green-400">{t("formUi.walletSaved")}</p>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-keystore.keystoreJson")}</label>
                  <div className="flex gap-2">
                    <textarea
                      readOnly
                      className="flex-1 px-3 py-2 bg-black/30 rounded text-xs h-24 resize-none"
                      value={formData.keystoreJson ?? ""}
                    />
                    <button type="button"
                      onClick={() => copyToClipboard(formData.keystoreJson as string, "ks-json")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "ks-json" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <button type="button"
                  onClick={() => void downloadFile(formData.keystoreJson as string, "keystore.json")}
                  className="w-full py-2 bg-white/10 rounded-lg hover:bg-white/20 transition-colors flex items-center justify-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  {t("features.create-keystore.downloadFile")}
                </button>
              </div>
            )}
          </div>
        );

      case "import-mnemonic":
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">{t("formUi.walletNameRequiredLabel")}</label>
              <input
                type="text"
                value={formData.name || ""}
                onChange={(e) => handleFormChange("name", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("formUi.walletNamePlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.import-mnemonic.mnemonic")}</label>
              <textarea
                data-sensitive-field="mnemonic"
                value={formData.mnemonic || ""}
                onChange={(e) => handleFormChange("mnemonic", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                placeholder={t("features.import-mnemonic.mnemonicPlaceholder")}
                spellCheck={false}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.import-mnemonic.derivationPath")}</label>
              <input
                type="text"
                value={formData.derivationPath || ""}
                onChange={(e) => handleFormChange("derivationPath", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.import-mnemonic.derivationPathPlaceholder")}
              />
              <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("features.import-mnemonic.derivationPathHint")}</p>
            </div>
            <button type="button"
              onClick={() => requestCreatePasswordSubmit("import-mnemonic")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.import-mnemonic.importing") : t("features.import-mnemonic.importButton")}
            </button>
            {formData.publicKey && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.publicKey")}</label>
                  <code className="block px-3 py-2 bg-black/30 rounded text-xs break-all">
                    {formData.publicKey}
                  </code>
                </div>
                <p className="text-sm text-green-400">{t("formUi.walletSaved")}</p>
              </div>
            )}
          </div>
        );

      case "import-keystore":
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">{t("formUi.walletName")}</label>
              <input
                type="text"
                value={formData.name || ""}
                onChange={(e) => handleFormChange("name", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("formUi.walletNamePlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.import-keystore.selectFile")}</label>
              <input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
              />
            </div>
            <div className="text-center text-gray-400">{t("features.import-keystore.or")}</div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.import-keystore.pasteJson")}</label>
              <textarea
                value={formData.keystoreJson || ""}
                onChange={(e) => {
                  const content = e.target.value;
                  setFormData((prev) => ({
                    ...prev,
                    keystoreJson: content,
                    ...(!String(prev.name ?? "").trim() ? { name: keystoreMetadataName(content) } : {}),
                  }));
                }}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                placeholder={t("features.import-keystore.jsonPlaceholder")}
              />
            </div>
            <button type="button"
              onClick={() => requestCreatePasswordSubmit("import-keystore")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.import-keystore.importing") : t("features.import-keystore.importButton")}
            </button>
            {formData.publicKey && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.publicKey")}</label>
                  <code className="block px-3 py-2 bg-black/30 rounded text-xs break-all">
                    {formData.publicKey}
                  </code>
                </div>
                <p className="text-sm text-green-400">{t("formUi.walletSaved")}</p>
              </div>
            )}
            {wallets.length > 0 && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium">{t("formUi.walletList")}</label>
                  <button
                    type="button"
                    onClick={() => void loadWallets()}
                    className="px-3 py-1.5 bg-white/10 rounded text-xs hover:bg-white/20 transition-colors"
                  >
                    {walletsLoading ? t("common.loading") : t("formUi.refreshWallets")}
                  </button>
                </div>
                <div className="space-y-2">
                  {wallets.map((wallet) => (
                    <div key={wallet.id} className="flex items-center gap-2 p-3 bg-black/30 rounded-lg">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{wallet.name}</p>
                        <p className="text-xs text-gray-400 break-all">{wallet.public_key}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(wallet.public_key, `wallet-${wallet.id}`)}
                        className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                      >
                        {copied === `wallet-${wallet.id}` ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );

      case "decrypt": {
        const decryptAuth = walletAuth("decrypt");
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "decrypt": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.secretKey;
                    delete newFormData.encryptedKey;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    decryptAuth === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "decrypt": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.secretKey;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    decryptAuth === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "decrypt": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encryptedKey;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    decryptAuth === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {decryptAuth === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && decryptAuth === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && decryptAuth === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.privateKey")}</label>
                <input
                  type="password"
                  value={formData.secretKey || ""}
                  onChange={(e) => handleFormChange("secretKey", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintext")}</p>
              </div>
            )}

            <button type="button"
              onClick={() => requestPasswordSubmit("decrypt")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.decrypt.decrypting") : t("features.decrypt.decryptButton")}
            </button>
            {formData.unlocked && formData.publicKey && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.publicKey")}</label>
                  <code className="block px-3 py-2 bg-black/30 rounded text-xs break-all">
                    {formData.publicKey}
                  </code>
                </div>
                <p className="text-sm text-green-400">{t("formUi.walletUnlockedNoSecret")}</p>
              </div>
            )}
          </div>
        );
      }

      case "unlock": {
        const unlockAuth = walletAuth("unlock");
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "unlock": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.secretKey;
                    delete newFormData.encryptedKey;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    unlockAuth === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "unlock": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.secretKey;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    unlockAuth === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "unlock": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encryptedKey;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    unlockAuth === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {unlockAuth === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && unlockAuth === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && unlockAuth === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.privateKey")}</label>
                <input
                  type="password"
                  value={formData.secretKey || ""}
                  onChange={(e) => handleFormChange("secretKey", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintext")}</p>
              </div>
            )}

            <button type="button"
              onClick={() => requestPasswordSubmit("unlock")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.unlock.unlocking") : t("features.unlock.unlockButton")}
            </button>
            {formData.publicKey && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.publicKey")}</label>
                  <code className="block px-3 py-2 bg-black/30 rounded text-xs break-all">
                    {formData.publicKey}
                  </code>
                </div>
                <p className="text-sm text-green-400">{t("formUi.walletUnlockedNoSecret")}</p>
              </div>
            )}
          </div>
        );
      }

      case "check-balance":
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.check-balance.address")}</label>
              <input
                type="text"
                value={formData.address || ""}
                onChange={(e) => handleFormChange("address", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.check-balance.addressPlaceholder")}
              />
            </div>
            <button type="button"
              onClick={() => handleSubmit("check-balance")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.check-balance.checking") : t("features.check-balance.checkButton")}
            </button>
            {formData.balance && (
              <div className="p-4 bg-white/5 rounded-lg">
                <p className="text-2xl font-bold text-center">
                  {formData.balance} SOL
                  {formData.network && ` (${formData.network})`}
                </p>
              </div>
            )}
          </div>
        );

      case "get-pubkey": {
        const getPubkeyAuth = walletAuth("get-pubkey");
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "get-pubkey": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.secretKey;
                    delete newFormData.encryptedKey;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    getPubkeyAuth === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "get-pubkey": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.secretKey;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    getPubkeyAuth === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "get-pubkey": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encryptedKey;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    getPubkeyAuth === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {getPubkeyAuth === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && getPubkeyAuth === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[100px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && getPubkeyAuth === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.privateKey")}</label>
                <input
                  type="password"
                  value={formData.secretKey || ""}
                  onChange={(e) => handleFormChange("secretKey", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextSuggestEnc")}</p>
              </div>
            )}

            <button type="button"
              onClick={() => requestPasswordSubmit("get-pubkey")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.get-pubkey.getting") : t("features.get-pubkey.getButton")}
            </button>
            {formData.publicKey && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.publicKey")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.publicKey}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.publicKey as string, "get-pubkey")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "get-pubkey" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      }

      case "transfer-sol":
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "transfer-sol": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("transfer-sol") === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "transfer-sol": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("transfer-sol") === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "transfer-sol": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("transfer-sol") === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {/* Keystore Input */}
            {walletAuth("transfer-sol") === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("transfer-sol") === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("transfer-sol") === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.senderPrivateKey")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-2">{t("features.transfer-sol.toAddress")}</label>
              <input
                type="text"
                value={formData.to_address || ""}
                onChange={(e) => handleFormChange("to_address", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.transfer-sol.addressPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.transfer-sol.amount")}</label>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={formData.amount || ""}
                onChange={(e) => handleFormChange("amount", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.transfer-sol.amountPlaceholder")}
              />
              <div className="mt-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-gray-500">{t("features.transfer-sol.walletBalance")}</p>
                  <button
                    type="button"
                    onClick={() => refreshCurrentWalletAssets(transferSolWallet || undefined)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white"
                    title={t("features.wallet-list.refreshAssets")}
                    aria-label={t("features.wallet-list.refreshAssets")}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${transferSolAssets?.refreshing ? "animate-spin" : ""}`} />
                  </button>
                </div>
                <p className="mt-1 font-mono text-sm text-gray-100">
                  {transferSolBalance} SOL
                </p>
                {transferSolAssets?.refreshing && (
                  <p className="mt-1 text-xs text-gray-500">{t("features.transfer-sol.balanceRefreshing")}</p>
                )}
              </div>
            </div>
            <button type="button"
              onClick={() => requestPasswordSubmit("transfer-sol")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.transfer-sol.transferring") : t("features.transfer-sol.transferButton")}
            </button>
            {formData.signature && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.txSignature")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.signature}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.signature as string, "txsig")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "txsig" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case "transfer-token":
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "transfer-token": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("transfer-token") === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "transfer-token": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("transfer-token") === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "transfer-token": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("transfer-token") === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {walletAuth("transfer-token") === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("transfer-token") === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("transfer-token") === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.senderPrivateKey")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-2">{t("features.transfer-token.toAddress")}</label>
              <input
                type="text"
                value={formData.to_address || ""}
                onChange={(e) => handleFormChange("to_address", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.transfer-token.addressPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.transfer-token.mintAddress")}</label>
              <input
                type="text"
                value={formData.mint || ""}
                onChange={(e) => handleFormChange("mint", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.transfer-token.mintPlaceholder")}
              />
              {renderTokenMintInfo()}
              {transferTokenMint && (
                <div className="mt-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-gray-500">{t("features.transfer-token.walletBalance")}</p>
                    <button
                      type="button"
                      onClick={() => refreshCurrentWalletAssets(transferTokenWallet || undefined)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white"
                      title={t("features.wallet-list.refreshAssets")}
                      aria-label={t("features.wallet-list.refreshAssets")}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${transferTokenAssets?.refreshing ? "animate-spin" : ""}`} />
                    </button>
                  </div>
                  <p className="mt-1 font-mono text-sm text-gray-100">
                    {transferTokenBalance?.amount ?? "0"}
                  </p>
                  {transferTokenAssets?.refreshing && (
                    <p className="mt-1 text-xs text-gray-500">{t("features.transfer-token.balanceRefreshing")}</p>
                  )}
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.transfer-token.amount")}</label>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={formData.amount || ""}
                onChange={(e) => handleFormChange("amount", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.transfer-token.amountPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.transfer-token.decimals")}</label>
              <input
                value={formData.decimals ?? ""}
                readOnly
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white/80"
                placeholder={t("features.transfer-token.decimalsPlaceholder")}
              />
            </div>
            <button type="button"
              onClick={() => requestPasswordSubmit("transfer-token")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.transfer-token.transferring") : t("features.transfer-token.transferButton")}
            </button>
            {formData.signature && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.txSignature")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.signature}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.signature as string, "token-txsig")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "token-txsig" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case "create-wsol-ata":
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "create-wsol-ata": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("create-wsol-ata") === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "create-wsol-ata": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("create-wsol-ata") === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "create-wsol-ata": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("create-wsol-ata") === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {walletAuth("create-wsol-ata") === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("create-wsol-ata") === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("create-wsol-ata") === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.privateKey")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
              </div>
            )}
            <button type="button"
              onClick={() => requestPasswordSubmit("create-wsol-ata")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.create-wsol-ata.creating") : t("features.create-wsol-ata.createButton")}
            </button>
            {formData.signature && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.txSignature")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.signature}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.signature as string, "wsol-ata-sig")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "wsol-ata-sig" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case "wrap-sol":
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "wrap-sol": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("wrap-sol") === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "wrap-sol": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("wrap-sol") === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "wrap-sol": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("wrap-sol") === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {walletAuth("wrap-sol") === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("wrap-sol") === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("wrap-sol") === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.privateKey")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-2">{t("features.wrap-sol.amount")}</label>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={formData.amount || ""}
                onChange={(e) => handleFormChange("amount", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.wrap-sol.amountPlaceholder")}
              />
            </div>
            <button type="button"
              onClick={() => requestPasswordSubmit("wrap-sol")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.wrap-sol.wrapping") : t("features.wrap-sol.wrapButton")}
            </button>
            {formData.signature && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.txSignature")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.signature}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.signature as string, "wrap-sig")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "wrap-sig" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case "unwrap-sol":
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "unwrap-sol": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("unwrap-sol") === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "unwrap-sol": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("unwrap-sol") === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "unwrap-sol": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("unwrap-sol") === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {walletAuth("unwrap-sol") === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("unwrap-sol") === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("unwrap-sol") === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.privateKey")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
              </div>
            )}
            <button type="button"
              onClick={() => requestPasswordSubmit("unwrap-sol")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.unwrap-sol.unwrapping") : t("features.unwrap-sol.unwrapButton")}
            </button>
            {formData.signature && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.txSignature")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.signature}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.signature as string, "unwrap-sig")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "unwrap-sig" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case "program-deploy": {
        const deployAuth = walletAuth("program-deploy");
        const deploymentWallet = deployAuth === "keystore" ? savedWalletFromForm(formData) : undefined;
        const expectedGenesisHash = expectedGenesisHashFor(formData);
        const deploymentJournalIntent = programDeploymentJournalIntentFor(formData) || lastProgramDeploymentIntent;
        const deploymentJournalIntentKey = deploymentJournalIntent
          ? programDeploymentIntentKey(deploymentJournalIntent)
          : "";
        const deploymentJournalMatchesIntent = Boolean(
          deploymentJournalIntentKey &&
            programDeploymentJournal.intentKey === deploymentJournalIntentKey,
        );
        const deploymentJournalReady = Boolean(
          deploymentJournalMatchesIntent && !programDeploymentJournal.loading && !programDeploymentJournal.error,
        );
        const deploymentJournal = deploymentJournalMatchesIntent
          ? programDeploymentJournal.journal
          : null;
        const conflictingJournal = deploymentJournalMatchesIntent
          ? programDeploymentJournal.conflictingJournal
          : null;
        const conflictingJournalMessage = conflictingJournal
          ? conflictingJournal.status === "finalized"
            ? t("features.program-deploy.journalConflictingFinalized", {
                programId: conflictingJournal.program_id,
                recordedArtifact: conflictingJournal.program_sha256,
                currentArtifact: String(formData.programSoSha256 || "").trim().toLowerCase() || "-",
              })
            : t("features.program-deploy.journalConflictingActive", {
                programId: conflictingJournal.program_id,
                recordedArtifact: conflictingJournal.program_sha256,
                currentArtifact: String(formData.programSoSha256 || "").trim().toLowerCase() || "-",
              })
          : null;
        const journalIsFinalized = deploymentJournal
          ? deploymentJournal.status === "finalized"
          : false;
        const journalIsAwaitingReadback =
          deploymentJournal?.status === "deploy_finalized_pending_readback";
        const journalCanFillBuffer = Boolean(
          deploymentJournal && PROGRAM_BUFFER_RECOVERY_STATUSES.has(deploymentJournal.status),
        );
        const selectedMaxDataLen =
          formData.max_data_len === undefined || formData.max_data_len === ""
            ? Number(formData.programSoSize || 0)
            : Number(formData.max_data_len);
        const selectedResumeBuffer = String(
          formData.resumeBufferAddress || "",
        ).trim();
        const deployValidationMessage = loading ? null : programDeployValidationError(formData);
        const deploymentJournalIntentMatches = Boolean(
          !deploymentJournal ||
            (selectedMaxDataLen === deploymentJournal.max_data_len &&
              (PROGRAM_BUFFER_RECOVERY_STATUSES.has(deploymentJournal.status)
                ? selectedResumeBuffer === "" || selectedResumeBuffer === deploymentJournal.buffer_address
                : selectedResumeBuffer === "" ||
                  selectedResumeBuffer === deploymentJournal.buffer_address)),
        );
        const deployBlockedMessage =
          deployValidationMessage ||
          conflictingJournalMessage ||
          (!deploymentJournalIntentMatches
            ? programDeploymentJournal.loading
              ? t("features.program-deploy.journalLoading")
              : programDeploymentJournal.error
                ? programDeploymentJournal.error
                : t("features.program-deploy.journalIntentMismatch")
            : null);
        const journalRecoveryIntentSelected = Boolean(
          deploymentJournal &&
            selectedResumeBuffer === deploymentJournal.buffer_address &&
            selectedMaxDataLen === deploymentJournal.max_data_len,
        );
        const deploymentAttempts = deploymentJournalMatchesIntent
          ? programDeploymentJournal.deploymentAttempts
          : [];
        const programSourceDir = String(formData.programSourceDir || "").trim();
        const sourceHasCompiledProgram = Boolean(
          formData.programSoBase64 && String(formData.programSoSha256 || "").trim(),
        );
        const sourceHasProgramKeypair = Boolean(
          programKeypairMetadata || String(formData.programKeypairPath || "").trim(),
        );
        const sourceNeedsBuild = Boolean(programSourceDir && !sourceHasCompiledProgram);
        const sourceNeedsProgramKeypair = Boolean(
          programSourceDir && sourceHasCompiledProgram && !sourceHasProgramKeypair,
        );
        const writeAttempts = deploymentAttempts.filter((attempt) => attempt.stage === "write");
        const writeChunkCount = programDeploymentJournal.writeChunkCount;
        const submittedWriteChunks = new Set(
          writeAttempts
            .filter((attempt) =>
              ["signed", "confirmed", "requires_reconciliation", "finalized"].includes(attempt.status),
            )
            .map((attempt) => attempt.chunk_index)
            .filter((chunkIndex): chunkIndex is number => chunkIndex !== null),
        ).size;
        const confirmedWriteChunks = new Set(
          writeAttempts
            .filter((attempt) => attempt.status === "confirmed" || attempt.status === "finalized")
            .map((attempt) => attempt.chunk_index)
            .filter((chunkIndex): chunkIndex is number => chunkIndex !== null),
        ).size;
        const finalizedWriteChunks = new Set(
          writeAttempts
            .filter((attempt) => attempt.status === "finalized")
            .map((attempt) => attempt.chunk_index)
            .filter((chunkIndex): chunkIndex is number => chunkIndex !== null),
        ).size;
        const lastWriteProgress =
          deploymentJournal?.last_write_chunk_index === null ||
          deploymentJournal?.last_write_chunk_index === undefined
            ? 0
            : deploymentJournal.last_write_chunk_index + 1;
        const journalWriteProgress = writeChunkCount > 0
          ? Math.min(
              writeChunkCount,
              Math.max(
                deploymentJournal?.completed_writes || 0,
                submittedWriteChunks,
                lastWriteProgress,
              ),
            )
          : 0;
        const journalWritePercent = writeChunkCount > 0
          ? Math.min(100, Math.floor((journalWriteProgress / writeChunkCount) * 100))
          : 0;
        const processingWriteChunks = Math.max(0, submittedWriteChunks - confirmedWriteChunks);
        const remainingWriteChunks = writeChunkCount > 0
          ? Math.max(0, writeChunkCount - journalWriteProgress)
          : 0;
        const latestDeploymentAttempt = deploymentAttempts.reduce<ProgramDeploymentAttemptRecord | null>(
          (latest, attempt) =>
            !latest || (attempt.updated_at || attempt.created_at) > (latest.updated_at || latest.created_at)
              ? attempt
              : latest,
          null,
        );
        const waitingWriteAttempt = writeAttempts.reduce<ProgramDeploymentAttemptRecord | null>(
          (latest, attempt) => {
            if (!["signed", "requires_reconciliation"].includes(attempt.status)) return latest;
            return !latest || (attempt.updated_at || attempt.created_at) > (latest.updated_at || latest.created_at)
              ? attempt
              : latest;
          },
          null,
        );
        const lastDeploymentActivitySeconds = Math.max(
          deploymentJournal?.updated_at || 0,
          latestDeploymentAttempt?.updated_at || latestDeploymentAttempt?.created_at || 0,
        );
        const lastDeploymentActivityAgeMs = lastDeploymentActivitySeconds > 0
          ? Math.max(0, programDeploymentNowMs - lastDeploymentActivitySeconds * 1000)
          : 0;
        const lastDeploymentActivityAgeSeconds = Math.floor(lastDeploymentActivityAgeMs / 1000);
        const formatDeploymentElapsed = (seconds: number) => {
          if (seconds < 60) {
            return t("features.program-deploy.elapsedSeconds", { seconds });
          }
          const minutes = Math.floor(seconds / 60);
          if (minutes < 60) {
            return t("features.program-deploy.elapsedMinutes", { minutes });
          }
          const hours = Math.floor(minutes / 60);
          return t("features.program-deploy.elapsedHours", { hours });
        };
        const deploymentProgressNeedsAttention = Boolean(
          deploymentJournal &&
            !journalIsFinalized &&
            (
              deploymentJournal.status.endsWith("_signed") ||
              deploymentJournal.status.endsWith("_requires_reconciliation") ||
              waitingWriteAttempt
            ),
        );
        const deploymentProgressIsSlow = Boolean(
          deploymentProgressNeedsAttention &&
            lastDeploymentActivityAgeMs >= PROGRAM_DEPLOY_SLOW_PROGRESS_MS,
        );
        const journalStatusLabel = deploymentJournal
          ? t(`features.program-deploy.deploymentStatuses.${deploymentJournal.status}`)
          : "";
        const formatDeploymentLogTime = (seconds: number | null | undefined) =>
          seconds ? new Date(seconds * 1000).toLocaleTimeString() : new Date().toLocaleTimeString();
        const shortDeploymentSignature = (signature: string | null | undefined) =>
          signature && signature.length > 18
            ? `${signature.slice(0, 10)}...${signature.slice(-8)}`
            : signature || "-";
        const appendLimitedLogText = (lines: string[], label: string, textValue: unknown) => {
          const text = String(textValue || "").trim();
          if (!text) return;
          const parts = text.split(/\r?\n/).filter((line) => line.trim()).slice(-80);
          if (parts.length === 0) return;
          lines.push(`[${new Date().toLocaleTimeString()}] ${label}`);
          parts.forEach((line) => lines.push(line));
        };
        const deploymentLogLines: string[] = [];
        if (programSourceDir) {
          deploymentLogLines.push(`[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.sourceDir")}: ${programSourceDir}`);
        }
        if (formData.sourceBuildTemplate || formData.sourceBuildCommand || formData.sourceBuildStatus) {
          deploymentLogLines.push(
            `[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.sourceBuildTemplate")}: ${String(formData.sourceBuildTemplate || "-")}`,
          );
          deploymentLogLines.push(
            `[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.sourceBuildCommand")}: ${String(formData.sourceBuildCommand || "-")}`,
          );
          deploymentLogLines.push(`[${new Date().toLocaleTimeString()}] build status: ${String(formData.sourceBuildStatus || (programSourceLoading ? "running" : "-"))}`);
        } else if (programSourceLoading) {
          deploymentLogLines.push(`[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.sourceAutoReadingTitle")}`);
        }
        if (formData.sourceImportWarnings) {
          appendLimitedLogText(deploymentLogLines, "warnings", formData.sourceImportWarnings);
        }
        if (formData.sourceValidationErrors) {
          appendLimitedLogText(deploymentLogLines, "source validation errors", formData.sourceValidationErrors);
        }
        if (formData.sourceBuildError) {
          appendLimitedLogText(deploymentLogLines, "build error", formData.sourceBuildError);
        }
        appendLimitedLogText(deploymentLogLines, "stdout", formData.sourceBuildStdout);
        appendLimitedLogText(deploymentLogLines, "stderr", formData.sourceBuildStderr);
        if (programSourceLoading) {
          deploymentLogLines.push(`[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.sourceBuildStarted")}`);
        }
        if (deploymentJournal) {
          const statusText =
            journalStatusLabel === `features.program-deploy.deploymentStatuses.${deploymentJournal.status}`
              ? deploymentJournal.status
              : `${journalStatusLabel} (${deploymentJournal.status})`;
          deploymentLogLines.push(`[${formatDeploymentLogTime(deploymentJournal.updated_at)}] ${statusText}`);
          if (writeChunkCount > 0) {
            deploymentLogLines.push(
              `[${formatDeploymentLogTime(deploymentJournal.updated_at)}] ${t("features.program-deploy.journalWriteProgress", {
                completed: journalWriteProgress,
                total: writeChunkCount,
                percent: journalWritePercent,
              })}`,
            );
            deploymentLogLines.push(
              `[${formatDeploymentLogTime(deploymentJournal.updated_at)}] ${t("features.program-deploy.journalWriteBreakdown", {
                confirmed: confirmedWriteChunks,
                finalized: finalizedWriteChunks,
                processing: processingWriteChunks,
                bytes: programDeploymentJournal.writeChunkBytes,
              })}`,
            );
            deploymentLogLines.push(
              `[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.journalRemainingChunks", {
                remaining: remainingWriteChunks,
              })}`,
            );
            if (lastDeploymentActivitySeconds > 0) {
              deploymentLogLines.push(
                `[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.journalLastActivity", {
                  age: formatDeploymentElapsed(lastDeploymentActivityAgeSeconds),
                })}`,
              );
            }
            if (waitingWriteAttempt?.chunk_index !== null && waitingWriteAttempt?.chunk_index !== undefined) {
              deploymentLogLines.push(
                `[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.journalWaitingWriteConfirmation", {
                  chunk: waitingWriteAttempt.chunk_index,
                  signature: shortDeploymentSignature(waitingWriteAttempt.signature),
                })}`,
              );
            }
            if (deploymentProgressIsSlow) {
              deploymentLogLines.push(
                `[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.journalSlowConfirmationHint")}`,
              );
            }
          }
          deploymentLogLines.push(`[${formatDeploymentLogTime(deploymentJournal.updated_at)}] ${t("features.program-deploy.bufferAddress")}: ${deploymentJournal.buffer_address}`);
          deploymentLogLines.push(`[${formatDeploymentLogTime(deploymentJournal.updated_at)}] ${t("features.program-deploy.programSha256")}: ${deploymentJournal.program_sha256}`);
          deploymentLogLines.push(`[${formatDeploymentLogTime(deploymentJournal.updated_at)}] ${t("features.program-deploy.maxDataLen")}: ${deploymentJournal.max_data_len}`);
          if (deploymentJournal.create_signature) {
            deploymentLogLines.push(`[${formatDeploymentLogTime(deploymentJournal.updated_at)}] ${t("features.program-deploy.createBufferSignature")}: ${shortDeploymentSignature(deploymentJournal.create_signature)}`);
          }
          if (deploymentJournal.last_write_signature) {
            deploymentLogLines.push(`[${formatDeploymentLogTime(deploymentJournal.updated_at)}] ${t("features.program-deploy.journalLastWriteSignature")}: ${shortDeploymentSignature(deploymentJournal.last_write_signature)}`);
          }
          if (deploymentJournal.deploy_signature) {
            deploymentLogLines.push(`[${formatDeploymentLogTime(deploymentJournal.updated_at)}] ${t("features.program-deploy.journalDeploySignature")}: ${shortDeploymentSignature(deploymentJournal.deploy_signature)}`);
          }
          deploymentAttempts
            .slice()
            .sort((left, right) => left.created_at - right.created_at)
            .forEach((attempt) => {
              const chunkLabel = attempt.chunk_index === null ? "" : ` #${attempt.chunk_index}`;
              deploymentLogLines.push(
                `[${formatDeploymentLogTime(attempt.updated_at || attempt.created_at)}] ${attempt.stage}${chunkLabel}: ${attempt.status} ${shortDeploymentSignature(attempt.signature)}`,
              );
            });
          if (programDeploymentJournal.loading) {
            deploymentLogLines.push(`[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.journalAutoRefreshing")}`);
          }
          if (programDeploymentJournal.error) {
            deploymentLogLines.push(`[${new Date().toLocaleTimeString()}] ${programDeploymentJournal.error}`);
            deploymentLogLines.push(`[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.journalRpcUnavailableHint")}`);
          }
        } else if (conflictingJournalMessage) {
          deploymentLogLines.push(`[${formatDeploymentLogTime(conflictingJournal?.updated_at)}] ${conflictingJournalMessage}`);
          if (conflictingJournal) {
            deploymentLogLines.push(`[${formatDeploymentLogTime(conflictingJournal.updated_at)}] recorded artifact: ${conflictingJournal.program_sha256}`);
            deploymentLogLines.push(`[${formatDeploymentLogTime(conflictingJournal.updated_at)}] recorded status: ${conflictingJournal.status}`);
          }
        } else if (programDeploymentJournal.error) {
          deploymentLogLines.push(`[${new Date().toLocaleTimeString()}] ${programDeploymentJournal.error}`);
          deploymentLogLines.push(`[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.journalRpcUnavailableHint")}`);
        } else if (programDeploymentJournal.loading) {
          deploymentLogLines.push(`[${new Date().toLocaleTimeString()}] ${t("features.program-deploy.journalLoading")}`);
        } else {
          deploymentLogLines.push(
            loading
              ? t("features.program-deploy.journalAutoRefreshing")
              : deploymentJournalReady
                ? t("features.program-deploy.journalEmpty")
                : t("features.program-deploy.journalNotReady"),
          );
        }
        return (
          <div className="space-y-4">
            <div className="hidden">
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "program-deploy": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    deployAuth === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "program-deploy": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    deployAuth === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "program-deploy": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    deployAuth === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {deployAuth === "keystore" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  {renderProgramDeployHelpLabel(
                    t("features.program-deploy.selectedUpgradeAuthority"),
                    t("features.program-deploy.deploymentWalletTooltip"),
                    { inputId: "program-deployment-wallet", margin: false },
                  )}
                  <button
                    type="button"
                    onClick={() => void loadWallets()}
                    disabled={walletsLoading || loading}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-gray-300 hover:bg-white/20 disabled:opacity-50"
                    aria-label={t("formUi.refreshWallets")}
                    title={t("formUi.refreshWallets")}
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${walletsLoading ? "animate-spin" : ""}`}
                    />
                  </button>
                </div>
                <select
                  id="program-deployment-wallet"
                  value={formData.wallet_id || ""}
                  onChange={(event) => {
                    const walletId = event.target.value;
                    const wallet = wallets.find((candidate) => candidate.id === walletId);
                    clearProgramDeploymentProgress();
                    setFormData((previous) => ({
                      ...previous,
                      wallet_id: walletId || undefined,
                      keystoreJson: undefined,
                      expectedUpgradeAuthority: wallet?.public_key || "",
                      resumeBufferAddress: undefined,
                    }));
                  }}
                  disabled={walletsLoading || loading}
                  className="w-full min-w-0 max-w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-50"
                >
                  <option value="">{t("formUi.selectWallet")}</option>
                  {wallets.map((wallet) => (
                    <option key={wallet.id} value={wallet.id}>
                      {walletLabel(wallet)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && deployAuth === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && deployAuth === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.privateKey")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
              </div>
            )}

            <p className="rounded-lg border border-cyan-300/15 bg-cyan-400/5 px-3 py-2 text-xs text-cyan-100/80">
              {t("features.program-deploy.redeployHint")}
            </p>
            {renderProgramSourceImport()}
            {renderProgramFileInput()}
            {renderProgramKeypairFileInput()}
            <div>
              {renderProgramDeployHelpLabel(
                t("features.program-deploy.expectedProgramId"),
                t("features.program-deploy.expectedProgramIdTooltip"),
                { inputId: "expected-program-id" },
              )}
              <input
                id="expected-program-id"
                value={formData.expectedProgramId || ""}
                readOnly
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.program-deploy.expectedProgramIdPlaceholder")}
              />
            </div>
            {deploymentWallet && (
              <div>
                {renderProgramDeployHelpLabel(
                  t("features.program-deploy.selectedUpgradeAuthority"),
                  t("features.program-deploy.deploymentWalletTooltip"),
                )}
                <div className="flex gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-black/30 px-3 py-2 text-xs">
                    {deploymentWallet.public_key}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(deploymentWallet.public_key, "selected-upgrade-authority")}
                    className="shrink-0 rounded bg-white/10 px-3 py-2 hover:bg-white/20"
                    aria-label={t("common.copy")}
                  >
                    {copied === "selected-upgrade-authority" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}
            <div>
              {renderProgramDeployHelpLabel(
                t("features.program-deploy.expectedUpgradeAuthority"),
                t("features.program-deploy.expectedUpgradeAuthorityTooltip"),
                { inputId: "expected-upgrade-authority" },
              )}
              <input
                id="expected-upgrade-authority"
                value={formData.expectedUpgradeAuthority || ""}
                onChange={(event) =>
                  handleFormChange("expectedUpgradeAuthority", event.target.value.trim())
                }
                readOnly={Boolean(deploymentWallet)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.program-deploy.expectedUpgradeAuthorityPlaceholder")}
              />
            </div>
            <div>
              {renderProgramDeployHelpLabel(
                t("features.program-deploy.expectedGenesisHash"),
                t("features.program-deploy.expectedGenesisHashTooltip"),
              )}
              <code className="block break-all rounded bg-black/30 px-3 py-2 text-xs">
                {expectedGenesisHash}
              </code>
            </div>
            <div>
              {renderProgramDeployHelpLabel(
                t("features.program-deploy.maxDataLen"),
                t("features.program-deploy.maxDataLenTooltip"),
                { inputId: "program-max-data-len" },
              )}
              <input
                id="program-max-data-len"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={formData.max_data_len || ""}
                onChange={(e) => handleFormChange("max_data_len", e.target.value.replace(/[^\d]/g, ""))}
                disabled={journalRecoveryIntentSelected}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.program-deploy.maxDataLenPlaceholder")}
              />
            </div>
            <section className="space-y-3 border-y border-white/10 py-4" aria-labelledby="program-deployment-terminal-title">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  <h3 id="program-deployment-terminal-title" className="min-w-0 text-sm font-semibold text-gray-200">
                    {t("features.program-deploy.terminalTitle")}
                  </h3>
                  <FieldHelp
                    description={t("features.program-deploy.journalTooltip")}
                    label={t("features.program-deploy.helpAriaLabel", {
                      field: t("features.program-deploy.journalTitle"),
                    })}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (deploymentJournalIntent) {
                      void loadProgramDeploymentJournal(deploymentJournalIntent);
                    }
                  }}
                  disabled={programDeploymentJournal.loading || !deploymentJournalIntent}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-gray-200 hover:bg-white/20 disabled:opacity-50"
                  aria-label={t("features.program-deploy.journalRefresh")}
                  title={t("features.program-deploy.journalRefresh")}
                >
                  <RefreshCw className={`h-4 w-4 ${programDeploymentJournal.loading ? "animate-spin" : ""}`} />
                </button>
              </div>
              <div
                ref={programDeploymentLogPanelRef}
                className="h-64 select-text overflow-y-auto rounded-lg border border-emerald-300/15 bg-black px-3 py-2 font-mono text-xs leading-5 text-emerald-100 shadow-inner"
                role="log"
                aria-live="polite"
              >
                {deploymentLogLines.map((line, index) => (
                  <div
                    key={`${index}:${line}`}
                    className={`whitespace-pre-wrap break-words ${
                      line.includes(programDeploymentJournal.error || "\u0000")
                        ? "text-red-300"
                        : index === deploymentLogLines.length - 1 && programDeploymentJournal.loading
                          ? "text-cyan-200"
                          : "text-emerald-100"
                    }`}
                  >
                    <span className="select-none text-emerald-500">$ </span>
                    {line}
                  </div>
                ))}
              </div>
              {deploymentJournal && (
                <button
                  type="button"
                  onClick={() => {
                    setFormData((previous) => ({
                      ...previous,
                      resumeBufferAddress: deploymentJournal.buffer_address,
                      max_data_len: String(deploymentJournal.max_data_len),
                    }));
                    toast.success(t("features.program-deploy.journalBufferFilled"));
                  }}
                  disabled={
                    !journalCanFillBuffer ||
                    !isLikelySolanaPublicKey(deploymentJournal.buffer_address) ||
                    journalRecoveryIntentSelected
                  }
                  className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-amber-300/30 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-400/20 disabled:opacity-50"
                >
                  <ArrowRightLeft className="h-4 w-4 shrink-0" />
                  {journalIsFinalized
                    ? t("features.program-deploy.journalAlreadyFinalized")
                    : journalIsAwaitingReadback
                      ? t("features.program-deploy.journalAwaitingReadback")
                      : !journalCanFillBuffer
                        ? t("features.program-deploy.journalRecoveryUnavailable")
                        : t("features.program-deploy.journalFillBuffer")}
                </button>
              )}
            </section>
            <div>
              {renderProgramDeployHelpLabel(
                t("features.program-deploy.resumeBufferAddress"),
                t("features.program-deploy.resumeBufferAddressTooltip"),
                { inputId: "resume-buffer-address" },
              )}
              <input
                id="resume-buffer-address"
                value={formData.resumeBufferAddress || ""}
                onChange={(e) => handleFormChange("resumeBufferAddress", e.target.value.trim())}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg font-mono text-xs focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.program-deploy.resumeBufferAddressPlaceholder")}
              />
            </div>
            {(loading || deploymentJournal) && (
              <div
                className={`space-y-2 rounded-lg border p-3 ${
                  deploymentProgressIsSlow
                    ? "border-amber-300/30 bg-amber-400/10"
                    : "border-cyan-300/20 bg-cyan-300/10"
                }`}
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className={`min-w-0 font-medium ${deploymentProgressIsSlow ? "text-amber-100" : "text-cyan-100"}`}>
                    {deploymentJournal
                      ? journalStatusLabel === `features.program-deploy.deploymentStatuses.${deploymentJournal.status}`
                        ? deploymentJournal.status
                        : journalStatusLabel
                      : t("features.program-deploy.deploying")}
                  </span>
                  {writeChunkCount > 0 && (
                    <span className={`shrink-0 ${deploymentProgressIsSlow ? "text-amber-100" : "text-cyan-100"}`}>
                      {t("features.program-deploy.journalWriteProgress", {
                        completed: journalWriteProgress,
                        total: writeChunkCount,
                        percent: journalWritePercent,
                      })}
                    </span>
                  )}
                </div>
                {writeChunkCount > 0 ? (
                  <>
                    <div
                      className="h-2 overflow-hidden rounded-full bg-black/40"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={writeChunkCount}
                      aria-valuenow={journalWriteProgress}
                    >
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-300 transition-[width] duration-300"
                        style={{ width: `${journalWritePercent}%` }}
                      />
                    </div>
                    <p className="break-words text-xs text-cyan-100/80">
                      {t("features.program-deploy.journalWriteBreakdown", {
                        confirmed: confirmedWriteChunks,
                        finalized: finalizedWriteChunks,
                        processing: processingWriteChunks,
                        bytes: programDeploymentJournal.writeChunkBytes,
                      })}
                    </p>
                    <div className="grid gap-1 text-xs text-cyan-100/80 sm:grid-cols-2">
                      <p>
                        {t("features.program-deploy.journalRemainingChunks", {
                          remaining: remainingWriteChunks,
                        })}
                      </p>
                      {lastDeploymentActivitySeconds > 0 && (
                        <p>
                          {t("features.program-deploy.journalLastActivity", {
                            age: formatDeploymentElapsed(lastDeploymentActivityAgeSeconds),
                          })}
                        </p>
                      )}
                    </div>
                    {waitingWriteAttempt?.chunk_index !== null && waitingWriteAttempt?.chunk_index !== undefined && (
                      <p className="break-words text-xs text-cyan-100/80">
                        {t("features.program-deploy.journalWaitingWriteConfirmation", {
                          chunk: waitingWriteAttempt.chunk_index,
                          signature: shortDeploymentSignature(waitingWriteAttempt.signature),
                        })}
                      </p>
                    )}
                    {deploymentProgressIsSlow && (
                      <p className="rounded-md border border-amber-300/20 bg-amber-400/10 px-2 py-1.5 text-xs text-amber-100">
                        {t("features.program-deploy.journalSlowConfirmationHint")}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-cyan-100/80">
                    {loading
                      ? t("features.program-deploy.journalAutoRefreshing")
                      : programDeploymentJournal.loading
                        ? t("features.program-deploy.journalLoading")
                        : t("features.program-deploy.journalNotReady")}
                  </p>
                )}
              </div>
            )}
            {programSourceDir && (programSourceLoading || sourceNeedsBuild || sourceNeedsProgramKeypair) && (
              <div className="space-y-3 rounded-lg border border-amber-300/20 bg-amber-400/10 p-3">
                <div className="flex items-start gap-3">
                  {programSourceLoading ? (
                    <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-cyan-200" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-amber-100">
                      {programSourceLoading
                        ? t("features.program-deploy.sourceAutoReadingTitle")
                        : sourceNeedsProgramKeypair
                          ? t("features.program-deploy.programKeypairRequiredTitle")
                          : t("features.program-deploy.compileRequiredTitle")}
                    </p>
                    <p className="mt-1 text-xs text-amber-100/80">
                      {programSourceLoading
                        ? t("features.program-deploy.sourceAutoReadingHint")
                        : sourceNeedsProgramKeypair
                          ? t("features.program-deploy.programKeypairRequiredHint")
                          : t("features.program-deploy.compileRequiredHint")}
                    </p>
                  </div>
                </div>
                {!programSourceLoading && sourceNeedsBuild && (
                  <button
                    type="button"
                    onClick={() => void handleProgramSourceImport(true)}
                    disabled={loading}
                    className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-amber-300/30 bg-amber-400/15 px-4 py-2 text-sm font-semibold text-amber-50 hover:bg-amber-400/25 disabled:opacity-50"
                  >
                    <RefreshCw className="h-4 w-4 shrink-0" />
                    {t("features.program-deploy.compileRequiredAction")}
                  </button>
                )}
              </div>
            )}
            {!loading && !programSourceLoading && deployBlockedMessage && !sourceNeedsBuild && !sourceNeedsProgramKeypair && (
              <p className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-gray-300">
                {deployBlockedMessage}
              </p>
            )}
            {programDeployInlineError && (
              <div className="space-y-2 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-red-100">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-200" />
                    <p className="font-semibold">{t("features.program-deploy.deployErrorTitle")}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(
                      [
                        programDeployInlineError.friendly,
                        programDeployInlineError.raw !== programDeployInlineError.friendly
                          ? programDeployInlineError.raw
                          : "",
                      ].filter(Boolean).join("\n\n"),
                      "program-deploy-inline-error",
                    )}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-red-400/15 px-2 py-1 text-[11px] font-medium text-red-50 hover:bg-red-400/25"
                  >
                    {copied === "program-deploy-inline-error" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {t("features.program-deploy.sourceValidationCopy")}
                  </button>
                </div>
                <p className="text-sm leading-6 text-red-50">{programDeployInlineError.friendly}</p>
                {programDeployInlineError.raw !== programDeployInlineError.friendly && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-red-200/80">
                      {t("features.program-deploy.rawErrorLabel")}
                    </p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/40 p-2 font-mono text-[11px] leading-5 text-red-100">
                      {programDeployInlineError.raw}
                    </pre>
                  </div>
                )}
              </div>
            )}
            <button type="button"
              onClick={() => requestPasswordSubmit("program-deploy")}
              disabled={loading || programSourceLoading || Boolean(deployBlockedMessage)}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.program-deploy.deploying") : t("features.program-deploy.deployButton")}
            </button>
            {formData.programId && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                {[
                  ["program-id", t("features.program-deploy.programId"), formData.programId],
                  ["programdata", t("features.program-deploy.programdataAddress"), formData.programdataAddress],
                  ["program-buffer", t("features.program-deploy.bufferAddress"), formData.bufferAddress],
                  ["program-create-buffer-signature", t("features.program-deploy.createBufferSignature"), formData.createBufferSignature],
                  ["program-authority", t("features.program-deploy.authority"), formData.authority],
                  ["program-genesis", t("features.program-deploy.genesisHash"), formData.genesisHash],
                  ["program-sha256", t("features.program-deploy.programSha256"), formData.programSha256],
                  ["program-slot", t("features.program-deploy.deployedSlot"), formData.deployedSlot],
                  ["program-finalized-slot", t("features.program-deploy.finalizedSlot"), formData.finalizedSlot],
                  ["program-readback", t("features.program-deploy.readbackVerification"), formData.readbackVerified],
                  ["program-receipt-sha256", t("features.program-deploy.receiptSha256"), formData.deploymentReceiptSha256],
                  ["deploy-sig", t("formUi.txSignature"), formData.signature],
                ].map(([id, label, value]) => (
                  value ? (
                    <div key={id as string}>
                      <label className="block text-sm font-medium mb-2">{label}</label>
                      <div className="flex gap-2">
                        <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                          {value}
                        </code>
                        <button type="button"
                          onClick={() => copyToClipboard(String(value), String(id))}
                          className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                        >
                          {copied === id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  ) : null
                ))}
                <p className="text-xs text-gray-400">
                  {t("features.program-deploy.deployStats", {
                    writes: String(formData.writeCount || 0),
                    skipped: String(formData.skippedWriteCount || 0),
                    bytes: String(formData.programBytes || 0),
                    rent: String(formData.rentLamports || 0),
                    fees: String(formData.estimatedFeesLamports || 0),
                    rateReserve: String(formData.feeRateReserveLamports || 0),
                    recoveryReserve: String(formData.recoveryWriteReserveLamports || 0),
                    feeBudget: String(formData.totalFeeBudgetLamports || 0),
                    required: String(formData.estimatedRequiredBalanceLamports || 0),
                  })}
                </p>
                {formData.readbackVerified === t("features.program-deploy.readbackPassed") && (
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        void downloadFile(
                          compactProgramDeploymentReceiptJson({
                            receiptJson: formData.deploymentReceiptJson,
                            programId: formData.programId,
                            programdataAddress: formData.programdataAddress,
                            bufferAddress: formData.bufferAddress,
                            authority: formData.authority,
                            deploySignature: formData.signature,
                            programBytes: formData.programBytes,
                            programSha256: formData.programSha256,
                            genesisHash: formData.genesisHash,
                            deployedSlot: formData.deployedSlot,
                            finalizedSlot: formData.finalizedSlot,
                            readbackVerified:
                              formData.readbackVerified === t("features.program-deploy.readbackPassed"),
                            network: formData.network,
                          }),
                          deploymentReceiptFilename(formData.programId),
                        )
                      }
                      disabled={!formData.deploymentReceiptJson}
                      className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-gray-100 hover:bg-white/10 disabled:opacity-50"
                    >
                      <Download className="h-4 w-4" />
                      {t("features.program-deploy.downloadReceipt")}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      }

      case "program-invoke":
      case "program-invoke-standalone": {
        const isStandaloneProgramInvoke = formId === "program-invoke-standalone";
        const invokeProject = currentProgramProjects.find((project) => project.id === programInvoke.projectId);
        const invokeWallet = savedWalletFromForm(formData) ?? effectiveWallet;
        const selectedInstruction = programInvoke.idl?.instructions.find(
          (instruction) => instruction.name === programInvoke.selectedInstruction,
        );
        const selectedAccounts = selectedInstruction ? flattenAnchorAccounts(selectedInstruction.accounts) : [];
        const selectedSignerAccounts = selectedAccounts.filter((account) => account.isSigner);
        const invokeMode = String(formData.programInvokeMode || "simulate") === "send" ? "send" : "simulate";
        const invokeNoticeMessage = programInvoke.result?.errorMessage || programInvoke.result?.simulationError || "";
        const invokeNoticeKind = programInvoke.result?.simulationError && !programInvoke.result?.errorMessage
          ? "warning"
          : "error";
        const invokeLogs = [
          ...(programInvoke.result?.errorMessage
            ? [t("features.program-invoke.errorLog", { error: programInvoke.result.errorMessage })]
            : []),
          ...(programInvoke.result?.rawErrorMessage
            ? [t("features.program-invoke.rawErrorLog", { error: programInvoke.result.rawErrorMessage })]
            : []),
          ...(programInvoke.result?.signature
            ? [t("features.program-invoke.signatureLog", { signature: programInvoke.result.signature })]
            : []),
          ...(programInvoke.result?.simulationError
            ? [t("features.program-invoke.simulationErrorLog", { error: programInvoke.result.simulationError })]
            : []),
          ...(programInvoke.result?.rawSimulationError
            ? [t("features.program-invoke.rawSimulationErrorLog", { error: programInvoke.result.rawSimulationError })]
            : []),
          ...(programInvoke.result?.logs || []),
        ];
        const runProgramInvoke = (mode: "simulate" | "send") => {
          const nextFormData = { ...formData, programInvokeMode: mode };
          setFormData(nextFormData);
          requestPasswordSubmit(formId, nextFormData);
        };

        return (
          <div className="space-y-4">
            <section className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-semibold text-gray-100">
                    {invokeProject?.name || (isStandaloneProgramInvoke
                      ? tf("features.program-invoke.standaloneProject", "自选 IDL 调用")
                      : t("features.program-invoke.project"))}
                  </p>
                  {programInvoke.sourceDir && (
                    <code className="block break-all text-xs text-gray-500">{programInvoke.sourceDir}</code>
                  )}
                  {programInvoke.idlPath && (
                    <p className="break-all text-xs text-gray-400 select-text">
                      {t("features.program-invoke.idlPath")}: {programInvoke.idlPath}
                    </p>
                  )}
                </div>
                {invokeProject && (
                  <button
                    type="button"
                    onClick={() => void loadProgramInvokeIdl(invokeProject)}
                    disabled={programInvoke.loading}
                    className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${programInvoke.loading ? "animate-spin" : ""}`} />
                    {t("features.program-invoke.reloadIdl")}
                  </button>
                )}
                {isStandaloneProgramInvoke && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <input
                      ref={programInvokeIdlFileInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={(event) => void handleProgramInvokeIdlFileChange(event)}
                    />
                    <button
                      type="button"
                      onClick={() => programInvokeIdlFileInputRef.current?.click()}
                      disabled={programInvoke.loading}
                      className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20 disabled:opacity-50"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {tf("features.program-invoke.chooseIdlFile", "选择 IDL JSON")}
                    </button>
                  </div>
                )}
              </div>
              {isStandaloneProgramInvoke && (
                <p className="text-xs text-gray-500">
                  {programInvoke.idlFileName
                    ? tf("features.program-invoke.idlFileReady", "已读取 IDL：{file}", { file: programInvoke.idlFileName })
                    : tf("features.program-invoke.idlFileHint", "可选择任意 Anchor IDL JSON 文件；如果 IDL 里没有 address，请手动填写 Program ID。")}
                </p>
              )}
              {programInvoke.loading && (
                <p className="text-xs text-cyan-200">{t("features.program-invoke.idlLoading")}</p>
              )}
              {programInvoke.error && (
                <p className="rounded-lg border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
                  {programInvoke.error}
                </p>
              )}
            </section>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
              <section className="min-w-0 space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
                <h3 className="text-sm font-semibold text-gray-200">{t("features.program-invoke.functions")}</h3>
                {programInvoke.idl?.instructions.length ? (
                  <div className="max-h-96 space-y-1 overflow-y-auto pr-1">
                    {programInvoke.idl.instructions.map((instruction) => (
                      <div
                        key={instruction.name}
                        role="button"
                        tabIndex={0}
                        onClick={() => void selectProgramInvokeInstruction(instruction)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            void selectProgramInvokeInstruction(instruction);
                          }
                        }}
                        className={`group relative w-full cursor-pointer rounded-lg px-3 py-2 pr-11 text-left text-sm transition-colors ${
                          instruction.name === programInvoke.selectedInstruction
                            ? "bg-cyan-400/15 text-cyan-100 ring-1 ring-cyan-300/30"
                            : "bg-white/5 text-gray-300 hover:bg-white/10"
                        }`}
                      >
                        <span className="block truncate font-medium select-text">{instruction.name}</span>
                        <span className="mt-1 block text-xs text-gray-500">
                          {t("features.program-invoke.functionMeta", {
                            args: instruction.args.length,
                            accounts: flattenAnchorAccounts(instruction.accounts).length,
                          })}
                        </span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void copyToClipboard(instruction.name, `program-invoke-instruction:${instruction.name}`);
                          }}
                          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white"
                          aria-label={t("common.copy")}
                          title={t("common.copy")}
                        >
                          {copied === `program-invoke-instruction:${instruction.name}` ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">{t("features.program-invoke.noFunctions")}</p>
                )}
              </section>

              <section className="min-w-0 space-y-4 rounded-lg border border-white/10 bg-white/[0.03] p-3">
                <div>
                  <label className="block text-sm font-medium mb-2 select-text">{t("features.program-invoke.programId")}</label>
                  <input
                    value={programInvoke.programId}
                    onChange={(event) =>
                      setProgramInvoke((prev) => ({ ...prev, programId: event.target.value.trim(), result: undefined }))
                    }
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full select-text rounded-lg border border-white/10 bg-white/5 px-4 py-2 font-mono text-xs text-white focus:outline-none focus:ring-2 focus:ring-white/20"
                    placeholder={t("features.program-invoke.programIdPlaceholder")}
                  />
                </div>

                {selectedInstruction ? (
                  <>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-gray-200">{t("features.program-invoke.parameters")}</h3>
                        {selectedInstruction.args.length === 0 ? (
                          <p className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-gray-500">
                            {t("features.program-invoke.noParameters")}
                          </p>
	                        ) : selectedInstruction.args.map((arg) => {
	                          const unsupported = isUnsupportedIdlType(arg.type);
	                          const supportsWalletPicker = !unsupported && isIdlPubkeyType(arg.type);
	                          const tokenAmountArg = !unsupported && isProgramInvokeTokenAmountArg(arg);
	                          const tokenAmountMint = tokenAmountArg
	                            ? programInvokeSingleMintAccount(selectedInstruction, programInvoke.accountValues)
	                            : "";
	                          const argValue = String(programInvoke.argValues[arg.name] || "");
	                          const typeLabel = tokenAmountArg
	                            ? t("features.program-invoke.tokenAmountType", { type: idlTypeLabel(arg.type) })
	                            : idlTypeLabel(arg.type);
	                          return (
	                            <div key={arg.name}>
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate text-sm font-medium select-text">{arg.name}</span>
                                <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${
                                  unsupported ? "bg-amber-400/15 text-amber-100" : "bg-white/10 text-gray-300"
                                }`}>
                                  {typeLabel}
                                </span>
                              </div>
                              <div className="flex gap-2">
                                <input
                                  value={argValue}
                                  onChange={(event) =>
                                    setProgramInvoke((prev) => ({
                                      ...prev,
                                      argValues: { ...prev.argValues, [arg.name]: event.target.value },
                                      result: undefined,
                                    }))
                                  }
	                                  disabled={unsupported}
	                                  inputMode={tokenAmountArg ? "decimal" : undefined}
	                                  className="min-w-0 flex-1 select-text rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-50"
	                                  placeholder={
	                                    unsupported
	                                      ? t("features.program-invoke.unsupportedType")
	                                      : tokenAmountArg
	                                        ? t("features.program-invoke.tokenAmountPlaceholder")
	                                        : t("features.program-invoke.argPlaceholder", { type: idlTypeLabel(arg.type) })
	                                  }
	                                />
                                {supportsWalletPicker && (
                                  <button
                                    type="button"
                                    onClick={() => openProgramInvokeWalletPicker({ kind: "arg", name: arg.name })}
                                    className="shrink-0 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20"
                                  >
                                    {tf("features.program-invoke.chooseWallet", "选择钱包")}
	                                  </button>
	                                )}
	                              </div>
	                              {tokenAmountArg && (
	                                <p className="mt-1 text-xs text-gray-500">
	                                  {tokenAmountMint
	                                    ? t("features.program-invoke.tokenAmountHint")
	                                    : t("features.program-invoke.tokenAmountPendingHint")}
	                                </p>
	                              )}
	                            </div>
	                          );
	                        })}
                      </div>

                      <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-gray-200">{t("features.program-invoke.accounts")}</h3>
                        {selectedAccounts.map((account) => {
                          const accountValue = String(programInvoke.accountValues[account.path] || "").trim();
                          const resolvedAccountValue = resolveAnchorAccountAddress(accountValue, account);
	                          const selectedSignerWallet = wallets.find(
	                            (wallet) => wallet.id === programInvoke.signerWalletIds[account.path],
	                          );
	                          const defaultAddress = defaultAccountAddress(account.name, account);
	                          const isAutoAccount = Boolean(account.address || account.pda || defaultAddress);
	                          const walletLikeAccount = isWalletLikeInvokeAccount(account);
	                          const isPrimarySigner =
	                            account.isSigner &&
	                            Boolean(invokeWallet) &&
	                            resolvedAccountValue === invokeWallet?.public_key;
	                          const requiresManualAccountInput = !isAutoAccount && !accountValue;
	                          const waitsForAutoAccount = isAutoAccount && !accountValue;
	                          return (
	                          <div key={account.path} className="space-y-2">
	                            <div className="mb-2 flex flex-wrap items-center gap-2">
	                              <span className="min-w-0 flex-1 truncate text-sm font-medium select-text">{account.path}</span>
	                              {isAutoAccount && (
	                                <span className="rounded bg-blue-400/15 px-2 py-0.5 text-xs text-blue-100">
	                                  {t("features.program-invoke.autoGeneratedAccount")}
	                                </span>
	                              )}
	                              {waitsForAutoAccount && (
	                                <span className="rounded bg-amber-400/15 px-2 py-0.5 text-xs text-amber-100">
	                                  {t("features.program-invoke.autoAccountPending")}
	                                </span>
	                              )}
	                              {requiresManualAccountInput && (
	                                <span className="rounded bg-amber-400/15 px-2 py-0.5 text-xs text-amber-100">
	                                  {t("features.program-invoke.manualRequired")}
                                </span>
                              )}
                              {account.isSigner && (
                                <span className="rounded bg-cyan-400/15 px-2 py-0.5 text-xs text-cyan-100">
                                  {t("features.program-invoke.signer")}
                                </span>
                              )}
                              {account.isWritable && (
                                <span className="rounded bg-emerald-400/15 px-2 py-0.5 text-xs text-emerald-100">
                                  {t("features.program-invoke.writable")}
                                </span>
                              )}
                            </div>
                            <div className="flex gap-2">
	                              <input
	                                value={accountValue}
	                                onChange={(event) => {
	                                  if (isAutoAccount) return;
	                                  setProgramInvoke((prev) => ({
	                                    ...prev,
	                                    accountValues: { ...prev.accountValues, [account.path]: event.target.value.trim() },
	                                    signerWalletIds: { ...prev.signerWalletIds, [account.path]: "" },
	                                    signerPasswords: { ...prev.signerPasswords, [account.path]: "" },
	                                    result: undefined,
	                                  }));
	                                }}
	                                readOnly={isAutoAccount}
	                                autoComplete="off"
	                                autoCapitalize="none"
	                                autoCorrect="off"
	                                spellCheck={false}
	                                className={`min-w-0 flex-1 select-text rounded-lg border border-white/10 px-4 py-2 font-mono text-xs text-white focus:outline-none focus:ring-2 focus:ring-white/20 ${
	                                  isAutoAccount ? "bg-black/30 text-gray-300" : "bg-white/5"
	                                }`}
	                                placeholder={
	                                  waitsForAutoAccount
	                                    ? t("features.program-invoke.autoAccountPendingPlaceholder")
	                                    : t("features.program-invoke.accountPlaceholder")
	                                }
	                              />
	                              {!isAutoAccount && (account.isSigner || walletLikeAccount) && (
                                <button
                                  type="button"
                                  onClick={() => openProgramInvokeWalletPicker({
                                    kind: "account",
                                    path: account.path,
                                    signer: account.isSigner,
                                  })}
                                  className="shrink-0 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20"
                                >
                                  {tf("features.program-invoke.chooseWallet", "选择钱包")}
                                </button>
                              )}
                            </div>
                            {account.isSigner && !isPrimarySigner && (
                              <div className="grid gap-2 rounded-lg border border-cyan-300/15 bg-cyan-400/5 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                                <div>
                                  <label className="mb-1 block text-xs font-medium text-cyan-100 select-text">
                                    {t("features.program-invoke.signerWallet")}
                                  </label>
                                  <select
                                    value={programInvoke.signerWalletIds[account.path] || ""}
                                    onChange={(event) => {
                                      const wallet = wallets.find((item) => item.id === event.target.value);
                                      setProgramInvoke((prev) => ({
                                        ...prev,
                                        accountValues: wallet
                                          ? { ...prev.accountValues, [account.path]: wallet.public_key }
                                          : prev.accountValues,
                                        signerWalletIds: { ...prev.signerWalletIds, [account.path]: event.target.value },
                                        signerPasswords: { ...prev.signerPasswords, [account.path]: "" },
                                        result: undefined,
                                      }));
                                    }}
                                    className="w-full select-text rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-white/20"
                                  >
                                    <option value="">{t("features.program-invoke.selectSignerWallet")}</option>
                                    {wallets.map((wallet) => (
                                      <option key={wallet.id} value={wallet.id}>
                                        {walletLabel(wallet)}
                                      </option>
                                    ))}
                                  </select>
                                  {selectedSignerWallet && selectedSignerWallet.public_key !== resolvedAccountValue && (
                                    <p className="mt-1 text-xs text-amber-100">
                                      {t("features.program-invoke.signerWalletMismatch", { account: account.path })}
                                    </p>
                                  )}
                                </div>
                                <div>
                                  <label className="mb-1 block text-xs font-medium text-cyan-100 select-text">
                                    {t("features.program-invoke.signerPassword")}
                                  </label>
                                  <input
                                    type="password"
                                    data-sensitive-field="password"
                                    value={programInvoke.signerPasswords[account.path] || ""}
                                    onChange={(event) =>
                                      setProgramInvoke((prev) => ({
                                        ...prev,
                                        signerPasswords: {
                                          ...prev.signerPasswords,
                                          [account.path]: event.target.value,
                                        },
                                        result: undefined,
                                      }))
                                    }
                                    disabled={!programInvoke.signerWalletIds[account.path]}
                                    className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-white/20 disabled:opacity-50"
                                    placeholder={t("features.program-invoke.signerPasswordPlaceholder")}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                        })}
                      </div>
                    </div>

                    <section className="space-y-3 border-t border-white/10 pt-4">
                      {invokeNoticeMessage && (
                        <div
                          className={`rounded-lg border px-3 py-3 ${
                            invokeNoticeKind === "warning"
                              ? "border-amber-300/25 bg-amber-400/10 text-amber-50"
                              : "border-red-300/25 bg-red-500/10 text-red-50"
                          }`}
                          role="alert"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-2">
                              <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${
                                invokeNoticeKind === "warning" ? "text-amber-200" : "text-red-200"
                              }`} />
                              <div className="min-w-0 space-y-1">
                                <p className="text-sm font-semibold">
                                  {invokeNoticeKind === "warning"
                                    ? t("features.program-invoke.warningTitle")
                                    : t("features.program-invoke.errorTitle")}
                                </p>
                                <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">
                                  {invokeNoticeMessage}
                                </p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(invokeNoticeMessage, "program-invoke-notice")}
                              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white hover:bg-white/20"
                            >
                              {copied === "program-invoke-notice" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                              {t("common.copy")}
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="inline-grid grid-cols-2 overflow-hidden rounded-lg border border-white/10 bg-black/20 p-1">
                          {(["simulate", "send"] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => handleFormChange("programInvokeMode", mode)}
                              className={`min-h-9 px-4 text-sm font-semibold ${
                                invokeMode === mode
                                  ? "rounded-md bg-white/15 text-white"
                                  : "text-gray-400 hover:text-gray-100"
                              }`}
                            >
                              {t(`features.program-invoke.modes.${mode}`)}
                            </button>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => runProgramInvoke("simulate")}
                            disabled={loading || programInvoke.loading}
                            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-50 hover:bg-cyan-400/20 disabled:opacity-50"
                          >
                            <RefreshCw className={`h-4 w-4 ${loading && invokeMode === "simulate" ? "animate-spin" : ""}`} />
                            {loading && invokeMode === "simulate"
                              ? t("features.program-invoke.simulating")
                              : t("features.program-invoke.simulateButton")}
                          </button>
                          <button
                            type="button"
                            onClick={() => runProgramInvoke("send")}
                            disabled={loading || programInvoke.loading}
                            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-2 text-sm font-semibold text-white hover:from-purple-600 hover:to-pink-600 disabled:opacity-50"
                          >
                            <Send className="h-4 w-4" />
                            {loading && invokeMode === "send"
                              ? t("features.program-invoke.sending")
                              : t("features.program-invoke.sendButton")}
                          </button>
                        </div>
                      </div>
                      <p className="text-xs text-gray-500">
                        {selectedSignerAccounts.length > 1
                          ? t("features.program-invoke.multiSignerHint", { count: String(selectedSignerAccounts.length) })
                          : t("features.program-invoke.signerLimitHint")}
                      </p>
                    </section>

                    <section className="space-y-2" aria-labelledby="program-invoke-terminal-title">
                      <h3 id="program-invoke-terminal-title" className="text-sm font-semibold text-gray-200">
                        {t("features.program-invoke.logs")}
                      </h3>
                      <div
                        className="h-64 select-text overflow-y-auto rounded-lg border border-emerald-300/15 bg-black px-3 py-2 font-mono text-xs leading-5 text-emerald-100 shadow-inner"
                        role="log"
                        aria-live="polite"
                      >
                        {invokeLogs.length === 0 ? (
                          <div className="text-gray-500">
                            <span className="select-none text-emerald-500">$ </span>
                            {t("features.program-invoke.noLogs")}
                          </div>
                        ) : invokeLogs.map((line, index) => (
                          <div
                            key={`${index}:${line}`}
                            className={`whitespace-pre-wrap break-words ${
                              (programInvoke.result?.errorMessage || programInvoke.result?.simulationError) && index === 0
                                ? "text-red-300"
                                : "text-emerald-100"
                            }`}
                          >
                            <span className="select-none text-emerald-500">$ </span>
                            {line}
                          </div>
                        ))}
                      </div>
                    </section>
                  </>
                ) : (
                  <p className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-gray-400">
                    {programInvoke.idl
                      ? t("features.program-invoke.noInstruction")
                      : isStandaloneProgramInvoke
                        ? tf("features.program-invoke.noStandaloneIdl", "请先选择一个 Anchor IDL JSON 文件。")
                        : t("features.program-invoke.noIdl")}
                  </p>
                )}
              </section>
            </div>
          </div>
        );
      }

      case "external-sign": {
        const externalSignAuth = walletAuth("external-sign");
        const externalSignWallet = savedWalletFromForm(formData) ?? effectiveWallet;
        const requiredSigner = String(formData.requiredSigner || "").trim();
        const walletMismatch = Boolean(
          requiredSigner &&
          externalSignWallet?.public_key &&
          externalSignWallet.public_key !== requiredSigner,
        );
        const fillSelectedWalletSigner = () => {
          if (externalSignWallet?.public_key) {
            handleFormChange("requiredSigner", externalSignWallet.public_key);
          }
        };
        const jsonSummary = parseExternalSignRequestSummary(String(formData.externalSignRequestJson || ""));
        const summaryRows: Array<[string, string, string?]> = jsonSummary?.valid
          ? [
              [t("features.external-sign.requestId"), jsonSummary.requestId],
              [tf("features.external-sign.schema", "Schema"), jsonSummary.schema],
              [tf("features.external-sign.operation", "Operation"), jsonSummary.operation],
              [tf("features.external-sign.cluster", "Cluster"), jsonSummary.cluster || jsonSummary.network],
              [t("features.external-sign.expectedGenesisHash"), jsonSummary.clusterGenesisHash],
              [tf("features.external-sign.programId", "Program ID"), jsonSummary.programId],
              [tf("features.external-sign.bridgeMint", "Bridge Mint"), jsonSummary.bridgeMint],
              [t("features.external-sign.requiredSigner"), jsonSummary.requiredSigner],
              [t("features.external-sign.transactionBase64"), jsonSummary.transactionBase64, "external-sign-summary-transaction-base64"],
              [tf("features.external-sign.dataBase64", "Data Base64"), jsonSummary.dataBase64, "external-sign-summary-data-base64"],
              [tf("features.external-sign.recipient", "Recipient"), jsonSummary.recipient],
              [tf("features.external-sign.amount", "Amount"), jsonSummary.amount],
              [t("features.external-sign.expiresAt"), jsonSummary.expiresAt],
              [tf("features.external-sign.recentBlockhash", "Recent Blockhash"), jsonSummary.recentBlockhash],
              [tf("features.external-sign.lastValidBlockHeight", "Last Valid Block Height"), jsonSummary.lastValidBlockHeight],
            ].filter((row): row is [string, string, string?] => Boolean(row[1]))
          : [];
        const renderExternalSignManualFields = () => (
          <>
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <label className="block text-sm font-medium">{t("features.external-sign.requiredSigner")}</label>
                <button
                  type="button"
                  onClick={fillSelectedWalletSigner}
                  disabled={!externalSignWallet?.public_key}
                  className="rounded bg-white/10 px-2 py-1 text-xs text-gray-200 hover:bg-white/20 disabled:opacity-40"
                >
                  {t("features.external-sign.useSelectedWallet")}
                </button>
              </div>
              <input
                type="text"
                value={formData.requiredSigner || ""}
                onChange={(e) => handleFormChange("requiredSigner", e.target.value.trim())}
                className={`w-full px-4 py-2 bg-white/5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white font-mono text-sm select-text ${
                  walletMismatch ? "border-red-400/60" : "border-white/10"
                }`}
                placeholder={t("features.external-sign.requiredSignerPlaceholder")}
              />
              {walletMismatch && (
                <p className="mt-2 text-xs text-red-200">
                  {t("features.external-sign.walletMismatch", {
                    wallet: externalSignWallet?.public_key || "-",
                    signer: requiredSigner,
                  })}
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">{t("features.external-sign.transactionBase64")}</label>
              <textarea
                value={formData.transactionBase64 || ""}
                onChange={(e) => handleFormChange("transactionBase64", e.target.value.trim())}
                spellCheck={false}
                className="w-full min-h-[160px] px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white font-mono text-xs select-text"
                placeholder={t("features.external-sign.transactionBase64Placeholder")}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium mb-2">{t("features.external-sign.requestId")}</label>
                <input
                  type="text"
                  value={formData.requestId || ""}
                  onChange={(e) => handleFormChange("requestId", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white select-text"
                  placeholder={t("features.external-sign.requestIdPlaceholder")}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">{t("features.external-sign.expiresAt")}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={formData.expiresAt || ""}
                  onChange={(e) => handleFormChange("expiresAt", e.target.value.replace(/[^\d]/g, ""))}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white select-text"
                  placeholder={t("features.external-sign.expiresAtPlaceholder")}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">{t("features.external-sign.expectedGenesisHash")}</label>
              <input
                type="text"
                value={formData.expectedGenesisHash || ""}
                onChange={(e) => handleFormChange("expectedGenesisHash", e.target.value.trim())}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white font-mono text-sm select-text"
                placeholder={t("features.external-sign.expectedGenesisHashPlaceholder")}
              />
            </div>
          </>
        );

        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                {([
                  ["keystore", t("formUi.tabKeystore")],
                  ["encrypted", t("formUi.tabEncrypted")],
                  ["private", t("formUi.tabPrivateKey")],
                ] as const).map(([method, label]) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => {
                      setAuthMethod({ ...authMethod, "external-sign": method });
                      const nextFormData = { ...formData };
                      if (method !== "private") delete nextFormData.private_key;
                      if (method !== "encrypted") delete nextFormData.encrypted_key;
                      if (method !== "keystore") {
                        delete nextFormData.wallet_id;
                        delete nextFormData.keystoreJson;
                      }
                      if (method === "private") delete nextFormData.password;
                      setFormData(nextFormData);
                    }}
                    className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                      externalSignAuth === method
                        ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                        : "bg-white/5 text-gray-400 hover:bg-white/10"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {externalSignAuth === "keystore" && (
              <SavedWalletPicker
                copied={copied}
                formData={formData}
                formId="external-sign"
                loading={walletsLoading}
                t={t}
                walletAuth={externalSignAuth}
                wallets={wallets}
                showTemporaryKeystore
                onCopy={copyToClipboard}
                onFieldChange={handleFormChange}
                onKeystoreUpload={handleFileUpload}
                onRefresh={() => void loadWallets()}
              />
            )}

            {ALLOW_DIRECT_SECRET_INPUT && externalSignAuth === "encrypted" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                <textarea
                  value={formData.encrypted_key || ""}
                  onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                  className="w-full min-h-[120px] px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderEncryptedKey")}
                />
              </div>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && externalSignAuth === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.senderPrivateKey")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
              </div>
            )}

            <section className="space-y-4 rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-black/20 p-1">
                {([
                  ["json", tf("features.external-sign.jsonTab", "JSON")],
                  ["form", tf("features.external-sign.formTab", "Form")],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setExternalSignInputMode(mode)}
                    className={`rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                      externalSignInputMode === mode
                        ? "bg-white/15 text-white shadow"
                        : "text-gray-400 hover:bg-white/10 hover:text-gray-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {externalSignInputMode === "json" ? (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-2">{t("features.external-sign.requestJson")}</label>
                    <textarea
                      value={formData.externalSignRequestJson || ""}
                      onChange={(e) => handleFormChange("externalSignRequestJson", e.target.value)}
                      spellCheck={false}
                      className="w-full min-h-[180px] px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white font-mono text-xs select-text"
                      placeholder={t("features.external-sign.requestJsonPlaceholder")}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={importExternalSignRequest}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20"
                  >
                    <Upload className="h-4 w-4" />
                    {t("features.external-sign.importRequest")}
                  </button>

                  {jsonSummary ? (
                    jsonSummary.valid ? (
                      <div className="space-y-3 rounded-lg border border-white/10 bg-black/20 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold text-white">{tf("features.external-sign.parsedSummary", "Parsed Summary")}</h3>
                          <div className="flex flex-wrap gap-2 text-xs text-gray-300">
                            <span className="rounded bg-white/10 px-2 py-1">
                              {tf("features.external-sign.signersCount", "Signers: {count}", { count: jsonSummary.signerCount })}
                            </span>
                            <span className="rounded bg-white/10 px-2 py-1">
                              {tf("features.external-sign.writableCount", "Writable: {count}", { count: jsonSummary.writableCount })}
                            </span>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                          {summaryRows.map(([label, value, copyId]) => (
                            <div key={label} className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] p-2">
                              <div className="mb-1 text-[11px] font-medium uppercase tracking-normal text-gray-500">{label}</div>
                              <div className="flex min-w-0 items-start gap-2">
                                <code className="min-w-0 flex-1 break-all font-mono text-xs text-gray-100">{value}</code>
                                {copyId ? (
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(value, copyId)}
                                    className="shrink-0 rounded bg-white/10 p-1.5 text-gray-200 hover:bg-white/20"
                                    aria-label={t("common.copy")}
                                    title={t("common.copy")}
                                  >
                                    {copied === copyId ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                        {jsonSummary.accounts.length > 0 ? (
                          <div>
                            <div className="mb-2 text-xs font-medium text-gray-400">{tf("features.external-sign.accounts", "Accounts")}</div>
                            <div className="max-h-56 overflow-y-auto rounded-md border border-white/10">
                              {jsonSummary.accounts.map((account, index) => (
                                <div
                                  key={`${account.pubkey}:${index}`}
                                  className="grid grid-cols-1 gap-2 border-b border-white/5 px-3 py-2 last:border-b-0 md:grid-cols-[1fr_auto]"
                                >
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(account.pubkey, `external-sign-account:${index}`)}
                                    className="min-w-0 break-all text-left font-mono text-xs text-gray-200 hover:text-white"
                                    title={account.pubkey}
                                  >
                                    {account.pubkey}
                                  </button>
                                  <div className="flex flex-wrap gap-1">
                                    {account.isSigner ? (
                                      <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-200">
                                        {tf("features.external-sign.signer", "Signer")}
                                      </span>
                                    ) : null}
                                    {account.isWritable ? (
                                      <span className="rounded bg-cyan-500/15 px-2 py-0.5 text-[11px] text-cyan-200">
                                        {tf("features.external-sign.writable", "Writable")}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <p className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-100">
                        {t("features.external-sign.invalidRequestJson")}
                      </p>
                    )
                  ) : null}
                </>
              ) : (
                <div className="space-y-4">
                  {renderExternalSignManualFields()}
                </div>
              )}
            </section>

            {walletMismatch && externalSignInputMode === "json" ? (
              <p className="rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-100">
                {t("features.external-sign.walletMismatch", {
                  wallet: externalSignWallet?.public_key || "-",
                  signer: requiredSigner,
                })}
              </p>
            ) : null}

            <button
              type="button"
              onClick={() => requestPasswordSubmit("external-sign")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.external-sign.submitting") : t("features.external-sign.submitButton")}
            </button>

            {formData.signature && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                {renderCopyRow("external-sign-signature", t("formUi.txSignature"), formData.signature)}
                {renderCopyRow("external-sign-signed-by", t("features.external-sign.signedBy"), formData.signedBy)}
                {renderCopyRow("external-sign-required-signer", t("features.external-sign.requiredSigner"), formData.requiredSigner)}
                {formData.externalSignBackfillJson ? (
                  renderCopyRow(
                    "external-sign-backfill-json",
                    t("features.external-sign.backfillJson"),
                    formData.externalSignBackfillJson,
                  )
                ) : null}
                <p className="text-xs text-gray-400">
                  {t("features.external-sign.resultMeta", {
                    slot: String(formData.externalSignSlot || "-"),
                    network: String(formData.externalSignNetwork || requestNetwork()),
                  })}
                </p>
              </div>
            )}
          </div>
        );
      }

      case "program-info":
        return (
          <div className="space-y-4">
            {renderProgramIdInput()}
            <button type="button"
              onClick={() => handleSubmit("program-info")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.program-info.querying") : t("features.program-info.queryButton")}
            </button>
            {formData.programInfoChecked && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                {[
                  ["info-program-id", t("features.program-info.programId"), formData.programId],
                  ["info-programdata", t("features.program-info.programdataAddress"), formData.programdataAddress],
                  ["info-owner", t("features.program-info.owner"), formData.owner],
                ].map(([id, label, value]) => (
                  value ? (
                    <div key={id as string}>
                      <label className="block text-sm font-medium mb-2">{label}</label>
                      <div className="flex gap-2">
                        <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                          {value}
                        </code>
                        <button type="button"
                          onClick={() => copyToClipboard(String(value), String(id))}
                          className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                        >
                          {copied === id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  ) : null
                ))}
                <p className="text-xs text-gray-400">
                  {t("features.program-info.stats", {
                    exists: String(formData.programExists || "false"),
                    executable: String(formData.executable || "false"),
                    lamports: String(formData.lamports || 0),
                    dataLen: String(formData.dataLen || 0),
                  })}
                </p>
              </div>
            )}
          </div>
        );

      case "squads-create":
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.squads-create.members")}</label>
              <textarea
                value={formData.members || ""}
                onChange={(e) => handleFormChange("members", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                placeholder={t("features.squads-create.membersPlaceholder")}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-2">{t("features.squads-create.threshold")}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={formData.threshold || ""}
                  onChange={(e) => handleFormChange("threshold", e.target.value.replace(/[^\d]/g, ""))}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("features.squads-create.thresholdPlaceholder")}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">{t("features.squads-create.timeLock")}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={formData.time_lock || ""}
                  onChange={(e) => handleFormChange("time_lock", e.target.value.replace(/[^\d]/g, ""))}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("features.squads-create.timeLockPlaceholder")}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.squads.memo")}</label>
              <input
                value={formData.memo || ""}
                onChange={(e) => handleFormChange("memo", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.squads.memoPlaceholder")}
              />
            </div>
            <button type="button" onClick={() => requestPasswordSubmit("squads-create")} disabled={loading} className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50">
              {loading ? t("features.squads-create.creating") : t("features.squads-create.createButton")}
            </button>
            {renderSquadsResult()}
          </div>
        );

      case "squads-info":
        return (
          <div className="space-y-4">
            {renderMultisigInput()}
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.squads.proposalOptional")}</label>
              <input
                value={formData.proposal || ""}
                onChange={(e) => handleFormChange("proposal", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.squads.proposalPlaceholder")}
              />
            </div>
            <button type="button" onClick={() => handleSubmit("squads-info")} disabled={loading} className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50">
              {loading ? t("features.squads-info.querying") : t("features.squads-info.queryButton")}
            </button>
            {(formData.vault || formData.membersText) && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                {renderCopyRow("squads-info-vault", t("features.squads.vault"), formData.vault)}
                {renderCopyRow("squads-info-create-key", t("features.squads.createKey"), formData.createKey)}
                <p className="text-xs text-gray-400">
                  {t("features.squads-info.stats", {
                    threshold: String(formData.threshold || ""),
                    transactionIndex: String(formData.transactionIndex || ""),
                  })}
                </p>
                {formData.membersText && (
                  <pre className="px-3 py-2 bg-black/30 rounded text-xs whitespace-pre-wrap break-all">{formData.membersText}</pre>
                )}
                {formData.proposalStatus && (
                  <p className="text-xs text-gray-300">
                    {t("features.squads-info.proposalStats", {
                      status: String(formData.proposalStatus),
                      transactionIndex: String(formData.proposalTxIndex || ""),
                    })}
                  </p>
                )}
                {formData.approvedText && (
                  <pre className="px-3 py-2 bg-black/30 rounded text-xs whitespace-pre-wrap break-all">{formData.approvedText}</pre>
                )}
              </div>
            )}
          </div>
        );

      case "squads-sol-transfer":
        return (
          renderStepForm([
            {
              title: t("features.workspace.stepTarget"),
              content: renderMultisigInput(),
            },
            {
              title: t("features.workspace.stepDetails"),
              content: (
                <>
                  {renderMultisigInput()}
                  <div>
                    <label className="block text-sm font-medium mb-2">{t("formUi.recipientAddress")}</label>
                    <input
                      value={formData.to_address || ""}
                      onChange={(e) => handleFormChange("to_address", e.target.value)}
                      className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                      placeholder={t("formUi.placeholderRecipient")}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">{t("formUi.amountSol")}</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={formData.amount || ""}
                      onChange={(e) => handleFormChange("amount", e.target.value)}
                      className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                      placeholder={t("formUi.placeholderAmountSol")}
                    />
                  </div>
                  {renderMemoInput()}
                </>
              ),
            },
            {
              title: t("features.workspace.stepSubmit"),
              content: (
                <>
                  <button type="button" onClick={() => requestPasswordSubmit("squads-sol-transfer")} disabled={loading} className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50">
                    {loading ? t("features.squads-sol-transfer.creating") : t("features.squads-sol-transfer.createButton")}
                  </button>
                  {renderSquadsResult()}
                </>
              ),
            },
          ])
        );

      case "squads-token-transfer":
        return (
          renderStepForm([
            {
              title: t("features.workspace.stepTarget"),
              content: (
                <>
                  {renderMultisigInput()}
                  <div>
                    <label className="block text-sm font-medium mb-2">{t("features.transfer-token.mintAddress")}</label>
                    <input
                      value={formData.mint || ""}
                      onChange={(e) => handleFormChange("mint", e.target.value)}
                      className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                      placeholder={t("features.transfer-token.mintPlaceholder")}
                    />
                    {renderTokenMintInfo()}
                  </div>
                </>
              ),
            },
            {
              title: t("features.workspace.stepDetails"),
              content: (
                <>
                  {renderMultisigInput()}
                  <div>
                    <label className="block text-sm font-medium mb-2">{t("features.transfer-token.mintAddress")}</label>
                    <input
                      value={formData.mint || ""}
                      onChange={(e) => handleFormChange("mint", e.target.value)}
                      className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                      placeholder={t("features.transfer-token.mintPlaceholder")}
                    />
                    {renderTokenMintInfo()}
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">{t("formUi.recipientAddress")}</label>
                    <input
                      value={formData.recipient || ""}
                      onChange={(e) => handleFormChange("recipient", e.target.value)}
                      className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                      placeholder={t("formUi.placeholderRecipient")}
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-2">{t("features.transfer-token.amount")}</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={formData.amount || ""}
                        onChange={(e) => handleFormChange("amount", e.target.value)}
                        className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                        placeholder={t("features.transfer-token.amountPlaceholder")}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">{t("features.transfer-token.decimals")}</label>
                      <input
                        value={formData.decimals ?? ""}
                        readOnly
                        className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white/80"
                        placeholder={t("features.transfer-token.decimalsPlaceholder")}
                      />
                    </div>
                  </div>
                  {renderMemoInput()}
                </>
              ),
            },
            {
              title: t("features.workspace.stepSubmit"),
              content: (
                <>
                  <button type="button" onClick={() => requestPasswordSubmit("squads-token-transfer")} disabled={loading} className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50">
                    {loading ? t("features.squads-token-transfer.creating") : t("features.squads-token-transfer.createButton")}
                  </button>
                  {renderSquadsResult()}
                </>
              ),
            },
          ])
        );

      case "squads-prepare-upgrade-buffer":
        return (
          renderStepForm([
            {
              title: t("features.workspace.stepTarget"),
              content: renderMultisigInput(),
            },
            {
              title: t("features.workspace.stepDetails"),
              content: (
                <>
                  {renderMultisigInput()}
                  {renderProgramFileInput()}
                </>
              ),
            },
            {
              title: t("features.workspace.stepSubmit"),
              content: (
                <>
                  <button type="button" onClick={() => requestPasswordSubmit("squads-prepare-upgrade-buffer")} disabled={loading} className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50">
                    {loading ? t("features.squads-prepare-upgrade-buffer.preparing") : t("features.squads-prepare-upgrade-buffer.prepareButton")}
                  </button>
                  {renderSquadsResult()}
                </>
              ),
            },
          ])
        );

      case "program-upgrade": {
        const upgradeProgramId = String(formData.programId || formData.expectedProgramId || "").trim();
        const upgradeSourceDir = String(formData.programSourceDir || "").trim();
        const upgradeProject = upgradeSourceDir
          ? workspace.programProjects.find((item) => item.id === scopedProgramProjectId(upgradeSourceDir))
          : workspace.programProjects.find((item) => String(item.programId || "").trim() === upgradeProgramId);
        const lastFinalizedSha = lastFinalizedProgramArtifactSha(upgradeProject, upgradeProgramId);
        const currentArtifactSha = String(formData.programSoSha256 || "").trim().toLowerCase();
        const upgradeJustSucceeded = Boolean(String(formData.signature || "").trim());
        // After a successful upgrade, current SHA naturally equals the latest record — don't treat that as stale.
        const upgradeArtifactIsStale = !upgradeJustSucceeded && isStaleProgramUpgradeArtifact(
          upgradeProject,
          upgradeProgramId,
          currentArtifactSha,
        );
        const upgradeNeedsCompile = Boolean(upgradeSourceDir && !formData.programSoBase64 && !upgradeJustSucceeded);
        return (
          <div className="space-y-4">
            <p className="text-sm text-gray-400">{t("features.program-upgrade.hint")}</p>
            {upgradeJustSucceeded && formData.message && !loading && (
              <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                <p className="font-semibold text-emerald-50">{t("features.program-upgrade.success")}</p>
                <p className="mt-1 text-xs leading-5 text-emerald-100/85">{formData.message}</p>
                {formData.signature && (
                  <button
                    type="button"
                    onClick={() => copyToClipboard(String(formData.signature), "program-upgrade-signature")}
                    className="mt-2 block max-w-full truncate text-left font-mono text-xs text-emerald-200 hover:text-white"
                  >
                    {formData.signature}
                  </button>
                )}
              </div>
            )}
            {upgradeSourceDir ? renderProgramSourceImport() : null}
            {renderProgramIdInput()}
            {renderProgramFileInput()}
            {!upgradeJustSucceeded && (programSourceLoading || upgradeNeedsCompile || upgradeArtifactIsStale) && (
              <div className={`space-y-3 rounded-lg border p-3 ${
                upgradeArtifactIsStale
                  ? "border-amber-300/25 bg-amber-400/10 text-amber-50"
                  : "border-cyan-300/20 bg-cyan-400/10 text-cyan-50"
              }`}>
                <div className="flex items-start gap-3">
                  {programSourceLoading ? (
                    <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-semibold">
                      {programSourceLoading
                        ? t("features.program-deploy.sourceAutoReadingTitle")
                        : upgradeNeedsCompile
                          ? t("features.program-upgrade.compileRequiredTitle")
                          : t("features.program-upgrade.staleArtifactTitle")}
                    </p>
                    <p className="text-xs leading-5 opacity-85">
                      {programSourceLoading
                        ? t("features.program-deploy.sourceAutoReadingHint")
                        : upgradeNeedsCompile
                          ? t("features.program-upgrade.compileRequiredHint")
                          : t("features.program-upgrade.staleArtifactHint", {
                              current: shortSignature(currentArtifactSha),
                              previous: shortSignature(lastFinalizedSha || ""),
                            })}
                    </p>
                  </div>
                </div>
                {!programSourceLoading && upgradeSourceDir && (
                  <button
                    type="button"
                    onClick={() => void handleProgramSourceImport(true)}
                    disabled={loading}
                    className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-amber-300/30 bg-amber-400/15 px-4 py-2 text-sm font-semibold text-amber-50 hover:bg-amber-400/25 disabled:opacity-50"
                  >
                    <RefreshCw className="h-4 w-4 shrink-0" />
                    {t("features.program-deploy.compileRequiredAction")}
                  </button>
                )}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.squads.spill")}</label>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={formData.spillAddress || ""}
                onChange={(e) => handleFormChange("spillAddress", e.target.value.trim())}
                disabled={loading}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white font-mono text-sm disabled:opacity-50"
                placeholder={t("features.squads.spillPlaceholder")}
              />
            </div>
            {loading && (
              <div className="space-y-3 rounded-lg border border-cyan-300/20 bg-cyan-400/10 p-3 text-cyan-50">
                <div className="flex items-start gap-3">
                  <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-cyan-200" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-cyan-50">
                        {t("features.program-upgrade.progressTitle")}
                      </p>
                      {programUpgradeProgress && programUpgradeProgress.write_total > 0 && (
                        <p className="font-mono text-xs text-cyan-100/90">
                          {t("features.program-upgrade.progressWriteCount", {
                            completed: programUpgradeProgress.write_completed,
                            total: programUpgradeProgress.write_total,
                          })}
                        </p>
                      )}
                    </div>
                    <p className="text-xs leading-5 text-cyan-100/80">
                      {programUpgradeProgress?.message ||
                        formData.message ||
                        t("features.program-upgrade.upgradeStarted")}
                    </p>
                    {programUpgradeProgress?.stage && (
                      <p className="text-[11px] text-cyan-100/70">
                        {t("features.program-upgrade.progressStageLabel", {
                          stage: ({
                            idle: t("features.program-upgrade.stage.idle"),
                            preparing: t("features.program-upgrade.stage.preparing"),
                            verifying: t("features.program-upgrade.stage.verifying"),
                            creating_buffer: t("features.program-upgrade.stage.creating_buffer"),
                            writing: t("features.program-upgrade.stage.writing"),
                            upgrading: t("features.program-upgrade.stage.upgrading"),
                            verifying_readback: t("features.program-upgrade.stage.verifying_readback"),
                            finalized: t("features.program-upgrade.stage.finalized"),
                            failed: t("features.program-upgrade.stage.failed"),
                          } as Record<string, string>)[programUpgradeProgress.stage] ||
                            programUpgradeProgress.stage,
                        })}
                      </p>
                    )}
                  </div>
                </div>
                {(() => {
                  const total = Math.max(0, Number(programUpgradeProgress?.write_total || 0));
                  const completed = Math.max(0, Number(programUpgradeProgress?.write_completed || 0));
                  const stage = String(programUpgradeProgress?.stage || "");
                  const percent =
                    stage === "finalized"
                      ? 100
                      : stage === "upgrading" || stage === "verifying_readback"
                        ? 100
                        : total > 0
                          ? Math.min(99, Math.round((completed / total) * 100))
                          : stage === "creating_buffer"
                            ? 2
                            : stage === "writing"
                              ? Math.min(99, Math.round((completed / Math.max(total, 1)) * 100))
                              : 0;
                  return (
                    <div className="space-y-1.5">
                      <div className="h-2 overflow-hidden rounded-full bg-black/30">
                        <div
                          className="h-full rounded-full bg-cyan-300/80 transition-[width] duration-300"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-cyan-100/70">
                        {t("features.program-upgrade.progressPercent", { percent })}
                      </p>
                    </div>
                  );
                })()}
                <ol className="space-y-1.5 border-t border-cyan-300/15 pt-3 text-xs text-cyan-100/85">
                  {[
                    { id: "creating_buffer", label: t("features.program-upgrade.progressStepBuffer") },
                    { id: "writing", label: t("features.program-upgrade.progressStepWrite") },
                    { id: "upgrading", label: t("features.program-upgrade.progressStepUpgrade") },
                    { id: "verifying_readback", label: t("features.program-upgrade.progressStepVerify") },
                  ].map((step, index) => {
                    const stage = String(programUpgradeProgress?.stage || "");
                    const order = ["preparing", "verifying", "creating_buffer", "writing", "upgrading", "verifying_readback", "finalized"];
                    const currentIdx = order.indexOf(stage);
                    const stepIdx = order.indexOf(step.id);
                    const done =
                      stage === "finalized" ||
                      (currentIdx >= 0 && stepIdx >= 0 && currentIdx > stepIdx);
                    const active =
                      stage === step.id ||
                      (step.id === "creating_buffer" && (stage === "preparing" || stage === "verifying")) ||
                      (step.id === "writing" && stage === "writing");
                    return (
                      <li
                        key={step.id}
                        className={
                          done
                            ? "text-emerald-200"
                            : active
                              ? "font-semibold text-cyan-50"
                              : "text-cyan-100/55"
                        }
                      >
                        {index + 1}. {step.label}
                        {step.id === "writing" &&
                          programUpgradeProgress &&
                          programUpgradeProgress.write_total > 0 &&
                          stage === "writing" && (
                            <span className="ml-2 font-mono text-[11px] text-cyan-100/80">
                              ({programUpgradeProgress.write_completed}/{programUpgradeProgress.write_total})
                            </span>
                          )}
                      </li>
                    );
                  })}
                </ol>
                {programUpgradeProgress?.last_signature && (
                  <p className="truncate font-mono text-[11px] text-cyan-100/60" title={programUpgradeProgress.last_signature}>
                    {t("features.program-upgrade.progressLastSignature", {
                      signature: shortSignature(programUpgradeProgress.last_signature),
                    })}
                  </p>
                )}
                <p className="text-[11px] leading-5 text-cyan-100/65">
                  {t("features.program-upgrade.progressWaitHint")}
                </p>
              </div>
            )}
            {programUpgradeInlineError && (
              <div className="space-y-2 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-red-100">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-200" />
                    <p className="font-semibold">{t("features.program-upgrade.upgradeErrorTitle")}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(
                      [
                        programUpgradeInlineError.friendly,
                        programUpgradeInlineError.raw !== programUpgradeInlineError.friendly
                          ? programUpgradeInlineError.raw
                          : "",
                      ].filter(Boolean).join("\n\n"),
                      "program-upgrade-inline-error",
                    )}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-red-400/15 px-2 py-1 text-[11px] font-medium text-red-50 hover:bg-red-400/25"
                  >
                    {copied === "program-upgrade-inline-error" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {t("features.program-deploy.sourceValidationCopy")}
                  </button>
                </div>
                <p className="text-sm leading-6 text-red-50">{programUpgradeInlineError.friendly}</p>
                {programUpgradeInlineError.raw !== programUpgradeInlineError.friendly && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-red-200/80">
                      {t("features.program-upgrade.rawErrorLabel")}
                    </p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/40 p-2 font-mono text-[11px] leading-5 text-red-100">
                      {programUpgradeInlineError.raw}
                    </pre>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => requestPasswordSubmit("program-upgrade")}
              disabled={loading || programSourceLoading || upgradeNeedsCompile || upgradeArtifactIsStale}
              className="w-full py-3 bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-lg font-semibold hover:from-emerald-600 hover:to-cyan-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.program-upgrade.upgrading") : t("features.program-upgrade.upgradeButton")}
            </button>
            {formData.message && !loading && !upgradeJustSucceeded && (
              <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                {formData.message}
              </div>
            )}
          </div>
        );
      }

      case "squads-program-upgrade":
        return (
          renderStepForm([
            {
              title: t("features.workspace.stepTarget"),
              content: (
                <>
                  {renderMultisigInput()}
                  {renderProgramIdInput()}
                </>
              ),
            },
            {
              title: t("features.workspace.stepDetails"),
              content: (
                <>
                  {renderMultisigInput()}
                  {renderProgramIdInput()}
                  {renderBufferInput()}
                  {renderSpillInput()}
                  {renderMemoInput()}
                </>
              ),
            },
            {
              title: t("features.workspace.stepSubmit"),
              content: (
                <>
                  <button type="button" onClick={() => requestPasswordSubmit("squads-program-upgrade")} disabled={loading} className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50">
                    {loading ? t("features.squads-program-upgrade.creating") : t("features.squads-program-upgrade.createButton")}
                  </button>
                  {renderSquadsResult()}
                </>
              ),
            },
          ])
        );

      case "squads-set-authority":
        return (
          <div className="space-y-4">
            {renderMultisigInput()}
            {renderProgramIdInput()}
            <button type="button" onClick={() => requestPasswordSubmit("squads-set-authority")} disabled={loading} className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50">
              {loading ? t("features.squads-set-authority.setting") : t("features.squads-set-authority.setButton")}
            </button>
            {renderSquadsResult()}
          </div>
        );

      case "squads-approve":
      case "squads-reject":
        return (
          <div className="space-y-4">
            {renderMultisigInput()}
            {renderProposalInput()}
            {renderMemoInput()}
            <button type="button" onClick={() => requestPasswordSubmit(formId)} disabled={loading} className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50">
              {loading
                ? formId === "squads-approve"
                  ? t("features.squads-approve.approving")
                  : t("features.squads-reject.rejecting")
                : formId === "squads-approve"
                  ? t("features.squads-approve.approveButton")
                  : t("features.squads-reject.rejectButton")}
            </button>
            {renderSquadsResult()}
          </div>
        );

      case "squads-execute":
        return (
          <div className="space-y-4">
            {renderMultisigInput()}
            {renderProposalInput()}
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.squads.transactionIndex")}</label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={formData.transactionIndex || ""}
                onChange={(e) => handleFormChange("transactionIndex", e.target.value.replace(/[^\d]/g, ""))}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.squads.transactionIndexPlaceholder")}
              />
            </div>
            <button type="button" onClick={() => requestPasswordSubmit("squads-execute")} disabled={loading} className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50">
              {loading ? t("features.squads-execute.executing") : t("features.squads-execute.executeButton")}
            </button>
            {renderSquadsResult()}
          </div>
        );

      case "setup-2fa":
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.setup-2fa.hardwareFingerprint")}</label>
              <input
                type="text"
                value={formData.hardware_fingerprint || ""}
                onChange={(e) => handleFormChange("hardware_fingerprint", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.setup-2fa.fingerprintPlaceholder")}
              />
              <p className="mt-1 text-xs text-gray-400">{t("features.setup-2fa.fingerprintHint")}</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.setup-2fa.accountName")}</label>
              <input
                type="text"
                value={formData.account || ""}
                onChange={(e) => handleFormChange("account", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.setup-2fa.accountPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.setup-2fa.issuer")}</label>
              <input
                type="text"
                value={formData.issuer || ""}
                onChange={(e) => handleFormChange("issuer", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.setup-2fa.issuerPlaceholder")}
              />
            </div>
            <button type="button"
              onClick={() => requestPasswordSubmit("setup-2fa")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.setup-2fa.generating") : t("features.setup-2fa.generateButton")}
            </button>
            {formData.totp_secret && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.setup-2fa.totpSecret")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.totp_secret}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.totp_secret as string, "totp")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "totp" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.setup-2fa.qrCodeUrl")}</label>
                  <code className="block px-3 py-2 bg-black/30 rounded text-xs break-all">
                    {formData.qr_code_url}
                  </code>
                </div>
              </div>
            )}
          </div>
        );

      case "create-tfa": {
        const tfaAuth = authMethod["create-tfa"] ?? "keystore";
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "create-tfa": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    tfaAuth === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "create-tfa": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    tfaAuth === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "create-tfa": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    tfaAuth === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {tfaAuth === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("features.create-tfa.uploadFile")}</label>
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && tfaAuth === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && tfaAuth === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("features.create-tfa.privateKeyLabel")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("features.create-tfa.privateKeyPlaceholder")}
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.create-tfa.totpSecret")}</label>
              <input
                type="text"
                value={formData.totp_secret || ""}
                onChange={(e) => handleFormChange("totp_secret", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.create-tfa.totpSecretPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.create-tfa.hardwareFingerprint")}</label>
              <input
                type="text"
                value={formData.hardware_fingerprint || ""}
                onChange={(e) => handleFormChange("hardware_fingerprint", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.create-tfa.fingerprintPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.create-tfa.questionIndex")}</label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={formData.question_index === undefined ? "" : formData.question_index}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^\d]/g, "");
                  if (raw === "") {
                    handleFormChange("question_index", undefined);
                    return;
                  }
                  const n = parseInt(raw, 10);
                  handleFormChange("question_index", Number.isNaN(n) ? undefined : n);
                }}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.create-tfa.questionIndexPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.create-tfa.securityAnswer")}</label>
              <input
                type="password"
                value={formData.security_answer || ""}
                onChange={(e) => handleFormChange("security_answer", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.create-tfa.answerPlaceholder")}
                autoComplete="off"
              />
            </div>
            <button type="button"
              onClick={() => requestPasswordSubmit("create-tfa")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.create-tfa.creating") : t("features.create-tfa.createButton")}
            </button>
            {formData.encrypted_wallet && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.publicKey")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.publicKey}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.publicKey as string, "tfa-pubkey")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "tfa-pubkey" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-tfa.encryptedWallet")}</label>
                  <p className="text-xs text-gray-400">{t("features.create-tfa.saveHint")}</p>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all max-h-32 overflow-y-auto">
                      {formData.encrypted_wallet}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.encrypted_wallet as string, "tfa-enc")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "tfa-enc" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      }

      case "unlock-tfa":
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.unlock-tfa.encryptedWallet")}</label>
              <textarea
                value={formData.encrypted_wallet || ""}
                onChange={(e) => handleFormChange("encrypted_wallet", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[100px]"
                placeholder={t("features.unlock-tfa.walletPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.unlock-tfa.hardwareFingerprint")}</label>
              <input
                type="text"
                value={formData.hardware_fingerprint || ""}
                onChange={(e) => handleFormChange("hardware_fingerprint", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.unlock-tfa.fingerprintPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.unlock-tfa.securityAnswer")}</label>
              <input
                type="password"
                value={formData.security_answer || ""}
                onChange={(e) => handleFormChange("security_answer", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.unlock-tfa.answerPlaceholder")}
                autoComplete="off"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.unlock-tfa.totpCode")}</label>
              <input
                type="password"
                value={formData.totp_code || ""}
                onChange={(e) => handleFormChange("totp_code", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.unlock-tfa.totpPlaceholder")}
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </div>
            <button type="button"
              onClick={() => requestPasswordSubmit("unlock-tfa")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.unlock-tfa.unlocking") : t("features.unlock-tfa.unlockButton")}
            </button>
            {formData.unlocked && formData.publicKey && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("features.create-plain.publicKey")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.publicKey}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.publicKey as string, "unlock-pubkey")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "unlock-pubkey" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <p className="text-sm text-green-400">{t("formUi.walletUnlockedNoSecret")}</p>
              </div>
            )}
          </div>
        );

      case "close-wsol-ata":
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "close-wsol-ata": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("close-wsol-ata") === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "close-wsol-ata": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("close-wsol-ata") === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "close-wsol-ata": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("close-wsol-ata") === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {walletAuth("close-wsol-ata") === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("close-wsol-ata") === "encrypted" && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                  <textarea
                    value={formData.encrypted_key || ""}
                    onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                    placeholder={t("formUi.placeholderEncryptedKey")}
                  />
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("close-wsol-ata") === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.privateKey")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
              </div>
            )}
            <button type="button"
              onClick={() => requestPasswordSubmit("close-wsol-ata")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.close-wsol-ata.closing") : t("features.close-wsol-ata.closeButton")}
            </button>
            {formData.signature && (
              <div className="space-y-3 p-4 bg-white/5 rounded-lg">
                <div>
                  <label className="block text-sm font-medium mb-2">{t("formUi.txSignature")}</label>
                  <div className="flex gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
                      {formData.signature}
                    </code>
                    <button type="button"
                      onClick={() => copyToClipboard(formData.signature as string, "close-ata")}
                      className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
                    >
                      {copied === "close-ata" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );

      case "pumpfun-sell":
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "pumpfun-sell": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("pumpfun-sell") === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "pumpfun-sell": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("pumpfun-sell") === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "pumpfun-sell": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("pumpfun-sell") === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {walletAuth("pumpfun-sell") === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("pumpfun-sell") === "encrypted" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                <textarea
                  value={formData.encrypted_key || ""}
                  onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                  placeholder={t("formUi.placeholderEncryptedKey")}
                />
              </div>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("pumpfun-sell") === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("features.pumpfun-sell.privateKeyLabel")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("features.pumpfun-sell.privateKeyPlaceholder")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-2">{t("features.pumpfun-sell.mintAddress")}</label>
              <input
                type="text"
                value={formData.mint || ""}
                onChange={(e) => handleFormChange("mint", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.pumpfun-sell.mintPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.pumpfun-sell.amount")}</label>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={formData.amount ?? ""}
                onChange={(e) => handleFormChange("amount", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.pumpfun-sell.amountPlaceholder")}
              />
              <p className="mt-2 text-xs text-gray-400">{t("features.pumpfun-sell.sellPercent")}</p>
              <div className="mt-2 grid grid-cols-4 gap-2">
                {[25, 50, 75, 100].map((percent) => (
                  <button
                    key={percent}
                    type="button"
                    onClick={() => void handleSellPercentShortcut("pumpfun-sell", percent)}
                    className="rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-gray-200 transition-colors hover:bg-white/20"
                  >
                    {percent}%
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.pumpfun-sell.slippage")}</label>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={slippageInputDisplay(formData.slippage)}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    handleFormChange("slippage", undefined);
                    return;
                  }
                  const n = parseFloat(raw);
                  handleFormChange("slippage", Number.isNaN(n) ? undefined : n);
                }}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.pumpfun-sell.slippagePlaceholder")}
              />
            </div>
            <button type="button"
              onClick={() => requestPasswordSubmit("pumpfun-sell")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.pumpfun-sell.selling") : t("features.pumpfun-sell.sellButton")}
            </button>
            {formData.status === "success" && (
              <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
                <p className="text-green-400">{t("formUi.sellSuccess")}</p>
              </div>
            )}
          </div>
        );

      case "pumpswap-sell":
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "pumpswap-sell": "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("pumpswap-sell") === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "pumpswap-sell": "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("pumpswap-sell") === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, "pumpswap-sell": "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    walletAuth("pumpswap-sell") === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {walletAuth("pumpswap-sell") === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("pumpswap-sell") === "encrypted" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                <textarea
                  value={formData.encrypted_key || ""}
                  onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                  placeholder={t("formUi.placeholderEncryptedKey")}
                />
              </div>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && walletAuth("pumpswap-sell") === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("features.pumpswap-sell.privateKeyLabel")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("features.pumpswap-sell.privateKeyPlaceholder")}
                />
                <p className="mt-1 text-xs text-yellow-400">{t("formUi.warnPlaintextStrong")}</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-2">{t("features.pumpswap-sell.mintAddress")}</label>
              <input
                type="text"
                value={formData.mint || ""}
                onChange={(e) => handleFormChange("mint", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.pumpswap-sell.mintPlaceholder")}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.pumpswap-sell.amount")}</label>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={formData.amount ?? ""}
                onChange={(e) => handleFormChange("amount", e.target.value)}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.pumpswap-sell.amountPlaceholder")}
              />
              <p className="mt-2 text-xs text-gray-400">{t("features.pumpswap-sell.sellPercent")}</p>
              <div className="mt-2 grid grid-cols-4 gap-2">
                {[25, 50, 75, 100].map((percent) => (
                  <button
                    key={percent}
                    type="button"
                    onClick={() => void handleSellPercentShortcut("pumpswap-sell", percent)}
                    className="rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-gray-200 transition-colors hover:bg-white/20"
                  >
                    {percent}%
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">{t("features.pumpswap-sell.slippage")}</label>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={slippageInputDisplay(formData.slippage)}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    handleFormChange("slippage", undefined);
                    return;
                  }
                  const n = parseFloat(raw);
                  handleFormChange("slippage", Number.isNaN(n) ? undefined : n);
                }}
                className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                placeholder={t("features.pumpswap-sell.slippagePlaceholder")}
              />
            </div>
            <button type="button"
              onClick={() => requestPasswordSubmit("pumpswap-sell")}
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading ? t("features.pumpswap-sell.selling") : t("features.pumpswap-sell.sellButton")}
            </button>
            {formData.status === "success" && (
              <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
                <p className="text-green-400">{t("formUi.sellSuccess")}</p>
              </div>
            )}
          </div>
        );

      case "pumpfun-cashback":
      case "pumpswap-cashback": {
        const cashbackAuth = walletAuth(selectedForm || "pumpfun-cashback");
        const cashbackDex = selectedForm === "pumpswap-cashback" ? "pumpswap" : "pumpfun";
        const currentCashbackInfo = cashbackInfo
          ? cashbackInfo.owner === effectiveWallet?.public_key &&
            cashbackInfo.network === effectiveNetwork &&
            cashbackInfo.dex === cashbackDex
            ? cashbackInfo
            : null
          : null;
        return (
          <div className="space-y-4">
            <div className={ALLOW_DIRECT_SECRET_INPUT ? undefined : "hidden"}>
              <label className="block text-sm font-medium mb-2">{t("formUi.authMethod")}</label>
              <div className={ALLOW_DIRECT_SECRET_INPUT ? "grid grid-cols-3 gap-2" : "grid grid-cols-1 gap-2 [&>button:not(:first-child)]:hidden"}>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, [selectedForm || "pumpfun-cashback"]: "keystore" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.encrypted_key;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    cashbackAuth === "keystore"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabKeystore")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, [selectedForm || "pumpfun-cashback"]: "encrypted" });
                    const newFormData = { ...formData };
                    delete newFormData.private_key;
                    delete newFormData.keystoreJson;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    cashbackAuth === "encrypted"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabEncrypted")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod({ ...authMethod, [selectedForm || "pumpfun-cashback"]: "private" });
                    const newFormData = { ...formData };
                    delete newFormData.keystoreJson;
                    delete newFormData.encrypted_key;
                    delete newFormData.password;
                    setFormData(newFormData);
                  }}
                  className={`py-2 px-3 rounded-lg font-medium transition-colors text-sm ${
                    cashbackAuth === "private"
                      ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white"
                      : "bg-white/5 text-gray-400 hover:bg-white/10"
                  }`}
                >
                  {t("formUi.tabPrivateKey")}
                </button>
              </div>
            </div>

            {cashbackAuth === "keystore" && (
              <>
                <div className={formData.wallet_id ? "hidden" : undefined}>
                  <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFileUpload}
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
                  />
                  {formData.keystoreJson && (
                    <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
                  )}
                </div>
              </>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && cashbackAuth === "encrypted" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.encryptedKey")}</label>
                <textarea
                  value={formData.encrypted_key || ""}
                  onChange={(e) => handleFormChange("encrypted_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white min-h-[120px]"
                  placeholder={t("formUi.placeholderEncryptedKey")}
                />
              </div>
            )}

            {ALLOW_DIRECT_SECRET_INPUT && cashbackAuth === "private" && (
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.privateKey")}</label>
                <input
                  type="password"
                  value={formData.private_key || ""}
                  onChange={(e) => handleFormChange("private_key", e.target.value)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
                  placeholder={t("formUi.placeholderPrivateKeyBase58")}
                />
              </div>
            )}
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-gray-400">
                    {selectedForm === "pumpswap-cashback"
                      ? t("features.pumpswap-cashback.availableAmount")
                      : t("features.pumpfun-cashback.availableAmount")}
                  </p>
                  <p className="mt-2 text-3xl font-semibold">
                    {currentCashbackInfo?.loading
                      ? "--"
                      : `${currentCashbackInfo?.uiAmountString ?? "0"} ${currentCashbackInfo?.asset ?? (selectedForm === "pumpswap-cashback" ? "WSOL" : "SOL")}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadCashbackInfo(cashbackDex, effectiveWallet)}
                  className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/20"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${currentCashbackInfo?.loading ? "animate-spin" : ""}`} />
                  {selectedForm === "pumpswap-cashback"
                    ? t("features.pumpswap-cashback.refreshAmount")
                    : t("features.pumpfun-cashback.refreshAmount")}
                </button>
              </div>
              {currentCashbackInfo?.accumulator && (
                <button
                  type="button"
                  onClick={() => copyToClipboard(currentCashbackInfo.accumulator || "", `cashback-accumulator:${cashbackDex}`)}
                  className="mt-3 block max-w-full truncate text-left font-mono text-xs text-gray-500 hover:text-white"
                >
                  {currentCashbackInfo.accumulator}
                </button>
              )}
              {currentCashbackInfo?.error && (
                <p className="mt-3 text-xs text-yellow-200">{currentCashbackInfo.error}</p>
              )}
            </div>
            <button type="button"
              onClick={() => requestPasswordSubmit(selectedForm || "")}
              disabled={loading || currentCashbackInfo?.loading || currentCashbackInfo?.available !== true}
              className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg font-semibold hover:from-purple-600 hover:to-pink-600 transition-all disabled:opacity-50"
            >
              {loading
                ? selectedForm === "pumpswap-cashback"
                  ? t("features.pumpswap-cashback.claiming")
                  : t("features.pumpfun-cashback.claiming")
                : selectedForm === "pumpswap-cashback"
                  ? t("features.pumpswap-cashback.claimButton")
                  : t("features.pumpfun-cashback.claimButton")}
            </button>
            {formData.message && (
              <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                <p className="text-blue-400 text-sm">{formData.message}</p>
                {formData.signature && (
                  <button
                    type="button"
                    onClick={() => copyToClipboard(String(formData.signature), "cashback-signature")}
                    className="mt-2 block max-w-full truncate text-left font-mono text-xs text-blue-200 hover:text-white"
                  >
                    {formData.signature}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      }

      default:
        return <div className="text-center text-gray-400">{t("formUi.pickFeature")}</div>;
      }
    };

    const internalSquadsForms = new Set([
      "squads-create",
      "squads-info",
      "squads-sol-transfer",
      "squads-token-transfer",
      "squads-prepare-upgrade-buffer",
      "squads-program-upgrade",
      "squads-set-authority",
    ]);
    const showSquadsWalletPicker = ALLOW_DIRECT_SECRET_INPUT && internalSquadsForms.has(formId);
    const showTokenActionHeader = tokenActionContext && TOKEN_ACTION_FORM_IDS.has(formId);
    const tokenActionMint = String((tokenActionContext?.mint ?? formData.mint) || "");
    const tokenActionBalance = String((tokenActionContext?.token_balance ?? formData.token_balance ?? formData.amount) || "0");
    const tokenActionDecimals = tokenActionContext?.decimals ?? formData.decimals;
    const transferSolWallet = selectedSavedWallet() ?? effectiveWallet;
    const transferSolAssets =
      transferSolWallet &&
      walletAssets?.address === transferSolWallet.public_key &&
      walletAssets.network === effectiveNetwork
        ? walletAssets
        : null;
    const transferSolBalance =
      transferSolAssets?.solBalance && transferSolAssets.solBalance !== "--"
        ? transferSolAssets.solBalance
        : "--";
    const transferTokenMint = String(formData.mint ?? "").trim();
    const transferTokenWallet = selectedSavedWallet() ?? effectiveWallet;
    const transferTokenAssets =
      transferTokenWallet &&
      walletAssets?.address === transferTokenWallet.public_key &&
      walletAssets.network === effectiveNetwork
        ? walletAssets
        : null;
    const transferTokenBalance =
      transferTokenMint && transferTokenAssets
        ? aggregateTokenBalance(transferTokenAssets.tokens, transferTokenMint)
        : null;

    return (
      <div className={formId === "dapp-store" ? "h-full min-h-0" : "space-y-4"}>
        {showTokenActionHeader && (
          <div className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-normal text-gray-500">
                  {t("features.token-actions.token")}
                </p>
                <button
                  type="button"
                  onClick={() => copyToClipboard(tokenActionMint, "token-actions-mint")}
                  className="mt-1 block max-w-full truncate text-left font-mono text-sm text-gray-200 hover:text-white"
                >
                  {tokenActionMint}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:min-w-56">
                <div className="rounded-lg bg-black/20 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-gray-500">{t("features.token-actions.balance")}</p>
                    <button
                      type="button"
                      onClick={() => refreshCurrentWalletAssets()}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white"
                      title={t("features.wallet-list.refreshAssets")}
                      aria-label={t("features.wallet-list.refreshAssets")}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${walletAssets?.refreshing ? "animate-spin" : ""}`} />
                    </button>
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold">{tokenActionBalance}</p>
                </div>
                <div className="rounded-lg bg-black/20 px-3 py-2">
                  <p className="text-xs text-gray-500">{t("features.token-actions.decimals")}</p>
                  <p className="mt-1 text-sm font-semibold">{String(tokenActionDecimals ?? "")}</p>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-black/20 p-1">
              {[
                { id: "pumpfun-sell" as const, label: t("features.token-actions.sell") },
                { id: "transfer-token" as const, label: t("features.token-actions.transfer") },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => switchTokenAction(tab.id)}
                  className={`h-10 rounded-lg text-sm font-semibold transition-colors ${
                    formId === tab.id
                      ? "bg-white text-black"
                      : "text-gray-300 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {showSquadsWalletPicker && (
          <SavedWalletPicker
            copied={copied}
            formData={formData}
            formId={formId}
            loading={walletsLoading}
            t={t}
            walletAuth={walletAuth(formId)}
            wallets={wallets}
            showTemporaryKeystore
            onCopy={copyToClipboard}
            onFieldChange={handleFormChange}
            onKeystoreUpload={handleFileUpload}
            onRefresh={() => void loadWallets()}
          />
        )}
        {renderFormBody()}
      </div>
    );
  };

  const selectedFormTitle = selectedForm
    ? tokenActionContext && TOKEN_ACTION_FORM_IDS.has(selectedForm)
      ? t("features.token-actions.title")
      : menuItems
        .flatMap((m) => m.children || [])
        .find((c) => c?.id === selectedForm)?.label ||
      ({
        "wallet-list": t("features.wallet-list.title"),
        "wsol-workbench": t("features.wsol-workbench.title"),
        "pump-workbench": t("features.pump-workbench.title"),
        "dapp-store": tf("features.dapp-store.title", "DApp Store"),
        "contract-tools": tf("features.contract-tools.title", "合约工具"),
        "program-workbench": t("features.program-workbench.title"),
        "nonce-workbench": t("features.nonce-workbench.title"),
        "settings": t("features.settings.title"),
        "create-encrypted": t("features.create-encrypted.title"),
        "create-keystore": t("features.create-keystore.title"),
        "import-keystore": t("features.import-keystore.title"),
        "import-mnemonic": t("features.import-mnemonic.title"),
        "decrypt": t("features.decrypt.title"),
        "setup-2fa": t("features.setup-2fa.title"),
        "create-tfa": t("features.create-tfa.title"),
        "unlock-tfa": t("features.unlock-tfa.title"),
        "unlock": t("features.unlock.title"),
        "check-balance": t("features.check-balance.title"),
        "get-pubkey": t("features.get-pubkey.title"),
        "transfer-sol": t("features.transfer-sol.title"),
        "transfer-token": t("features.transfer-token.title"),
        "create-wsol-ata": t("features.create-wsol-ata.title"),
        "wrap-sol": t("features.wrap-sol.title"),
        "unwrap-sol": t("features.unwrap-sol.title"),
        "close-wsol-ata": t("features.close-wsol-ata.title"),
        "pumpfun-sell": t("features.pumpfun-sell.title"),
        "pumpswap-sell": t("features.pumpswap-sell.title"),
        "pumpfun-cashback": t("features.pumpfun-cashback.title"),
        "pumpswap-cashback": t("features.pumpswap-cashback.title"),
        "create-nonce": t("features.create-nonce.title"),
        "program-deploy": t("features.program-deploy.title"),
        "program-upgrade": t("features.program-upgrade.title"),
        "program-invoke": t("features.program-invoke.title"),
        "program-invoke-standalone": t("features.program-invoke.title"),
        "external-sign": t("features.external-sign.title"),
        "program-info": t("features.program-info.title"),
        "squads-workspace": t("features.workspace.title"),
        "squads-proposals": t("features.workspace.savedProposals"),
        "squads-programs": t("features.workspace.savedPrograms"),
        "squads-create": t("features.squads-create.title"),
        "squads-info": t("features.squads-info.title"),
        "squads-sol-transfer": t("features.squads-sol-transfer.title"),
        "squads-token-transfer": t("features.squads-token-transfer.title"),
        "squads-prepare-upgrade-buffer": t("features.squads-prepare-upgrade-buffer.title"),
        "squads-program-upgrade": t("features.squads-program-upgrade.title"),
        "squads-set-authority": t("features.squads-set-authority.title"),
      } as Record<string, string>)[selectedForm] ||
      t("formUi.pickFeature")
    : t("app.welcome");
  const isDappBrowserForm = selectedForm === "dapp-store";
  const showFormHeader = selectedForm !== "wallet-list" && !isDappBrowserForm;
  const isWideWorkspaceForm = [
    "contract-tools",
    "program-workbench",
    "program-deploy",
    "program-upgrade",
    "program-invoke",
    "program-invoke-standalone",
    "external-sign",
    "dapp-store",
    "squads-prepare-upgrade-buffer",
    "squads-program-upgrade",
  ].includes(selectedForm || "");
  const contentContainerClass = isDappBrowserForm
    ? "h-full min-h-0 w-full p-0"
    : isWideWorkspaceForm
    ? "mx-auto w-full max-w-[1760px] p-3 space-y-3 sm:p-4 lg:p-5 lg:space-y-4 2xl:max-w-[1900px]"
    : "max-w-5xl mx-auto p-3 space-y-3 sm:p-4 lg:p-8 lg:space-y-4";
  const contentCardClass = isDappBrowserForm
    ? "app-content-card app-dapp-card h-full min-h-0 bg-black/40"
    : "app-content-card bg-black/40 backdrop-blur-xl rounded-xl border border-white/10 p-3 sm:p-4 lg:rounded-2xl lg:p-6";
  const themeOptions: ThemeOption[] = [
    { id: "light", label: t("app.themeDay"), icon: <Sun className="h-4 w-4" /> },
    { id: "deep-sea", label: t("app.themeDeepSea"), icon: <Moon className="h-4 w-4" /> },
    { id: "dark", label: t("app.themeNight"), icon: <CircleDot className="h-4 w-4" /> },
  ];
  const renderThemeSwitcher = (compact = false) => (
    <ThemeSwitcher
      appTheme={appTheme}
      compact={compact}
      label={t("app.themeStyle")}
      options={themeOptions}
      onSelect={selectAppTheme}
    />
  );
  const renderSettingsShortcut = () => (
    <button
      type="button"
      onClick={() => handleSelectForm("settings")}
      className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 text-gray-200 transition-colors hover:bg-white/10 hover:text-white ${
        selectedForm === "settings" ? "bg-white/15 text-white" : "bg-white/5"
      }`}
      aria-label={t("features.settings.title")}
      title={t("features.settings.title")}
      aria-pressed={selectedForm === "settings"}
    >
      <Settings className="h-4 w-4" />
    </button>
  );
  const dappSignWallet = dappSignRequest
    ? wallets.find((wallet) => wallet.public_key === dappSignRequest.wallet_public_key)
    : undefined;
  const dappBiometricConfigured = biometricConfiguredFor(dappSignWallet);
  const dappBiometricAvailable = canUseBiometricWallet(dappSignWallet);
  const dappBiometricBusy = Boolean(dappSignWallet && biometricBusyWalletId === dappSignWallet.id);
  return (
    <div
      className="app-shell flex min-h-screen flex-col bg-black text-white lg:h-screen lg:flex-row"
      data-app-theme={appTheme}
    >
      {/* Left Sidebar */}
      <div className={`app-sidebar w-full bg-black/40 backdrop-blur-xl border-b border-white/10 flex flex-col transition-[width] duration-200 lg:h-screen lg:border-b-0 lg:border-r ${
        desktopSidebarCollapsed ? "lg:w-20" : "lg:w-80"
      }`}>
        <div className={`p-3 border-b border-white/10 flex items-start justify-between gap-3 lg:p-4 ${
          desktopSidebarCollapsed ? "lg:justify-center" : ""
        }`}>
          <div className={`min-w-0 ${desktopSidebarCollapsed ? "lg:hidden" : ""}`}>
            <h1 className="whitespace-nowrap text-xl font-bold leading-tight bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent lg:text-[1.65rem]">
              {t("app.title")}
            </h1>
            <p className="mt-1 hidden truncate whitespace-nowrap text-sm text-gray-400 sm:block">{t("app.subtitle")}</p>
            <p className="mt-1 truncate text-xs text-gray-400 lg:hidden">{selectedFormTitle}</p>
          </div>
          <div className="flex shrink-0 items-start gap-2">
            <button
              type="button"
              onClick={() => setDesktopSidebarCollapsed((collapsed) => !collapsed)}
              className="hidden h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 lg:inline-flex"
              aria-label={desktopSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={desktopSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {desktopSidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((open) => !open)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 lg:hidden"
              aria-label={t("formUi.pickFeature")}
            >
              {mobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <nav className={`hidden flex-1 space-y-2 overflow-y-auto scrollbar-thin lg:flex lg:flex-col ${
          desktopSidebarCollapsed ? "p-2" : "p-4"
        }`}>
          {menuItems.map((item) => (
            <div
              key={item.id}
              className="min-w-0"
            >
              <button type="button"
                onClick={() => handleDesktopMenuClick(item)}
                className={`w-full flex items-center rounded-lg transition-colors ${
                  selectedForm === item.id
                    ? "bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-white"
                    : "hover:bg-white/5 text-gray-300"
                } ${desktopSidebarCollapsed ? "h-12 justify-center px-0 py-0" : "justify-between px-4 py-3"}`}
                title={item.label}
              >
                <div className={`flex min-w-0 items-center ${desktopSidebarCollapsed ? "justify-center" : "gap-3"}`}>
                  {item.icon}
                  <span className={`truncate font-medium ${desktopSidebarCollapsed ? "hidden" : ""}`}>{item.label}</span>
                </div>
                {item.children && !desktopSidebarCollapsed && (
                  activeMenu === item.id ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )
                )}
              </button>

              {item.children && activeMenu === item.id && !desktopSidebarCollapsed && (
                <div className="ml-4 mt-2 space-y-1">
                  {item.children.map((child) => (
                    <button type="button"
                      key={child.id}
                      onClick={() => handleSelectForm(child.id)}
                      className={`w-full flex items-center gap-3 px-4 py-2 rounded-lg transition-colors ${
                        selectedForm === child.id
                          ? "bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-white"
                          : "hover:bg-white/5 text-gray-400"
                      }`}
                    >
                      {child.icon}
                      <span className="truncate text-sm">{child.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className={`hidden border-t border-white/10 lg:block ${desktopSidebarCollapsed ? "p-2" : "p-4"}`}>
          <div className={`flex gap-2 ${desktopSidebarCollapsed ? "flex-col items-center" : "items-center justify-start"}`}>
            {renderSettingsShortcut()}
            {renderThemeSwitcher(true)}
            <LanguageSwitcher />
          </div>
        </div>
      </div>

      {mobileMenuOpen && (
        <button
          type="button"
          aria-label={t("common.cancel")}
          onClick={() => setMobileMenuOpen(false)}
          className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm lg:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-[120] flex w-80 max-w-[86vw] flex-col border-r border-white/10 bg-zinc-950 shadow-2xl transition-transform duration-200 lg:hidden ${
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-4">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold">{t("app.title")}</p>
            <p className="mt-1 truncate text-sm text-gray-400">{selectedFormTitle}</p>
          </div>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-gray-200 hover:bg-white/20"
            aria-label={t("common.cancel")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 space-y-2 overflow-y-auto p-3 scrollbar-thin">
          {menuItems.map((item) => (
            <div key={item.id} className="min-w-0">
              <button
                type="button"
                onClick={() => item.children ? toggleMenu(item.id) : handleSelectForm(item.id)}
                className={`flex w-full items-center justify-between rounded-xl px-4 py-3 text-left transition-colors ${
                  selectedForm === item.id
                    ? "bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-white"
                    : "text-gray-300 hover:bg-white/5"
                }`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  {item.icon}
                  <span className="truncate text-base font-medium">{item.label}</span>
                </span>
                {item.children && (
                  activeMenu === item.id ? (
                    <ChevronDown className="h-4 w-4 shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0" />
                  )
                )}
              </button>
              {item.children && activeMenu === item.id && (
                <div className="ml-4 mt-2 space-y-1 border-l border-white/10 pl-2">
                  {item.children.map((child) => (
                    <button
                      type="button"
                      key={child.id}
                      onClick={() => handleSelectForm(child.id)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                        selectedForm === child.id
                          ? "bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-white"
                          : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
                      }`}
                    >
                      {child.icon}
                      <span className="truncate text-sm">{child.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t border-white/10 p-3">
          {renderSettingsShortcut()}
          {renderThemeSwitcher(true)}
          <LanguageSwitcher />
        </div>
      </aside>

      {/* Main Content */}
      <div className={`app-main-surface min-w-0 flex-1 bg-gradient-to-br from-black via-purple-950 to-black ${
        isDappBrowserForm ? "overflow-hidden" : "overflow-y-auto"
      }`}>
        <div className={isDappBrowserForm ? "h-full min-h-0" : "min-h-full overflow-y-auto"}>
          <div className={contentContainerClass}>
            <div className={contentCardClass}>
              {showFormHeader && (
                <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
                  {selectedForm && (backTarget || defaultBackTarget(selectedForm)) && (
                    <button
                      type="button"
                      onClick={handleBack}
                      className="inline-flex w-fit items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-300 hover:bg-white/10 hover:text-white"
                    >
                      <ArrowLeft className="h-4 w-4" />
                      {t("common.back")}
                    </button>
                  )}
                  <h2 className="min-w-0 break-words text-xl font-bold sm:text-2xl">
                    {selectedFormTitle}
                  </h2>
                </div>
              )}
              {selectedForm ? renderForm(selectedForm) : (
                <div className="text-center py-12 text-gray-400">
                  <Key className="w-16 h-16 mx-auto mb-4 opacity-50" />
                  <p className="text-lg">{t("app.selectFeature")}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {programInvokeWalletPickerTarget &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[195] flex items-end bg-black/60"
            onClick={() => setProgramInvokeWalletPickerTarget(null)}
          >
            <div
              className="relative max-h-[85vh] w-full overflow-y-auto border-t border-white/10 bg-zinc-950 px-4 py-5 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mx-auto max-w-xl space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold">{tf("features.program-invoke.walletPickerTitle", "选择钱包")}</h3>
                    <p className="mt-1 text-sm text-gray-400">
                      {tf("features.program-invoke.walletPickerHint", "选择客户端里已保存的钱包地址，选中后会自动填入当前输入框。")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setProgramInvokeWalletPickerTarget(null)}
                    className="rounded-lg bg-white/10 p-2 text-gray-300 hover:bg-white/20"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {wallets.length === 0 ? (
                  <p className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-400">
                    {tf("features.program-invoke.noSavedWallets", "当前客户端还没有已保存钱包。")}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {wallets.map((wallet) => (
                      <button
                        key={wallet.id}
                        type="button"
                        onClick={() => selectProgramInvokeWalletAddress(wallet)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-left hover:bg-white/10"
                      >
                        <span className="flex items-center justify-between gap-3">
                          <span
                            className="min-w-0 cursor-text truncate text-sm font-semibold text-gray-100 select-text"
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                          >
                            {walletLabel(wallet)}
                          </span>
                          {wallet.id === effectiveWalletId && (
                            <span className="shrink-0 rounded bg-cyan-400/15 px-2 py-0.5 text-[11px] text-cyan-100">
                              {t("features.program-invoke.currentWallet")}
                            </span>
                          )}
                        </span>
                        <code className="mt-1 block break-all text-xs text-gray-500">
                          {wallet.public_key}
                        </code>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
      {historyDeletePrompt && (
        <div className="fixed inset-0 z-[200] flex items-end bg-black/60 sm:items-center sm:justify-center">
          <button
            type="button"
            aria-label={t("common.cancel")}
            className="absolute inset-0 cursor-default"
            onClick={() => setHistoryDeletePrompt(null)}
          />
          <div className="relative w-full border-t border-white/10 bg-zinc-950 px-4 py-5 shadow-2xl sm:mx-4 sm:max-w-md sm:rounded-2xl sm:border">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold">{t("features.program-projects.removeHistoryRecord")}</h3>
                  <p className="mt-1 text-sm text-gray-400">
                    {historyDeletePrompt.recordId.startsWith("journal-card:")
                      ? t("features.program-projects.historyRemoveJournalConfirm")
                      : t("features.program-projects.historyRemoveConfirm")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setHistoryDeletePrompt(null)}
                  className="rounded-lg bg-white/10 p-2 text-gray-300 hover:bg-white/20"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setHistoryDeletePrompt(null)}
                  className="flex-1 rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold text-gray-200 hover:bg-white/20"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const prompt = historyDeletePrompt;
                    setHistoryDeletePrompt(null);
                    if (prompt) {
                      removeProgramDeploymentHistoryRecord(prompt.projectId, prompt.recordId);
                    }
                  }}
                  className="flex-1 rounded-lg bg-red-500/20 px-4 py-2.5 text-sm font-semibold text-red-100 hover:bg-red-500/30"
                >
                  {t("features.program-projects.removeHistoryRecord")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {dappConnectRequest && (
        <div className="fixed inset-0 z-[200] flex items-end bg-black/60 sm:items-center sm:justify-center">
          <button
            type="button"
            aria-label={t("common.cancel")}
            className="absolute inset-0 cursor-default"
            onClick={() => void rejectDappConnectRequest()}
          />
          <div className="relative w-full border-t border-white/10 bg-zinc-950 px-4 py-5 shadow-2xl sm:mx-4 sm:max-w-xl sm:rounded-2xl sm:border">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold">
                    {tf("features.dapp-store.connectRequestTitle", "DApp 钱包连接确认")}
                  </h3>
                  <p className="mt-1 text-sm text-gray-400">
                    {dappConnectRequest.app_name}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void rejectDappConnectRequest()}
                  disabled={dappSignBusy}
                  className="rounded-lg bg-white/10 p-2 text-gray-300 hover:bg-white/20 disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-2 rounded-lg border border-white/10 bg-black/30 p-3">
                {[
                  [tf("features.dapp-store.requestAppUrl", "DApp 来源"), dappConnectRequest.app_url],
                  [tf("features.dapp-store.requestNetwork", "网络"), dappConnectRequest.network],
                ].map(([label, value]) => (
                  <div key={label} className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)]">
                    <span className="text-xs text-gray-500">{label}</span>
                    <code className="select-text break-all text-xs text-gray-300">{value}</code>
                  </div>
                ))}
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  {tf("features.dapp-store.connectWallet", "连接钱包")}
                </label>
                <select
                  value={dappConnectWalletId || effectiveWalletId}
                  onChange={(event) => setDappConnectWalletId(event.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-white/20"
                  disabled={dappSignBusy || walletsLoading}
                >
                  {wallets.map((wallet) => (
                    <option key={wallet.id} value={wallet.id}>
                      {walletLabel(wallet)}
                    </option>
                  ))}
                </select>
                {wallets.length === 0 && (
                  <p className="mt-2 text-xs text-amber-100">
                    {tf("features.dapp-store.noWallet", "Select a wallet first.")}
                  </p>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => void rejectDappConnectRequest()}
                  disabled={dappSignBusy}
                  className="rounded-lg bg-white/10 px-4 py-3 font-semibold text-gray-200 hover:bg-white/20 disabled:opacity-50"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void approveDappConnectRequest()}
                  disabled={dappSignBusy || walletsLoading || wallets.length === 0}
                  className="rounded-lg bg-gradient-to-r from-blue-500 to-cyan-400 px-4 py-3 font-semibold text-white hover:from-blue-600 hover:to-cyan-500 disabled:opacity-50"
                >
                  {dappSignBusy ? t("common.processing") : tf("features.dapp-store.connectApprove", "连接钱包")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {dappSignRequest && (
        <div className="fixed inset-0 z-[200] flex items-end bg-black/60 sm:items-center sm:justify-center">
          <button
            type="button"
            aria-label={t("common.cancel")}
            className="absolute inset-0 cursor-default"
            onClick={() => void rejectDappSignRequest()}
          />
          <div className="relative w-full border-t border-white/10 bg-zinc-950 px-4 py-5 shadow-2xl sm:mx-4 sm:max-w-xl sm:rounded-2xl sm:border">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold">
                    {dappSignRequest.method === "signMessage"
                      ? tf("features.dapp-store.messageSignRequestTitle", "DApp 消息签名确认")
                      : tf("features.dapp-store.signRequestTitle", "DApp 交易确认")}
                  </h3>
                  <p className="mt-1 text-sm text-gray-400">
                    {dappSignRequest.app_name} · {dappSignRequest.method}
                  </p>
                  <p className="mt-1 break-all text-xs text-gray-500">{dappSignRequest.app_url}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void rejectDappSignRequest()}
                  disabled={dappSignBusy}
                  className="rounded-lg bg-white/10 p-2 text-gray-300 hover:bg-white/20 disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
	              <div className="space-y-2 rounded-lg border border-white/10 bg-black/30 p-3">
	                {[
                  [tf("features.dapp-store.requestApp", "请求网站"), dappSignRequest.app_name],
                  [tf("features.dapp-store.requestOrigin", "来源"), dappSignRequest.app_url],
                  ...(dappSignRequest.request_purpose
                    ? [[tf("features.dapp-store.requestPurpose", "用途"), dappSignRequest.request_purpose]]
                    : []),
                  [tf("features.dapp-store.requestWallet", "签名钱包"), dappSignRequest.wallet_public_key],
                  [tf("features.dapp-store.requestNetwork", "网络"), dappSignRequest.network],
                  [
                    dappSignRequest.method === "signMessage"
                      ? tf("features.dapp-store.requestMessageBytes", "消息长度")
                      : tf("features.dapp-store.requestFormat", "交易格式"),
                    dappSignRequest.method === "signMessage"
                      ? `${dappMessagePreview(dappSignRequest.message_base64)?.byteLength ?? 0} bytes`
                      : dappSignRequest.transaction_format,
                  ],
                ].map(([label, value]) => (
                  <div key={label} className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)]">
                    <span className="text-xs text-gray-500">{label}</span>
                    <code className="select-text break-all text-xs text-gray-300">{value}</code>
                  </div>
	                ))}
	              </div>
	              {dappSignRequest.method !== "signMessage" && (
	                <div className="rounded-lg border border-sky-300/20 bg-sky-400/10 p-3">
	                  <div className="flex items-center justify-between gap-3">
	                    <span className="text-xs font-medium text-sky-100">
	                      {tf("features.dapp-store.transactionPreview", "交易预览")}
	                    </span>
	                    {dappTransactionPreview && (
	                      <span className="text-[11px] uppercase text-sky-100/70">
	                        {dappTransactionPreview.transaction_format}
	                      </span>
	                    )}
	                  </div>
	                  {dappTransactionPreviewLoading && (
	                    <p className="mt-2 text-xs text-sky-100/80">{t("common.loading")}</p>
	                  )}
	                  {dappTransactionPreviewError && (
	                    <p className="mt-2 break-words text-xs text-red-200">{dappTransactionPreviewError}</p>
	                  )}
	                  {dappTransactionPreview && (
	                    <div className="mt-3 space-y-3">
	                      <div className="grid gap-2 text-xs sm:grid-cols-2">
	                        <div>
	                          <span className="text-sky-100/60">{tf("features.dapp-store.requiredSignatures", "所需签名")}</span>
	                          <p className="mt-1 text-sky-50">{dappTransactionPreview.required_signatures}</p>
	                        </div>
	                        <div>
	                          <span className="text-sky-100/60">{tf("features.dapp-store.instructionCount", "指令数量")}</span>
	                          <p className="mt-1 text-sky-50">{dappTransactionPreview.instructions.length}</p>
	                        </div>
	                        <div className="sm:col-span-2">
	                          <span className="text-sky-100/60">Blockhash</span>
	                          <code className="mt-1 block break-all text-[11px] text-sky-50/90">
	                            {dappTransactionPreview.recent_blockhash}
	                          </code>
	                        </div>
	                      </div>
	                      {dappTransactionPreview.warnings.length > 0 && (
	                        <div className="space-y-1 rounded border border-amber-300/20 bg-amber-300/10 p-2">
	                          {dappTransactionPreview.warnings.map((warning) => (
	                            <p key={warning} className="text-xs text-amber-100">{warning}</p>
	                          ))}
	                        </div>
	                      )}
		                      <button
		                        type="button"
		                        onClick={() => setDappPreviewDetailsOpen((open) => !open)}
		                        className="flex w-full items-center justify-between gap-3 rounded border border-sky-300/15 bg-black/20 px-3 py-2 text-left text-xs text-sky-50/90 hover:bg-black/30"
		                        aria-expanded={dappPreviewDetailsOpen}
		                      >
		                        <span className="min-w-0 truncate">
		                          {dappPreviewDetailsOpen
		                            ? tf("features.dapp-store.hideInstructionDetails", "收起指令明细")
		                            : tf("features.dapp-store.showInstructionDetails", "展开指令明细")}
		                        </span>
		                        <span className="flex shrink-0 items-center gap-2 text-[11px] text-sky-100/60">
		                          {dappTransactionPreview.instructions.length} ix · {dappTransactionPreview.programs.length} programs
		                          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${dappPreviewDetailsOpen ? "rotate-180" : ""}`} />
		                        </span>
		                      </button>
		                      {dappPreviewDetailsOpen && (
		                        <>
		                          <div className="space-y-1">
		                            <span className="text-xs text-sky-100/60">{tf("features.dapp-store.programs", "Programs")}</span>
		                            <div className="flex flex-wrap gap-1.5">
		                              {dappTransactionPreview.instructions.slice(0, 6).map((instruction) => (
		                                <code
		                                  key={`${instruction.index}-${instruction.program_id}`}
		                                  className="max-w-full rounded bg-black/30 px-2 py-1 text-[11px] text-sky-50/90"
		                                >
		                                  #{instruction.index} {instruction.program_id} · {instruction.account_count} acc · {instruction.data_bytes} bytes
		                                </code>
		                              ))}
		                            </div>
		                          </div>
		                          <div className="grid gap-2 text-xs sm:grid-cols-2">
		                            <div>
		                              <span className="text-sky-100/60">{tf("features.dapp-store.signers", "Signers")}</span>
		                              <code className="mt-1 block max-h-16 overflow-auto break-all text-[11px] text-sky-50/90">
		                                {dappTransactionPreview.signer_accounts.join("\n")}
		                              </code>
		                            </div>
		                            <div>
		                              <span className="text-sky-100/60">{tf("features.dapp-store.writableAccounts", "Writable accounts")}</span>
		                              <code className="mt-1 block max-h-16 overflow-auto whitespace-pre-wrap break-all text-[11px] text-sky-50/90">
		                                {dappTransactionPreview.writable_accounts.slice(0, 8).join("\n")}
		                              </code>
		                            </div>
		                          </div>
		                        </>
		                      )}
		                    </div>
	                  )}
	                </div>
	              )}
	              {dappSignRequest.method === "signMessage" && (
                <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3">
                  <div className="text-xs font-medium text-amber-100">
                    {tf("features.dapp-store.requestMessage", "待签名消息")}
                  </div>
                  <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-amber-50/90">
                    {dappMessagePreview(dappSignRequest.message_base64)?.text ||
                      tf("features.dapp-store.messagePreviewUnavailable", "无法预览消息内容")}
                  </pre>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium mb-2">{t("formUi.walletPassword")}</label>
                <input
                  autoFocus
                  type="password"
                  data-sensitive-field="password"
                  value={dappPassword}
                  onChange={(event) => setDappPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void approveDappSignRequest();
                    }
                  }}
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-white/20"
                  placeholder={t("formUi.placeholderKeystorePassword")}
                />
                {dappBiometricAvailable && (
                  <div className="mt-3 rounded-lg border border-emerald-300/15 bg-emerald-400/10 p-3">
                    {dappBiometricConfigured ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void approveDappSignRequestWithBiometric()}
                          disabled={dappSignBusy || dappBiometricBusy}
                          className="inline-flex items-center gap-2 rounded-lg border border-emerald-200/25 bg-emerald-300/15 px-3.5 py-2.5 text-sm font-semibold text-emerald-50 shadow-sm shadow-emerald-950/20 hover:bg-emerald-300/25 disabled:opacity-50"
                        >
                          <Fingerprint className="h-4 w-4" />
                          {dappBiometricBusy ? t("common.processing") : t("features.biometric.useTouchId")}
                        </button>
                        <p className="mt-2 text-xs leading-relaxed text-emerald-50/70">
                          {t("features.biometric.touchIdHint")}
                        </p>
                      </>
                    ) : (
                      <>
                        <label className="inline-flex items-center gap-2 text-xs font-medium text-emerald-50">
                          <input
                            type="checkbox"
                            checked={dappSaveBiometric}
                            onChange={(event) => setDappSaveBiometric(event.target.checked)}
                            className="h-4 w-4 rounded border-emerald-200/30 bg-black/40"
                          />
                          <span>{t("features.biometric.saveForTouchId")}</span>
                        </label>
                        <p className="mt-2 text-xs leading-relaxed text-emerald-50/65">
                          {t("features.biometric.saveHint")}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void rejectDappSignRequest()}
                  disabled={dappSignBusy}
                  className="rounded-lg bg-white/10 px-4 py-3 text-sm font-semibold hover:bg-white/20 disabled:opacity-50"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void approveDappSignRequest()}
                  disabled={dappSignBusy}
                  className="rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-3 text-sm font-semibold hover:from-purple-600 hover:to-pink-600 disabled:opacity-50"
                >
                  {dappSignBusy ? t("common.processing") : tf("features.dapp-store.approve", "确认签名")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {sensitiveExport && (
        <div className="fixed inset-0 z-[210] flex items-end bg-black/70">
          <button
            type="button"
            aria-label={t("features.settings.exportPrivateKeyCloseAndClear")}
            className="absolute inset-0 cursor-default"
            onClick={closeSensitiveExport}
          />
          <div className="relative w-full border-t border-white/10 bg-zinc-950 px-4 py-5 shadow-2xl">
            <div className="mx-auto max-w-4xl space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold">{sensitiveExport.title}</h3>
                  <p className="mt-1 text-sm text-gray-400">{sensitiveExport.hint}</p>
                </div>
                <button
                  type="button"
                  onClick={closeSensitiveExport}
                  className="rounded-lg bg-white/10 p-2 text-gray-300 hover:bg-white/20"
                  aria-label={t("features.settings.exportPrivateKeyCloseAndClear")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="grid gap-2 text-xs sm:grid-cols-[6rem_minmax(0,1fr)]">
                    <span className="text-gray-500">{t("features.settings.exportPrivateKeyWallet")}</span>
                    <span className="truncate text-gray-200">{sensitiveExport.walletName}</span>
                    <span className="text-gray-500">{t("features.settings.exportPrivateKeyPublicKey")}</span>
                    <code className="break-all text-gray-300">{sensitiveExport.publicKey}</code>
                  </div>
                </div>
                {sensitiveExportPreviews.length > 1 && (
                  <div className="inline-grid grid-cols-2 rounded-lg border border-white/10 bg-black/30 p-1">
                    {sensitiveExportPreviews.map((preview) => (
                      <button
                        key={preview.kind}
                        type="button"
                        onClick={() => {
                          setSensitiveExportTab(preview.kind);
                          setPrivateKeyQrRevealed(false);
                        }}
                        className={`rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                          sensitiveExport.kind === preview.kind
                            ? "bg-white text-zinc-950"
                            : "text-gray-300 hover:bg-white/10 hover:text-white"
                        }`}
                        aria-pressed={sensitiveExport.kind === preview.kind}
                      >
                        {preview.kind === "private-key"
                          ? t("features.settings.exportPrivateKey")
                          : t("features.settings.exportMnemonic")}
                      </button>
                    ))}
                  </div>
                )}
                <div className="inline-grid grid-cols-2 rounded-lg border border-white/10 bg-black/30 p-1">
                  {(["simple", "advanced"] as PrivateKeyExportMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPrivateKeyExportMode(mode)}
                      className={`rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                        privateKeyExportMode === mode
                          ? "bg-white text-zinc-950"
                          : "text-gray-300 hover:bg-white/10 hover:text-white"
                      }`}
                      aria-pressed={privateKeyExportMode === mode}
                    >
                      {mode === "simple"
                        ? t("features.settings.exportPrivateKeySimpleMode")
                        : t("features.settings.exportPrivateKeyAdvancedMode")}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-red-300/20 bg-red-400/10 p-3 text-sm text-red-50">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="leading-relaxed">{sensitiveExport.warning}</p>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold">{t("features.settings.exportPrivateKeyQrLabel")}</span>
                    {privateKeyQrRevealed && (
                      <button
                        type="button"
                        onClick={() => setPrivateKeyQrRevealed(false)}
                        className="text-xs font-medium text-gray-400 hover:text-white"
                      >
                        {t("features.settings.exportPrivateKeyHideQr")}
                      </button>
                    )}
                  </div>
                  <div className="relative flex min-h-[292px] items-center justify-center rounded-lg border border-white/10 bg-white p-3">
                    {privateKeyQrRevealed ? (
                      <canvas
                        ref={privateKeyQrCanvasRef}
                        width={280}
                        height={280}
                        className="h-[280px] w-[280px]"
                        aria-label={sensitiveExport.qrCanvasLabel}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setPrivateKeyQrRevealed(true)}
                        className="flex h-[280px] w-full flex-col items-center justify-center gap-3 rounded-md bg-zinc-950 text-center text-white hover:bg-zinc-900"
                      >
                        <QrCode className="h-10 w-10 text-sky-200" />
                        <span className="text-sm font-semibold">{t("features.settings.exportPrivateKeyRevealQr")}</span>
                        <span className="max-w-52 text-xs leading-relaxed text-gray-400">
                          {t("features.settings.exportPrivateKeyRevealQrHint")}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
                <div className="min-w-0 space-y-3">
                  {privateKeyExportMode === "simple" ? (
                    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <label className="text-sm font-semibold">
                          {sensitiveExport.plaintextLabel}
                        </label>
                        <span className="text-xs text-gray-500">{t("features.settings.exportPrivateKeyHoverReveal")}</span>
                      </div>
                      <div
                        tabIndex={0}
                        className="group relative rounded-lg border border-white/10 bg-black/40 p-3 outline-none focus:ring-2 focus:ring-red-300/20"
                      >
                        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-lg bg-black/45 text-sm font-semibold text-red-50 transition-opacity group-hover:pointer-events-none group-hover:opacity-0 group-focus:pointer-events-none group-focus:opacity-0">
                          <EyeOff className="h-4 w-4" />
                          {sensitiveExport.hiddenLabel}
                        </div>
                        <code
                          className={`block min-h-24 select-text font-mono text-xs leading-relaxed text-red-50 blur-sm transition group-hover:blur-0 group-focus:blur-0 ${
                            sensitiveExport.kind === "mnemonic" ? "whitespace-pre-wrap break-words" : "break-all"
                          }`}
                        >
                          {sensitiveExport.value}
                        </code>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-gray-400">
                        {sensitiveExport.temporaryHint}
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{sensitiveExport.segmentsTitle}</span>
                          <HelpCircle
                            className="h-4 w-4 text-gray-500"
                            aria-label={sensitiveExport.segmentsHelp}
                          />
                        </div>
                        <div className="inline-flex items-center rounded-lg border border-white/10 bg-black/40 p-1">
                          <button
                            type="button"
                            onClick={() => changePrivateKeySegmentCount(-1)}
                            disabled={privateKeySegmentCount <= MIN_PRIVATE_KEY_SEGMENTS}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-200 hover:bg-white/10 disabled:opacity-35"
                            aria-label={t("features.settings.exportPrivateKeyDecreaseSegments")}
                          >
                            <Minus className="h-4 w-4" />
                          </button>
                          <span className="w-10 text-center text-sm font-semibold">{privateKeySegmentCount}</span>
                          <button
                            type="button"
                            onClick={() => changePrivateKeySegmentCount(1)}
                            disabled={privateKeySegmentCount >= MAX_PRIVATE_KEY_SEGMENTS}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-200 hover:bg-white/10 disabled:opacity-35"
                            aria-label={t("features.settings.exportPrivateKeyIncreaseSegments")}
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-gray-400">
                        {sensitiveExport.segmentsHint}
                      </p>
                      <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">
                        {splitSensitiveExportIntoSegments(sensitiveExport.value, privateKeySegmentCount).map((segment, index) => {
                          const segmentCopyId = `${sensitiveExport.segmentCopyPrefix}:${index}`;
                          return (
                            <div
                              key={`${privateKeySegmentCount}:${index}`}
                              tabIndex={0}
                              className="group grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2 outline-none focus:ring-2 focus:ring-red-300/20"
                            >
                              <span className="text-sm font-semibold text-gray-500">{index + 1}</span>
                              <code
                                className={`min-w-0 select-text font-mono text-sm text-red-50 blur-sm transition group-hover:blur-0 group-focus:blur-0 ${
                                  sensitiveExport.kind === "mnemonic" ? "break-words" : "break-all"
                                }`}
                              >
                                {segment}
                              </code>
                              <button
                                type="button"
                                onClick={() => void copyToClipboard(segment, segmentCopyId)}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-300 hover:bg-white/10 hover:text-white"
                                aria-label={t("features.settings.exportPrivateKeyCopySegment", { index: index + 1 })}
                              >
                                {copied === segmentCopyId ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => void copyToClipboard(sensitiveExport.value, sensitiveExport.copyId)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-semibold hover:bg-white/20"
                >
                  {copied === sensitiveExport.copyId ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {sensitiveExport.copyLabel}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const confirmMessage =
                      sensitiveExport.kind === "mnemonic"
                        ? t("features.settings.exportMnemonicDownloadConfirm")
                        : t("features.settings.exportPrivateKeyDownloadConfirm");
                    if (!window.confirm(confirmMessage)) return;
                    void downloadFile(
                      sensitiveExportContent(sensitiveExport),
                      `${safeFilename(sensitiveExport.walletName)}-${sensitiveExport.publicKey.slice(0, 8)}-${sensitiveExport.downloadSuffix}.txt`,
                      "text/plain",
                    );
                  }}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-semibold hover:bg-white/20"
                >
                  <Download className="h-4 w-4" />
                  {sensitiveExport.downloadLabel}
                </button>
                <button
                  type="button"
                  onClick={closeSensitiveExport}
                  className="rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-3 text-sm font-semibold hover:from-purple-600 hover:to-pink-600"
                >
                  {t("features.settings.exportPrivateKeyCloseAndClear")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {passwordPrompt && (
        <div className="fixed inset-0 z-[200] flex items-end bg-black/60">
          <button
            type="button"
            aria-label={t("common.cancel")}
            className="absolute inset-0 cursor-default"
            onClick={closePasswordPrompt}
          />
          <div className="relative w-full border-t border-white/10 bg-zinc-950 px-4 py-5 shadow-2xl">
            <div className="mx-auto max-w-xl space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold">{passwordPromptTitle}</h3>
                  <p className="mt-1 text-sm text-gray-400">{passwordPromptHint}</p>
                </div>
                <button
                  type="button"
                  onClick={closePasswordPrompt}
                  disabled={loading}
                  className="rounded-lg bg-white/10 p-2 text-gray-300 hover:bg-white/20 disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3">
                {showWalletPasswordPrompt && (
                  <div>
                    <div className="mb-2 flex items-center gap-1.5">
                      <label htmlFor="wallet-password-prompt" className="text-sm font-medium">
                        {showMigrationPasswords
                          ? t("features.settings.migrateCurrentPassword")
                          : t("formUi.walletPassword")}
                      </label>
                      {isLongRunningProgramPasswordPrompt && (
                        <FieldHelp
                          description={
                            isProgramUpgradePasswordPrompt
                              ? t("features.program-upgrade.walletPasswordTooltip")
                              : t("features.program-deploy.walletPasswordTooltip")
                          }
                          label={t("features.program-deploy.helpAriaLabel", {
                            field: t("formUi.walletPassword"),
                          })}
                        />
                      )}
                    </div>
                    <input
                      id="wallet-password-prompt"
                      autoFocus
                      type="password"
                      data-sensitive-field="current_password"
                      value={passwordPromptValue}
                      onChange={(e) => setPasswordPromptValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void confirmPasswordPrompt();
                        }
                      }}
                      className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-white/20"
                      placeholder={t("formUi.placeholderKeystorePassword")}
                    />
                    {showPasswordPromptBiometric && (
                      <div className="mt-3 rounded-lg border border-emerald-300/15 bg-emerald-400/10 p-3">
                        {passwordPromptBiometricConfigured ? (
                          <>
                            <button
                              type="button"
                              onClick={async () => {
                                const wallet = passwordPromptWallet;
                                if (!wallet) return;
                                const password = await getBiometricWalletPassword(wallet);
                                if (password) {
                                  await confirmPasswordPrompt(password);
                                }
                              }}
                              disabled={passwordPromptIsBusy || passwordPromptBiometricBusy}
                              className="inline-flex items-center gap-2 rounded-lg border border-emerald-200/25 bg-emerald-300/15 px-3.5 py-2.5 text-sm font-semibold text-emerald-50 shadow-sm shadow-emerald-950/20 hover:bg-emerald-300/25 disabled:opacity-50"
                            >
                              <Fingerprint className="h-4 w-4" />
                              {passwordPromptBiometricBusy
                                ? t("common.processing")
                                : t("features.biometric.useTouchId")}
                            </button>
                            <p className="mt-2 text-xs leading-relaxed text-emerald-50/70">
                              {t("features.biometric.touchIdHint")}
                            </p>
                          </>
                        ) : (
                          <>
                            <label className="inline-flex items-center gap-2 text-xs font-medium text-emerald-50">
                              <input
                                type="checkbox"
                                checked={savePasswordToBiometric}
                                onChange={(event) => setSavePasswordToBiometric(event.target.checked)}
                                className="h-4 w-4 rounded border-emerald-200/30 bg-black/40"
                              />
                              <span>{t("features.biometric.saveForTouchId")}</span>
                            </label>
                            <p className="mt-2 text-xs leading-relaxed text-emerald-50/65">
                              {t("features.biometric.saveHint")}
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {showMigrationPasswords && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        {t("features.settings.migrateNewPassword")}
                      </label>
                      <input
                        type="password"
                        data-sensitive-field="new_password"
                        autoComplete="new-password"
                        value={migrationNewPassword}
                        onChange={(event) => setMigrationNewPassword(event.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-white/20"
                        placeholder={t("features.settings.migrateNewPasswordPlaceholder")}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        {t("features.settings.migrateConfirmPassword")}
                      </label>
                      <input
                        type="password"
                        data-sensitive-field="new_password"
                        autoComplete="new-password"
                        value={migrationConfirmPassword}
                        onChange={(event) => setMigrationConfirmPassword(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void confirmPasswordPrompt();
                          }
                        }}
                        className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-white/20"
                        placeholder={t("features.settings.migrateConfirmPasswordPlaceholder")}
                      />
                    </div>
                  </>
                )}
                {showExportBundlePrompt && (
                  <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                    <p className="text-sm font-semibold">{t("features.settings.exportBundleOptionsTitle")}</p>
                    <p className="mt-1 text-xs leading-relaxed text-gray-400">
                      {t("features.settings.exportBundleOptionsHint")}
                    </p>
                    <div className="mt-3 space-y-2">
                      {([
                        {
                          id: "keystore",
                          icon: <Download className="h-4 w-4" />,
                          label: t("features.settings.exportKeystore"),
                          hint: t("features.settings.exportBundleKeystoreHint"),
                          tone: "text-sky-100",
                        },
                        {
                          id: "private-key",
                          icon: <Key className="h-4 w-4" />,
                          label: t("features.settings.exportPrivateKey"),
                          hint: t("features.settings.exportBundlePrivateKeyHint"),
                          tone: "text-amber-100",
                        },
                        {
                          id: "mnemonic",
                          icon: <Hash className="h-4 w-4" />,
                          label: t("features.settings.exportMnemonic"),
                          hint: t("features.settings.exportBundleMnemonicHint"),
                          tone: "text-amber-100",
                        },
                      ] as Array<{
                        id: ExportBundleItem;
                        icon: ReactNode;
                        label: string;
                        hint: string;
                        tone: string;
                      }>).map((option) => (
                        <label
                          key={option.id}
                          className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3 hover:bg-white/[0.06]"
                        >
                          <input
                            type="checkbox"
                            checked={exportBundleSelection[option.id]}
                            onChange={(event) =>
                              setExportBundleSelection((current) => ({
                                ...current,
                                [option.id]: event.target.checked,
                              }))
                            }
                            className="mt-1 h-4 w-4 rounded border-white/20 bg-black/40"
                          />
                          <span className={`mt-0.5 shrink-0 ${option.tone}`}>{option.icon}</span>
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold text-gray-100">{option.label}</span>
                            <span className="mt-1 block text-xs leading-relaxed text-gray-400">{option.hint}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {showMasterPasswordPrompt && (
                  <div>
                    <label className="block text-sm font-medium mb-2">{t("formUi.masterPassword")}</label>
                    <input
                      autoFocus={!showWalletPasswordPrompt}
                      type="password"
                      value={masterPasswordPromptValue}
                      onChange={(e) => setMasterPasswordPromptValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void confirmPasswordPrompt();
                        }
                      }}
                      className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-white/20"
                      placeholder={t("formUi.masterPasswordPlaceholder")}
                    />
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={closePasswordPrompt}
                  disabled={passwordPromptIsBusy}
                  className="rounded-lg bg-white/10 px-4 py-3 text-sm font-semibold hover:bg-white/20 disabled:opacity-50"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void confirmPasswordPrompt()}
                  disabled={passwordPromptIsBusy}
                  className="rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 px-4 py-3 text-sm font-semibold hover:from-purple-600 hover:to-pink-600 disabled:opacity-50"
                >
                  {passwordPromptIsBusy ? t("common.processing") : passwordPromptButton}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
