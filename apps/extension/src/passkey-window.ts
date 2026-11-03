import type { PasskeyConfig } from './passkey';

export const PASSKEY_CALLER_PORT = 'fnzsafe-passkey-caller';
export const PASSKEY_WINDOW_PORT = 'fnzsafe-passkey-window';
export type PasskeyRequest = { mode: 'create' } | { mode: 'unlock'; config: PasskeyConfig };
export type PasskeyResult = { password: string; config?: PasskeyConfig };

/** Screen coordinates may be negative on a monitor left of the primary display. */
export function passkeyWindowBounds(screen: { availWidth: number; availHeight: number; availLeft?: number; availTop?: number }) {
  const availableWidth = Math.max(1, Math.floor(screen.availWidth || 1024));
  const availableHeight = Math.max(1, Math.floor(screen.availHeight || 768));
  const width = Math.min(840, Math.max(1, availableWidth - 32));
  const height = Math.min(720, Math.max(1, availableHeight - 32));
  return {
    width, height,
    left: Math.round((screen.availLeft ?? 0) + (availableWidth - width) / 2),
    top: Math.round((screen.availTop ?? 0) + (availableHeight - height) / 2),
  };
}
