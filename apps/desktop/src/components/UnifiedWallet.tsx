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
  X,
} from "lucide-react";

export interface WalletChainAddress {
  id: string;
  family: "solana" | "evm";
  chainId?: number;
  chainName: string;
  symbol: string;
  address: string;
  logoUri?: string;
  testnet?: boolean;
}

export interface UnifiedWalletAsset {
  id: string;
  family: "solana" | "evm";
  chainId?: number;
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
}

export interface UnifiedWalletLabels {
  accountAddresses: string;
  allAssets: string;
  addAndContinue: string;
  addingAsset: string;
  address: string;
  back: string;
  close: string;
  contractHint: string;
  copy: string;
  copied: string;
  current: string;
  network: string;
  noEvmNetworks: string;
  noAssets: string;
  noAddresses: string;
  qrCode: string;
  qrFailed: string;
  receiveAddress: string;
  receiveNetworkWarning: string;
  refresh: string;
  searchAssets: string;
  searchEmpty: string;
  selectAsset: string;
  send: string;
  testnet: string;
  tracked: string;
  untracked: string;
}

type CopyHandler = (value: string, id: string) => void;

function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function chainGlyph(address: WalletChainAddress | UnifiedWalletAsset): string {
  if (address.family === "solana") return "S";
  return address.symbol.slice(0, 2).toUpperCase();
}

function ChainMark({ item, large = false }: { item: WalletChainAddress | UnifiedWalletAsset; large?: boolean }) {
  const logoUri = "logoUri" in item ? item.logoUri : undefined;
  const logoPadding = logoUri?.startsWith("/chain-icons/") ? "" : "p-1.5";
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white text-xs font-bold text-black ${
        large ? "h-14 w-14" : "h-10 w-10"
      }`}
      aria-hidden="true"
    >
      {logoUri ? (
        // eslint-disable-next-line @next/next/no-img-element -- token logos are local or validated metadata URLs.
        <img src={logoUri} alt="" className={`h-full w-full object-contain ${logoPadding}`} />
      ) : (
        chainGlyph(item)
      )}
    </span>
  );
}

function CopyIcon({ copied }: { copied: boolean }) {
  return copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />;
}

function hasPositiveBalance(value: string): boolean {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return false;
  return /[1-9]/.test(normalized);
}

function sortUnifiedAssets(assets: UnifiedWalletAsset[]): UnifiedWalletAsset[] {
  return [...assets].sort((a, b) => {
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
    <div className="relative min-w-0" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      <button
        ref={triggerRef}
        type="button"
        onClick={togglePinned}
        onFocus={() => {
          if (!suppressFocusOpenRef.current) cancelClose();
        }}
        onBlur={scheduleClose}
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="block min-w-0 max-w-full text-left"
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
  const selected = selectedId ? addresses.find((item) => item.id === selectedId) ?? null : null;
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
              <h3 className="text-xl font-semibold text-white">{selected.chainName}</h3>
              <p className="text-sm text-gray-400">{labels.receiveAddress}</p>
            </div>
          </div>
          <div className={`mx-auto mt-6 w-fit rounded-lg bg-white p-3 ${qrFailed ? "hidden" : ""}`}>
            <canvas ref={canvasRef} role="img" className="block aspect-square h-auto w-[260px] max-w-[calc(100vw-5rem)]" aria-label={`${selected.chainName} ${labels.qrCode}`} />
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
          {labels.network}: {selected.chainName}
        </p>
        <p className="text-center text-xs text-gray-500">{labels.receiveNetworkWarning}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {addresses.length === 0 && (
        <p className="py-10 text-center text-sm text-gray-500">{labels.noAddresses}</p>
      )}
      {addresses.map((item) => {
        const copyId = `wallet-receive-list:${item.id}`;
        return (
          <div key={item.id} className="flex min-w-0 items-center gap-3 border-b border-white/10 px-1 py-3 last:border-b-0 lg:rounded-lg lg:border lg:bg-white/[0.04] lg:px-4">
            <ChainMark item={item} large />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate font-semibold text-white">{item.chainName}</p>
                {item.testnet && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-200">{labels.testnet}</span>}
              </div>
              <p className="mt-1 truncate font-mono text-sm text-gray-400" title={item.address}>{shortAddress(item.address)}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedId(item.id)}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/5 text-gray-200 hover:bg-white/10"
              aria-label={`${item.chainName} ${labels.qrCode}`}
              title={labels.qrCode}
            >
              <QrCode className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => onCopy(item.address, copyId)}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/5 text-gray-200 hover:bg-white/10"
              aria-label={`${copiedId === copyId ? labels.copied : labels.copy} ${item.chainName}`}
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
  const content = (
    <>
      <ChainMark item={asset} large />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="truncate font-semibold text-white">{asset.symbol}</p>
          <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-gray-300">{asset.chainName}</span>
          {asset.testnet && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-200">{labels.testnet}</span>}
        </div>
        <p className="mt-1 truncate text-sm text-gray-400">{asset.name}</p>
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
  refreshing,
  onRefresh,
}: {
  assets: UnifiedWalletAsset[];
  error?: string | null;
  labels: UnifiedWalletLabels;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const sortedAssets = useMemo(() => sortUnifiedAssets(assets), [assets]);
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-200">{labels.allAssets}</h3>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-white/10 px-3 text-xs text-gray-200 hover:bg-white/15 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {labels.refresh}
        </button>
      </div>
      {error && (
        <p role="status" className="rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-sm text-amber-100">
          {error}
        </p>
      )}
      <div className="space-y-2">
        {sortedAssets.map((asset) => <AssetRow key={asset.id} asset={asset} labels={labels} />)}
        {sortedAssets.length === 0 && <p className="py-8 text-center text-sm text-gray-500">{labels.noAssets}</p>}
      </div>
    </section>
  );
}

export function WalletSendAssetPicker({
  assets,
  evmChains,
  labels,
  onAddEvmContract,
  onSelect,
}: {
  assets: UnifiedWalletAsset[];
  evmChains: Array<{ chainId: number; name: string }>;
  labels: UnifiedWalletLabels;
  onAddEvmContract: (chainId: number, contract: string) => Promise<void>;
  onSelect: (asset: UnifiedWalletAsset) => void;
}) {
  const [query, setQuery] = useState("");
  const [chainId, setChainId] = useState(() => String(evmChains[0]?.chainId || ""));
  const [adding, setAdding] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const normalized = query.trim().toLowerCase();
  const isContract = /^0x[0-9a-f]{40}$/.test(normalized);
  const filtered = useMemo(() => {
    const ranked = sortUnifiedAssets(assets);
    if (!normalized) return ranked;
    return ranked.filter((asset) => [asset.symbol, asset.name, asset.chainName, asset.tokenAddress]
      .some((value) => value?.toLowerCase().includes(normalized)));
  }, [assets, normalized]);

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
