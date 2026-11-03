import assert from 'node:assert/strict';
import test from 'node:test';
import { createWalletPasskey, unlockWithPasskey, validatePasskeyConfig } from '../src/passkey';
const rpId = 'a'.repeat(32), origin = `chrome-extension://${rpId}`;
const credentialId = '01'.repeat(32), salt = '02'.repeat(32);
Object.assign(globalThis, { location: { hostname: rpId, origin }, window: { PublicKeyCredential: class {} } });
function response(options: any, type: string, output = true, responseOrigin = origin) {
  assert.equal(options.publicKey.userVerification ?? options.publicKey.authenticatorSelection?.userVerification, 'required');
  const challenge = Buffer.from(options.publicKey.challenge).toString('base64url');
  return { rawId: Uint8Array.from(Buffer.from(credentialId, 'hex')).buffer,
    response: { clientDataJSON: new TextEncoder().encode(JSON.stringify({ challenge, type, origin: responseOrigin })).buffer },
    getClientExtensionResults: () => output ? { prf: { results: { first: new Uint8Array(32).fill(9).buffer } } } : {},
  };
}
function mock(create: (o: any) => any, get: (o: any) => any) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { create, get } } });
}
test('passkey setup verifies an assertion and uses only PRF output as the encryption secret', async () => {
  let gets = 0;
  mock(o => response(o, 'webauthn.create'), o => { gets++; return response(o, 'webauthn.get'); });
  const created = await createWalletPasskey();
  assert.equal(gets, 1);
  assert.equal(created.config.rpId, rpId);
  assert.equal(created.password, '09'.repeat(32));
  assert.equal(await unlockWithPasskey(created.config), created.password);
});
test('unsupported PRF, cancellation, wrong origins and foreign RP IDs fail closed', async () => {
  const config = { credentialId, salt, rpId };
  mock(o => response(o, 'webauthn.create'), o => response(o, 'webauthn.get', false));
  await assert.rejects(createWalletPasskey(), /PRF/);
  mock(() => null, () => null);
  await assert.rejects(createWalletPasskey(), /cancelled/);
  await assert.rejects(unlockWithPasskey(config), /cancelled/);
  mock(() => null, o => response(o, 'webauthn.get', true, 'https://attacker.example'));
  await assert.rejects(unlockWithPasskey(config), /does not match/);
  assert.throws(() => validatePasskeyConfig({ ...config, rpId: 'attacker.example' }, rpId));
});
