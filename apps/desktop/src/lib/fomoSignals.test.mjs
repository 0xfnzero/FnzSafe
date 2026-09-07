import assert from "node:assert/strict";
import test from "node:test";

import {
  fomoAlertDirection,
  fomoAlertTextParts,
  fomoTokenActionUrls,
  formatCompactUsd,
  parseCapturedFomoAlerts,
  signalSwapUrl,
  walletNetworkForChain,
} from "./fomoSignals.ts";

test("maps Fomo buy and sell event directions", () => {
  assert.equal(fomoAlertDirection("swap_buy"), "buy");
  assert.equal(fomoAlertDirection("multi_user_sell"), "sell");
  assert.equal(fomoAlertDirection("transfer_in"), "transfer_in");
});

test("formats compact USD values", () => {
  assert.equal(formatCompactUsd(8000), "8K");
  assert.equal(formatCompactUsd(18_900_000), "18.9M");
});

test("builds structured Fomo text parts for visual emphasis", () => {
  assert.deepEqual(fomoAlertTextParts({
    type: "swap_buy",
    chain: "Robinhood",
    ticker: "ZZZ",
    usdAmount: 8000,
    marketCap: 18_900_000,
  }), [
    { kind: "direction", text: "Buy" },
    { kind: "amount", text: "$8K" },
    { kind: "token", text: "$ZZZ" },
    { kind: "market_cap", text: "at $18.9M market cap" },
    { kind: "chain", text: "on Robinhood" },
  ]);
});

test("parses a sanitized Fomo alert into a stored token signal", () => {
  const [signal] = parseCapturedFomoAlerts([{
    id: "alert-1",
    event_type: "swap_buy",
    chain: "Robinhood",
    token_address: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
    ticker: "zzz",
    user_handle: "chefjin",
    follower_count: 12_345,
    usd_amount: 8000,
    market_cap: 18_900_000,
    trade_id: "trade-1",
    source_url: "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a?tradeId=trade-1",
    created_at_ms: Date.parse("2026-09-05T08:00:00Z"),
  }], new Date("2026-09-05T08:00:01Z"));

  assert.equal(signal.signalSource, "fomo");
  assert.equal(signal.tradeDirection, "buy");
  assert.equal(signal.chain, "Robinhood");
  assert.equal(signal.author, "@chefjin");
  assert.deepEqual(signal.tokenSymbols, ["$ZZZ"]);
  assert.equal(signal.followerCount, 12_345);
  assert.match(signal.tweetText, /Buy \$8K \$ZZZ at \$18\.9M market cap on Robinhood/);
});

test("parses a Fomo thesis as a non-trade token signal", () => {
  const [signal] = parseCapturedFomoAlerts([{
    id: "feed-42",
    event_type: "thesis_created",
    chain: "Robinhood",
    token_address: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
    ticker: "zzz",
    user_handle: "Long_Fomo_Profile_Handle_123",
    display_name: "Fomo Researcher",
    thesis: "$ZZZ has improving liquidity and a 25% catalyst window.",
    thesis_id: "comment-42",
    source_url: "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a?thesisId=comment-42",
    created_at_ms: Date.parse("2026-09-05T08:00:00Z"),
  }], new Date("2026-09-05T08:00:01Z"));

  assert.equal(signal.fomoEventType, "thesis_created");
  assert.equal(signal.tradeDirection, undefined);
  assert.equal(signal.author, "@Long_Fomo_Profile_Handle_123");
  assert.equal(signal.tweetText, "$ZZZ has improving liquidity and a 25% catalyst window.");
  assert.deepEqual(signal.tokenSymbols, ["$ZZZ"]);
});

test("rejects unsupported and incomplete alerts", () => {
  assert.deepEqual(parseCapturedFomoAlerts([{ id: "1", event_type: "thesis" }]), []);
  assert.deepEqual(parseCapturedFomoAlerts([{ id: "2", event_type: "swap_buy", chain: "Solana" }]), []);
  assert.deepEqual(parseCapturedFomoAlerts([{
    id: "3",
    event_type: "thesis_created",
    chain: "Robinhood",
    token_address: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
    source_url: "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a?thesisId=3",
    created_at_ms: Date.now(),
  }]), []);
});

test("builds separate Fomo context and built-in swap URLs", () => {
  const urls = fomoTokenActionUrls({
    sourceUrl: "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a?tradeId=trade-1",
    chain: "Robinhood",
    contractAddress: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
  });

  assert.equal(
    urls.fomoUrl,
    "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a?tradeId=trade-1",
  );
  assert.equal(
    urls.swapUrl,
    "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
  );
});

test("ignores unsafe Fomo sources and reconstructs a matching token URL", () => {
  assert.deepEqual(fomoTokenActionUrls({
    sourceUrl: "https://fomo.family.evil.example/tokens/base/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
    chain: "Base",
    contractAddress: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
  }), {
    fomoUrl: "https://fomo.family/tokens/base/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
    swapUrl: "https://fomo.family/tokens/base/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
  });
  assert.deepEqual(fomoTokenActionUrls({
    sourceUrl: "https://evil.example/tokens/unknown/not-an-address",
    chain: "Unknown",
    contractAddress: "not-an-address",
  }), {});
});

test("ignores a valid Fomo URL when it points to a different token", () => {
  assert.deepEqual(fomoTokenActionUrls({
    sourceUrl: "https://fomo.family/tokens/robinhood/0x1111111111111111111111111111111111111111?tradeId=wrong-token",
    chain: "Robinhood",
    contractAddress: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
  }), {
    fomoUrl: "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
    swapUrl: "https://fomo.family/tokens/robinhood/0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
  });
});

test("builds chain-specific buy URLs with the native token as input", () => {
  const contractAddress = "8DPB5jBfDCmh6gLxP3CVXwtuVN8m9vJw8n6dQ1XjFezH";
  assert.equal(
    signalSwapUrl({ signalSource: "x", chain: "Solana", contractAddress }),
    `https://jup.ag/swap/SOL-${contractAddress}`,
  );
  const evmContractAddress = "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a";
  assert.equal(
    signalSwapUrl({ signalSource: "x", chain: "BSC", contractAddress: evmContractAddress }),
    `https://pancakeswap.finance/swap?chain=bsc&inputCurrency=BNB&outputCurrency=${evmContractAddress}`,
  );
  assert.equal(
    signalSwapUrl({ signalSource: "x", chain: "Robinhood", contractAddress: evmContractAddress }),
    `https://1inch.com/swap?src=4663:ETH&dst=4663:${evmContractAddress}`,
  );
});

test("uses the configured chain swap for Fomo signals while preserving the Fomo page action", () => {
  const contractAddress = "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a";
  assert.equal(signalSwapUrl({
    signalSource: "fomo",
    sourceUrl: `https://fomo.family/tokens/robinhood/${contractAddress}?tradeId=trade-1`,
    chain: "Robinhood",
    contractAddress,
  }), `https://1inch.com/swap?src=4663:ETH&dst=4663:${contractAddress}`);
  assert.equal(fomoTokenActionUrls({
    sourceUrl: `https://fomo.family/tokens/robinhood/${contractAddress}?tradeId=trade-1`,
    chain: "Robinhood",
    contractAddress,
  }).fomoUrl, `https://fomo.family/tokens/robinhood/${contractAddress}?tradeId=trade-1`);
});

test("rejects unsupported chains and invalid contract addresses for swaps", () => {
  assert.equal(signalSwapUrl({
    signalSource: "x",
    chain: "Ethereum",
    contractAddress: "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a",
  }), undefined);
  assert.equal(signalSwapUrl({ chain: "BSC", contractAddress: "0x1234" }), undefined);
  assert.equal(signalSwapUrl({ chain: "Solana", contractAddress: "not-a-mint" }), undefined);
});

test("maps DApp chains to the matching wallet network", () => {
  assert.deepEqual(walletNetworkForChain("Solana"), { family: "solana", chain: "Solana" });
  assert.deepEqual(walletNetworkForChain("BSC"), { family: "evm", chain: "BSC", chainId: 56 });
  assert.deepEqual(walletNetworkForChain("Robinhood"), { family: "evm", chain: "Robinhood", chainId: 4663 });
  assert.equal(walletNetworkForChain("Unknown"), undefined);
});
