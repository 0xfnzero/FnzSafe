import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';

const MAX_TRANSACTION_BYTES = 64 * 1024;
const KNOWN_PROGRAMS = new Map([
  ['11111111111111111111111111111111', 'System Program'],
  ['ComputeBudget111111111111111111111111111111', 'Compute Budget'],
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'SPL Token'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'Token-2022'],
  ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'Associated Token Account'],
  ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo'],
]);

export interface SolanaTransactionInspection {
  details: Array<{ label: string; value: string }>;
  warnings: string[];
}

export function decodeSolanaTransaction(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_TRANSACTION_BYTES / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Solana transaction encoding is invalid');
  }
  const binary = atob(value);
  if (binary.length === 0 || binary.length > MAX_TRANSACTION_BYTES) {
    throw new Error('Solana transaction is too large');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function inspectSolanaTransaction(
  encoded: string,
  expectedSigner: string,
): SolanaTransactionInspection {
  const bytes = decodeSolanaTransaction(encoded);
  let feePayer: string;
  let signers: string[];
  let programIds: string[];
  let instructionCount: number;
  let version: string;
  try {
    const transaction = VersionedTransaction.deserialize(bytes);
    const message = transaction.message;
    const staticKeys = message.staticAccountKeys;
    feePayer = staticKeys[0]?.toBase58() ?? 'Unknown';
    signers = staticKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58());
    programIds = message.compiledInstructions.map((instruction) =>
      staticKeys[instruction.programIdIndex]?.toBase58() ?? `Lookup account #${instruction.programIdIndex}`,
    );
    instructionCount = message.compiledInstructions.length;
    version = 'Versioned v0';
  } catch {
    const transaction = Transaction.from(bytes);
    const message = transaction.compileMessage();
    feePayer = message.accountKeys[0]?.toBase58() ?? 'Unknown';
    signers = message.accountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58());
    programIds = message.instructions.map((instruction) =>
      message.accountKeys[instruction.programIdIndex]?.toBase58() ?? `Account #${instruction.programIdIndex}`,
    );
    instructionCount = message.instructions.length;
    version = 'Legacy';
  }
  if (!PublicKey.isOnCurve(new PublicKey(expectedSigner).toBytes()) || !signers.includes(expectedSigner)) {
    throw new Error('The selected FnzSafe account is not a required transaction signer');
  }
  const uniquePrograms = [...new Set(programIds)];
  const warnings: string[] = [];
  const unknown = uniquePrograms.filter((program) => !KNOWN_PROGRAMS.has(program));
  if (unknown.length > 0) {
    warnings.push(`Unknown Solana program${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
  return {
    details: [
      { label: 'Format', value: version },
      { label: 'Fee payer', value: feePayer },
      { label: 'Required signers', value: signers.join(', ') },
      { label: 'Instructions', value: String(instructionCount) },
      {
        label: 'Programs',
        value: uniquePrograms.map((program) => KNOWN_PROGRAMS.get(program) ?? program).join(', '),
      },
      { label: 'Transaction digest', value: bs58.encode(sha256(bytes)) },
    ],
    warnings,
  };
}
