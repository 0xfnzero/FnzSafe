import { ArrowUpRight, History, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PreparedTransaction } from '../evm-transfers';
import { api } from './api';
import { useDialogFocus } from './dialog-focus';
export interface TransactionReview { id: string; kind: string; network: string; chainId: number; transaction?: PreparedTransaction; details: Record<string, unknown> }
export function ReviewDialog({ review, onClose, onDone }: { review: TransactionReview; onClose: () => void; onDone: (result: { hash?: string; proposal?: unknown; address?: string }) => Promise<void> | void }) {
  const [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const ref = useDialogFocus<HTMLFormElement>(() => { if (!busy) onClose(); });
  return <div className="modal-backdrop"><form ref={ref} className="modal transaction-review" role="dialog" aria-modal="true" aria-label="Review transaction" onSubmit={async e => {
    e.preventDefault(); if (!checked) return; setBusy(true); setError('');
    try { const result = await api<{ hash?: string; proposal?: unknown; address?: string }>({ type: 'EXECUTE_REVIEW', id: review.id }); await onDone(result); }
    catch (e) { setError(e instanceof Error ? e.message : 'Transaction failed'); }
    finally { setBusy(false); }
  }}>
    <div className="dialog-icon"><ShieldCheck size={23} /></div><h2>{review.kind === 'safe-sign' ? 'Sign Safe proposal' : 'Confirm transaction'}</h2>
    <dl><dt>Network</dt><dd>{review.network} ({review.chainId})</dd>
      {review.transaction && <><dt>Signing account</dt><dd>{review.transaction.from}</dd><dt>Contract / recipient</dt><dd>{review.transaction.to}</dd><dt>Value (wei)</dt><dd>{review.transaction.value}</dd><dt>Maximum network fee (wei)</dt><dd>{review.transaction.maxFeeWei}</dd><dt>Account nonce</dt><dd>{review.transaction.nonce}</dd></>}
    </dl>
    <h3>Transaction details</h3><pre className="review-data">{JSON.stringify(review.details, null, 2)}</pre>
    {review.transaction?.data !== '0x' && review.transaction && <details><summary>Full transaction calldata</summary><pre className="review-data">{review.transaction.data}</pre></details>}
    {review.kind === 'safe-sign' && <p>Signing authorizes this exact Safe transaction. Any executor can submit it once the threshold is reached.</p>}
    <label className="check-label"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />I reviewed the network, addresses, amount and transaction data.</label>
    {error && <p className="error">{error} Close this review and prepare again.</p>}
    <div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !checked || !!error}>{busy ? 'Submitting...' : review.kind === 'safe-sign' ? 'Confirm signature' : 'Confirm & submit'}</button></div>
  </form></div>;
}
export function ImportToken({ onImported }: { onImported: () => void }) {
  const [address, setAddress] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  return <details className="settings-panel"><summary>Add token by contract</summary><form onSubmit={async e => {
    e.preventDefault(); setBusy(true); setMessage('');
    try { await api({ type: 'IMPORT_TOKEN', address }); setAddress(''); setMessage('Token added'); onImported(); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Token import failed'); }
    finally { setBusy(false); }
  }}><label>ERC-20 contract<input value={address} onChange={e => setAddress(e.target.value)} required /></label><p className="fine-print">Queries the selected RPC directly. Verify the contract address yourself; anyone can create a token with a familiar name.</p><button disabled={busy}>{busy ? 'Querying...' : 'Add token'}</button>{message && <p role="status">{message}</p>}</form></details>;
}
export function ActivityView({ family, context }: { family: string; context: string }) {
  const [records, setRecords] = useState<Array<{ hash: string; kind: string; status: string; createdAt: number }>>([]), [error, setError] = useState('');
  async function load() { try { setRecords(await api({ type: 'GET_ACTIVITY', family })); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load activity'); } }
  useEffect(() => { setRecords([]); setError(''); if (family === 'evm' || family === 'solana') void load(); }, [family, context]);
  return <section className="activity-view"><div className="page-heading"><span className="eyebrow">EVERY MOVE, IN VIEW</span><h2>Activity</h2><p>Your transactions on this account and network.</p></div>{error && <p className="error">{error}</p>}
    {!records.length && <div className="empty"><History size={32} /><strong>A fresh start</strong><span>Your submitted transactions will appear here.</span></div>}
    {records.map(record => <article className="activity-record" key={record.hash}><div className="activity-top"><span className="activity-icon">{record.kind.startsWith('safe') ? <ShieldCheck size={18} /> : <ArrowUpRight size={18} />}</span><div><strong>{record.kind.replaceAll('-', ' ')}</strong><small>{new Date(record.createdAt).toLocaleString()}</small></div><span className={`status-badge ${record.status}`}>{record.status}</span></div><code>{record.hash}</code><button onClick={async () => {
      try { await api({ type: 'REFRESH_ACTIVITY', hash: record.hash }); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Receipt unavailable'); }
    }}>Check receipt</button></article>)}
  </section>;
}
export function EvmSendDialog({ initialToken, tokens, nativeSymbol, onClose, onSent }: { initialToken?: string; tokens: Array<{ address?: string; symbol: string; native: boolean }>; nativeSymbol: string; onClose: () => void; onSent: () => void }) {
  const [token, setToken] = useState(initialToken ?? ''), [recipient, setRecipient] = useState(''), [amount, setAmount] = useState('');
  const [review, setReview] = useState<TransactionReview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const ref = useDialogFocus<HTMLFormElement>(() => { if (!busy) onClose(); }, !review);
  if (review) return <ReviewDialog review={review} onClose={() => setReview(null)} onDone={onSent} />;
  return <div className="modal-backdrop"><form ref={ref} className="modal" role="dialog" aria-modal="true" aria-label="Send asset" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { setReview(await api({ type: 'PREPARE_TRANSFER', token, recipient, amount })); }
    catch (e) { setError(e instanceof Error ? e.message : 'Transfer preview failed'); }
    finally { setBusy(false); }
  }}><h2>Send asset</h2><label>Asset<select value={token} onChange={e => setToken(e.target.value)}><option value="">{nativeSymbol} (native)</option>{tokens.filter(t => !t.native && t.address).map(t => <option key={t.address} value={t.address}>{t.symbol} · {t.address}</option>)}</select></label><label>Recipient<input value={recipient} onChange={e => setRecipient(e.target.value.trim())} required /></label><label>Amount<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required /></label>{error && <p className="error">{error}</p>}<div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Simulating...' : 'Preview transfer'}</button></div></form></div>;
}
