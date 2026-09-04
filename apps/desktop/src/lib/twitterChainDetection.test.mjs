import assert from "node:assert/strict";
import test from "node:test";
import {
  extractTweetTokenCandidates,
  isSolanaTokenAddress,
  tweetTokenCandidateIdentity,
} from "./twitterChainDetection.ts";

const EVM_ADDRESS = `0x${"1".repeat(40)}`;

test("detects common English, Chinese, and abbreviated chain names", () => {
  const cases = [
    ["ETH chain", "Ethereum"],
    ["以太坊", "Ethereum"],
    ["bsc", "BSC"],
    ["ARB", "Arbitrum"],
    ["OP mainnet", "Optimism"],
    ["ZKS", "zkSync Era"],
    ["RBH", "Robinhood"],
    ["ronbinhood链", "Robinhood"],
  ];
  for (const [label, expected] of cases) {
    const result = extractTweetTokenCandidates(`${label} CA: ${EVM_ADDRESS}`);
    assert.equal(result.candidates[0]?.chain, expected);
  }
});

test("prefers the current nearby chain over a previous chain mention", () => {
  const result = extractTweetTokenCandidates(
    `Previously deployed on BSC, now launched on Robinhood chain. CA: ${EVM_ADDRESS}`,
  );
  assert.equal(result.candidates[0]?.chain, "Robinhood");
});

test("does not treat a cashtagged native token as a chain declaration", () => {
  const result = extractTweetTokenCandidates("Watching $ETH closely");
  assert.deepEqual(result.tokenSymbols, ["$ETH"]);
  assert.equal(result.candidates[0]?.chain, "Unknown");
});

test("creates one resolvable candidate per cashtag when no address is present", () => {
  const result = extractTweetTokenCandidates("Robinhood: $PONS $USELESS $MARSCOIN");

  assert.deepEqual(result.candidates, [
    { chain: "Robinhood", tokenSymbols: ["$PONS"] },
    { chain: "Robinhood", tokenSymbols: ["$USELESS"] },
    { chain: "Robinhood", tokenSymbols: ["$MARSCOIN"] },
  ]);
});

test("preserves case-sensitive non-EVM candidate identities", () => {
  const solanaAddress = "So11111111111111111111111111111111111111112";
  assert.equal(isSolanaTokenAddress(solanaAddress), true);
  assert.equal(isSolanaTokenAddress("1".repeat(32)), false);
  const result = extractTweetTokenCandidates(`Solana CA: ${solanaAddress}`);
  assert.equal(result.candidates[0]?.address, solanaAddress);
  assert.equal(tweetTokenCandidateIdentity(result.candidates[0]), solanaAddress);
  assert.equal(
    tweetTokenCandidateIdentity({ address: "0xAaBb", chain: "Ethereum" }),
    "0xaabb",
  );
  const uppercasePrefix = `0X${"A".repeat(40)}`;
  const uppercaseResult = extractTweetTokenCandidates(`CA: ${uppercasePrefix}`);
  assert.equal(uppercaseResult.candidates[0]?.chain, "Unknown EVM");
  assert.equal(tweetTokenCandidateIdentity(uppercaseResult.candidates[0]), uppercasePrefix.toLowerCase());
});

test("associates each contract with its nearest ticker instead of the first ticker", () => {
  const firstAddress = `0x${"1".repeat(40)}`;
  const secondAddress = `0x${"2".repeat(40)}`;
  const result = extractTweetTokenCandidates(
    `$FIRST CA: ${firstAddress}\n$SECOND CA: ${secondAddress}`,
  );

  assert.deepEqual(result.candidates.map((candidate) => candidate.tokenSymbols), [
    ["$FIRST"],
    ["$SECOND"],
  ]);
});

test("does not bind a distant ticker to a contract address", () => {
  const result = extractTweetTokenCandidates(`$FIRST\n${"context ".repeat(30)}CA: ${EVM_ADDRESS}`);
  assert.equal(result.candidates[0]?.tokenSymbols, undefined);
});
