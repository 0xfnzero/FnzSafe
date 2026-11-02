import assert from 'node:assert/strict';
import test from 'node:test';
import { displaySignedMessage } from '../src/message-preview';
import { assertTokenTransferResult } from '../src/evm-transfers';

test('message previews decode exactly the bytes signed and expose binary/control content', () => {
  assert.equal(displaySignedMessage('solana_signMessage', [btoa('hello\nworld')]), '"hello\\nworld"');
  assert.equal(displaySignedMessage('personal_sign', ['0x6869', '0x1234']), '"hi"');
  assert.equal(displaySignedMessage('eth_sign', ['0x1234', '0x6869']), '"hi"');
  assert.equal(displaySignedMessage('solana_signMessage', ['/w==']), 'Binary message (hex): 0xff');
});
test('token simulation accepts true/no-return contracts and rejects false/malformed results', () => {
  assertTokenTransferResult('0x');
  assertTokenTransferResult('0x' + '0'.repeat(63) + '1');
  for (const result of ['0x' + '0'.repeat(64), '0x01', '0x' + '0'.repeat(63) + '2']) {
    assert.throws(() => assertTokenTransferResult(result), /did not return success/);
  }
});
