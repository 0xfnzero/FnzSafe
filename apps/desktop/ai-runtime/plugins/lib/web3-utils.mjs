const USER_AGENT = 'FnzSafe-Web3-Research/0.3';
const MAX_RESULT_CHARS = 48_000;
const MAX_UPSTREAM_BYTES = 20_000_000;
const MAX_CACHE_ENTRIES = 64;
const REQUEST_TIMEOUT_MS = 20_000;

const responseCache = new Map();
const inFlightRequests = new Map();

export const integerProperty = (minimum, maximum, defaultValue) => ({
  type: 'integer', minimum, maximum, default: defaultValue,
});

export function upstreamRequestError(host, error) {
  if (error instanceof Error && error.message.startsWith(`${host} `)) return error;
  if (error?.name === 'AbortError') return new Error(`${host} timed out after ${REQUEST_TIMEOUT_MS}ms`);
  const code = typeof error?.cause?.code === 'string' ? error.cause.code : '';
  return new Error(`${host} request failed${code ? `: ${code}` : ''}`);
}

export function requiredText(args, name) {
  const value = typeof args?.[name] === 'string' ? args[name].trim() : '';
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function optionalText(args, name) {
  return typeof args[name] === 'string' ? args[name].trim() : '';
}

export function boundedInteger(args, name, fallback, minimum, maximum) {
  const value = args[name] ?? fallback;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return Math.min(maximum, Math.max(minimum, value));
}

export function boundedNumber(args, name, fallback, minimum, maximum) {
  const value = args[name] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return Math.min(maximum, Math.max(minimum, value));
}

function cacheValue(key, value) {
  responseCache.delete(key);
  responseCache.set(key, { createdAt: Date.now(), value });
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    responseCache.delete(responseCache.keys().next().value);
  }
}

async function requestText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const host = new URL(url).hostname;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json, application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BYTES) {
      await response.body?.cancel();
      throw new Error(`${host} response exceeded the safety limit`);
    }
    if (!response.body) throw new Error(`${host} returned an empty response body`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let receivedBytes = 0;
    let body = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_UPSTREAM_BYTES) {
          await reader.cancel();
          throw new Error(`${host} response exceeded the safety limit`);
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    if (!response.ok) throw new Error(`${host} returned HTTP ${response.status}: ${body.slice(0, 240)}`);
    return body;
  } catch (error) {
    throw upstreamRequestError(host, error);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url, cacheMs = 0) {
  const cached = responseCache.get(url);
  if (cacheMs > 0 && cached && Date.now() - cached.createdAt < cacheMs) {
    responseCache.delete(url);
    responseCache.set(url, cached);
    return cached.value;
  }
  const inFlight = inFlightRequests.get(url);
  if (inFlight) {
    if (cacheMs > 0) inFlight.cacheRequested = true;
    return inFlight.promise;
  }

  const entry = { cacheRequested: cacheMs > 0, promise: undefined };
  const request = requestText(url)
    .then((body) => {
      if (entry.cacheRequested) cacheValue(url, body);
      return body;
    })
    .finally(() => inFlightRequests.delete(url));
  entry.promise = request;
  inFlightRequests.set(url, entry);
  return request;
}

export async function fetchJson(url, cacheMs = 0) {
  const body = await fetchText(url, cacheMs);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${new URL(url).hostname} returned invalid JSON`);
  }
}

export function jsonContent(value) {
  const serialized = JSON.stringify(value, null, 2);
  const output = serialized.length <= MAX_RESULT_CHARS
    ? serialized
    : JSON.stringify({
      source: value?.source ?? 'unknown',
      retrievedAt: value?.retrievedAt ?? new Date().toISOString(),
      error: 'The structured result exceeded the response safety limit. Use a narrower query or smaller limit.',
      originalCharacters: serialized.length,
    }, null, 2);
  return { content: [{ type: 'text', text: output }] };
}

export function sourceEnvelope(source, value) {
  return { source, retrievedAt: new Date().toISOString(), ...value };
}

export function validateToolArguments(schema, candidate) {
  const args = candidate ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool arguments must be an object');

  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).find((name) => !Object.hasOwn(properties, name));
    if (unknown) throw new Error(`unknown argument: ${unknown}`);
  }
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(args, name)) throw new Error(`${name} is required`);
  }
  for (const [name, value] of Object.entries(args)) {
    const rule = properties[name];
    if (!rule) continue;
    if (rule.type === 'string') {
      if (typeof value !== 'string') throw new Error(`${name} must be a string`);
      if (rule.minLength != null && value.length < rule.minLength) throw new Error(`${name} is too short`);
      if (rule.maxLength != null && value.length > rule.maxLength) throw new Error(`${name} is too long`);
      if (rule.pattern && !new RegExp(rule.pattern, 'u').test(value)) throw new Error(`${name} has an invalid format`);
    } else if (rule.type === 'integer') {
      if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
    } else if (rule.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
    } else if (rule.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`${name} must be a boolean`);
    }
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`${name} must be one of: ${rule.enum.join(', ')}`);
    if (typeof value === 'number' && rule.minimum != null && value < rule.minimum) throw new Error(`${name} is below the minimum`);
    if (typeof value === 'number' && rule.maximum != null && value > rule.maximum) throw new Error(`${name} exceeds the maximum`);
  }
  return args;
}
