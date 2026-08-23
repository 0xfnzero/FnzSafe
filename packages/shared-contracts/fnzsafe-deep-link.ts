export const FNZSAFE_WALLET_NAME = "FnzSafe";
export const FNZSAFE_DEEP_LINK_SCHEME = "fnzsafe";
export const FNZSAFE_SIGN_DEEP_LINK_HOST = "sign";
export const FNZSAFE_CONNECT_DEEP_LINK_HOST = "connect";

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
  knownPrograms?: FnzSafeKnownProgram[];
}

export interface FnzSafeConnectDeepLinkRequest {
  appUrl: string;
  appName?: string;
  network?: string;
  requestId?: string;
  callbackUrl: string;
}

export interface FnzSafeKnownProgram {
  programId: string;
  label: string;
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
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error(`${field} must be HTTPS, localhost, 127.0.0.1, or ::1`);
  }
  return url.toString();
}

function requireCallbackUrl(value: string, field: string): string {
  const url = new URL(value);
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error(`${field} must be HTTPS, localhost, 127.0.0.1, or ::1`);
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
  const callbackUrl = request.callbackUrl ? requireCallbackUrl(request.callbackUrl, "callbackUrl") : undefined;
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
  for (const program of request.knownPrograms ?? []) {
    const programId = requireCleanText(program.programId, "knownProgram.programId", 64);
    const label = requireCleanText(program.label, "knownProgram.label", 48);
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(programId) && /^[A-Za-z0-9 ._/-]+$/.test(label)) {
      params.append("known_program", `${programId}:${label}`);
    }
  }

  return `${FNZSAFE_DEEP_LINK_SCHEME}://${FNZSAFE_SIGN_DEEP_LINK_HOST}?${params.toString()}`;
}

export function buildFnzSafeConnectDeepLink(request: FnzSafeConnectDeepLinkRequest): string {
  const appUrl = requireAppUrl(request.appUrl, "appUrl");
  const callbackUrl = requireCallbackUrl(request.callbackUrl, "callbackUrl");
  const appHost = new URL(appUrl).hostname.toLowerCase();
  const callbackHost = new URL(callbackUrl).hostname.toLowerCase();
  if (!relatedCallbackHost(appHost, callbackHost)) {
    throw new Error("callbackUrl must belong to the same site as appUrl");
  }
  const params = new URLSearchParams();
  params.set("app_url", appUrl);
  params.set("callback_url", callbackUrl);
  params.set("network", requireCleanText(request.network || "mainnet", "network", 256));
  if (request.appName) params.set("app_name", requireCleanText(request.appName, "appName", 80));
  if (request.requestId) params.set("request_id", requireCleanText(request.requestId, "requestId", 128));
  return `${FNZSAFE_DEEP_LINK_SCHEME}://${FNZSAFE_CONNECT_DEEP_LINK_HOST}?${params.toString()}`;
}

export function openFnzSafeDeepLinkWithFallback(
  deepLink: string,
  options: FnzSafeOpenOptions = {},
): void {
  const fallbackDelayMs = options.fallbackDelayMs ?? 1200;
  let appLikelyOpened = false;
  let fallbackResolved = false;
  const markOpened = () => {
    appLikelyOpened = true;
  };
  const cleanup = () => {
    window.removeEventListener("blur", markOpened);
    window.removeEventListener("pagehide", markOpened);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
  const runFallbackIfNeeded = () => {
    if (fallbackResolved) return;
    fallbackResolved = true;
    cleanup();
    if (!appLikelyOpened) options.onFallback?.();
  };
  const onVisibilityChange = () => {
    if (!document.hidden) return;
    markOpened();
    runFallbackIfNeeded();
  };

  window.addEventListener("blur", markOpened);
  window.addEventListener("pagehide", markOpened);
  document.addEventListener("visibilitychange", onVisibilityChange);

  try {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    iframe.src = deepLink;
    document.body.appendChild(iframe);
    window.setTimeout(() => iframe.remove(), fallbackDelayMs + 1000);
  } catch {
    // Some embedded browsers block custom protocols in iframes.
  }

  try {
    const opened = window.open(deepLink, "_self");
    if (!opened) window.location.assign(deepLink);
  } catch {
    try {
      window.location.assign(deepLink);
    } catch {
      runFallbackIfNeeded();
    }
  }

  window.setTimeout(() => {
    runFallbackIfNeeded();
  }, fallbackDelayMs);
}
