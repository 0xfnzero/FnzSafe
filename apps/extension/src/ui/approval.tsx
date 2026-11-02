import { ThemeControl } from './theme';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Lock, ShieldCheck, X } from 'lucide-react';
import type { ApprovalView } from '../types';
import { api } from './api';

function Approval() {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  const [view, setView] = useState<ApprovalView | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<ApprovalView>({ type: 'GET_PENDING', id })
      .then(setView)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    const timer = setInterval(() => { void api<{ locked: boolean }>({ type: 'SESSION_STATUS' }).then(status => { if (status.locked) setView(previous => previous ? { ...previous, locked: true } : previous); }); }, 15000);
    return () => clearInterval(timer);
  }, [id]);

  async function decide(approved: boolean) {
    setBusy(true);
    try {
      if (approved && view?.locked) {
        await api({ type: 'UNLOCK', password });
        setPassword('');
        setView(await api<ApprovalView>({ type: 'GET_PENDING', id }));
        setBusy(false);
        return;
      }
      await api({ type: 'RESOLVE_PENDING', id, approved });
      window.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
      setPassword('');
    }
  }

  return <main className="approval-shell">
    <header className="brand"><span className="brand-mark"><ShieldCheck size={20} /></span><strong>FnzSafe<span className="brand-caption">SECURE CONFIRMATION</span></strong><ThemeControl /></header>
    {!view ? <section className="center-state">{error ? <><X /><p className="error">{error}</p></> : <p>Loading request...</p>}</section> : <>
      <section className="approval-heading"><span className="site-icon">{new URL(view.origin).hostname.slice(0, 1).toUpperCase()}</span><h1>{view.summary}</h1><p>{new URL(view.origin).hostname}</p></section>
      <section className="request-details">{view.details.map((detail) => <div key={detail.label}><span>{detail.label}</span><strong>{detail.value}</strong></div>)}</section>
      {view.warnings.map((warning) => <div className="warning" key={warning}><AlertTriangle size={18} /><span>{warning}</span></div>)}
      {view.locked && <label className="unlock-field"><span><Lock size={16} /> Unlock to approve</span><input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>}
      {error && <p className="error panel-error">{error}</p>}
      <footer className="approval-actions"><button disabled={busy} onClick={() => void decide(false)}>Reject</button><button className="primary" disabled={busy || view.blocking || (view.locked && !password)} onClick={() => void decide(true)}>{busy ? 'Processing...' : view.blocking ? 'Blocked' : view.locked ? 'Unlock & review' : 'Approve'}</button></footer>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Approval />);
