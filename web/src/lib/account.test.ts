import { describe, expect, it } from 'vitest';
import { addPendingToSummary, createLocalPendingTransaction, reconcileLiveAccount } from './account';
import type { TransactionPlan } from './transaction';
import type { AddressSummary } from './types';

const SOURCE = 'tc1qsourceaddress000000000000000000000000';
const CHANGE = 'tc1qchangeaddress000000000000000000000000';
const DESTINATION = 'tc1qdestination00000000000000000000000';

const plan: TransactionPlan = {
  version: 2,
  lockTime: 100,
  recipient: DESTINATION,
  amountSats: 25_000_000,
  feeSats: 141,
  feeRateSatVb: 1,
  changeSats: 74_999_859,
  estimatedVsize: 141,
  inputs: [{
    address: SOURCE,
    txid: '11'.repeat(32),
    vout: 0,
    value_sats: 100_000_000,
    script_pubkey: '0014' + '22'.repeat(20),
    height: 90,
    confirmations: 10,
    coinbase: false,
    sequence: 0xffff_fffd,
  }],
  outputs: [
    { address: DESTINATION, valueSats: 25_000_000, scriptPubKey: new Uint8Array(), change: false },
    { address: CHANGE, valueSats: 74_999_859, scriptPubKey: new Uint8Array(), change: true },
  ],
};

const summary: AddressSummary = {
  address: SOURCE,
  balance_sats: 100_000_000,
  unconfirmed_balance_sats: 0,
  pending_received_sats: 0,
  pending_sent_sats: 0,
  received_sats: 100_000_000,
  sent_sats: 0,
  tx_count: 1,
  first_seen_height: 90,
  last_seen_height: 90,
};

describe('locally broadcast wallet activity', () => {
  it('records the exact wallet-side pending value immediately', () => {
    const pending = createLocalPendingTransaction('aa'.repeat(32), plan, [SOURCE, CHANGE], 1_800_000_000);
    expect(pending).toMatchObject({
      status: 'pending',
      locally_broadcast: true,
      received_sats: 74_999_859,
      sent_sats: 100_000_000,
      delta_sats: -25_000_141,
      transfer_sats: 25_000_000,
      fee_sats: 141,
    });
    expect(addPendingToSummary(summary, pending)).toMatchObject({
      unconfirmed_balance_sats: -25_000_141,
      pending_received_sats: 74_999_859,
      pending_sent_sats: 100_000_000,
      tx_count: 2,
    });
  });

  it('keeps a fresh local record while an upstream mempool cache catches up', () => {
    const pending = createLocalPendingTransaction('aa'.repeat(32), plan, [SOURCE, CHANGE], 1_800_000_000);
    const reconciled = reconcileLiveAccount(summary, [], [pending], 1_800_000_030);
    expect(reconciled.transactions).toHaveLength(1);
    expect(reconciled.summary.unconfirmed_balance_sats).toBe(-25_000_141);
    expect(reconcileLiveAccount(summary, [], [pending], 1_800_000_301).transactions).toHaveLength(0);
  });
});
