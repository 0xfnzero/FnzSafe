import { normalizePublicWebUrl } from "./publicWebUrl.ts";
import { isSolanaTokenAddress } from "./twitterChainDetection.ts";

const INLINE_TWEET_ENTITY_SOURCE = String.raw`(?:@[A-Za-z0-9_]{1,15}|\$[A-Za-z][A-Za-z0-9_]{0,14}|#[\p{L}\p{N}_]+)`;
export const MAX_STORED_TWITTER_SIGNALS = 1_000;
export const TWITTER_SIGNAL_RECENT_DAYS = 3;
export const TWITTER_SIGNAL_PAGE_SIZE = 100;
const TOKEN_RESOLUTION_RETRY_MS = 30_000;
const TOKEN_DISCOVERY_RETRY_MS = 5 * 60_000;

export interface StoredTwitterSignal {
  id: string;
  chain: string;
  contractAddress?: string;
  observedChain?: string;
  observedContractAddress?: string;
  tokenSymbols?: string[];
  author: string;
  authorName?: string;
  avatarUrl?: string;
  tweetText: string;
  links?: Array<{ target: string; display: string }>;
  sourceUrl?: string;
  tweetId?: string;
  publishedAt?: string;
  detectedAt: string;
  resolutionStatus?: "pending" | "resolved" | "conflicted";
  resolutionConfidence?: number;
  resolutionSource?: string;
}

export interface TokenSignalObservation {
  chain: string;
  contractAddress?: string;
}

export function hasAutomaticTokenResolution(signal: StoredTwitterSignal): boolean {
  return signal.resolutionStatus === "resolved" && Boolean(signal.resolutionSource);
}

export function tokenSignalObservation(signal: StoredTwitterSignal): TokenSignalObservation {
  if (signal.observedChain !== undefined || signal.observedContractAddress !== undefined) {
    return {
      chain: signal.observedChain ?? "Unknown",
      contractAddress: signal.observedContractAddress,
    };
  }
  return hasAutomaticTokenResolution(signal)
    ? { chain: "Unknown" }
    : { chain: signal.chain, contractAddress: signal.contractAddress };
}

function normalizedTokenSymbols(
  signal: Pick<StoredTwitterSignal, "tokenSymbols">,
  stripRepeatedPrefixes = false,
): Set<string> {
  const prefixPattern = stripRepeatedPrefixes ? /^\$+/u : /^\$/u;
  return new Set((signal.tokenSymbols || []).flatMap((value) => {
    const symbol = value.trim().replace(prefixPattern, "");
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/u.test(symbol) ? [symbol.toUpperCase()] : [];
  }));
}

export function hasValidTweetSignalIdentity(signal: StoredTwitterSignal): boolean {
  const handle = signal.author.trim().replace(/^@+/u, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/u.test(handle)) return false;
  const tweetId = signal.tweetId?.trim();
  if (tweetId && !/^\d{1,32}$/u.test(tweetId)) return false;
  if (!signal.sourceUrl) return true;
  const sourceIdentity = twitterStatusSourceIdentity(signal.sourceUrl);
  if (!sourceIdentity || sourceIdentity.author !== handle) return false;
  return !tweetId || sourceIdentity.id === tweetId;
}

export function isTokenResolutionTarget(signal: StoredTwitterSignal): boolean {
  if (!hasValidTweetSignalIdentity(signal) || hasAutomaticTokenResolution(signal)) return false;
  const observation = tokenSignalObservation(signal);
  if (observation.contractAddress) {
    const address = observation.contractAddress.trim();
    return /^0x[0-9a-f]{40}$/iu.test(address)
      || (observation.chain === "Solana" && isSolanaTokenAddress(address));
  }
  return normalizedTokenSymbols(signal).size === 1;
}

export function tokenResolutionRetryDelayMs(source?: string): number {
  return source === "no-candidate"
    || source === "candidate-ranking"
    || source === "symbol-or-chain-conflict"
    ? TOKEN_DISCOVERY_RETRY_MS
    : TOKEN_RESOLUTION_RETRY_MS;
}

function tweetSignalMergeKey(signal: StoredTwitterSignal): string {
  const observation = tokenSignalObservation(signal);
  const tokenIdentity = observation.contractAddress?.toLowerCase()
    || `cashtag:${(signal.tokenSymbols || []).join(",")}`;
  const sourceIdentity = canonicalTweetSourceIdentity(signal.sourceUrl, signal.tweetId)
    || `${signal.author.trim().replace(/^@/u, "").toLowerCase()}:${normalizeTweetSignalText(signal.tweetText)}`;
  return `${tokenIdentity}:${sourceIdentity}`;
}

function tweetSymbolSourceKey(signal: StoredTwitterSignal): string | undefined {
  const symbols = Array.from(normalizedTokenSymbols(signal)).sort();
  if (symbols.length === 0) return undefined;
  const sourceIdentity = canonicalTweetSourceIdentity(signal.sourceUrl, signal.tweetId)
    || `${signal.author.trim().replace(/^@/u, "").toLowerCase()}:${normalizeTweetSignalText(signal.tweetText)}`;
  return `${symbols.join(",")}:${sourceIdentity}`;
}

export function mergeTweetTokenSignals<T extends StoredTwitterSignal>(existing: T[], incoming: T[]): T[] {
  existing = expandAddresslessTokenSignals(existing);
  incoming = expandAddresslessTokenSignals(incoming);
  const existingByKey = new Map(existing.map((signal) => [tweetSignalMergeKey(signal), signal]));
  const addresslessBySymbol = new Map(existing.flatMap((signal) => {
    if (tokenSignalObservation(signal).contractAddress) return [];
    const key = tweetSymbolSourceKey(signal);
    return key ? [[key, signal] as const] : [];
  }));
  const merged = incoming.map((signal) => {
    const key = tweetSignalMergeKey(signal);
    const fallbackKey = tweetSymbolSourceKey(signal);
    const previous = existingByKey.get(key) || (fallbackKey ? addresslessBySymbol.get(fallbackKey) : undefined);
    if (previous) {
      existingByKey.delete(tweetSignalMergeKey(previous));
      const previousFallbackKey = tweetSymbolSourceKey(previous);
      if (previousFallbackKey && addresslessBySymbol.get(previousFallbackKey) === previous) {
        addresslessBySymbol.delete(previousFallbackKey);
      }
    }
    if (!previous) return signal;
    const observation = tokenSignalObservation(signal);
    const preserveResolution = hasAutomaticTokenResolution(previous)
      && (observation.chain === "Unknown" || observation.chain === "Unknown EVM");
    return {
      ...signal,
      id: previous.id,
      detectedAt: previous.detectedAt,
      ...(preserveResolution ? {
        chain: previous.chain,
        contractAddress: previous.contractAddress,
        observedChain: observation.chain,
        observedContractAddress: observation.contractAddress,
        resolutionStatus: previous.resolutionStatus,
        resolutionConfidence: previous.resolutionConfidence,
        resolutionSource: previous.resolutionSource,
      } : {}),
    };
  });
  for (const signal of existing) {
    if (existingByKey.has(tweetSignalMergeKey(signal))) merged.push(signal);
  }
  return sortTweetSignalsNewestFirst(filterRecentTweetSignals(merged)).slice(0, MAX_STORED_TWITTER_SIGNALS);
}

function storedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || undefined;
}

export function parseStoredTwitterSignals(value: unknown): StoredTwitterSignal[] {
  if (!Array.isArray(value)) return [];
  const signals: StoredTwitterSignal[] = [];
  for (const candidate of value.slice(0, MAX_STORED_TWITTER_SIGNALS)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const id = storedString(item.id, 256);
    const author = storedString(item.author, 80);
    const tweetText = storedString(item.tweetText, 4_000);
    const detectedAt = storedString(item.detectedAt, 64);
    if (!id || !author || !tweetText || !detectedAt || !Number.isFinite(Date.parse(detectedAt))) continue;
    const links = Array.isArray(item.links)
      ? item.links.slice(0, 32).flatMap((link) => {
        if (!link || typeof link !== "object" || Array.isArray(link)) return [];
        const record = link as Record<string, unknown>;
        const target = normalizePublicWebUrl(record.target);
        const display = storedString(record.display, 512);
        return target && display ? [{ target, display }] : [];
      })
      : undefined;
    const tokenSymbols = Array.isArray(item.tokenSymbols)
      ? item.tokenSymbols
        .filter((symbol): symbol is string => typeof symbol === "string")
        .map((symbol) => symbol.trim().slice(0, 24))
        .filter(Boolean)
        .slice(0, 32)
      : undefined;
    signals.push({
      id,
      chain: storedString(item.chain, 64) ?? "Unknown",
      author,
      tweetText,
      detectedAt,
      contractAddress: storedString(item.contractAddress, 128),
      observedChain: storedString(item.observedChain, 64),
      observedContractAddress: storedString(item.observedContractAddress, 128),
      tokenSymbols,
      authorName: storedString(item.authorName, 80),
      avatarUrl: normalizePublicWebUrl(item.avatarUrl),
      links,
      sourceUrl: normalizePublicWebUrl(item.sourceUrl),
      tweetId: storedString(item.tweetId, 64),
      publishedAt: storedString(item.publishedAt, 64),
      resolutionStatus: item.resolutionStatus === "pending"
        || item.resolutionStatus === "resolved"
        || item.resolutionStatus === "conflicted"
        ? item.resolutionStatus
        : undefined,
      resolutionConfidence: typeof item.resolutionConfidence === "number"
        && Number.isFinite(item.resolutionConfidence)
        ? Math.min(1, Math.max(0, item.resolutionConfidence))
        : undefined,
      resolutionSource: storedString(item.resolutionSource, 64),
    });
  }
  return expandAddresslessTokenSignals(signals).slice(0, MAX_STORED_TWITTER_SIGNALS);
}
const INLINE_TWEET_ENTITY_LINE_RE = new RegExp(
  `^(?:${INLINE_TWEET_ENTITY_SOURCE}[，,。.!?！？:：;；]?)(?:[ \\t]+${INLINE_TWEET_ENTITY_SOURCE}[，,。.!?！？:：;；]?)*$`,
  "u",
);

function collapseInlineTweetEntityLines(value: string): string {
  const lines = value.split("\n");
  const normalized: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!INLINE_TWEET_ENTITY_LINE_RE.test(trimmed)) {
      normalized.push(line);
      continue;
    }

    const entities = [trimmed];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const nextEntity = lines[nextIndex].trim();
      if (!INLINE_TWEET_ENTITY_LINE_RE.test(nextEntity)) break;
      entities.push(nextEntity);
      nextIndex += 1;
    }

    const entityText = entities.join(" ");
    const previousIndex = normalized.length - 1;
    if (previousIndex >= 0 && normalized[previousIndex].trim()) {
      normalized[previousIndex] = `${normalized[previousIndex].trimEnd()} ${entityText}`;
    } else {
      normalized.push(entityText);
    }

    const nextLine = lines[nextIndex];
    if (nextLine !== undefined && nextLine.trim()) {
      const targetIndex = normalized.length - 1;
      normalized[targetIndex] = `${normalized[targetIndex].trimEnd()} ${nextLine.trimStart()}`;
      index = nextIndex;
    } else {
      index = nextIndex - 1;
    }
  }

  return normalized.join("\n");
}

export function normalizeTweetSignalText(value: string): string {
  let text = value.replace(/\r\n?/g, "\n");
  text = collapseInlineTweetEntityLines(text);
  text = text.replace(/(https?:\/\/)(?:[ \t]*\n[ \t]*)+(?=[A-Za-z0-9])/gi, "$1");
  text = text.replace(/https?:\/\/(?=https?:\/\/)/gi, "");
  text = text.replace(/(@[A-Za-z0-9_]{1,15})\n(?=\S)/g, "$1 ");
  text = text.replace(/([^\n。！？!?：:])\n[ \t]*(@[A-Za-z0-9_]{1,15})(?=[ \t]|$)/g, "$1 $2");
  text = text.replace(/(\$[A-Za-z][A-Za-z0-9_]{0,14})\n[ \t]*(?=[：:，,。.!?）)\]}])/g, "$1");
  text = text.replace(
    /([：:])[ \t]*\n[ \t]*(?=(?:https?:\/\/|www\.|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}(?:\/|\s|$)))/gi,
    "$1 ",
  );

  // X can insert hard line breaks inside a displayed query value. Join only
  // short URL continuations so ordinary paragraph breaks remain untouched.
  const wrappedUrlContinuation = /(https?:\/\/[^\s\n]*[?&][^\s\n]*)\n([A-Za-z0-9%._~+-]{1,12})(?=\s|$)/gi;
  let previous: string;
  do {
    previous = text;
    text = text.replace(wrappedUrlContinuation, "$1$2");
  } while (text !== previous);

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

interface GroupableTweetSignal {
  id: string;
  author: string;
  tweetText: string;
  chain?: string;
  contractAddress?: string;
  tokenSymbols?: string[];
  sourceUrl?: string;
  tweetId?: string;
  publishedAt?: string;
  detectedAt?: string;
  resolutionStatus?: "pending" | "resolved" | "conflicted";
}

function tweetTokenSignalRichness(signal: GroupableTweetSignal): number {
  return (signal.contractAddress ? 8 : 0)
    + (signal.resolutionStatus === "resolved" ? 4 : 0)
    + (signal.chain && signal.chain !== "Unknown" && signal.chain !== "Unknown EVM" ? 2 : 0);
}

function preferRicherTweetTokenSignal<T extends GroupableTweetSignal>(left: T, right: T): T {
  return tweetTokenSignalRichness(right) > tweetTokenSignalRichness(left) ? right : left;
}

function canonicalTokenSymbols<T extends GroupableTweetSignal>(signal: T): T {
  const symbols = Array.from(normalizedTokenSymbols(signal, true), (symbol) => `$${symbol}`);
  if (symbols.length === 0 && !signal.tokenSymbols?.length) return signal;
  return { ...signal, tokenSymbols: symbols.length > 0 ? symbols : undefined };
}

export function expandAddresslessTokenSignals<T extends GroupableTweetSignal>(signals: T[]): T[] {
  return signals.flatMap((signal) => {
    if (signal.contractAddress) return [signal];
    const symbols = Array.from(normalizedTokenSymbols(signal, true));
    if (symbols.length <= 1) return [canonicalTokenSymbols(signal)];
    return symbols.map((symbol) => ({
      ...signal,
      id: `${signal.id}:symbol:${symbol.toLowerCase()}`,
      tokenSymbols: [`$${symbol}`],
    }));
  });
}

/**
 * Collapses legacy cashtag variants and redundant aggregate rows within one tweet.
 * Distinct contract addresses remain visible because they can represent a real conflict.
 */
export function compactTweetTokenSignals<T extends GroupableTweetSignal>(signals: T[]): T[] {
  const canonical = signals.map(canonicalTokenSymbols);
  const atomicByIdentity = new Map<string, { signal: T; index: number }>();
  const aggregates: Array<{ signal: T; index: number }> = [];

  canonical.forEach((signal, index) => {
    const symbols = Array.from(normalizedTokenSymbols(signal, true));
    if (!signal.contractAddress && symbols.length > 1) {
      aggregates.push({ signal, index });
      return;
    }
    const contractIdentity = signal.contractAddress?.trim().toLowerCase();
    let identity = `record:${signal.id}`;
    if (contractIdentity) identity = `contract:${contractIdentity}`;
    else if (symbols.length === 1) identity = `symbol:${symbols[0]}`;
    const existing = atomicByIdentity.get(identity);
    if (!existing) {
      atomicByIdentity.set(identity, { signal, index });
      return;
    }
    atomicByIdentity.set(identity, {
      signal: preferRicherTweetTokenSignal(existing.signal, signal),
      index: existing.index,
    });
  });

  const atomic = Array.from(atomicByIdentity.values());
  const addressedSymbols = new Set(atomic.flatMap(({ signal }) =>
    signal.contractAddress ? Array.from(normalizedTokenSymbols(signal, true)) : [],
  ));
  const withoutCoveredSymbolOnly = atomic.filter(({ signal }) => {
    if (signal.contractAddress) return true;
    const [symbol] = Array.from(normalizedTokenSymbols(signal, true));
    return !symbol || !addressedSymbols.has(symbol);
  });
  const coveredSymbols = new Set(withoutCoveredSymbolOnly.flatMap(({ signal }) =>
    Array.from(normalizedTokenSymbols(signal, true)),
  ));
  const compactedAggregates: Array<{ signal: T; index: number }> = [];

  for (const entry of aggregates) {
    const remaining = Array.from(normalizedTokenSymbols(entry.signal, true))
      .filter((symbol) => !coveredSymbols.has(symbol));
    if (remaining.length === 0) continue;
    const signal = { ...entry.signal, tokenSymbols: remaining.map((symbol) => `$${symbol}`) };
    compactedAggregates.push({ signal, index: entry.index });
    remaining.forEach((symbol) => coveredSymbols.add(symbol));
  }

  return [...withoutCoveredSymbolOnly, ...compactedAggregates]
    .sort((left, right) =>
      Number(Boolean(right.signal.contractAddress)) - Number(Boolean(left.signal.contractAddress))
      || tweetTokenSignalRichness(right.signal) - tweetTokenSignalRichness(left.signal)
      || left.index - right.index,
    )
    .map(({ signal }) => signal);
}

function tweetSignalTimestamp(signal: GroupableTweetSignal): number {
  const publishedAt = signal.publishedAt ? Date.parse(signal.publishedAt) : Number.NaN;
  if (Number.isFinite(publishedAt)) return publishedAt;
  const detectedAt = signal.detectedAt ? Date.parse(signal.detectedAt) : Number.NaN;
  return Number.isFinite(detectedAt) ? detectedAt : 0;
}

export function filterRecentTweetSignals<T extends GroupableTweetSignal>(
  signals: T[],
  nowMs = Date.now(),
  days = TWITTER_SIGNAL_RECENT_DAYS,
): T[] {
  const cutoffMs = nowMs - Math.max(0, days) * 24 * 60 * 60 * 1_000;
  return signals.filter((signal) => {
    const timestamp = tweetSignalTimestamp(signal);
    return timestamp >= cutoffMs && timestamp <= nowMs;
  });
}

export function sortTweetSignalsNewestFirst<T extends GroupableTweetSignal>(signals: T[]): T[] {
  return signals
    .map((signal, index) => ({ signal, index }))
    .sort((left, right) =>
      tweetSignalTimestamp(right.signal) - tweetSignalTimestamp(left.signal)
      || left.index - right.index,
    )
    .map(({ signal }) => signal);
}

export interface TweetSignalGroup<T> {
  key: string;
  primary: T;
  signals: T[];
}

export interface TweetSignalPage<T> {
  groups: TweetSignalGroup<T>[];
  page: number;
  pageCount: number;
  pageSize: number;
}

export function paginateTweetSignalGroups<T>(
  groups: TweetSignalGroup<T>[],
  requestedPage: number,
  requestedPageSize = TWITTER_SIGNAL_PAGE_SIZE,
): TweetSignalPage<T> {
  const pageSize = Math.min(
    TWITTER_SIGNAL_PAGE_SIZE,
    Math.max(1, Number.isFinite(requestedPageSize) ? Math.floor(requestedPageSize) : TWITTER_SIGNAL_PAGE_SIZE),
  );
  const pageCount = Math.max(1, Math.ceil(groups.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1));
  const start = (page - 1) * pageSize;
  return { groups: groups.slice(start, start + pageSize), page, pageCount, pageSize };
}

export function canonicalTweetSourceIdentity(
  value: string | undefined,
  tweetId?: string,
): string | undefined {
  let genericUrlIdentity: string | undefined;
  if (value?.trim()) {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, "");
      const statusIdentity = twitterStatusSourceIdentity(value);
      if (statusIdentity) {
        return `status:${statusIdentity.id}`;
      }
      const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
      genericUrlIdentity = `${url.protocol.toLowerCase()}//${hostname}${url.port ? `:${url.port}` : ""}${pathname}`;
    } catch {
      genericUrlIdentity = value.trim().toLowerCase();
    }
  }
  const explicitTweetId = tweetId?.trim();
  return explicitTweetId && /^\d+$/.test(explicitTweetId)
    ? `status:${explicitTweetId}`
    : genericUrlIdentity;
}

function twitterStatusSourceIdentity(value: string): { author: string; id: string } | undefined {
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase().replace(/^(?:www|mobile)\./, "");
    if (url.protocol !== "https:"
      || url.username
      || url.password
      || (url.port && url.port !== "443")
      || (hostname !== "x.com" && hostname !== "twitter.com")) {
      return undefined;
    }
    const match = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)(?:\/|$)/iu.exec(url.pathname);
    return match ? { author: match[1].toLowerCase(), id: match[2] } : undefined;
  } catch {
    return undefined;
  }
}

export function groupTweetSignalsByTweet<T extends GroupableTweetSignal>(
  signals: T[],
): TweetSignalGroup<T>[] {
  const groups = new Map<string, TweetSignalGroup<T>>();

  for (const signal of signals) {
    const sourceKey = canonicalTweetSourceIdentity(signal.sourceUrl, signal.tweetId);
    const key = sourceKey
      ? `source:${sourceKey}`
      : `content:${signal.author.trim().toLowerCase()}:${signal.publishedAt || ""}:${normalizeTweetSignalText(signal.tweetText)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.signals.push(signal);
    } else {
      groups.set(key, { key, primary: signal, signals: [signal] });
    }
  }

  return Array.from(groups.values(), (group) => ({
    ...group,
    signals: compactTweetTokenSignals(group.signals),
  }));
}
