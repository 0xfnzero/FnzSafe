import { Interface, JsonRpcProvider } from 'ethers';
import { safeAccount, SAFE_FACTORY, verifySafeFactory } from './safe';
import type { ChainInfo } from './types';
import type { SafeDiscoveryPage } from '../../desktop/src/lib/safeMultisig';
import type { DiscoveryCursor } from '../../desktop/src/lib/safeDiscovery';

const factory = new Interface(['event ProxyCreation(address indexed proxy,address singleton)']);
/** Read-only pages; candidates are never cached before code and ownership checks. */
export async function discoverSafes(provider: JsonRpcProvider, chain: ChainInfo, owner: string, cursor: DiscoveryCursor): Promise<SafeDiscoveryPage> {
  if (BigInt(await provider.send('eth_chainId', [])) !== BigInt(chain.chainId!)) throw new Error('Wrong Safe network');
  await verifySafeFactory(provider);
  const latest = Number(BigInt(await provider.send('eth_blockNumber', [])));
  const to = cursor.before_block ?? latest;
  let span = cursor.block_span ?? 50_000;
  if (![latest, to, span, cursor.offset].every(n => Number.isSafeInteger(n) && n >= 0) || to > latest || span < 1 || span > 50_000 || cursor.offset > 100_000) throw new Error('Invalid discovery cursor');
  let logs, from;
  for (;;) {
    from = Math.max(0, to - span + 1);
    try {
      logs = await provider.getLogs({address:SAFE_FACTORY,fromBlock:from,toBlock:to,topics:[factory.getEvent('ProxyCreation')!.topicHash]});
      break;
    } catch (e) {
      if (cursor.offset || span <= 500) throw e;
      span = Math.max(500, Math.floor(span / 10));
    }
  }
  logs.sort((a,b) => b.blockNumber-a.blockNumber || b.index-a.index);
  if (cursor.offset > logs.length) throw new Error('Discovery history changed; restart synchronization');
  const end = Math.min(cursor.offset + 5, logs.length), accounts = [];
  let unsupported = 0;
  for (const log of logs.slice(cursor.offset,end)) {
    if (log.removed) continue;
    if (log.address.toLowerCase() !== SAFE_FACTORY || log.blockNumber < from || log.blockNumber > to) throw new Error('Invalid factory log response');
    const event = factory.parseLog(log);
    if (!event) throw new Error('Invalid factory log response');
    try {
      const account = await safeAccount(provider, chain, event.args.proxy);
      if (account.owners.some(a => a.toLowerCase() === owner.toLowerCase())) accounts.push(account);
    } catch (e) {
      // Transport errors stop the scan; do not mistake an outage for an empty list.
      if (e instanceof Error && /contract code mismatch|Invalid Safe account/.test(e.message)) unsupported++;
      else throw e;
    }
  }
  const sameRange = end < logs.length;
  const next = sameRange ? to : from === 0 ? null : from - 1;
  return {accounts,from_block:from,to_block:to,latest_block:latest,next_before_block:next,next_offset:sameRange?end:0,block_span:span,complete:next===null,unsupported};
}
