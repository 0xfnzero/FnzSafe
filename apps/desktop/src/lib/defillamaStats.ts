export type DefiLlamaStatsView =
  | "chain-volume"
  | "chain-revenue"
  | "protocol-volume"
  | "protocol-revenue"
  | "ai";

export type DefiLlamaDataView = Exclude<DefiLlamaStatsView, "ai">;

export const DEFILLAMA_DATA_VIEWS: readonly DefiLlamaDataView[] = [
  "chain-volume",
  "chain-revenue",
  "protocol-volume",
  "protocol-revenue",
];

export type DefiLlamaPeriod = "24h" | "7d" | "30d";

export interface DefiLlamaRankingRow {
  id: string;
  name: string;
  category?: string;
  chains?: string[];
  tokenName?: string | null;
  tokenSymbol?: string | null;
  value24h: number;
  value7d: number;
  value30d: number;
  change1d?: number | null;
  change7d?: number | null;
  change1m?: number | null;
  logo?: string | null;
  url?: string | null;
}

export interface DefiLlamaRankingsResult {
  view: DefiLlamaDataView;
  fetchedAt: number;
  totals: {
    value24h: number;
    value7d: number;
    value30d: number;
    change1d?: number | null;
    change7d?: number | null;
    change1m?: number | null;
  };
  rows: DefiLlamaRankingRow[];
}

type OverviewPayload = {
  total24h?: number;
  total7d?: number;
  total30d?: number;
  change_1d?: number;
  change_7d?: number;
  change_1m?: number;
  protocols?: OverviewProtocol[];
};

type OverviewProtocol = {
  name?: string;
  displayName?: string;
  slug?: string;
  module?: string;
  category?: string;
  chains?: string[];
  logo?: string;
  url?: string;
  total24h?: number;
  total48hto24h?: number;
  total7d?: number;
  total14dto7d?: number;
  total30d?: number;
  change_1d?: number;
  change_7d?: number;
  change_1m?: number;
  breakdown24h?: Record<string, number | Record<string, number>>;
  breakdown30d?: Record<string, number | Record<string, number>>;
};

const DEX_OVERVIEW_URL =
  "https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";
const REVENUE_OVERVIEW_URL =
  "https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyRevenue";
const PROTOCOLS_META_URL = "https://api.llama.fi/protocols";

type ProtocolTokenMeta = {
  tokenName: string | null;
  tokenSymbol: string | null;
};

let protocolTokenMetaCache: Map<string, ProtocolTokenMeta> | null = null;
let protocolTokenMetaPromise: Promise<Map<string, ProtocolTokenMeta>> | null = null;

function cleanTokenSymbol(value: unknown): string | null {
  const symbol = String(value || "").trim();
  if (!symbol || symbol === "-" || symbol === "—" || symbol.toLowerCase() === "n/a") return null;
  return symbol;
}

function prettyTokenNameFromSlug(slug: string): string {
  return String(slug || "")
    .trim()
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatProtocolTokenLabel(
  tokenName?: string | null,
  tokenSymbol?: string | null,
): string {
  const symbol = cleanTokenSymbol(tokenSymbol);
  const name = String(tokenName || "").trim() || null;
  if (name && symbol) {
    if (name.toUpperCase() === symbol.toUpperCase()) return symbol;
    return `${name} (${symbol})`;
  }
  if (symbol) return symbol;
  if (name) return name;
  return "-";
}

async function loadProtocolTokenMeta(): Promise<Map<string, ProtocolTokenMeta>> {
  if (protocolTokenMetaCache) return protocolTokenMetaCache;
  if (!protocolTokenMetaPromise) {
    protocolTokenMetaPromise = (async () => {
      const response = await fetch(PROTOCOLS_META_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`DeFiLlama protocols request failed (${response.status})`);
      }
      const payload = (await response.json()) as Array<{
        name?: string;
        slug?: string;
        module?: string;
        symbol?: string;
        parentProtocolSlug?: string;
      }>;
      const map = new Map<string, ProtocolTokenMeta>();
      for (const item of Array.isArray(payload) ? payload : []) {
        const symbol = cleanTokenSymbol(item.symbol);
        const parentSlug = String(item.parentProtocolSlug || "").trim();
        const tokenName = parentSlug
          ? prettyTokenNameFromSlug(parentSlug)
          : symbol
            ? String(item.name || "").trim() || null
            : null;
        const meta: ProtocolTokenMeta = { tokenName, tokenSymbol: symbol };
        for (const key of [item.slug, item.module, item.name]) {
          const normalized = String(key || "").trim().toLowerCase();
          if (normalized) map.set(normalized, meta);
        }
      }
      protocolTokenMetaCache = map;
      return map;
    })().catch((error) => {
      protocolTokenMetaPromise = null;
      throw error;
    });
  }
  return protocolTokenMetaPromise;
}

function asFiniteNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function breakdownSum(value: number | Record<string, number> | undefined): number {
  if (typeof value === "number") return asFiniteNumber(value);
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((sum, item) => sum + asFiniteNumber(item), 0);
}

function displayName(protocol: OverviewProtocol): string {
  return String(protocol.displayName || protocol.name || protocol.slug || protocol.module || "Unknown").trim();
}

function protocolId(protocol: OverviewProtocol): string {
  return String(protocol.slug || protocol.module || protocol.name || displayName(protocol))
    .trim()
    .toLowerCase();
}

function prettyChainName(chain: string): string {
  const raw = String(chain || "").trim();
  if (!raw) return "Unknown";
  const key = raw.toLowerCase();
  const aliases: Record<string, string> = {
    bsc: "BSC",
    avax: "Avalanche",
    era: "zkSync Era",
    zksync: "zkSync Era",
    xdai: "Gnosis",
    off_chain: "Off Chain",
    hyperliquid: "Hyperliquid",
    robinhood: "Robinhood",
    op_bnb: "opBNB",
    opbnb: "opBNB",
  };
  if (aliases[key]) return aliases[key];
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const CHAIN_LOGO_ALIASES: Record<string, string> = {
  avax: "avalanche",
  avalanche: "avalanche",
  era: "zksync era",
  zksync: "zksync era",
  "zksync era": "zksync era",
  binance: "bsc",
  bnb: "bsc",
  "op mainnet": "optimism",
  optimism: "optimism",
  "polygon zkevm": "polygon zkevm",
  "hyperliquid l1": "hyperliquid",
  hyperliquid: "hyperliquid",
  "robinhood chain": "robinhood",
  robinhood: "robinhood",
  "off chain": "off chain",
};

export function chainLogoUrl(chain: string): string {
  const raw = String(chain || "").trim().toLowerCase();
  const mapped = CHAIN_LOGO_ALIASES[raw] || raw.replace(/_/g, " ");
  return `https://icons.llamao.fi/icons/chains/rsz_${mapped}?w=48&h=48`;
}

export function normalizeDefiLlamaLogoUrl(url: string | null | undefined, fallbackSlug?: string): string | null {
  const raw = String(url || "").trim();
  if (raw) {
    try {
      const parsed = new URL(raw);
      parsed.pathname = parsed.pathname
        .split("/")
        .map((segment, index) => (index === 0 ? segment : encodeURIComponent(decodeURIComponent(segment))))
        .join("/");
      if (!parsed.searchParams.has("w")) {
        parsed.searchParams.set("w", "48");
        parsed.searchParams.set("h", "48");
      }
      // Broken historical chain asset paths often 404; prefer protocol icon slug when available.
      if (/\/chains\//i.test(parsed.pathname) && fallbackSlug) {
        return `https://icons.llamao.fi/icons/protocols/${fallbackSlug}?w=48&h=48`;
      }
      return parsed.toString();
    } catch {
      // fall through to slug
    }
  }
  if (fallbackSlug) {
    return `https://icons.llamao.fi/icons/protocols/${fallbackSlug}?w=48&h=48`;
  }
  return null;
}

async function fetchOverview(url: string): Promise<OverviewPayload> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`DeFiLlama request failed (${response.status})`);
  }
  return (await response.json()) as OverviewPayload;
}

function protocolRows(
  protocols: OverviewProtocol[],
  tokenMeta: Map<string, ProtocolTokenMeta>,
): DefiLlamaRankingRow[] {
  return protocols
    .map((protocol) => {
      const name = displayName(protocol);
      const value24h = asFiniteNumber(protocol.total24h);
      const value7d = asFiniteNumber(protocol.total7d);
      const value30d = asFiniteNumber(protocol.total30d);
      if (value24h <= 0 && value7d <= 0 && value30d <= 0) return null;
      const id = protocolId(protocol);
      const meta =
        tokenMeta.get(id) ||
        tokenMeta.get(String(protocol.slug || "").toLowerCase()) ||
        tokenMeta.get(String(protocol.name || "").toLowerCase()) ||
        tokenMeta.get(name.toLowerCase());
      return {
        id,
        name,
        category: protocol.category ? String(protocol.category) : undefined,
        chains: Array.isArray(protocol.chains)
          ? protocol.chains.map((item) => String(item)).filter(Boolean)
          : undefined,
        tokenName: meta?.tokenName || null,
        tokenSymbol: meta?.tokenSymbol || null,
        value24h,
        value7d,
        value30d,
        change1d: protocol.change_1d ?? null,
        change7d: protocol.change_7d ?? null,
        change1m: protocol.change_1m ?? null,
        logo: normalizeDefiLlamaLogoUrl(protocol.logo, id),
        url: protocol.url || null,
      } satisfies DefiLlamaRankingRow;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.value24h - a.value24h);
}

function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

type ChainAccumulator = DefiLlamaRankingRow & {
  prev24h: number;
  prev7d: number;
};

function emptyChainRow(key: string): ChainAccumulator {
  return {
    id: key,
    name: prettyChainName(key),
    value24h: 0,
    value7d: 0,
    value30d: 0,
    prev24h: 0,
    prev7d: 0,
    logo: chainLogoUrl(key),
  };
}

function chainRowsFromProtocols(protocols: OverviewProtocol[]): DefiLlamaRankingRow[] {
  const map = new Map<string, ChainAccumulator>();

  for (const protocol of protocols) {
    const breakdown24h = protocol.breakdown24h || {};
    const breakdown30d = protocol.breakdown30d || {};
    const chainKeys = new Set([...Object.keys(breakdown24h), ...Object.keys(breakdown30d)]);
    const protocolDay = asFiniteNumber(protocol.total24h);
    const protocolWeek = asFiniteNumber(protocol.total7d);
    const protocolPrevDay = asFiniteNumber(protocol.total48hto24h);
    const protocolPrevWeek = asFiniteNumber(protocol.total14dto7d);

    if (chainKeys.size === 0 && Array.isArray(protocol.chains) && protocol.chains.length > 0) {
      const share = 1 / protocol.chains.length;
      for (const chain of protocol.chains) {
        const key = String(chain).toLowerCase();
        const current = map.get(key) || emptyChainRow(key);
        current.value24h += protocolDay * share;
        current.value7d += protocolWeek * share;
        current.value30d += asFiniteNumber(protocol.total30d) * share;
        current.prev24h += protocolPrevDay * share;
        current.prev7d += protocolPrevWeek * share;
        map.set(key, current);
      }
      continue;
    }

    for (const chain of chainKeys) {
      const key = String(chain).toLowerCase();
      const current = map.get(key) || emptyChainRow(key);
      const day = breakdownSum(breakdown24h[chain]);
      const month = breakdownSum(breakdown30d[chain]);
      current.value24h += day;
      current.value30d += month;
      const dayShare = protocolDay > 0 && day > 0 ? day / protocolDay : 0;
      if (dayShare > 0) {
        current.value7d += protocolWeek * dayShare;
        current.prev24h += protocolPrevDay * dayShare;
        current.prev7d += protocolPrevWeek * dayShare;
      }
      map.set(key, current);
    }
  }

  return [...map.values()]
    .filter((row) => row.value24h > 0 || row.value7d > 0 || row.value30d > 0)
    .map((row) => ({
      id: row.id,
      name: row.name,
      value24h: row.value24h,
      value7d: row.value7d,
      value30d: row.value30d,
      change1d: percentChange(row.value24h, row.prev24h),
      change7d: percentChange(row.value7d, row.prev7d),
      logo: row.logo,
    }))
    .sort((a, b) => b.value24h - a.value24h);
}

export function rankingValueForPeriod(row: DefiLlamaRankingRow, period: DefiLlamaPeriod): number {
  if (period === "7d") return row.value7d;
  if (period === "30d") return row.value30d;
  return row.value24h;
}

export function sortRankingsByPeriod(
  rows: DefiLlamaRankingRow[],
  period: DefiLlamaPeriod,
): DefiLlamaRankingRow[] {
  return [...rows].sort((a, b) => rankingValueForPeriod(b, period) - rankingValueForPeriod(a, period));
}

export type DefiLlamaSortKey = "name" | "token" | "category" | "chains" | "value" | "change1d" | "change7d";
export type DefiLlamaSortDirection = "asc" | "desc";

function nullableNumber(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

export function compareRankingRows(
  a: DefiLlamaRankingRow,
  b: DefiLlamaRankingRow,
  key: DefiLlamaSortKey,
  period: DefiLlamaPeriod,
  direction: DefiLlamaSortDirection,
): number {
  const dir = direction === "asc" ? 1 : -1;
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name) * dir;
    case "token":
      return formatProtocolTokenLabel(a.tokenName, a.tokenSymbol)
        .localeCompare(formatProtocolTokenLabel(b.tokenName, b.tokenSymbol)) * dir;
    case "category":
      return (a.category || "").localeCompare(b.category || "") * dir;
    case "chains":
      return (a.chains?.join(",") || "").localeCompare(b.chains?.join(",") || "") * dir;
    case "value":
      return (rankingValueForPeriod(a, period) - rankingValueForPeriod(b, period)) * dir;
    case "change1d":
    case "change7d": {
      const left = nullableNumber(key === "change1d" ? a.change1d : a.change7d);
      const right = nullableNumber(key === "change1d" ? b.change1d : b.change7d);
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return (left - right) * dir;
    }
    default:
      return 0;
  }
}

export function sortRankingsByColumn(
  rows: DefiLlamaRankingRow[],
  key: DefiLlamaSortKey,
  period: DefiLlamaPeriod,
  direction: DefiLlamaSortDirection,
): DefiLlamaRankingRow[] {
  return [...rows].sort((a, b) => compareRankingRows(a, b, key, period, direction));
}

export function formatDefiLlamaUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatDefiLlamaPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export async function fetchDefiLlamaRankings(
  view: Exclude<DefiLlamaStatsView, "ai">,
): Promise<DefiLlamaRankingsResult> {
  const isVolume = view === "chain-volume" || view === "protocol-volume";
  const isProtocolView = view === "protocol-volume" || view === "protocol-revenue";
  const [payload, tokenMeta] = await Promise.all([
    fetchOverview(isVolume ? DEX_OVERVIEW_URL : REVENUE_OVERVIEW_URL),
    isProtocolView ? loadProtocolTokenMeta().catch(() => new Map<string, ProtocolTokenMeta>()) : Promise.resolve(new Map<string, ProtocolTokenMeta>()),
  ]);
  const protocols = Array.isArray(payload.protocols) ? payload.protocols : [];
  const rows =
    view === "chain-volume" || view === "chain-revenue"
      ? chainRowsFromProtocols(protocols)
      : protocolRows(protocols, tokenMeta);

  return {
    view,
    fetchedAt: Date.now(),
    totals: {
      value24h: asFiniteNumber(payload.total24h),
      value7d: asFiniteNumber(payload.total7d),
      value30d: asFiniteNumber(payload.total30d),
      change1d: payload.change_1d ?? null,
      change7d: payload.change_7d ?? null,
      change1m: payload.change_1m ?? null,
    },
    rows,
  };
}

export function buildDefiLlamaAiContext(
  view: Exclude<DefiLlamaStatsView, "ai">,
  period: DefiLlamaPeriod,
  rows: DefiLlamaRankingRow[],
  limit = 15,
): string {
  const ranked = sortRankingsByPeriod(rows, period).slice(0, limit);
  const lines = ranked.map((row, index) => {
    const value = formatDefiLlamaUsd(rankingValueForPeriod(row, period));
    const category = row.category ? ` category=${row.category}` : "";
    const token = formatProtocolTokenLabel(row.tokenName, row.tokenSymbol);
    const tokenPart = token !== "-" ? ` token=${token}` : "";
    const chains = row.chains?.length ? ` chains=${row.chains.slice(0, 4).join("|")}` : "";
    return `${index + 1}. ${row.name}: ${value}${tokenPart}${category}${chains}`;
  });
  return [
    `DeFiLlama snapshot view=${view} period=${period}`,
    "Use these rankings as evidence. Prefer DeFiLlama MCP tools for fresh lookups when needed.",
    ...lines,
  ].join("\n");
}

export const DEFILLAMA_STATS_CACHE_KEY = "fnzero-safe.defillama-stats.v1";

type DefiLlamaStatsCacheStore = {
  version: 1;
  views: Partial<Record<DefiLlamaDataView, DefiLlamaRankingsResult>>;
};

export interface DefiLlamaRankingsDatabaseRecord {
  view: string;
  payloadJson: string;
  fetchedAtMs: number;
  updatedAtMs: number;
}

export function isDefiLlamaRankingsResult(value: unknown): value is DefiLlamaRankingsResult {
  if (!value || typeof value !== "object") return false;
  const record = value as DefiLlamaRankingsResult;
  return DEFILLAMA_DATA_VIEWS.includes(record.view)
    && Number.isFinite(record.fetchedAt)
    && Array.isArray(record.rows)
    && Boolean(record.totals)
    && typeof record.totals === "object";
}

export function mergeDefiLlamaRankingsCaches(
  current: Partial<Record<DefiLlamaDataView, DefiLlamaRankingsResult>>,
  incoming: Partial<Record<DefiLlamaDataView, DefiLlamaRankingsResult>>,
): Partial<Record<DefiLlamaDataView, DefiLlamaRankingsResult>> {
  const next = { ...current };
  for (const view of DEFILLAMA_DATA_VIEWS) {
    const candidate = incoming[view];
    if (candidate && (!next[view] || candidate.fetchedAt > next[view]!.fetchedAt)) {
      next[view] = candidate;
    }
  }
  return next;
}

export function rankingsCacheFromDatabaseRecords(
  records: DefiLlamaRankingsDatabaseRecord[],
): Partial<Record<DefiLlamaDataView, DefiLlamaRankingsResult>> {
  const next: Partial<Record<DefiLlamaDataView, DefiLlamaRankingsResult>> = {};
  for (const record of records) {
    if (!DEFILLAMA_DATA_VIEWS.includes(record.view as DefiLlamaDataView)) continue;
    try {
      const parsed = JSON.parse(record.payloadJson) as unknown;
      if (
        isDefiLlamaRankingsResult(parsed)
        && parsed.view === record.view
        && parsed.fetchedAt === record.fetchedAtMs
      ) {
        next[parsed.view] = parsed;
      }
    } catch {
      // Ignore a corrupt snapshot and allow the background refresh to repair it.
    }
  }
  return next;
}

export function readDefiLlamaRankingsCache(): Partial<
  Record<DefiLlamaDataView, DefiLlamaRankingsResult>
> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DEFILLAMA_STATS_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DefiLlamaStatsCacheStore;
    if (!parsed || parsed.version !== 1 || !parsed.views || typeof parsed.views !== "object") {
      return {};
    }
    const next: Partial<Record<DefiLlamaDataView, DefiLlamaRankingsResult>> = {};
    for (const [key, value] of Object.entries(parsed.views)) {
      if (isDefiLlamaRankingsResult(value) && value.view === key) {
        next[key as DefiLlamaDataView] = value;
      }
    }
    return next;
  } catch {
    return {};
  }
}

export function writeDefiLlamaRankingsCache(
  view: Exclude<DefiLlamaStatsView, "ai">,
  result: DefiLlamaRankingsResult,
): void {
  if (typeof window === "undefined") return;
  try {
    const current = readDefiLlamaRankingsCache();
    const store: DefiLlamaStatsCacheStore = {
      version: 1,
      views: {
        ...current,
        [view]: result,
      },
    };
    window.localStorage.setItem(DEFILLAMA_STATS_CACHE_KEY, JSON.stringify(store));
  } catch {
    // Ignore quota / private mode failures; in-memory cache still works.
  }
}
