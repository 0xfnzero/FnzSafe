import { ThemeControl, ThemeSettings } from './theme';
import { SafeView } from './safe-view';
import { ActivityView, EvmSendDialog, ImportToken } from './transactions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownLeft,
  History,
  Eye,
  EyeOff,
  ArrowUpRight,
  Check,
  Copy,
  Globe2,
  Lock,
  RefreshCw,
  Settings,
  ShieldCheck,
  WalletCards,
  X,
} from 'lucide-react';
import { ImportFields, RecoverySettings, RpcSettings, emptyImport } from './wallet-settings';
import type { ChainFamily, ChainInfo, PortfolioSnapshot } from '../types';
import { api, compact, type WalletStatus } from './api';

function Popup() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setStatus(await api<WalletStatus>({ type: 'STATUS' }));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Keep the worker alive while the wallet UI is open; this does not extend the inactivity lock.
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  if (!status) return <Shell><Loading error={error} /></Shell>;
  if (!status.initialized) {
    return <Shell><CreateWallet onComplete={refresh} /></Shell>;
  }
  if (status.locked) return <Shell><Unlock onComplete={refresh} /></Shell>;
  return <WalletHome status={status} refresh={refresh} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="shell">
    <header className="brand">
      <span className="brand-mark"><ShieldCheck size={20} strokeWidth={2.2} /></span><strong>FnzSafe<span className="brand-caption">YOUR WEB3 COMPANION</span></strong>
      <ThemeControl />
    </header>
    {children}
  </main>;
}

function Loading({ error }: { error: string }) {
  return <section className="center-state">
    <RefreshCw className="spin" /><p>{error || 'Loading wallet...'}</p>
  </section>;
}

function CreateWallet({ onComplete }: { onComplete: () => Promise<void> }) {
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [walletImport, setWalletImport] = useState(emptyImport);
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      const result = await api<{ recoveryMnemonic: string }>({
        type: 'CREATE_VAULT',
        password,
        ...(mode === 'import' ? { import: walletImport } : {}),
      });
      if (mode === 'create') setRecoveryPhrase(result.recoveryMnemonic);
      else { setWalletImport(emptyImport()); await onComplete(); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setPassword('');
      setConfirm('');
    }
  }

  if (recoveryPhrase) {
    return <section className="onboarding recovery">
      <ShieldCheck size={44} /><h1>Back up your wallet</h1>
      <p>Write these words down in order and keep them offline. FnzSafe cannot recover them for you.</p>
      <div className="recovery-grid">
        {recoveryPhrase.split(' ').map((word, index) => <span key={`${word}-${index}`}><small>{index + 1}</small>{word}</span>)}
      </div>
      <button className="primary" onClick={() => void onComplete()}>I saved it offline</button>
      <p className="error">Never share this phrase or enter it on a website.</p>
    </section>;
  }

  return <section className="onboarding">
    <div className="onboarding-symbol"><WalletCards size={34} /></div>
    <span className="eyebrow">YOUR KEYS. YOUR WORLD.</span>
    <h1>{mode === 'create' ? 'A wallet of your own' : 'Welcome to FnzSafe'}</h1>
    <p>One home for your crypto. Create a wallet or bring your existing accounts with you.</p>
    <div className="mode-tabs">
      <button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>Create</button>
      <button className={mode === 'import' ? 'active' : ''} onClick={() => setMode('import')}>Import</button>
    </div>
    <form onSubmit={submit}>
      {mode === 'import' && <ImportFields value={walletImport} onChange={setWalletImport} />}
      <label>Wallet password<input type="password" minLength={10} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <label>Confirm password<input type="password" minLength={10} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></label>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Working...' : mode === 'create' ? 'Create wallet' : 'Import wallet'}</button>
    </form>
    <p className="fine-print">Keys stay encrypted in Chrome storage. The password is never sent to a server.</p>
  </section>;
}

function Unlock({ onComplete }: { onComplete: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api({ type: 'UNLOCK', password });
      await onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setPassword('');
    }
  }

  return <section className="onboarding">
    <div className="onboarding-symbol"><Lock size={32} /></div><span className="eyebrow">SECURE BY YOU</span><h1>Welcome back</h1>
    <p>Your wallet is locked. Enter your password to pick up where you left off.</p>
    <form onSubmit={submit}>
      <label>Wallet password<input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Unlocking...' : 'Unlock'}</button>
    </form>
  </section>;
}

function WalletHome({ status, refresh }: { status: WalletStatus; refresh: () => Promise<void> }) {
  const [family, setFamily] = useState<ChainFamily>(() => status.accounts.find(account => account.id === status.settings.activeAccountId)?.family ?? status.accounts[0]?.family ?? 'evm');
  const [tab, setTab] = useState<'wallet' | 'activity' | 'safe' | 'settings'>('wallet');
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null);
  const [portfolioError, setPortfolioError] = useState('');
  const [sendOpen, setSendOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [balanceHidden, setBalanceHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  async function copyAddress() {
    if (!account) return;
    try { await navigator.clipboard.writeText(account.address); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  }
  const accounts = status.accounts.filter((account) => account.family === family);
  const account = accounts.find((item) => item.id === status.settings.activeAccountId) ?? accounts[0];
  const selectedChain = useMemo(
    () => status.chains.find((chain) => chain.family === family && (
      family === 'evm'
        ? chain.chainId === status.settings.evmChainId
        : family === 'solana'
          ? chain.key.endsWith(status.settings.solanaCluster)
          : true
    )),
    [family, status],
  );

  const portfolioRequest = useRef(0);
  const refreshPortfolio = useCallback(async (force = false) => {
    const requestId = ++portfolioRequest.current;
    setPortfolio(null);
    setPortfolioError('');
    try {
      const snapshot = await api<PortfolioSnapshot>({ type: 'GET_PORTFOLIO', family, force });
      if (requestId === portfolioRequest.current) { setPortfolio(snapshot); setPortfolioError(''); }
    } catch (reason) {
      if (requestId === portfolioRequest.current) setPortfolioError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [family, account?.id, selectedChain?.key, selectedChain?.rpcUrl, status.settings.enhancedAssetDetection]);

  useEffect(() => {
    void refreshPortfolio(false);
    return () => { portfolioRequest.current++; };
  }, [refreshPortfolio]);

  const nativeBalance = portfolio?.assets.find((asset) => asset.native);
  const totalUsd = portfolio?.assets.reduce((total, asset) => total + (asset.valueUsd ?? 0), 0) ?? 0;

  async function changeChain(chain: ChainInfo) {
    await api({ type: 'SET_NETWORK', key: chain.key });
    await refresh();
  }

  async function changeAccount(accountId: string) {
    await api({ type: 'SET_ACTIVE_ACCOUNT', accountId });
    await refresh();
  }

  async function lock() {
    await api({ type: 'LOCK' });
    await refresh();
  }

  return <Shell>
    <div className="context-row">
      <select aria-label="Chain" value={family} onChange={(event) => setFamily(event.target.value as ChainFamily)}>
        <option value="evm">EVM</option><option value="solana">Solana</option>
        <option value="bitcoin">Bitcoin</option><option value="tron">TRON</option>
      </select>
      <select aria-label="Network" value={selectedChain?.key ?? ''} onChange={(event) => {
        const chain = status.chains.find((item) => item.key === event.target.value);
        if (chain) void changeChain(chain);
      }}>
        {status.chains.filter((chain) => chain.family === family).map((chain) => <option key={chain.key} value={chain.key}>{chain.name}</option>)}
      </select>
      <button className="icon-button" title="Lock wallet" onClick={lock}><Lock size={18} /></button>
    </div>
    {tab === 'wallet' && <section className="wallet-view">
      <div className="account-card">
        <span className="account-avatar"><img alt="" src={`chain-icons/${selectedChain?.icon ?? 'ethereum.svg'}`} /></span>
        <div>{accounts.length > 1 ? (
          <select aria-label="Account" value={account?.id ?? ''} onChange={(event) => void changeAccount(event.target.value)}>
            {accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        ) : <strong>{account?.name ?? `${selectedChain?.name ?? family} account`}</strong>}
          <button className="address" disabled={!account} onClick={() => void copyAddress()}>
            {copied ? 'Address copied' : account ? compact(account.address) : 'Not available'} {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>
      <div className="balance">
        <div className="balance-caption"><span>{totalUsd > 0 ? 'Estimated value' : 'Native balance'}</span><button className="balance-visibility" aria-label={balanceHidden ? 'Show balances' : 'Hide balances'} onClick={() => setBalanceHidden(!balanceHidden)}>{balanceHidden ? <EyeOff size={15} /> : <Eye size={15} />}</button><span className="network-badge"><i />{selectedChain?.name}</span></div>
        <strong className={totalUsd > 0 ? '' : 'native-total'}>{balanceHidden ? '••••••' : totalUsd > 0 ? formatUsd(totalUsd) : nativeBalance ? compactAmount(nativeBalance.balance) : '—'}</strong>
        <small>{balanceHidden ? 'Balances hidden' : nativeBalance ? `${compactAmount(nativeBalance.balance)} ${nativeBalance.symbol}` : 'Your assets, in one place'}</small>
        {!balanceHidden && totalUsd > 0 && portfolio?.assets.some(asset => asset.valueUsd === undefined) && <span className="valuation-note">Some assets have no price available</span>}
      </div>
      {(family === 'bitcoin' || family === 'tron') && <div className="notice"><ShieldCheck size={18} /><span>Address support is visible, but signing and broadcast remain disabled until the native implementation is complete.</span></div>}
      <div className="actions">
        <Action icon={<ArrowUpRight />} label="Send" disabled={!selectedChain?.transactionSupport || !account} onClick={() => setSendOpen(true)} />
        <Action icon={<ArrowDownLeft />} label="Receive" disabled={!account} onClick={() => setReceiveOpen(true)} />
        <Action
          icon={<Globe2 />}
          label="DApps"
          disabled={family !== 'evm' && family !== 'solana'}
          onClick={() => chrome.tabs.create({
            url: family === 'solana' ? 'https://jup.ag' : 'https://app.uniswap.org',
          })}
        />
      </div>
      <div className="section-title"><strong>Tokens <span className="count-badge">{portfolio?.assets.length ?? 0}</span></strong><button className="icon-button" title="Refresh assets" onClick={() => void refreshPortfolio(true)}><RefreshCw size={16} /></button></div>
      {portfolioError && <p className="error">{portfolioError}</p>}
      {portfolio?.warnings.map((warning) => <p className="asset-warning" key={warning}>{warning}</p>)}
      {!portfolio && !portfolioError && <div className="empty"><RefreshCw className="spin" size={24} /><span>Loading balances...</span></div>}
      {portfolio && portfolio.assets.length === 0 && <div className="empty"><WalletCards size={28} /><span>No assets found on this network</span></div>}
      {portfolio && <div className="asset-list">
        {portfolio.assets.map((asset) => <div className={`asset-row${asset.risk === 'spam' ? ' risky' : ''}`} key={asset.id}>
          <span className={`asset-symbol ${asset.native ? 'native' : ''}`}>{asset.native ? <img alt="" src={`chain-icons/${selectedChain?.icon ?? 'ethereum.svg'}`} /> : asset.symbol.slice(0, 2)}</span>
          <span><strong>{asset.symbol}</strong><small>{asset.risk === 'spam' ? `Potential spam - ${asset.name}` : asset.name}</small></span>
          <span className="asset-amount"><strong>{balanceHidden ? '••••' : compactAmount(asset.balance)}</strong><small>{balanceHidden ? '••••' : asset.valueUsd !== undefined ? formatUsd(asset.valueUsd) : 'Price unavailable'}</small></span>
        </div>)}
      </div>}
      {family === 'evm' && account && <ImportToken onImported={() => void refreshPortfolio(true)} />}
      {portfolio && !portfolio.enhancedDetection && (family === 'evm' || family === 'solana') && <p className="privacy-hint">Automatic token discovery is off. Native assets and manually imported tokens are queried.</p>}
    </section>}
    {tab === 'activity' && <ActivityView family={family} context={`${selectedChain?.key}:${account?.id}`} />}
    {tab === 'safe' && (family === 'evm' ? <SafeView key={`${selectedChain?.key}:${account?.id}:${selectedChain?.rpcUrl}`} chainId={status.settings.evmChainId} accountId={account?.id} /> : <div className="empty-page"><ShieldCheck size={36} /><h2>Shared control</h2><p>Switch to an EVM network to manage your Safe multisig wallets.</p></div>)}
    {tab === 'settings' && <SettingsView status={status} onLock={lock} onRefresh={refresh} />}
    <nav>
      <button className={tab === 'wallet' ? 'active' : ''} onClick={() => setTab('wallet')}><WalletCards />Wallet</button>
      <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}><History />Activity</button>
      <button className={tab === 'safe' ? 'active' : ''} onClick={() => setTab('safe')}><ShieldCheck />Multisig</button>
      <button className={tab === 'settings' ? 'active' : ''} onClick={() => {
        setTab('settings');
        void refresh();
      }}><Settings />Settings</button>
    </nav>
    {receiveOpen && account && <div className="modal-backdrop"><section className="modal receive-modal" role="dialog" aria-modal="true" aria-label="Receive assets"><div className="dialog-heading"><span className="dialog-icon"><ArrowDownLeft size={22} /></span><button className="icon-button" aria-label="Close receive" onClick={() => setReceiveOpen(false)}><X size={18} /></button></div><h2>Receive {selectedChain?.symbol}</h2><p>Use this address on <strong>{selectedChain?.name}</strong>.</p><div className="receive-address">{account.address}</div><p className="fine-print">Make sure the sender uses the correct network.</p><button className="primary" onClick={() => void copyAddress()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Address copied' : 'Copy address'}</button></section></div>}
    {sendOpen && account && selectedChain && (family === 'evm' ? <EvmSendDialog tokens={portfolio?.assets ?? []} nativeSymbol={selectedChain.symbol} onClose={() => setSendOpen(false)} onSent={() => { setSendOpen(false); void refreshPortfolio(true); }} /> : <SendDialog accountId={account.id} family={family} chain={selectedChain} onClose={() => setSendOpen(false)} onSent={() => { setSendOpen(false); void refreshPortfolio(true); }} />)}
  </Shell>;
}

function Action({ icon, label, disabled, onClick }: { icon: React.ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return <button disabled={disabled} onClick={onClick}><span>{icon}</span>{label}</button>;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);
}

function compactAmount(value: string): string {
  if (value === '--') return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value.slice(0, 18);
  return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 }).format(numeric);
}

function SendDialog({ accountId, family, chain, onClose, onSent }: { accountId: string; family: ChainFamily; chain: ChainInfo; onClose: () => void; onSent: () => void }) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!confirming) return setConfirming(true);
    setBusy(true);
    try {
      const result = await api<{ signature: string }>({ type: 'SEND_NATIVE', family, recipient, amount, accountId, chainKey: chain.key });
      window.alert(`Submitted\n${result.signature}`);
      onSent();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-label="Send native asset" onSubmit={submit}>
    <h2>{confirming ? 'Confirm transfer' : `Send ${chain.symbol}`}</h2>
    {confirming ? <dl><dt>Network</dt><dd>{chain.name}</dd><dt>Recipient</dt><dd>{recipient}</dd><dt>Amount</dt><dd>{amount} {chain.symbol}</dd></dl> : <><label>Recipient<input value={recipient} onChange={(event) => setRecipient(event.target.value.trim())} required /></label><label>Amount<input type="number" min="0" step="any" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label></>}
    {error && <p className="error">{error}</p>}
    <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Submitting...' : confirming ? 'Confirm' : 'Review'}</button></div>
  </form></div>;
}

function SettingsView({ status, onLock, onRefresh }: { status: WalletStatus; onLock: () => void; onRefresh: () => Promise<void> }) {
  return <section className="settings-view"><div className="page-heading"><span className="eyebrow">YOUR WALLET, YOUR WAY</span><h2>Settings</h2><p>A little more personal. Just as secure.</p></div><ThemeSettings /><h3 className="group-label">Security & privacy</h3><div className="settings-list">
    <button onClick={onLock}><Lock /><span><strong>Lock wallet</strong><small>Clear decrypted keys from memory</small></span></button>
    <div><ShieldCheck /><span><strong>Auto-lock</strong><small>Five minutes of inactivity</small></span><span className="status-dot" /></div>

    <button onClick={async () => {
      await api({ type: 'SET_ENHANCED_ASSET_DETECTION', enabled: !status.settings.enhancedAssetDetection });
      await onRefresh();
    }}><WalletCards /><span><strong>Enhanced token detection</strong><small>{status.settings.enhancedAssetDetection ? 'On by default - public addresses may be sent to configured index services' : 'Off - native assets and manually imported tokens only'}</small></span>{status.settings.enhancedAssetDetection ? <Check /> : null}</button>
    <div><Globe2 /><span><strong>Connected sites</strong><small>{status.connectedSites.length === 0 ? 'No sites currently authorized' : `${status.connectedSites.length} authorized`}</small></span></div>
    {status.connectedSites.map((site) => <button key={site.origin} onClick={async () => {
      await api({ type: 'REVOKE_PERMISSION', origin: site.origin });
      await onRefresh();
    }}><span><strong>{new URL(site.origin).hostname}</strong><small>{site.families.join(' + ').toUpperCase()} - {site.accountCount} account - {site.networkCount} network</small></span><X aria-label={`Disconnect ${new URL(site.origin).hostname}`} /></button>)}
    {status.connectedSites.length > 1 && <button className="danger-action" onClick={async () => { await api({ type: 'CLEAR_PERMISSIONS' }); await onRefresh(); }}><X /><span><strong>Disconnect all sites</strong><small>Revoke every DApp connection</small></span></button>}
  </div><RpcSettings status={status} onRefresh={onRefresh} /><RecoverySettings onRefresh={onRefresh} /></section>;
}

createRoot(document.getElementById('root')!).render(<Popup />);
