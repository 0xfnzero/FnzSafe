import { invoke } from "@tauri-apps/api/core";
import { buildApiUrl, getApiBaseUrl } from "@/lib/api";
import { normalizeApiPath } from "@/lib/apiPath";

const SECURE_BODY_HEADER = "x-fnzero-safe-secure-body";
const SECURE_BODY_VERSION = "1";
const TAURI_SECURE_PROXY_HEADER = "x-fnzero-safe-tauri-secure-proxy";
const SECURE_JSON_METHODS = new Set(["POST", "PUT", "PATCH"]);
const PLAINTEXT_SECRET_KEYS = new Set([
  "password",
  "current_password",
  "new_password",
  "private_key",
  "secret_key",
  "keystore_json",
  "program_keypair_json",
  "master_password",
  "security_answer",
  "totp_code",
]);
const SECURE_ENVELOPE_KEYS = new Set(["version", "encrypted_key", "iv", "ciphertext"]);

interface SecureSession {
  version: string;
  algorithm: string;
  public_key_pem: string;
}

interface ProxyRequestHeader {
  name: string;
  value: string;
}

let secureKeyPromise: Promise<CryptoKey> | null = null;
let secureSessionPromise: Promise<SecureSession> | null = null;
const SECURE_KEY_DECRYPT_ERRORS = new Set([
  "解密请求密钥失败",
]);
const STATIC_API_TOKEN =
  process.env.NEXT_PUBLIC_FNZERO_SAFE_API_TOKEN?.trim() ||
  process.env.NEXT_PUBLIC_SOL_SAFEKEY_API_TOKEN?.trim() ||
  "";

/**
 * `isTauri()` from `@tauri-apps/api/core` only checks `window.isTauri`, which Tauri 2 does not always set.
 * The injected bridge is `window.__TAURI_INTERNALS__` — without this we fell through to `fetch()` and the
 * UI looked "dead" (hung or no feedback).
 */
function isTauriWebview(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isJsonRequest(headers: Headers): boolean {
  const contentType = headers.get("Content-Type") || headers.get("content-type") || "";
  return contentType.toLowerCase().includes("application/json");
}

function hasWebCrypto(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.getRandomValues === "function";
}

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function containsPlaintextSecret(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some(containsPlaintextSecret);
  }
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    if (PLAINTEXT_SECRET_KEYS.has(key)) return true;
    return containsPlaintextSecret(child);
  });
}

function assertCanEncryptSensitiveBody(init: RequestInit): void {
  const method = String(init.method ?? "GET").toUpperCase();
  if (!SECURE_JSON_METHODS.has(method)) return;
  if (!containsPlaintextSecret(parseJsonBody(init.body))) return;
  if (hasWebCrypto() || isTauriWebview()) return;
  throw new Error(
    "Sensitive request blocked: this browser context cannot encrypt passwords. Use HTTPS, localhost, 127.0.0.1, or the desktop app.",
  );
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function getSecureBodyPublicKey(): Promise<CryptoKey> {
  if (!hasWebCrypto()) {
    throw new Error("Secure API encryption is unavailable in this browser context.");
  }
  if (!secureKeyPromise) {
    secureKeyPromise = (async () => {
      const session = await getSecureSession();
      if (session.version !== SECURE_BODY_VERSION) {
        throw new Error("Unsupported secure API session version.");
      }
      return crypto.subtle.importKey(
        "spki",
        pemToArrayBuffer(session.public_key_pem),
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["encrypt"],
      );
    })().catch((error) => {
      secureKeyPromise = null;
      throw error;
    });
  }

  return secureKeyPromise;
}

function resetSecureBodyPublicKey(): void {
  secureKeyPromise = null;
  secureSessionPromise = null;
}

async function getSecureSession(): Promise<SecureSession> {
  if (!secureSessionPromise) {
    secureSessionPromise = fetchSecureSession().catch((error) => {
      secureSessionPromise = null;
      throw error;
    });
  }
  return secureSessionPromise;
}

async function fetchSecureSession(): Promise<SecureSession> {
  if (isTauriWebview()) {
    const result = await invoke<{ status: number; body: string }>(
      "proxy_api_request",
      {
        method: "GET",
        path: "secure/session",
        headers: [],
        body: null,
      },
    );
    if (result.status < 200 || result.status >= 300) {
      throw new Error("Failed to initialize secure API session.");
    }
    return JSON.parse(result.body) as SecureSession;
  }

  const response = await fetch(`${getApiBaseUrl().replace(/\/$/, "")}/secure/session`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Failed to initialize secure API session.");
  }
  return (await response.json()) as SecureSession;
}

function apiPathRequiresToken(cleanPath: string): boolean {
  const normalized = cleanPath.replace(/^\/+|\/+$/g, "");
  return normalized !== "health" && normalized !== "secure/session";
}

async function withApiToken(cleanPath: string, init: RequestInit): Promise<RequestInit> {
  if (!apiPathRequiresToken(cleanPath)) return init;
  if (isTauriWebview()) return init;
  if (!STATIC_API_TOKEN) {
    throw new Error("Failed to initialize local API token.");
  }
  const headers = new Headers(init.headers);
  headers.set("X-Fnzero-Safe-Token", STATIC_API_TOKEN);
  return { ...init, headers };
}

async function secureJsonBody(body: string): Promise<string> {
  if (!hasWebCrypto()) {
    throw new Error("Secure API encryption is unavailable in this browser context.");
  }
  const publicKey = await getSecureBodyPublicKey();
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(body),
  );
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawAesKey,
  );

  return JSON.stringify({
    version: 1,
    encrypted_key: bytesToBase64(encryptedKey),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  });
}

async function secureInitBody(
  init: RequestInit,
  headers: Headers,
  options: { refreshSecureSession?: boolean } = {},
): Promise<RequestInit> {
  if (options.refreshSecureSession) {
    resetSecureBodyPublicKey();
  }
  const method = String(init.method ?? "GET").toUpperCase();
  if (!SECURE_JSON_METHODS.has(method)) {
    return init;
  }

  const hasBody = init.body != null;
  const hasJsonContentType = isJsonRequest(headers);
  if (hasBody && typeof init.body !== "string" && !hasJsonContentType) {
    throw new Error("Mutating API requests with body must use JSON.");
  }

  const plainBody = !hasBody
    ? "{}"
    : typeof init.body === "string"
      ? init.body
      : await new Response(init.body).text();
  if (!hasWebCrypto() && isTauriWebview()) {
    const nextHeaders = new Headers(headers);
    nextHeaders.set(TAURI_SECURE_PROXY_HEADER, "1");
    nextHeaders.set("Content-Type", "application/json");
    return {
      ...init,
      headers: nextHeaders,
      body: plainBody,
    };
  }
  const encryptedBody = await secureJsonBody(plainBody);
  const nextHeaders = new Headers(headers);
  nextHeaders.set(SECURE_BODY_HEADER, SECURE_BODY_VERSION);
  nextHeaders.set("Content-Type", "application/json");

  return {
    ...init,
    headers: nextHeaders,
    body: encryptedBody,
  };
}

function assertNoPlaintextSecretRequest(init: RequestInit): void {
  const method = String(init.method ?? "GET").toUpperCase();
  if (!SECURE_JSON_METHODS.has(method)) return;

  const headers = new Headers(init.headers);
  if (isTauriWebview() && headers.get(TAURI_SECURE_PROXY_HEADER) === "1") {
    return;
  }
  if (headers.get(SECURE_BODY_HEADER) !== SECURE_BODY_VERSION) {
    throw new Error("Sensitive API request was blocked because the request body is not encrypted.");
  }
  if (typeof init.body !== "string") {
    throw new Error("Sensitive API request was blocked because the encrypted body is invalid.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    throw new Error("Sensitive API request was blocked because the encrypted body is invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Sensitive API request was blocked because the encrypted body is malformed.");
  }

  const envelope = parsed as Record<string, unknown>;
  const isSecureEnvelope =
    envelope.version === 1 &&
    typeof envelope.encrypted_key === "string" &&
    typeof envelope.iv === "string" &&
    typeof envelope.ciphertext === "string";
  if (!isSecureEnvelope) {
    throw new Error("Sensitive API request was blocked because plaintext request data was detected.");
  }

  for (const key of Object.keys(envelope)) {
    if (!SECURE_ENVELOPE_KEYS.has(key) || (PLAINTEXT_SECRET_KEYS.has(key) && key !== "encrypted_key")) {
      throw new Error("Sensitive API request was blocked because plaintext secrets were detected.");
    }
  }
}

function headersForTauri(headers: Headers): ProxyRequestHeader[] {
  return Array.from(headers.entries()).map(([name, value]) => ({ name, value }));
}

async function normalizeApiResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") || "";
  const bodyText = await response.text();
  const declaredJson = contentType.toLowerCase().includes("application/json");
  const trimmedBody = bodyText.trim();

  if (declaredJson || trimmedBody.startsWith("{") || trimmedBody.startsWith("[")) {
    if (trimmedBody) {
      try {
        JSON.parse(bodyText);
        return new Response(bodyText, {
          status: response.status,
          statusText: response.statusText,
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        if (declaredJson) {
          return new Response(JSON.stringify({ error: "API returned invalid JSON." }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    if (declaredJson) {
      return new Response(JSON.stringify({ error: `HTTP ${response.status}` }), {
        status: response.ok ? 502 : response.status,
        statusText: response.statusText,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (response.ok) {
    return new Response(JSON.stringify({ error: "API returned a non-JSON response." }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const message = trimmedBody || `HTTP ${response.status}`;
  return new Response(JSON.stringify({ error: message }), {
    status: response.status,
    statusText: response.statusText,
    headers: { "Content-Type": "application/json" },
  });
}

function apiExceptionResponse(error: unknown): Response {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "API request failed";
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

async function responseJsonError(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    const body = await response.clone().json();
    if (!body || typeof body !== "object") return null;
    const error = (body as Record<string, unknown>).error;
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}

async function sendApiRequest(cleanPath: string, init: RequestInit): Promise<Response> {
  const nextHeaders = new Headers(init.headers);

  if (isTauriWebview()) {
    const secureProxy = nextHeaders.get(TAURI_SECURE_PROXY_HEADER) === "1";
    nextHeaders.delete(TAURI_SECURE_PROXY_HEADER);
    let bodyStr: string | null = null;
    if (init.body != null) {
      if (typeof init.body === "string") {
        bodyStr = init.body;
      } else {
        bodyStr = await new Response(init.body).text();
      }
    }
    const result = await invoke<{ status: number; body: string }>(
      "proxy_api_request",
      {
        method: init.method ?? "GET",
        path: cleanPath,
        headers: headersForTauri(nextHeaders),
        body: bodyStr,
        secureProxy,
      },
    );
    return normalizeApiResponse(new Response(result.body, { status: result.status }));
  }

  return normalizeApiResponse(await fetch(buildApiUrl(cleanPath), init));
}

/**
 * Same as `fetch(buildApiUrl(path), init)` in the browser.
 * In Tauri, calls Rust `proxy_api_request` (reqwest) so the WebView never runs `fetch` to `/api` or `127.0.0.1`
 * (avoids WKWebView "The string did not match the expected pattern" / Load failed).
 */
export async function apiFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  try {
    const cleanPath = normalizeApiPath(path);
    const headers = new Headers(init.headers);
    const initialInit = { ...init, headers };
    assertCanEncryptSensitiveBody(initialInit);
    const nextInit = await secureInitBody(initialInit, headers);
    assertNoPlaintextSecretRequest(nextInit);

    const authorizedInit = await withApiToken(cleanPath, nextInit);
    const response = await sendApiRequest(cleanPath, authorizedInit);
    const error = await responseJsonError(response);
    if (response.status === 401 || SECURE_KEY_DECRYPT_ERRORS.has(error ?? "")) {
      const retryInit = await secureInitBody(initialInit, headers, { refreshSecureSession: true });
      assertNoPlaintextSecretRequest(retryInit);
      const retryAuthorizedInit = await withApiToken(cleanPath, retryInit);
      return sendApiRequest(cleanPath, retryAuthorizedInit);
    }

    return response;
  } catch (error) {
    return apiExceptionResponse(error);
  }
}
