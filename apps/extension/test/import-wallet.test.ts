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
  assert.deepEqual(merged.accounts.slice(0, 5).map(({ walletId: _, ...a }) => a), payload.accounts);
  assert.equal(merged.wallets?.length, 2);
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

test('legacy imported private keys are separated from the mnemonic wallet without changing keys', async () => {
  const { groupedVault, createPrivateKeyVault } = await import('../src/vault');
  const legacy = createInitialVault('test test test test test test test test test test test junk');
  const imported = createPrivateKeyVault('evm', '7'.padStart(64, '0'));
  legacy.accounts.push(imported.accounts[0]);
  const grouped = groupedVault(legacy);
  assert.equal(grouped.wallets!.length, 2);
  assert.equal(grouped.wallets![0].recoveryMnemonic, legacy.recoveryMnemonic);
  assert.equal(grouped.wallets![1].recoveryMnemonic, '');
  assert.equal(grouped.accounts.at(-1)!.walletId, grouped.wallets![1].id);
  assert.deepEqual(grouped.accounts.map(({ walletId, ...a }) => a), legacy.accounts);
});

test('verified custom derivation paths retain mnemonic grouping and full-backup metadata', async () => {
  const { HDNodeWallet } = await import('ethers');
  const { mnemonicToSeedSync } = await import('@scure/bip39');
  const { groupedVault } = await import('../src/vault');
  const payload = createInitialVault(phrase);
  const path = "m/44'/60'/0'/0/1";
  const account = HDNodeWallet.fromSeed(mnemonicToSeedSync(phrase)).derivePath(path);
  payload.accounts[0] = { ...payload.accounts[0], privateKey: account.privateKey, address: account.address, derivationPath: path };
  const grouped = groupedVault(payload);
  assert.equal(grouped.wallets!.length, 1);
  const restored = await decryptVault(await encryptVault(grouped, password), password);
  assert.equal(restored.accounts[0].derivationPath, path);
  assert.equal(restored.accounts[0].address, account.address);
});

test('importing a full mnemonic after one of its keys still provides every chain in that wallet', () => {
  const root = createInitialVault(phrase);
  const existing = createPrivateKeyVault('evm', root.accounts[0].privateKey);
  const merged = mergeVaultAccounts(existing, root);
  assert.equal(merged.wallets!.length, 2);
  assert.equal(merged.accounts.filter(a => a.walletId === merged.wallets![1].id).length, 5);
  assert.equal(merged.accounts[0].id, existing.accounts[0].id);
  assert.throws(() => mergeVaultAccounts(merged, root), /already imported/);
});
