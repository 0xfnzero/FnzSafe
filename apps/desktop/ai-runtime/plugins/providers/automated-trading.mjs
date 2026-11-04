import { jsonContent, requiredText } from '../lib/web3-utils.mjs';

const REQUEST_TIMEOUT_MS = 20_000;

function runtimeConfig() {
  const rawUrl = String(process.env.FNZSAFE_WALLET_API_URL ?? '').trim();
  const apiToken = String(process.env.FNZSAFE_WALLET_API_TOKEN ?? '').trim();
  if (!rawUrl || !apiToken) throw new Error('wallet automation is unavailable in this runtime');
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
    throw new Error('wallet automation API endpoint is invalid');
  }
  return { baseUrl: url.href.replace(/\/+$/u, ''), apiToken };
}

async function apiRequest(path) {
  const { baseUrl, apiToken } = runtimeConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      Accept: 'application/json',
      Origin: 'tauri://localhost',
      'X-Fnzero-Safe-Token': apiToken,
    };
    const response = await fetch(`${baseUrl}/${path.replace(/^\/+|\/+$/gu, '')}`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(result.error || `wallet API returned HTTP ${response.status}`));
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`wallet API timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const automatedTradingHandlers = {
  async wallet_session_status(args) {
    const walletId = requiredText(args, 'walletId');
    if (!/^[a-fA-F0-9]{32}$/u.test(walletId)) throw new Error('Invalid wallet ID');
    const status = await apiRequest(`wallets/${walletId}/session`);
    return jsonContent({
      walletId: status.wallet_id,
      publicKey: status.public_key,
      unlocked: status.unlocked === true,
      expiresInSeconds: Number(status.expires_in_seconds || 0),
    });
  },

  async automated_token_sell(args) {
    const walletId = requiredText(args, 'walletId');
    const mint = requiredText(args, 'mint');
    const venue = requiredText(args, 'venue');
    // A model-generated intent is never an approval. Keep this legacy tool name
    // as a proposal-only operation; the runtime's API capability is read-only too.
    return jsonContent({
      status: 'requires_wallet_confirmation',
      submitted: false,
      walletId, mint, venue,
      sellPercentBps: args.sellPercentBps,
      slippageBps: args.slippageBps,
      nextStep: 'Open FnzSafe wallet trading, review the wallet, token, amount and slippage, then confirm there. This proposal has not signed or submitted a transaction.',
    });
  },
};
