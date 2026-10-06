"use client";

import { Bot, ExternalLink, KeyRound, Save, ShieldCheck, Trash2 } from "lucide-react";
import type { BinanceAgentEnvironment, BinanceAgentPreferences } from "@/lib/binanceAgent";

export interface BinanceAgentCredentialStatus {
  environment: BinanceAgentEnvironment;
  apiKeySaved: boolean;
  secretKeySaved: boolean;
  ready: boolean;
}

interface BinanceAgentConfigurationProps {
  locale: "zh" | "en";
  preferences: BinanceAgentPreferences;
  apiKey: string;
  secretKey: string;
  status: BinanceAgentCredentialStatus | null;
  busy: boolean;
  desktop: boolean;
  onPreferencesChange: (value: BinanceAgentPreferences) => void;
  onApiKeyChange: (value: string) => void;
  onSecretKeyChange: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onOpenDocs: () => void;
}

const COPY = {
  zh: {
    title: "Binance Agent OS",
    hint: "让 AI 查询 Binance 现货账户，并在短时预览、逐笔确认和单笔限额内执行下单或撤单。",
    mcp: "官方 Agentic MCP",
    mcpHint: "OAuth 连接使用隔离的 Agentic 子账户，不需要在 FnzSafe 保存 API Key；当前可按 Binance 官方文档连接到受支持的 Agent 客户端。",
    docs: "连接文档",
    api: "Exchange API",
    apiHint: "FnzSafe 仅支持 HMAC-SHA256 类型的现货 API Key，启用行情、账户、下单和撤单，不提供提现或任意签名能力。请关闭提现权限并限制 IP。",
    environment: "环境",
    testnet: "Spot Testnet",
    production: "生产环境",
    apiKey: "API Key",
    secretKey: "HMAC Secret Key",
    stored: "凭据已安全保存",
    apiPlaceholder: "输入 Binance API Key",
    secretPlaceholder: "输入 Binance Secret Key",
    replacePlaceholder: "输入新值以替换已保存凭据",
    save: "安全保存凭据",
    remove: "移除凭据",
    trading: "允许 AI 交易",
    tradingHint: "关闭时只允许查询和生成订单预览。每次执行仍需用户在对话中输入 CONFIRM。",
    limit: "单笔最大计价金额",
    limitHint: "按交易对的计价资产计算，例如 USDT。AI 不能拆单绕过此限制。",
    productionWarning: "生产环境会使用真实资金。建议先在 Spot Testnet 验证完整流程。",
    desktopOnly: "凭据只能在 FnzSafe 桌面客户端中配置。",
  },
  en: {
    title: "Binance Agent OS",
    hint: "Let AI inspect Binance Spot accounts and place or cancel orders behind short-lived previews, per-action confirmation, and a per-order limit.",
    mcp: "Official Agentic MCP",
    mcpHint: "The OAuth connection uses an isolated Agentic sub-account and does not require FnzSafe to store an API key. Follow Binance's official guide to connect a supported agent client.",
    docs: "Connection guide",
    api: "Exchange API",
    apiHint: "FnzSafe supports HMAC-SHA256 Spot API keys only, exposing market data, account reads, orders, and cancellation without withdrawals or arbitrary signing. Disable withdrawals and restrict the key's IPs.",
    environment: "Environment",
    testnet: "Spot Testnet",
    production: "Production",
    apiKey: "API Key",
    secretKey: "HMAC Secret Key",
    stored: "Credentials securely stored",
    apiPlaceholder: "Enter Binance API Key",
    secretPlaceholder: "Enter Binance Secret Key",
    replacePlaceholder: "Enter new values to replace stored credentials",
    save: "Securely save credentials",
    remove: "Remove credentials",
    trading: "Allow AI trading",
    tradingHint: "When off, AI can only read data and create previews. Every execution still requires the user to type CONFIRM in chat.",
    limit: "Maximum quote value per order",
    limitHint: "Measured in the pair's quote asset, such as USDT. The AI cannot split orders to bypass this limit.",
    productionWarning: "Production uses real funds. Validate the complete flow on Spot Testnet first.",
    desktopOnly: "Credentials can only be configured in the FnzSafe desktop app.",
  },
} as const;

export function BinanceAgentConfiguration(props: BinanceAgentConfigurationProps) {
  const copy = COPY[props.locale];
  const ready = props.status?.ready === true;
  const replacePlaceholder = ready ? copy.replacePlaceholder : undefined;

  return (
    <div className="space-y-5">
      <section className="space-y-3 border-b border-white/10 pb-5">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-amber-400/10 text-amber-300"><Bot className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-gray-100">{copy.title}</h3><p className="mt-1 text-xs leading-5 text-gray-500">{copy.hint}</p></div>
        </div>
      </section>

      <section className="space-y-3 border-b border-white/10 pb-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div><h4 className="text-sm font-medium text-gray-200">{copy.mcp}</h4><p className="mt-1 max-w-3xl text-xs leading-5 text-gray-500">{copy.mcpHint}</p></div>
          <button type="button" onClick={props.onOpenDocs} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-white/10 px-3 text-xs text-gray-200 hover:bg-white/[0.07]"><ExternalLink className="h-3.5 w-3.5" />{copy.docs}</button>
        </div>
        <code className="block break-all rounded-md bg-black/25 px-3 py-2 text-[11px] text-gray-400">https://agent.binance.com/mcp/agentic</code>
      </section>

      <section className="space-y-4">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-medium text-gray-200">{copy.api}</h4>{ready && <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300"><ShieldCheck className="h-3 w-3" />{copy.stored}</span>}</div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-gray-500">{copy.apiHint}</p>
        </div>

        <div>
          <span className="mb-1.5 block text-[11px] text-gray-500">{copy.environment}</span>
          <div className="grid max-w-md grid-cols-2 gap-1 rounded-md border border-white/10 bg-black/20 p-1">
            {(["testnet", "production"] as const).map((environment) => (
              <button key={environment} type="button" disabled={props.busy} onClick={() => props.onPreferencesChange({ ...props.preferences, environment })} className={`h-8 rounded text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${props.preferences.environment === environment ? "bg-white text-black" : "text-gray-400 hover:bg-white/[0.07]"}`}>{environment === "testnet" ? copy.testnet : copy.production}</button>
            ))}
          </div>
          {props.preferences.environment === "production" && <p className="mt-2 text-xs text-amber-300">{copy.productionWarning}</p>}
        </div>

        {!props.desktop && <p className="rounded-md border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-xs text-amber-200">{copy.desktopOnly}</p>}

        <div className="grid gap-3 md:grid-cols-2">
          <label><span className="mb-1 block text-[11px] text-gray-500">{copy.apiKey}</span><div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600" /><input type="password" value={props.apiKey} onChange={(event) => props.onApiKeyChange(event.target.value)} placeholder={replacePlaceholder ?? copy.apiPlaceholder} autoComplete="new-password" spellCheck={false} disabled={!props.desktop || props.busy} className="h-10 w-full rounded-md border border-white/10 bg-zinc-950 pl-9 pr-3 text-sm text-gray-200 outline-none placeholder:text-gray-700 focus:border-amber-300/30 disabled:opacity-50" /></div></label>
          <label><span className="mb-1 block text-[11px] text-gray-500">{copy.secretKey}</span><div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600" /><input type="password" value={props.secretKey} onChange={(event) => props.onSecretKeyChange(event.target.value)} placeholder={replacePlaceholder ?? copy.secretPlaceholder} autoComplete="new-password" spellCheck={false} disabled={!props.desktop || props.busy} className="h-10 w-full rounded-md border border-white/10 bg-zinc-950 pl-9 pr-3 text-sm text-gray-200 outline-none placeholder:text-gray-700 focus:border-amber-300/30 disabled:opacity-50" /></div></label>
        </div>

        <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_minmax(180px,260px)]">
          <label className="flex items-start justify-between gap-4 rounded-md border border-white/10 bg-black/20 p-3"><span><span className="block text-sm text-gray-200">{copy.trading}</span><span className="mt-1 block text-xs leading-5 text-gray-500">{copy.tradingHint}</span></span><input type="checkbox" checked={props.preferences.tradingEnabled} onChange={(event) => props.onPreferencesChange({ ...props.preferences, tradingEnabled: event.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-amber-400" /></label>
          <label className="rounded-md border border-white/10 bg-black/20 p-3"><span className="block text-sm text-gray-200">{copy.limit}</span><input type="number" min={1} max={1_000_000} step="1" value={props.preferences.maxOrderQuote} onChange={(event) => props.onPreferencesChange({ ...props.preferences, maxOrderQuote: Math.min(1_000_000, Math.max(1, Number(event.target.value) || 1)) })} className="mt-2 h-9 w-full rounded-md border border-white/10 bg-zinc-950 px-2.5 text-sm text-gray-200 outline-none focus:border-amber-300/30" /><span className="mt-1 block text-[11px] leading-4 text-gray-600">{copy.limitHint}</span></label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={props.onSave} disabled={!props.desktop || props.busy || props.apiKey.trim().length < 16 || props.secretKey.trim().length < 16} className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-amber-300 px-3 text-xs font-semibold text-black hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"><Save className="h-3.5 w-3.5" />{copy.save}</button>
          {ready && <button type="button" onClick={props.onDelete} disabled={props.busy} className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-red-300/20 px-3 text-xs text-red-200 hover:bg-red-500/10 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" />{copy.remove}</button>}
        </div>
      </section>
    </div>
  );
}
