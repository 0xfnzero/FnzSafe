export const FNZSAFE_WALLET_NAME = "FnzSafe";
export const FNZSAFE_DEEP_LINK_SCHEME = "fnzsafe";
export const FNZSAFE_SIGN_DEEP_LINK_HOST = "sign";

export type FnzSafeSignMethod =
  | "signMessage"
  | "signTransaction"
  | "signAllTransactions"
  | "signAndSendTransaction"
  | "sendTransaction";

export interface FnzSafeSignDeepLinkRequest {
  method: FnzSafeSignMethod;
  walletPublicKey: string;
  appUrl: string;
  appName?: string;
  network?: string;
  requestId?: string;
  transactionBase64?: string;
  transactionFormat?: "legacy" | "versioned" | "v0" | "auto";
  messageBase64?: string;
  callbackUrl?: string;
}

export interface FnzSafeOpenOptions {
  fallbackDelayMs?: number;
  onFallback?: () => void;
}

export interface WalletLike {
  adapter?: unknown;
  name?: string;
  label?: string;
}

function walletName(wallet: WalletLike): string {
  const adapter = wallet.adapter as WalletLike | undefined;
  return String(wallet.name || wallet.label || adapter?.name || adapter?.label || "");
}

export function isFnzSafeWallet(wallet: WalletLike): boolean {
  return walletName(wallet).trim().toLowerCase() === FNZSAFE_WALLET_NAME.toLowerCase();
}

export function prioritizeFnzSafeWallets<T extends WalletLike>(wallets: readonly T[]): T[] {
  return [...wallets].sort((left, right) => {
    const leftIsFnzSafe = isFnzSafeWallet(left);
    const rightIsFnzSafe = isFnzSafeWallet(right);
    if (leftIsFnzSafe === rightIsFnzSafe) return 0;
    return leftIsFnzSafe ? -1 : 1;
  });
}

function requireCleanText(value: string, field: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error(`Invalid ${field}`);
  }
  return trimmed;
}

function requireAppUrl(value: string, field: string): string {
  const url = new URL(value);
  const isLocalHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error(`${field} must be HTTPS, localhost, or 127.0.0.1`);
  }
  return url.toString();
}

function requireHttpsUrl(value: string, field: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${field} must be HTTPS`);
  }
  return url.toString();
}

function relatedCallbackHost(appHost: string, callbackHost: string): boolean {
  return (
    appHost === callbackHost ||
    callbackHost.endsWith(`.${appHost}`) ||
    appHost.endsWith(`.${callbackHost}`)
  );
}

export function buildFnzSafeSignDeepLink(request: FnzSafeSignDeepLinkRequest): string {
  const method = requireCleanText(request.method, "method", 40) as FnzSafeSignMethod;
  const appUrl = requireAppUrl(request.appUrl, "appUrl");
  const callbackUrl = request.callbackUrl ? requireHttpsUrl(request.callbackUrl, "callbackUrl") : undefined;
  if (callbackUrl) {
    const appHost = new URL(appUrl).hostname.toLowerCase();
    const callbackHost = new URL(callbackUrl).hostname.toLowerCase();
    if (!relatedCallbackHost(appHost, callbackHost)) {
      throw new Error("callbackUrl must belong to the same site as appUrl");
    }
  }
  const params = new URLSearchParams();
  params.set("method", method);
  params.set("wallet_public_key", requireCleanText(request.walletPublicKey, "walletPublicKey", 64));
  params.set("app_url", appUrl);
  params.set("network", requireCleanText(request.network || "mainnet", "network", 256));
  if (request.appName) params.set("app_name", requireCleanText(request.appName, "appName", 80));
  if (request.requestId) params.set("request_id", requireCleanText(request.requestId, "requestId", 128));
  if (callbackUrl) params.set("callback_url", callbackUrl);

  if (method === "signMessage") {
    params.set("message_base64", requireCleanText(request.messageBase64 || "", "messageBase64", 24 * 1024));
  } else {
    params.set(
      "transaction_base64",
      requireCleanText(request.transactionBase64 || "", "transactionBase64", 4096),
    );
    params.set("transaction_format", request.transactionFormat || "auto");
  }

  return `${FNZSAFE_DEEP_LINK_SCHEME}://${FNZSAFE_SIGN_DEEP_LINK_HOST}?${params.toString()}`;
}

export function openFnzSafeDeepLinkWithFallback(
  deepLink: string,
  options: FnzSafeOpenOptions = {},
): void {
  const fallbackDelayMs = options.fallbackDelayMs ?? 1600;
  let appLikelyOpened = false;
  const markOpened = () => {
    appLikelyOpened = true;
  };
  window.addEventListener("blur", markOpened, { once: true });
  window.addEventListener("pagehide", markOpened, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) markOpened();
  }, { once: true });

  window.location.href = deepLink;

  window.setTimeout(() => {
    if (!appLikelyOpened) options.onFallback?.();
  }, fallbackDelayMs);
}
