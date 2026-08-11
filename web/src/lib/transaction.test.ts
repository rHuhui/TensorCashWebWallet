import { describe, expect, it } from 'vitest';
import { bytesToHex } from './bytes';
import { createQtWalletMaterial, reserveQtChangeAddress, resolveQtP2wpkhSpendKey } from './qtWallet';
import {
  checkedWalletChangeAddress,
  feeRateFromTscPerKvb,
  maximumP2wpkhSendAmount,
  parseTscAmount,
  planP2wpkhTransaction,
  p2wpkhScript,
  signP2wpkhTransaction,
} from './transaction';

describe('standard TSC transaction signing', () => {
  it('parses exact amounts and conservative fee rates', () => {
    expect(parseTscAmount('1.00000001')).toBe(100_000_001);
    expect(feeRateFromTscPerKvb('0.00001000')).toBe(1);
    expect(feeRateFromTscPerKvb('1e-05')).toBe(1);
    expect(() => parseTscAmount('0.000000001')).toThrow();
  });

  it('only accepts a P2WPKH change address controlled by the wallet', async () => {
    const wallet = await createQtWalletMaterial('change-owner-password');
    const other = await createQtWalletMaterial('external-change-password');
    expect(checkedWalletChangeAddress(wallet.address.toUpperCase(), wallet.qt.addresses)).toBe(wallet.address);
    expect(() => checkedWalletChangeAddress(other.address, wallet.qt.addresses)).toThrow(/owned by this wallet/i);
  });

  it('builds and signs a native P2WPKH transaction locally', async () => {
    const source = await createQtWalletMaterial('source-test-password');
    const destination = await createQtWalletMaterial('destination-test-password');
    const change = await reserveQtChangeAddress(source);
    const plan = planP2wpkhTransaction(
      [{
        address: source.address,
        txid: '11'.repeat(32),
        vout: 1,
        value_sats: 200_000_000,
        script_pubkey: bytesToHex(p2wpkhScript(source.address)),
        height: 100,
        confirmations: 101,
        coinbase: false,
      }],
      destination.address,
      25_000_000,
      change.address,
      2,
      200,
    );
    const signed = signP2wpkhTransaction(plan, (address) => resolveQtP2wpkhSpendKey(change.material, address));
    expect(signed.hex.startsWith('02000000000101')).toBe(true);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.wtxid).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.vsize).toBeLessThanOrEqual(plan.estimatedVsize);
    expect(plan.feeSats).toBeGreaterThanOrEqual(signed.vsize * 2);
    expect(plan.outputs.map((output) => output.address)).toEqual([destination.address, change.address]);
  });

  it('calculates MAX from every spendable input after the one-output fee', async () => {
    const wallet = await createQtWalletMaterial('max-source-password');
    const destination = await createQtWalletMaterial('max-destination-password');
    const utxos = [
      { address: wallet.address, txid: '22'.repeat(32), vout: 0, value_sats: 60_000_000, script_pubkey: bytesToHex(p2wpkhScript(wallet.address)), height: 100, confirmations: 12, coinbase: false },
      { address: wallet.address, txid: '33'.repeat(32), vout: 1, value_sats: 40_000_000, script_pubkey: bytesToHex(p2wpkhScript(wallet.address)), height: 101, confirmations: 11, coinbase: false },
    ];
    const maximum = maximumP2wpkhSendAmount(utxos, 2);
    expect(maximum.inputCount).toBe(2);
    expect(maximum.amountSats + maximum.feeSats).toBe(100_000_000);
    const plan = planP2wpkhTransaction(utxos, destination.address, maximum.amountSats, wallet.address, 2, 200);
    expect(plan.changeSats).toBe(0);
    expect(plan.feeSats).toBe(maximum.feeSats);
  });
});
