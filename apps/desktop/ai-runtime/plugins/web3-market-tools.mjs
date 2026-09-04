import { coingeckoHandlers } from './providers/coingecko.mjs';
import { defillamaHandlers } from './providers/defillama.mjs';
import { dexSecurityHandlers } from './providers/dex-security.mjs';
import { newsSentimentHandlers } from './providers/news-sentiment.mjs';
import { automatedTradingHandlers } from './providers/automated-trading.mjs';
import { web3MarketTools } from './web3-market-definitions.mjs';

export { web3MarketTools };

export const web3MarketHandlers = {
  ...automatedTradingHandlers,
  ...coingeckoHandlers,
  ...defillamaHandlers,
  ...dexSecurityHandlers,
  ...newsSentimentHandlers,
};

export function validateWeb3MarketRegistry() {
  const names = web3MarketTools.map((tool) => tool.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  const missingHandlers = names.filter((name) => typeof web3MarketHandlers[name] !== 'function');
  const orphanHandlers = Object.keys(web3MarketHandlers).filter((name) => !names.includes(name));
  return { ok: duplicates.length === 0 && missingHandlers.length === 0 && orphanHandlers.length === 0, duplicates, missingHandlers, orphanHandlers };
}
