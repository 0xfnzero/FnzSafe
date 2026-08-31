const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SOLANA_MAX_ACCOUNT_DATA_BYTES = 10 * 1024 * 1024;
const UPGRADEABLE_LOADER_PROGRAMDATA_METADATA_BYTES = 45;
export const MAX_PROGRAM_SO_FILE_BYTES =
  SOLANA_MAX_ACCOUNT_DATA_BYTES - UPGRADEABLE_LOADER_PROGRAMDATA_METADATA_BYTES;
const DEPLOYMENT_STAGES = new Set(["create_buffer", "write", "deploy"]);
const DEPLOYMENT_ATTEMPT_STATUSES = new Set([
  "signed",
  "confirmed",
  "requires_reconciliation",
  "finalized",
  "finalized_failed",
  "expired_absent",
]);
const DEPLOYMENT_RESPONSE_KEYS = new Set([
  "program_id",
  "programdata_address",
  "buffer_address",
  "authority",
  "network",
  "genesis_hash",
  "program_bytes",
  "max_data_len",
  "program_sha256",
  "temporary_buffer_rent_lamports",
  "program_rent_lamports",
  "programdata_rent_lamports",
  "rent_lamports",
  "estimated_transaction_fees_lamports",
  "fee_rate_reserve_lamports",
  "recovery_write_reserve_lamports",
  "total_fee_budget_lamports",
  "estimated_required_balance_lamports",
  "create_buffer_signature",
  "skipped_write_chunks",
  "write_signatures",
  "deploy_signature",
  "finalized_slot",
  "deployed_slot",
  "readback_verified",
  "journal_revision",
  "attempt_evidence_version",
  "deployment_attempts",
  "status",
]);
const DEPLOYMENT_ATTEMPT_KEYS = new Set([
  "genesis_hash",
  "program_id",
  "stage",
  "buffer_address",
  "chunk_index",
  "signature",
  "last_valid_block_height",
  "status",
  "created_at",
  "updated_at",
]);

export const MAX_PROGRAM_KEYPAIR_FILE_BYTES = 4 * 1024;

export interface ProgramDeploymentReceiptExpectations {
  network: string;
  genesisHash: string;
  programId: string;
  upgradeAuthority: string;
  programSha256: string;
  programBytes: number;
}

export function parseProgramKeypairJson(contents: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("invalid-json");
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    throw new Error("invalid-keypair");
  }

  return Uint8Array.from(parsed as number[]);
}

export function serializeProgramKeypairJson(bytes: Uint8Array): string {
  if (bytes.length !== 64) {
    throw new Error("invalid-keypair");
  }
  return JSON.stringify(Array.from(bytes));
}

export function programIdFromKeypairBytes(bytes: Uint8Array): string {
  if (bytes.length !== 64) {
    throw new Error("invalid-keypair");
  }
  return encodeBase58(bytes.subarray(32));
}

export function isLikelySolanaPublicKey(value: string): boolean {
  const decoded = decodeBase58(value.trim());
  return Boolean(
    decoded &&
      decoded.length === 32 &&
      decoded.some((byte) => byte !== 0) &&
      encodeBase58(decoded) === value.trim(),
  );
}

export function isLikelySolanaGenesisHash(value: string): boolean {
  const normalized = value.trim();
  const decoded = decodeBase58(normalized);
  return Boolean(
    decoded &&
      normalized.length >= 32 &&
      normalized.length <= 44 &&
      decoded.length > 0 &&
      decoded.length <= 32 &&
      decoded.some((byte) => byte !== 0) &&
      encodeBase58(decoded) === normalized,
  );
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("sha256-unavailable");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function receiptRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid-${label}`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error(`unexpected-${label}-field`);
  }
}

function receiptString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`invalid-${key}`);
  return value;
}

function receiptInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`invalid-${key}`);
  return Number(value);
}

function optionalReceiptInteger(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  return receiptInteger(record, key);
}

function optionalCompactString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function optionalCompactInteger(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function optionalCompactBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalCompactIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function optionalCompactRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseOptionalReceiptJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return optionalCompactRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function compactReceiptObject(fields: {
  network?: unknown;
  genesisHash?: unknown;
  programId?: unknown;
  programdataAddress?: unknown;
  upgradeAuthority?: unknown;
  bufferAddress?: unknown;
  programSha256?: unknown;
  programBytes?: unknown;
  maxDataLen?: unknown;
  deploySignature?: unknown;
  status?: unknown;
  readbackVerified?: unknown;
  deployedSlot?: unknown;
  finalizedSlot?: unknown;
  exportedAt?: unknown;
  completedAt?: unknown;
}): Record<string, unknown> {
  const completedAt = optionalCompactInteger(fields.completedAt);
  const result: Record<string, unknown> = {
    receipt_type: "solana_program_deployment",
    schema_version: 3,
    exported_at: optionalCompactIsoDate(fields.exportedAt) ?? new Date().toISOString(),
  };
  const stringFields: Array<[string, unknown]> = [
    ["network", fields.network],
    ["genesis_hash", fields.genesisHash],
    ["program_id", fields.programId],
    ["programdata_address", fields.programdataAddress],
    ["upgrade_authority", fields.upgradeAuthority],
    ["buffer_address", fields.bufferAddress],
    ["program_sha256", fields.programSha256],
    ["deploy_signature", fields.deploySignature],
    ["status", fields.status],
  ];
  for (const [key, value] of stringFields) {
    const normalized = optionalCompactString(value);
    if (normalized) result[key] = normalized;
  }
  const integerFields: Array<[string, unknown]> = [
    ["program_bytes", fields.programBytes],
    ["max_data_len", fields.maxDataLen],
    ["deployed_slot", fields.deployedSlot],
    ["finalized_slot", fields.finalizedSlot],
  ];
  for (const [key, value] of integerFields) {
    const normalized = optionalCompactInteger(value);
    if (normalized !== undefined) result[key] = normalized;
  }
  const readbackVerified = optionalCompactBoolean(fields.readbackVerified);
  if (readbackVerified !== undefined) result.readback_verified = readbackVerified;
  if (completedAt !== undefined) result.completed_at = new Date(completedAt).toISOString();
  return result;
}

function receiptSignature(value: unknown, label: string, optional = false): string | null {
  if ((value === null || value === undefined || value === "") && optional) return null;
  const decoded = typeof value === "string" ? decodeBase58(value) : null;
  if (!decoded || decoded.length !== 64 || encodeBase58(decoded) !== value) {
    throw new Error(`invalid-${label}`);
  }
  return value as string;
}

export function buildProgramDeploymentReceiptJson(
  value: unknown,
  expected: ProgramDeploymentReceiptExpectations,
): string {
  const expectedNetwork = expected.network.trim();
  const expectedGenesisHash = expected.genesisHash.trim();
  const expectedProgramId = expected.programId.trim();
  const expectedUpgradeAuthority = expected.upgradeAuthority.trim();
  const expectedProgramSha256 = expected.programSha256.trim().toLowerCase();
  if (
    !expectedNetwork ||
    !isLikelySolanaGenesisHash(expectedGenesisHash) ||
    !isLikelySolanaPublicKey(expectedProgramId) ||
    !isLikelySolanaPublicKey(expectedUpgradeAuthority) ||
    !/^[a-f0-9]{64}$/.test(expectedProgramSha256) ||
    !Number.isSafeInteger(expected.programBytes) ||
    expected.programBytes <= 0 ||
    expected.programBytes > MAX_PROGRAM_SO_FILE_BYTES
  ) {
    throw new Error("invalid-deployment-expectations");
  }

  const data = receiptRecord(value, "deployment-response");
  rejectUnknownKeys(data, DEPLOYMENT_RESPONSE_KEYS, "deployment-response");
  const status = receiptString(data, "status");
  if (status !== "finalized" && status !== "already_deployed_verified") {
    throw new Error("invalid-deployment-status");
  }
  const programdataAddress = receiptString(data, "programdata_address");
  if (
    receiptString(data, "network") !== expectedNetwork ||
    receiptString(data, "genesis_hash") !== expectedGenesisHash ||
    receiptString(data, "program_id") !== expectedProgramId ||
    receiptString(data, "authority") !== expectedUpgradeAuthority ||
    receiptString(data, "program_sha256") !== expectedProgramSha256 ||
    !isLikelySolanaPublicKey(programdataAddress)
  ) {
    throw new Error("invalid-deployment-target");
  }
  const programBytes = receiptInteger(data, "program_bytes");
  const maxDataLen = receiptInteger(data, "max_data_len");
  if (
    programBytes !== expected.programBytes ||
    maxDataLen < programBytes ||
    maxDataLen > MAX_PROGRAM_SO_FILE_BYTES
  ) {
    throw new Error("invalid-program-length");
  }
  const finalizedSlot = receiptInteger(data, "finalized_slot");
  const deployedSlot = receiptInteger(data, "deployed_slot");
  if (deployedSlot > finalizedSlot || data.readback_verified !== true) {
    throw new Error("invalid-finalized-readback");
  }

  const bufferAddress = receiptString(data, "buffer_address");
  if (bufferAddress && !isLikelySolanaPublicKey(bufferAddress)) {
    throw new Error("invalid-buffer-address");
  }
  if (status === "finalized" && !bufferAddress) throw new Error("missing-buffer-address");
  receiptSignature(
    data.create_buffer_signature,
    "create-buffer-signature",
    true,
  );
  const deploySignature = receiptSignature(
    data.deploy_signature,
    "deploy-signature",
    status !== "finalized",
  );
  if (!Array.isArray(data.write_signatures)) throw new Error("invalid-write-signatures");
  data.write_signatures.forEach((signature, index) => {
    receiptSignature(signature, `write-signature-${index}`);
  });
  const journalRevision = optionalReceiptInteger(data, "journal_revision");
  const attemptEvidenceVersion = optionalReceiptInteger(data, "attempt_evidence_version");

  if (!Array.isArray(data.deployment_attempts)) throw new Error("invalid-deployment-attempts");
  const attempts = data.deployment_attempts.map((rawAttempt, index) => {
    const attempt = receiptRecord(rawAttempt, `deployment-attempt-${index}`);
    rejectUnknownKeys(attempt, DEPLOYMENT_ATTEMPT_KEYS, `deployment-attempt-${index}`);
    const stage = receiptString(attempt, "stage");
    const attemptStatus = receiptString(attempt, "status");
    const attemptBuffer = receiptString(attempt, "buffer_address");
    const chunkIndex = optionalReceiptInteger(attempt, "chunk_index");
    if (
      receiptString(attempt, "genesis_hash") !== expectedGenesisHash ||
      receiptString(attempt, "program_id") !== expectedProgramId ||
      !DEPLOYMENT_STAGES.has(stage) ||
      !DEPLOYMENT_ATTEMPT_STATUSES.has(attemptStatus) ||
      !isLikelySolanaPublicKey(attemptBuffer) ||
      (stage === "write") !== (chunkIndex !== null)
    ) {
      throw new Error(`invalid-deployment-attempt-${index}`);
    }
    return {
      stage,
      buffer_address: attemptBuffer,
      chunk_index: chunkIndex,
      signature: receiptSignature(attempt.signature, `attempt-signature-${index}`),
      last_valid_block_height: receiptInteger(attempt, "last_valid_block_height"),
      status: attemptStatus,
      created_at: receiptInteger(attempt, "created_at"),
      updated_at: receiptInteger(attempt, "updated_at"),
    };
  });
  if (
    status === "finalized" &&
    (journalRevision === null ||
      attemptEvidenceVersion === null ||
      !attempts.some(
        (attempt) =>
          attempt.stage === "deploy" &&
          attempt.status === "finalized" &&
          attempt.signature === deploySignature,
      ))
  ) {
    throw new Error("incomplete-finalized-evidence");
  }

  return `${JSON.stringify(
    compactReceiptObject({
      network: expectedNetwork,
      genesisHash: expectedGenesisHash,
      programId: expectedProgramId,
      programdataAddress,
      upgradeAuthority: expectedUpgradeAuthority,
      bufferAddress,
      programSha256: expectedProgramSha256,
      programBytes,
      maxDataLen,
      deploySignature,
      status,
      readbackVerified: true,
      deployedSlot,
      finalizedSlot,
    }),
    null,
    2,
  )}\n`;
}

export function compactProgramDeploymentReceiptJson(value: unknown): string {
  const direct = optionalCompactRecord(value);
  const nestedReceipt = parseOptionalReceiptJson(direct?.receiptJson ?? direct?.receipt_json)
    ?? parseOptionalReceiptJson(value);
  const cluster = optionalCompactRecord(nestedReceipt?.cluster);
  const program = optionalCompactRecord(nestedReceipt?.program);
  const artifact = optionalCompactRecord(nestedReceipt?.artifact);
  const transactions = optionalCompactRecord(nestedReceipt?.transactions);
  const finalizedReadback = optionalCompactRecord(nestedReceipt?.finalized_readback);
  const source = direct ?? nestedReceipt ?? {};

  return `${JSON.stringify(
    compactReceiptObject({
      network: source.network ?? cluster?.network,
      genesisHash: source.genesisHash ?? source.genesis_hash ?? cluster?.genesis_hash,
      programId: source.programId ?? source.program_id ?? program?.program_id,
      programdataAddress:
        source.programdataAddress ?? source.programdata_address ?? program?.programdata_address,
      upgradeAuthority:
        source.authority ?? source.upgradeAuthority ?? source.upgrade_authority ?? program?.upgrade_authority,
      bufferAddress: source.bufferAddress ?? source.buffer_address ?? program?.buffer_address,
      programSha256:
        source.programSha256 ?? source.program_sha256 ?? artifact?.program_sha256,
      programBytes:
        source.programBytes ?? source.program_bytes ?? artifact?.program_len ?? artifact?.program_bytes,
      maxDataLen: source.maxDataLen ?? source.max_data_len ?? artifact?.max_data_len,
      deploySignature:
        source.deploySignature ?? source.deploy_signature ?? transactions?.deploy,
      status: source.status ?? finalizedReadback?.status,
      readbackVerified:
        source.readbackVerified ?? source.readback_verified ?? finalizedReadback?.verified,
      deployedSlot: source.deployedSlot ?? source.deployed_slot ?? finalizedReadback?.deployed_slot,
      finalizedSlot: source.finalizedSlot ?? source.finalized_slot ?? finalizedReadback?.finalized_slot,
      exportedAt: nestedReceipt?.exported_at ?? source.exported_at,
      completedAt: source.completedAt ?? source.completed_at,
    }),
    null,
    2,
  )}\n`;
}

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }

  const digits: number[] = [];
  for (let i = leadingZeroes; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let encoded = BASE58_ALPHABET[0].repeat(leadingZeroes);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    encoded += BASE58_ALPHABET[digits[i]];
  }
  return encoded;
}

function decodeBase58(value: string): Uint8Array | null {
  if (!value) return null;
  const bytes: number[] = [];
  for (const character of value) {
    let carry = BASE58_ALPHABET.indexOf(character);
    if (carry < 0) return null;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = Math.floor(carry / 256);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === BASE58_ALPHABET[0]) {
    leadingZeroes += 1;
  }
  const decoded = new Uint8Array(leadingZeroes + bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    decoded[decoded.length - index - 1] = bytes[index];
  }
  return decoded;
}
