import { apiFetch } from "@/lib/apiFetch";

const ALLOW_DIRECT_SECRET_INPUT =
  process.env.NEXT_PUBLIC_ALLOW_DIRECT_SECRET_INPUT === "true";

export interface FormState {
  [key: string]: string | number | undefined;
  sell_percent?: number;
}

export interface ApiRequestBody {
  [key: string]: string | number | undefined;
  sell_percent?: number;
}

export interface SavedWallet {
  id: string;
  name: string;
  public_key: string;
  evm_address?: string | null;
  evm_wallet_id?: string | null;
  evm_derivation_path?: string | null;
  created_at: number;
  updated_at: number;
  keystore_version: "v2" | "legacy_v1" | "unknown";
}

export type WalletAuthTab = "keystore" | "encrypted" | "private";

export function normalizeWalletAuth(method: WalletAuthTab): WalletAuthTab {
  if (ALLOW_DIRECT_SECRET_INPUT) return method;
  return "keystore";
}

export const authFormsWithWallets = new Set([
  "decrypt", "unlock", "get-pubkey", "transfer-sol", "transfer-token",
  "create-wsol-ata", "wrap-sol", "unwrap-sol", "close-wsol-ata",
  "create-nonce", "pumpfun-sell", "pumpswap-sell", "create-tfa",
  "pumpfun-cashback", "pumpswap-cashback", "program-deploy", "program-upgrade",
  "program-invoke", "program-invoke-standalone", "external-sign",
  "squads-create", "squads-sol-transfer", "squads-token-transfer",
  "squads-prepare-upgrade-buffer", "squads-program-upgrade",
  "squads-approve", "squads-reject", "squads-execute", "squads-set-authority",
]);

export function walletLabel(wallet: SavedWallet): string {
  return `${wallet.name} - ${wallet.public_key.slice(0, 4)}...${wallet.public_key.slice(-4)}`;
}

export function encryptedKeyFromForm(formData: FormState): string {
  return String(
    (formData as Record<string, unknown>).encrypted_key ??
      (formData as Record<string, unknown>).encryptedKey ??
      "",
  ).trim();
}

export function validateWalletAuth(
  method: WalletAuthTab,
  formData: FormState,
  privateField: "private_key" | "secret_key",
): boolean {
  method = normalizeWalletAuth(method);
  if (method === "keystore") {
    return !!((String(formData.wallet_id ?? "").trim() || String(formData.keystoreJson ?? "").trim()) && formData.password);
  }
  if (method === "encrypted") {
    return !!(encryptedKeyFromForm(formData) && formData.password);
  }
  const raw =
    privateField === "secret_key" ? formData.secretKey : formData.private_key;
  return !!String(raw ?? "").trim();
}

export function applyWalletAuth(
  body: ApiRequestBody,
  method: WalletAuthTab,
  formData: FormState,
  privateField: "private_key" | "secret_key",
) {
  method = normalizeWalletAuth(method);
  if (method === "keystore") {
    const walletId = String(formData.wallet_id ?? "").trim();
    const keystoreJson = String(formData.keystoreJson ?? "").trim();
    if (walletId) body.wallet_id = walletId;
    else body.keystore_json = keystoreJson;
    body.password = formData.password;
  } else if (method === "encrypted") {
    body.encrypted_key = encryptedKeyFromForm(formData);
    body.password = formData.password;
  } else {
    const raw =
      privateField === "secret_key" ? formData.secretKey : formData.private_key;
    const v = String(raw ?? "").trim();
    if (privateField === "secret_key") body.secret_key = v;
    else body.private_key = v;
  }
}

export async function fetchWallets(): Promise<SavedWallet[]> {
  const response = await apiFetch("wallets", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "加载钱包列表失败");
  }
  return Array.isArray(data.wallets) ? data.wallets : [];
}
