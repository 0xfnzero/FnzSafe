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

test('message signing rejects legacy and v0 transaction messages but preserves ordinary messages', async () => {
  const { validateSolanaMessage } = await import('../src/solana-security');
  const tx = Transaction.from(Buffer.from(transfer(Keypair.generate()), 'base64'));
  assert.throws(() => validateSolanaMessage(encode(tx.serializeMessage())), /transaction approval/);
  const { TransactionMessage } = await import('@solana/web3.js');
  const v0 = new TransactionMessage({ payerKey: tx.feePayer!, recentBlockhash: tx.recentBlockhash!, instructions: tx.instructions }).compileToV0Message();
  assert.throws(() => validateSolanaMessage(encode(v0.serialize())), /transaction approval/);
  assert.equal(Buffer.from(validateSolanaMessage(encode(Buffer.from('Sign in to example.com')))).toString(), 'Sign in to example.com');
});

test('preview shows exact SOL recipient and integer amount, and flags opaque instructions', async () => {
  const signer = Keypair.generate();
  const encoded = transfer(signer), tx = Transaction.from(Buffer.from(encoded, 'base64'));
  const preview = inspectSolanaTransaction(encoded, signer.publicKey.toBase58());
  assert.equal(preview.details.find(d => d.label === 'Format')?.value, 'Legacy');
  assert.equal(preview.details.find(d => d.label.endsWith('Recipient'))?.value, tx.instructions[0].keys[1].pubkey.toBase58());
  assert.equal(preview.details.find(d => d.label.endsWith('Amount (lamports)'))?.value, '1');
  tx.instructions[0].data = Buffer.from([99]);
  assert.match(inspectSolanaTransaction(encode(tx.serialize({ requireAllSignatures: false })), signer.publicKey.toBase58()).warnings.join(' '), /not fully decoded/);
});

test('token approvals and authority changes show the delegate and new owner without rounding amounts', async () => {
  const { TransactionInstruction, PublicKey } = await import('@solana/web3.js');
  const signer = Keypair.generate(), delegate = Keypair.generate().publicKey;
  const approvalData = Buffer.alloc(9); approvalData[0] = 4; approvalData.writeBigUInt64LE(18446744073709551615n, 1);
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: delegate.toBase58() }).add(new TransactionInstruction({
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: true }, { pubkey: delegate, isSigner: false, isWritable: false }, { pubkey: signer.publicKey, isSigner: true, isWritable: false }], data: approvalData,
  }));
  let preview = inspectSolanaTransaction(encode(tx.serialize({ requireAllSignatures: false })), signer.publicKey.toBase58());
  assert.equal(preview.details.find(d => d.label.endsWith('Delegate'))?.value, delegate.toBase58());
  assert.equal(preview.details.find(d => d.label.endsWith('Amount (raw token units)'))?.value, '18446744073709551615');
  assert.ok(preview.warnings.some(w => w.includes('delegate to spend')));
  tx.instructions[0].data = Buffer.concat([Buffer.from([6, 2, 1]), delegate.toBuffer()]);
  preview = inspectSolanaTransaction(encode(tx.serialize({ requireAllSignatures: false })), signer.publicKey.toBase58());
  assert.equal(preview.details.find(d => d.label.endsWith('New authority'))?.value, delegate.toBase58());
  assert.ok(preview.warnings.some(w => w.includes('permanently surrender')));
});
