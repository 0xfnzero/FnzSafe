export type ResearchAiProviderKind =
  | "local"
  | "deepseek"
  | "gpt"
  | "grok"
  | "kimi"
  | "glm"
  | "minimax"
  | "openai"
  | "ollama";

export interface ResearchAiProviderPreset {
  kind: ResearchAiProviderKind;
  label: string;
  endpoint: string;
  model: string;
  requiresApiKey: boolean;
}

export const RESEARCH_AI_PROVIDER_PRESETS: readonly ResearchAiProviderPreset[] = [
  { kind: "local", label: "", endpoint: "", model: "", requiresApiKey: false },
  { kind: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com", model: "deepseek-chat", requiresApiKey: true },
  { kind: "gpt", label: "GPT / OpenAI", endpoint: "https://api.openai.com/v1", model: "gpt-5.2", requiresApiKey: true },
  { kind: "grok", label: "Grok / xAI", endpoint: "https://api.x.ai/v1", model: "grok-4-latest", requiresApiKey: true },
  { kind: "kimi", label: "Kimi / Moonshot", endpoint: "https://api.moonshot.cn/v1", model: "kimi-k2-turbo-preview", requiresApiKey: true },
  { kind: "glm", label: "GLM / 智谱", endpoint: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6", requiresApiKey: true },
  { kind: "minimax", label: "MiniMax", endpoint: "https://api.minimax.io/v1", model: "MiniMax-M2", requiresApiKey: true },
  { kind: "openai", label: "", endpoint: "https://api.openai.com/v1", model: "", requiresApiKey: true },
  { kind: "ollama", label: "Ollama", endpoint: "http://127.0.0.1:11434/v1", model: "", requiresApiKey: false },
];

export function researchAiProviderPreset(kind: ResearchAiProviderKind): ResearchAiProviderPreset {
  return RESEARCH_AI_PROVIDER_PRESETS.find((preset) => preset.kind === kind) ?? RESEARCH_AI_PROVIDER_PRESETS[0];
}

export function isResearchAiProviderKind(value: unknown): value is ResearchAiProviderKind {
  return typeof value === "string" && RESEARCH_AI_PROVIDER_PRESETS.some((preset) => preset.kind === value);
}
