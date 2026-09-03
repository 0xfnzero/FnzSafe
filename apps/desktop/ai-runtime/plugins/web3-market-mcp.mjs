#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateToolArguments } from './lib/web3-utils.mjs';
import {
  validateWeb3MarketRegistry,
  web3MarketHandlers,
  web3MarketTools,
} from './web3-market-tools.mjs';

const registryStatus = validateWeb3MarketRegistry();

if (process.argv.includes('--self-test')) {
  process.stdout.write(`${JSON.stringify({ ...registryStatus, tools: web3MarketTools.map((tool) => tool.name) })}\n`);
  if (!registryStatus.ok) process.exitCode = 1;
} else {
  if (!registryStatus.ok) throw new Error(`invalid Web3 tool registry: ${JSON.stringify(registryStatus)}`);

  const toolsByName = new Map(web3MarketTools.map((tool) => [tool.name, tool]));
  const server = new Server({ name: 'fnzsafe-web3-market', version: '0.3.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: web3MarketTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const tool = toolsByName.get(request.params.name);
      if (!tool) throw new Error(`unknown tool: ${request.params.name}`);
      const args = validateToolArguments(tool.inputSchema, request.params.arguments);
      return await web3MarketHandlers[tool.name](args);
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  await server.connect(new StdioServerTransport());
}
