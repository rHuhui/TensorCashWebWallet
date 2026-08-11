import type { AddressSummary, AddressTransaction, ChainStatus, EncryptedVault, WalletAddressBalance } from './types';
import { validateVault } from './vault';

const DATABASE = 'tensorcash-wallet';
const STORE = 'vaults';
const LEGACY_ACTIVE_KEY = 'active';
const LEGACY_RECEIVE_STATE_KEY = 'active-receive-state';
const ACTIVE_WALLET_KEY = 'active-wallet-id';
const WALLET_PREFIX = 'wallet:';
const RECEIVE_PREFIX = 'receive-state:';
const BACKUP_PREFIX = 'backup-state:';
const ACCOUNT_CACHE_PREFIX = 'account-cache:';

export interface WalletBackupState {
  origin: 'created' | 'imported';
  backedUp: boolean;
}

export interface WalletAccountCache {
  version: 1;
  savedAt: number;
  status: ChainStatus;
  summary: AddressSummary;
  transactions: AddressTransaction[];
  fundedAddresses?: WalletAddressBalance[];
}

function walletKey(walletId: string): string { return `${WALLET_PREFIX}${walletId}`; }
function receiveKey(walletId: string): string { return `${RECEIVE_PREFIX}${walletId}`; }
function backupKey(walletId: string): string { return `${BACKUP_PREFIX}${walletId}`; }
function accountCacheKey(walletId: string): string { return `${ACCOUNT_CACHE_PREFIX}${walletId}`; }

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function validAccountCache(value: unknown): value is WalletAccountCache {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Partial<WalletAccountCache>;
  const status = cache.status as Partial<ChainStatus> | undefined;
  const summary = cache.summary as Partial<AddressSummary> | undefined;
  return cache.version === 1 && isInteger(cache.savedAt) && Boolean(status) &&
    typeof status?.network === 'string' && isInteger(status.core_height) &&
    isInteger(status.header_height) && isInteger(status.indexed_height) &&
    isInteger(status.lag) && typeof status.synced === 'boolean' &&
    isInteger(status.observed_at) && Boolean(summary) &&
    typeof summary?.address === 'string' && isInteger(summary.balance_sats) &&
    isInteger(summary.received_sats) && isInteger(summary.sent_sats) &&
    isInteger(summary.tx_count) && Array.isArray(cache.transactions) &&
    cache.transactions.length <= 25 && cache.transactions.every((transaction) =>
      transaction && typeof transaction === 'object' &&
      typeof transaction.txid === 'string' && /^[0-9a-f]{64}$/i.test(transaction.txid) &&
      (transaction.status === 'pending' || transaction.status === 'confirmed' || transaction.status === undefined) &&
      (transaction.locally_broadcast === undefined || typeof transaction.locally_broadcast === 'boolean') &&
      isInteger(transaction.timestamp) && isInteger(transaction.received_sats) &&
      isInteger(transaction.sent_sats) && isInteger(transaction.delta_sats)) &&
    (cache.fundedAddresses === undefined || (Array.isArray(cache.fundedAddresses) &&
      cache.fundedAddresses.length <= 200 && cache.fundedAddresses.every((item) =>
        item && typeof item === 'object' && typeof item.address === 'string' &&
        isInteger(item.balance_sats) && item.balance_sats > 0 &&
        isInteger(item.received_sats) && isInteger(item.sent_sats) && isInteger(item.tx_count))));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Unable to open encrypted wallet storage'));
  });
}

function requestValue<T>(request: IDBRequest<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(message));
  });
}

async function migrateLegacyVault(database: IDBDatabase): Promise<EncryptedVault | null> {
  const value = await requestValue(
    database.transaction(STORE, 'readonly').objectStore(STORE).get(LEGACY_ACTIVE_KEY),
    'Unable to read encrypted wallet storage',
  );
  if (value === undefined) return null;
  validateVault(value);
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    store.put(value, walletKey(value.walletId));
    store.put(value.walletId, ACTIVE_WALLET_KEY);
    store.delete(LEGACY_ACTIVE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('Unable to migrate encrypted wallet storage'));
    transaction.onabort = () => reject(new Error('Wallet migration was aborted'));
  });
  return value;
}

export async function loadVaults(): Promise<EncryptedVault[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    const [keys, values] = await Promise.all([
      requestValue(store.getAllKeys(), 'Unable to list encrypted wallets'),
      requestValue(store.getAll(), 'Unable to list encrypted wallets'),
    ]);
    const wallets: EncryptedVault[] = [];
    keys.forEach((key, index) => {
      if (typeof key !== 'string' || !key.startsWith(WALLET_PREFIX)) return;
      validateVault(values[index]);
      wallets.push(values[index] as EncryptedVault);
    });
    return wallets.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } finally {
    database.close();
  }
}

export async function loadVault(): Promise<EncryptedVault | null> {
  let database = await openDatabase();
  try {
    const store = database.transaction(STORE, 'readonly').objectStore(STORE);
    const activeId = await requestValue(store.get(ACTIVE_WALLET_KEY), 'Unable to read active wallet');
    if (typeof activeId === 'string') {
      const value = await requestValue(
        database.transaction(STORE, 'readonly').objectStore(STORE).get(walletKey(activeId)),
        'Unable to read encrypted wallet storage',
      );
      if (value !== undefined) {
        validateVault(value);
        return value;
      }
    }
  } finally {
    database.close();
  }

  database = await openDatabase();
  try {
    const migrated = await migrateLegacyVault(database);
    if (migrated) return migrated;
  } finally {
    database.close();
  }

  const wallets = await loadVaults();
  if (!wallets.length) return null;
  await activateVault(wallets[0].walletId);
  return wallets[0];
}

export async function saveVault(vault: EncryptedVault): Promise<void> {
  validateVault(vault);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      store.put(vault, walletKey(vault.walletId));
      store.put(vault.walletId, ACTIVE_WALLET_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Unable to save encrypted wallet'));
      transaction.onabort = () => reject(new Error('Wallet save was aborted'));
    });
  } finally {
    database.close();
  }
}

export async function activateVault(walletId: string): Promise<EncryptedVault> {
  const database = await openDatabase();
  try {
    const value = await requestValue(
      database.transaction(STORE, 'readonly').objectStore(STORE).get(walletKey(walletId)),
      'Unable to read selected wallet',
    );
    validateVault(value);
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(walletId, ACTIVE_WALLET_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Unable to switch wallet'));
      transaction.onabort = () => reject(new Error('Wallet switch was aborted'));
    });
    return value;
  } finally {
    database.close();
  }
}

export async function loadReceiveAddressCount(walletId: string): Promise<number | null> {
  const database = await openDatabase();
  try {
    const store = database.transaction(STORE, 'readonly').objectStore(STORE);
    let value = await requestValue(store.get(receiveKey(walletId)), 'Unable to read receive-address state') as { count?: unknown } | undefined;
    if (!value) {
      const legacy = await requestValue(
        database.transaction(STORE, 'readonly').objectStore(STORE).get(LEGACY_RECEIVE_STATE_KEY),
        'Unable to read receive-address state',
      ) as { walletId?: unknown; count?: unknown } | undefined;
      if (legacy?.walletId === walletId) value = legacy;
    }
    return Number.isSafeInteger(value?.count) && Number(value?.count) >= 1 ? Number(value?.count) : null;
  } finally {
    database.close();
  }
}

export async function saveReceiveAddressCount(walletId: string, count: number): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 200) throw new Error('Invalid receive-address count');
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put({ walletId, count }, receiveKey(walletId));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Unable to save receive-address state'));
      transaction.onabort = () => reject(new Error('Receive-address update was aborted'));
    });
  } finally {
    database.close();
  }
}

export async function loadBackupState(walletId: string): Promise<WalletBackupState | null> {
  const database = await openDatabase();
  try {
    const value = await requestValue(
      database.transaction(STORE, 'readonly').objectStore(STORE).get(backupKey(walletId)),
      'Unable to read wallet backup state',
    ) as Partial<WalletBackupState> | undefined;
    if (!value || (value.origin !== 'created' && value.origin !== 'imported') || typeof value.backedUp !== 'boolean') return null;
    return { origin: value.origin, backedUp: value.backedUp };
  } finally {
    database.close();
  }
}

export async function saveBackupState(walletId: string, state: WalletBackupState): Promise<void> {
  if ((state.origin !== 'created' && state.origin !== 'imported') || typeof state.backedUp !== 'boolean') {
    throw new Error('Invalid wallet backup state');
  }
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(state, backupKey(walletId));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Unable to save wallet backup state'));
      transaction.onabort = () => reject(new Error('Wallet backup-state update was aborted'));
    });
  } finally {
    database.close();
  }
}

export async function loadAccountCache(walletId: string): Promise<WalletAccountCache | null> {
  const database = await openDatabase();
  try {
    const value = await requestValue(
      database.transaction(STORE, 'readonly').objectStore(STORE).get(accountCacheKey(walletId)),
      'Unable to read cached account history',
    );
    return validAccountCache(value) ? value : null;
  } finally {
    database.close();
  }
}

export async function saveAccountCache(walletId: string, cache: Omit<WalletAccountCache, 'version' | 'savedAt'>): Promise<void> {
  const value: WalletAccountCache = {
    version: 1,
    savedAt: Date.now(),
    status: cache.status,
    summary: cache.summary,
    transactions: cache.transactions.slice(0, 25),
    fundedAddresses: cache.fundedAddresses?.slice(0, 200),
  };
  if (!validAccountCache(value)) throw new Error('Invalid account history cache');
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(value, accountCacheKey(walletId));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Unable to cache account history'));
      transaction.onabort = () => reject(new Error('Account history cache was aborted'));
    });
  } finally {
    database.close();
  }
}

export async function removeReceiveAddressState(walletId: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      store.delete(receiveKey(walletId));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Unable to remove receive-address state'));
      transaction.onabort = () => reject(new Error('Receive-address removal was aborted'));
    });
  } finally {
    database.close();
  }
}

export async function removeVault(walletId: string): Promise<EncryptedVault | null> {
  const remaining = (await loadVaults()).filter((wallet) => wallet.walletId !== walletId);
  const next = remaining[0] ?? null;
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      store.delete(walletKey(walletId));
      store.delete(receiveKey(walletId));
      store.delete(backupKey(walletId));
      store.delete(accountCacheKey(walletId));
      if (next) store.put(next.walletId, ACTIVE_WALLET_KEY);
      else store.delete(ACTIVE_WALLET_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Unable to remove encrypted wallet'));
      transaction.onabort = () => reject(new Error('Wallet removal was aborted'));
    });
  } finally {
    database.close();
  }
  return next;
}
