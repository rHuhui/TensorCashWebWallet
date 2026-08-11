import { describe, expect, it } from 'vitest';
import { bech32m } from '@scure/base';
import { createWalletMaterial, validateMaterialDerivation } from './mldsa';

describe('TensorCash ML-DSA wallet material', () => {
  it('creates a witness-v2 mainnet wallet with self-consistent metadata', async () => {
    const wallet = await createWalletMaterial();
    const decoded = bech32m.decode(wallet.address as `tc1${string}`, 90);
    expect(decoded.prefix).toBe('tc');
    expect(decoded.words[0]).toBe(2);
    expect(wallet.key.publicKeyHex).toHaveLength(1952 * 2);
    expect(wallet.key.secretKeyHex).toHaveLength(4032 * 2);
    expect(wallet.taproot.scriptPubKeyHex).toHaveLength(34 * 2);
    expect(validateMaterialDerivation(wallet)).toBe(true);
  }, 30_000);
});
