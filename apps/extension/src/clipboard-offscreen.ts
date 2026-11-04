import { SecretClipboard } from './secret-clipboard';

const field = document.querySelector('textarea')!;
// Chrome offscreen documents are unfocused, so use the permission-backed DOM
// clipboard commands rather than the focus-gated async Clipboard API.
const clipboard = new SecretClipboard({
  async readText() {
    field.value = ''; field.focus(); field.select();
    if (!document.execCommand('paste')) throw new Error('Clipboard read permission unavailable');
    const value = field.value; field.value = ''; return value;
  },
  async writeText(value) {
    field.value = value; field.focus(); field.select();
    try { if (!document.execCommand('copy')) throw new Error('Clipboard write permission unavailable'); }
    finally { field.value = ''; }
  },
}, () => { void chrome.runtime.sendMessage({ type: 'CLIPBOARD_CLEANUP_FAILED' }).catch(() => undefined); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'secret-clipboard') return false;
  const action = message.action === 'copy' && typeof message.value === 'string' ? clipboard.copy(message.value)
    : message.action === 'clear' ? clipboard.clear() : Promise.reject(new Error('Invalid clipboard action'));
  void action.then(() => respond({ ok: true }), () => respond({ ok: false, error: 'Clipboard cleanup unavailable. Clear the clipboard manually.' }));
  return true;
});
