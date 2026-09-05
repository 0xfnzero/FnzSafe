import type { StoredTwitterSignal } from "./twitterSignals.ts";

export const FOMO_ALERT_TYPES = [
  "swap_buy",
  "swap_sell",
  "transfer_in",
  "transfer_out",
  "multi_user_buy",
  "multi_user_sell",
  "thesis_created",
] as const;

export type FomoAlertType = (typeof FOMO_ALERT_TYPES)[number];
export type FomoTradeAlertType = Exclude<FomoAlertType, "thesis_created">;
export type FomoSignalDirection = "buy" | "sell" | "transfer_in" | "transfer_out";

export interface CapturedFomoAlert {
  id: string;
  event_type: FomoAlertType;
  chain: string;
  token_address: string;
  ticker?: string | null;
  user_handle?: string | null;
  display_name?: string | null;
  profile_picture_url?: string | null;
  follower_count?: number | null;
  trade_id?: string | null;
  usd_amount?: number | null;
  market_cap?: number | null;
  trader_count?: number | null;
  thesis?: string | null;
  thesis_id?: string | null;
  source_url: string;
  created_at_ms: number;
}

export interface FomoTokenSignal extends StoredTwitterSignal {
  signalSource: "fomo";
  fomoEventType: FomoAlertType;
  tradeDirection?: FomoSignalDirection;
  usdAmount?: number;
  marketCapUsd?: number;
  traderCount?: number;
  followerCount?: number;
}

export type FomoSignalTextPartKind = "plain" | "direction" | "amount" | "token" | "market_cap" | "chain";

export interface FomoSignalTextPart {
  kind: FomoSignalTextPartKind;
  text: string;
}

const ALERT_TYPE_SET = new Set<string>(FOMO_ALERT_TYPES);
const FOMO_NETWORK_SLUGS = new Map<string, string>([
  ["Solana", "solana"],
  ["Ethereum", "ethereum"],
  ["BSC", "bnb"],
  ["Base", "base"],
  ["Monad", "monad"],
  ["Robinhood", "robinhood"],
  ["HyperEVM", "hyperliquid"],
]);
const FOMO_TOKEN_PATH_RE = /^\/tokens\/(solana|ethereum|bnb|base|monad|robinhood|hyperliquid)\/([^/]+)\/?$/u;
const EVM_TOKEN_ADDRESS_RE = /^0x[a-f0-9]{40}$/iu;
const SOLANA_TOKEN_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validFomoTokenAddress(networkSlug: string, address: string): boolean {
  return networkSlug === "solana"
    ? SOLANA_TOKEN_ADDRESS_RE.test(address)
    : EVM_TOKEN_ADDRESS_RE.test(address);
}

function parsedFomoTokenUrl(value: string | undefined): {
  url: URL;
  networkSlug: string;
  contractAddress: string;
} | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    const match = FOMO_TOKEN_PATH_RE.exec(url.pathname);
    if (
      url.protocol !== "https:"
      || url.hostname.toLowerCase() !== "fomo.family"
      || url.username
      || url.password
      || (url.port && url.port !== "443")
      || !match
      || !validFomoTokenAddress(match[1], decodeURIComponent(match[2]))
    ) return undefined;
    return {
      url,
      networkSlug: match[1],
      contractAddress: decodeURIComponent(match[2]),
    };
  } catch {
    return undefined;
  }
}

export function fomoTokenActionUrls(input: {
  sourceUrl?: string;
  chain: string;
  contractAddress?: string;
}): { fomoUrl?: string; swapUrl?: string } {
  const sourceUrl = parsedFomoTokenUrl(input.sourceUrl);
  const networkSlug = FOMO_NETWORK_SLUGS.get(input.chain);
  const contractAddress = input.contractAddress?.trim();
  const sourceMatchesSignal = sourceUrl
    && sourceUrl.networkSlug === networkSlug
    && (networkSlug === "solana"
      ? sourceUrl.contractAddress === contractAddress
      : sourceUrl.contractAddress.toLowerCase() === contractAddress?.toLowerCase());
  if (sourceMatchesSignal) {
    const swapUrl = new URL(sourceUrl.url.toString());
    swapUrl.search = "";
    swapUrl.hash = "";
    return { fomoUrl: sourceUrl.url.toString(), swapUrl: swapUrl.toString() };
  }

  if (!networkSlug || !contractAddress || !validFomoTokenAddress(networkSlug, contractAddress)) return {};
  const tokenUrl = `https://fomo.family/tokens/${networkSlug}/${encodeURIComponent(contractAddress)}`;
  return { fomoUrl: tokenUrl, swapUrl: tokenUrl };
}

export function signalSwapUrl(input: {
  signalSource?: "x" | "fomo";
  sourceUrl?: string;
  chain: string;
  contractAddress?: string;
}): string | undefined {
  if (input.signalSource === "fomo") return fomoTokenActionUrls(input).swapUrl;
  const contractAddress = input.contractAddress?.trim();
  if (input.chain !== "Solana" || !contractAddress || !SOLANA_TOKEN_ADDRESS_RE.test(contractAddress)) {
    return undefined;
  }
  return `https://jup.ag/swap/SOL-${encodeURIComponent(contractAddress)}`;
}

export function fomoAlertDirection(type: FomoTradeAlertType): FomoSignalDirection {
  if (type === "swap_buy" || type === "multi_user_buy") return "buy";
  if (type === "swap_sell" || type === "multi_user_sell") return "sell";
  return type;
}

export function formatCompactUsd(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return new Intl.NumberFormat("en-US", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000 ? 1 : 2,
  }).format(value);
}

export function fomoAlertTextParts(input: {
  type: FomoTradeAlertType;
  chain: string;
  ticker?: string;
  usdAmount?: number;
  marketCap?: number;
  traderCount?: number;
}): FomoSignalTextPart[] {
  const direction = fomoAlertDirection(input.type);
  const action = direction === "buy"
    ? "Buy"
    : direction === "sell"
      ? "Sell"
      : direction === "transfer_in"
        ? "Transfer in"
        : "Transfer out";
  const amount = formatCompactUsd(input.usdAmount);
  const marketCap = formatCompactUsd(input.marketCap);
  const subject = input.ticker ? `$${input.ticker}` : "token";
  const parts: FomoSignalTextPart[] = [];
  if (input.type.startsWith("multi_user_") && input.traderCount) {
    parts.push({ kind: "plain", text: `${input.traderCount} traders:` });
  }
  parts.push({ kind: "direction", text: action });
  if (amount) parts.push({ kind: "amount", text: `$${amount}` });
  parts.push({ kind: "token", text: subject });
  if (marketCap) parts.push({ kind: "market_cap", text: `at $${marketCap} market cap` });
  parts.push({ kind: "chain", text: `on ${input.chain}` });
  return parts;
}

function fomoAlertText(input: Parameters<typeof fomoAlertTextParts>[0]): string {
  return fomoAlertTextParts(input).map((part) => part.text).join(" ");
}

export function parseCapturedFomoAlerts(
  value: unknown,
  capturedAt = new Date(),
): FomoTokenSignal[] {
  if (!Array.isArray(value)) return [];
  const signals: FomoTokenSignal[] = [];
  for (const candidate of value.slice(0, 500)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const id = cleanString(item.id, 128);
    const eventType = cleanString(item.event_type, 32);
    const chain = cleanString(item.chain, 32);
    const contractAddress = cleanString(item.token_address, 128);
    const sourceUrl = cleanString(item.source_url, 2_048);
    if (!id || !eventType || !ALERT_TYPE_SET.has(eventType) || !chain || !contractAddress || !sourceUrl) continue;

    const createdAtMs = finiteNonNegative(item.created_at_ms);
    const publishedAt = new Date(createdAtMs ?? capturedAt.getTime());
    if (!Number.isFinite(publishedAt.getTime())) continue;
    const ticker = cleanString(item.ticker, 32)?.replace(/^\$+/u, "").toUpperCase();
    const handle = cleanString(item.user_handle, 80)?.replace(/^@+/u, "");
    const displayName = cleanString(item.display_name, 120);
    const usdAmount = finiteNonNegative(item.usd_amount);
    const marketCap = finiteNonNegative(item.market_cap);
    const traderCountValue = finiteNonNegative(item.trader_count);
    const traderCount = traderCountValue === undefined ? undefined : Math.max(1, Math.floor(traderCountValue));
    const followerCountValue = finiteNonNegative(item.follower_count);
    const followerCount = followerCountValue === undefined ? undefined : Math.floor(followerCountValue);
    const type = eventType as FomoAlertType;
    const thesis = cleanString(item.thesis, 4_000);
    if (type === "thesis_created" && !thesis) continue;
    const author = handle
      ? `@${handle}`
      : traderCount
        ? `${traderCount} traders`
        : "Fomo trader";

    signals.push({
      id: `fomo:${id}`,
      chain,
      contractAddress,
      tokenSymbols: ticker ? [`$${ticker}`] : undefined,
      author,
      authorName: displayName && displayName !== handle ? displayName : undefined,
      avatarUrl: cleanString(item.profile_picture_url, 2_048),
      tweetText: type === "thesis_created"
        ? thesis!
        : fomoAlertText({ type, chain, ticker, usdAmount, marketCap, traderCount }),
      sourceUrl,
      publishedAt: publishedAt.toISOString(),
      detectedAt: capturedAt.toISOString(),
      signalSource: "fomo",
      fomoEventType: type,
      tradeDirection: type === "thesis_created" ? undefined : fomoAlertDirection(type),
      usdAmount,
      marketCapUsd: marketCap,
      traderCount,
      followerCount,
    });
  }
  return signals;
}
