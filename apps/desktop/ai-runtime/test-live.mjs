#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(runtimeRoot, 'plugins', 'web3-market-mcp.mjs');
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: 'pipe' });
const client = new Client({ name: 'fnzsafe-web3-live-test', version: '0.1.0' });

const cases = [
  ['market_search', { query: 'solana' }],
  ['trending_tokens', {}],
  ['global_market_snapshot', {}],
  ['market_leaders', { limit: 3 }],
  ['market_categories', { limit: 3 }],
  ['token_market_chart', { coinId: 'bitcoin', days: 1 }],
  ['defi_chain_overview', { chain: 'Solana' }],
  ['defi_protocol_search', { query: 'Jupiter', chain: 'Solana', limit: 3 }],
  ['defi_yield_search', { chain: 'Solana', minTvlUsd: 10000000, limit: 3 }],
  ['protocol_fees_overview', { chain: 'Solana', limit: 3 }],
  ['stablecoin_chain_overview', { chain: 'Solana' }],
  ['dex_pair_search', { query: 'SOL USDC' }],
  ['token_risk_snapshot', { address: 'So11111111111111111111111111111111111111112' }],
  ['latest_token_profiles', { chain: 'robinhood', limit: 3 }],
  ['token_security_scan', { address: 'So11111111111111111111111111111111111111112', network: 'solana' }],
  ['token_security_scan', { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', network: '1' }],
  ['crypto_news', { limit: 3 }],
  ['market_sentiment', { days: 2 }],
];

try {
  await client.connect(transport);
  const available = await client.listTools();
  const availableNames = new Set(available.tools.map((tool) => tool.name));
  const results = [];
  for (const [name, args] of cases) {
    if (!availableNames.has(name)) throw new Error(`${name} is not registered`);
    const result = await client.callTool({ name, arguments: args });
    const output = result.content?.find((item) => item.type === 'text')?.text ?? '';
    if (result.isError) throw new Error(`${name} failed: ${output}`);
    let payload;
    try {
      payload = JSON.parse(output);
    } catch (error) {
      throw new Error(`${name} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!payload?.source || !payload?.retrievedAt) throw new Error(`${name} returned no source metadata`);
    results.push({ name, source: payload.source });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, calls: results.length, results })}\n`);
} finally {
  await client.close();
}
