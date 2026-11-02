import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import { Wallet, encryptKeystoreJson } from 'ethers';
import { createInitialVault, createPrivateKeyVault, decryptVault, encryptVault, mergeVaultAccounts } from '../src/vault';
import { importWallet } from '../src/import-wallet';
const phrase = 'test test test test test test test test test test test junk';
const key = '01'.padStart(64, '0');
const password = 'local-fixture-password';
test('plaintext imports cover EVM, TRON, Solana base58/JSON/seed and compressed Bitcoin WIF', async () => {
  const evm = createPrivateKeyVault('evm', key);
  assert.equal(evm.recoveryMnemonic, '');
  assert.equal(evm.accounts[0].address, new Wallet(key).address);
  assert.deepEqual(await decryptVault(await encryptVault(evm, password), password), evm);
  assert.equal(createPrivateKeyVault('tron', key).accounts[0].address, 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC');
  const pair = Keypair.fromSeed(new Uint8Array(32).fill(7));
  for (const text of [bs58.encode(pair.secretKey), JSON.stringify([...pair.secretKey]), '07'.repeat(32)]) assert.equal(createPrivateKeyVault('solana', text).accounts[0].address, pair.publicKey.toBase58());
  const body = Uint8Array.from([0x80, ...Buffer.from(key, 'hex'), 1]);
  const wif = bs58.encode(Uint8Array.from([...body, ...sha256(sha256(body)).slice(0, 4)]));
  assert.equal(createPrivateKeyVault('bitcoin', wif).accounts[0].address, createPrivateKeyVault('bitcoin', key).accounts[0].address);
  assert.throws(() => createPrivateKeyVault('bitcoin', wif.slice(0, -1) + 'a'));
  assert.throws(() => createPrivateKeyVault('evm', '00'.repeat(32)));
  assert.throws(() => createPrivateKeyVault('solana', '[256]'));
});
test('mnemonic whitespace normalized; empty imports rejected; appending preserves original root and keys', async () => {
  const payload = await importWallet({ kind: 'mnemonic', text: phrase.toUpperCase().replaceAll(' ', '\n '), family: 'evm' });
  assert.equal(payload.recoveryMnemonic, phrase);
  await assert.rejects(importWallet({ kind: 'mnemonic', text: ' ', family: 'evm' }));
  const merged = mergeVaultAccounts(payload, createPrivateKeyVault('evm', key));
  assert.equal(merged.recoveryMnemonic, phrase); assert.equal(merged.accounts.length, 6);
  assert.deepEqual(merged.accounts.slice(0, 5), payload.accounts);
  assert.throws(() => mergeVaultAccounts(merged, createPrivateKeyVault('evm', key)), /already imported/);
});
test('extension backup and standard EVM keystore restore correct addresses and reject hostile work factors', async () => {
  const payload = createInitialVault(phrase);
  const backup = await encryptVault(payload, password);
  assert.deepEqual(await importWallet({ kind: 'encrypted', text: JSON.stringify(backup), family: 'evm', password }), payload);
  const wallet = new Wallet(key);
  const json = await encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, password, { scrypt: { N: 1024, r: 8, p: 1 } });
  assert.equal((await importWallet({ kind: 'encrypted', text: json, family: 'evm', password })).accounts[0].address, wallet.address);
  const hostile = JSON.parse(json); hostile.Crypto.kdfparams.n = 2 ** 30;
  await assert.rejects(importWallet({ kind: 'encrypted', text: JSON.stringify(hostile), family: 'evm', password }), /work factor/);
});

test('desktop Rust-generated encrypted key and phrase fixtures restore matching addresses', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/desktop-backups.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) {
    const payload = await importWallet({ kind: 'encrypted', text: fixture.text, family: fixture.family, password });
    assert.equal(payload.accounts.find(a => a.family === fixture.family)?.address.toLowerCase(), fixture.expected_address.toLowerCase(), fixture.name);
  }
  const corrupted = JSON.parse(fixtures[0].text); corrupted.address = '0x' + '11'.repeat(20);
  await assert.rejects(importWallet({ kind: 'encrypted', text: JSON.stringify(corrupted), family: 'evm', password }), /damaged backup/);
});
