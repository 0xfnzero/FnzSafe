import { jsonContent, requiredText } from '../lib/web3-utils.mjs';

const SECURE_BODY_VERSION = '1';
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

function pemToBytes(pem) {
  const base64 = String(pem).replace(/-----[^-]+-----/gu, '').replace(/\s+/gu, '');
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

async function encryptBody(publicKeyPem, value) {
  const publicKey = await crypto.subtle.importKey(
    'spki',
    pemToBytes(publicKeyPem),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const rawKey = await crypto.subtle.exportKey('raw', aesKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const encryptedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey);
  return JSON.stringify({
    version: 1,
    encrypted_key: Buffer.from(encryptedKey).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64'),
  });
}

async function apiRequest(path, { method = 'GET', body } = {}) {
  const { baseUrl, apiToken } = runtimeConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      Accept: 'application/json',
      Origin: 'tauri://localhost',
      'X-Fnzero-Safe-Token': apiToken,
    };
    let requestBody;
    if (body !== undefined) {
      const secureSession = await fetch(`${baseUrl}/secure/session`, { signal: controller.signal });
      if (!secureSession.ok) throw new Error(`wallet API session returned HTTP ${secureSession.status}`);
      const session = await secureSession.json();
      requestBody = await encryptBody(session.public_key_pem, body);
      headers['Content-Type'] = 'application/json';
      headers['X-Fnzero-Safe-Secure-Body'] = SECURE_BODY_VERSION;
    }
    const response = await fetch(`${baseUrl}/${path.replace(/^\/+|\/+$/gu, '')}`, {
      method,
      headers,
      body: requestBody,
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
    const result = await apiRequest('automation/token/sell', {
      method: 'POST',
      body: {
        request_id: crypto.randomUUID(),
        wallet_id: walletId,
        mint,
        venue,
        sell_percent_bps: args.sellPercentBps,
        slippage_bps: args.slippageBps,
        expires_at_ms: Date.now() + 60_000,
      },
    });
    return jsonContent({
      status: result.status,
      signature: result.signature,
      dex: result.dex,
      market: result.market,
      soldRawAmount: result.sold_raw_amount,
      decimals: result.decimals,
      sourceAccount: result.source_account,
    });
  },
};
