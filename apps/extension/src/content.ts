import type { ProviderRequest } from './types';
import { validateProviderRequest } from './provider-security';

let port = chrome.runtime.connect({ name: 'fnzsafe-provider' });

function bindPort(next: chrome.runtime.Port): void {
  port = next;
  port.onMessage.addListener((response) => {
    window.postMessage({ channel: 'fnzsafe:provider', direction: 'response', ...response }, location.origin);
  });
  port.onDisconnect.addListener(() => {
    window.setTimeout(() => bindPort(chrome.runtime.connect({ name: 'fnzsafe-provider' })), 250);
  });
}

bindPort(port);

window.addEventListener('message', (event: MessageEvent<ProviderRequest & { direction?: string }>) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (message?.channel !== 'fnzsafe:provider' || message.direction !== 'request') return;
  try {
    port.postMessage(validateProviderRequest({
      id: message.id,
      channel: message.channel,
      family: message.family,
      method: message.method,
      params: message.params,
    }));
  } catch (error) {
    const id = typeof message.id === 'string' ? message.id.slice(0, 128) : '';
    window.postMessage({
      channel: 'fnzsafe:provider',
      direction: 'response',
      id,
      error: { code: -32600, message: error instanceof Error ? error.message : 'Invalid provider request' },
    }, location.origin);
  }
});
