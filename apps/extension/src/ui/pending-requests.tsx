import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api } from './api';
import { t } from './i18n';

interface Request { id: string; origin: string; method: string; processing: boolean }
function requestLabel(method: string): string {
  if (['eth_requestAccounts', 'solana_connect'].includes(method)) return t('Connect wallet');
  if (['wallet_switchEthereumChain', 'wallet_addEthereumChain'].includes(method)) return t('Switch network');
  if (['personal_sign', 'eth_signTypedData_v4', 'solana_signMessage'].includes(method)) return t('Sign message');
  return t('Transaction request');
}
export function PendingRequests() {
  const [requests, setRequests] = useState<Request[]>([]), [error, setError] = useState('');
  const [opening, setOpening] = useState('');
  useEffect(() => {
    let live = true, fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try { const next = await api<Request[]>({ type: 'GET_PENDING_REQUESTS' }); if (live) setRequests(next); }
      catch { /* Keep the last known requests during a transient worker interruption. */ }
      finally { fetching = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    window.addEventListener('focus', refresh);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  if (!requests.length) return null;
  return <details className="pending-requests" open>
    <summary><span className="request-count">{requests.length}</span>{t('Pending requests')}</summary>
    {requests.map(request => <div key={request.id} className="pending-request">
      <div><strong title={request.origin}>{request.origin}</strong><small>{requestLabel(request.method)}</small></div>
      <button disabled={request.processing || !!opening} onClick={async () => {
        setOpening(request.id); setError('');
        try { await api({ type: 'FOCUS_PENDING', id: request.id }); }
        catch (e) { setError(e instanceof Error ? e.message : 'Unable to open request'); }
        finally { setOpening(''); }
      }}>{request.processing || opening === request.id ? <LoaderCircle size={14} className="spin" /> : null}{t(request.processing ? 'Processing…' : 'Review')}</button>
    </div>)}
    {error && <p className="error" role="alert">{t(error)}</p>}
  </details>;
}
