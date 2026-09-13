import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Keypair,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { inspectSolanaTransaction } from '../src/solana-security';

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function transfer(signer: Keypair): string {
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1,
  }));
  return encode(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

test('Solana inspection binds the selected signer and shows known programs', () => {
  const signer = Keypair.generate();
  const inspection = inspectSolanaTransaction(transfer(signer), signer.publicKey.toBase58());
  assert.equal(inspection.details.find((detail) => detail.label === 'Programs')?.value, 'System Program');
  assert.deepEqual(inspection.warnings, []);
});

test('Solana inspection rejects transactions that do not require the selected account', () => {
  const signer = Keypair.generate();
  assert.throws(
    () => inspectSolanaTransaction(transfer(signer), Keypair.generate().publicKey.toBase58()),
    /not a required transaction signer/,
  );
});

test('Solana inspection rejects oversized or malformed encodings', () => {
  assert.throws(() => inspectSolanaTransaction('not-base64', Keypair.generate().publicKey.toBase58()), /encoding is invalid/);
  assert.throws(() => inspectSolanaTransaction('A'.repeat(90 * 1024), Keypair.generate().publicKey.toBase58()), /encoding is invalid/);
});
