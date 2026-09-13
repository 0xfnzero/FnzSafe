export const WALLET_EXPORT_PROTOCOL_VERSION = 1;

export type WalletExportFamily = "solana" | "evm" | "bitcoin" | "tron";

export interface WalletExportContext {
  family: WalletExportFamily;
  chainId?: string;
  expectedAddress: string;
  derivationPath?: string;
}

export type WalletExportValidationError =
  | "incompatible-backend"
  | "account-mismatch"
  | "invalid-private-key";

export interface ValidatedPrivateKeyExport {
  privateKey: string;
  family: WalletExportFamily;
  address: string;
  encoding: string;
  derivationPath?: string;
}

export interface ValidatedMnemonicExport {
  mnemonic: string;
  family: WalletExportFamily;
  address: string;
  derivationPath: string;
}

export function renderableSensitiveExportValue(value: string, revealed: boolean): string | null {
  return revealed ? value : null;
}

const BITCOIN_MAINNET_ID = "bip122:000000000019d6689c085ae165831e93";
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addressesMatch(family: WalletExportFamily, left: string, right: string): boolean {
  return family === "evm" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validPrivateKeyFormat(
  privateKey: string,
  context: WalletExportContext,
  encoding: string,
): boolean {
  switch (context.family) {
    case "solana":
      return encoding === "base58-keypair"
        && privateKey.length >= 87
        && privateKey.length <= 88
        && BASE58_PATTERN.test(privateKey);
    case "evm":
      return encoding === "hex-32-byte-0x" && /^0x[0-9a-fA-F]{64}$/.test(privateKey);
    case "bitcoin": {
      if (encoding !== "wif-compressed" || privateKey.length !== 52 || !BASE58_PATTERN.test(privateKey)) {
        return false;
      }
      const mainnet = !context.chainId || context.chainId === BITCOIN_MAINNET_ID;
      return mainnet ? /^[KL]/.test(privateKey) : privateKey.startsWith("c");
    }
    case "tron":
      return encoding === "hex-32-byte" && /^[0-9a-fA-F]{64}$/.test(privateKey);
  }
}

export function validatePrivateKeyExport(
  value: unknown,
  context: WalletExportContext,
): { ok: true; value: ValidatedPrivateKeyExport } | { ok: false; error: WalletExportValidationError } {
  if (!isRecord(value)
    || value.export_protocol_version !== WALLET_EXPORT_PROTOCOL_VERSION
    || value.family !== context.family
    || typeof value.address !== "string"
    || typeof value.encoding !== "string"
    || typeof value.private_key !== "string") {
    return { ok: false, error: "incompatible-backend" };
  }

  const address = value.address.trim();
  if (!address || !addressesMatch(context.family, address, context.expectedAddress.trim())) {
    return { ok: false, error: "account-mismatch" };
  }

  const derivationPath = typeof value.derivation_path === "string"
    ? value.derivation_path.trim() || undefined
    : undefined;
  if (context.derivationPath && derivationPath !== context.derivationPath) {
    return { ok: false, error: "account-mismatch" };
  }
  const privateKey = value.private_key.trim();
  if (!validPrivateKeyFormat(privateKey, context, value.encoding)) {
    return { ok: false, error: "invalid-private-key" };
  }
  return {
    ok: true,
    value: {
      privateKey,
      family: context.family,
      address,
      encoding: value.encoding,
      derivationPath,
    },
  };
}

export function validateMnemonicExport(
  value: unknown,
  context: WalletExportContext,
): { ok: true; value: ValidatedMnemonicExport } | { ok: false; error: WalletExportValidationError } {
  if (!isRecord(value)
    || value.export_protocol_version !== WALLET_EXPORT_PROTOCOL_VERSION
    || value.family !== context.family
    || typeof value.address !== "string"
    || typeof value.derivation_path !== "string"
    || typeof value.mnemonic !== "string") {
    return { ok: false, error: "incompatible-backend" };
  }

  const address = value.address.trim();
  if (!address || !addressesMatch(context.family, address, context.expectedAddress.trim())) {
    return { ok: false, error: "account-mismatch" };
  }

  const mnemonic = value.mnemonic.trim().replace(/\s+/g, " ");
  const wordCount = mnemonic ? mnemonic.split(" ").length : 0;
  if (![12, 15, 18, 21, 24].includes(wordCount)) {
    return { ok: false, error: "invalid-private-key" };
  }

  const derivationPath = value.derivation_path.trim();
  if (!derivationPath) {
    return { ok: false, error: "incompatible-backend" };
  }
  if (context.derivationPath && derivationPath !== context.derivationPath) {
    return { ok: false, error: "account-mismatch" };
  }
  return {
    ok: true,
    value: { mnemonic, family: context.family, address, derivationPath },
  };
}
