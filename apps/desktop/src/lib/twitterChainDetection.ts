const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const EVM_ADDRESS_RE = /0x[a-f0-9]{40}\b/gi;
const SUI_ADDRESS_RE = /0x[a-f0-9]{64}\b/gi;
const SOLANA_ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const TRON_ADDRESS_RE = /T[1-9A-HJ-NP-Za-km-z]{33}\b/g;
const TON_ADDRESS_RE = /\b(?:EQ|UQ)[A-Za-z0-9_-]{46}(?![A-Za-z0-9_-])/g;
const TOKEN_CASHTAG_RE = /\$[A-Za-z][A-Za-z0-9_]{0,14}\b/g;

export type TweetSignalChain =
  | "Solana" | "Ethereum" | "BSC" | "Base" | "Polygon" | "Arbitrum" | "Optimism"
  | "Avalanche" | "Fantom" | "Linea" | "Scroll" | "zkSync Era" | "Blast" | "Mantle"
  | "opBNB" | "Cronos" | "Gnosis" | "Celo" | "Moonbeam" | "Moonriver" | "Aurora"
  | "Harmony" | "HECO" | "OKX Chain" | "X Layer" | "Kava EVM" | "Metis" | "Ronin"
  | "Monad" | "Berachain" | "Sonic" | "HyperEVM" | "World Chain" | "Zora" | "Mode"
  | "Taiko" | "Manta Pacific" | "Rootstock" | "Bitlayer" | "Merlin Chain" | "Kaia"
  | "Sei" | "Sui" | "Aptos" | "TON" | "Tron" | "Bitcoin" | "Cardano" | "Near"
  | "Injective" | "Cosmos" | "Osmosis" | "Polkadot" | "Kusama" | "XRP Ledger"
  | "Dogecoin" | "Litecoin" | "Robinhood" | "Unknown EVM" | "Unknown";

type TweetChainFamily = "evm" | "move" | "other";

interface TweetChainRule {
  chain: TweetSignalChain;
  family: TweetChainFamily;
  patterns: RegExp[];
}

const TWEET_CHAIN_RULES: TweetChainRule[] = [
  { chain: "Robinhood", family: "evm", patterns: [/\b(?:robinhood|ronbinhood)(?:\s+chain)?\b/gi, /\bRBH\b/g, /\$rbh\b/gi, /(?:Robinhood|Ronbinhood)\s*链/gi] },
  { chain: "Ethereum", family: "evm", patterns: [/\bethereum\b/gi, /\beth\b/gi, /\$eth\b/gi, /\berc-?20\b/gi, /以太(?:坊|链|网络)?/g] },
  { chain: "BSC", family: "evm", patterns: [/\bbsc\b/gi, /\bBNB\b/g, /\bbnb\s*(?:smart\s*)?chain\b/gi, /\$bnb\b/gi, /\bbep-?20\b/gi, /币安(?:智能|智慧)?链|币安链|BNB\s*链/gi] },
  { chain: "Base", family: "evm", patterns: [/\bbase\s+(?:chain|network|mainnet)\b/gi, /\bon\s+base\b/gi, /\$base\b/gi, /Base\s*(?:链|网络|主网)/g] },
  { chain: "Polygon", family: "evm", patterns: [/\bpolygon\b/gi, /\bmatic\b/gi, /\$matic\b/gi, /Polygon\s*链|马蹄链|多边形链/gi] },
  { chain: "Arbitrum", family: "evm", patterns: [/\barbitrum(?:\s+one)?\b/gi, /\bARB\b/g, /\$arb\b/gi, /\barb\s+(?:chain|network|mainnet)\b/gi, /Arbitrum\s*链|ARB\s*链/gi] },
  { chain: "Optimism", family: "evm", patterns: [/\boptimism\b/gi, /\bOP\b/g, /\bop\s+mainnet\b/gi, /\$op\b/gi, /Optimism\s*链|OP\s*链/gi] },
  { chain: "Avalanche", family: "evm", patterns: [/\bavalanche\b/gi, /\bavax\b/gi, /\$avax\b/gi, /雪崩链|Avalanche\s*链/gi] },
  { chain: "Fantom", family: "evm", patterns: [/\bfantom\b/gi, /\bFTM\b/g, /\$ftm\b/gi, /Fantom\s*链/gi] },
  { chain: "Linea", family: "evm", patterns: [/\blinea\b/gi, /Linea\s*链/gi] },
  { chain: "Scroll", family: "evm", patterns: [/\bscroll\s+(?:chain|network|mainnet)\b/gi, /\bon\s+scroll\b/gi, /Scroll\s*链/g] },
  { chain: "zkSync Era", family: "evm", patterns: [/\bzksync(?:\s+era)?\b/gi, /\bZKS\b/g, /\$zks\b/gi, /zkSync\s*链/gi] },
  { chain: "Blast", family: "evm", patterns: [/\bblast\s+(?:chain|network|mainnet|l2)\b/gi, /\bon\s+blast\b/gi, /Blast\s*链/g] },
  { chain: "Mantle", family: "evm", patterns: [/\bmantle\s+(?:chain|network|mainnet)\b/gi, /\bon\s+mantle\b/gi, /\bMNT\b/g, /\$mnt\b/gi, /Mantle\s*链/g] },
  { chain: "opBNB", family: "evm", patterns: [/\bopbnb\b/gi, /opBNB\s*链/gi] },
  { chain: "Cronos", family: "evm", patterns: [/\bcronos\b/gi, /\bCRO\b/g, /\$cro\b/gi, /Cronos\s*链/gi] },
  { chain: "Gnosis", family: "evm", patterns: [/\bgnosis\s+chain\b/gi, /\bxdai\b/gi, /Gnosis\s*链/gi] },
  { chain: "Celo", family: "evm", patterns: [/\bcelo\b/gi, /Celo\s*链/gi] },
  { chain: "Moonbeam", family: "evm", patterns: [/\bmoonbeam\b/gi, /\bGLMR\b/g, /\$glmr\b/gi, /Moonbeam\s*链/gi] },
  { chain: "Moonriver", family: "evm", patterns: [/\bmoonriver\b/gi, /\bMOVR\b/g, /\$movr\b/gi, /Moonriver\s*链/gi] },
  { chain: "Aurora", family: "evm", patterns: [/\baurora\s+(?:chain|network|mainnet)\b/gi, /\bon\s+aurora\b/gi, /Aurora\s*链/g] },
  { chain: "Harmony", family: "evm", patterns: [/\bharmony\s+(?:chain|network|mainnet)\b/gi, /\bon\s+harmony\b/gi, /Harmony\s*链/g] },
  { chain: "HECO", family: "evm", patterns: [/\bheco\b/gi, /火币(?:生态)?链|火币智能链/g] },
  { chain: "OKX Chain", family: "evm", patterns: [/\b(?:okx chain|oktc)\b/gi, /OKX\s*链|欧易链/gi] },
  { chain: "X Layer", family: "evm", patterns: [/\bx\s*layer\b/gi, /X\s*Layer\s*链/gi] },
  { chain: "Kava EVM", family: "evm", patterns: [/\bkava\s+(?:evm|chain|network)\b/gi, /Kava\s*链/g] },
  { chain: "Metis", family: "evm", patterns: [/\bmetis\s+(?:chain|network|mainnet|andromeda)\b/gi, /\bon\s+metis\b/gi, /Metis\s*链/g] },
  { chain: "Ronin", family: "evm", patterns: [/\bronin\s+(?:chain|network|mainnet)\b/gi, /\bon\s+ronin\b/gi, /Ronin\s*链/g] },
  { chain: "Monad", family: "evm", patterns: [/\bmonad\b/gi, /Monad\s*链/g] },
  { chain: "Berachain", family: "evm", patterns: [/\bberachain\b/gi, /\$bera\b/gi, /Bera\s*链/gi] },
  { chain: "Sonic", family: "evm", patterns: [/\bsonic\s+(?:chain|network|mainnet)\b/gi, /\bon\s+sonic\b/gi, /Sonic\s*链/g] },
  { chain: "HyperEVM", family: "evm", patterns: [/\b(?:hyperevm|hyperliquid\s+evm)\b/gi, /HyperEVM\s*链/gi] },
  { chain: "World Chain", family: "evm", patterns: [/\bworld\s+chain\b/gi, /World\s*Chain\s*链/gi] },
  { chain: "Zora", family: "evm", patterns: [/\bzora\s+(?:chain|network|mainnet)\b/gi, /\bon\s+zora\b/gi, /Zora\s*链/g] },
  { chain: "Mode", family: "evm", patterns: [/\bmode\s+(?:chain|network|mainnet)\b/gi, /\bon\s+mode\b/gi, /Mode\s*链/g] },
  { chain: "Taiko", family: "evm", patterns: [/\btaiko\b/gi, /Taiko\s*链/g] },
  { chain: "Manta Pacific", family: "evm", patterns: [/\bmanta\s+pacific\b/gi, /Manta\s*链/g] },
  { chain: "Rootstock", family: "evm", patterns: [/\brootstock\b/gi, /\brsk\s+(?:chain|network|mainnet)\b/gi, /Rootstock\s*链/g] },
  { chain: "Bitlayer", family: "evm", patterns: [/\bbitlayer\b/gi, /Bitlayer\s*链/g] },
  { chain: "Merlin Chain", family: "evm", patterns: [/\bmerlin\s+chain\b/gi, /Merlin\s*链/g] },
  { chain: "Kaia", family: "evm", patterns: [/\bkaia\b/gi, /\bklaytn\b/gi, /Kaia\s*链/g] },
  { chain: "Sei", family: "evm", patterns: [/\bsei\s+(?:chain|network|mainnet|evm)\b/gi, /\bSEI\b/g, /\$sei\b/gi, /Sei\s*链/g] },
  { chain: "Sui", family: "move", patterns: [/\bsui\b/gi, /\$sui\b/gi, /Sui\s*链/g] },
  { chain: "Aptos", family: "move", patterns: [/\baptos\b/gi, /\bAPT\b/g, /\$apt\b/gi, /Aptos\s*链/g] },
  { chain: "Solana", family: "other", patterns: [/\bsolana\b/gi, /\bSOL\b/g, /\$sol\b/gi, /\bsol\s+(?:chain|network|mainnet)\b/gi, /pump\.fun|pumpfun|jup\.ag|raydium/gi, /Solana\s*链|索拉纳|索拉娜/g] },
  { chain: "TON", family: "other", patterns: [/\bthe\s+open\s+network\b/gi, /\bTON\b/g, /\$ton\b/gi, /\bton\s+(?:chain|network|mainnet)\b/gi, /TON\s*链/g] },
  { chain: "Tron", family: "other", patterns: [/\btron\b/gi, /\bTRX\b/g, /\$trx\b/gi, /\btrx\s+(?:chain|network|mainnet)\b/gi, /波场(?:链|网络)?/g] },
  { chain: "Bitcoin", family: "other", patterns: [/\bbitcoin\b/gi, /\bBTC\b/g, /\$btc\b/gi, /比特币(?:链|网络)?/g] },
  { chain: "Cardano", family: "other", patterns: [/\bcardano\b/gi, /\bADA\b/g, /\$ada\b/gi, /艾达币?|卡尔达诺/g] },
  { chain: "Near", family: "other", patterns: [/\bnear\s+(?:protocol|chain|network|mainnet)\b/gi, /\bNEAR\b/g, /\$near\b/gi, /NEAR\s*链/g] },
  { chain: "Injective", family: "other", patterns: [/\binjective\b/gi, /\bINJ\b/g, /\$inj\b/gi, /Injective\s*链/g] },
  { chain: "Cosmos", family: "other", patterns: [/\bcosmos\s+(?:hub|chain|network|mainnet)\b/gi, /\bATOM\b/g, /\$atom\b/gi, /Cosmos\s*链/g] },
  { chain: "Osmosis", family: "other", patterns: [/\bosmosis\b/gi, /\bOSMO\b/g, /\$osmo\b/gi, /Osmosis\s*链/g] },
  { chain: "Polkadot", family: "other", patterns: [/\bpolkadot\b/gi, /\bDOT\b/g, /\$dot\b/gi, /波卡(?:链|网络)?/g] },
  { chain: "Kusama", family: "other", patterns: [/\bkusama\b/gi, /\bKSM\b/g, /\$ksm\b/gi, /Kusama\s*链/g] },
  { chain: "XRP Ledger", family: "other", patterns: [/\bxrp\s+ledger\b/gi, /\bXRP\b/g, /\$xrp\b/gi, /\bripple\b/gi, /瑞波(?:链|网络|币)?/g] },
  { chain: "Dogecoin", family: "other", patterns: [/\bdogecoin\b/gi, /\bDOGE\b/g, /\$doge\b/gi, /狗狗币/g] },
  { chain: "Litecoin", family: "other", patterns: [/\blitecoin\b/gi, /\bLTC\b/g, /\$ltc\b/gi, /莱特币/g] },
];

const EVM_CHAINS = new Set(TWEET_CHAIN_RULES.filter((rule) => rule.family === "evm").map((rule) => rule.chain));
const MOVE_CHAINS = new Set(TWEET_CHAIN_RULES.filter((rule) => rule.family === "move").map((rule) => rule.chain));

function decodedBase58ByteLength(value: string): number | null {
  const bytes: number[] = [];
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === "1") leadingZeroBytes += 1;
  return bytes.length + leadingZeroBytes;
}

export function isSolanaTokenAddress(candidate: string): boolean {
  if (candidate.length < 32 || candidate.length > 44 || /^\d+$/.test(candidate)) return false;
  return decodedBase58ByteLength(candidate) === 32;
}

function isLikelySolanaTokenAddress(candidate: string, source: string, index: number): boolean {
  if (!isSolanaTokenAddress(candidate)) return false;
  const before = source[index - 1] ?? "";
  const after = source[index + candidate.length] ?? "";
  return !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
}

function detectMentionedChain(
  text: string,
  anchors: number[],
  allowedChains?: Set<TweetSignalChain>,
): TweetSignalChain | undefined {
  let best: { chain: TweetSignalChain; score: number } | undefined;
  for (const rule of TWEET_CHAIN_RULES) {
    if (allowedChains && !allowedChains.has(rule.chain)) continue;
    for (const pattern of rule.patterns) {
      const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      for (const match of text.matchAll(matcher)) {
        const start = match.index ?? 0;
        if (match[0].startsWith("$") || text[start - 1] === "$") continue;
        const end = start + match[0].length;
        const distance = anchors.length > 0
          ? Math.min(...anchors.map((anchor) => Math.min(Math.abs(anchor - start), Math.abs(anchor - end))))
          : Math.max(0, text.length - end);
        const before = text.slice(Math.max(0, start - 36), start);
        const after = text.slice(end, Math.min(text.length, end + 36));
        const nearby = text.slice(Math.max(0, start - 12), Math.min(text.length, end + 12));
        let score = 2_000 - Math.min(distance, 2_000) + Math.min(match[0].length, 40);
        if (/(?:chain|network|mainnet|生态|主网|公链|链|网络)/i.test(nearby)) score += 80;
        if (/(?:now|current(?:ly)?|migrat(?:e|ed|ing)|launch(?:ed|ing)?|deploy(?:ed|ing)?|现在|当前|如今|迁移|部署|上线|发行)[^\n]{0,20}$/i.test(before)) score += 140;
        if (/(?:formerly|previous(?:ly)?|used\s+to|old|before|曾经|此前|之前|原来|过去|旧)[^\n]{0,20}$/i.test(before)) score -= 140;
        if (match[0] === "OP" && /(?:楼主|原推|原作者|original\s+poster|author|posted|said|says|reply|thread)/i.test(`${before} ${after}`)) continue;
        if (anchors.some((anchor) => end <= anchor && anchor - end <= 24)) score += 20;
        if (!best || score > best.score) best = { chain: rule.chain, score };
      }
    }
  }
  return best?.chain;
}

function detectAddressChain(text: string, address: string): TweetSignalChain {
  const addressIndex = Math.max(0, text.toLowerCase().indexOf(address.toLowerCase()));
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return "Tron";
  if (/^(?:EQ|UQ)[A-Za-z0-9_-]{46}$/.test(address)) return "TON";
  if (/^0x/i.test(address) && address.length === 66) {
    return detectMentionedChain(text, [addressIndex], MOVE_CHAINS) || "Unknown";
  }
  if (/^0x/i.test(address)) {
    return detectMentionedChain(text, [addressIndex], EVM_CHAINS) || "Unknown EVM";
  }
  return "Solana";
}

export function detectTweetTokenChain(text: string, address?: string): TweetSignalChain {
  if (address) return detectAddressChain(text, address);
  const anchors = Array.from(text.matchAll(TOKEN_CASHTAG_RE), (match) => match.index ?? 0);
  return detectMentionedChain(text, anchors) || "Unknown";
}

export interface TweetTokenCandidate {
  address?: string;
  chain: TweetSignalChain;
  tokenSymbols?: string[];
}

interface PositionedTokenSymbol {
  symbol: string;
  index: number;
}

function nearestTokenSymbol(
  text: string,
  symbols: PositionedTokenSymbol[],
  addressIndex: number,
  addressLength: number,
): string[] | undefined {
  if (symbols.length === 0) return undefined;
  const addressEnd = addressIndex + addressLength;
  const ranked = symbols
    .map((candidate) => {
      const symbolEnd = candidate.index + candidate.symbol.length;
      const gapStart = symbolEnd <= addressIndex ? symbolEnd : addressEnd;
      const gapEnd = symbolEnd <= addressIndex ? addressIndex : candidate.index;
      const distance = Math.max(0, gapEnd - gapStart);
      const lineBreaks = (text.slice(gapStart, gapEnd).match(/\n/g) ?? []).length;
      return { ...candidate, distance, score: distance + lineBreaks * 160 };
    })
    .sort((left, right) => left.score - right.score || left.index - right.index);
  const nearest = ranked[0];
  const second = ranked[1];
  // A distant or tied ticker is not strong enough evidence to bind to a CA.
  if (!nearest || nearest.score > 160 || (second && second.score === nearest.score)) return undefined;
  return [nearest.symbol];
}

export function extractTweetTokenCandidates(text: string): {
  tokenSymbols: string[];
  candidates: TweetTokenCandidate[];
} {
  const positionedSymbols = Array.from(text.matchAll(TOKEN_CASHTAG_RE), (match) => ({
    symbol: match[0].toUpperCase(),
    index: match.index ?? 0,
  }));
  const tokenSymbols = Array.from(new Set(positionedSymbols.map((item) => item.symbol)));
  const candidates: TweetTokenCandidate[] = [];
  for (const match of text.matchAll(SUI_ADDRESS_RE)) {
    candidates.push({
      address: match[0],
      chain: detectAddressChain(text, match[0]),
      tokenSymbols: nearestTokenSymbol(text, positionedSymbols, match.index ?? 0, match[0].length),
    });
  }
  for (const match of text.matchAll(EVM_ADDRESS_RE)) {
    if (candidates.some((item) => item.address?.toLowerCase() === match[0].toLowerCase())) continue;
    candidates.push({
      address: match[0],
      chain: detectAddressChain(text, match[0]),
      tokenSymbols: nearestTokenSymbol(text, positionedSymbols, match.index ?? 0, match[0].length),
    });
  }
  for (const match of text.matchAll(TRON_ADDRESS_RE)) {
    candidates.push({
      address: match[0],
      chain: "Tron",
      tokenSymbols: nearestTokenSymbol(text, positionedSymbols, match.index ?? 0, match[0].length),
    });
  }
  for (const match of text.matchAll(TON_ADDRESS_RE)) {
    candidates.push({
      address: match[0],
      chain: "TON",
      tokenSymbols: nearestTokenSymbol(text, positionedSymbols, match.index ?? 0, match[0].length),
    });
  }
  for (const match of text.matchAll(SOLANA_ADDRESS_RE)) {
    const index = match.index ?? 0;
    if (isLikelySolanaTokenAddress(match[0], text, index)) {
      candidates.push({
        address: match[0],
        chain: "Solana",
        tokenSymbols: nearestTokenSymbol(text, positionedSymbols, index, match[0].length),
      });
    }
  }
  if (candidates.length === 0 && tokenSymbols.length > 0) {
    candidates.push({ chain: detectTweetTokenChain(text) });
  }
  return { tokenSymbols, candidates };
}

export function tweetTokenCandidateIdentity(candidate: TweetTokenCandidate): string | undefined {
  if (!candidate.address) return undefined;
  return /^0x/i.test(candidate.address)
    ? candidate.address.toLowerCase()
    : candidate.address;
}
