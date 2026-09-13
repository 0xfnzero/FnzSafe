export interface SocialRecoveryConfiguration {
  googleClientId: string;
  authorizationEndpoint: string;
  mpcExchangeEndpoint: string;
  redirectUri: string;
}

export interface SocialRecoveryResult {
  recoverySessionId: string;
  expiresAt: number;
}

export interface SocialRecoveryProvider {
  readonly configured: boolean;
  beginGoogleRecovery(): Promise<SocialRecoveryResult>;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function createPkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export class DisabledSocialRecoveryProvider implements SocialRecoveryProvider {
  readonly configured = false;

  async beginGoogleRecovery(): Promise<never> {
    throw new Error(
      'Social recovery requires an audited MPC provider and OAuth PKCE configuration.',
    );
  }
}

// The provider interface deliberately returns only an opaque recovery session.
// OAuth identity tokens must never become wallet keys or bypass local approval.
