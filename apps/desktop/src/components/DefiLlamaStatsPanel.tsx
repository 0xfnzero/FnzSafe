"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Bot,
  Coins,
  Layers,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import {
  buildDefiLlamaAiContext,
  fetchDefiLlamaRankings,
  formatDefiLlamaPct,
  formatDefiLlamaUsd,
  formatProtocolTokenLabel,
  chainLogoUrl,
  mergeDefiLlamaRankingsCaches,
  rankingValueForPeriod,
  readDefiLlamaRankingsCache,
  rankingsCacheFromDatabaseRecords,
  sortRankingsByColumn,
  writeDefiLlamaRankingsCache,
  type DefiLlamaDataView,
  type DefiLlamaPeriod,
  type DefiLlamaRankingRow,
  type DefiLlamaRankingsDatabaseRecord,
  type DefiLlamaRankingsResult,
  type DefiLlamaSortDirection,
  type DefiLlamaSortKey,
  type DefiLlamaStatsView,
} from "@/lib/defillamaStats";
import { researchAiProviderPreset, type ResearchAiProviderKind } from "@/lib/researchAiProviders";

interface ResearchAiChatResult {
  answer: string;
  local_only: boolean;
  runtime: "local" | "deepseek-harness";
  session_id?: string | null;
  tools_used?: string[];
}

function isTauriWebview(): boolean {
  return typeof window !== "undefined" && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export interface DefiLlamaStatsLabels {
  title: string;
  hint: string;
  chainVolume: string;
  chainRevenue: string;
  protocolVolume: string;
  protocolRevenue: string;
  aiView: string;
  period24h: string;
  period7d: string;
  period30d: string;
  search: string;
  allCategories: string;
  refresh: string;
  refreshing: string;
  updatedAt: string;
  loading: string;
  empty: string;
  error: string;
  rank: string;
  name: string;
  token: string;
  category: string;
  chains: string;
  value: string;
  volume: string;
  revenue: string;
  change1d: string;
  change7d: string;
  totals: string;
  source: string;
  aiTitle: string;
  aiHint: string;
  aiPlaceholder: string;
  aiAsk: string;
  aiBusy: string;
  aiEmpty: string;
  aiDesktopOnly: string;
  aiFailed: string;
  aiContextHint: string;
  aiSettings: string;
  localProvider: string;
}

interface DefiLlamaStatsPanelProps {
  labels: DefiLlamaStatsLabels;
  initialView?: DefiLlamaStatsView;
  aiProvider: {
    kind: ResearchAiProviderKind;
    endpoint: string;
    model: string;
    apiKey: string;
  };
  aiConfiguration: ReactNode;
}

const VIEW_META: Array<{
  id: DefiLlamaStatsView;
  icon: typeof BarChart3;
  labelKey: keyof Pick<
    DefiLlamaStatsLabels,
    "chainVolume" | "chainRevenue" | "protocolVolume" | "protocolRevenue" | "aiView"
  >;
}> = [
  { id: "chain-volume", icon: Layers, labelKey: "chainVolume" },
  { id: "chain-revenue", icon: TrendingUp, labelKey: "chainRevenue" },
  { id: "protocol-volume", icon: BarChart3, labelKey: "protocolVolume" },
  { id: "protocol-revenue", icon: Coins, labelKey: "protocolRevenue" },
  { id: "ai", icon: Sparkles, labelKey: "aiView" },
];

function changeClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return "text-gray-400";
  }
  return value > 0 ? "text-emerald-300" : "text-red-300";
}

function defaultSortDirection(key: DefiLlamaSortKey): DefiLlamaSortDirection {
  return key === "name" || key === "token" || key === "category" || key === "chains" ? "asc" : "desc";
}

export function DefiLlamaStatsPanel({
  labels,
  initialView = "chain-volume",
  aiProvider,
  aiConfiguration,
}: DefiLlamaStatsPanelProps) {
  const [view, setView] = useState<DefiLlamaStatsView>(initialView);
  const [period, setPeriod] = useState<DefiLlamaPeriod>("24h");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [sortKey, setSortKey] = useState<DefiLlamaSortKey>("value");
  const [sortDirection, setSortDirection] = useState<DefiLlamaSortDirection>("desc");
  const [errors, setErrors] = useState<Partial<Record<DefiLlamaDataView, string>>>({});
  const [cache, setCache] = useState<Partial<Record<DefiLlamaDataView, DefiLlamaRankingsResult>>>(() =>
    readDefiLlamaRankingsCache(),
  );
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const [databaseHydrated, setDatabaseHydrated] = useState(false);
  const [pendingViews, setPendingViews] = useState<Partial<Record<DefiLlamaDataView, boolean>>>({});
  const refreshRequestIdsRef = useRef<Partial<Record<DefiLlamaDataView, number>>>({});

  const [aiQuestion, setAiQuestion] = useState("");
  const [aiResult, setAiResult] = useState<ResearchAiChatResult | null>(null);
  const [aiSessionId, setAiSessionId] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const aiRequestIdRef = useRef(0);

  const activeDataView: DefiLlamaDataView =
    view === "ai" ? "protocol-revenue" : view;
  const showCategoryFilter = view === "protocol-volume" || view === "protocol-revenue";
  const showChains = showCategoryFilter;
  const showToken = showCategoryFilter;
  const isRevenueView = view === "chain-revenue" || view === "protocol-revenue";
  const valueLabel = isRevenueView ? labels.revenue : labels.volume;

  const loadRankings = useCallback(async (
    target: DefiLlamaDataView,
    options: { force?: boolean; background?: boolean } = {},
  ) => {
    const force = Boolean(options.force);
    const cached = cacheRef.current[target];
    if (!force && cached) return cached;

    const requestId = (refreshRequestIdsRef.current[target] || 0) + 1;
    refreshRequestIdsRef.current[target] = requestId;
    const hasCached = Boolean(cached);
    setPendingViews((previous) => ({ ...previous, [target]: true }));
    setErrors((previous) => ({ ...previous, [target]: "" }));
    try {
      const result = await fetchDefiLlamaRankings(target);
      if (requestId !== refreshRequestIdsRef.current[target]) return result;
      setCache((prev) => {
        const next = { ...prev, [target]: result };
        cacheRef.current = next;
        return next;
      });
      writeDefiLlamaRankingsCache(target, result);
      if (isTauriWebview()) {
        try {
          await invoke("research_put_defillama_rankings", {
            view: target,
            payloadJson: JSON.stringify(result),
            fetchedAtMs: result.fetchedAt,
          });
        } catch {
          // localStorage remains available as a fallback if the database write fails.
        }
      }
      return result;
    } catch (err) {
      if (requestId !== refreshRequestIdsRef.current[target]) return null;
      if (!hasCached) {
        setErrors((previous) => ({
          ...previous,
          [target]: err instanceof Error ? err.message : labels.error,
        }));
      }
      return null;
    } finally {
      if (requestId === refreshRequestIdsRef.current[target]) {
        setPendingViews((previous) => ({ ...previous, [target]: false }));
      }
    }
  }, [labels.error]);

  useEffect(() => {
    let cancelled = false;
    if (!isTauriWebview()) {
      setDatabaseHydrated(true);
      return () => {
        cancelled = true;
      };
    }
    void invoke<DefiLlamaRankingsDatabaseRecord[]>("research_list_defillama_rankings")
      .then(async (records) => {
        if (cancelled) return;
        const databaseCache = rankingsCacheFromDatabaseRecords(records);
        const next = mergeDefiLlamaRankingsCaches(cacheRef.current, databaseCache);
        cacheRef.current = next;
        setCache(next);
        for (const cachedView of Object.values(next)) {
          if (cachedView) writeDefiLlamaRankingsCache(cachedView.view, cachedView);
        }
        const snapshotsToMigrate = Object.values(next).filter((snapshot): snapshot is DefiLlamaRankingsResult => {
          if (!snapshot) return false;
          return !databaseCache[snapshot.view]
            || snapshot.fetchedAt > databaseCache[snapshot.view]!.fetchedAt;
        });
        await Promise.allSettled(snapshotsToMigrate.map((snapshot) => invoke(
          "research_put_defillama_rankings",
          {
            view: snapshot.view,
            payloadJson: JSON.stringify(snapshot),
            fetchedAtMs: snapshot.fetchedAt,
          },
        )));
      })
      .catch(() => {
        // Continue with localStorage and repair the database on the next successful refresh.
      })
      .finally(() => {
        if (!cancelled) setDatabaseHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!databaseHydrated || view === "ai") return;
    // Stale-while-revalidate: hydrate durable history before refreshing in the background.
    void loadRankings(view, { background: true, force: true });
  }, [databaseHydrated, view, loadRankings]);

  useEffect(() => {
    if (!showCategoryFilter && (sortKey === "category" || sortKey === "token" || sortKey === "chains")) {
      setSortKey("value");
      setSortDirection("desc");
    }
  }, [showCategoryFilter, sortKey]);

  useEffect(() => {
    aiRequestIdRef.current += 1;
    setAiSessionId(null);
    setAiResult(null);
    setAiError("");
    setAiBusy(false);
  }, [aiProvider.apiKey, aiProvider.endpoint, aiProvider.kind, aiProvider.model]);

  const current = cache[activeDataView];
  const error = errors[activeDataView] || "";
  const activeViewPending = Boolean(pendingViews[activeDataView]);
  const loading = (!databaseHydrated || activeViewPending) && !current;
  const refreshing = activeViewPending && Boolean(current);
  const categories = useMemo(() => {
    const values = new Set<string>();
    for (const row of current?.rows || []) {
      if (row.category) values.add(row.category);
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [current?.rows]);

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = (current?.rows || []).filter((row) => {
      if (category && row.category !== category) return false;
      if (!needle) return true;
      const haystack = [
        row.name,
        row.tokenName,
        row.tokenSymbol,
        formatProtocolTokenLabel(row.tokenName, row.tokenSymbol),
        row.category,
        ...(row.chains || []),
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
    return sortRankingsByColumn(rows, sortKey, period, sortDirection);
  }, [category, current?.rows, period, search, sortDirection, sortKey]);

  const toggleSort = (key: DefiLlamaSortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection(defaultSortDirection(key));
  };

  const askAi = async () => {
    const question = aiQuestion.trim();
    if (!question || aiBusy) return;
    if (!isTauriWebview()) {
      setAiError(labels.aiDesktopOnly);
      return;
    }
    setAiBusy(true);
    setAiError("");
    const requestId = aiRequestIdRef.current + 1;
    aiRequestIdRef.current = requestId;
    try {
      const rankingView: Exclude<DefiLlamaStatsView, "ai"> =
        cacheRef.current["protocol-revenue"]
          ? "protocol-revenue"
          : cacheRef.current["protocol-volume"]
            ? "protocol-volume"
            : cacheRef.current["chain-volume"]
              ? "chain-volume"
              : "protocol-revenue";
      const snapshot = cacheRef.current[rankingView] || (await loadRankings(rankingView, { force: true }));
      const context = buildDefiLlamaAiContext(
        rankingView,
        period,
        snapshot?.rows || [],
      );
      const providerPreset = researchAiProviderPreset(aiProvider.kind);
      const result = await invoke<ResearchAiChatResult>("research_ai_chat", {
        request: {
          question: `${question}\n\n${context}`,
          session_id: aiProvider.kind === "local" ? null : aiSessionId,
          provider: aiProvider.kind === "local" ? null : {
            kind: aiProvider.kind,
            endpoint: aiProvider.endpoint.trim() || providerPreset.endpoint,
            model: aiProvider.model.trim() || providerPreset.model,
            api_key: aiProvider.apiKey,
          },
        },
      });
      if (aiRequestIdRef.current !== requestId) return;
      setAiResult(result);
      if (result.session_id) setAiSessionId(result.session_id);
    } catch (err) {
      if (aiRequestIdRef.current !== requestId) return;
      setAiError(err instanceof Error ? err.message : labels.aiFailed);
    } finally {
      if (aiRequestIdRef.current === requestId) setAiBusy(false);
    }
  };

  return (
    <div className="app-defillama-stats flex h-full min-h-0 flex-col overflow-hidden bg-[#081019] text-gray-100">
      <div className="shrink-0 border-b border-white/10 px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">{labels.title}</h2>
            <p className="mt-1 text-xs text-gray-400">{labels.hint}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] text-gray-400">
            {labels.source}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-1 overflow-x-auto pb-1">
          {VIEW_META.map(({ id, icon: Icon, labelKey }) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-pressed={view === id}
              className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors ${
                view === id
                  ? "bg-white text-zinc-950"
                  : "text-gray-400 hover:bg-white/[0.07] hover:text-white"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {labels[labelKey]}
            </button>
          ))}
        </div>
      </div>

      {view !== "ai" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-3 sm:px-4">
          <div className="mb-3 shrink-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex h-9 items-center rounded-md border border-white/10 bg-black/25 p-0.5">
                {([
                  ["24h", labels.period24h],
                  ["7d", labels.period7d],
                  ["30d", labels.period30d],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPeriod(id)}
                    aria-pressed={period === id}
                    className={`h-8 rounded px-2.5 text-xs font-semibold transition-colors ${
                      period === id
                        ? "bg-white text-zinc-950"
                        : "text-gray-400 hover:bg-white/[0.07] hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="relative min-w-[180px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={labels.search}
                  className="h-9 w-full rounded-md border border-white/10 bg-black/30 py-2 pl-8 pr-3 text-xs text-white placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-white/20"
                />
              </div>

              {showCategoryFilter && (
                <select
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  className="h-9 rounded-md border border-white/10 bg-black/30 px-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-white/20"
                >
                  <option value="">{labels.allCategories}</option>
                  {categories.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                onClick={() => void loadRankings(view, { force: true, background: Boolean(current) })}
                disabled={loading || refreshing}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 text-xs font-semibold text-gray-200 hover:bg-white/10 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading || refreshing ? "animate-spin" : ""}`} />
                {refreshing ? labels.refreshing : labels.refresh}
              </button>
            </div>

            {current?.fetchedAt ? (
              <p className="text-[11px] text-gray-500">
                {labels.updatedAt.replace(
                  "{time}",
                  new Date(current.fetchedAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                )}
                {refreshing ? ` · ${labels.refreshing}` : ""}
              </p>
            ) : null}

            {current && (
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  ["24h", current.totals.value24h, current.totals.change1d],
                  ["7d", current.totals.value7d, current.totals.change7d],
                  ["30d", current.totals.value30d, current.totals.change1m],
                ].map(([label, value, change]) => (
                  <div key={String(label)} className="rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-gray-500">
                      {labels.totals} · {label}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-white">
                      {formatDefiLlamaUsd(Number(value))}
                    </p>
                    <p className={`mt-0.5 text-xs ${changeClass(change as number | null | undefined)}`}>
                      {formatDefiLlamaPct(change as number | null | undefined)}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{error}</p>
              </div>
            )}
          </div>

          {loading && !current ? (
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-8 text-sm text-gray-400">
              <RefreshCw className="h-4 w-4 animate-spin" />
              {labels.loading}
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 bg-black/20 px-3 py-8 text-center text-sm text-gray-400">
              {labels.empty}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-white/10">
              <table className="min-w-full text-left text-xs">
                <thead className="sticky top-0 z-10 bg-[#101821] text-[11px] uppercase tracking-wide text-gray-500 shadow-[inset_0_-1px_0_rgba(255,255,255,0.08)]">
                  <tr>
                    <th className="px-3 py-2 font-semibold">{labels.rank}</th>
                    <SortableHeader
                      label={labels.name}
                      active={sortKey === "name"}
                      direction={sortDirection}
                      onClick={() => toggleSort("name")}
                    />
                    {showToken && (
                      <SortableHeader
                        label={labels.token}
                        active={sortKey === "token"}
                        direction={sortDirection}
                        onClick={() => toggleSort("token")}
                      />
                    )}
                    <SortableHeader
                      label={valueLabel}
                      active={sortKey === "value"}
                      direction={sortDirection}
                      onClick={() => toggleSort("value")}
                    />
                    <SortableHeader
                      label={labels.change1d}
                      active={sortKey === "change1d"}
                      direction={sortDirection}
                      onClick={() => toggleSort("change1d")}
                    />
                    <SortableHeader
                      label={labels.change7d}
                      active={sortKey === "change7d"}
                      direction={sortDirection}
                      onClick={() => toggleSort("change7d")}
                    />
                    {showChains && (
                      <SortableHeader
                        label={labels.chains}
                        active={sortKey === "chains"}
                        direction={sortDirection}
                        onClick={() => toggleSort("chains")}
                      />
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row, index) => (
                    <RankingRow
                      key={row.id}
                      row={row}
                      rank={index + 1}
                      period={period}
                      showToken={showToken}
                      showCategoryInline={showCategoryFilter}
                      showChains={showChains}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
          <section className="mx-auto max-w-4xl overflow-hidden rounded-lg border border-white/10 bg-white/[0.025]">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2.5 md:px-4">
              <Bot className="h-4 w-4 text-sky-300" />
              <h3 className="text-sm font-semibold text-gray-100">{labels.aiTitle}</h3>
              <span className="rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[10px] text-gray-500">
                {aiProvider.kind === "local"
                  ? labels.localProvider
                  : `DSH · ${researchAiProviderPreset(aiProvider.kind).label || aiProvider.kind}`}
              </span>
              <span className="mr-auto" />
              <button
                type="button"
                onClick={() => setAiConfigOpen((open) => !open)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-white/10 hover:text-white"
                title={labels.aiSettings}
                aria-label={labels.aiSettings}
                aria-expanded={aiConfigOpen}
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            </div>

            {aiConfigOpen && (
              <div className="border-b border-white/10 bg-black/15 px-3 py-3 md:px-4">
                {aiConfiguration}
              </div>
            )}

            <div className="border-b border-white/10 px-3 py-3 md:px-4">
              <p className="mb-2 text-xs leading-5 text-gray-500">
                {labels.aiHint} {labels.aiContextHint}
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void askAi();
                }}
                className="flex items-end gap-2"
              >
                <textarea
                  value={aiQuestion}
                  onChange={(event) => setAiQuestion(event.target.value.slice(0, 2_000))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void askAi();
                    }
                  }}
                  rows={4}
                  placeholder={labels.aiPlaceholder}
                  className="min-h-24 min-w-0 flex-1 resize-y rounded-md border border-white/10 bg-black/25 px-3 py-2 text-sm leading-5 text-gray-100 outline-none placeholder:text-gray-600 focus:border-sky-300/30"
                />

                <button
                  type="submit"
                  disabled={aiBusy || !aiQuestion.trim()}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-sky-300 px-3 text-xs font-semibold text-zinc-950 hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {aiBusy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  {aiBusy ? labels.aiBusy : labels.aiAsk}
                </button>
              </form>

              {aiError && <p className="mt-2 text-xs text-red-300">{aiError}</p>}
            </div>

            {aiResult ? (
              <div className="space-y-2 px-3 py-4 md:px-4">
                <div className="flex items-center gap-2 text-[11px] text-gray-500">
                  <Bot className="h-3.5 w-3.5 text-sky-300" />
                  {aiResult.local_only ? labels.localProvider : `DSH Agent · ${researchAiProviderPreset(aiProvider.kind).label}`}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6 text-gray-100">{aiResult.answer}</p>
                {aiResult.tools_used && aiResult.tools_used.length > 0 && (
                  <p className="text-[11px] text-gray-500">
                    tools: {aiResult.tools_used.join(", ")}
                  </p>
                )}
              </div>
            ) : (
              !aiBusy && (
                <div className="flex min-h-44 flex-col items-center justify-center px-6 text-center text-gray-600">
                  <Sparkles className="h-7 w-7" />
                  <p className="mt-2 text-sm">{labels.aiEmpty}</p>
                </div>
              )
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function SortableHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: DefiLlamaSortDirection;
  onClick: () => void;
}) {
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      className="px-3 py-2 font-semibold"
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-gray-200 ${
          active ? "text-white" : "text-gray-500"
        }`}
      >
        <span>{label}</span>
        <Icon className="h-3 w-3 opacity-80" />
      </button>
    </th>
  );
}

function RankingRow({
  row,
  rank,
  period,
  showToken,
  showCategoryInline,
  showChains,
}: {
  row: DefiLlamaRankingRow;
  rank: number;
  period: DefiLlamaPeriod;
  showToken: boolean;
  showCategoryInline: boolean;
  showChains: boolean;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = Boolean(row.logo) && !logoFailed;

  useEffect(() => {
    setLogoFailed(false);
  }, [row.id, row.logo]);

  return (
    <tr className="border-t border-white/5 hover:bg-white/[0.03]">
      <td className="px-3 py-2 align-middle text-gray-500">{rank}</td>
      <td className="px-3 py-2 align-middle font-medium text-gray-100">
        <div className="flex min-w-0 items-center gap-2">
          {showLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.logo || undefined}
              alt=""
              className="h-5 w-5 shrink-0 rounded-full bg-white/10 object-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] text-gray-400">
              {row.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-gray-100">{row.name}</p>
            {showCategoryInline && row.category ? (
              <p className="truncate text-[11px] text-gray-500">{row.category}</p>
            ) : null}
          </div>
        </div>
      </td>
      {showToken && (
        <td className="px-3 py-2 align-middle font-medium text-cyan-100/90">
          {formatProtocolTokenLabel(row.tokenName, row.tokenSymbol)}
        </td>
      )}
      <td className="px-3 py-2 align-middle font-semibold text-white">
        {formatDefiLlamaUsd(rankingValueForPeriod(row, period))}
      </td>
      <td className={`px-3 py-2 align-middle ${changeClass(row.change1d)}`}>
        {formatDefiLlamaPct(row.change1d)}
      </td>
      <td className={`px-3 py-2 align-middle ${changeClass(row.change7d)}`}>
        {formatDefiLlamaPct(row.change7d)}
      </td>
      {showChains && (
        <td className="px-3 py-2 align-middle">
          <ChainIconStack chains={row.chains || []} />
        </td>
      )}
    </tr>
  );
}

function ChainIconStack({ chains, max = 6 }: { chains: string[]; max?: number }) {
  if (chains.length === 0) {
    return <span className="text-gray-500">-</span>;
  }
  const visible = chains.slice(0, max);
  const rest = chains.length - visible.length;

  return (
    <div className="flex items-center" title={chains.join(", ")}>
      {visible.map((chain, index) => (
        <ChainIcon
          key={`${chain}-${index}`}
          chain={chain}
          className={index === 0 ? "" : "-ml-1.5"}
        />
      ))}
      {rest > 0 && (
        <span className="ml-1 rounded bg-white/10 px-1 py-0.5 text-[10px] font-semibold text-gray-300">
          +{rest}
        </span>
      )}
    </div>
  );
}

function ChainIcon({ chain, className = "" }: { chain: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const label = chain.trim() || "?";

  if (failed) {
    return (
      <span
        title={label}
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#101821] bg-white/10 text-[9px] font-semibold text-gray-300 ${className}`}
      >
        {label.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={chainLogoUrl(chain)}
      alt={label}
      title={label}
      className={`h-5 w-5 shrink-0 rounded-full border border-[#101821] bg-[#101821] object-cover ${className}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
