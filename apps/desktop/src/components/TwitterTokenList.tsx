"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink, RefreshCw, Search } from "lucide-react";

export interface ResearchTokenListItem {
  id: number;
  symbol: string;
  name?: string | null;
  chain: string;
  contract_address: string;
  price_usd?: number | null;
  volume_24h_usd?: number | null;
  liquidity_usd?: number | null;
  market_cap_usd?: number | null;
  market_source?: string | null;
  market_updated_at_ms?: number | null;
  mention_count: number;
  kol_mention_count: number;
  latest_mention_at_ms: number;
}

interface TwitterTokenListLabels {
  search: string;
  allChains: string;
  latest: string;
  mentions: string;
  marketCap: string;
  volume: string;
  liquidity: string;
  token: string;
  price: string;
  poolFunds: string;
  kolMentions: string;
  chain: string;
  swap: string;
  updated: string;
  empty: string;
  loading: string;
  refresh: string;
  previousPage: string;
  nextPage: string;
  copyContract: string;
  openMarket: string;
}

interface TwitterTokenListProps {
  tokens: ResearchTokenListItem[];
  loading: boolean;
  error: string;
  copiedId?: string | null;
  locale: string;
  labels: TwitterTokenListLabels;
  onRefresh: () => void;
  onCopy: (address: string, copyId: string) => void;
  onOpen: (url: string) => void;
}

const PAGE_SIZE = 100;

function compactAddress(value: string): string {
  if (value.length <= 22) return value;
  return `${value.slice(0, value.startsWith("0x") ? 10 : 8)}...${value.slice(-8)}`;
}

function formatUsd(value: number | null | undefined, locale: string): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "--";
  if (value < 0.01) return `$${value.toPrecision(4)}`;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function marketUrl(token: ResearchTokenListItem): string {
  return `https://dexscreener.com/search?q=${encodeURIComponent(token.contract_address)}`;
}

export function TwitterTokenList({
  tokens,
  loading,
  error,
  copiedId,
  locale,
  labels,
  onRefresh,
  onCopy,
  onOpen,
}: TwitterTokenListProps) {
  const [search, setSearch] = useState("");
  const [chain, setChain] = useState("");
  const [sort, setSort] = useState<"latest" | "mentions" | "marketCap" | "volume" | "liquidity">("latest");
  const [page, setPage] = useState(1);
  const chains = useMemo(
    () => Array.from(new Set(tokens.map((token) => token.chain))).sort((left, right) => left.localeCompare(right)),
    [tokens],
  );
  const filteredTokens = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tokens
      .filter((token) => !chain || token.chain === chain)
      .filter((token) => !query || [token.symbol, token.name, token.contract_address, token.market_source]
        .some((value) => value?.toLowerCase().includes(query)))
      .sort((left, right) => {
        if (sort === "mentions") return right.mention_count - left.mention_count;
        if (sort === "marketCap") return (right.market_cap_usd || 0) - (left.market_cap_usd || 0);
        if (sort === "volume") return (right.volume_24h_usd || 0) - (left.volume_24h_usd || 0);
        if (sort === "liquidity") return (right.liquidity_usd || 0) - (left.liquidity_usd || 0);
        return right.latest_mention_at_ms - left.latest_mention_at_ms;
      });
  }, [chain, search, sort, tokens]);
  const pageCount = Math.max(1, Math.ceil(filteredTokens.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const displayedTokens = filteredTokens.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  useEffect(() => setPage(1), [chain, search, sort]);

  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.025]">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2.5 md:px-4">
        <label className="relative min-w-[220px] flex-1 md:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-600" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-9 w-full rounded-md border border-white/10 bg-black/25 pl-8 pr-2.5 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-sky-300/30"
            placeholder={labels.search}
            aria-label={labels.search}
          />
        </label>
        <select
          value={chain}
          onChange={(event) => setChain(event.target.value)}
          className="h-9 rounded-md border border-white/10 bg-zinc-950 px-2.5 text-xs text-gray-300 outline-none focus:border-sky-300/30"
          aria-label={labels.chain}
        >
          <option value="">{labels.allChains}</option>
          {chains.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
          className="h-9 rounded-md border border-white/10 bg-zinc-950 px-2.5 text-xs text-gray-300 outline-none focus:border-sky-300/30"
          aria-label={labels.latest}
        >
          <option value="latest">{labels.latest}</option>
          <option value="mentions">{labels.mentions}</option>
          <option value="marketCap">{labels.marketCap}</option>
          <option value="volume">{labels.volume}</option>
          <option value="liquidity">{labels.liquidity}</option>
        </select>
        <span className="text-xs tabular-nums text-gray-500">{filteredTokens.length}</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 text-gray-400 hover:bg-white/[0.07] hover:text-white disabled:opacity-40"
          title={labels.refresh}
          aria-label={labels.refresh}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <p className="px-4 py-12 text-center text-sm text-red-300">{error}</p>
      )}
      {!error && loading && tokens.length === 0 && (
        <p className="px-4 py-12 text-center text-sm text-gray-500">{labels.loading}</p>
      )}
      {!error && (!loading || tokens.length > 0) && displayedTokens.length === 0 && (
        <p className="px-4 py-12 text-center text-sm text-gray-500">{labels.empty}</p>
      )}
      {!error && displayedTokens.length > 0 && (
        <div className="max-h-[calc(100vh-13rem)] overflow-auto">
          <table className="w-full min-w-[1260px] table-fixed text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[#0b141e] text-[11px] font-medium text-gray-500">
              <tr className="border-b border-white/10">
                <th className="w-64 px-3 py-2.5 md:px-4">{labels.token}</th>
                <th className="w-28 px-3 py-2.5 text-right">{labels.price}</th>
                <th className="w-28 px-3 py-2.5 text-right">{labels.marketCap}</th>
                <th className="w-28 px-3 py-2.5 text-right">{labels.poolFunds}</th>
                <th className="w-28 px-3 py-2.5 text-right">24h {labels.volume}</th>
                <th className="w-20 px-3 py-2.5 text-right">{labels.mentions}</th>
                <th className="w-24 px-3 py-2.5 text-right">{labels.kolMentions}</th>
                <th className="w-24 px-3 py-2.5">{labels.chain}</th>
                <th className="w-28 px-3 py-2.5">{labels.swap}</th>
                <th className="w-32 px-3 py-2.5">{labels.updated}</th>
                <th className="w-20 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.07]">
              {displayedTokens.map((token) => {
                const copyId = `research-token-${token.id}`;
                const updatedAt = token.market_updated_at_ms || token.latest_mention_at_ms;
                return (
                  <tr key={token.id} className="hover:bg-white/[0.035]">
                    <td className="px-3 py-2.5 md:px-4">
                      <div className="truncate font-semibold text-gray-100">${token.symbol || "--"}</div>
                      {token.name && <div className="truncate text-[11px] text-gray-500">{token.name}</div>}
                      <code className="block truncate text-[10px] text-emerald-200/75" title={token.contract_address}>
                        {compactAddress(token.contract_address)}
                      </code>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-200">{formatUsd(token.price_usd, locale)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-300">{formatUsd(token.market_cap_usd, locale)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-300">{formatUsd(token.liquidity_usd, locale)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-300">{formatUsd(token.volume_24h_usd, locale)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-200">{token.mention_count}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-sky-300">{token.kol_mention_count}</td>
                    <td className="px-3 py-2.5"><span className="rounded border border-white/10 px-1.5 py-1 text-[10px] text-gray-300">{token.chain}</span></td>
                    <td className="truncate px-3 py-2.5 text-gray-300" title={token.market_source || undefined}>{token.market_source || "--"}</td>
                    <td className="px-3 py-2.5 text-[11px] text-gray-500">{new Date(updatedAt).toLocaleString(locale)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onCopy(token.contract_address, copyId)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-white/10 hover:text-white"
                          title={labels.copyContract}
                          aria-label={labels.copyContract}
                        >
                          {copiedId === copyId ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpen(marketUrl(token))}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-white/10 hover:text-white"
                          title={labels.openMarket}
                          aria-label={labels.openMarket}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-3 py-2 md:px-4">
          <button
            type="button"
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            disabled={currentPage <= 1}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 text-gray-300 hover:bg-white/[0.08] disabled:opacity-35"
            title={labels.previousPage}
            aria-label={labels.previousPage}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-16 text-center text-xs tabular-nums text-gray-500">{currentPage} / {pageCount}</span>
          <button
            type="button"
            onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
            disabled={currentPage >= pageCount}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 text-gray-300 hover:bg-white/[0.08] disabled:opacity-35"
            title={labels.nextPage}
            aria-label={labels.nextPage}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </section>
  );
}
