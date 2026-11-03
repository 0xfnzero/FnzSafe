import assert from 'node:assert/strict';
import test from 'node:test';
import { nextWalletName } from '../src/wallet-names';
import { createInitialVault, mergeVaultAccounts } from '../src/vault';

test('default wallet numbers continue after existing numbers and custom names', () => {
  assert.equal(nextWalletName([]), 'Wallet 1');
  assert.equal(nextWalletName([{ name: 'Wallet 1' }]), 'Wallet 2');
  assert.equal(nextWalletName([{ name: 'Wallet 7' }, { name: 'Savings' }]), 'Wallet 8');
  assert.equal(nextWalletName([{ name: 'wallet-09' }]), 'Wallet 10');
});
test('wallet creation accepts an optional name and rejects duplicate names without replacing accounts', () => {
  const original = createInitialVault();
  const named = mergeVaultAccounts(original, createInitialVault(), '  Savings  ');
  assert.equal(named.wallets![1].name, 'Savings');
  const next = mergeVaultAccounts(named, createInitialVault());
  assert.equal(next.wallets![2].name, 'Wallet 3');
  assert.throws(() => mergeVaultAccounts(next, createInitialVault(), 'savings'), /already exists/);
  assert.equal(next.wallets!.length, 3);
});
