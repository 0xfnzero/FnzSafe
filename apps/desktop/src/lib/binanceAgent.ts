export type BinanceAgentEnvironment = "testnet" | "production";

export interface BinanceAgentPreferences {
  environment: BinanceAgentEnvironment;
  officialMcpEnabled: boolean;
  tradingEnabled: boolean;
  maxOrderQuote: number;
}

interface StorageReader {
  getItem: (key: string) => string | null;
}

export const BINANCE_AGENT_STORAGE_KEY = "fnzero-safe.binance-agent.v1";
export const DEFAULT_BINANCE_AGENT_PREFERENCES: BinanceAgentPreferences = {
  environment: "testnet",
  officialMcpEnabled: false,
  tradingEnabled: false,
  maxOrderQuote: 100,
};

export function normalizeBinanceAgentPreferences(value: unknown): BinanceAgentPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_BINANCE_AGENT_PREFERENCES };
  }
  const candidate = value as Record<string, unknown>;
  const environment = candidate.environment === "production" ? "production" : "testnet";
  const maxOrderQuote = typeof candidate.maxOrderQuote === "number" && Number.isFinite(candidate.maxOrderQuote)
    ? Math.min(1_000_000, Math.max(1, candidate.maxOrderQuote))
    : DEFAULT_BINANCE_AGENT_PREFERENCES.maxOrderQuote;
  return {
    environment,
    officialMcpEnabled: candidate.officialMcpEnabled === true,
    tradingEnabled: candidate.tradingEnabled === true,
    maxOrderQuote,
  };
}

export function readBinanceAgentPreferences(storage: StorageReader): BinanceAgentPreferences {
  try {
    const raw = storage.getItem(BINANCE_AGENT_STORAGE_KEY);
    return raw ? normalizeBinanceAgentPreferences(JSON.parse(raw)) : { ...DEFAULT_BINANCE_AGENT_PREFERENCES };
  } catch {
    return { ...DEFAULT_BINANCE_AGENT_PREFERENCES };
  }
}
