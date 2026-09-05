"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  RefreshCw,
  Search,
} from "lucide-react";
import { fomoTokenActionUrls, signalSwapUrl } from "@/lib/fomoSignals";
import {
  DEFAULT_TOKEN_MARKET_SORT,
  formatTokenMarketUsd,
  nextTokenMarketSort,
  sortTokenMarketRows,
  type SortableTokenMarketRow,
  type TokenMarketSort,
  type TokenMarketSortKey,
} from "@/lib/tokenMarketTable";

export interface ResearchTokenListItem extends SortableTokenMarketRow {
  logo_url?: string | null;
  contract_address: string;
}

interface TwitterTokenListLabels {
  rowNumber: string;
  search: string;
  allChains: string;
  mentions: string;
  marketCap: string;
  volume: string;
  change: string;
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
  actions: string;
  fomoAction: string;
  swapAction: string;
  openFomoExternal: string;
  fomoUnavailable: string;
  openSwap: string;
  swapUnavailable: string;
  sortBy: string;
  sortAscending: string;
  sortDescending: string;
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
  onOpenExternal: (url: string) => void;
}

const PAGE_SIZE = 100;

function compactAddress(value: string): string {
  if (value.length <= 22) return value;
  return `${value.slice(0, value.startsWith("0x") ? 10 : 8)}...${value.slice(-8)}`;
}

function displayTokenName(value: string | null | undefined): string {
  return value
    ?.replace(/\s*(?:(?:\u2022|\u00b7)\s*)?Robinhood Token\s*$/i, "")
    .trim() || "";
}

function formatPercent(value: number | null | undefined, locale: string): string {
  if (value == null || !Number.isFinite(value)) return "--";
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return `${new Intl.NumberFormat(locale, {
    signDisplay: "exceptZero",
    maximumFractionDigits: 2,
  }).format(normalized)}%`;
}

function percentTone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "text-gray-400";
  return value > 0 ? "text-emerald-300" : "text-red-300";
}

function marketUrl(token: ResearchTokenListItem): string {
  return `https://dexscreener.com/search?q=${encodeURIComponent(token.contract_address)}`;
}

const MARKET_PERIODS = [
  {
    label: "5m",
    sortKey: "change5m",
    changeField: "price_change_5m_percent",
    volumeField: "volume_5m_usd",
  },
  {
    label: "1h",
    sortKey: "change1h",
    changeField: "price_change_1h_percent",
    volumeField: "volume_1h_usd",
  },
  {
    label: "6h",
    sortKey: "change6h",
    changeField: "price_change_6h_percent",
    volumeField: "volume_6h_usd",
  },
  {
    label: "24h",
    sortKey: "change24h",
    changeField: "price_change_24h_percent",
    volumeField: "volume_24h_usd",
  },
] as const;

interface SortableHeaderProps {
  sortKey: TokenMarketSortKey;
  label: string;
  sort: TokenMarketSort;
  labels: Pick<TwitterTokenListLabels, "sortBy" | "sortAscending" | "sortDescending">;
  onSort: (key: TokenMarketSortKey) => void;
  className?: string;
  align?: "left" | "right";
  sortLabel?: string;
}

function SortableHeader({
  sortKey,
  label,
  sort,
  labels,
  onSort,
  className = "",
  align = "right",
  sortLabel,
}: SortableHeaderProps) {
  const active = sort.key === sortKey;
  const directionLabel = sort.direction === "asc" ? labels.sortAscending : labels.sortDescending;
  let Icon = ArrowUpDown;
  let ariaSort: "none" | "ascending" | "descending" = "none";
  if (active) {
    Icon = sort.direction === "asc" ? ArrowUp : ArrowDown;
    ariaSort = sort.direction === "asc" ? "ascending" : "descending";
  }
  return (
    <th className={className} aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex h-8 w-full items-center gap-1 whitespace-nowrap rounded px-1 text-gray-500 hover:bg-white/[0.06] hover:text-gray-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-300/50 ${
          align === "right" ? "justify-end" : "justify-start"
        }`}
        title={`${labels.sortBy} ${sortLabel || label}`}
        aria-label={`${labels.sortBy} ${sortLabel || label}${active ? `, ${directionLabel}` : ""}`}
      >
        <span>{label}</span>
        <Icon className={`h-3 w-3 shrink-0 ${active ? "text-sky-300" : "opacity-45"}`} />
      </button>
    </th>
  );
}

function PeriodMarketCell({
  change,
  volume,
  locale,
}: {
  change: number | null | undefined;
  volume: number | null | undefined;
  locale: string;
}) {
  return (
    <td className="px-2.5 py-2 text-right tabular-nums">
      <div className={`font-medium leading-5 ${percentTone(change)}`}>{formatPercent(change, locale)}</div>
      <div className="text-[10px] leading-4 text-gray-500">{formatTokenMarketUsd(volume, locale)}</div>
    </td>
  );
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
  onOpenExternal,
}: TwitterTokenListProps) {
  const [search, setSearch] = useState("");
  const [chain, setChain] = useState("");
  const [sort, setSort] = useState<TokenMarketSort>(DEFAULT_TOKEN_MARKET_SORT);
  const [page, setPage] = useState(1);
  const chains = useMemo(
    () => Array.from(new Set(tokens.map((token) => token.chain))).sort((left, right) => left.localeCompare(right)),
    [tokens],
  );
  const filteredTokens = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = tokens
      .filter((token) => !chain || token.chain === chain)
      .filter((token) => !query || [token.symbol, token.name, token.contract_address, token.market_source]
        .some((value) => value?.toLowerCase().includes(query)));
    return sortTokenMarketRows(filtered, sort, locale);
  }, [chain, locale, search, sort, tokens]);
  const pageCount = Math.max(1, Math.ceil(filteredTokens.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const displayedTokens = filteredTokens.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const handleSort = (key: TokenMarketSortKey) => {
    setSort((value) => nextTokenMarketSort(value, key));
  };

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
          <table className="w-full min-w-[1700px] table-fixed text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[#0b141e] text-[11px] font-medium text-gray-500">
              <tr className="border-b border-white/10">
                <th className="sticky left-0 z-20 w-12 bg-[#0b141e] px-2 py-2.5 text-center" title={labels.rowNumber} aria-label={labels.rowNumber}>#</th>
                <SortableHeader sortKey="token" label={labels.token} sort={sort} labels={labels} onSort={handleSort} align="left" className="sticky left-12 z-20 w-52 bg-[#0b141e] px-2 py-1.5 md:px-3" />
                <SortableHeader sortKey="price" label={labels.price} sort={sort} labels={labels} onSort={handleSort} className="w-28 px-2 py-1.5" />
                <SortableHeader sortKey="marketCap" label={labels.marketCap} sort={sort} labels={labels} onSort={handleSort} className="w-28 px-2 py-1.5" />
                {MARKET_PERIODS.map((period) => (
                  <SortableHeader
                    key={period.label}
                    sortKey={period.sortKey}
                    label={period.label}
                    sortLabel={`${period.label} ${labels.change}`}
                    sort={sort}
                    labels={labels}
                    onSort={handleSort}
                    className="w-24 px-2 py-1.5"
                  />
                ))}
                <SortableHeader sortKey="liquidity" label={labels.poolFunds} sort={sort} labels={labels} onSort={handleSort} className="w-28 px-2 py-1.5" />
                <SortableHeader sortKey="mentions" label={labels.mentions} sort={sort} labels={labels} onSort={handleSort} className="w-20 px-2 py-1.5" />
                <SortableHeader sortKey="kolMentions" label={labels.kolMentions} sort={sort} labels={labels} onSort={handleSort} className="w-28 px-2 py-1.5" />
                <SortableHeader sortKey="chain" label={labels.chain} sort={sort} labels={labels} onSort={handleSort} align="left" className="w-24 px-2 py-1.5" />
                <SortableHeader sortKey="marketSource" label={labels.swap} sort={sort} labels={labels} onSort={handleSort} align="left" className="w-28 px-2 py-1.5" />
                <SortableHeader sortKey="updated" label={labels.updated} sort={sort} labels={labels} onSort={handleSort} align="left" className="w-32 px-2 py-1.5" />
                <th className="w-44 px-2 py-2.5 text-center">{labels.actions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.07]">
              {displayedTokens.map((token, rowIndex) => {
                const copyId = `research-token-${token.id}`;
                const updatedAt = token.market_updated_at_ms || token.latest_mention_at_ms;
                const tokenName = displayTokenName(token.name);
                const rowNumber = (currentPage - 1) * PAGE_SIZE + rowIndex + 1;
                const fomoActionUrls = fomoTokenActionUrls({
                  chain: token.chain,
                  contractAddress: token.contract_address,
                });
                const swapUrl = fomoActionUrls.swapUrl || signalSwapUrl({
                  chain: token.chain,
                  contractAddress: token.contract_address,
                });
                return (
                  <tr key={token.id} className="group hover:bg-white/[0.035]">
                    <th scope="row" className="sticky left-0 z-[6] bg-[#080f16] px-2 py-2.5 text-center font-normal tabular-nums text-gray-500 group-hover:bg-[#0d151d]">{rowNumber}</th>
                    <td className="sticky left-12 z-[5] bg-[#080f16] px-3 py-2.5 group-hover:bg-[#0d151d] md:px-4">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[0.06] text-[10px] font-semibold text-gray-400">
                          {token.symbol?.slice(0, 1) || "?"}
                          {token.logo_url && (
                            // eslint-disable-next-line @next/next/no-img-element -- logos are remote token metadata with per-image fallback.
                            <img
                              src={token.logo_url}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              className="absolute inset-0 h-full w-full object-cover"
                              onError={(event) => { event.currentTarget.hidden = true; }}
                            />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-gray-100">${token.symbol || "--"}</div>
                          {tokenName && <div className="truncate text-[11px] text-gray-500">{tokenName}</div>}
                          <div className="flex min-w-0 items-center gap-1">
                            <code className="min-w-0 truncate text-[10px] text-emerald-200/75" title={token.contract_address}>
                              {compactAddress(token.contract_address)}
                            </code>
                            <button
                              type="button"
                              onClick={() => onCopy(token.contract_address, copyId)}
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-white/10 hover:text-white"
                              title={labels.copyContract}
                              aria-label={labels.copyContract}
                            >
                              {copiedId === copyId ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            </button>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-200">{formatTokenMarketUsd(token.price_usd, locale)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-300">{formatTokenMarketUsd(token.market_cap_usd, locale)}</td>
                    {MARKET_PERIODS.map((period) => (
                      <PeriodMarketCell
                        key={period.label}
                        change={token[period.changeField]}
                        volume={token[period.volumeField]}
                        locale={locale}
                      />
                    ))}
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-300">{formatTokenMarketUsd(token.liquidity_usd, locale)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-200">{token.mention_count}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-sky-300">{token.kol_mention_count}</td>
                    <td className="px-3 py-2.5"><span className="rounded border border-white/10 px-1.5 py-1 text-[10px] text-gray-300">{token.chain}</span></td>
                    <td className="truncate px-3 py-2.5 text-gray-300" title={token.market_source || undefined}>{token.market_source || "--"}</td>
                    <td className="px-3 py-2.5 text-[11px] text-gray-500">{new Date(updatedAt).toLocaleString(locale)}</td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => fomoActionUrls.fomoUrl && onOpenExternal(fomoActionUrls.fomoUrl)}
                          disabled={!fomoActionUrls.fomoUrl}
                          className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border border-violet-300/25 bg-violet-300/10 px-2 text-[11px] font-semibold text-violet-100 hover:bg-violet-300/20 disabled:cursor-not-allowed disabled:opacity-40"
                          title={fomoActionUrls.fomoUrl ? labels.openFomoExternal : labels.fomoUnavailable}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {labels.fomoAction}
                        </button>
                        <button
                          type="button"
                          onClick={() => swapUrl && onOpen(swapUrl)}
                          disabled={!swapUrl}
                          className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md bg-emerald-300 px-2 text-[11px] font-semibold text-zinc-950 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
                          title={swapUrl ? labels.openSwap : labels.swapUnavailable}
                        >
                          <ArrowRightLeft className="h-3.5 w-3.5" />
                          {labels.swapAction}
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpen(marketUrl(token))}
                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-white/10 hover:text-white"
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
