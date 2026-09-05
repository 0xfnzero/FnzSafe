export type TokenMarketSortKey =
  | "token"
  | "price"
  | "marketCap"
  | "liquidity"
  | "change5m"
  | "change1h"
  | "change6h"
  | "change24h"
  | "mentions"
  | "kolMentions"
  | "chain"
  | "marketSource"
  | "updated";

export type TokenMarketSortDirection = "asc" | "desc";

export interface TokenMarketSort {
  key: TokenMarketSortKey;
  direction: TokenMarketSortDirection;
}

export interface SortableTokenMarketRow {
  id: number;
  symbol: string;
  name?: string | null;
  chain: string;
  market_source?: string | null;
  price_usd?: number | null;
  market_cap_usd?: number | null;
  liquidity_usd?: number | null;
  volume_5m_usd?: number | null;
  volume_1h_usd?: number | null;
  volume_6h_usd?: number | null;
  volume_24h_usd?: number | null;
  price_change_5m_percent?: number | null;
  price_change_1h_percent?: number | null;
  price_change_6h_percent?: number | null;
  price_change_24h_percent?: number | null;
  market_updated_at_ms?: number | null;
  mention_count: number;
  kol_mention_count: number;
  latest_mention_at_ms: number;
}

export const DEFAULT_TOKEN_MARKET_SORT: TokenMarketSort = {
  key: "updated",
  direction: "desc",
};

const USD_COMPACT_SUFFIXES = ["", "K", "M", "B", "T"] as const;

export function formatTokenMarketUsd(
  value: number | null | undefined,
  locale: string,
): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "--";
  if (value < 0.01) return `$${value.toPrecision(4)}`;

  let unitIndex = value >= 1_000
    ? Math.min(Math.floor(Math.log10(value) / 3), USD_COMPACT_SUFFIXES.length - 1)
    : 0;
  let scaled = value / (1_000 ** unitIndex);
  if (unitIndex > 0
    && unitIndex < USD_COMPACT_SUFFIXES.length - 1
    && Number(scaled.toFixed(2)) >= 1_000) {
    unitIndex += 1;
    scaled = value / (1_000 ** unitIndex);
  }
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: scaled < 1 ? 4 : 2,
  }).format(scaled);
  return `$${formatted}${USD_COMPACT_SUFFIXES[unitIndex]}`;
}

const ASCENDING_DEFAULT_KEYS = new Set<TokenMarketSortKey>([
  "token",
  "chain",
  "marketSource",
]);

export function nextTokenMarketSort(
  current: TokenMarketSort,
  key: TokenMarketSortKey,
): TokenMarketSort {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: ASCENDING_DEFAULT_KEYS.has(key) ? "asc" : "desc" };
}

function compareValues(
  left: number | string | null | undefined,
  right: number | string | null | undefined,
  direction: TokenMarketSortDirection,
  collator: Intl.Collator,
): number {
  const leftMissing = left == null || (typeof left === "number" && !Number.isFinite(left)) || left === "";
  const rightMissing = right == null || (typeof right === "number" && !Number.isFinite(right)) || right === "";
  if (leftMissing || rightMissing) {
    if (leftMissing === rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }

  let comparison: number;
  if (typeof left === "string" && typeof right === "string") {
    comparison = collator.compare(left, right);
  } else if (Number(left) === Number(right)) {
    comparison = 0;
  } else {
    comparison = Number(left) < Number(right) ? -1 : 1;
  }
  return direction === "asc" ? comparison : -comparison;
}

function sortValue(row: SortableTokenMarketRow, key: TokenMarketSortKey): number | string | null | undefined {
  switch (key) {
    case "token": return row.symbol;
    case "price": return row.price_usd;
    case "marketCap": return row.market_cap_usd;
    case "liquidity": return row.liquidity_usd;
    case "change5m": return row.price_change_5m_percent;
    case "change1h": return row.price_change_1h_percent;
    case "change6h": return row.price_change_6h_percent;
    case "change24h": return row.price_change_24h_percent;
    case "mentions": return row.mention_count;
    case "kolMentions": return row.kol_mention_count;
    case "chain": return row.chain;
    case "marketSource": return row.market_source;
    case "updated": return row.market_updated_at_ms ?? row.latest_mention_at_ms;
  }
}

export function sortTokenMarketRows<T extends SortableTokenMarketRow>(
  rows: readonly T[],
  sort: TokenMarketSort,
  locale: string,
): T[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  return [...rows].sort((left, right) => (
    compareValues(sortValue(left, sort.key), sortValue(right, sort.key), sort.direction, collator)
    || left.id - right.id
  ));
}
