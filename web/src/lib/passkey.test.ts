import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from './bytes';
import {
  generateFallbackPassword,
  unwrapPasswordWithPrfKey,
  validatePasskeyState,
  wrapPasswordWithPrfKey,
  type WalletPasskeyState,
} from './passkey';

function metadata(): Omit<WalletPasskeyState, 'wrappedPassword'> {
  return {
    schema: 'org.tensorcash.webwallet.passkey',
    version: 1,
    walletId: '8fc12586-733b-4f42-9f5f-0e1414cb73bb',
    credentialId: 'AQIDBAUGBwg',
    transports: ['internal'],
    rpId: 'localhost',
    prfSalt: bytesToBase64(new Uint8Array(32).fill(0x35)),
    cipher: { name: 'AES-256-GCM', iv: bytesToBase64(new Uint8Array(12).fill(0x72)) },
    createdAt: '2026-08-21T00:00:00.000Z',
  };
}

describe('local Passkey password wrapper', () => {
  it('generates a high-entropy fallback password without keyboard input', () => {
    const first = generateFallbackPassword();
    const second = generateFallbackPassword();
    expect(first).toMatch(/^(?:[A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/);
    expect(second).not.toBe(first);
  });

  it('round-trips the existing wallet password without changing the vault', async () => {
    const key = new Uint8Array(32).fill(0x81);
    const state = await wrapPasswordWithPrfKey(metadata(), 'existing-user-password', key);
    expect(state.wrappedPassword).not.toContain('existing-user-password');
    expect(await unwrapPasswordWithPrfKey(state, key)).toBe('existing-user-password');
  });

  it('rejects a different Passkey PRF output', async () => {
    const state = await wrapPasswordWithPrfKey(metadata(), 'existing-user-password', new Uint8Array(32).fill(0x81));
    await expect(unwrapPasswordWithPrfKey(state, new Uint8Array(32).fill(0x82))).rejects.toThrow(
      'Use your wallet password instead',
    );
  });

  it('authenticates the wallet binding and Passkey metadata', async () => {
    const key = new Uint8Array(32).fill(0x81);
    const state = await wrapPasswordWithPrfKey(metadata(), 'existing-user-password', key);
    const moved = { ...state, walletId: 'different-wallet-id' };
    await expect(unwrapPasswordWithPrfKey(moved, key)).rejects.toThrow('Use your wallet password instead');
  });

  it('rejects malformed optional state so callers can fall back to password', () => {
    expect(() => validatePasskeyState({ ...metadata(), wrappedPassword: 'not base64!' })).toThrow(
      'Invalid base64 data',
    );
  });
});
