import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectTypedData, normalizeAndInspectTransaction, prepareArcFees, ARC_MIN_FEE_PER_GAS, securityConstants } from '../src/transaction-security';

const wallet = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const spender = '0x3333333333333333333333333333333333333333';

function addressWord(address: string): string {
  return address.slice(2).padStart(64, '0');
}

function uintWord(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

test('rejects a transaction for another chain instead of silently replacing chainId', () => {
  assert.throws(
    () => normalizeAndInspectTransaction({ from: wallet, to: token, chainId: '0x89' }, 1, wallet),
    /does not match selected chain/,
  );
});

test('rejects a transaction from an account that is not selected', () => {
  assert.throws(
    () => normalizeAndInspectTransaction({ from: spender, to: token }, 1, wallet),
    /does not match the selected FnzSafe account/,
  );
});

test('decodes and flags unlimited ERC-20 approvals', () => {
  const data = `0x095ea7b3${addressWord(spender)}${uintWord(securityConstants.MAX_UINT256)}`;
  const inspection = normalizeAndInspectTransaction({ from: wallet, to: token, data }, 1, wallet);

  assert.equal(inspection.danger, true);
  assert.deepEqual(inspection.details.find((detail) => detail.label === 'Spender')?.value, spender);
  assert.equal(inspection.details.find((detail) => detail.label === 'Approval amount (raw)')?.value, 'Unlimited');
  assert.match(inspection.warnings.join(' '), /entire current and future token balance/);
});

test('decodes and flags NFT operator approval', () => {
  const data = `0xa22cb465${addressWord(spender)}${uintWord(1n)}`;
  const inspection = normalizeAndInspectTransaction({ from: wallet, to: token, data }, 1, wallet);

  assert.equal(inspection.danger, true);
  assert.equal(inspection.details.find((detail) => detail.label === 'Approve all NFTs')?.value, 'Yes');
});

test('typed data enforces chain binding and identifies unlimited permits', () => {
  assert.throws(
    () => inspectTypedData(JSON.stringify({ primaryType: 'Permit', domain: { chainId: 10 }, message: {} }), 1),
    /does not match selected chain/,
  );
  const inspection = inspectTypedData(JSON.stringify({
    primaryType: 'Permit',
    domain: { name: 'Token', chainId: 1, verifyingContract: token },
    message: { spender, value: securityConstants.MAX_UINT256.toString() },
  }), 1);
  assert.equal(inspection.danger, true);
  assert.match(inspection.warnings.join(' '), /unlimited token allowance/);
});

test('rejects ambiguous fee models and oversized nonce values', () => {
  assert.throws(
    () => normalizeAndInspectTransaction({ from: wallet, to: token, gasPrice: 1, maxFeePerGas: 2 }, 1, wallet),
    /cannot mix legacy gasPrice/,
  );
  assert.throws(
    () => normalizeAndInspectTransaction({ from: wallet, to: token, nonce: '9007199254740992' }, 1, wallet),
    /nonce is too large/,
  );
  assert.throws(
    () => normalizeAndInspectTransaction({ from: wallet, to: token, value: Number.MAX_SAFE_INTEGER + 1 }, 1, wallet),
    /safe integer number or an exact string/,
  );
  assert.throws(
    () => normalizeAndInspectTransaction({ from: wallet, to: token, value: (securityConstants.MAX_UINT256 + 1n).toString() }, 1, wallet),
    /uint256/,
  );
});

test('Arc transaction inspection uses USDC and rejects low fee caps and zero-address sends', () => {
  for (const id of [5042, 5042002]) {
    const inspect = (input: Record<string, unknown>) => normalizeAndInspectTransaction({ from: wallet, to: token, ...input }, id, wallet, 'USDC');
    assert.throws(() => inspect({ maxFeePerGas: ARC_MIN_FEE_PER_GAS - 1n }), /at least 20 Gwei/);
    assert.throws(() => inspect({ gasPrice: 1n }), /at least 20 Gwei/);
    assert.throws(() => inspect({ to: '0x0000000000000000000000000000000000000000', value: 1n }), /zero address/);
    const result = inspect({ value: 10n ** 18n, maxFeePerGas: ARC_MIN_FEE_PER_GAS });
    assert.equal(result.details.find((detail) => detail.label === 'Value')?.value, '1.0 USDC');
    assert.match(result.warnings.join(' '), /native USDC/);
  }
  assert.doesNotThrow(() => normalizeAndInspectTransaction({ to: token, gasPrice: 1n }, 1, wallet));
});

test('Arc automatic fees preserve higher quotes and explicit caps', async () => {
  const low = () => Promise.resolve({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
  const transaction = { to: token, value: 1n };
  assert.equal((await prepareArcFees(transaction, 5042, low)).maxFeePerGas, ARC_MIN_FEE_PER_GAS);
  assert.equal((await prepareArcFees(transaction, 5042002, () => Promise.resolve({ maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1n }))).maxFeePerGas, 30_000_000_000n);
  const explicit = { ...transaction, maxFeePerGas: 40_000_000_000n };
  assert.equal(await prepareArcFees(explicit, 5042, low), explicit);
  assert.equal(await prepareArcFees(transaction, 1, low), transaction);
});
