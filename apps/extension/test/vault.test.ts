import assert from 'node:assert/strict';
import test from 'node:test';
import { socialRecoveryConfig } from '../src/chains';
import {
  createInitialVault,
  decryptVault,
  encryptVault,
  migrateLegacyBitcoinAddresses,
} from '../src/vault';

test('vault round-trip keeps account keys encrypted at rest', async () => {
  const payload = createInitialVault();
  const stored = await encryptVault(payload, 'correct horse battery staple');
  const serialized = JSON.stringify(stored);

  for (const account of payload.accounts) {
    assert.equal(serialized.includes(account.privateKey), false);
  }
  const restored = await decryptVault(stored, 'correct horse battery staple');
  assert.deepEqual(restored, payload);
});

test('vault rejects a wrong password', async () => {
  const stored = await encryptVault(createInitialVault(), 'correct horse battery staple');
  await assert.rejects(
    () => decryptVault(stored, 'wrong wallet password'),
    /Incorrect password/,
  );
});

test('vault rejects hostile KDF parameters before doing expensive work', async () => {
  const stored = await encryptVault(createInitialVault(), 'correct horse battery staple');
  stored.kdf.iterations = 100_000_000;
  await assert.rejects(
    () => decryptVault(stored, 'correct horse battery staple'),
    /Unsupported or weak vault format/,
  );
});

test('vault rejects malformed encodings and inconsistent account keys', async () => {
  const payload = createInitialVault();
  const invalidPayload = structuredClone(payload);
  invalidPayload.accounts[0].address = '0x1111111111111111111111111111111111111111';
  await assert.rejects(
    () => encryptVault(invalidPayload, 'correct horse battery staple'),
    /Invalid vault contents/,
  );

  const stored = await encryptVault(payload, 'correct horse battery staple');
  stored.cipher.iv = 'AA==';
  await assert.rejects(
    () => decryptVault(stored, 'correct horse battery staple'),
    /Incorrect password or damaged wallet vault/,
  );
});

test('one recovery phrase deterministically derives all supported families', () => {
  const first = createInitialVault(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  const restored = createInitialVault(first.recoveryMnemonic);
  const addresses = Object.fromEntries(
    first.accounts.map((account) => [`${account.family}:${account.derivationPath ?? 'default'}`, account.address]),
  );
  const restoredAddresses = Object.fromEntries(
    restored.accounts.map((account) => [`${account.family}:${account.derivationPath ?? 'default'}`, account.address]),
  );

  assert.deepEqual(restoredAddresses, addresses);
  assert.match(addresses["bitcoin:m/86'/0'/0'/0/0"], /^bc1p/);
  assert.match(addresses['tron:default'], /^T/);
  assert.deepEqual(addresses, {
    'evm:default': '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
    'solana:default': 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
    "bitcoin:m/86'/0'/0'/0/0": 'bc1pmg5dhafms6h9nts4dtehgkanym6yeccfmk5hx3ts3jxnm4zh2knqv80ha5',
    "bitcoin:m/84'/0'/0'/0/0": 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    'tron:default': 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
  });
});

test('legacy Bitcoin accounts migrate key and address to wallet-import compatible Taproot', () => {
  const payload = createInitialVault(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  const bitcoin = payload.accounts.find((account) => account.family === 'bitcoin')!;
  const legacyPrivateKey = bitcoin.privateKey;
  bitcoin.privateKey = '0x4604b4b710fe91f584fff084e1a9159fe4f8408fff380596a604948474ce4fa3';
  bitcoin.address = 'bc1cr8te4kr609gcawutmrza0j4xv80jy8z0km63t';

  assert.equal(migrateLegacyBitcoinAddresses(payload), true);
  assert.equal(bitcoin.address, 'bc1pmg5dhafms6h9nts4dtehgkanym6yeccfmk5hx3ts3jxnm4zh2knqv80ha5');
  assert.equal(bitcoin.privateKey, legacyPrivateKey);
  assert.equal(migrateLegacyBitcoinAddresses(payload), false);
});

test('a full legacy vault remains unlockable when migration cannot append a compatibility account', async () => {
  const payload = createInitialVault(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  payload.accounts = payload.accounts.filter(
    (account) => account.derivationPath !== "m/84'/0'/0'/0/0",
  );
  const template = payload.accounts.find((account) => account.family === 'evm')!;
  while (payload.accounts.length < 100) {
    payload.accounts.push({
      ...template,
      id: crypto.randomUUID(),
      name: `EVM Account ${payload.accounts.length + 1}`,
    });
  }
  const stored = await encryptVault(payload, 'correct horse battery staple');
  const restored = await decryptVault(stored, 'correct horse battery staple');

  assert.equal(restored.accounts.length, 100);
  assert.equal(restored.accounts.some(
    (account) => account.derivationPath === "m/84'/0'/0'/0/0",
  ), false);
});

test('social recovery remains disabled without audited MPC configuration', () => {
  assert.equal(socialRecoveryConfig.enabled, false);
  assert.match(socialRecoveryConfig.reason, /MPC/);
});
