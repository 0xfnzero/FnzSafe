"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, CheckCircle2, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { apiFetch } from "@/lib/apiFetch";
import { chainDescriptorLogoUri, chainFamilyLogoUri } from "@/lib/chainMetadata";
import {
  CHAIN_FAMILY_ORDER,
  chainCapabilityTier,
  chainFamilyCounts,
  filterChainCatalog,
  parseChainCatalog,
  visibleChainFamilies,
  type MultiChainDescriptor,
} from "@/lib/multichain";

export interface ChainDirectoryLabels {
  title: string;
  subtitle: string;
  all: string;
  search: string;
  refresh: string;
  loading: string;
  loadFailed: string;
  retry: string;
  noResults: string;
  mainnet: string;
  testnet: string;
  stable: string;
  beta: string;
  experimental: string;
  walletReady: string;
  accountReady: string;
  validationReady: string;
  walletReadyHint: string;
  accountReadyHint: string;
  validationReadyHint: string;
  networks: string;
}

const FAMILY_LABELS: Record<string, string> = {
  solana: "Solana",
  evm: "EVM",
  bitcoin: "Bitcoin",
  tron: "TRON",
};

function ChainLogo({ family, logoUri, size }: { family: string; logoUri?: string; size: "summary" | "network" }) {
  const [failed, setFailed] = useState(false);
  const dimensions = size === "summary" ? "h-9 w-9" : "h-10 w-10";

  return (
    <span
      className={`flex ${dimensions} shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white text-gray-700`}
      aria-hidden="true"
    >
      {logoUri && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- chain logos are bundled local assets.
        <img src={logoUri} alt="" className="h-full w-full object-contain" onError={() => setFailed(true)} />
      ) : family === "evm" ? (
        <Boxes className="h-4 w-4" />
      ) : (
        <ShieldCheck className="h-4 w-4" />
      )}
    </span>
  );
}

function capabilityCopy(tier: ReturnType<typeof chainCapabilityTier>, labels: ChainDirectoryLabels) {
  if (tier === "wallet") return { label: labels.walletReady, hint: labels.walletReadyHint };
  if (tier === "account") return { label: labels.accountReady, hint: labels.accountReadyHint };
  return { label: labels.validationReady, hint: labels.validationReadyHint };
}

function supportLevelLabel(level: string, labels: ChainDirectoryLabels): string {
  if (level === "stable") return labels.stable;
  if (level === "beta") return labels.beta;
  return labels.experimental;
}

export function ChainDirectory({ labels }: { labels: ChainDirectoryLabels }) {
  const [chains, setChains] = useState<MultiChainDescriptor[]>([]);
  const [family, setFamily] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const loadChains = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch("chains", { method: "GET", cache: "no-store", signal: controller.signal });
      const data = await response.json();
      const parsed = parseChainCatalog(data);
      if (!response.ok || !parsed) throw new Error(labels.loadFailed);
      if (requestIdRef.current !== requestId) return;
      setChains(parsed);
    } catch {
      if (controller.signal.aborted || requestIdRef.current !== requestId) return;
      setError(labels.loadFailed);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [labels.loadFailed]);

  useEffect(() => {
    void loadChains();
    return () => abortRef.current?.abort();
  }, [loadChains]);

  const counts = useMemo(() => chainFamilyCounts(chains), [chains]);
  const visibleChains = useMemo(() => filterChainCatalog(chains, family, query), [chains, family, query]);
  const filters = ["all", ...visibleChainFamilies(chains)];

  return (
    <section className="space-y-4" aria-labelledby="chain-directory-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="chain-directory-title" className="text-base font-semibold text-white">{labels.title}</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-400">{labels.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void loadChains()}
          disabled={loading}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white disabled:opacity-50"
          aria-label={labels.refresh}
          title={labels.refresh}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="grid overflow-hidden rounded-lg border border-white/10 bg-white/[0.03] sm:grid-cols-2 lg:grid-cols-4">
        {CHAIN_FAMILY_ORDER.map((item, index) => (
          <div
            key={item}
            className={`flex min-w-0 items-center gap-3 px-4 py-3 ${
              index > 0 ? "border-t border-white/10 sm:border-t-0 sm:border-l" : ""
            }`}
          >
            <ChainLogo family={item} logoUri={chainFamilyLogoUri(item)} size="summary" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-white">{FAMILY_LABELS[item] ?? item}</span>
              <span className="block text-xs text-gray-500">{counts[item] ?? 0} {labels.networks}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-white/10 bg-white/5 p-1">
          {filters.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setFamily(item)}
              className={`h-8 shrink-0 rounded-md px-3 text-xs font-semibold transition-colors ${
                family === item ? "bg-white text-black" : "text-gray-300 hover:bg-white/10 hover:text-white"
              }`}
              aria-pressed={family === item}
            >
              {item === "all" ? labels.all : FAMILY_LABELS[item] ?? item}
            </button>
          ))}
        </div>
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{labels.search}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.search}
            className="h-10 w-full rounded-lg border border-white/10 bg-black/30 pl-10 pr-3 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-400/30"
          />
        </label>
      </div>

      {error && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] p-4 sm:flex-row sm:items-center sm:justify-between">
          <p role="status" className="text-sm text-amber-100">{error}</p>
          <button type="button" onClick={() => void loadChains()} className="h-9 rounded-lg bg-white px-3 text-sm font-semibold text-black hover:bg-gray-200">
            {labels.retry}
          </button>
        </div>
      )}
      {loading && chains.length === 0 ? (
        <p role="status" className="py-12 text-center text-sm text-gray-500">{labels.loading}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-white/10 bg-black/20">
          {visibleChains.map((chain, index) => {
            const tier = chainCapabilityTier(chain);
            const tierCopy = capabilityCopy(tier, labels);
            return (
              <div key={chain.chain_id} className={`grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${index > 0 ? "border-t border-white/10" : ""}`}>
                <div className="flex min-w-0 items-center gap-3">
                  <ChainLogo family={chain.family} logoUri={chainDescriptorLogoUri(chain)} size="network" />
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-white">{chain.name}</p>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${chain.testnet ? "bg-amber-400/15 text-amber-200" : "bg-white/10 text-gray-300"}`}>
                        {chain.testnet ? labels.testnet : labels.mainnet}
                      </span>
                      <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-gray-400">
                        {supportLevelLabel(chain.support_level, labels)}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-gray-500" title={chain.chain_id}>{chain.chain_id} · {chain.native_asset.symbol}</p>
                  </div>
                </div>
                <div className="min-w-0 sm:max-w-xs sm:text-right">
                  <p className={`inline-flex items-center gap-1.5 text-xs font-semibold ${tier === "wallet" ? "text-emerald-200" : "text-amber-200"}`}>
                    {tier === "wallet" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    {tierCopy.label}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-gray-500">{tierCopy.hint}</p>
                </div>
              </div>
            );
          })}
          {visibleChains.length === 0 && <p className="py-12 text-center text-sm text-gray-500">{labels.noResults}</p>}
        </div>
      )}
    </section>
  );
}
