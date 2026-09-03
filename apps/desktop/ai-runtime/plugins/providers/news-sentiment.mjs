import { XMLParser } from 'fast-xml-parser';
import {
  boundedInteger,
  fetchJson,
  fetchText,
  jsonContent,
  optionalText,
  sourceEnvelope,
} from '../lib/web3-utils.mjs';

const NEWS_FEEDS = {
  coindesk: { label: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  cointelegraph: { label: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  decrypt: { label: 'Decrypt', url: 'https://decrypt.co/feed' },
};

function plainXmlValue(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') return String(value['#text'] ?? value.__cdata ?? '');
  return '';
}

async function readNewsFeed(id) {
  const feed = NEWS_FEEDS[id];
  const xml = await fetchText(feed.url, 30_000);
  const parsed = new XMLParser({ ignoreAttributes: false, trimValues: true, processEntities: false }).parse(xml);
  const rawItems = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];
  return (Array.isArray(rawItems) ? rawItems : [rawItems]).map((item) => {
    const link = typeof item?.link === 'object' ? item.link?.['@_href'] : item?.link;
    return {
      source: feed.label,
      title: plainXmlValue(item?.title),
      url: plainXmlValue(link),
      publishedAt: plainXmlValue(item?.pubDate ?? item?.published ?? item?.updated),
      summary: plainXmlValue(item?.description ?? item?.summary).replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 600),
      categories: (Array.isArray(item?.category) ? item.category : [item?.category]).filter(Boolean).map(plainXmlValue).slice(0, 8),
    };
  }).filter((item) => item.title && item.url);
}

async function cryptoNews(args) {
  const query = optionalText(args, 'query').toLowerCase();
  const source = optionalText(args, 'source') || 'all';
  const limit = boundedInteger(args, 'limit', 15, 1, 30);
  const ids = source === 'all' ? Object.keys(NEWS_FEEDS) : [source];
  const results = await Promise.allSettled(ids.map(readNewsFeed));
  const errors = [];
  const items = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    errors.push({ source: NEWS_FEEDS[ids[index]]?.label || ids[index], error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    return [];
  }).filter((item) => !query || `${item.title} ${item.summary} ${item.categories.join(' ')}`.toLowerCase().includes(query));
  items.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  return jsonContent(sourceEnvelope('Public crypto RSS feeds', {
    query: query || null,
    items: items.slice(0, limit),
    errors,
    caution: 'Feed summaries are discovery evidence; open primary sources before relying on material claims.',
  }));
}

async function marketSentiment(args) {
  const days = boundedInteger(args, 'days', 7, 1, 30);
  const data = await fetchJson(`https://api.alternative.me/fng/?limit=${days}&format=json`, 30_000);
  return jsonContent(sourceEnvelope('Alternative.me Crypto Fear and Greed Index', {
    observations: data?.data ?? [],
    metadata: data?.metadata ?? null,
    caution: 'Sentiment can remain extreme and does not predict a reversal or future return.',
  }));
}

export const newsSentimentHandlers = {
  crypto_news: cryptoNews,
  market_sentiment: marketSentiment,
};
