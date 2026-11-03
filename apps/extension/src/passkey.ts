export interface PasskeyConfig { credentialId: string; salt: string; rpId: string }
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], b => parseInt(b, 16));
export function validatePasskeyConfig(raw: unknown, rpId: string): PasskeyConfig {
  const c = raw as PasskeyConfig;
  if (!c || c.rpId !== rpId || typeof c.credentialId !== 'string' || !/^(?:[a-f0-9]{2}){16,1024}$/.test(c.credentialId) || typeof c.salt !== 'string' || !/^[a-f0-9]{64}$/.test(c.salt)) throw new Error('Invalid passkey configuration');
  return { credentialId: c.credentialId, salt: c.salt, rpId: c.rpId };
}
interface PrfOutput { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } }
function secret(credential: PublicKeyCredential): string {
  const output = (credential.getClientExtensionResults() as PrfOutput).prf?.results?.first;
  if (!output || output.byteLength !== 32) throw new Error('This passkey provider does not support wallet encryption (PRF). Choose another provider or use a password.');
  const bytes = new Uint8Array(output);
  try { return hex(bytes); } finally { bytes.fill(0); }
}
function verifyResponse(credential: PublicKeyCredential, challenge: Uint8Array, type: string, origin: string) {
  const data = JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON));
  const expected = btoa(String.fromCharCode(...challenge)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  if (data.type !== type || data.challenge !== expected || data.origin !== origin || data.crossOrigin === true) throw new Error('Passkey response does not match this wallet request');
}
export async function unlockWithPasskey(config: PasskeyConfig): Promise<string> {
  validatePasskeyConfig(config, location.hostname);
  if (!navigator.credentials || !window.PublicKeyCredential) throw new Error('Passkeys are unavailable in this browser');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.get({ publicKey: {
    challenge, rpId: config.rpId, timeout: 60000, userVerification: 'required',
    allowCredentials: [{ id: unhex(config.credentialId), type: 'public-key' }],
    extensions: { prf: { eval: { first: unhex(config.salt) } } } as AuthenticationExtensionsClientInputs,
  } }) as PublicKeyCredential | null;
  if (!credential || hex(new Uint8Array(credential.rawId)) !== config.credentialId) throw new Error('Passkey verification was cancelled');
  verifyResponse(credential, challenge, 'webauthn.get', location.origin);
  return secret(credential);
}
export async function createWalletPasskey(): Promise<{ config: PasskeyConfig; password: string }> {
  if (!navigator.credentials || !window.PublicKeyCredential) throw new Error('Passkeys are unavailable in this browser');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.create({ publicKey: {
    challenge, rp: { id: location.hostname, name: 'FnzSafe Wallet' },
    user: { id: crypto.getRandomValues(new Uint8Array(32)), name: 'FnzSafe wallet', displayName: 'FnzSafe wallet' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    attestation: 'none', timeout: 60000,
    extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
  } }) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey creation was cancelled');
  verifyResponse(credential, challenge, 'webauthn.create', location.origin);
  const config = validatePasskeyConfig({ credentialId: hex(new Uint8Array(credential.rawId)), salt: hex(salt), rpId: location.hostname }, location.hostname);
  // Always prove that an assertion can reproduce a PRF before changing storage.
  const password = await unlockWithPasskey(config);
  return { config, password };
}
