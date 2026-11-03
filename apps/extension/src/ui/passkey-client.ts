import { validatePasskeyConfig, type PasskeyConfig } from '../passkey';
import { PASSKEY_CALLER_PORT, passkeyWindowBounds, type PasskeyRequest, type PasskeyResult } from '../passkey-window';

let active = false;
function requestPasskey(request: PasskeyRequest): Promise<PasskeyResult> {
  if (active) return Promise.reject(new Error('Passkey verification is already in progress'));
  active = true;
  return new Promise<PasskeyResult>((resolve, reject) => {
    const port = chrome.runtime.connect({ name: PASSKEY_CALLER_PORT });
    let settled = false;
    const finish = (result?: PasskeyResult, error?: string) => {
      if (settled) return;
      settled = true; clearInterval(heartbeat); clearTimeout(timeout); port.disconnect();
      window.removeEventListener('pagehide', cancel);
      if (result) resolve(result); else reject(new Error(error || 'Passkey verification was cancelled'));
    };
    const cancel = () => finish();
    const heartbeat = setInterval(() => {
      try { port.postMessage({ type: 'ping' }); } catch { finish(); }
    }, 20000);
    const timeout = setTimeout(() => finish(undefined, 'Passkey verification timed out'), 185000);
    window.addEventListener('pagehide', cancel, { once: true });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; finish(); });
    port.onMessage.addListener(message => {
      if (message?.error) finish(undefined, message.error);
      else if (/^[a-f0-9]{64}$/.test(message?.result?.password ?? '')) finish(message.result);
      else finish(undefined, 'Invalid Passkey response');
    });
    try { port.postMessage({ ...request, bounds: passkeyWindowBounds(window.screen) }); }
    catch { finish(undefined, 'Unable to open Passkey window'); }
  }).finally(() => { active = false; });
}
export async function unlockWithPasskey(config: PasskeyConfig): Promise<string> {
  const validated = validatePasskeyConfig(config, location.hostname);
  return (await requestPasskey({ mode: 'unlock', config: validated })).password;
}
export async function createWalletPasskey(): Promise<{ config: PasskeyConfig; password: string }> {
  const result = await requestPasskey({ mode: 'create' });
  return { password: result.password, config: validatePasskeyConfig(result.config, location.hostname) };
}
