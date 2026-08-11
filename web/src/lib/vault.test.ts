import { describe, expect, it } from 'vitest';
import { wipe } from './bytes';
import { decryptWallet, encryptWallet, validateVault } from './vault';
import type { MLDSAWalletMaterial } from './types';

function material(): MLDSAWalletMaterial {
  return {
    schema: 'org.tensorcash.webwallet.material',
    version: 1,
    walletId: '8fc12586-733b-4f42-9f5f-0e1414cb73bb',
    network: 'mainnet',
    address: 'tc1qg83etpvnwl8jqrexs3zsnpvpcvepwg2xduejel',
    createdAt: '2026-08-10T00:00:00.000Z',
    key: {
      algorithm: 'ML-DSA-65',
      publicKeyHex: '11'.repeat(1952),
      secretKeyHex: '22'.repeat(4032),
    },
    taproot: {
      encodedPublicKeyHex: '01',
      tapScriptHex: '02',
      scriptPubKeyHex: '03',
      internalPublicKeyHex: '04'.repeat(32),
      outputPublicKeyHex: '05'.repeat(32),
      leafHashHex: '06'.repeat(32),
      parity: false,
    },
  };
}

describe('encrypted wallet vault', () => {
  it('wipes Qt-sized buffers larger than the Web Crypto per-call limit', () => {
    const bytes = new Uint8Array(128 * 1024 + 17).fill(0x5a);
    expect(() => wipe(bytes)).not.toThrow();
    expect(bytes.every((value) => value === 0)).toBe(true);
  });
  it('round-trips wallet material without exposing a secret', async () => {
    const source = material();
    const vault = await encryptWallet(source, 'a secure test password', {
      memoryKiB: 32_768,
      iterations: 2,
    });
    expect(JSON.stringify(vault)).not.toContain(source.key.secretKeyHex.slice(0, 200));
    expect(await decryptWallet(vault, 'a secure test password')).toEqual(source);
  }, 30_000);

  it('requires 12 characters for new wallets while retaining legacy recovery', async () => {
    const vault = await encryptWallet(material(), '123456', {
      memoryKiB: 32_768,
      iterations: 2,
      allowLegacyPassword: true,
    });
    expect((await decryptWallet(vault, '123456')).walletId).toBe(material().walletId);
    await expect(encryptWallet(material(), '12345678901', {
      memoryKiB: 32_768,
      iterations: 2,
    })).rejects.toThrow('at least 12 characters');
  }, 30_000);

  it('authenticates public metadata and rejects tampering', async () => {
    const vault = await encryptWallet(material(), 'another secure password', {
      memoryKiB: 32_768,
      iterations: 2,
    });
    const tampered = { ...vault, address: `${vault.address.slice(0, -1)}x` };
    await expect(decryptWallet(tampered, 'another secure password')).rejects.toThrow(
      'Incorrect password or damaged wallet backup',
    );
  }, 30_000);

  it('authenticates a user supplied wallet name', async () => {
    const source = material();
    const vault = await encryptWallet(source, 'a secure test password', {
      memoryKiB: 32_768,
      iterations: 2,
    }, 'Personal wallet');
    expect(vault.walletName).toBe('Personal wallet');
    expect((await decryptWallet(vault, 'a secure test password')).walletId).toBe(source.walletId);
    expect(() => validateVault({ ...vault, walletName: 'x'.repeat(41) })).toThrow(
      'Unsupported or invalid wallet backup',
    );
  }, 30_000);

  it('rejects unknown formats', () => {
    expect(() => validateVault({ schema: 'unknown' })).toThrow('Unsupported or invalid wallet backup');
  });
});
