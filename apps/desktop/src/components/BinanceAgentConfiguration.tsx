"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Bot, CircleCheck, ExternalLink, KeyRound, Link2Off, LoaderCircle, PlugZap, QrCode, RefreshCw, Save, ShieldCheck, Trash2, WalletCards } from "lucide-react";
import type { BinanceAgentEnvironment, BinanceAgentPreferences } from "@/lib/binanceAgent";

export interface BinanceAgentCredentialStatus {
  environment: BinanceAgentEnvironment;
  apiKeySaved: boolean;
  secretKeySaved: boolean;
  ready: boolean;
}

export interface BinanceAgentCredentialTestResult {
  environment: BinanceAgentEnvironment;
  valid: boolean;
  canTrade: boolean;
  accountType: string;
  permissions: string[];
  verifiedAtMs: number;
}

interface BinanceMcpConnectionStatus {
  connected: boolean;
  refreshAvailable: boolean;
  expiresAt?: number;
  verified?: boolean;
  toolCount?: number;
  readOnlyToolCount?: number;
  writeToolCount?: number;
}

interface BinanceWalletSignin {
  qrCodeId: string;
  expireAt?: number;
  urlForWeb: string;
  pairingCode?: string;
}

interface BinanceAgentConfigurationProps {
  locale: "zh" | "en";
  preferences: BinanceAgentPreferences;
  apiKey: string;
  secretKey: string;
  status: BinanceAgentCredentialStatus | null;
  testResult: BinanceAgentCredentialTestResult | null;
  busy: boolean;
  desktop: boolean;
  onPreferencesChange: (value: BinanceAgentPreferences) => void;
  onApiKeyChange: (value: string) => void;
  onSecretKeyChange: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onTest: () => void;
  onOpenDocs: () => void;
  onOpenUrl: (url: string) => void;
}

const COPY = {
  zh: {
    title: "Binance Agent OS",
    hint: "连接 Binance Agentic MCP、现货 API 与 Agentic Wallet，让 AI 查询行情和账户，并在逐笔确认后执行中心化或链上交易。",
    mcp: "官方 Agentic MCP",
    mcpHint: "通过 Binance OAuth 连接隔离的 Agentic 子账户，不需要向 FnzSafe 提供 API Key。首次向 AI 提问时会打开 Binance 授权页。写操作仍会先生成预览，并要求下一条消息精确输入 CONFIRM。",
    mcpEnable: "启用官方 Agentic MCP",
    mcpEnableHint: "OAuth 令牌保存在本机应用数据目录；关闭后不会再连接官方 MCP。",
    mcpConnected: "OAuth 已连接",
    mcpDisconnected: "OAuth 未连接",
    connect: "授权并测试",
    reconnect: "重新授权",
    disconnect: "断开连接",
    refresh: "刷新连接状态",
    mcpVerified: "已验证 {tools} 个官方工具（{reads} 个只读，{writes} 个写操作）",
    scopes: "授权范围：行情（公开）、账户（只读）、交易、子账户内部划转。请只授予需要的权限；官方 MCP 永远没有提现权限。修改权限需要先断开再重新授权。",
    fundAccount: "首次入金",
    manageAccount: "权限与急停",
    fundingHint: "Agentic 子账户首次入金必须在 Binance 网页手工完成，AI 无法从主账户拉取资产。急停会断开全部 Agent，并取消该子账户的现货、杠杆和合约订单/仓位。",
    wallet: "Agentic Wallet",
    walletHint: "使用 Binance App 扫码连接隔离的 Agentic Wallet。支持链上行情、信号、钱包追踪、排行榜、Swap、限价单、Prediction、DeFi、合约调用与 x402；所有写操作仍需预览及后续 CONFIRM。",
    walletConnected: "钱包已连接",
    walletDisconnected: "钱包未连接",
    walletConnect: "获取登录二维码",
    walletVerify: "我已扫码，验证连接",
    walletDisconnect: "断开钱包",
    openSignin: "在浏览器打开",
    pairingCode: "配对码",
    qrExpired: "二维码已过期，请重新获取。",
    connectionError: "连接操作失败",
    disconnectConfirm: "确认断开 Binance OAuth？本机 OAuth 凭据将被移除。",
    walletDisconnectConfirm: "确认断开 Agentic Wallet？本机钱包会话将被清除。",
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
    test: "验证连接", verified: "连接已验证", readOnly: "当前 Key 无现货交易权限", canTrade: "具备现货交易权限",
  },
  en: {
    title: "Binance Agent OS",
    hint: "Connect Binance Agentic MCP, Spot API, and Agentic Wallet so AI can query markets and accounts, then execute centralized or on-chain trades after per-action confirmation.",
    mcp: "Official Agentic MCP",
    mcpHint: "Connect an isolated Agentic sub-account through Binance OAuth without giving FnzSafe an API key. The first AI request opens Binance authorization. Mutating tools still produce a preview and require a later message exactly equal to CONFIRM.",
    mcpEnable: "Enable official Agentic MCP",
    mcpEnableHint: "OAuth tokens stay in the local app-data directory. Turning this off stops connecting to the official MCP.",
    mcpConnected: "OAuth connected",
    mcpDisconnected: "OAuth not connected",
    connect: "Authorize and test",
    reconnect: "Reauthorize",
    disconnect: "Disconnect",
    refresh: "Refresh connection status",
    mcpVerified: "Verified {tools} official tools ({reads} read-only, {writes} state-changing)",
    scopes: "Scopes: Market Data (public), Account (read-only), Trade, and internal wallet movement. Grant only what is needed; the official MCP never has withdrawal access. Disconnect and reauthorize to change scopes.",
    fundAccount: "Fund account",
    manageAccount: "Permissions & emergency stop",
    fundingHint: "The first Agentic sub-account deposit must be completed manually on Binance Web; AI cannot pull funds from the main account. Emergency stop disconnects every agent and cancels this sub-account's Spot, Margin, and Futures orders/positions.",
    wallet: "Agentic Wallet",
    walletHint: "Connect an isolated Agentic Wallet with the Binance App. Supports on-chain markets, signals, wallet tracking, leaderboards, swaps, limit orders, Prediction, DeFi, contract calls, and x402; every write still requires a preview and later CONFIRM.",
    walletConnected: "Wallet connected",
    walletDisconnected: "Wallet not connected",
    walletConnect: "Get sign-in QR code",
    walletVerify: "Scanned, verify connection",
    walletDisconnect: "Disconnect wallet",
    openSignin: "Open in browser",
    pairingCode: "Pairing code",
    qrExpired: "This QR code has expired. Request a new one.",
    connectionError: "Connection operation failed",
    disconnectConfirm: "Disconnect Binance OAuth and remove its local credentials?",
    walletDisconnectConfirm: "Disconnect Agentic Wallet and clear its local session?",
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
    test: "Verify connection", verified: "Connection verified", readOnly: "This key cannot trade Spot", canTrade: "Spot trading permission available",
  },
} as const;

export function BinanceAgentConfiguration(props: BinanceAgentConfigurationProps) {
  const copy = COPY[props.locale];
  const ready = props.status?.ready === true;
  const replacePlaceholder = ready ? copy.replacePlaceholder : undefined;
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [mcpStatus, setMcpStatus] = useState<BinanceMcpConnectionStatus | null>(null);
  const [walletStatus, setWalletStatus] = useState("UNKNOWN");
  const [walletSignin, setWalletSignin] = useState<BinanceWalletSignin | null>(null);
  const [qrExpired, setQrExpired] = useState(false);

  const callConnection = useCallback(async <T,>(action: string, qrCodeId?: string) => (
    invoke<T>("binance_agent_connection", { request: { action, ...(qrCodeId ? { qrCodeId } : {}) } })
  ), []);

  const refreshConnections = useCallback(async () => {
    if (!props.desktop) return;
    setConnectionBusy("refresh");
    setConnectionError("");
    try {
      const nextMcpStatus = await callConnection<BinanceMcpConnectionStatus>("mcp-status");
      setMcpStatus(nextMcpStatus);
      const wallet = await callConnection<Record<string, unknown>>("wallet-status");
      const data = wallet.data && typeof wallet.data === "object" ? wallet.data as Record<string, unknown> : wallet;
      setWalletStatus(String(data.status ?? "UNKNOWN").toUpperCase());
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  }, [callConnection, props.desktop]);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  useEffect(() => {
    const canvas = qrCanvasRef.current;
    if (!canvas || !walletSignin?.urlForWeb) return;
    void QRCode.toCanvas(canvas, walletSignin.urlForWeb, {
      width: 184,
      margin: 1,
      color: { dark: "#111111", light: "#ffffff" },
    }).catch((error) => setConnectionError(error instanceof Error ? error.message : String(error)));
  }, [walletSignin]);

  useEffect(() => {
    setQrExpired(false);
    if (!walletSignin?.expireAt) return;
    const remaining = walletSignin.expireAt - Date.now();
    if (remaining <= 0) {
      setQrExpired(true);
      return;
    }
    const timer = window.setTimeout(() => setQrExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [walletSignin]);

  const runMcpAction = async (action: "mcp-connect" | "mcp-reauthorize" | "mcp-disconnect") => {
    if (!props.desktop) return;
    if (action === "mcp-disconnect" && !window.confirm(copy.disconnectConfirm)) return;
    setConnectionBusy(action);
    setConnectionError("");
    try {
      const status = await callConnection<BinanceMcpConnectionStatus>(action);
      setMcpStatus(status);
      props.onPreferencesChange({ ...props.preferences, officialMcpEnabled: action !== "mcp-disconnect" });
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  const startWalletSignin = async () => {
    if (!props.desktop) return;
    setConnectionBusy("wallet-signin");
    setConnectionError("");
    try {
      const response = await callConnection<Record<string, unknown>>("wallet-signin");
      const data = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : response;
      const qrCodeId = String(data.qrCodeId ?? "");
      const urlForWeb = String(data.urlForWeb ?? "");
      if (!qrCodeId || !urlForWeb) throw new Error("Binance Agentic Wallet did not return QR sign-in details");
      const rawExpireAt = Number(data.expireAt);
      const expireAt = Number.isFinite(rawExpireAt) && rawExpireAt > 0
        ? (rawExpireAt < 10_000_000_000 ? rawExpireAt * 1_000 : rawExpireAt)
        : undefined;
      setWalletSignin({
        qrCodeId,
        urlForWeb,
        pairingCode: data.pairingCode ? String(data.pairingCode) : undefined,
        expireAt,
      });
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  const verifyWalletSignin = async () => {
    if (!walletSignin || !props.desktop) return;
    setConnectionBusy("wallet-verify");
    setConnectionError("");
    try {
      await callConnection("wallet-verify", walletSignin.qrCodeId);
      const wallet = await callConnection<Record<string, unknown>>("wallet-status");
      const data = wallet.data && typeof wallet.data === "object" ? wallet.data as Record<string, unknown> : wallet;
      setWalletStatus(String(data.status ?? "CONNECTED").toUpperCase());
      setWalletSignin(null);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  const disconnectWallet = async () => {
    if (!props.desktop || !window.confirm(copy.walletDisconnectConfirm)) return;
    setConnectionBusy("wallet-signout");
    setConnectionError("");
    try {
      await callConnection("wallet-signout");
      setWalletStatus("UNCONNECTED");
      setWalletSignin(null);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  const walletConnected = walletStatus === "CONNECTED" || walletStatus === "READY" || walletStatus === "CREATED";
  const busy = props.busy || connectionBusy !== null;

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
        <p className="text-xs leading-5 text-gray-500">{copy.scopes}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1.5 ${mcpStatus?.connected ? "text-emerald-300" : "text-gray-500"}`}>
            {mcpStatus?.connected ? <CircleCheck className="h-3.5 w-3.5" /> : <Link2Off className="h-3.5 w-3.5" />}
            {mcpStatus?.connected ? copy.mcpConnected : copy.mcpDisconnected}
          </span>
          {mcpStatus?.verified && (
            <span className="text-gray-500">
              {copy.mcpVerified
                .replace("{tools}", String(mcpStatus.toolCount ?? 0))
                .replace("{reads}", String(mcpStatus.readOnlyToolCount ?? 0))
                .replace("{writes}", String(mcpStatus.writeToolCount ?? 0))}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!mcpStatus?.connected && <button type="button" onClick={() => void runMcpAction("mcp-connect")} disabled={!props.desktop || busy} className="inline-flex h-9 items-center gap-2 rounded-md bg-amber-300 px-3 text-xs font-semibold text-black hover:bg-amber-200 disabled:opacity-40">{connectionBusy === "mcp-connect" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}{copy.connect}</button>}
          {mcpStatus?.connected && <button type="button" onClick={() => void runMcpAction("mcp-reauthorize")} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-xs text-gray-200 hover:bg-white/[0.07] disabled:opacity-40">{connectionBusy === "mcp-reauthorize" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{copy.reconnect}</button>}
          {mcpStatus?.connected && <button type="button" onClick={() => void runMcpAction("mcp-disconnect")} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-md border border-red-300/20 px-3 text-xs text-red-200 hover:bg-red-500/10 disabled:opacity-40"><Link2Off className="h-3.5 w-3.5" />{copy.disconnect}</button>}
          <button type="button" onClick={() => void refreshConnections()} disabled={!props.desktop || busy} aria-label={copy.refresh} title={copy.refresh} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 text-gray-400 hover:bg-white/[0.07] disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${connectionBusy === "refresh" ? "animate-spin" : ""}`} /></button>
        </div>
        <div className="flex flex-col gap-2 border-l-2 border-amber-300/30 pl-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-3xl text-xs leading-5 text-gray-500">{copy.fundingHint}</p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button type="button" onClick={() => props.onOpenUrl("https://www.binance.com/en/my/sub-account/account-management")} className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-xs text-gray-200 hover:bg-white/[0.07]"><ExternalLink className="h-3.5 w-3.5" />{copy.fundAccount}</button>
            <button type="button" onClick={() => props.onOpenUrl("https://www.binance.com/en/my/sub-account/account-management")} className="inline-flex h-9 items-center gap-2 rounded-md border border-red-300/20 px-3 text-xs text-red-200 hover:bg-red-500/10"><ShieldCheck className="h-3.5 w-3.5" />{copy.manageAccount}</button>
          </div>
        </div>
        <label className="flex items-start justify-between gap-4 rounded-md border border-white/10 bg-black/20 p-3">
          <span><span className="block text-sm text-gray-200">{copy.mcpEnable}</span><span className="mt-1 block text-xs leading-5 text-gray-500">{copy.mcpEnableHint}</span></span>
          <input type="checkbox" checked={props.preferences.officialMcpEnabled} onChange={(event) => props.onPreferencesChange({ ...props.preferences, officialMcpEnabled: event.target.checked })} disabled={!props.desktop || busy} className="mt-0.5 h-4 w-4 shrink-0 accent-amber-400 disabled:opacity-50" />
        </label>
      </section>

      <section className="space-y-3 border-b border-white/10 pb-5">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-400/10 text-emerald-300"><WalletCards className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1"><h4 className="text-sm font-medium text-gray-200">{copy.wallet}</h4><p className="mt-1 max-w-3xl text-xs leading-5 text-gray-500">{copy.walletHint}</p></div>
        </div>
        <div className={`inline-flex items-center gap-1.5 text-xs ${walletConnected ? "text-emerald-300" : "text-gray-500"}`}>
          {walletConnected ? <CircleCheck className="h-3.5 w-3.5" /> : <Link2Off className="h-3.5 w-3.5" />}
          {walletConnected ? copy.walletConnected : copy.walletDisconnected}
          {walletStatus !== "UNKNOWN" && <span className="text-[10px] text-gray-600">({walletStatus})</span>}
        </div>
        {!walletConnected && !walletSignin && <button type="button" onClick={() => void startWalletSignin()} disabled={!props.desktop || busy} className="inline-flex h-9 items-center gap-2 rounded-md bg-emerald-300 px-3 text-xs font-semibold text-black hover:bg-emerald-200 disabled:opacity-40">{connectionBusy === "wallet-signin" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <QrCode className="h-3.5 w-3.5" />}{copy.walletConnect}</button>}
        {walletSignin && (
          <div className="grid gap-4 border-t border-white/10 pt-4 sm:grid-cols-[184px_minmax(0,1fr)]">
            <canvas ref={qrCanvasRef} className="h-[184px] w-[184px] rounded bg-white" />
            <div className="min-w-0 space-y-3">
              {walletSignin.pairingCode && <p className="text-xs text-gray-400">{copy.pairingCode}: <span className="font-mono text-gray-100">{walletSignin.pairingCode}</span></p>}
              {qrExpired && <p className="text-xs text-amber-300">{copy.qrExpired}</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => props.onOpenUrl(walletSignin.urlForWeb)} className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-xs text-gray-200 hover:bg-white/[0.07]"><ExternalLink className="h-3.5 w-3.5" />{copy.openSignin}</button>
                <button type="button" onClick={() => void verifyWalletSignin()} disabled={busy || qrExpired} className="inline-flex h-9 items-center gap-2 rounded-md bg-emerald-300 px-3 text-xs font-semibold text-black hover:bg-emerald-200 disabled:opacity-40">{connectionBusy === "wallet-verify" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}{copy.walletVerify}</button>
                <button type="button" onClick={() => void startWalletSignin()} disabled={busy} aria-label={copy.walletConnect} title={copy.walletConnect} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 text-gray-400 hover:bg-white/[0.07] disabled:opacity-40"><RefreshCw className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          </div>
        )}
        {walletConnected && <button type="button" onClick={() => void disconnectWallet()} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-md border border-red-300/20 px-3 text-xs text-red-200 hover:bg-red-500/10 disabled:opacity-40">{connectionBusy === "wallet-signout" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Link2Off className="h-3.5 w-3.5" />}{copy.walletDisconnect}</button>}
        {connectionError && <p className="rounded-md border border-red-300/20 bg-red-400/[0.05] px-3 py-2 text-xs leading-5 text-red-200">{copy.connectionError}: {connectionError}</p>}
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
          {ready && <button type="button" onClick={props.onTest} disabled={!props.desktop || props.busy} className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-emerald-300/20 px-3 text-xs text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40"><PlugZap className="h-3.5 w-3.5" />{copy.test}</button>}
          {ready && <button type="button" onClick={props.onDelete} disabled={props.busy} className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-red-300/20 px-3 text-xs text-red-200 hover:bg-red-500/10 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" />{copy.remove}</button>}
        </div>
        {props.testResult?.valid && props.testResult.environment === props.preferences.environment && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-emerald-300/20 bg-emerald-400/[0.06] px-3 py-2 text-xs text-emerald-200">
            <span className="inline-flex items-center gap-1"><CircleCheck className="h-3.5 w-3.5" />{copy.verified}</span>
            <span>{props.testResult.accountType}</span>
            <span>{props.testResult.canTrade ? copy.canTrade : copy.readOnly}</span>
            {props.testResult.permissions.length > 0 && <span>{props.testResult.permissions.join(" · ")}</span>}
          </div>
        )}
      </section>
    </div>
  );
}
