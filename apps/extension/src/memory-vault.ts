import type { VaultAccount, VaultPayload } from './types';

export type SessionAccount = Omit<VaultAccount, 'privateKey'>;

export interface UnlockedVaultSession {
  accounts: SessionAccount[];
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

export async function protectVaultInMemory(
  payload: VaultPayload,
): Promise<UnlockedVaultSession> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cleartext = new TextEncoder().encode(JSON.stringify(payload));
  try {
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, cleartext),
    );
    return {
      accounts: payload.accounts.map(({ privateKey: _, ...account }) => account),
      key,
      iv,
      ciphertext,
    };
  } finally {
    cleartext.fill(0);
  }
}

export async function decryptSessionVault(
  session: UnlockedVaultSession,
): Promise<VaultPayload> {
  let cleartext: Uint8Array<ArrayBuffer> | undefined;
  try {
    cleartext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: session.iv },
        session.key,
        session.ciphertext,
      ),
    );
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(cleartext),
    ) as VaultPayload;
  } finally {
    cleartext?.fill(0);
  }
}

export function destroyVaultSession(session: UnlockedVaultSession): void {
  session.iv.fill(0);
  session.ciphertext.fill(0);
}
