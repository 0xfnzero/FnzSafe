import assert from "node:assert/strict";
import test from "node:test";
import {
  chainLogoUrl,
  formatDefiLlamaPct,
  formatDefiLlamaUsd,
  mergeDefiLlamaRankingsCaches,
  normalizeDefiLlamaLogoUrl,
  rankingValueForPeriod,
  rankingsCacheFromDatabaseRecords,
  readDefiLlamaRankingsCache,
  sortRankingsByColumn,
  sortRankingsByPeriod,
  writeDefiLlamaRankingsCache,
} from "./defillamaStats.ts";

test("formats DefiLlama USD and percent values", () => {
  assert.equal(formatDefiLlamaUsd(2_500_000_000), "$2.50B");
  assert.equal(formatDefiLlamaUsd(12_400), "$12.40K");
  assert.equal(formatDefiLlamaPct(12.345), "+12.35%");
  assert.equal(formatDefiLlamaPct(-3.2), "-3.20%");
  assert.equal(formatDefiLlamaPct(null), "-");
});

test("sorts ranking rows by selected period", () => {
  const rows = [
    { id: "a", name: "A", value24h: 10, value7d: 100, value30d: 50 },
    { id: "b", name: "B", value24h: 20, value7d: 40, value30d: 400 },
  ];
  assert.equal(sortRankingsByPeriod(rows, "24h")[0]?.id, "b");
  assert.equal(sortRankingsByPeriod(rows, "7d")[0]?.id, "a");
  assert.equal(sortRankingsByPeriod(rows, "30d")[0]?.id, "b");
  assert.equal(rankingValueForPeriod(rows[0], "7d"), 100);
});

test("sorts ranking rows by column header keys", () => {
  const rows = [
    { id: "a", name: "Alpha", category: "Dexes", value24h: 10, value7d: 10, value30d: 10, change1d: -2, change7d: 5 },
    { id: "b", name: "Beta", category: "Lending", value24h: 30, value7d: 30, value30d: 30, change1d: 8, change7d: null },
    { id: "c", name: "Charlie", category: "Bridge", value24h: 20, value7d: 20, value30d: 20, change1d: null, change7d: 1 },
  ];
  assert.equal(sortRankingsByColumn(rows, "name", "24h", "asc")[0]?.id, "a");
  assert.equal(sortRankingsByColumn(rows, "value", "24h", "desc")[0]?.id, "b");
  assert.equal(sortRankingsByColumn(rows, "change1d", "24h", "desc")[0]?.id, "b");
  assert.equal(sortRankingsByColumn(rows, "change1d", "24h", "desc")[2]?.id, "c");
  assert.equal(sortRankingsByColumn(rows, "category", "24h", "asc")[0]?.id, "c");
});

test("builds chain and protocol logo urls", () => {
  assert.equal(
    chainLogoUrl("solana"),
    "https://icons.llamao.fi/icons/chains/rsz_solana?w=48&h=48",
  );
  assert.equal(
    chainLogoUrl("avax"),
    "https://icons.llamao.fi/icons/chains/rsz_avalanche?w=48&h=48",
  );
  assert.equal(
    normalizeDefiLlamaLogoUrl("https://icons.llamao.fi/chains/rsz_robinhood chain.jpg", "robinhood-chain"),
    "https://icons.llamao.fi/icons/protocols/robinhood-chain?w=48&h=48",
  );
  assert.equal(
    normalizeDefiLlamaLogoUrl("https://icons.llamao.fi/icons/protocols/tether", "tether"),
    "https://icons.llamao.fi/icons/protocols/tether?w=48&h=48",
  );
});

test("persists and reads DefiLlama rankings cache", () => {
  const memory = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => { memory.set(key, value); },
      removeItem: (key) => { memory.delete(key); },
    },
  };

  const sample = {
    view: "chain-volume",
    fetchedAt: 1_700_000_000_000,
    totals: { value24h: 1, value7d: 2, value30d: 3 },
    rows: [{ id: "solana", name: "Solana", value24h: 1, value7d: 2, value30d: 3 }],
  };
  writeDefiLlamaRankingsCache("chain-volume", sample);
  const cached = readDefiLlamaRankingsCache();
  assert.equal(cached["chain-volume"]?.rows[0]?.id, "solana");
  assert.equal(cached["chain-volume"]?.fetchedAt, 1_700_000_000_000);
});

test("hydrates database rankings and keeps the newest snapshot", () => {
  const older = {
    view: "chain-volume",
    fetchedAt: 1_700_000_000_000,
    totals: { value24h: 1, value7d: 2, value30d: 3 },
    rows: [{ id: "old", name: "Old", value24h: 1, value7d: 2, value30d: 3 }],
  };
  const newer = {
    ...older,
    fetchedAt: 1_700_000_001_000,
    rows: [{ id: "new", name: "New", value24h: 4, value7d: 5, value30d: 6 }],
  };
  const database = rankingsCacheFromDatabaseRecords([{
    view: "chain-volume",
    payloadJson: JSON.stringify(newer),
    fetchedAtMs: newer.fetchedAt,
    updatedAtMs: newer.fetchedAt,
  }]);
  const merged = mergeDefiLlamaRankingsCaches({ "chain-volume": older }, database);
  assert.equal(merged["chain-volume"]?.rows[0]?.id, "new");

  const staleDatabase = rankingsCacheFromDatabaseRecords([{
    view: "chain-volume",
    payloadJson: JSON.stringify(older),
    fetchedAtMs: older.fetchedAt,
    updatedAtMs: older.fetchedAt,
  }]);
  assert.equal(
    mergeDefiLlamaRankingsCaches({ "chain-volume": newer }, staleDatabase)["chain-volume"]?.rows[0]?.id,
    "new",
  );
});

test("ignores malformed or mismatched database rankings", () => {
  const valid = {
    view: "chain-volume",
    fetchedAt: 1_700_000_000_000,
    totals: { value24h: 1, value7d: 2, value30d: 3 },
    rows: [],
  };
  const cached = rankingsCacheFromDatabaseRecords([
    { view: "chain-volume", payloadJson: "not-json", fetchedAtMs: valid.fetchedAt, updatedAtMs: 1 },
    { view: "chain-revenue", payloadJson: JSON.stringify(valid), fetchedAtMs: valid.fetchedAt, updatedAtMs: 1 },
    { view: "chain-volume", payloadJson: JSON.stringify(valid), fetchedAtMs: valid.fetchedAt + 1, updatedAtMs: 1 },
  ]);
  assert.deepEqual(cached, {});
});
