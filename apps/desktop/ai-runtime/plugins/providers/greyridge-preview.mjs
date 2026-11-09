import { fetchJsonWithoutRedirects } from '../lib/web3-utils.mjs';

const BASE_URL = 'https://x402-data-api.sigrunner.workers.dev';
const MAX_AGE_MS = 15 * 60_000;
const LIMITATION = 'Optional Base-only free preview; provider quotas apply. Missing simulation or tax data is unknown, not zero or safe. This is not a full router swap, an audit, or permission to trade. No paid endpoint or payment is used.';

function nullableBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function nullableBps(value) {
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : null;
}

function validateSnapshot(data, address) {
  if (!data || data.token?.toLowerCase?.() !== address ||
      (data.chain !== undefined && data.chain !== 'base') ||
      (data.chainId !== undefined && data.chainId !== 8453) ||
      !Number.isFinite(data.risk_score) || data.risk_score < 0 || data.risk_score > 100) {
    throw new Error('Invalid preview identity or risk score');
  }
  const time = typeof data.analyzed_at === 'string' ? Date.parse(data.analyzed_at) : NaN;
  const age = Date.now() - time;
  if (!Number.isFinite(time) || age < -60_000 || age > MAX_AGE_MS) {
    throw new Error('Preview timestamp is missing or stale');
  }
}

// Both URLs are fixed free-preview routes. Never follow provider upgrade/payment
// instructions or treat a demo-token response as evidence for another contract.
export async function greyRidgePreview(address) {
  const base = { source: 'Grey Ridge', network: '8453', address, mode: 'free-preview', limitation: LIMITATION };
  try {
    const query = `token=${encodeURIComponent(address)}`;
    const [gate, report] = await Promise.all([
      fetchJsonWithoutRedirects(`${BASE_URL}/gate/swap/preview?${query}&side=buy&notional_usd=100`),
      fetchJsonWithoutRedirects(`${BASE_URL}/chain/token-report/preview?${query}`),
    ]);
    validateSnapshot(gate, address);
    validateSnapshot(report, address);
    if (report.chain !== 'base' || gate.side !== 'buy' || gate.notional_usd !== 100 ||
        !['go', 'hold', 'block'].includes(gate.decision) ||
        !['SAFE', 'CAUTION', 'AVOID'].includes(gate.verdict) ||
        !['SAFE', 'CAUTION', 'AVOID'].includes(report.verdict) ||
        !report.security || typeof report.security !== 'object' || Array.isArray(report.security)) {
      throw new Error('Invalid preview coverage');
    }
    const security = report.security;
    const simulationVerified = security.simStatus === 'tested' && security.sellabilityUnverified === false &&
      security.sellable === true && security.isHoneypot === false && gate.sellability_unverified === false;
    const taxesKnown = ['buyTaxBps', 'sellTaxBps', 'transferTaxBps'].every(key => nullableBps(security[key]) !== null);
    const blocked = gate.decision === 'block' || gate.verdict === 'AVOID' || report.verdict === 'AVOID' || security.isHoneypot === true || security.sellable === false;
    // Keep the provider's observation separate from a conservative advisory.
    // A positive free preview cannot override an incomplete/negative signal.
    const adminRisk = ['taxMutable', 'upgradeableProxy', 'canMint', 'canPause', 'hasBlacklist'].some(key => security[key] !== false);
    const noMeasuredTax = ['buyTaxBps', 'sellTaxBps', 'transferTaxBps'].every(key => security[key] === 0);
    let advisory = 'hold';
    if (blocked) advisory = 'block';
    else if (gate.decision === 'go' && gate.verdict === 'SAFE' && report.verdict === 'SAFE' &&
        simulationVerified && noMeasuredTax && !adminRisk && gate.risk_score === 0 && report.risk_score === 0) advisory = 'go';
    return {
      ...base, status: 'available', advisory, providerDecision: gate.decision,
      riskScore: Math.max(gate.risk_score, report.risk_score),
      scenario: { side: 'buy', notionalUsd: 100, illustrativeOnly: true },
      gateAnalyzedAt: gate.analyzed_at, reportAnalyzedAt: report.analyzed_at,
      simulationVerified, taxesKnown,
      security: {
        isHoneypot: nullableBoolean(security.isHoneypot), sellable: nullableBoolean(security.sellable),
        buyTaxBps: nullableBps(security.buyTaxBps), sellTaxBps: nullableBps(security.sellTaxBps),
        transferTaxBps: nullableBps(security.transferTaxBps),
        taxMutable: nullableBoolean(security.taxMutable), upgradeableProxy: nullableBoolean(security.upgradeableProxy),
        canMint: nullableBoolean(security.canMint), canPause: nullableBoolean(security.canPause),
        hasBlacklist: nullableBoolean(security.hasBlacklist),
      },
    };
  } catch {
    // Do not forward upstream HTML, promotion, payment URLs or instructions.
    return { ...base, status: 'unavailable', advisory: 'hold', reason: 'The free preview failed, was rate limited, or returned incomplete, mismatched or stale data.' };
  }
}
