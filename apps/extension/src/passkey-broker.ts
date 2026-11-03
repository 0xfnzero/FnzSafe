import { validatePasskeyConfig } from './passkey';
import { PASSKEY_CALLER_PORT, PASSKEY_WINDOW_PORT, type PasskeyRequest, type PasskeyResult } from './passkey-window';

/** One-use, in-memory relay. No keys, PRF output or configuration in URLs/storage. */
export function registerPasskeyWindows() {
  type Flow = { caller: chrome.runtime.Port; child?: chrome.runtime.Port; request: PasskeyRequest;
    window: Promise<chrome.windows.Window>; timer: ReturnType<typeof setTimeout>; done: boolean };
  const flows = new Map<string, Flow>();
  const trusted = (port: chrome.runtime.Port, page: string) => port.sender?.id === chrome.runtime.id &&
    port.sender.url?.split('?')[0] === chrome.runtime.getURL(page);
  function finish(id: string, reply: { result?: PasskeyResult; error?: string }) {
    const flow = flows.get(id);
    if (!flow || flow.done) return;
    flow.done = true; flows.delete(id); clearTimeout(flow.timer);
    try { flow.caller.postMessage(reply); } catch { /* caller was closed */ }
    flow.caller.disconnect(); flow.child?.disconnect();
    void flow.window.then(w => w.id === undefined ? undefined : chrome.windows.remove(w.id)).catch(() => undefined);
  }
  chrome.runtime.onConnect.addListener(port => {
    if (port.name === PASSKEY_CALLER_PORT) {
      if (!trusted(port, 'popup.html') && !trusted(port, 'approval.html')) { port.disconnect(); return; }
      let id: string | undefined;
      let disconnected = false;
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError; disconnected = true;
        if (id) finish(id, { error: 'Passkey verification was cancelled' });
      });
      port.onMessage.addListener(message => {
        if (message?.type === 'ping' || id || disconnected) return;
        try {
          if (flows.size >= 8) throw new Error('Passkey verification is already in progress');
          const request: PasskeyRequest = message?.mode === 'create' ? { mode: 'create' }
            : message?.mode === 'unlock' ? { mode: 'unlock', config: validatePasskeyConfig(message.config, chrome.runtime.id) }
            : (() => { throw new Error('Invalid Passkey request'); })();
          const bounds = message.bounds;
          if (!bounds || !['left', 'top', 'width', 'height'].every(k => Number.isSafeInteger(bounds[k])) ||
              bounds.width < 1 || bounds.width > 1200 || bounds.height < 1 || bounds.height > 1200 ||
              Math.abs(bounds.left) > 100000 || Math.abs(bounds.top) > 100000) throw new Error('Invalid Passkey window bounds');
          id = crypto.randomUUID();
          const flowId = id;
          const popup = chrome.windows.create({ url: chrome.runtime.getURL(`passkey.html?request=${id}`),
            type: 'popup', focused: true, width: bounds.width, height: bounds.height, left: bounds.left, top: bounds.top });
          flows.set(id, { caller: port, request, window: popup, done: false,
            timer: setTimeout(() => finish(flowId, { error: 'Passkey verification timed out' }), 180000) });
          void popup.catch(() => finish(flowId, { error: 'Unable to open Passkey window' }));
        } catch (error) {
          port.postMessage({ error: error instanceof Error ? error.message : 'Invalid Passkey request' }); port.disconnect();
        }
      });
    } else if (port.name === PASSKEY_WINDOW_PORT) {
      if (!trusted(port, 'passkey.html')) { port.disconnect(); return; }
      const id = new URL(port.sender!.url!).searchParams.get('request') ?? '';
      const flow = flows.get(id);
      if (!flow) { port.disconnect(); return; }
      let disconnected = false;
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError; disconnected = true;
        if (flow.child === port) finish(id, { error: 'Passkey verification was cancelled' });
      });
      void flow.window.then(w => {
        if (disconnected || flow.done || flow.child || w.id === undefined || port.sender?.tab?.windowId !== w.id) {
          port.disconnect(); return;
        }
        flow.child = port;
        port.onMessage.addListener(message => {
          if (flow.done || message?.type === 'ping') return;
          try {
            if (message?.error) { finish(id, { error: 'Passkey verification was cancelled' }); return; }
            if (!/^[a-f0-9]{64}$/.test(message?.result?.password ?? '')) throw new Error('Invalid Passkey response');
            const result: PasskeyResult = { password: message.result.password };
            if (flow.request.mode === 'create') result.config = validatePasskeyConfig(message.result.config, chrome.runtime.id);
            finish(id, { result });
          } catch { finish(id, { error: 'Invalid Passkey response' }); }
        });
        port.postMessage(flow.request);
      }).catch(() => port.disconnect());
    }
  });
  chrome.windows.onRemoved.addListener(windowId => {
    for (const [id, flow] of flows) void flow.window.then(w => {
      if (w.id === windowId) finish(id, { error: 'Passkey verification was cancelled' });
    }).catch(() => undefined);
  });
}
