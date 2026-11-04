import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import {
  PublicKey,
  VersionedTransaction,
  VersionedMessage,
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
  const transaction = VersionedTransaction.deserialize(bytes);
  const message = transaction.message;
  const keys = message.staticAccountKeys;
  const feePayer = keys[0]?.toBase58() ?? 'Unknown';
  const signers = keys.slice(0, message.header.numRequiredSignatures).map(key => key.toBase58());
  const programIds = message.compiledInstructions.map(ix => keys[ix.programIdIndex]?.toBase58() ?? `Lookup account #${ix.programIdIndex}`);
  const instructionCount = message.compiledInstructions.length;
  const version = message.version === 'legacy' ? 'Legacy' : `Versioned v${message.version}`;
  const decodedDetails: SolanaTransactionInspection['details'] = [];
  const instructionWarnings: string[] = [];
  const address = (index: number | undefined) => index === undefined ? 'Missing account' : keys[index]?.toBase58() ?? `Unresolved lookup account #${index}`;
  message.compiledInstructions.forEach((ix, index) => {
    const program = programIds[index], data = ix.data, accounts = ix.accountKeyIndexes;
    const detail = (label: string, value: string) => decodedDetails.push({ label: `Instruction ${index + 1} · ${label}`, value });
    const amount = (offset: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true).toString();
    const opaque = () => {
      detail('Instruction data (hex)', Array.from(data, b => b.toString(16).padStart(2, '0')).join(''));
      instructionWarnings.push(`Instruction ${index + 1} is not fully decoded. It may transfer assets or change permissions.`);
    };
    detail('Program', `${KNOWN_PROGRAMS.get(program) ?? 'Unknown'} · ${program}`);
    detail('Accounts', accounts.map(address).join(', '));
    if (program === '11111111111111111111111111111111' && data.length === 12 && new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) === 2) {
      detail('Action', 'SOL transfer'); detail('From', address(accounts[0])); detail('Recipient', address(accounts[1])); detail('Amount (lamports)', amount(4));
    } else if (program === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
      const tag = data[0], checked = tag === 12 || tag === 13;
      if (([3, 4].includes(tag) && data.length === 9) || (checked && data.length === 10)) {
        const approval = tag === 4 || tag === 13;
        detail('Action', approval ? 'Token spending approval' : 'Token transfer');
        detail('Source token account', address(accounts[0]));
        if (checked) detail('Token mint', address(accounts[1]));
        detail(approval ? 'Delegate' : 'Destination token account', address(accounts[checked ? 2 : 1]));
        detail('Amount (raw token units)', amount(1));
        if (checked) detail('Token decimals (requested)', String(data[9]));
        if (approval) instructionWarnings.push('This approval allows the delegate to spend tokens from this account.');
        if (!checked) instructionWarnings.push('Token mint and decimals are not supplied by this instruction. Verify the token account.');
      } else if (tag === 6 && (data.length === 3 || data.length === 35) && data[2] <= 1 && data.length === (data[2] ? 35 : 3)) {
        detail('Action', 'Change token authority'); detail('Account', address(accounts[0]));
        detail('Authority type', String(data[1])); detail('New authority', data[2] ? new PublicKey(data.slice(3)).toBase58() : 'None (revoked)');
        instructionWarnings.push('Changing authority can permanently surrender control of tokens or a mint.');
      } else if (tag === 5 && data.length === 1) { detail('Action', 'Revoke token delegate'); }
      else if (tag === 9 && data.length === 1) {
        detail('Action', 'Close token account'); detail('Rent recipient', address(accounts[1]));
        instructionWarnings.push('This closes the token account and transfers its rent balance.');
      } else opaque();
    } else if (program === 'ComputeBudget111111111111111111111111111111' && data[0] === 2 && data.length === 5) {
      detail('Compute unit limit', String(new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0, true)));
    } else if (program === 'ComputeBudget111111111111111111111111111111' && data[0] === 3 && data.length === 9) {
      detail('Priority fee (micro-lamports / unit)', amount(1));
    } else if (program === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr') {
      detail('Memo', new TextDecoder().decode(data));
    } else opaque();
  });
  if (message.version !== 'legacy' && message.addressTableLookups.length) instructionWarnings.push('Address lookup tables are unresolved. Some recipients or programs cannot be identified in this preview.');
  if (!PublicKey.isOnCurve(new PublicKey(expectedSigner).toBytes()) || !signers.includes(expectedSigner)) {
    throw new Error('The selected FnzSafe account is not a required transaction signer');
  }
  const uniquePrograms = [...new Set(programIds)];
  const warnings: string[] = [...instructionWarnings];
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
      ...decodedDetails,
      { label: 'Transaction digest', value: bs58.encode(sha256(bytes)) },
    ],
    warnings,
  };
}

// Ed25519 has no implicit domain separation. Never allow the message-signing
// prompt to authorize bytes that are a canonical Solana transaction message.
export function validateSolanaMessage(encoded: string): Uint8Array {
  const bytes = decodeSolanaTransaction(encoded);
  let transactionMessage = false;
  try {
    const message = VersionedMessage.deserialize(bytes);
    const canonical = message.serialize();
    transactionMessage = canonical.length === bytes.length && canonical.every((v, i) => v === bytes[i]);
  } catch { /* Ordinary messages are not transaction messages. */ }
  if (transactionMessage) throw new Error('Transaction messages must use transaction approval, not signMessage');
  return bytes;
}
