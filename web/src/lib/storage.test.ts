import { describe, expect, it } from 'vitest';
import { filterStoredVaultRecords } from './storage';
import type { EncryptedVault } from './types';

function vault(walletId: string, createdAt: string): EncryptedVault {
  return {
    schema: 'org.tensorcash.webwallet.vault',
    version: 1,
    walletId,
    walletName: `Wallet ${walletId}`,
    network: 'mainnet',
    address: 'tc1qg83etpvnwl8jqrexs3zsnpvpcvepwg2xduejel',
    addresses: ['tc1qg83etpvnwl8jqrexs3zsnpvpcvepwg2xduejel'],
    receiveAddresses: ['tc1qg83etpvnwl8jqrexs3zsnpvpcvepwg2xduejel'],
    receiveAddressCount: 1,
    createdAt,
    kdf: { name: 'argon2id', salt: 'AA==', memoryKiB: 65_536, iterations: 3, parallelism: 1 },
    cipher: { name: 'AES-256-GCM', iv: 'AA==' },
    ciphertext: 'AA==',
  };
}

describe('wallet storage inventory', () => {
  it('keeps healthy wallets visible when one record is malformed', () => {
    const healthy = vault('healthy', '2026-08-12T00:00:00.000Z');
    const inventory = filterStoredVaultRecords(
      ['wallet:broken', 'wallet:healthy', 'account-cache:healthy'],
      [{ schema: 'damaged' }, healthy, { ignored: true }],
    );
    expect(inventory.wallets).toEqual([healthy]);
    expect(inventory.invalidRecordCount).toBe(1);
  });
});
