import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { jsonContent, requiredText } from '../lib/web3-utils.mjs';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PREVIEW_TTL_MS = 5 * 60 * 1_000;
const BINANCE_WEB3_AUDIT_URL = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit';
const ENVIRONMENTS = {
  production: 'https://api.binance.com',
  testnet: 'https://testnet.binance.vision',
};

function text(value) {
  return String(value ?? '').trim();
}

function runtimeConfig({ requireCredentials = true } = {}) {
  const environment = text(process.env.FNZSAFE_BINANCE_ENVIRONMENT) || 'testnet';
  const baseUrl = ENVIRONMENTS[environment];
  if (!baseUrl) throw new Error('Binance environment is invalid');
  const apiKey = text(process.env.FNZSAFE_BINANCE_API_KEY);
  const secretKey = text(process.env.FNZSAFE_BINANCE_SECRET_KEY);
  if (requireCredentials && (!apiKey || !secretKey)) {
    throw new Error(`Binance ${environment} API credentials are not configured in FnzSafe`);
  }
  const configuredLimit = Number(process.env.FNZSAFE_BINANCE_MAX_ORDER_QUOTE || 100);
  const maxOrderQuote = Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.min(configuredLimit, 1_000_000)
    : 100;
  return {
    environment,
    baseUrl,
    apiKey,
    secretKey,
    tradingEnabled: process.env.FNZSAFE_BINANCE_TRADING_ENABLED === '1',
    maxOrderQuote,
  };
}

function normalizedSymbol(value) {
  const symbol = text(value).toUpperCase();
  if (!/^[A-Z0-9]{4,20}$/u.test(symbol)) throw new Error('symbol is invalid');
  return symbol;
}

function decimal(value, name) {
  const candidate = text(value);
  if (candidate.length > 40 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/u.test(candidate) || Number(candidate) <= 0) {
    throw new Error(`${name} must be a positive decimal string`);
  }
  return candidate;
}

function decimalScale(value) {
  return text(value).split('.')[1]?.length ?? 0;
}

function decimalUnits(value, scale) {
  const [whole, fraction = ''] = text(value).split('.');
  return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
}

function compareDecimals(left, right) {
  const scale = Math.max(decimalScale(left), decimalScale(right));
  const leftUnits = decimalUnits(left, scale);
  const rightUnits = decimalUnits(right, scale);
  return leftUnits === rightUnits ? 0 : leftUnits > rightUnits ? 1 : -1;
}

function multiplyDecimals(left, right) {
  const scale = decimalScale(left) + decimalScale(right);
  const product = decimalUnits(left, decimalScale(left)) * decimalUnits(right, decimalScale(right));
  if (scale === 0) return product.toString();
  const digits = product.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function activeFilterValue(filter, name) {
  const value = text(filter?.[name]);
  return value && /^\d+(?:\.\d+)?$/u.test(value) && compareDecimals(value, '0') > 0 ? value : '';
}

function enforceRangeAndStep(value, filter, label, minName, maxName, stepName) {
  const minimum = activeFilterValue(filter, minName);
  const maximum = activeFilterValue(filter, maxName);
  const step = activeFilterValue(filter, stepName);
  if (minimum && compareDecimals(value, minimum) < 0) throw new Error(`${label} is below Binance minimum ${minimum}`);
  if (maximum && compareDecimals(value, maximum) > 0) throw new Error(`${label} exceeds Binance maximum ${maximum}`);
  if (step) {
    const scale = Math.max(decimalScale(value), decimalScale(minimum || '0'), decimalScale(step));
    const offset = decimalUnits(value, scale) - decimalUnits(minimum || '0', scale);
    if (offset < 0n || offset % decimalUnits(step, scale) !== 0n) {
      throw new Error(`${label} must align to Binance step ${step}`);
    }
  }
}

function marketFilter(snapshot, filterType) {
  return snapshot.filters.find((filter) => filter?.filterType === filterType);
}

function enforceNotionalFilters(order, snapshot) {
  const isMarket = order.type === 'MARKET';
  const minimumFilter = marketFilter(snapshot, 'MIN_NOTIONAL');
  const minimum = activeFilterValue(minimumFilter, 'minNotional');
  if (minimum && (!isMarket || minimumFilter.applyToMarket !== false) && compareDecimals(order.estimatedQuote, minimum) < 0) {
    throw new Error(`estimated quote value is below Binance minimum notional ${minimum}`);
  }
  const notionalFilter = marketFilter(snapshot, 'NOTIONAL');
  const notionalMinimum = activeFilterValue(notionalFilter, 'minNotional');
  const notionalMaximum = activeFilterValue(notionalFilter, 'maxNotional');
  if (notionalMinimum && (!isMarket || notionalFilter.applyMinToMarket !== false) && compareDecimals(order.estimatedQuote, notionalMinimum) < 0) {
    throw new Error(`estimated quote value is below Binance minimum notional ${notionalMinimum}`);
  }
  if (notionalMaximum && (!isMarket || notionalFilter.applyMaxToMarket === true) && compareDecimals(order.estimatedQuote, notionalMaximum) > 0) {
    throw new Error(`estimated quote value exceeds Binance maximum notional ${notionalMaximum}`);
  }
}

async function boundedJsonResponse(response, host) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`${host} response exceeded the safety limit`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error(`${host} response exceeded the safety limit`);
  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`${host} returned invalid JSON`);
  }
  if (!response.ok) {
    const message = text(payload?.msg || payload?.message).slice(0, 240);
    throw new Error(`${host} returned HTTP ${response.status}${message ? `: ${message}` : ''}`);
  }
  return payload;
}

async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const host = new URL(url).hostname;
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await boundedJsonResponse(response, host);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${host} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    if (error instanceof Error) throw error;
    throw new Error(`${host} request failed`);
  } finally {
    clearTimeout(timer);
  }
}

function queryString(params) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(name, String(value));
  }
  return query.toString();
}

async function publicRequest(path, params = {}) {
  const { baseUrl } = runtimeConfig({ requireCredentials: false });
  const query = queryString(params);
  return request(`${baseUrl}${path}${query ? `?${query}` : ''}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'FnzSafe-Binance-Agent/0.1' },
  });
}

async function signedRequest(method, path, params = {}) {
  const config = runtimeConfig();
  const signedParams = { ...params, recvWindow: 5_000, timestamp: Date.now() };
  const unsigned = queryString(signedParams);
  const signature = createHmac('sha256', config.secretKey).update(unsigned).digest('hex');
  const body = `${unsigned}&signature=${signature}`;
  const url = method === 'GET' || method === 'DELETE' ? `${config.baseUrl}${path}?${body}` : `${config.baseUrl}${path}`;
  return request(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'FnzSafe-Binance-Agent/0.1',
      'X-MBX-APIKEY': config.apiKey,
    },
    ...(method === 'GET' || method === 'DELETE' ? {} : { body }),
  });
}

function previewSignature(encoded, secretKey) {
  return createHmac('sha256', secretKey).update(`fnzsafe-binance-preview-v1\0${encoded}`).digest('base64url');
}

function encodePreview(payload, secretKey) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${previewSignature(encoded, secretKey)}`;
}

function decodePreview(token, expectedKind) {
  const config = runtimeConfig();
  const [encoded, signature, extra] = text(token).split('.');
  if (!encoded || !signature || extra) throw new Error('preview token is invalid');
  const expected = Buffer.from(previewSignature(encoded, config.secretKey));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error('preview token integrity check failed');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('preview token payload is invalid');
  }
  if (payload?.v !== 1 || payload?.kind !== expectedKind || payload?.environment !== config.environment) {
    throw new Error('preview token does not match this Binance configuration');
  }
  if (!Number.isSafeInteger(payload.expiresAt) || Date.now() > payload.expiresAt) {
    throw new Error('preview token expired; create a new preview');
  }
  return { config, payload };
}

function requireConfirmation(args) {
  if (requiredText(args, 'confirmation') !== 'CONFIRM') {
    throw new Error('confirmation must be exactly CONFIRM');
  }
  if (process.env.FNZSAFE_BINANCE_USER_CONFIRMED !== '1') {
    throw new Error('real Binance actions require a new user message containing exactly CONFIRM');
  }
}

async function symbolSnapshot(symbol) {
  const [exchangeInfo, ticker] = await Promise.all([
    publicRequest('/api/v3/exchangeInfo', { symbol }),
    publicRequest('/api/v3/ticker/price', { symbol }),
  ]);
  const market = exchangeInfo?.symbols?.[0];
  if (!market || market.symbol !== symbol) throw new Error(`Binance does not list ${symbol}`);
  return {
    symbol,
    status: market.status,
    baseAsset: market.baseAsset,
    quoteAsset: market.quoteAsset,
    price: text(ticker?.price),
    orderTypes: Array.isArray(market.orderTypes) ? market.orderTypes : [],
    filters: Array.isArray(market.filters) ? market.filters : [],
    isSpotTradingAllowed: market.isSpotTradingAllowed !== false,
    quoteOrderQtyMarketAllowed: market.quoteOrderQtyMarketAllowed !== false,
  };
}

function orderParameters(args, snapshot) {
  const side = requiredText(args, 'side').toUpperCase();
  const type = requiredText(args, 'type').toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) throw new Error('side must be BUY or SELL');
  if (!['MARKET', 'LIMIT'].includes(type)) throw new Error('type must be MARKET or LIMIT');
  if (snapshot.status !== 'TRADING' || !snapshot.isSpotTradingAllowed || !snapshot.orderTypes.includes(type)) {
    throw new Error(`${snapshot.symbol} does not currently support ${type} orders`);
  }
  const quantity = text(args.quantity) ? decimal(args.quantity, 'quantity') : '';
  const quoteOrderQty = text(args.quoteOrderQty) ? decimal(args.quoteOrderQty, 'quoteOrderQty') : '';
  const price = text(args.price) ? decimal(args.price, 'price') : '';
  if (type === 'LIMIT') {
    if (!quantity || !price || quoteOrderQty) throw new Error('LIMIT orders require quantity and price only');
  } else if (side === 'SELL') {
    if (!quantity || quoteOrderQty || price) throw new Error('MARKET SELL requires quantity only');
  } else if (Boolean(quantity) === Boolean(quoteOrderQty) || price) {
    throw new Error('MARKET BUY requires exactly one of quantity or quoteOrderQty');
  }
  if (quoteOrderQty && !snapshot.quoteOrderQtyMarketAllowed) {
    throw new Error(`${snapshot.symbol} does not support quoteOrderQty market orders`);
  }
  const referencePrice = decimal(price || snapshot.price, 'reference price');
  if (price) enforceRangeAndStep(price, marketFilter(snapshot, 'PRICE_FILTER'), 'price', 'minPrice', 'maxPrice', 'tickSize');
  if (quantity) {
    const quantityFilter = type === 'MARKET'
      ? marketFilter(snapshot, 'MARKET_LOT_SIZE') ?? marketFilter(snapshot, 'LOT_SIZE')
      : marketFilter(snapshot, 'LOT_SIZE');
    enforceRangeAndStep(quantity, quantityFilter, 'quantity', 'minQty', 'maxQty', 'stepSize');
  }
  const estimatedQuote = quoteOrderQty || multiplyDecimals(quantity, referencePrice);
  enforceNotionalFilters({ type, estimatedQuote }, snapshot);
  return { side, type, quantity, quoteOrderQty, price, referencePrice, estimatedQuote };
}

function orderRequestParameters(payload) {
  return {
    symbol: payload.symbol,
    side: payload.side,
    type: payload.type,
    quantity: payload.quantity,
    quoteOrderQty: payload.quoteOrderQty,
    price: payload.price,
    timeInForce: payload.type === 'LIMIT' ? 'GTC' : undefined,
    newClientOrderId: payload.clientOrderId,
    newOrderRespType: 'FULL',
  };
}

function publicOrder(order) {
  return {
    symbol: order.symbol,
    orderId: order.orderId,
    clientOrderId: order.clientOrderId,
    price: order.price,
    origQty: order.origQty,
    executedQty: order.executedQty,
    cumulativeQuoteQty: order.cummulativeQuoteQty,
    status: order.status,
    timeInForce: order.timeInForce,
    type: order.type,
    side: order.side,
    updateTime: order.updateTime ?? order.transactTime,
  };
}

export const binanceAgentHandlers = {
  async binance_spot_market(args) {
    const snapshot = await symbolSnapshot(normalizedSymbol(requiredText(args, 'symbol')));
    return jsonContent({ source: 'Binance', environment: runtimeConfig({ requireCredentials: false }).environment, ...snapshot });
  },

  async binance_spot_account() {
    const config = runtimeConfig();
    const account = await signedRequest('GET', '/api/v3/account', { omitZeroBalances: 'true' });
    return jsonContent({
      source: 'Binance',
      environment: config.environment,
      canTrade: account.canTrade === true,
      accountType: account.accountType,
      permissions: account.permissions,
      balances: (account.balances ?? []).filter((item) => Number(item.free) !== 0 || Number(item.locked) !== 0),
      updateTime: account.updateTime,
    });
  },

  async binance_spot_open_orders(args) {
    const symbol = text(args.symbol) ? normalizedSymbol(args.symbol) : undefined;
    const orders = await signedRequest('GET', '/api/v3/openOrders', { symbol });
    return jsonContent({ source: 'Binance', environment: runtimeConfig().environment, orders: orders.map(publicOrder) });
  },

  async binance_spot_order_status(args) {
    const symbol = normalizedSymbol(requiredText(args, 'symbol'));
    const orderId = text(args.orderId);
    const clientOrderId = text(args.clientOrderId);
    if (Boolean(orderId) === Boolean(clientOrderId)) throw new Error('provide exactly one of orderId or clientOrderId');
    if (orderId && !/^[0-9]{1,24}$/u.test(orderId)) throw new Error('orderId is invalid');
    if (clientOrderId && !/^[A-Za-z0-9_-]{1,36}$/u.test(clientOrderId)) throw new Error('clientOrderId is invalid');
    const order = await signedRequest('GET', '/api/v3/order', { symbol, orderId, origClientOrderId: clientOrderId });
    return jsonContent({ source: 'Binance', environment: runtimeConfig().environment, order: publicOrder(order) });
  },

  async binance_spot_order_preview(args) {
    const config = runtimeConfig();
    const symbol = normalizedSymbol(requiredText(args, 'symbol'));
    const snapshot = await symbolSnapshot(symbol);
    const order = orderParameters(args, snapshot);
    if (compareDecimals(order.estimatedQuote, String(config.maxOrderQuote)) > 0) {
      throw new Error(`estimated order value ${order.estimatedQuote} ${snapshot.quoteAsset} exceeds the FnzSafe limit ${config.maxOrderQuote}`);
    }
    const createdAt = Date.now();
    const clientOrderId = `fnz_${randomBytes(12).toString('hex')}`;
    const payload = {
      v: 1,
      kind: 'spot-order',
      environment: config.environment,
      symbol,
      baseAsset: snapshot.baseAsset,
      quoteAsset: snapshot.quoteAsset,
      referencePrice: snapshot.price,
      ...order,
      clientOrderId,
      createdAt,
      expiresAt: createdAt + PREVIEW_TTL_MS,
    };
    await signedRequest('POST', '/api/v3/order/test', orderRequestParameters(payload));
    return jsonContent({
      source: 'Binance',
      action: 'preview',
      tradingEnabled: config.tradingEnabled,
      maxOrderQuote: config.maxOrderQuote,
      preview: payload,
      previewToken: encodePreview(payload, config.secretKey),
      confirmationRequired: 'CONFIRM',
      warning: 'This preview does not place an order. Verify every field before execution.',
    });
  },

  async binance_spot_order_execute(args) {
    requireConfirmation(args);
    const { config, payload } = decodePreview(requiredText(args, 'previewToken'), 'spot-order');
    if (!config.tradingEnabled) throw new Error('Binance AI trading is disabled in FnzSafe settings');
    if (compareDecimals(payload.estimatedQuote, String(config.maxOrderQuote)) > 0) throw new Error('preview exceeds the current FnzSafe order limit');
    const order = await signedRequest('POST', '/api/v3/order', orderRequestParameters(payload));
    return jsonContent({ source: 'Binance', environment: config.environment, status: 'submitted', order: publicOrder(order), fills: order.fills ?? [] });
  },

  async binance_spot_cancel_preview(args) {
    const config = runtimeConfig();
    const symbol = normalizedSymbol(requiredText(args, 'symbol'));
    const orderId = requiredText(args, 'orderId');
    if (!/^[0-9]{1,24}$/u.test(orderId)) throw new Error('orderId is invalid');
    const order = await signedRequest('GET', '/api/v3/order', { symbol, orderId });
    if (!['NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL'].includes(order.status)) {
      throw new Error(`order ${orderId} cannot be cancelled from status ${order.status}`);
    }
    const createdAt = Date.now();
    const payload = { v: 1, kind: 'spot-cancel', environment: config.environment, symbol, orderId, order: publicOrder(order), createdAt, expiresAt: createdAt + PREVIEW_TTL_MS };
    return jsonContent({ source: 'Binance', action: 'cancel-preview', preview: payload, previewToken: encodePreview(payload, config.secretKey), confirmationRequired: 'CONFIRM' });
  },

  async binance_spot_cancel_execute(args) {
    requireConfirmation(args);
    const { config, payload } = decodePreview(requiredText(args, 'previewToken'), 'spot-cancel');
    if (!config.tradingEnabled) throw new Error('Binance AI trading is disabled in FnzSafe settings');
    const order = await signedRequest('DELETE', '/api/v3/order', { symbol: payload.symbol, orderId: payload.orderId });
    return jsonContent({ source: 'Binance', environment: config.environment, status: 'cancelled', order: publicOrder(order) });
  },

  async binance_token_audit(args) {
    const chainId = requiredText(args, 'chainId');
    if (!['1', '56', '8453', 'CT_501'].includes(chainId)) throw new Error('chainId is unsupported');
    const contractAddress = requiredText(args, 'contractAddress');
    const evm = /^0x[0-9a-fA-F]{40}$/u.test(contractAddress);
    const solana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(contractAddress);
    if ((chainId === 'CT_501' && !solana) || (chainId !== 'CT_501' && !evm)) throw new Error('contractAddress is invalid for chainId');
    const result = await request(BINANCE_WEB3_AUDIT_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/json',
        source: 'agent',
        'User-Agent': 'FnzSafe-Binance-Web3/1.4',
      },
      body: JSON.stringify({ binanceChainId: chainId, contractAddress, requestId: randomUUID() }),
    });
    const data = result?.data ?? {};
    if (data.hasResult !== true || data.isSupported !== true) {
      return jsonContent({ source: 'Binance Web3', hasResult: false, isSupported: false, warning: 'Security audit data is unavailable for this token and chain.' });
    }
    return jsonContent({
      source: 'Binance Web3',
      retrievedAt: new Date().toISOString(),
      hasResult: true,
      isSupported: true,
      riskLevel: data.riskLevel,
      riskLevelEnum: data.riskLevelEnum,
      extraInfo: data.extraInfo,
      riskItems: data.riskItems,
      disclaimer: 'This point-in-time audit is for reference only and is not investment advice.',
    });
  },
};

export const binanceAgentInternals = {
  compareDecimals,
  decodePreview,
  encodePreview,
  multiplyDecimals,
  normalizedSymbol,
  decimal,
  orderParameters,
};
