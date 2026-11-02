import { getBytes, hexlify } from 'ethers';

export function displaySignedMessage(method: string, params: unknown[]): string {
  const raw = String(method === 'eth_sign' ? params[1] ?? params[0] ?? '0x' : params[0] ?? '');
  const bytes = method === 'solana_signMessage'
    ? Uint8Array.from(atob(raw), c => c.charCodeAt(0))
    : raw.startsWith('0x') ? getBytes(raw) : new TextEncoder().encode(raw);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Keep control characters visible to prevent misleading signature previews.
    return JSON.stringify(text);
  } catch {
    return `Binary message (hex): ${hexlify(bytes)}`;
  }
}
