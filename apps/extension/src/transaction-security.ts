import { formatUnits, getAddress, isAddress, type TransactionRequest } from 'ethers';
import { isArcChain } from './chains';

export const ARC_MIN_FEE_PER_GAS = 20_000_000_000n;

export async function prepareArcFees(
  transaction: TransactionRequest,
  chainId: number,
  loadFees: () => Promise<{ maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null }>,
): Promise<TransactionRequest> {
  if (!isArcChain(chainId) || transaction.gasPrice != null || transaction.maxFeePerGas != null) return transaction;
  const fees = await loadFees();
  const priority = BigInt(transaction.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas ?? 0n);
  const quoted = fees.maxFeePerGas ?? ARC_MIN_FEE_PER_GAS;
  const maxFeePerGas = [quoted, priority, ARC_MIN_FEE_PER_GAS].reduce((a, b) => a > b ? a : b);
  return { ...transaction, maxFeePerGas, maxPriorityFeePerGas: priority };
}

const MAX_CALLDATA_BYTES = 256 * 1024;
const MAX_UINT256 = (1n << 256n) - 1n;
const EFFECTIVELY_UNLIMITED = 1n << 255n;
const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3';

export interface TransactionInspection {
  transaction: TransactionRequest;
  details: Array<{ label: string; value: string }>;
  warnings: string[];
  danger: boolean;
}

function parseQuantity(value: unknown, label: string): bigint | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} must use a safe integer number or an exact string quantity`);
  }
  try {
    const parsed = BigInt(value as string | number | bigint);
    if (parsed < 0n || parsed > MAX_UINT256) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a uint256 integer or hex quantity`);
  }
}

function parseAddress(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`${label} is not a valid EVM address`);
  return getAddress(value);
}

function parseData(value: unknown): string {
  if (value === undefined || value === null || value === '') return '0x';
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error('Transaction data must be an even-length hex string');
  }
  if ((value.length - 2) / 2 > MAX_CALLDATA_BYTES) throw new Error('Transaction data is too large');
  return value;
}

function word(data: string, index: number): string | null {
  const start = 10 + index * 64;
  const value = data.slice(start, start + 64);
  return value.length === 64 ? value : null;
}

function wordAddress(data: string, index: number): string | null {
  const value = word(data, index);
  if (!value || !/^0{24}[0-9a-fA-F]{40}$/.test(value)) return null;
  try {
    return getAddress(`0x${value.slice(24)}`);
  } catch {
    return null;
  }
}

function wordUint(data: string, index: number): bigint | null {
  const value = word(data, index);
  return value ? BigInt(`0x${value}`) : null;
}

function approvalAmount(value: bigint): string {
  return value >= EFFECTIVELY_UNLIMITED ? 'Unlimited' : value.toString();
}

function inspectCalldata(
  data: string,
  to: string | undefined,
  details: TransactionInspection['details'],
  warnings: string[],
): boolean {
  if (data === '0x') return false;
  const selector = data.slice(0, 10).toLowerCase();
  let danger = false;
  if (selector === '0xa9059cbb') {
    details.push({ label: 'Action', value: 'ERC-20 transfer' });
    const recipient = wordAddress(data, 0);
    const amount = wordUint(data, 1);
    if (recipient) details.push({ label: 'Token recipient', value: recipient });
    if (amount !== null) details.push({ label: 'Token amount (raw)', value: amount.toString() });
  } else if (selector === '0x095ea7b3') {
    details.push({ label: 'Action', value: 'ERC-20 approval' });
    const spender = wordAddress(data, 0);
    const amount = wordUint(data, 1);
    if (spender) details.push({ label: 'Spender', value: spender });
    if (amount !== null) details.push({ label: 'Approval amount (raw)', value: approvalAmount(amount) });
    if (amount !== null && amount >= EFFECTIVELY_UNLIMITED) {
      danger = true;
      warnings.push('Unlimited token approval lets this spender transfer the entire current and future token balance.');
    } else {
      warnings.push('This transaction grants a contract permission to spend tokens.');
    }
  } else if (selector === '0xa22cb465') {
    details.push({ label: 'Action', value: 'NFT operator approval' });
    const operator = wordAddress(data, 0);
    const enabled = wordUint(data, 1);
    if (operator) details.push({ label: 'Operator', value: operator });
    if (enabled !== null) details.push({ label: 'Approve all NFTs', value: enabled === 0n ? 'No' : 'Yes' });
    if (enabled !== null && enabled !== 0n) {
      danger = true;
      warnings.push('This operator will be able to transfer every NFT in this collection.');
    }
  } else if (selector === '0x23b872dd') {
    details.push({ label: 'Action', value: 'Transfer from an approved account' });
    warnings.push('This call uses an existing token allowance. Verify the source and recipient carefully.');
  } else {
    details.push({ label: 'Action', value: `Contract call ${selector}` });
    warnings.push('FnzSafe cannot fully decode this contract method. Verify the destination and simulation result.');
  }
  if (to?.toLowerCase() === PERMIT2_ADDRESS) {
    danger = true;
    warnings.push('This call targets Permit2. Review token, spender, amount and expiration before approving.');
  }
  return danger;
}

export function normalizeAndInspectTransaction(
  value: unknown,
  expectedChainId: number,
  expectedFrom?: string,
  nativeSymbol = 'ETH',
): TransactionInspection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Transaction payload is missing');
  const input = value as Record<string, unknown>;
  const from = parseAddress(input.from, 'Transaction from');
  const normalizedExpectedFrom = expectedFrom ? parseAddress(expectedFrom, 'Wallet address') : undefined;
  if (from && normalizedExpectedFrom && from.toLowerCase() !== normalizedExpectedFrom.toLowerCase()) {
    throw new Error('Transaction from does not match the selected FnzSafe account');
  }
  const suppliedChainId = parseQuantity(input.chainId, 'Transaction chainId');
  if (suppliedChainId !== undefined && suppliedChainId !== BigInt(expectedChainId)) {
    throw new Error(`Transaction chainId ${suppliedChainId} does not match selected chain ${expectedChainId}`);
  }
  const to = parseAddress(input.to, 'Transaction recipient');
  const valueWei = parseQuantity(input.value, 'Transaction value') ?? 0n;
  if (isArcChain(expectedChainId) && valueWei > 0n && to === '0x0000000000000000000000000000000000000000') {
    throw new Error('Arc does not allow USDC transfers to the zero address');
  }
  const data = parseData(input.data ?? input.input);
  const details: TransactionInspection['details'] = [
    { label: 'From', value: normalizedExpectedFrom ?? from ?? 'Selected FnzSafe account' },
    { label: 'To', value: to ?? 'New contract deployment' },
    { label: 'Value', value: `${formatUnits(valueWei, 18)} ${nativeSymbol}` },
  ];
  const warnings: string[] = [];
  if (isArcChain(expectedChainId)) warnings.push('Arc transaction fees are paid in native USDC. USDC runtime restrictions may cause transfers to revert.');
  let danger = inspectCalldata(data, to, details, warnings);
  if (!to) {
    danger = true;
    warnings.push('This transaction deploys a new contract. Confirm the bytecode source before continuing.');
  }
  const nonce = parseQuantity(input.nonce, 'Transaction nonce');
  if (nonce !== undefined && nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Transaction nonce is too large');
  const gasLimit = parseQuantity(input.gas ?? input.gasLimit, 'Gas limit');
  const gasPrice = parseQuantity(input.gasPrice, 'Gas price');
  const maxFeePerGas = parseQuantity(input.maxFeePerGas, 'Maximum fee per gas');
  const maxPriorityFeePerGas = parseQuantity(input.maxPriorityFeePerGas, 'Maximum priority fee per gas');
  if (gasPrice !== undefined && (maxFeePerGas !== undefined || maxPriorityFeePerGas !== undefined)) {
    throw new Error('Transaction cannot mix legacy gasPrice with EIP-1559 fee fields');
  }
  if (isArcChain(expectedChainId)) {
    const fee = gasPrice ?? maxFeePerGas;
    if (fee !== undefined && fee < ARC_MIN_FEE_PER_GAS) throw new Error('Arc requires a fee cap of at least 20 Gwei in native USDC units');
    if (maxFeePerGas !== undefined && maxPriorityFeePerGas !== undefined && maxPriorityFeePerGas > maxFeePerGas) {
      throw new Error('Maximum priority fee exceeds the maximum fee');
    }
  }
  const transaction: TransactionRequest = {
    chainId: expectedChainId,
    ...(to ? { to } : {}),
    ...(valueWei > 0n ? { value: valueWei } : {}),
    ...(data !== '0x' ? { data } : {}),
    ...(nonce !== undefined ? { nonce: Number(nonce) } : {}),
    ...(gasLimit !== undefined ? { gasLimit } : {}),
    ...(gasPrice !== undefined ? { gasPrice } : {}),
    ...(maxFeePerGas !== undefined ? { maxFeePerGas } : {}),
    ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
  };
  return { transaction, details, warnings: [...new Set(warnings)], danger };
}

export function inspectTypedData(
  value: unknown,
  expectedChainId: number,
): { details: Array<{ label: string; value: string }>; warnings: string[]; danger: boolean } {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text || text.length > 128 * 1024) throw new Error('Typed data is missing or too large');
  const payload = JSON.parse(text) as {
    primaryType?: unknown;
    domain?: { name?: unknown; verifyingContract?: unknown; chainId?: unknown };
    message?: Record<string, unknown>;
  };
  const suppliedChainId = parseQuantity(payload.domain?.chainId, 'Typed data chainId');
  if (suppliedChainId !== undefined && suppliedChainId !== BigInt(expectedChainId)) {
    throw new Error(`Typed data chainId ${suppliedChainId} does not match selected chain ${expectedChainId}`);
  }
  const primaryType = typeof payload.primaryType === 'string' ? payload.primaryType : 'Unknown';
  const details = [{ label: 'Typed data type', value: primaryType }];
  if (typeof payload.domain?.name === 'string') details.push({ label: 'Domain', value: payload.domain.name.slice(0, 128) });
  if (typeof payload.domain?.verifyingContract === 'string' && isAddress(payload.domain.verifyingContract)) {
    details.push({ label: 'Verifying contract', value: getAddress(payload.domain.verifyingContract) });
  }
  const spender = payload.message?.spender;
  if (typeof spender === 'string' && isAddress(spender)) details.push({ label: 'Spender', value: getAddress(spender) });
  const warnings: string[] = [];
  const isPermit = /permit/i.test(primaryType);
  let danger = isPermit;
  if (isPermit) warnings.push('This signature may grant token spending permission without sending an on-chain transaction now.');
  const amount = parseQuantity(payload.message?.value ?? payload.message?.amount, 'Typed data amount');
  if (amount !== undefined) details.push({ label: 'Amount (raw)', value: approvalAmount(amount) });
  if (isPermit && amount !== undefined && amount >= EFFECTIVELY_UNLIMITED) {
    danger = true;
    warnings.push('This typed-data signature grants an unlimited token allowance.');
  }
  return { details, warnings, danger };
}

export const securityConstants = Object.freeze({ MAX_UINT256 });
