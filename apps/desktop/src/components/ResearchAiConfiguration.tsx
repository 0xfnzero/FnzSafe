"use client";

import { RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react";
import {
  researchAiProviderPreset,
  type ResearchAiProviderKind,
} from "@/lib/researchAiProviders";

export interface ResearchAiConfigurationLabels {
  provider: string;
  localResearch: string;
  openAiCompatible: string;
  model: string;
  modelPlaceholder: string;
  keyStored: string;
  keyStoredPlaceholder: string;
  keySecurePlaceholder: string;
  saveKey: string;
  removeKey: string;
}

interface ResearchAiConfigurationProps {
  providerKind: ResearchAiProviderKind;
  endpoint: string;
  model: string;
  apiKey: string;
  keySaved: boolean;
  busy: boolean;
  labels: ResearchAiConfigurationLabels;
  onProviderChange: (kind: ResearchAiProviderKind) => void;
  onEndpointChange: (endpoint: string) => void;
  onModelChange: (model: string) => void;
  onApiKeyChange: (apiKey: string) => void;
  onSaveApiKey: () => void;
  onDeleteApiKey: () => void;
  className?: string;
}

const PROVIDER_KINDS = ["deepseek", "gpt", "grok", "kimi", "glm", "minimax", "openai", "ollama"] as const;

export function ResearchAiConfiguration({
  providerKind,
  endpoint,
  model,
  apiKey,
  keySaved,
  busy,
  labels,
  onProviderChange,
  onEndpointChange,
  onModelChange,
  onApiKeyChange,
  onSaveApiKey,
  onDeleteApiKey,
  className = "",
}: ResearchAiConfigurationProps) {
  const preset = researchAiProviderPreset(providerKind);

  return (
    <div className={`grid gap-3 md:grid-cols-2 xl:grid-cols-[160px_minmax(220px,1fr)_minmax(160px,280px)_minmax(220px,340px)] ${className}`}>
      <label>
        <span className="mb-1 block text-[11px] text-gray-500">{labels.provider}</span>
        <select
          value={providerKind}
          onChange={(event) => onProviderChange(event.target.value as ResearchAiProviderKind)}
          className="h-9 w-full rounded-md border border-white/10 bg-zinc-950 px-2 text-sm text-gray-200 outline-none focus:border-sky-300/30"
        >
          <option value="local">{labels.localResearch}</option>
          {PROVIDER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {researchAiProviderPreset(kind).label || labels.openAiCompatible}
            </option>
          ))}
        </select>
      </label>

      {providerKind !== "local" && (
        <>
          <label>
            <span className="mb-1 block text-[11px] text-gray-500">Endpoint</span>
            <input
              value={endpoint}
              onChange={(event) => onEndpointChange(event.target.value)}
              className="h-9 w-full rounded-md border border-white/10 bg-zinc-950 px-2.5 text-sm text-gray-200 outline-none placeholder:text-gray-700 focus:border-sky-300/30"
              placeholder={preset.endpoint}
              spellCheck={false}
            />
          </label>
          <label>
            <span className="mb-1 block text-[11px] text-gray-500">{labels.model}</span>
            <input
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
              className="h-9 w-full rounded-md border border-white/10 bg-zinc-950 px-2.5 text-sm text-gray-200 outline-none placeholder:text-gray-700 focus:border-sky-300/30"
              placeholder={preset.model || labels.modelPlaceholder}
              spellCheck={false}
            />
          </label>
          {preset.requiresApiKey && (
            <div>
              <div className="mb-1 flex min-h-4 items-center justify-between gap-2">
                <span className="text-[11px] text-gray-500">API Key</span>
                {keySaved && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                    <ShieldCheck className="h-3 w-3" />
                    {labels.keyStored}
                  </span>
                )}
              </div>
              <div className="flex gap-1.5">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => onApiKeyChange(event.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-md border border-white/10 bg-zinc-950 px-2.5 text-sm text-gray-200 outline-none placeholder:text-gray-700 focus:border-sky-300/30"
                  placeholder={keySaved ? labels.keyStoredPlaceholder : labels.keySecurePlaceholder}
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={onSaveApiKey}
                  disabled={busy || apiKey.trim().length < 8}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-sky-400/20 bg-sky-400/10 text-sky-300 hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-35"
                  title={labels.saveKey}
                  aria-label={labels.saveKey}
                >
                  {busy && !keySaved
                    ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    : <Save className="h-3.5 w-3.5" />}
                </button>
                {keySaved && (
                  <button
                    type="button"
                    onClick={onDeleteApiKey}
                    disabled={busy}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-red-400/15 bg-red-400/[0.06] text-red-300 hover:bg-red-400/15 disabled:cursor-not-allowed disabled:opacity-35"
                    title={labels.removeKey}
                    aria-label={labels.removeKey}
                  >
                    {busy
                      ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
