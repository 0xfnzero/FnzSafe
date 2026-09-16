import assert from 'node:assert/strict';
import test from 'node:test';
import { evmChain, requestedBuiltinChain } from '../src/chains';
import { validateProviderRequest } from '../src/provider-security';

test('DApp add/switch Arc resolves only built-in network metadata', () => {
  for (const [id, hex] of [[5042, '0x13b2'], [5042002, '0x4cef52']] as const) {
    const params = [{ chainId: hex, rpcUrls: ['https://evil.example'], nativeCurrency: { symbol: 'ETH' } }];
    assert.equal(requestedBuiltinChain(params), evmChain(id));
    assert.equal(requestedBuiltinChain(params).symbol, 'USDC');
    assert.match(requestedBuiltinChain(params).rpcUrl!, /^https:\/\/rpc\.(mainnet|testnet)\.arc\.io$/);
    for (const method of ['wallet_addEthereumChain', 'wallet_switchEthereumChain']) {
      assert.equal(validateProviderRequest({ channel: 'fnzsafe:provider', id: 'arc-test', family: 'evm', method, params }).method, method);
    }
  }
  assert.throws(() => requestedBuiltinChain([{ chainId: '0xffffff' }]), /Unsupported EVM chain/);
  assert.throws(() => requestedBuiltinChain([{ chainId: '0xffffffffffffffff' }]), /invalid/);
  assert.throws(() => requestedBuiltinChain([{ chainId: 5042 }]), /invalid/);
});
