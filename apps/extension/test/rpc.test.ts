import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { evmChain } from '../src/chains';
import { configuredChain, evmProvider, normalizeRpcOverrides, normalizeRpcUrl, validateRpc } from '../src/rpc';

test('RPC settings reject unsafe schemes, credentials and fragments; preserve valid API keys', () => {
  for (const url of ['file:///tmp/wallet', 'javascript:alert(1)', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/#key', 'http://127.0.0.1.evil.test']) assert.throws(() => normalizeRpcUrl(url));
  assert.equal(normalizeRpcUrl(' https://example.com/rpc?key=fixture '), 'https://example.com/rpc?key=fixture');
  assert.equal(normalizeRpcUrl('http://127.0.0.1:8545'), 'http://127.0.0.1:8545/');
  assert.deepEqual(normalizeRpcOverrides({ 'evm:1': 'file:///tmp', 'evm:999': 'https://rpc.example' }), {});
  assert.equal(configuredChain(evmChain(1), {}).rpcUrl, evmChain(1).rpcUrl);
});
test('RPC validates actual endpoint chain/cluster, rejects redirects and redacts provider errors', async () => {
  let mode = 'matching'; let calls = 0;
  const server = createServer(async (request, response) => {
    calls++; let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    if (mode === 'redirect') { response.writeHead(302, { location: '/other' }); response.end(); return; }
    response.setHeader('content-type', 'application/json');
    const result = mode === 'solana' ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1' : mode === 'wrong' ? '0x38' : '0x1';
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...(body.method === 'eth_getBalance' ? { error: { code: -32000, message: 'secret-fixture https://provider.example/api-key' } } : { result }) }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/secret-fixture`;
  const chain = { ...evmChain(1), rpcUrl: url };
  try {
    await validateRpc(chain);
    const provider = await evmProvider(chain);
    await assert.rejects(provider.getBalance('0x' + '11'.repeat(20)), e => { assert.ok(!String(e).includes('secret-fixture')); return true; }); provider.destroy();
    mode = 'wrong'; await assert.rejects(validateRpc(chain), /verification failed/);
    mode = 'redirect'; const before = calls; await assert.rejects(validateRpc(chain)); assert.equal(calls, before + 1);
    mode = 'solana'; await validateRpc({ ...chain, family: 'solana', key: 'solana:devnet' });
    await assert.rejects(validateRpc({ ...chain, family: 'solana', key: 'solana:mainnet-beta' }));
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
