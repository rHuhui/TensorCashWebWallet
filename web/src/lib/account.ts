import type { TransactionPlan } from './transaction';
import type { AddressSummary, AddressTransaction } from './types';

const LOCAL_PENDING_GRACE_SECONDS = 5 * 60;

function sortedTransactions(transactions: AddressTransaction[]) {
  return [...transactions]
    .sort((left, right) => right.timestamp - left.timestamp || left.txid.localeCompare(right.txid))
    .slice(0, 25);
}

export function createLocalPendingTransaction(
  txid: string,
  plan: TransactionPlan,
  ownedAddresses: string[],
  timestamp = Math.floor(Date.now() / 1000),
): AddressTransaction {
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('Invalid broadcast transaction id');
  const owned = new Set(ownedAddresses.map((address) => address.toLowerCase()));
  if (!plan.inputs.length || plan.inputs.some((input) => !owned.has(input.address.toLowerCase()))) {
    throw new Error('Transaction contains an input outside this wallet');
  }
  const sentSats = plan.inputs.reduce((sum, input) => sum + input.value_sats, 0);
  const receivedSats = plan.outputs.reduce(
    (sum, output) => sum + (owned.has(output.address.toLowerCase()) ? output.valueSats : 0),
    0,
  );
  return {
    txid: txid.toLowerCase(),
    status: 'pending',
    locally_broadcast: true,
    confirmations: 0,
    block_height: null,
    block_hash: null,
    timestamp,
    received_sats: receivedSats,
    sent_sats: sentSats,
    delta_sats: receivedSats - sentSats,
    transfer_sats: plan.amountSats,
    fee_sats: plan.feeSats,
    is_coinbase: 0,
    from_addresses: [],
    to_addresses: plan.outputs
      .filter((output) => !owned.has(output.address.toLowerCase()))
      .map((output) => ({ address: output.address, value_sats: output.valueSats })),
    input_addresses: plan.inputs.map((input) => ({ address: input.address, value_sats: input.value_sats })),
    output_addresses: plan.outputs.map((output) => ({ address: output.address, value_sats: output.valueSats })),
  };
}

export function addPendingToSummary(summary: AddressSummary, transaction: AddressTransaction): AddressSummary {
  return {
    ...summary,
    unconfirmed_balance_sats: (summary.unconfirmed_balance_sats ?? 0) + transaction.delta_sats,
    pending_received_sats: (summary.pending_received_sats ?? 0) + transaction.received_sats,
    pending_sent_sats: (summary.pending_sent_sats ?? 0) + transaction.sent_sats,
    tx_count: summary.tx_count + 1,
  };
}

export function prependLocalPending(
  current: AddressTransaction[],
  transaction: AddressTransaction,
): AddressTransaction[] {
  const withoutDuplicate = current.filter((item) => item.txid !== transaction.txid);
  return sortedTransactions([transaction, ...withoutDuplicate]);
}

export function reconcileLiveAccount(
  remoteSummary: AddressSummary,
  remoteTransactions: AddressTransaction[],
  currentTransactions: AddressTransaction[],
  now = Math.floor(Date.now() / 1000),
): { summary: AddressSummary; transactions: AddressTransaction[] } {
  const remoteIds = new Set(remoteTransactions.map((transaction) => transaction.txid));
  const retained = currentTransactions.filter((transaction) =>
    transaction.locally_broadcast === true &&
    transaction.status === 'pending' &&
    !remoteIds.has(transaction.txid) &&
    now - transaction.timestamp < LOCAL_PENDING_GRACE_SECONDS,
  );
  return {
    summary: retained.reduce(addPendingToSummary, remoteSummary),
    transactions: sortedTransactions([...remoteTransactions, ...retained]),
  };
}
