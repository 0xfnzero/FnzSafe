"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Send,
  WalletCards,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { atomicToDecimalUnits, decimalToAtomicUnits } from "@/lib/multichain";

export interface WalletChainAddress {
  id: string;
  family: "solana" | "evm" | "bitcoin" | "tron";
  chainId?: number;
  networkId?: string;
  chainName: string;
  symbol: string;
  address: string;
  logoUri?: string;
  testnet?: boolean;
  derivationPath?: string;
}

export interface UnifiedWalletAsset {
  id: string;
  family: "solana" | "evm" | "bitcoin" | "tron";
  chainId?: number;
  networkId?: string;
  chainName: string;
  chainSymbol: string;
  symbol: string;
  name: string;
  balance: string;
  rawBalance: string;
  decimals: number;
  tokenAddress?: string;
  logoUri?: string;
  tracked: boolean;
  loading?: boolean;
  testnet?: boolean;
  derivationPath?: string;
}

export interface WalletRecipientOption {
  id: string;
  name: string;
  address: string;
  current: boolean;
}

export interface UnifiedWalletLabels {
  accountAddresses: string;
  allNetworks: string;
  allAssets: string;
  addAndContinue: string;
  addingAsset: string;
  addAsset: string;
  assetDetails: string;
  assetName: string;
  assetSymbol: string;
  address: string;
  back: string;
  close: string;
  contractHint: string;
  copy: string;
  copied: string;
  current: string;
  decimals: string;
  chainFamily: string;
  network: string;
  nativeAsset: string;
  networks: string;
  noEvmNetworks: string;
  noAssets: string;
  noAddresses: string;
  qrCode: string;
  qrFailed: string;
  receiveAddress: string;
  receiveNetworkWarning: string;
  sharedNetworkWarning: string;
  refresh: string;
  searchAssets: string;
  searchEmpty: string;
  selectAsset: string;
  send: string;
  testnet: string;
  tracked: string;
  tokenAddress: string;
  untracked: string;
  recipient: string;
  amount: string;
  available: string;
  previewSend: string;
  previewing: string;
  confirmSend: string;
  sending: string;
  minerFee: string;
  feeRate: string;
  change: string;
  inputs: string;
  rbfEnabled: string;
  bandwidth: string;
  accountActivation: string;
  activated: string;
  notActivated: string;
  estimatedMaxFee: string;
  transactionId: string;
  sendSuccess: string;
  sendFailed: string;
  previewFailed: string;
  reviewWarning: string;
  chooseWallet: string;
  chooseRecipientWallet: string;
  noRecipientWallets: string;
}

type CopyHandler = (value: string, id: string) => void;

function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function chainGlyph(address: WalletChainAddress | UnifiedWalletAsset): string {
  if (address.family === "solana") return "S";
  if (address.family === "bitcoin") return "BTC";
  if (address.family === "tron") return "TRX";
  return address.symbol.slice(0, 2).toUpperCase();
}

function ChainMark({ item, large = false }: { item: WalletChainAddress | UnifiedWalletAsset; large?: boolean }) {
  const logoUri = "logoUri" in item ? item.logoUri : undefined;
  const [failedLogoUri, setFailedLogoUri] = useState<string | null>(null);
  const showLogo = Boolean(logoUri && failedLogoUri !== logoUri);
  const logoPadding = logoUri?.startsWith("/chain-icons/") ? "" : "p-1.5";
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white text-xs font-bold text-black ${
        large ? "h-14 w-14" : "h-10 w-10"
      }`}
      aria-hidden="true"
    >
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element -- token logos are local or validated metadata URLs.
        <img
          src={logoUri}
          alt=""
          className={`h-full w-full object-contain ${logoPadding}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedLogoUri(logoUri || null)}
        />
      ) : (
        chainGlyph(item)
      )}
    </span>
  );
}

function CopyIcon({ copied }: { copied: boolean }) {
  return copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />;
}

export function RecipientWalletPicker({
  wallets,
  labels,
  onSelect,
  allowCurrent = false,
}: {
  wallets: WalletRecipientOption[];
  labels: Pick<UnifiedWalletLabels, "chooseWallet" | "chooseRecipientWallet" | "noRecipientWallets" | "current" | "close">;
  onSelect: (wallet: WalletRecipientOption) => void;
  allowCurrent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [close, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-controls={open ? dialogId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={labels.chooseWallet}
        title={labels.chooseWallet}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-gray-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60"
      >
        <WalletCards className="h-5 w-5" />
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/65" onMouseDown={close}>
          <section
            id={dialogId}
            role="dialog"
            aria-modal="true"
            aria-label={labels.chooseRecipientWallet}
            className="max-h-[72vh] w-full max-w-2xl overflow-hidden rounded-t-lg border border-b-0 border-white/10 bg-zinc-950 shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <h3 className="text-sm font-semibold text-white">{labels.chooseRecipientWallet}</h3>
              <button
                type="button"
                onClick={close}
                autoFocus
                aria-label={labels.close}
                title={labels.close}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[calc(72vh-4rem)] overflow-y-auto p-2 sm:p-3">
              {wallets.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-500">{labels.noRecipientWallets}</p>
              ) : wallets.map((wallet) => (
                <button
                  key={wallet.id}
                  type="button"
                  disabled={wallet.current && !allowCurrent}
                  aria-current={wallet.current ? "true" : undefined}
                  onClick={() => {
                    onSelect(wallet);
                    close();
                  }}
                  className="flex w-full min-w-0 items-center gap-3 border-b border-white/10 px-2 py-3 text-left last:border-b-0 enabled:hover:bg-white/[0.06] disabled:cursor-default disabled:opacity-65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-300/60"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-white">
                    {wallet.name.trim().slice(0, 2).toUpperCase() || "W"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold text-white">{wallet.name}</span>
                      {wallet.current && (
                        <span className="shrink-0 rounded bg-emerald-400/15 px-2 py-0.5 text-[10px] font-medium text-emerald-200">
                          {labels.current}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block truncate font-mono text-xs text-gray-400" title={wallet.address}>
                      {shortAddress(wallet.address)}
                    </span>
                  </span>
                  {(!wallet.current || allowCurrent) && <ChevronRight className="h-4 w-4 shrink-0 text-gray-500" />}
                </button>
              ))}
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

function hasPositiveBalance(value: string): boolean {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return false;
  return /[1-9]/.test(normalized);
}

function sortUnifiedAssets(assets: UnifiedWalletAsset[], preferredChainId?: string): UnifiedWalletAsset[] {
  return [...assets].sort((a, b) => {
    const aPreferred = Boolean(preferredChainId && a.id.startsWith(`${preferredChainId}:`));
    const bPreferred = Boolean(preferredChainId && b.id.startsWith(`${preferredChainId}:`));
    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    const aPositive = hasPositiveBalance(a.rawBalance);
    const bPositive = hasPositiveBalance(b.rawBalance);
    if (aPositive !== bPositive) return aPositive ? -1 : 1;
    if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
    return a.chainName.localeCompare(b.chainName) || a.symbol.localeCompare(b.symbol);
  });
}

export function WalletAddressPopover({
  addresses,
  copiedId,
  labels,
  onCopy,
  onSelect,
  selectedId,
  trigger,
}: {
  addresses: WalletChainAddress[];
  copiedId: string | null;
  labels: UnifiedWalletLabels;
  onCopy: CopyHandler;
  onSelect: (item: WalletChainAddress) => void;
  selectedId: string;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 0, width: 320 });
  const closeTimerRef = useRef<number | null>(null);
  const pinnedRef = useRef(false);
  const suppressFocusOpenRef = useRef(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();

  const placePopover = useCallback(() => {
    const triggerElement = triggerRef.current;
    if (!triggerElement) return;
    const rect = triggerElement.getBoundingClientRect();
    const width = Math.min(544, Math.max(0, window.innerWidth - 32));
    const left = Math.min(Math.max(16, rect.left), Math.max(16, window.innerWidth - width - 16));
    const estimatedHeight = Math.min(376, 64 + addresses.length * 56);
    const belowTop = rect.bottom + 8;
    const aboveTop = Math.max(16, rect.top - estimatedHeight - 8);
    const top = belowTop + estimatedHeight <= window.innerHeight ? belowTop : aboveTop;
    setPosition({ left, top, width });
  }, [addresses.length]);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    placePopover();
    setOpen(true);
  };
  const scheduleClose = () => {
    if (pinnedRef.current) return;
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 180);
  };
  const togglePinned = () => {
    if (pinnedRef.current) {
      pinnedRef.current = false;
      setOpen(false);
      return;
    }
    pinnedRef.current = true;
    cancelClose();
    window.requestAnimationFrame(() => {
      popoverRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
  };
  const closePopover = (restoreFocus = false) => {
    pinnedRef.current = false;
    setOpen(false);
    if (restoreFocus) {
      suppressFocusOpenRef.current = true;
      triggerRef.current?.focus();
      window.requestAnimationFrame(() => {
        suppressFocusOpenRef.current = false;
      });
    }
  };

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => placePopover();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      closePopover();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePopover(true);
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, placePopover]);

  return (
    <div className="relative shrink-0" onMouseLeave={scheduleClose}>
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={cancelClose}
        onClick={togglePinned}
        onFocus={() => {
          if (!suppressFocusOpenRef.current) cancelClose();
        }}
        onBlur={scheduleClose}
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60"
        title={labels.accountAddresses}
        aria-label={labels.accountAddresses}
      >
        {trigger}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label={labels.accountAddresses}
          style={position}
          className="fixed z-[90] overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-2xl shadow-black/60"
          onFocus={cancelClose}
          onBlur={scheduleClose}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <p className="text-sm font-semibold text-white">{labels.accountAddresses}</p>
            <button
              type="button"
              onClick={() => closePopover(true)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-white/10 hover:text-white"
              aria-label={labels.close}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            {addresses.map((item) => {
              const copyId = `wallet-address-popover:${item.id}`;
              const selected = item.id === selectedId;
              return (
                <div
                  key={item.id}
                  className={`flex min-w-0 items-center rounded-lg transition-colors ${
                    selected ? "bg-emerald-400/10 ring-1 ring-inset ring-emerald-300/30" : "hover:bg-white/[0.06]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(item)}
                    aria-pressed={selected}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-300/60"
                  >
                    <ChainMark item={item} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-sm font-semibold text-white">{item.chainName}</p>
                        {item.testnet && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-200">{labels.testnet}</span>}
                        {selected && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-200">
                            <Check className="h-3 w-3" />
                            {labels.current}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-gray-400" title={item.address}>{shortAddress(item.address)}</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => onCopy(item.address, copyId)}
                    className="mr-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60"
                    title={copiedId === copyId ? labels.copied : labels.copy}
                    aria-label={`${copiedId === copyId ? labels.copied : labels.copy} ${item.chainName}`}
                  >
                    <CopyIcon copied={copiedId === copyId} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export function WalletReceivePanel({
  addresses,
  copiedId,
  labels,
  onCopy,
}: {
  addresses: WalletChainAddress[];
  copiedId: string | null;
  labels: UnifiedWalletLabels;
  onCopy: CopyHandler;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const addressGroups = useMemo(
    () => addresses.map((item) => ({ primary: item, items: [item] })),
    [addresses],
  );
  const selectedGroup = selectedId
    ? addressGroups.find((group) => group.primary.id === selectedId) ?? null
    : null;
  const selected = selectedGroup?.primary ?? null;
  const selectedAddress = selected?.address;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !selectedAddress) return;
    let cancelled = false;
    setQrFailed(false);
    void QRCode.toCanvas(canvas, selectedAddress, {
      width: 260,
      margin: 2,
      color: { dark: "#09090b", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).catch(() => {
      if (!cancelled) setQrFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedAddress]);

  if (selected) {
    const copyId = `wallet-receive:${selected.id}`;
    const displayName = selected.chainName;
    return (
      <div className="mx-auto max-w-xl space-y-6">
        <button
          type="button"
          onClick={() => setSelectedId(null)}
          className="inline-flex h-9 items-center gap-2 rounded-lg px-2 text-sm text-gray-300 hover:bg-white/10 hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" />
          {labels.back}
        </button>
        <div className="text-center">
          <div className="mx-auto flex w-fit items-center gap-3">
            <ChainMark item={selected} />
            <div className="text-left">
              <h3 className="text-xl font-semibold text-white">{displayName}</h3>
              <p className="text-sm text-gray-400">
                {labels.receiveAddress}
              </p>
            </div>
          </div>
          <div className={`mx-auto mt-6 w-fit rounded-lg bg-white p-3 ${qrFailed ? "hidden" : ""}`}>
            <canvas ref={canvasRef} role="img" className="block aspect-square h-auto w-[260px] max-w-[calc(100vw-5rem)]" aria-label={`${displayName} ${labels.qrCode}`} />
          </div>
          {qrFailed && (
            <p className="mx-auto mt-6 max-w-sm rounded-lg border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-100">
              {labels.qrFailed}
            </p>
          )}
        </div>
        <div className="overflow-hidden rounded-lg border border-white/10 bg-black/30">
          <p className="break-all px-4 py-4 text-center font-mono text-sm text-gray-100">{selected.address}</p>
          <button
            type="button"
            onClick={() => onCopy(selected.address, copyId)}
            className="flex h-12 w-full items-center justify-center gap-2 border-t border-white/10 text-sm font-semibold text-gray-200 hover:bg-white/10"
          >
            <CopyIcon copied={copiedId === copyId} />
            {copiedId === copyId ? labels.copied : labels.copy}
          </button>
        </div>
        <p className="text-center text-sm text-amber-200/90">
          {labels.network}: {displayName}
        </p>
        <p className="text-center text-xs text-gray-500">
          {labels.receiveNetworkWarning}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {addressGroups.length === 0 && (
        <p className="py-10 text-center text-sm text-gray-500">{labels.noAddresses}</p>
      )}
      {addressGroups.map(({ primary: item }) => {
        const copyId = `wallet-receive-list:${item.id}`;
        const displayName = item.chainName;
        return (
          <div key={item.id} className="flex min-w-0 items-center gap-3 border-b border-white/10 px-1 py-3 last:border-b-0 lg:rounded-lg lg:border lg:bg-white/[0.04] lg:px-4">
            <ChainMark item={item} large />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate font-semibold text-white">{displayName}</p>
                {item.testnet && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-200">{labels.testnet}</span>}
              </div>
              <p className="mt-0.5 truncate font-mono text-sm text-gray-400" title={item.address}>{shortAddress(item.address)}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedId(item.id)}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/5 text-gray-200 hover:bg-white/10"
              aria-label={`${displayName} ${labels.qrCode}`}
              title={labels.qrCode}
            >
              <QrCode className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => onCopy(item.address, copyId)}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/5 text-gray-200 hover:bg-white/10"
              aria-label={`${copiedId === copyId ? labels.copied : labels.copy} ${displayName}`}
              title={copiedId === copyId ? labels.copied : labels.copy}
            >
              <CopyIcon copied={copiedId === copyId} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function AssetRow({ asset, labels, onSelect }: { asset: UnifiedWalletAsset; labels: UnifiedWalletLabels; onSelect?: (asset: UnifiedWalletAsset) => void }) {
  const showAssetName = asset.name !== asset.chainName && asset.name !== asset.symbol;
  const content = (
    <>
      <ChainMark item={asset} large />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="truncate font-semibold text-white">{asset.symbol}</p>
          <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-gray-300">{asset.chainName}</span>
          {asset.testnet && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-200">{labels.testnet}</span>}
        </div>
        {showAssetName && <p className="mt-1 truncate text-sm text-gray-400">{asset.name}</p>}
        {asset.tokenAddress && <p className="mt-0.5 truncate font-mono text-[11px] text-gray-600">{shortAddress(asset.tokenAddress)}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="max-w-32 truncate text-sm font-semibold text-white" title={asset.balance}>
          {asset.loading ? "--" : asset.balance}
        </p>
        <p className="mt-1 text-xs text-gray-500">{asset.tracked ? labels.tracked : labels.untracked}</p>
      </div>
      {onSelect && <ChevronRight className="h-4 w-4 shrink-0 text-gray-500" />}
    </>
  );
  const className = "flex w-full min-w-0 items-center gap-3 border-b border-white/10 px-1 py-3 text-left transition-colors last:border-b-0 lg:rounded-lg lg:border lg:bg-white/[0.04] lg:px-4 lg:last:border-b";
  if (!onSelect) return <div className={className}>{content}</div>;
  return (
    <button
      type="button"
      onClick={() => onSelect(asset)}
      className={`${className} hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/50`}
    >
      {content}
    </button>
  );
}

export function UnifiedAssetList({
  assets,
  error,
  labels,
  onAddAsset,
  onSelect,
  preferredChainId,
  refreshing,
  onRefresh,
  showHeader = true,
}: {
  assets: UnifiedWalletAsset[];
  error?: string | null;
  labels: UnifiedWalletLabels;
  onAddAsset?: () => void;
  onSelect?: (asset: UnifiedWalletAsset) => void;
  preferredChainId?: string;
  refreshing: boolean;
  onRefresh: () => void;
  showHeader?: boolean;
}) {
  const sortedAssets = useMemo(() => sortUnifiedAssets(assets, preferredChainId), [assets, preferredChainId]);
  return (
    <section className="space-y-3">
      {showHeader && (
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-gray-200">{labels.allAssets}</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-white/10 px-3 text-xs text-gray-200 hover:bg-white/15 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              {labels.refresh}
            </button>
            {onAddAsset && (
              <button
                type="button"
                onClick={onAddAsset}
                aria-label={labels.addAsset}
                title={labels.addAsset}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-gray-100 hover:bg-white/10"
              >
                <Plus className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="status" className="rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-sm text-amber-100">
          {error}
        </p>
      )}
      <div className="space-y-2">
        {sortedAssets.map((asset) => <AssetRow key={asset.id} asset={asset} labels={labels} onSelect={onSelect} />)}
        {sortedAssets.length === 0 && <p className="py-8 text-center text-sm text-gray-500">{labels.noAssets}</p>}
      </div>
    </section>
  );
}

export function WalletAssetDetailPanel({
  asset,
  copied,
  labels,
  onCopy,
  onSend,
}: {
  asset: UnifiedWalletAsset;
  copied: boolean;
  labels: UnifiedWalletLabels;
  onCopy: (value: string, id: string) => void;
  onSend: (asset: UnifiedWalletAsset) => void;
}) {
  const tokenAddressLabel = asset.family === "solana" ? "Mint" : labels.tokenAddress;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <section className="flex items-center gap-4 border-y border-white/10 py-5">
        <ChainMark item={asset} large />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-semibold text-white">{asset.symbol}</h3>
            <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-gray-300">{asset.chainName}</span>
          </div>
          <p className="mt-1 text-sm text-gray-400">{asset.name}</p>
        </div>
        <div className="min-w-0 text-right">
          <p className="text-xs text-gray-500">{labels.available}</p>
          <p className="mt-1 max-w-48 truncate text-lg font-semibold text-white" title={asset.balance}>
            {asset.loading ? "--" : asset.balance} {asset.symbol}
          </p>
        </div>
      </section>

      <dl aria-label={labels.assetDetails} className="divide-y divide-white/10 border-y border-white/10">
        {[
          [labels.assetName, asset.name],
          [labels.assetSymbol, asset.symbol],
          [labels.decimals, String(asset.decimals)],
          [labels.network, asset.chainName],
        ].map(([label, value]) => (
          <div key={label} className="grid gap-1 py-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-gray-500">{label}</dt>
            <dd className="break-words text-gray-100 sm:text-right">{value}</dd>
          </div>
        ))}
        <div className="grid gap-2 py-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-start">
          <dt className="text-gray-500">{tokenAddressLabel}</dt>
          {asset.tokenAddress ? (
            <dd className="flex min-w-0 items-start justify-between gap-2 sm:justify-end">
              <span className="break-all font-mono text-xs leading-5 text-gray-100">{asset.tokenAddress}</span>
              <button
                type="button"
                onClick={() => onCopy(asset.tokenAddress || "", `asset-detail:${asset.id}`)}
                aria-label={copied ? labels.copied : labels.copy}
                title={copied ? labels.copied : labels.copy}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-300 hover:bg-white/10 hover:text-white"
              >
                <CopyIcon copied={copied} />
              </button>
            </dd>
          ) : (
            <dd className="text-gray-300 sm:text-right">{labels.nativeAsset}</dd>
          )}
        </div>
      </dl>

      <button
        type="button"
        onClick={() => onSend(asset)}
        disabled={asset.loading}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-black hover:bg-gray-200 disabled:opacity-50 sm:w-auto"
      >
        <Send className="h-4 w-4" />
        {labels.send}
      </button>
    </div>
  );
}

interface NativeChainSendPreview {
  preview_id: string;
  chain_id: string;
  family: "bitcoin" | "tron";
  sender: string;
  recipient: string;
  amount_atomic: string;
  fee_atomic: string;
  fee_rate_sat_vb?: number;
  change_atomic?: string;
  input_count?: number;
  output_count?: number;
  rbf?: boolean;
  estimated_bandwidth_bytes?: string;
  bandwidth_available?: string;
  recipient_activated?: boolean;
  account_activation_fee_atomic?: string;
}

function isAtomicUnitString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isNativeChainPreview(
  value: unknown,
  expected: { family: "bitcoin" | "tron"; networkId: string; sender: string; recipient: string; amountAtomic: string },
): value is NativeChainSendPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preview = value as Partial<NativeChainSendPreview>;
  if (
    typeof preview.preview_id !== "string"
    || preview.preview_id.length < 16
    || preview.chain_id !== expected.networkId
    || preview.family !== expected.family
    || preview.sender !== expected.sender
    || preview.recipient !== expected.recipient
    || preview.amount_atomic !== expected.amountAtomic
    || !isAtomicUnitString(preview.fee_atomic)
  ) return false;
  if (expected.family === "bitcoin") {
    return typeof preview.fee_rate_sat_vb === "number"
      && Number.isFinite(preview.fee_rate_sat_vb)
      && preview.fee_rate_sat_vb > 0
      && isAtomicUnitString(preview.change_atomic)
      && Number.isSafeInteger(preview.input_count)
      && Number(preview.input_count) > 0
      && Number.isSafeInteger(preview.output_count)
      && Number(preview.output_count) > 0
      && typeof preview.rbf === "boolean";
  }
  return isAtomicUnitString(preview.estimated_bandwidth_bytes)
    && isAtomicUnitString(preview.bandwidth_available)
    && typeof preview.recipient_activated === "boolean"
    && isAtomicUnitString(preview.account_activation_fee_atomic);
}

export function NativeChainSendPanel({
  asset,
  sender,
  walletId,
  recipientWallets,
  labels,
  onSubmitted,
}: {
  asset: UnifiedWalletAsset;
  sender: string;
  walletId: string;
  recipientWallets: WalletRecipientOption[];
  labels: UnifiedWalletLabels;
  onSubmitted: () => void;
}) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<NativeChainSendPreview | null>(null);
  const [transactionId, setTransactionId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"preview" | "submit" | null>(null);
  const busyRef = useRef(false);
  const requestIdRef = useRef(0);
  const networkId = asset.networkId || "";
  const family = asset.family === "bitcoin" || asset.family === "tron" ? asset.family : null;
  const amountAtomic = decimalToAtomicUnits(amount, asset.decimals);

  useEffect(() => {
    requestIdRef.current += 1;
    busyRef.current = false;
    setBusy(null);
    setPreview(null);
    setTransactionId("");
    setError("");
  }, [asset.id, asset.derivationPath, sender, walletId]);

  const updateRecipient = (value: string) => {
    requestIdRef.current += 1;
    busyRef.current = false;
    setBusy(null);
    setRecipient(value);
    setPreview(null);
    setTransactionId("");
    setError("");
  };
  const updateAmount = (value: string) => {
    requestIdRef.current += 1;
    busyRef.current = false;
    setBusy(null);
    setAmount(value);
    setPreview(null);
    setTransactionId("");
    setError("");
  };

  const request = async (mode: "preview" | "submit") => {
    if (busyRef.current || !family || !networkId || !amountAtomic || amountAtomic === "0" || !recipient.trim()) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    busyRef.current = true;
    setBusy(mode);
    setError("");
    try {
      const body: Record<string, unknown> = {
        chain_id: networkId,
        sender,
        recipient: recipient.trim(),
        amount_atomic: amountAtomic,
        derivation_path: asset.derivationPath,
      };
      if (mode === "submit") {
        body.preview_id = preview?.preview_id;
      }
      const response = await apiFetch(
        `wallets/${encodeURIComponent(walletId)}/${family}/send/${mode}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await response.json();
      if (requestIdRef.current !== requestId) return;
      if (!response.ok) throw new Error(data?.error || (mode === "preview" ? labels.previewFailed : labels.sendFailed));
      if (mode === "preview") {
        if (!isNativeChainPreview(data, {
          family,
          networkId,
          sender,
          recipient: recipient.trim(),
          amountAtomic,
        })) {
          throw new Error(labels.previewFailed);
        }
        setPreview(data);
      } else {
        if (
          data?.chain_id !== networkId
          || data?.status !== "submitted"
          || typeof data?.transaction_id !== "string"
          || !data.transaction_id
        ) throw new Error(labels.sendFailed);
        setTransactionId(data.transaction_id);
        setPreview(null);
        onSubmitted();
      }
    } catch (cause) {
      if (requestIdRef.current !== requestId) return;
      setError(cause instanceof Error ? cause.message : mode === "preview" ? labels.previewFailed : labels.sendFailed);
    } finally {
      if (requestIdRef.current === requestId) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  };

  if (!family || !networkId) return null;
  const formattedFee = preview ? atomicToDecimalUnits(preview.fee_atomic, asset.decimals) : "--";
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center gap-3 border-b border-white/10 pb-4">
        <ChainMark item={asset} large />
        <div className="min-w-0">
          <p className="text-lg font-semibold text-white">{asset.symbol} · {asset.chainName}</p>
          <p className="mt-1 text-sm text-gray-400">{labels.available}: {asset.balance} {asset.symbol}</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 text-sm text-gray-300 sm:col-span-2">
          <label htmlFor="native-chain-recipient">{labels.recipient}</label>
          <span className="flex min-w-0 gap-2">
            <input
              id="native-chain-recipient"
              value={recipient}
              onChange={(event) => updateRecipient(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={family === "bitcoin" ? "bc1..." : "T..."}
              className="h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 font-mono text-sm text-white outline-none focus:ring-2 focus:ring-emerald-400/30"
            />
            <RecipientWalletPicker wallets={recipientWallets} labels={labels} onSelect={(wallet) => updateRecipient(wallet.address)} />
          </span>
        </div>
        <label className="space-y-1.5 text-sm text-gray-300 sm:col-span-2">
          {labels.amount} ({asset.symbol})
          <input
            value={amount}
            onChange={(event) => updateAmount(event.target.value)}
            inputMode="decimal"
            placeholder="0"
            className="h-11 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-400/30"
          />
        </label>
      </div>
      {!preview && !transactionId && (
        <button
          type="button"
          onClick={() => void request("preview")}
          disabled={busy !== null || !recipient.trim() || !amountAtomic || amountAtomic === "0"}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-black hover:bg-gray-200 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${busy === "preview" ? "animate-spin" : ""}`} />
          {busy === "preview" ? labels.previewing : labels.previewSend}
        </button>
      )}
      {preview && (
        <div className="space-y-4 border-y border-white/10 py-4">
          <p className="text-sm text-amber-100">{labels.reviewWarning}</p>
          <dl className="grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="text-gray-500">{labels.amount}</dt><dd className="mt-1 text-white">{amount} {asset.symbol}</dd></div>
            <div><dt className="text-gray-500">{family === "bitcoin" ? labels.minerFee : labels.estimatedMaxFee}</dt><dd className="mt-1 text-white">{formattedFee} {asset.symbol}</dd></div>
            {family === "bitcoin" && (
              <>
                <div><dt className="text-gray-500">{labels.feeRate}</dt><dd className="mt-1 text-white">{preview.fee_rate_sat_vb} sat/vB</dd></div>
                <div><dt className="text-gray-500">{labels.inputs}</dt><dd className="mt-1 text-white">{preview.input_count} / {preview.output_count}</dd></div>
                <div><dt className="text-gray-500">{labels.change}</dt><dd className="mt-1 text-white">{atomicToDecimalUnits(preview.change_atomic || "0", asset.decimals)} BTC</dd></div>
                <div><dt className="text-gray-500">RBF</dt><dd className="mt-1 text-white">{preview.rbf ? labels.rbfEnabled : "-"}</dd></div>
              </>
            )}
            {family === "tron" && (
              <>
                <div><dt className="text-gray-500">{labels.bandwidth}</dt><dd className="mt-1 text-white">{preview.estimated_bandwidth_bytes} / {preview.bandwidth_available}</dd></div>
                <div><dt className="text-gray-500">{labels.accountActivation}</dt><dd className="mt-1 text-white">{preview.recipient_activated ? labels.activated : `${labels.notActivated} (+${atomicToDecimalUnits(preview.account_activation_fee_atomic || "0", asset.decimals)} TRX)`}</dd></div>
              </>
            )}
          </dl>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void request("submit")}
              disabled={busy !== null}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-black hover:bg-emerald-400 disabled:opacity-50"
            >
              <Check className="h-4 w-4" />
              {busy === "submit" ? labels.sending : labels.confirmSend}
            </button>
            <button type="button" onClick={() => setPreview(null)} disabled={busy !== null} className="h-11 rounded-lg border border-white/10 px-4 text-sm text-gray-200 hover:bg-white/10 disabled:opacity-50">
              {labels.back}
            </button>
          </div>
        </div>
      )}
      {transactionId && (
        <div className="border-y border-emerald-300/20 bg-emerald-300/[0.04] py-4">
          <p className="font-semibold text-emerald-100">{labels.sendSuccess}</p>
          <p className="mt-2 text-xs text-gray-400">{labels.transactionId}</p>
          <p className="mt-1 break-all font-mono text-sm text-white">{transactionId}</p>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    </div>
  );
}

export function WalletSendAssetPicker({
  assets,
  preferredChainId,
  preferredFamily,
  evmChains,
  labels,
  onAddEvmContract,
  onSelect,
}: {
  assets: UnifiedWalletAsset[];
  preferredChainId?: string;
  preferredFamily?: "solana" | "evm" | "bitcoin" | "tron";
  evmChains: Array<{ chainId: number; name: string }>;
  labels: UnifiedWalletLabels;
  onAddEvmContract: (chainId: number, contract: string) => Promise<void>;
  onSelect: (asset: UnifiedWalletAsset) => void;
}) {
  const [query, setQuery] = useState("");
  const [familyFilter, setFamilyFilter] = useState<"all" | "solana" | "evm" | "bitcoin" | "tron">(preferredFamily ?? "all");
  const [chainId, setChainId] = useState(() => String(evmChains[0]?.chainId || ""));
  const [adding, setAdding] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const normalized = query.trim().toLowerCase();
  const isContract = /^0x[0-9a-f]{40}$/.test(normalized);
  const filtered = useMemo(() => {
    const ranked = sortUnifiedAssets(assets, preferredChainId)
      .filter((asset) => familyFilter === "all" || asset.family === familyFilter);
    if (!normalized) return ranked.filter((asset) => asset.tracked);
    return ranked.filter((asset) => [asset.symbol, asset.name, asset.chainName, asset.tokenAddress]
      .some((value) => value?.toLowerCase().includes(normalized)));
  }, [assets, familyFilter, normalized, preferredChainId]);

  useEffect(() => {
    if (!evmChains.some((chain) => String(chain.chainId) === chainId)) {
      setChainId(String(evmChains[0]?.chainId || ""));
    }
  }, [chainId, evmChains]);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const addContract = async () => {
    const parsedChainId = Number(chainId);
    if (!isContract || !Number.isSafeInteger(parsedChainId)) return;
    setAdding(true);
    try {
      await onAddEvmContract(parsedChainId, query.trim());
    } catch {
      // The parent reports the lookup failure through the app's toast system.
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-1">
        {[
          { id: "solana" as const, label: "Solana" },
          { id: "evm" as const, label: "EVM" },
          { id: "bitcoin" as const, label: "Bitcoin" },
          { id: "tron" as const, label: "TRON" },
          { id: "all" as const, label: labels.allNetworks },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFamilyFilter(item.id)}
            className={`h-8 rounded-md px-3 text-xs font-semibold transition-colors ${
              familyFilter === item.id ? "bg-white text-black" : "text-gray-300 hover:bg-white/10 hover:text-white"
            }`}
            aria-pressed={familyFilter === item.id}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" />
        <input
          ref={searchInputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isContract && chainId && !adding) {
              event.preventDefault();
              void addContract();
            }
          }}
          placeholder={labels.searchAssets}
          aria-label={labels.searchAssets}
          className="h-12 w-full rounded-lg border border-white/10 bg-black/30 pl-11 pr-3 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-400/30"
        />
      </div>

      {isContract && (
        <div className="grid gap-2 rounded-lg border border-emerald-300/20 bg-emerald-300/[0.06] p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-emerald-100">{labels.contractHint}</p>
            <div className="mt-2 flex min-w-0 items-center gap-2">
              <label className="shrink-0 text-xs text-gray-400">{labels.network}</label>
              <select
                value={chainId}
                onChange={(event) => setChainId(event.target.value)}
                className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-2 text-sm text-white outline-none"
              >
                {evmChains.map((chain) => <option key={chain.chainId} value={chain.chainId}>{chain.name}</option>)}
              </select>
            </div>
            {evmChains.length === 0 && <p className="mt-2 text-xs text-amber-200">{labels.noEvmNetworks}</p>}
          </div>
          <button
            type="button"
            onClick={() => void addContract()}
            disabled={adding || !chainId}
            className="inline-flex h-10 items-center justify-center gap-2 self-end rounded-lg bg-white px-3 text-sm font-semibold text-black hover:bg-gray-200 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {adding ? labels.addingAsset : labels.addAndContinue}
          </button>
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((asset) => <AssetRow key={asset.id} asset={asset} labels={labels} onSelect={onSelect} />)}
        {filtered.length === 0 && !isContract && <p className="py-10 text-center text-sm text-gray-500">{labels.searchEmpty}</p>}
      </div>
    </div>
  );
}
