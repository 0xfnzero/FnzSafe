import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOKEN_MARKET_SORT,
  formatTokenMarketUsd,
  nextTokenMarketSort,
  sortTokenMarketRows,
} from "./tokenMarketTable.ts";

const row = (id, overrides = {}) => ({
  id,
  symbol: `T${id}`,
  chain: "Solana",
  mention_count: 0,
  kol_mention_count: 0,
  latest_mention_at_ms: id,
  ...overrides,
});

test("formats market values with standard dollar K/M/B/T suffixes", () => {
  assert.equal(formatTokenMarketUsd(51_000, "zh-CN"), "$51K");
  assert.equal(formatTokenMarketUsd(5_000_000, "zh-CN"), "$5M");
  assert.equal(formatTokenMarketUsd(2_420_000_000, "zh-CN"), "$2.42B");
  assert.equal(formatTokenMarketUsd(1_100_000_000_000, "zh-CN"), "$1.1T");
  assert.equal(formatTokenMarketUsd(0.2406, "zh-CN"), "$0.2406");
  assert.equal(formatTokenMarketUsd(null, "zh-CN"), "--");
});

test("uses intuitive initial directions and toggles the active column", () => {
  assert.deepEqual(nextTokenMarketSort(DEFAULT_TOKEN_MARKET_SORT, "change1h"), {
    key: "change1h",
    direction: "desc",
  });
  assert.deepEqual(nextTokenMarketSort({ key: "token", direction: "asc" }, "token"), {
    key: "token",
    direction: "desc",
  });
  assert.deepEqual(nextTokenMarketSort(DEFAULT_TOKEN_MARKET_SORT, "chain"), {
    key: "chain",
    direction: "asc",
  });
});

test("sorts each period by price change and keeps missing values last", () => {
  const rows = [
    row(1, { volume_5m_usd: null, price_change_5m_percent: null }),
    row(2, { volume_5m_usd: 50, price_change_5m_percent: -2 }),
    row(3, { volume_5m_usd: 100, price_change_5m_percent: 5 }),
  ];

  assert.deepEqual(
    sortTokenMarketRows(rows, { key: "change5m", direction: "asc" }, "en")
      .map(({ id }) => id),
    [2, 3, 1],
  );
});

test("uses a stable id tie-breaker", () => {
  const rows = [row(3, { mention_count: 4 }), row(1, { mention_count: 4 })];
  assert.deepEqual(
    sortTokenMarketRows(rows, { key: "mentions", direction: "desc" }, "en")
      .map(({ id }) => id),
    [1, 3],
  );
});

test("maps every numeric market header to its own field", () => {
  const cases = [
    ["price", "price_usd"],
    ["marketCap", "market_cap_usd"],
    ["liquidity", "liquidity_usd"],
    ["change5m", "price_change_5m_percent"],
    ["change1h", "price_change_1h_percent"],
    ["change6h", "price_change_6h_percent"],
    ["change24h", "price_change_24h_percent"],
    ["mentions", "mention_count"],
    ["kolMentions", "kol_mention_count"],
    ["updated", "market_updated_at_ms"],
  ];

  for (const [key, field] of cases) {
    const rows = [row(1, { [field]: 1 }), row(2, { [field]: 2 })];
    assert.equal(
      sortTokenMarketRows(rows, { key, direction: "desc" }, "en")[0].id,
      2,
      `${key} did not use its matching value`,
    );
  }
});
