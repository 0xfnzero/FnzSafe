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
  }, [id]);

  async function decide(approved: boolean) {
    setBusy(true);
    try {
      await api({ type: 'RESOLVE_PENDING', id, approved, password });
      window.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
      setPassword('');
    }
  }

  return <main className="approval-shell">
    <header className="brand"><span className="brand-mark">F</span><strong>FnzSafe confirmation</strong><ShieldCheck size={18} /></header>
    {!view ? <section className="center-state">{error ? <><X /><p className="error">{error}</p></> : <p>Loading request...</p>}</section> : <>
      <section className="approval-heading"><span className="site-icon">{new URL(view.origin).hostname.slice(0, 1).toUpperCase()}</span><h1>{view.summary}</h1><p>{new URL(view.origin).hostname}</p></section>
      <section className="request-details">{view.details.map((detail) => <div key={detail.label}><span>{detail.label}</span><strong>{detail.value}</strong></div>)}</section>
      {view.warnings.map((warning) => <div className="warning" key={warning}><AlertTriangle size={18} /><span>{warning}</span></div>)}
      {view.locked && <label className="unlock-field"><span><Lock size={16} /> Unlock to approve</span><input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>}
      {error && <p className="error panel-error">{error}</p>}
      <footer className="approval-actions"><button disabled={busy} onClick={() => void decide(false)}>Reject</button><button className="primary" disabled={busy || view.blocking || (view.locked && !password)} onClick={() => void decide(true)}>{busy ? 'Processing...' : view.blocking ? 'Blocked' : 'Approve'}</button></footer>
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Approval />);
