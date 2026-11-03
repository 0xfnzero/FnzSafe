import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Fingerprint, LoaderCircle, ShieldCheck } from 'lucide-react';
import { createWalletPasskey, unlockWithPasskey } from '../passkey';
import { PASSKEY_WINDOW_PORT, type PasskeyRequest } from '../passkey-window';
import { t, useLocale } from './i18n';
import { ThemeControl } from './theme';

function PasskeyWindow() {
  useLocale();
  const [request, setRequest] = useState<PasskeyRequest | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const port = useRef<chrome.runtime.Port | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    const connection = chrome.runtime.connect({ name: PASSKEY_WINDOW_PORT });
    port.current = connection;
    connection.onMessage.addListener(message => { setRequest(message); setError(''); });
    connection.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port.current = null; operation.current?.abort(); setRequest(null);
      setError('Passkey request expired. Return to your wallet and try again.');
    });
    return () => { operation.current?.abort(); connection.disconnect(); port.current = null; };
  }, []);
  async function verify() {
    if (!request || !port.current || operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError('');
    try {
      const result = request.mode === 'create' ? await createWalletPasskey(controller.signal)
        : { password: await unlockWithPasskey(request.config, controller.signal) };
      if (!controller.signal.aborted) port.current?.postMessage({ result });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Passkey verification was cancelled. You can try again.'
        : e instanceof Error ? e.message : 'Passkey verification failed');
    } finally { operation.current = null; setBusy(false); }
  }
  function cancel() {
    operation.current?.abort();
    if (port.current) port.current.postMessage({ error: true });
    else window.close();
  }
  return <main className="passkey-shell">
    <header className="brand"><span className="brand-mark"><ShieldCheck size={20} /></span><strong>FnzSafe</strong><ThemeControl /></header>
    <section className="passkey-card">
      <div className="onboarding-symbol"><Fingerprint size={36} /></div>
      <h1>{request?.mode === 'create' ? t('Set up Passkey') : t('Verify Passkey')}</h1>
      <p>{t('Continue here to open your browser’s Passkey prompt. This window will close after verification and your wallet will continue automatically.')}</p>
      {request?.mode === 'create' && <p className="fine-print">{t('Your browser will ask you to create a Passkey, then verify it once.')}</p>}
      {error && <p role="alert" className="error">{t(error)}</p>}
      {busy && <p className="passkey-progress" role="status"><LoaderCircle size={18} className="spin" />{t('Complete the Passkey prompt in your browser.')}</p>}
      <button className="primary" onClick={() => void verify()} disabled={!request || busy}>{busy ? t('Verifying…') : t('Continue with Passkey')}</button>
      <button className="secondary-wide" onClick={cancel}>{t('Cancel')}</button>
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<PasskeyWindow />);
