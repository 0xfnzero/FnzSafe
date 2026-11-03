import { groupedVault } from './vault';
import type { PublicWallet, VaultAccount, VaultPayload } from './types';

export type SessionAccount = Omit<VaultAccount, 'privateKey'>;

export interface UnlockedVaultSession {
  accounts: SessionAccount[];
  wallets: PublicWallet[];
  authorization?: { iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> };
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

export async function protectVaultInMemory(
  payload: VaultPayload,
  authorization?: string,
  stripRecovery = false,
): Promise<UnlockedVaultSession> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const grouped = groupedVault(payload);
  const groups = grouped.wallets!;
  const sessionPayload = stripRecovery ? { ...grouped, recoveryMnemonic: '', wallets: groups.map(w => ({ ...w, recoveryMnemonic: '' })) } : payload;
  const cleartext = new TextEncoder().encode(JSON.stringify(sessionPayload));
  let protectedAuthorization: UnlockedVaultSession['authorization'];
  if (authorization !== undefined) {
    const secret = new TextEncoder().encode(authorization), authIv = crypto.getRandomValues(new Uint8Array(12));
    try { protectedAuthorization = { iv: authIv, ciphertext: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: authIv }, key, secret)) }; }
    finally { secret.fill(0); }
  }
  try {
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, cleartext),
    );
    return {
      accounts: grouped.accounts.map(({ privateKey: _, ...account }) => ({ ...account, walletId: account.walletId ?? groups[0].id })),
      wallets: groups.map(w => ({ id: w.id, name: w.name, hasRecoveryPhrase: !!w.recoveryMnemonic })),
      authorization: protectedAuthorization,
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
  session.authorization?.iv.fill(0);
  session.authorization?.ciphertext.fill(0);
  session.iv.fill(0);
  session.ciphertext.fill(0);
}

export async function sessionAuthorization(session: UnlockedVaultSession): Promise<string> {
  if (!session.authorization) throw new Error('Unlock the wallet again to create a wallet');
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: session.authorization.iv }, session.key, session.authorization.ciphertext));
  try { return new TextDecoder().decode(clear); } finally { clear.fill(0); }
}
