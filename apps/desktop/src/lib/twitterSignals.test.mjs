import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalTweetSourceIdentity,
  compactTweetTokenSignals,
  expandAddresslessTokenSignals,
  filterRecentTweetSignals,
  filterTweetTokenSignalsByAuthor,
  groupTweetSignalsByTweet,
  hasValidTweetSignalIdentity,
  isTokenResolutionTarget,
  mergeTweetTokenSignals,
  newestTwitterTweetId,
  normalizeTweetSignalText,
  paginateTweetSignalGroups,
  parseStoredTwitterSignals,
  sortTweetSignalsNewestFirst,
  tokenResolutionRetryDelayMs,
  tokenSignalObservation,
} from "./twitterSignals.ts";

test("compares Twitter snowflake IDs without losing integer precision", () => {
  assert.equal(
    newestTwitterTweetId(["2096895735979794769", "2096895735979794770", "00042", "invalid"]),
    "2096895735979794770",
  );
  assert.equal(newestTwitterTweetId(["000", "0"]), "0");
  assert.equal(newestTwitterTweetId([undefined, ""]), undefined);
});

test("filters X and Fomo signals by their exact account handle", () => {
  const signals = [{ id: "x", author: "@shared", signalSource: "x" }, {
    id: "fomo-shared", author: "@shared", signalSource: "fomo",
  }, {
    id: "fomo-long", author: "@Long_Fomo_Profile_Handle_123", signalSource: "fomo",
  }];

  assert.deepEqual(
    filterTweetTokenSignalsByAuthor(signals, "@shared").map(({ id }) => id),
    ["x", "fomo-shared"],
  );
  assert.deepEqual(
    filterTweetTokenSignalsByAuthor(signals, "@long_fomo_profile_handle_123").map(({ id }) => id),
    ["fomo-long"],
  );
});

test("splits legacy addressless aggregates into independently resolvable signals", () => {
  const expanded = expandAddresslessTokenSignals([{
    id: "legacy",
    author: "@kol",
    tweetText: "$PONS $USELESS",
    chain: "Unknown",
    tokenSymbols: ["$PONS", "$USELESS"],
  }]);

  assert.deepEqual(expanded.map((signal) => [signal.id, signal.tokenSymbols]), [
    ["legacy:symbol:pons", ["$PONS"]],
    ["legacy:symbol:useless", ["$USELESS"]],
  ]);
  assert.ok(expanded.every((signal) => isTokenResolutionTarget({
    ...signal,
    detectedAt: new Date().toISOString(),
  })));
});

test("canonicalizes Twitter and X status aliases to one source identity", () => {
  assert.equal(
    canonicalTweetSourceIdentity("https://x.com/User/status/123?ref=timeline"),
    "status:123",
  );
  assert.equal(
    canonicalTweetSourceIdentity("https://www.twitter.com/user/status/123#details"),
    "status:123",
  );
  assert.equal(
    canonicalTweetSourceIdentity("https://mobile.x.com/user/statuses/123"),
    "status:123",
  );
  assert.equal(canonicalTweetSourceIdentity(undefined, "123"), "status:123");
  assert.equal(canonicalTweetSourceIdentity("https://x.com/user/status/456", "123"), "status:456");
  assert.notEqual(canonicalTweetSourceIdentity("http://x.com/user/status/123"), "status:123");
  assert.notEqual(canonicalTweetSourceIdentity("https://name@x.com/user/status/123"), "status:123");
  assert.notEqual(canonicalTweetSourceIdentity("https://x.com:444/user/status/123"), "status:123");
});

test("rejoins inline X entities split into standalone DOM lines", () => {
  const input = `LONG
@longdotxyz
平台有很好的展板能够看 股票MEME 的市值排名

目前最重要的几个MEME代币：

- 1.
$AI
Long 平台的当家 英伟达股票代币 币对
并且
$AI
已经成为 Long 平台可以再次当币对发行的底层

价值相比于其他的MEME不一样

-2. $BONER 昨日爆拉的代币，和
$HIMS
做币对`;

  assert.equal(normalizeTweetSignalText(input), `LONG @longdotxyz 平台有很好的展板能够看 股票MEME 的市值排名

目前最重要的几个MEME代币：

- 1. $AI Long 平台的当家 英伟达股票代币 币对
并且 $AI 已经成为 Long 平台可以再次当币对发行的底层

价值相比于其他的MEME不一样

-2. $BONER 昨日爆拉的代币，和 $HIMS 做币对`);
});

test("rejoins consecutive entity-only lines without flattening paragraphs", () => {
  assert.equal(
    normalizeTweetSignalText("Tokens:\n$AI\n$BONER\nare active\n\n$AAVE\n\nSecond paragraph"),
    "Tokens: $AI $BONER are active\n\n$AAVE\n\nSecond paragraph",
  );
});

test("preserves ordinary authored line and paragraph breaks", () => {
  const input = "第一行\n第二行\n\n第三段";
  assert.equal(normalizeTweetSignalText(input), input);
});

test("groups multiple contract signals extracted from the same tweet", () => {
  const shared = {
    author: "@10uwina8",
    tweetText: "同一条推文里的多个合约",
    sourceUrl: "https://x.com/10uwina8/status/123?ref=timeline",
    publishedAt: "2026-09-01T14:11:00Z",
  };
  const groups = groupTweetSignalsByTweet([
    { ...shared, id: "one", contractAddress: "0x111" },
    { ...shared, id: "two", contractAddress: "0x222" },
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].signals.map((signal) => signal.id), ["one", "two"]);
});

test("keeps identical text from different tweet URLs separate", () => {
  const groups = groupTweetSignalsByTweet([
    { id: "one", author: "@same", tweetText: "same", sourceUrl: "https://x.com/same/status/1" },
    { id: "two", author: "@same", tweetText: "same", sourceUrl: "https://x.com/same/status/2" },
  ]);

  assert.equal(groups.length, 2);
});

test("keeps separate Fomo trades on the same token", () => {
  const baseUrl = "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a";
  const groups = groupTweetSignalsByTweet([
    { id: "one", author: "@trader", tweetText: "Buy $8K $ZZZ", sourceUrl: `${baseUrl}?tradeId=trade-1` },
    { id: "two", author: "@trader", tweetText: "Buy $8K $ZZZ", sourceUrl: `${baseUrl}?tradeId=trade-2` },
  ]);

  assert.equal(groups.length, 2);
});

test("keeps separate Fomo theses on the same token", () => {
  const baseUrl = "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a";
  const groups = groupTweetSignalsByTweet([
    { id: "one", author: "@trader", tweetText: "same thesis", sourceUrl: `${baseUrl}?thesisId=comment-1` },
    { id: "two", author: "@trader", tweetText: "same thesis", sourceUrl: `${baseUrl}?thesisId=comment-2` },
  ]);

  assert.equal(groups.length, 2);
});

test("preserves captured Fomo metadata when SQLite returns the same signal", () => {
  const sourceUrl = "https://fomo.family/tokens/robinhood/0x1111111111111111111111111111111111111111?tradeId=one";
  const detectedAt = new Date().toISOString();
  const [merged] = mergeTweetTokenSignals([{
    id: "fomo:one",
    author: "@chefjin",
    authorName: "Chef Jin",
    tweetText: "Buy $8K $ZZZ on Robinhood",
    chain: "Robinhood",
    contractAddress: "0x1111111111111111111111111111111111111111",
    sourceUrl,
    detectedAt,
    signalSource: "fomo",
    fomoEventType: "swap_buy",
    tradeDirection: "buy",
    followerCount: 12_345,
  }], [{
    id: "sqlite:one",
    author: "Fomo trader",
    tweetText: "Buy $8K $ZZZ on Robinhood",
    chain: "Robinhood",
    contractAddress: "0x1111111111111111111111111111111111111111",
    sourceUrl,
    detectedAt,
    signalSource: "fomo",
  }]);

  assert.equal(merged.id, "fomo:one");
  assert.equal(merged.author, "@chefjin");
  assert.equal(merged.tradeDirection, "buy");
  assert.equal(merged.followerCount, 12_345);
});

test("groups the same status across Twitter host aliases and URL decorations", () => {
  const groups = groupTweetSignalsByTweet([
    { id: "one", author: "@same", tweetText: "same", sourceUrl: "https://x.com/User/status/42?ref=home" },
    { id: "two", author: "@same", tweetText: "same", sourceUrl: "https://twitter.com/user/status/42#top" },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].signals.map((signal) => signal.id), ["one", "two"]);
});

test("groups URL-less signals by their captured tweet id", () => {
  const groups = groupTweetSignalsByTweet([
    { id: "one", tweetId: "42", author: "@one", tweetText: "first extraction" },
    { id: "two", tweetId: "42", author: "@two", tweetText: "second extraction" },
  ]);
  assert.equal(groups.length, 1);
});

test("deduplicates legacy cashtag prefixes and keeps canonical display symbols", () => {
  const compacted = compactTweetTokenSignals([
    { id: "legacy", author: "@kol", tweetText: "$AI", chain: "Unknown", tokenSymbols: ["$$ai"] },
    { id: "current", author: "@kol", tweetText: "$AI", chain: "Unknown", tokenSymbols: ["AI"] },
  ]);

  assert.equal(compacted.length, 1);
  assert.deepEqual(compacted[0].tokenSymbols, ["$AI"]);
});

test("replaces a symbol-only row with its richer resolved contract row", () => {
  const compacted = compactTweetTokenSignals([
    { id: "symbol", author: "@kol", tweetText: "$AI", chain: "Unknown", tokenSymbols: ["$AI"] },
    {
      id: "resolved",
      author: "@kol",
      tweetText: "$AI",
      chain: "Solana",
      contractAddress: "So11111111111111111111111111111111111111112",
      tokenSymbols: ["AI"],
      resolutionStatus: "resolved",
    },
  ]);

  assert.deepEqual(compacted.map((signal) => signal.id), ["resolved"]);
  assert.deepEqual(compacted[0].tokenSymbols, ["$AI"]);
});

test("drops an aggregate row when individual rows cover all of its symbols", () => {
  const compacted = compactTweetTokenSignals([
    { id: "ai", author: "@kol", tweetText: "$AI $NVDA", chain: "Unknown", tokenSymbols: ["AI"] },
    { id: "nvda", author: "@kol", tweetText: "$AI $NVDA", chain: "Unknown", tokenSymbols: ["$NVDA"] },
    { id: "aggregate", author: "@kol", tweetText: "$AI $NVDA", chain: "Unknown", tokenSymbols: ["$AI", "NVDA"] },
  ]);

  assert.deepEqual(compacted.map((signal) => signal.id), ["ai", "nvda"]);
});

test("keeps only uncovered symbols in a partially redundant aggregate row", () => {
  const compacted = compactTweetTokenSignals([
    { id: "ai", author: "@kol", tweetText: "$AI $NVDA", chain: "Unknown", tokenSymbols: ["$AI"] },
    { id: "aggregate", author: "@kol", tweetText: "$AI $NVDA", chain: "Unknown", tokenSymbols: ["AI", "NVDA"] },
  ]);

  assert.equal(compacted.length, 2);
  assert.deepEqual(compacted[1].tokenSymbols, ["$NVDA"]);
});

test("keeps distinct contracts for the same symbol visible", () => {
  const compacted = compactTweetTokenSignals([
    { id: "one", author: "@kol", tweetText: "$AI", chain: "BSC", contractAddress: "0x111", tokenSymbols: ["AI"] },
    { id: "two", author: "@kol", tweetText: "$AI", chain: "BSC", contractAddress: "0x222", tokenSymbols: ["$AI"] },
    { id: "symbol", author: "@kol", tweetText: "$AI", chain: "Unknown", tokenSymbols: ["$AI"] },
  ]);

  assert.deepEqual(compacted.map((signal) => signal.id), ["one", "two"]);
});

test("deduplicates the same contract after its chain is resolved", () => {
  const compacted = compactTweetTokenSignals([
    { id: "observed", author: "@kol", tweetText: "$AI", chain: "Unknown EVM", contractAddress: "0x111", tokenSymbols: ["AI"] },
    { id: "resolved", author: "@kol", tweetText: "$AI", chain: "Robinhood", contractAddress: "0x111", tokenSymbols: ["$AI"], resolutionStatus: "resolved" },
  ]);

  assert.deepEqual(compacted.map((signal) => signal.id), ["resolved"]);
});

test("paginates tweet groups with clamped pages and at most 100 items", () => {
  const groups = Array.from({ length: 205 }, (_, index) => ({
    key: `tweet-${index}`,
    primary: index,
    signals: [index],
  }));

  const middle = paginateTweetSignalGroups(groups, 2, 500);
  assert.equal(middle.page, 2);
  assert.equal(middle.pageCount, 3);
  assert.equal(middle.groups.length, 100);
  assert.equal(middle.groups[0].primary, 100);

  const clamped = paginateTweetSignalGroups(groups, 99);
  assert.equal(clamped.page, 3);
  assert.equal(clamped.groups.length, 5);
});

test("filters signals to the recent window using published time before capture time", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  const signals = filterRecentTweetSignals([
    { id: "new", author: "@one", tweetText: "$NEW", publishedAt: "2026-09-03T11:00:00.000Z", detectedAt: "2026-09-03T12:00:00.000Z" },
    { id: "edge", author: "@one", tweetText: "$EDGE", publishedAt: "2026-08-31T12:00:00.000Z", detectedAt: "2026-09-03T12:00:00.000Z" },
    { id: "old", author: "@one", tweetText: "$OLD", publishedAt: "2026-08-31T11:59:59.999Z", detectedAt: "2026-09-03T12:00:00.000Z" },
    { id: "future", author: "@one", tweetText: "$FUTURE", publishedAt: "2026-09-03T12:00:00.001Z", detectedAt: "2026-09-03T12:00:00.000Z" },
  ], now);

  assert.deepEqual(signals.map((signal) => signal.id), ["new", "edge"]);
});

test("sorts tweet signals newest first and falls back to detection time", () => {
  const signals = sortTweetSignalsNewestFirst([
    { id: "middle", author: "@one", tweetText: "$MID", detectedAt: "2026-09-02T12:00:00.000Z" },
    { id: "new", author: "@one", tweetText: "$NEW", publishedAt: "2026-09-03T12:00:00.000Z", detectedAt: "2026-09-01T12:00:00.000Z" },
    { id: "old", author: "@one", tweetText: "$OLD", publishedAt: "2026-09-01T12:00:00.000Z", detectedAt: "2026-09-03T12:00:00.000Z" },
  ]);

  assert.deepEqual(signals.map((signal) => signal.id), ["new", "middle", "old"]);
});

test("parses stored signals independently so one corrupt item cannot discard the cache", () => {
  const signals = parseStoredTwitterSignals([
    {
      id: "signal-1",
      chain: "Solana",
      author: " @kol ",
      tweetText: " $SOL looks active ",
      detectedAt: "2026-09-02T00:00:00.000Z",
      tokenSymbols: ["$SOL", 42],
      links: [{ target: "https://x.com/kol/status/1", display: "source" }, { target: 42, display: "bad" }],
    },
    { id: "broken", author: {}, tweetText: "text", detectedAt: "invalid" },
  ]);

  assert.equal(signals.length, 1);
  assert.equal(signals[0].author, "@kol");
  assert.deepEqual(signals[0].tokenSymbols, ["$SOL"]);
  assert.deepEqual(signals[0].links, [{ target: "https://x.com/kol/status/1", display: "source" }]);
});

test("bounds stored signals before processing untrusted entries", () => {
  const records = parseStoredTwitterSignals(Array.from({ length: 1_050 }, (_, index) => ({
    id: `signal-${index}`,
    author: "@kol",
    tweetText: "$SOL",
    detectedAt: "2026-09-02T00:00:00.000Z",
  })));
  assert.equal(records.length, 1_000);
});

test("drops unsafe URLs from stored signals while preserving public web links", () => {
  const [signal] = parseStoredTwitterSignals([{
    id: "signal-1",
    author: "@kol",
    tweetText: "$SOL",
    detectedAt: "2026-09-02T00:00:00.000Z",
    avatarUrl: "data:image/svg+xml,bad",
    sourceUrl: "javascript:alert(1)",
    links: [
      { target: "https://x.com/kol/status/1", display: "source" },
      { target: "https://user:secret@example.com/", display: "credentialed" },
    ],
  }]);

  assert.equal(signal.avatarUrl, undefined);
  assert.equal(signal.sourceUrl, undefined);
  assert.deepEqual(signal.links, [{ target: "https://x.com/kol/status/1", display: "source" }]);
});

test("preserves bounded automatic token resolution metadata", () => {
  const [signal] = parseStoredTwitterSignals([{
    id: "signal-1",
    author: "@kol",
    tweetText: "$PONS",
    chain: "Robinhood",
    contractAddress: "0x39dbed3a2bd333467115de45665cc57f813c4571",
    detectedAt: "2026-09-03T00:00:00.000Z",
    resolutionStatus: "resolved",
    resolutionConfidence: 4,
    resolutionSource: "dexscreener",
    observedChain: "Unknown EVM",
    observedContractAddress: "0x39dbed3a2bd333467115de45665cc57f813c4571",
  }]);

  assert.equal(signal.resolutionStatus, "resolved");
  assert.equal(signal.resolutionConfidence, 1);
  assert.equal(signal.resolutionSource, "dexscreener");
  assert.deepEqual(tokenSignalObservation(signal), {
    chain: "Unknown EVM",
    contractAddress: "0x39dbed3a2bd333467115de45665cc57f813c4571",
  });
});

test("preserves bounded Fomo signal metadata", () => {
  const [signal] = parseStoredTwitterSignals([{
    id: "fomo:signal-1",
    author: "@trader",
    tweetText: "Buy $8K $ZZZ",
    chain: "Robinhood",
    contractAddress: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
    detectedAt: "2026-09-05T00:00:00.000Z",
    signalSource: "fomo",
    fomoEventType: "swap_buy",
    tradeDirection: "buy",
    usdAmount: 8_000,
    marketCapUsd: 18_900_000,
    traderCount: 1.9,
    followerCount: 12_345.9,
  }]);

  assert.equal(signal.signalSource, "fomo");
  assert.equal(signal.fomoEventType, "swap_buy");
  assert.equal(signal.tradeDirection, "buy");
  assert.equal(signal.usdAmount, 8_000);
  assert.equal(signal.marketCapUsd, 18_900_000);
  assert.equal(signal.traderCount, 1);
  assert.equal(signal.followerCount, 12_345);
});

test("falls back safely for legacy inferred signals without observation metadata", () => {
  assert.deepEqual(tokenSignalObservation({
    id: "legacy",
    author: "@kol",
    tweetText: "$PONS",
    chain: "Robinhood",
    contractAddress: "0x39dbed3a2bd333467115de45665cc57f813c4571",
    detectedAt: "2026-09-03T00:00:00.000Z",
    resolutionStatus: "resolved",
    resolutionSource: "dexscreener",
  }), { chain: "Unknown" });
});

test("queues only signals that the token resolver can query", () => {
  const base = {
    id: "signal",
    author: "@kol",
    tweetText: "$PONS",
    chain: "Unknown",
    detectedAt: "2026-09-03T00:00:00.000Z",
  };
  assert.equal(isTokenResolutionTarget({ ...base, tokenSymbols: ["$PONS"] }), true);
  assert.equal(isTokenResolutionTarget({
    ...base,
    contractAddress: "0x1111111111111111111111111111111111111111",
  }), true);
  assert.equal(isTokenResolutionTarget({
    ...base,
    chain: "BSC",
    contractAddress: "0x1111111111111111111111111111111111111111",
    tokenSymbols: ["$WRONG"],
  }), true);
  assert.equal(isTokenResolutionTarget({
    ...base,
    chain: "BSC",
    contractAddress: "0x1111111111111111111111111111111111111111",
    resolutionStatus: "resolved",
    resolutionSource: "chain-rpc",
  }), false);
  assert.equal(isTokenResolutionTarget({
    ...base,
    chain: "Solana",
    contractAddress: "So11111111111111111111111111111111111111112",
    tokenSymbols: ["$WRONG"],
  }), true);
  assert.equal(isTokenResolutionTarget({ ...base, contractAddress: "not-an-evm-address" }), false);
  assert.equal(isTokenResolutionTarget({ ...base, tokenSymbols: ["$ONE", "$TWO"] }), false);
  assert.equal(isTokenResolutionTarget({ ...base, tokenSymbols: ["PONS,"] }), false);
  assert.equal(isTokenResolutionTarget({ ...base, tokenSymbols: ["$$PONS"] }), false);
  assert.equal(isTokenResolutionTarget({ ...base, tokenSymbols: ["ß"] }), false);
});

test("rejects malformed tweet identity before batching storage or resolution", () => {
  const base = {
    id: "signal",
    author: "@kol",
    tweetText: "$PONS",
    chain: "Unknown",
    detectedAt: "2026-09-03T00:00:00.000Z",
  };
  assert.equal(hasValidTweetSignalIdentity({
    ...base,
    tweetId: "42",
    sourceUrl: "https://x.com/kol/status/42?ref=home",
  }), true);
  assert.equal(hasValidTweetSignalIdentity({ ...base, author: "-" }), false);
  assert.equal(hasValidTweetSignalIdentity({
    ...base,
    tweetId: "43",
    sourceUrl: "https://x.com/kol/status/42",
  }), false);
  assert.equal(hasValidTweetSignalIdentity({
    ...base,
    tweetId: "42",
    sourceUrl: "https://x.com/another/status/42",
  }), false);
  assert.equal(hasValidTweetSignalIdentity({ ...base, sourceUrl: "https://example.com/status/42" }), false);
  const fomo = {
    ...base,
    signalSource: "fomo",
    author: "Fomo trader",
    contractAddress: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
    sourceUrl: "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a?tradeId=1",
  };
  assert.equal(hasValidTweetSignalIdentity(fomo), true);
  assert.equal(isTokenResolutionTarget(fomo), false);
  assert.equal(hasValidTweetSignalIdentity({ ...fomo, sourceUrl: "https://fomo.family/tokens/robinhood/0x1111111111111111111111111111111111111111" }), false);
});

test("backs off longer while waiting for a new token to appear", () => {
  assert.equal(tokenResolutionRetryDelayMs("resolver-unavailable"), 30_000);
  assert.equal(tokenResolutionRetryDelayMs("no-candidate"), 300_000);
  assert.equal(tokenResolutionRetryDelayMs("candidate-ranking"), 300_000);
  assert.equal(tokenResolutionRetryDelayMs("symbol-or-chain-conflict"), 300_000);
});

test("keeps an inferred chain when the same unknown-address signal is captured again", () => {
  const address = "0x39dbed3a2bd333467115de45665cc57f813c4571";
  const detectedAt = new Date().toISOString();
  const base = {
    id: "fresh",
    author: "@kol",
    tweetText: `$PONS ${address}`,
    chain: "Unknown EVM",
    contractAddress: address,
    tokenSymbols: ["$PONS"],
    sourceUrl: "https://x.com/kol/status/1",
    detectedAt,
  };
  const [merged] = mergeTweetTokenSignals([{
    ...base,
    id: "stable",
    chain: "Robinhood",
    observedChain: "Unknown EVM",
    observedContractAddress: address,
    resolutionStatus: "resolved",
    resolutionConfidence: 0.99,
    resolutionSource: "chain-rpc",
  }], [base]);

  assert.equal(merged.id, "stable");
  assert.equal(merged.chain, "Robinhood");
  assert.equal(merged.resolutionStatus, "resolved");
  assert.equal(merged.observedContractAddress, address);
});

test("replaces a symbol-only automatic resolution when a recapture has explicit identity", () => {
  const sourceUrl = "https://x.com/kol/status/2";
  const previousDetectedAt = new Date(Date.now() - 60_000).toISOString();
  const currentDetectedAt = new Date().toISOString();
  const [merged] = mergeTweetTokenSignals([{
    id: "stable",
    author: "@kol",
    tweetText: "$PONS",
    chain: "Robinhood",
    contractAddress: "0x1111111111111111111111111111111111111111",
    observedChain: "Unknown",
    tokenSymbols: ["$PONS"],
    sourceUrl,
    detectedAt: previousDetectedAt,
    resolutionStatus: "resolved",
    resolutionConfidence: 0.9,
    resolutionSource: "DexScreener",
  }], [{
    id: "fresh",
    author: "@kol",
    tweetText: "$PONS BSC CA: 0x2222222222222222222222222222222222222222",
    chain: "BSC",
    contractAddress: "0x2222222222222222222222222222222222222222",
    tokenSymbols: ["$PONS"],
    sourceUrl,
    detectedAt: currentDetectedAt,
  }]);

  assert.equal(merged.id, "stable");
  assert.equal(merged.chain, "BSC");
  assert.equal(merged.contractAddress, "0x2222222222222222222222222222222222222222");
  assert.equal(merged.resolutionStatus, undefined);
  assert.equal(merged.resolutionSource, undefined);
});
