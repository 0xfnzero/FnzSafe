import { Contract, formatUnits, getAddress, Interface, JsonRpcProvider, parseUnits, Wallet, type TransactionRequest } from 'ethers';
import type { ChainInfo, PortfolioAsset } from './types';
import { prepareArcFees } from './transaction-security';
import { isNativeTokenAlias } from './chains';

export const erc20 = new Interface(['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)', 'function symbol() view returns(string)', 'function name() view returns(string)', 'function transfer(address,uint256) returns(bool)']);
export async function tokenAsset(provider: JsonRpcProvider, chain: ChainInfo, owner: string, input: string): Promise<PortfolioAsset> {
  const address = getAddress(input);
  if (isNativeTokenAlias(chain.chainId, address)) throw new Error('This address represents the native asset');
  if (await provider.getCode(address) === '0x') throw new Error('Token contract not found');
  const token = new Contract(address, erc20, provider);
  const [balance, decimals, symbol, name] = await Promise.all([
    token.balanceOf(owner), token.decimals(), token.symbol().catch(() => 'Token'), token.name().catch(() => 'Imported token'),
  ]);
  const digits = Number(decimals);
  if (!Number.isInteger(digits) || digits < 0 || digits > 255 || typeof balance !== 'bigint') throw new Error('Invalid token metadata');
  const safeText = (v: unknown, fallback: string, length: number) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, length) : fallback;
  return { id: `${chain.key}:${address.toLowerCase()}`, family: 'evm', chainKey: chain.key, address,
    name: safeText(name, 'Imported token', 96), symbol: safeText(symbol, 'Token', 32),
    balance: formatUnits(balance, digits), rawBalance: balance.toString(), decimals: digits, native: false, risk: 'unknown' };
}
export type PreparedTransaction = { to: string; data: string; value: string; from: string; chainId: number; gasLimit: string; maxFeeWei: string; nonce: number; tokenTransfer?: true; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
export async function prepareTransaction(provider: JsonRpcProvider, chain: ChainInfo, from: string, request: TransactionRequest, tokenTransfer = false): Promise<PreparedTransaction> {
  request = await prepareArcFees(request, chain.chainId!, () => provider.getFeeData());
  const to = getAddress(String(request.to));
  const data = String(request.data ?? '0x');
  const value = BigInt(request.value ?? 0).toString();
  if (!/^0x([a-f\d]{2})*$/i.test(data) || data.length > 131074 || BigInt(value) < 0n) throw new Error('Invalid transaction');
  const tx = { from: getAddress(from), to, data, value, chainId: chain.chainId! };
  const simulation = await provider.call(tx);
  if (tokenTransfer) assertTokenTransferResult(simulation);
  const estimated = await provider.estimateGas(tx);
  const gas = request.gasLimit != null ? BigInt(request.gasLimit) : estimated * 120n / 100n;
  if (gas < estimated) throw new Error('Requested gas limit is below the simulation estimate');
  const suggested = await provider.getFeeData();
  const fees = request.gasPrice != null
    ? { gasPrice: BigInt(request.gasPrice), maxFeePerGas: null, maxPriorityFeePerGas: null }
    : { gasPrice: suggested.gasPrice, maxFeePerGas: request.maxFeePerGas != null ? BigInt(request.maxFeePerGas) : suggested.maxFeePerGas, maxPriorityFeePerGas: request.maxPriorityFeePerGas != null ? BigInt(request.maxPriorityFeePerGas) : suggested.maxPriorityFeePerGas };
  if (fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null && (fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > fees.maxFeePerGas)) throw new Error('Invalid transaction fee');
  const nonce = await provider.getTransactionCount(from, 'pending');
  if (request.nonce != null && request.nonce !== nonce) throw new Error('Requested nonce does not match the pending account nonce');
  const fee = fees.maxFeePerGas ?? fees.gasPrice;
  if (fee === null || fee < 0n || gas <= 0n) throw new Error('Unable to estimate network fee');
  if (await provider.getBalance(from) < BigInt(value) + gas * fee) throw new Error('Insufficient balance for amount and maximum network fee');
  return { ...tx, gasLimit: gas.toString(), maxFeeWei: (gas * fee).toString(), nonce, ...(tokenTransfer ? { tokenTransfer: true as const } : {}),
    ...(fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null
      ? { maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() }
      : { gasPrice: fee.toString() }) };
}
export async function signPrepared(provider: JsonRpcProvider, wallet: Wallet, tx: PreparedTransaction, assertContext: () => Promise<void>): Promise<string> {
  if (wallet.address.toLowerCase() !== tx.from.toLowerCase() || BigInt(await provider.send('eth_chainId', [])) !== BigInt(tx.chainId)) throw new Error('Signing account or network changed');
  if (await provider.getTransactionCount(tx.from, 'pending') !== tx.nonce) throw new Error('Account nonce changed; review again');
  const simulation = await provider.call(tx);
  if (tx.tokenTransfer) assertTokenTransferResult(simulation);
  if (await provider.estimateGas(tx) > BigInt(tx.gasLimit)) throw new Error('Gas estimate increased; review again');
  await assertContext();
  const { maxFeeWei: _, tokenTransfer: __, ...request } = tx;
  const signed = await wallet.signTransaction(request);
  await assertContext();
  return signed;
}
export async function sendPrepared(provider: JsonRpcProvider, wallet: Wallet, tx: PreparedTransaction, assertContext: () => Promise<void>): Promise<string> {
  const signed = await signPrepared(provider, wallet, tx, assertContext);
  await assertContext();
  return (await provider.broadcastTransaction(signed)).hash;
}
export function transferRequest(recipient: string, amount: string, token?: PortfolioAsset): TransactionRequest {
  const to = getAddress(recipient);
  if (to === '0x0000000000000000000000000000000000000000') throw new Error('Recipient cannot be zero');
  if (!/^\d+(\.\d+)?$/.test(amount) || amount.length > 300) throw new Error('Invalid amount');
  const value = parseUnits(amount, token?.decimals ?? 18);
  if (value <= 0n) throw new Error('Amount must be greater than zero');
  if (token) {
    if (value > BigInt(token.rawBalance)) throw new Error('Insufficient token balance');
    return { to: token.address, value: 0n, data: erc20.encodeFunctionData('transfer', [to, value]) };
  }
  return { to, value };
}

export function assertTokenTransferResult(result: string): void {
  // Some established ERC-20 contracts return no data; an explicit false is a failure.
  if (result === '0x') return;
  if (result.toLowerCase() !== '0x' + '0'.repeat(63) + '1') throw new Error('Token transfer simulation did not return success');
}
