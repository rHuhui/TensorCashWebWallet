import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import packageMetadata from '../package.json';
import { importOfficialWalletExport } from './lib/mldsa';
import {
  advanceQtReceiveAddressCount,
  createQtP2wpkhSpendKeyResolver,
  createQtWalletMaterial,
  hydrateQtAddressState,
  inspectQtWallet,
  importQtWallet,
  prepareQtBackup,
  reserveQtChangeAddress,
} from './lib/qtWallet';
import { decryptWallet, encryptWallet, validateVault, vaultFingerprint } from './lib/vault';
import {
  createPasskeyState,
  generateFallbackPassword,
  passkeyUnavailableReason,
  rewrapPasskeyPassword,
  unlockPasswordWithPasskey,
  type WalletPasskeyState,
} from './lib/passkey';
import {
  activateVault,
  loadAccountCache,
  loadBackupState,
  loadPasskeyState,
  loadReceiveAddressCount,
  loadVault,
  loadVaultInventory,
  loadVaults,
  removeVault,
  saveReceiveAddressCount,
  saveBackupState,
  saveAccountCache,
  savePasskeyState,
  saveVault,
  saveVaultAndPasskeyState,
  type WalletBackupState,
} from './lib/storage';
import {
  broadcastSignedTransaction,
  getFeeEstimate,
  getGatewayUrl,
  getStatus,
  getWalletOverview,
  getWalletUtxos,
  setGatewayUrl,
  testSignedTransaction,
} from './lib/gateway';
import { base64ToBytes } from './lib/bytes';
import {
  convertedTscPrice,
  formatCurrency,
  getDisplayCurrency,
  loadCurrencyRates,
  loadTscTicker,
  setDisplayCurrency as saveDisplayCurrency,
  type CurrencySnapshot,
  type MarketSnapshot,
} from './lib/market';
import {
  addPendingToSummary,
  createLocalPendingTransaction,
  prependLocalPending,
  reconcileLiveAccount,
} from './lib/account';
import {
  checkedWalletChangeAddress,
  feeRateFromTscPerKvb,
  maximumP2wpkhSendAmount,
  partitionP2wpkhUtxos,
  parseTscAmount,
  planP2wpkhTransaction,
  requiresHighFeeConfirmation,
  signP2wpkhTransaction,
  type TransactionPlan,
  type WalletUtxo,
} from './lib/transaction';
import type {
  AddressSummary,
  AddressTransaction,
  ChainStatus,
  CoreWalletMaterial,
  EncryptedVault,
  WalletAddressBalance,
  WalletMaterial,
} from './lib/types';

type View = 'overview' | 'receive' | 'send' | 'activity' | 'addresses' | 'settings' | 'wallets';
type Dialog = 'create' | 'import' | 'unlock' | 'backup' | null;
interface GeneratedFallbackNotice {
  walletName: string;
  address: string;
  password: string;
  origin: 'created' | 'imported';
}

const SOURCE_URL = import.meta.env.VITE_SOURCE_URL || 'https://github.com/rHuhui/TensorCashWebWallet';
const VERIFY_URL = import.meta.env.VITE_VERIFY_URL || 'https://rhuhui.github.io/TensorCashWebWallet/';
const EXPLORER_URL = (import.meta.env.VITE_EXPLORER_URL || 'https://tscscan.xyz').replace(/\/$/, '');
const APP_VERSION = packageMetadata.version;
const TSC = 100_000_000;
const FRESH_CHANGE_ADDRESS = '__fresh_internal_change__';
const PASSKEY_RECOMMENDATION_SEEN_KEY = 'tensorcash-passkey-recommendation-seen-v1';

function explorerTransactionUrl(txid: string) {
  return `${EXPLORER_URL}/tx/${encodeURIComponent(txid)}`;
}

function explorerAddressUrl(address: string) {
  return `${EXPLORER_URL}/address/${encodeURIComponent(address)}`;
}

function formatTsc(sats = 0): string {
  return (sats / TSC).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}

function formatTscInput(sats: number): string {
  const whole = Math.floor(sats / TSC);
  const fraction = String(sats % TSC).padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function short(value: string, start = 11, end = 9): string {
  return value.length > start + end + 1 ? `${value.slice(0, start)}…${value.slice(-end)}` : value;
}

function walletLabel(vault: EncryptedVault): string {
  return vault.walletName?.trim() || short(vault.address, 10, 7);
}

function localWalletAddressOwner(candidate: string, wallets: EncryptedVault[]) {
  const normalized = candidate.trim().toLowerCase();
  if (!normalized) return null;
  for (const wallet of wallets) {
    const addresses = new Set([wallet.address, ...(wallet.addresses ?? []), ...(wallet.receiveAddresses ?? [])].map((address) => address.toLowerCase()));
    if (addresses.has(normalized)) return { wallet, address: normalized };
  }
  return null;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function issuedReceiveAddresses(vault: EncryptedVault, exposedCount = vault.receiveAddressCount ?? 1): string[] {
  const addresses = vault.receiveAddresses?.length ? vault.receiveAddresses : [vault.address];
  const count = Math.max(1, Math.min(addresses.length, exposedCount));
  return addresses.slice(0, count);
}

function currentReceiveAddress(vault: EncryptedVault, exposedCount = vault.receiveAddressCount ?? 1): string {
  const addresses = issuedReceiveAddresses(vault, exposedCount);
  return addresses[addresses.length - 1] ?? vault.address;
}

function Logo() {
  return (
    <div className="brand" aria-label="TensorCash Wallet">
      <span className="brand-mark">T</span>
      <span>
        <strong>TensorCash</strong>
        <small>WALLET</small>
      </span>
    </div>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.23.7-3.91-1.37-3.91-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.39.97.1-.75.4-1.27.74-1.56-2.58-.29-5.29-1.29-5.29-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18A10.95 10.95 0 0 1 12 6.11c.98 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.4-2.72 5.38-5.3 5.67.42.36.79 1.07.79 2.16v3.25c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function SecurityIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M12 2.7 20 6v5.5c0 4.9-3.2 8.1-8 9.8-4.8-1.7-8-4.9-8-9.8V6l8-3.3Z" />
      <path fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" d="m8.5 12.1 2.2 2.2 4.9-5" />
    </svg>
  );
}

function SecurityCheckLink() {
  return (
    <span className="security-check">
      <a
        className="security-link"
        href={VERIFY_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="Open the independent security check before entering your wallet password"
        aria-describedby="security-dns-tip"
      >
        <SecurityIcon />
        <span className="security-attention" aria-hidden="true">!</span>
      </a>
      <span className="security-tip" id="security-dns-tip" role="tooltip">
        <span className="security-tip-label">SECURITY CHECK</span>
        <strong>Verify the page before entering your password</strong>
        <span>
          DNS or local-network hijacking can replace this page with a fake wallet. Open the independent security check and confirm every file matches before unlocking, backing up, or sending. Do not enter your password after a certificate warning or file mismatch.
        </span>
        <a href={VERIFY_URL} target="_blank" rel="noreferrer">Open security check <span aria-hidden="true">↗</span></a>
      </span>
    </span>
  );
}

function RecoveryBackupWarning({ vault, additionalCount, active, onBackup }: {
  vault: EncryptedVault;
  additionalCount: number;
  active: boolean;
  onBackup: () => void;
}) {
  return (
    <section className="backup-alert" role="alert" aria-live="polite">
      <span className="backup-alert-icon" aria-hidden="true">!</span>
      <span className="backup-alert-copy">
        <strong>
          {walletLabel(vault)} <code>({short(vault.address, 13, 10)})</code> has not been backed up
        </strong>
        <span>
          This wallet exists only in this browser. Clearing site data, resetting the browser, or losing this device can permanently remove access to the wallet and its funds.
          {additionalCount > 0 && ` ${additionalCount} other local wallet${additionalCount === 1 ? '' : 's'} also need${additionalCount === 1 ? 's' : ''} a backup.`}
        </span>
      </span>
      <button type="button" onClick={onBackup}>{active ? 'Back up now' : 'Switch & back up'}</button>
    </section>
  );
}

function PasskeyRecommendation({ vault, additionalCount, onSetup, onDismiss }: {
  vault: EncryptedVault;
  additionalCount: number;
  onSetup: () => void;
  onDismiss: () => void;
}) {
  return <section className="passkey-recommendation" role="status" aria-live="polite">
    <span className="passkey-recommendation-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="8" cy="9" r="4"/><path d="m11 12 8 8m-2-2 2-2m-5-1 2-2"/></svg></span>
    <span className="passkey-recommendation-copy">
      <strong>Protect {walletLabel(vault)} <code>({short(vault.address, 13, 10)})</code> with Passkey</strong>
      <span>
        Passkey uses your device's secure verification and reduces exposure to keyboard-recording and clipboard-monitoring malware. Your wallet password always remains available as a fallback.
        {additionalCount > 0 && ` ${additionalCount} other password-only wallet${additionalCount === 1 ? '' : 's'} can also be upgraded.`}
      </span>
    </span>
    <span className="passkey-recommendation-actions">
      <button className="passkey-recommendation-setup" type="button" onClick={onSetup}>Set up Passkey</button>
      <button className="passkey-recommendation-dismiss" type="button" onClick={onDismiss} aria-label="Dismiss Passkey recommendation">×</button>
    </span>
  </section>;
}

function WalletSwitchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h13.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h11"/><path d="M15.5 11.5H22v4h-6.5a2 2 0 0 1 0-4Z"/><circle cx="17" cy="13.5" r=".7"/></svg>;
}

function ManageWalletsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="13" height="10" rx="2"/><path d="M8 19h11a2 2 0 0 0 2-2V9M6.5 9h6"/></svg>;
}

function ReceiveToolIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>;
}

function SendToolIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5m0 0 4 4m-4-4L8 9"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>;
}

function TransactionsToolIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h13m0 0-3-3m3 3-3 3M20 17H7m0 0 3 3m-3-3 3-3"/></svg>;
}

function SettingsToolIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10m4 0h2M4 12h3m4 0h9M4 18h8m4 0h4"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="14" cy="18" r="2"/></svg>;
}

function LiveSendIcon() {
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 20V7m0 0 5 5m-5-5-5 5"/><path d="M8 24h16M10.5 28h11"/></svg>;
}

function StatusBadge({ status, error }: { status: ChainStatus | null; error?: string }) {
  const stale = status?.stale || status?.core_available === false;
  const state = error ? 'error' : status?.synced && !stale ? 'ready' : 'warning';
  const label = error
    ? 'Gateway unavailable'
    : stale
      ? `Core delayed · index ${status?.indexed_height.toLocaleString() ?? '—'}`
      : status?.synced
      ? `Synced · ${status.indexed_height.toLocaleString()}`
      : status
        ? `${status.lag.toLocaleString()} blocks behind`
        : 'Connecting';
  return (
    <span className={`status-badge ${state}`} title={error}>
      <i /> {label}
    </span>
  );
}

function EmptyHome({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <main className="landing">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow"><span /> CORE-COMPATIBLE · SELF-CUSTODY</p>
          <h1>Your TensorCash,<br /><em>without the sync.</em></h1>
          <p className="hero-lead">
            A modern TensorCash wallet that opens instantly. Create a Core/Qt-compatible wallet or import an existing wallet.dat;
            your browser protects the key while
            a synchronized node supplies public chain data and relays only transactions you signed.
          </p>
          <div className="hero-actions">
            <button className="button primary" onClick={onCreate}>Create wallet <span>↗</span></button>
            <button className="button secondary" onClick={onImport}>Import wallet</button>
          </div>
          <p className="hero-note"><span>✓</span> No account &nbsp;·&nbsp; No email &nbsp;·&nbsp; No server-side keys</p>
        </div>
        <div className="vault-visual" aria-hidden="true">
          <div className="vault-aura" />
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="vault-card rear"><span>ENCRYPTED LOCALLY</span></div>
          <div className="vault-card front">
            <div className="vault-scan" />
            <div className="vault-top"><span>QT / CORE COMPATIBLE</span><b>●</b></div>
            <div className="key-glyph"><i /><i /><i /></div>
            <div className="vault-lines"><span /><span /><span /></div>
            <small>PRIVATE KEY NEVER LEAVES THIS DEVICE</small>
          </div>
        </div>
      </section>

      <section className="trust-strip">
        <div><b>01</b><span><strong>Keys stay local</strong>Create or open a Qt-compatible wallet.dat entirely in this browser.</span></div>
        <div><b>02</b><span><strong>Encrypt at rest</strong>Argon2id and AES-256-GCM protect the local wallet.</span></div>
        <div><b>03</b><span><strong>Read the chain</strong>A replaceable gateway returns balance and history.</span></div>
        <div><b>04</b><span><strong>Sign, then relay</strong>Only a finished signed transaction reaches the server.</span></div>
      </section>

      <section className="disclosure">
        <div>
          <p className="eyebrow">THE IMPORTANT PART</p>
          <h2>No one else can recover this wallet.</h2>
        </div>
        <p>
          TensorCash Wallet stores no user profile, password, private key, backup, or recovery code on a server.
          Make an encrypted backup immediately. There is no 12-word seed phrase. Losing both browser data and that backup permanently loses access.
        </p>
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">Review the source ↗</a>
      </section>
    </main>
  );
}

function ToolsMenu({ onView, sendEnabled }: { onView: (view: View) => void; sendEnabled: boolean }) {
  const items: Array<[View, string, ReactNode, string]> = [
    ['receive', 'Receive', <ReceiveToolIcon />, 'Address and derivation'],
    ['send', 'Send', <SendToolIcon />, 'Prepare a transfer'],
    ['activity', 'Transactions', <TransactionsToolIcon />, 'Complete wallet history'],
    ['settings', 'Settings', <SettingsToolIcon />, 'Security, backup and gateway'],
  ];
  return (
    <section className="content-card tools-bar" aria-label="Wallet tools">
      <header className="tools-bar-heading">
        <div><p className="eyebrow">WALLET ACTIONS</p><h2>Tools</h2></div>
        <span>Every private-key action stays on this device</span>
      </header>
      <div className="tools-bar-grid">
        {items.map(([id, label, icon, description]) => (
          <button key={id} onClick={() => onView(id)} disabled={id === 'send' && !sendEnabled} title={id === 'send' && !sendEnabled ? 'This post-quantum wallet is receive/watch-only in v1.0.1' : undefined}>
            <span className="tool-icon">{icon}</span>
            <span><strong>{label}</strong><small>{id === 'send' && !sendEnabled ? 'Receive/watch-only · signing unavailable' : description}</small></span>
            <b>→</b>
          </button>
        ))}
      </div>
    </section>
  );
}

type TransactionFilter = 'all' | 'pending' | 'confirmed';

function isPendingTransaction(transaction: AddressTransaction) {
  return transaction.status === 'pending' || transaction.block_height === null;
}

function filterTransactions(transactions: AddressTransaction[], filter: TransactionFilter) {
  if (filter === 'all') return transactions;
  return transactions.filter((transaction) => filter === 'pending'
    ? isPendingTransaction(transaction)
    : !isPendingTransaction(transaction));
}

function userFacingTransactionDelta(transaction: AddressTransaction): number {
  if (transaction.delta_sats >= 0) return transaction.delta_sats;
  const transfer = transaction.transfer_sats
    ?? Math.max(0, transaction.sent_sats - transaction.received_sats - (transaction.fee_sats ?? 0));
  return -transfer;
}

function TransactionFilters({ transactions, filter, onChange, compact = false }: {
  transactions: AddressTransaction[];
  filter: TransactionFilter;
  onChange: (filter: TransactionFilter) => void;
  compact?: boolean;
}) {
  const pendingCount = transactions.filter(isPendingTransaction).length;
  const confirmedCount = transactions.length - pendingCount;
  return (
    <div className={`transaction-filters${compact ? ' compact' : ''}`} role="group" aria-label="Filter wallet transactions">
      <button className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => onChange('all')}>All <span>{transactions.length}</span></button>
      <button className={filter === 'pending' ? 'active' : ''} aria-pressed={filter === 'pending'} onClick={() => onChange('pending')}>Pending <span>{pendingCount}</span></button>
      <button className={filter === 'confirmed' ? 'active' : ''} aria-pressed={filter === 'confirmed'} onClick={() => onChange('confirmed')}>Confirmed <span>{confirmedCount}</span></button>
    </div>
  );
}

function Overview({ vault, receiveAddressCount, summary, status, transactions, fundedAddresses, loading, showBackup, market, currencies, displayCurrency, onCopy, onBackup, onReceive, onView }: {
  vault: EncryptedVault;
  receiveAddressCount: number;
  summary: AddressSummary | null;
  status: ChainStatus | null;
  transactions: AddressTransaction[];
  fundedAddresses: WalletAddressBalance[];
  loading: boolean;
  showBackup: boolean;
  market: MarketSnapshot | null;
  currencies: CurrencySnapshot | null;
  displayCurrency: string;
  onCopy: (value: string) => void;
  onBackup: () => void;
  onReceive: () => void;
  onView: (view: View) => void;
}) {
  const receiveAddress = currentReceiveAddress(vault, receiveAddressCount);
  const unconfirmed = summary?.unconfirmed_balance_sats ?? 0;
  const pendingTransactions = transactions.filter(isPendingTransaction);
  const pendingDisplaySats = pendingTransactions.length
    ? pendingTransactions.reduce((total, transaction) => total + userFacingTransactionDelta(transaction), 0)
    : unconfirmed;
  const pendingMode = pendingDisplaySats > 0 ? 'incoming' : pendingDisplaySats < 0 ? 'outgoing' : '';
  const hasPending = Boolean(pendingMode);
  const totalBalance = summary ? summary.balance_sats + unconfirmed : null;
  const unitPrice = convertedTscPrice(market, currencies, displayCurrency);
  const convertedBalance = totalBalance !== null && unitPrice !== null
    ? totalBalance / TSC * unitPrice
    : null;
  const [transactionFilter, setTransactionFilter] = useState<TransactionFilter>('all');
  const recentTransactions = filterTransactions(transactions, transactionFilter).slice(0, 6);
  useEffect(() => setTransactionFilter('all'), [vault.walletId]);
  return (
    <div className="panel-stack enter">
      <section className={`balance-hero ${loading ? 'is-loading' : ''} ${hasPending ? `has-pending pending-${pendingMode}` : ''}`} aria-busy={loading}>
        {hasPending && <div className="pending-ambient" aria-hidden="true"><i /><i /><i /></div>}
        <div className="balance-primary">
          <p className="eyebrow light">ESTIMATED WALLET VALUE</p>
          <div className="balance-value-line">
            <h1 className={convertedBalance === null ? 'market-value-pending' : ''}>
              {convertedBalance === null
                ? <><span className="market-value-spinner" aria-hidden="true" /><span className="sr-only">Loading estimated wallet value</span></>
                : formatCurrency(convertedBalance, displayCurrency)}
            </h1>
            <div className={`market-valuation${market?.stale || currencies?.stale ? ' is-stale' : ''}`} role="status">
              <span className="market-valuation-rate">
                <small>{unitPrice === null ? 'Waiting for market data' : `1 TSC = ${formatCurrency(unitPrice, displayCurrency)}`}</small>
              </span>
              {(market?.stale || currencies?.stale) && <b>Price update delayed</b>}
            </div>
          </div>
          <div className="asset-balance-line">
            <span className="asset-balance-amount">
              <strong>{totalBalance === null ? '—' : formatTsc(totalBalance)}</strong>
              <small>TSC</small>
            </span>
            {hasPending && <em className={pendingMode}>
              {pendingDisplaySats > 0 ? '+' : '−'}{formatTsc(Math.abs(pendingDisplaySats))} TSC unconfirmed
            </em>}
          </div>
          <div className="address-pill">
            <span>{short(receiveAddress, 16, 14)}</span>
            <button onClick={() => onCopy(receiveAddress)}>Copy</button>
            <a href={explorerAddressUrl(receiveAddress)} target="_blank" rel="noreferrer">Open in tscscan.xyz <span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <div className="balance-actions">
          <button onClick={onReceive}>Receive</button>
          <button onClick={() => onView('addresses')}>Addresses <span>{fundedAddresses.length}</span></button>
          {showBackup && <button className="backup-reminder" onClick={onBackup}>Back up</button>}
        </div>
        {hasPending && <div className={`pending-activity ${pendingMode}`} role="status" aria-live="polite">
          <span className="pending-activity-signal"><i>{pendingMode === 'incoming' ? '↓' : '↑'}</i></span>
          <span className="pending-activity-copy">
            <small>{pendingMode === 'incoming' ? 'Incoming transfer pending' : 'Outgoing transfer pending'}</small>
            <strong>{pendingMode === 'incoming' ? '+' : '−'}{formatTsc(Math.abs(pendingDisplaySats))} TSC</strong>
          </span>
          <em>{pendingTransactions.length || 1} awaiting confirmation</em>
        </div>}
        <div className="balance-grid">
          <span><small>Total received</small><b>{formatTsc(summary?.received_sats)} TSC</b></span>
          <span><small>Total sent</small><b>{formatTsc(summary?.sent_sats)} TSC</b></span>
          <span><small>Transactions</small><b>{summary?.tx_count?.toLocaleString() ?? '—'}</b></span>
          <span><small>Chain height</small><b>{status?.indexed_height?.toLocaleString() ?? '—'}</b></span>
        </div>
      </section>
      <ToolsMenu onView={onView} sendEnabled={(vault.addresses ?? [vault.address]).some((address) => address.startsWith('tc1q'))} />
      <section className="content-card recent-transactions">
        <div className="card-heading"><div><p className="eyebrow">LATEST ACTIVITY</p><h2>Recent transactions</h2></div><span>{transactions.length ? `${transactions.length} recent records` : 'No activity yet'}</span></div>
        <TransactionFilters transactions={transactions} filter={transactionFilter} onChange={setTransactionFilter} compact />
        <div className="transaction-filter-results" key={transactionFilter}>
          {recentTransactions.length || (loading && !transactions.length)
            ? <TransactionTable transactions={recentTransactions} address={receiveAddress} loading={loading} />
            : <div className="empty-state compact"><span>◇</span><strong>No {transactionFilter} transactions</strong><p>New matching activity will appear here automatically.</p></div>}
        </div>
      </section>
    </div>
  );
}

function AddressBalancesPanel({ vault, receiveAddressCount, addresses, onCopy }: {
  vault: EncryptedVault;
  receiveAddressCount: number;
  addresses: WalletAddressBalance[];
  onCopy: (value: string) => void;
}) {
  const current = currentReceiveAddress(vault, receiveAddressCount);
  const receiveAddresses = vault.receiveAddresses?.length ? vault.receiveAddresses : issuedReceiveAddresses(vault, receiveAddressCount);
  const total = addresses.reduce((sum, item) => sum + item.balance_sats, 0);
  return (
    <section className="content-card funded-addresses enter">
      <div className="card-heading">
        <div><p className="eyebrow">WALLET BALANCES</p><h2>Funded addresses</h2></div>
        <span>{addresses.length} with confirmed balance</span>
      </div>
      <div className="funded-address-total">
        <span>Confirmed across these addresses</span>
        <strong>{formatTsc(total)} TSC</strong>
      </div>
      {addresses.length ? <div className="funded-address-list">
        {addresses.map((item) => {
          const receiveIndex = receiveAddresses.indexOf(item.address);
          const kind = item.address === current ? 'Current receive' : receiveIndex >= 0 ? `Receive #${receiveIndex}` : 'Internal change';
          const share = total > 0 ? item.balance_sats / total * 100 : 0;
          return <div key={item.address}>
            <span className="funded-address-icon">{kind === 'Internal change' ? '↩' : '↓'}</span>
            <span className="funded-address-main"><strong>{kind}</strong><code title={item.address}>{short(item.address, 15, 12)}</code></span>
            <span className="funded-address-value"><strong>{formatTsc(item.balance_sats)} TSC</strong><small>{share.toFixed(share < 1 ? 2 : 1)}% of wallet</small></span>
            <button onClick={() => onCopy(item.address)}>Copy</button>
          </div>;
        })}
      </div> : <div className="empty-state compact"><span>◇</span><strong>No funded addresses</strong><p>Addresses with a confirmed balance will appear here.</p></div>}
      <p className="receive-footnote">This is a read-only view reconstructed from the wallet's authenticated public watch set. Private keys remain encrypted on this device.</p>
    </section>
  );
}

function ReceivePanel({ vault, receiveAddressCount, onCopy, onGenerate, onSelect, generating = false }: {
  vault: EncryptedVault;
  receiveAddressCount: number;
  onCopy: (value: string) => void;
  onGenerate: () => Promise<void>;
  onSelect: (address: string) => void;
  generating?: boolean;
}) {
  const addresses = issuedReceiveAddresses(vault, receiveAddressCount);
  const current = addresses[addresses.length - 1] ?? vault.address;
  const monitored = vault.addresses?.length ?? addresses.length;
  return (
    <div className="receive-layout enter">
      <section className="receive-primary">
        <div className="receive-intro">
          <div className="receive-orb" aria-hidden="true"><span>T</span></div>
          <div><p className="eyebrow light">CURRENT RECEIVE ADDRESS</p><h2>Ready to receive TSC</h2><p>Share the active address below. New addresses remain part of the same Qt-compatible wallet.</p></div>
        </div>
        <div className="receive-current-address">
          <span><small>Active address</small><b>Receive #{Math.max(0, addresses.length - 1)}</b></span>
          <code>{current}</code>
        </div>
        <div className="receive-actions">
          <button className="button primary receive-watch-button" onClick={() => onSelect(current)}>Wait for payment</button>
          <button className="button secondary" onClick={() => onCopy(current)}>Copy address</button>
          <a className="button secondary" href={explorerAddressUrl(current)} target="_blank" rel="noreferrer">Open in tscscan.xyz ↗</a>
          <button className="button secondary derive-button" onClick={() => void onGenerate()} disabled={generating} aria-busy={generating}>
            {generating && <span className="button-spinner" aria-hidden="true" />}
            <span>{generating ? 'Generating…' : 'Generate new address'}</span>
          </button>
        </div>
      </section>
      <section className="content-card receive-history">
        <div className="card-heading">
          <div><p className="eyebrow">DERIVATION HISTORY</p><h2>Receive addresses</h2></div>
          <span>{addresses.length} issued · {monitored} monitored</span>
        </div>
        <div className="receive-address-list">
          {[...addresses].reverse().map((address, reverseIndex) => {
            const index = addresses.length - reverseIndex - 1;
            return (
              <div className={address === current ? 'current' : ''} key={address}>
                <span className="receive-index">{index}</span>
                <span className="receive-address-main"><strong>{address === current ? 'Current receive address' : `Receive address #${index}`}</strong><code title={address}>{address}</code></span>
                <span className="receive-address-state">{address === current ? 'Active' : 'Previously issued'}</span>
                <span className="receive-row-actions"><button onClick={() => onCopy(address)}>Copy</button><button className="receive-use" onClick={() => onSelect(address)}>Use</button></span>
              </div>
            );
          })}
        </div>
        <p className="receive-footnote">The wallet privately monitors a 20-address lookahead on both the receive and change chains, so Qt-created payments and change can be discovered without running a local node.</p>
      </section>
    </div>
  );
}

type ReceiveWatchPhase = 'waiting' | 'pending' | 'confirmed';

function incomingPayments(transactions: AddressTransaction[], baseline: Set<string>, openedAt: number) {
  const incoming = transactions.filter((transaction) => transaction.received_sats > 0 && transaction.delta_sats > 0);
  return incoming.filter((transaction) => !baseline.has(transaction.txid) && (isPendingTransaction(transaction) || transaction.timestamp >= openedAt - 2));
}

function TransactionParties({ parties, empty }: {
  parties: AddressTransaction['input_addresses'];
  empty: string;
}) {
  if (!parties?.length) return <>{empty}</>;
  return <>{parties.map((party, index) => <span className="transaction-party" key={`${party.address}-${index}`}>
    <a href={explorerAddressUrl(party.address)} target="_blank" rel="noreferrer" title={party.address}>{short(party.address, 14, 10)}</a>
    {index < parties.length - 1 ? <i aria-hidden="true">, </i> : null}
  </span>)}</>;
}

function ReceiveWatchModal({ address, onClose, onCopy }: { address: string; onClose: () => void; onCopy: (value: string) => void }) {
  const openedAt = useRef(Math.floor(Date.now() / 1000));
  const baseline = useRef<Set<string> | null>(null);
  const tracked = useRef(new Map<string, AddressTransaction>());
  const [phase, setPhase] = useState<ReceiveWatchPhase>('waiting');
  const [payments, setPayments] = useState<AddressTransaction[]>([]);
  const [height, setHeight] = useState<number | null>(null);
  const [connection, setConnection] = useState<'connected' | 'retrying'>('connected');

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | undefined;
    const poll = async () => {
      try {
        const account = await getWalletOverview([address], 1, true);
        if (stopped) return;
        setConnection('connected');
        setHeight(account.status.indexed_height);
        const received = account.transactions.filter((transaction) => transaction.received_sats > 0 && transaction.delta_sats > 0);
        if (!baseline.current) {
          baseline.current = new Set(received.filter((transaction) => !isPendingTransaction(transaction) && transaction.timestamp < openedAt.current - 2).map((transaction) => transaction.txid));
        }
        incomingPayments(account.transactions, baseline.current, openedAt.current).forEach((transaction) => {
          tracked.current.set(transaction.txid, transaction);
        });
        const next = [...tracked.current.values()]
          .sort((left, right) => right.timestamp - left.timestamp || left.txid.localeCompare(right.txid));
        setPayments(next);
        setPhase(next.length === 0 ? 'waiting' : next.some(isPendingTransaction) ? 'pending' : 'confirmed');
      } catch {
        if (!stopped) setConnection('retrying');
      } finally {
        if (!stopped) pollTimer = window.setTimeout(poll, 2_500);
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(pollTimer);
    };
  }, [address]);

  return <div className={`receive-monitor-backdrop phase-${phase}`} role="presentation">
    <section className="receive-monitor" role="dialog" aria-modal="true" aria-labelledby="receive-monitor-title">
      <button className="receive-monitor-close" aria-label="Close payment monitor" onClick={onClose}>×</button>
      <div className={`receive-monitor-state ${phase}`} aria-hidden="true">
        <span className="monitor-symbol"><ReceiveToolIcon /></span>
        <svg className="monitor-check" viewBox="0 0 32 32"><path d="m8 16.5 5.2 5.2L24.5 10" /></svg>
      </div>
      <p className="eyebrow">{phase === 'waiting' ? 'READY TO RECEIVE' : phase === 'pending' ? 'MEMPOOL DETECTED' : 'PAYMENT CONFIRMED'}</p>
      <h2 id="receive-monitor-title">{phase === 'waiting' ? 'Waiting for payment' : phase === 'pending' ? `${payments.length} payment${payments.length === 1 ? '' : 's'} detected` : `${payments.length} payment${payments.length === 1 ? '' : 's'} received`}</h2>
      <p className="receive-monitor-lead">{phase === 'waiting' ? 'Keep this window open. The wallet checks the latest mempool and confirmed blocks automatically.' : phase === 'pending' ? 'New payments keep appearing here while this window remains open. Pending entries update individually after confirmation.' : 'All detected payments are confirmed. This monitor stays active for additional transfers until you close it.'}</p>
      <div className="receive-monitor-address"><span>Receive address</span><code>{address}</code><button onClick={() => onCopy(address)}>Copy</button></div>
      {payments.length > 0 && <div className="receive-monitor-payments" aria-label="Payments detected in this session">
        {payments.map((payment) => <article className={isPendingTransaction(payment) ? 'pending' : 'confirmed'} key={payment.txid}>
          <header><span><small>Amount received</small><strong>+{formatTsc(payment.received_sats)} TSC</strong></span><em><i />{isPendingTransaction(payment) ? 'Pending' : 'Confirmed'}</em></header>
          <dl>
            <div><dt>From</dt><dd><TransactionParties parties={payment.from_addresses} empty="Source address unavailable" /></dd></div>
            <div><dt>To</dt><dd><a href={explorerAddressUrl(address)} target="_blank" rel="noreferrer" title={address}>{short(address, 14, 10)}</a></dd></div>
            <div><dt>Transaction</dt><dd><a href={explorerTransactionUrl(payment.txid)} target="_blank" rel="noreferrer" title={payment.txid}>{short(payment.txid, 14, 10)} ↗</a></dd></div>
          </dl>
        </article>)}
      </div>}
      <div className="receive-monitor-footer"><span className={connection}><i />{connection === 'connected' ? `Live · block ${height?.toLocaleString() ?? '—'}` : 'Connection interrupted · retrying'}</span><a href={explorerAddressUrl(address)} target="_blank" rel="noreferrer">Open in tscscan.xyz ↗</a></div>
    </section>
  </div>;
}

function SendWatchModal({ transaction, addresses, onClose }: {
  transaction: AddressTransaction;
  addresses: string[];
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<'pending' | 'confirmed'>('pending');
  const [trackedTransaction, setTrackedTransaction] = useState(transaction);
  const [height, setHeight] = useState<number | null>(null);
  const [connection, setConnection] = useState<'connected' | 'retrying'>('connected');
  const amountSats = trackedTransaction.transfer_sats
    ?? transaction.transfer_sats
    ?? Math.max(0, trackedTransaction.sent_sats - trackedTransaction.received_sats - (trackedTransaction.fee_sats ?? 0));
  const inputAddresses = trackedTransaction.input_addresses?.length
    ? trackedTransaction.input_addresses
    : transaction.input_addresses;
  const recipientAddresses = trackedTransaction.to_addresses?.length
    ? trackedTransaction.to_addresses
    : transaction.to_addresses?.length
      ? transaction.to_addresses
      : trackedTransaction.output_addresses;

  useEffect(() => {
    let stopped = false;
    let completed = false;
    let pollTimer: number | undefined;
    const poll = async () => {
      try {
        const account = await getWalletOverview(addresses, 1, true);
        if (stopped) return;
        setConnection('connected');
        setHeight(account.status.indexed_height);
        const remote = account.transactions.find((item) => item.txid === transaction.txid);
        if (remote) {
          setTrackedTransaction({
            ...transaction,
            ...remote,
            transfer_sats: transaction.transfer_sats ?? remote.transfer_sats,
            input_addresses: remote.input_addresses?.length ? remote.input_addresses : transaction.input_addresses,
            output_addresses: remote.output_addresses?.length ? remote.output_addresses : transaction.output_addresses,
            from_addresses: remote.from_addresses?.length ? remote.from_addresses : transaction.from_addresses,
            to_addresses: remote.to_addresses?.length ? remote.to_addresses : transaction.to_addresses,
          });
        }
        if (remote && !isPendingTransaction(remote)) {
          setPhase('confirmed');
          completed = true;
        }
      } catch {
        if (!stopped) setConnection('retrying');
      } finally {
        if (!stopped && !completed) pollTimer = window.setTimeout(poll, 2_500);
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(pollTimer);
    };
  }, [addresses, transaction.txid]);

  return <div className={`receive-monitor-backdrop send-monitor-backdrop phase-${phase}`} role="presentation">
    <section className="receive-monitor send-monitor" role="dialog" aria-modal="true" aria-labelledby="send-monitor-title">
      <button className="receive-monitor-close" aria-label="Close transaction monitor" onClick={onClose}>×</button>
      <div className={`receive-monitor-state ${phase}`} aria-hidden="true">
        <span className="monitor-symbol"><LiveSendIcon /></span>
        <svg className="monitor-check" viewBox="0 0 32 32"><path d="m8 16.5 5.2 5.2L24.5 10" /></svg>
      </div>
      <p className="eyebrow">{phase === 'pending' ? 'TRANSACTION BROADCAST' : 'SEND CONFIRMED'}</p>
      <h2 id="send-monitor-title">{phase === 'pending' ? 'Waiting for confirmation' : 'TSC sent'}</h2>
      <p className="receive-monitor-lead">{phase === 'pending' ? 'The signed transaction was accepted and is being tracked in the TensorCash mempool. Keep this window open for live confirmation.' : 'The transfer has entered the confirmed chain. Close this window whenever you are ready.'}</p>
      <div className="receive-monitor-payment send-monitor-payment">
        <span><small>Amount sent</small><strong>−{formatTsc(amountSats)} TSC</strong></span>
        <a href={explorerTransactionUrl(transaction.txid)} target="_blank" rel="noreferrer"><small>Transaction</small><strong>{short(transaction.txid, 15, 12)} ↗</strong></a>
      </div>
      <dl className="send-monitor-route">
        <div><dt>From</dt><dd><TransactionParties parties={inputAddresses} empty="Wallet input address unavailable" /></dd></div>
        <div><dt>To</dt><dd><TransactionParties parties={recipientAddresses} empty="Recipient address unavailable" /></dd></div>
      </dl>
      <div className="receive-monitor-footer"><span className={connection}><i />{connection === 'connected' ? `Live · block ${height?.toLocaleString() ?? '—'}` : 'Connection interrupted · retrying'}</span><a href={explorerTransactionUrl(transaction.txid)} target="_blank" rel="noreferrer">Open in tscscan.xyz ↗</a></div>
    </section>
  </div>;
}

function TransactionTable({ transactions, address, loading = false }: { transactions: AddressTransaction[]; address: string; loading?: boolean }) {
  if (loading && !transactions.length) {
    return <div className="transaction-list transaction-skeleton" aria-label="Loading transactions">{[0, 1, 2].map((item) => <div className="transaction-row" key={item}><i /><span /><span /><span /></div>)}</div>;
  }
  if (!transactions.length) {
    return <div className="empty-state"><span>◇</span><strong>No wallet transactions</strong><p>Confirmed and unconfirmed activity for {short(address)} will appear here.</p></div>;
  }
  const pendingAnimationDelay = `${-(Date.now() % 3000)}ms`;
  return (
    <div className="transaction-list">
      {transactions.map((transaction) => {
        const pending = transaction.status === 'pending' || transaction.block_height === null;
        const displayDelta = pending ? userFacingTransactionDelta(transaction) : transaction.delta_sats;
        const received = displayDelta >= 0;
        const counterparties = received ? transaction.from_addresses ?? [] : transaction.to_addresses ?? [];
        const counterparty = counterparties[0];
        const counterpartyLabel = transaction.is_coinbase ? 'Source' : received ? 'From' : 'To';
        return (
          <div className={`transaction-row ${pending ? 'pending' : ''}`} key={transaction.txid} style={pending ? { '--tx-pending-delay': pendingAnimationDelay } as CSSProperties : undefined}>
            <span className={`tx-icon ${received ? 'received' : 'sent'}`} aria-hidden="true">
              {received ? <ReceiveToolIcon /> : <SendToolIcon />}
            </span>
            <div className="tx-main">
              <div className="tx-title"><strong>{received ? (transaction.is_coinbase ? 'Block reward' : 'Received') : 'Sent'}</strong>{pending && <span className="tx-pending-badge"><i /> Pending</span>}</div>
              <div className="tx-counterparty"><small>{counterpartyLabel}</small>{transaction.is_coinbase
                ? <span>TensorCash block subsidy</span>
                : counterparty
                  ? <><a href={explorerAddressUrl(counterparty.address)} target="_blank" rel="noreferrer" title={counterparty.address}>{short(counterparty.address, 14, 10)}</a>{counterparties.length > 1 && <em>+{counterparties.length - 1}</em>}</>
                  : <span>{received ? 'Sender address unavailable' : 'Recipient address unavailable'}</span>}</div>
              <a className="tx-id" href={explorerTransactionUrl(transaction.txid)} target="_blank" rel="noreferrer" title={`View ${transaction.txid} on TSC Scan`}>{short(transaction.txid, 12, 10)} <span aria-hidden="true">↗</span></a>
            </div>
            <div className={`tx-block ${pending ? 'is-pending' : ''}`}><small>{pending ? 'Status' : 'Block'}</small><span>{pending && <i />}{pending ? 'Unconfirmed' : transaction.block_height?.toLocaleString()}</span></div>
            <div className={`tx-value ${received ? 'received' : 'sent'}`}><strong>{received ? '+' : '−'}{formatTsc(Math.abs(displayDelta))} TSC</strong><small>{relativeTime(transaction.timestamp)}</small></div>
          </div>
        );
      })}
    </div>
  );
}

function Activity({ transactions, address }: { transactions: AddressTransaction[]; address: string }) {
  const [filter, setFilter] = useState<TransactionFilter>('all');
  const filtered = filterTransactions(transactions, filter);
  return <section className="content-card activity-card enter">
    <div className="card-heading"><div><p className="eyebrow">CONFIRMED + MEMPOOL</p><h2>Wallet transactions</h2></div><span>{transactions.length} recent records</span></div>
    <TransactionFilters transactions={transactions} filter={filter} onChange={setFilter} />
    <div className="transaction-filter-results" key={filter}>
      {filtered.length
        ? <TransactionTable transactions={filtered} address={address} />
        : <div className="empty-state compact"><span>◇</span><strong>No {filter} transactions</strong><p>New matching activity will appear here automatically.</p></div>}
    </div>
  </section>;
}

function ToolDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const closeTimer = useRef<number | undefined>(undefined);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => onCloseRef.current(), 260);
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(closeTimer.current);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [requestClose]);

  return (
    <div className={`tool-drawer-backdrop ${closing ? 'is-closing' : ''}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <aside className="tool-drawer" role="dialog" aria-modal="true" aria-labelledby="tool-drawer-title">
        <header className="tool-drawer-head">
          <div><p>WALLET TOOL</p><h2 id="tool-drawer-title">{title}</h2></div>
          <button aria-label="Close wallet tool" onClick={requestClose}>×</button>
        </header>
        <div className="tool-drawer-body">{children}</div>
      </aside>
    </div>
  );
}

function WalletSwitcher({ wallets, active, switching, onSwitch, onManage }: {
  wallets: EncryptedVault[];
  active: EncryptedVault;
  switching: boolean;
  onSwitch: (walletId: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [active.walletId]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return <div className={`wallet-switcher-group ${open ? 'is-open' : ''}`} ref={root}>
    <div className="wallet-switcher">
      <button className="wallet-switcher-trigger" type="button" disabled={switching} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="wallet-switcher-icon"><WalletSwitchIcon /></span>
        <span className="wallet-switcher-current"><strong>{walletLabel(active)}</strong><small>{short(active.address, 9, 6)}</small></span>
        {switching ? <i className="button-spinner dark" /> : <i className="wallet-switcher-chevron" aria-hidden="true">⌄</i>}
      </button>
      {open && <div className="wallet-switcher-options" role="listbox" aria-label="Active wallet">
        <header><span>Switch wallet</span><small>{wallets.length} encrypted locally</small></header>
        <div>
          {wallets.map((item) => <button type="button" role="option" aria-selected={item.walletId === active.walletId} className={item.walletId === active.walletId ? 'selected' : ''} key={item.walletId} onClick={() => {
            setOpen(false);
            onSwitch(item.walletId);
          }}>
            <span className="wallet-option-mark">{item.walletId === active.walletId ? '✓' : <WalletSwitchIcon />}</span>
            <span><strong>{walletLabel(item)}</strong><code>{short(item.address, 13, 9)}</code></span>
            <small>{item.walletId === active.walletId ? 'Active' : vaultFingerprint(item)}</small>
          </button>)}
        </div>
      </div>}
    </div>
    <button className="wallet-manage-button" aria-label="Manage wallets" onClick={() => { setOpen(false); onManage(); }}><ManageWalletsIcon /><b>Manage</b></button>
  </div>;
}

function WalletsPanel({ wallets, activeId, switching, onSwitch, onCreate, onImport }: {
  wallets: EncryptedVault[];
  activeId: string;
  switching: boolean;
  onSwitch: (walletId: string) => void;
  onCreate: () => void;
  onImport: () => void;
}) {
  return <section className="content-card wallets-panel enter">
    <div className="card-heading"><div><p className="eyebrow">LOCAL ENCRYPTED WALLETS</p><h2>Your wallets</h2></div><span>{wallets.length} on this device</span></div>
    <div className="wallet-list">{wallets.map((item) => <button className={item.walletId === activeId ? 'active' : ''} disabled={switching} key={item.walletId} onClick={() => onSwitch(item.walletId)}><span className="wallet-avatar">T</span><span><strong>{walletLabel(item)}</strong><small>{short(item.address, 13, 10)} · {vaultFingerprint(item)} · {new Date(item.createdAt).toLocaleDateString()}</small></span>{item.walletId === activeId ? <b>Current</b> : <b>Switch →</b>}</button>)}</div>
    <div className="wallet-add-actions"><button className="button primary" onClick={onCreate}>Create another wallet</button><button className="button secondary" onClick={onImport}>Import wallet</button></div>
    <p className="receive-footnote">Each wallet is encrypted independently in this browser. Switching never sends a password or private key to the gateway.</p>
  </section>;
}

type ChangeAddressOption = {
  address: string;
  label: string;
  balanceSats?: number;
};

function ChangeAddressPicker({ value, options, disabled, onChange }: {
  value: string;
  options: ChangeAddressOption[];
  disabled: boolean;
  onChange: (address: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.address === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return <div className={`change-address-picker ${open ? 'is-open' : ''}`} ref={root}>
    <button className="change-address-trigger" type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span className="change-address-symbol">↩</span>
      <span className="change-address-selection"><strong>{selected?.label ?? 'Select address'}</strong><code>{selected?.address === FRESH_CHANGE_ADDRESS ? 'Generated only when signing' : selected ? short(selected.address, 13, 11) : '—'}</code></span>
      {selected?.balanceSats !== undefined && <small>{formatTsc(selected.balanceSats)} TSC</small>}
      <i aria-hidden="true">⌄</i>
    </button>
    {open && <div className="change-address-options" role="listbox" aria-label="Wallet-owned change address">
      <div className="change-address-options-head"><span>Return change to</span><small>{options.length} wallet-owned addresses</small></div>
      <div className="change-address-options-scroll">
        {options.map((option) => <button type="button" role="option" aria-selected={option.address === value} className={option.address === value ? 'selected' : ''} key={option.address} onClick={() => { onChange(option.address); setOpen(false); }}>
          <span className="change-option-check">{option.address === value ? '✓' : ''}</span>
          <span><strong>{option.label}</strong><code>{option.address === FRESH_CHANGE_ADDRESS ? 'Generated only when signing' : short(option.address, 16, 13)}</code></span>
          <small>{option.balanceSats === undefined ? 'No current balance' : `${formatTsc(option.balanceSats)} TSC`}</small>
        </button>)}
      </div>
    </div>}
  </div>;
}

function SendPanel({ vault, wallets, passkeyState, receiveAddressCount, fundedAddresses, onSent, onVaultUpdated }: {
  vault: EncryptedVault;
  wallets: EncryptedVault[];
  passkeyState: WalletPasskeyState | null;
  receiveAddressCount: number;
  fundedAddresses: WalletAddressBalance[];
  onSent: (transaction: AddressTransaction, walletAddresses: string[]) => Promise<void>;
  onVaultUpdated?: (vault: EncryptedVault) => void;
}) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [password, setPassword] = useState('');
  const [authMethod, setAuthMethod] = useState<'passkey' | 'password'>(passkeyState ? 'passkey' : 'password');
  const [plan, setPlan] = useState<TransactionPlan | null>(null);
  const [reviewUtxos, setReviewUtxos] = useState<WalletUtxo[]>([]);
  const [busy, setBusy] = useState<'review' | 'send' | ''>('');
  const [error, setError] = useState('');
  const [txid, setTxid] = useState('');
  const [spendable, setSpendable] = useState<{ balanceSats: number; feeRateSatVb: number; maximum: { amountSats: number; feeSats: number; inputCount: number } | null; unsupportedValueSats: number } | null>(null);
  const [spendableLoading, setSpendableLoading] = useState(true);
  const [maxLoading, setMaxLoading] = useState(false);
  const [highFeeConfirmed, setHighFeeConfirmed] = useState(false);
  const localRecipient = useMemo(() => localWalletAddressOwner(recipient, wallets), [recipient, wallets]);
  // receiveAddressCount is mutable UI state stored separately from the
  // authenticated encrypted envelope. Never clone it into `vault` before
  // decrypting: that changes AES-GCM additional data and rejects a valid password.
  const sendCapable = (vault.addresses ?? [vault.address]).some((address) => address.startsWith('tc1q'));
  const defaultChangeAddress = currentReceiveAddress(vault, receiveAddressCount);
  const [changeAddress, setChangeAddress] = useState(FRESH_CHANGE_ADDRESS);
  const issuedAddresses = issuedReceiveAddresses(vault, receiveAddressCount);
  const ownedP2wpkhAddresses = [...new Set(vault.addresses?.filter((address) => address.startsWith('tc1q')) ?? [vault.address])];
  const walletAddresses = vault.addresses?.length ? vault.addresses : [vault.address];
  const walletAddressKey = walletAddresses.join('|');
  const fundedByAddress = new Map(fundedAddresses.map((item) => [item.address, item.balance_sats]));
  const confirmedWalletBalanceSats = fundedAddresses.reduce((sum, item) => sum + item.balance_sats, 0);
  const changeOptions = [FRESH_CHANGE_ADDRESS, defaultChangeAddress, ...fundedAddresses.map((item) => item.address), ...issuedAddresses, ...ownedP2wpkhAddresses]
    .filter((address, index, items) => address.startsWith('tc1q') && items.indexOf(address) === index);
  const changeAddressOptions: ChangeAddressOption[] = [{
    address: FRESH_CHANGE_ADDRESS,
    label: 'Fresh internal address · recommended',
  }, ...changeOptions.map((address) => ({
    address,
    label: address === defaultChangeAddress
      ? 'Current receive · default'
      : fundedByAddress.has(address)
        ? 'Funded wallet address'
        : issuedAddresses.includes(address) ? 'Receive address' : 'Internal change address',
    balanceSats: fundedByAddress.get(address),
  }))];

  const loadSpendable = useCallback(async () => {
    setSpendableLoading(true);
    try {
      const [coins, fees] = await Promise.all([getWalletUtxos(walletAddresses), getFeeEstimate()]);
      if (!coins.status.synced) throw new Error('The selected gateway is not synchronized. Sending is paused for safety.');
      const feeRateSatVb = feeRateFromTscPerKvb(fees.fee_rate_tsc_per_kvb);
      const partition = partitionP2wpkhUtxos(coins.utxos);
      const balanceSats = partition.spendable.reduce((sum, coin) => sum + coin.value_sats, 0);
      let maximum: { amountSats: number; feeSats: number; inputCount: number } | null = null;
      try {
        maximum = maximumP2wpkhSendAmount(coins.utxos, feeRateSatVb);
      } catch {
        maximum = null;
      }
      const next = { balanceSats, feeRateSatVb, maximum, unsupportedValueSats: partition.unsupportedValueSats };
      setSpendable(next);
      return next;
    } finally {
      setSpendableLoading(false);
    }
  }, [walletAddressKey]);

  useEffect(() => {
    setChangeAddress(FRESH_CHANGE_ADDRESS);
    setPlan(null);
    setHighFeeConfirmed(false);
    setPassword('');
    setAuthMethod(passkeyState ? 'passkey' : 'password');
  }, [vault.walletId, receiveAddressCount, passkeyState]);

  useEffect(() => {
    let active = true;
    void loadSpendable().catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Unable to load spendable balance');
    });
    return () => { active = false; };
  }, [loadSpendable]);

  async function useMaximumAmount() {
    if (busy || maxLoading) return;
    setMaxLoading(true);
    setError('');
    try {
      const current = spendable ?? await loadSpendable();
      if (!current.maximum) throw new Error('No confirmed spendable balance remains after the network fee');
      setAmount(formatTscInput(current.maximum.amountSats));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to calculate the maximum amount');
    } finally {
      setMaxLoading(false);
    }
  }

  async function review(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy('review');
    setError('');
    try {
      const amountSats = parseTscAmount(amount);
      const addresses = walletAddresses;
      const selectedChangeAddress = changeAddress === FRESH_CHANGE_ADDRESS
        ? currentReceiveAddress(vault, receiveAddressCount)
        : checkedWalletChangeAddress(changeAddress, addresses);
      const [coins, fees] = await Promise.all([getWalletUtxos(addresses), getFeeEstimate()]);
      if (!coins.status.synced) throw new Error('The selected gateway is not synchronized. Sending is paused for safety.');
      const feeRate = feeRateFromTscPerKvb(fees.fee_rate_tsc_per_kvb);
      const partition = partitionP2wpkhUtxos(coins.utxos);
      const balanceSats = partition.spendable.reduce((sum, coin) => sum + coin.value_sats, 0);
      let maximum = null;
      try { maximum = maximumP2wpkhSendAmount(coins.utxos, feeRate); } catch { maximum = null; }
      setSpendable({ balanceSats, feeRateSatVb: feeRate, maximum, unsupportedValueSats: partition.unsupportedValueSats });
      const next = planP2wpkhTransaction(
        coins.utxos,
        recipient,
        amountSats,
        selectedChangeAddress,
        feeRate,
        coins.status.indexed_height,
      );
      setReviewUtxos(partition.spendable);
      setRecipient(next.recipient);
      setPlan(next);
      setHighFeeConfirmed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to prepare this transaction');
    } finally {
      setBusy('');
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!plan || busy) return;
    setBusy('send');
    setError('');
    try {
      // Password KDF and local signing can occupy the main thread. Give React
      // two frames to commit and paint the spinner before that work begins.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      const walletPassword = authMethod === 'passkey' && passkeyState
        ? await unlockPasswordWithPasskey(passkeyState)
        : password;
      const unlocked = await decryptWallet(vault, walletPassword);
      if (unlocked.key.algorithm !== 'CORE-DESCRIPTOR' || !('qt' in unlocked)) {
        throw new Error('This wallet key type cannot sign standard TSC transfers yet');
      }
      let coreMaterial = hydrateQtAddressState(unlocked as CoreWalletMaterial);
      const addresses = coreMaterial.qt.addresses.length ? coreMaterial.qt.addresses : [coreMaterial.address];
      const freshCoins = await getWalletUtxos(addresses);
      if (!freshCoins.status.synced) throw new Error('The selected gateway is not synchronized. Sending is paused for safety.');
      let selectedChangeAddress: string;
      if (changeAddress === FRESH_CHANGE_ADDRESS) {
        if (plan.changeSats > 0) {
          const reservation = await reserveQtChangeAddress(coreMaterial);
          coreMaterial = reservation.material;
          selectedChangeAddress = reservation.address;
          const updatedVault = await encryptWallet(coreMaterial, walletPassword, { allowLegacyPassword: true }, vault.walletName);
          await saveVault(updatedVault);
          onVaultUpdated?.(updatedVault);
          setChangeAddress(reservation.address);
        } else {
          // The planner requires a valid wallet-owned script even when the
          // selected inputs produce no change output. Do not consume an
          // internal descriptor index in that case.
          selectedChangeAddress = currentReceiveAddress(vault, receiveAddressCount);
        }
      } else {
        selectedChangeAddress = checkedWalletChangeAddress(changeAddress, addresses);
      }
      const finalPlan = planP2wpkhTransaction(
        freshCoins.utxos,
        plan.recipient,
        plan.amountSats,
        selectedChangeAddress,
        plan.feeRateSatVb,
        freshCoins.status.indexed_height,
      );
      const reviewedInputs = plan.inputs.map((input) => `${input.txid}:${input.vout}`).join('|');
      const finalInputs = finalPlan.inputs.map((input) => `${input.txid}:${input.vout}`).join('|');
      if (finalPlan.feeSats !== plan.feeSats || finalInputs !== reviewedInputs) {
        setPlan(finalPlan);
        setReviewUtxos(partitionP2wpkhUtxos(freshCoins.utxos).spendable);
        setHighFeeConfirmed(false);
        throw new Error('Spendable inputs changed. Review the updated network fee and confirm again.');
      }
      if (finalPlan.amountSats !== plan.amountSats) {
        throw new Error('Final transaction does not match the reviewed amount and fee');
      }
      if (requiresHighFeeConfirmation(finalPlan) && !highFeeConfirmed) {
        throw new Error('Confirm the unusually high network fee before signing');
      }
      const keyResolver = createQtP2wpkhSpendKeyResolver(coreMaterial, finalPlan.inputs.map((input) => input.address));
      let signed;
      try {
        signed = signP2wpkhTransaction(finalPlan, keyResolver.resolve);
      } finally {
        keyResolver.destroy();
      }

      const preflight = await testSignedTransaction(signed.hex);
      if (!preflight.result.allowed) {
        throw new Error(preflight.result['reject-reason'] || 'TensorCash Core rejected the transaction');
      }
      if (!preflight.result.txid || preflight.result.txid.toLowerCase() !== signed.txid) {
        throw new Error('Core preflight transaction id does not match the locally signed transaction');
      }
      const broadcast = await broadcastSignedTransaction(signed.hex);
      if (broadcast.txid.toLowerCase() !== signed.txid) {
        throw new Error('Broadcast transaction id does not match the locally signed transaction');
      }
      const finalAddresses = coreMaterial.qt.addresses.length ? coreMaterial.qt.addresses : [coreMaterial.address];
      const pendingTransaction = createLocalPendingTransaction(signed.txid, finalPlan, finalAddresses);
      setTxid(signed.txid);
      setPassword('');
      await onSent(pendingTransaction, finalAddresses);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Transaction failed safely before broadcast');
    } finally {
      setPassword('');
      setBusy('');
    }
  }

  if (!sendCapable) return <section className="send-layout enter"><div className="content-card send-card send-unavailable"><p className="eyebrow">RECEIVE / WATCH ONLY</p><h2>Post-quantum signing is not available yet</h2><p>This imported ML-DSA wallet can receive TSC and monitor balances, but v1.0.1 cannot create an ML-DSA spend. No password is requested because this action is unsupported.</p></div></section>;

  if (txid) return (
    <section className="send-layout enter">
      <div className="content-card send-card send-success">
        <span className="send-success-mark">✓</span>
        <p className="eyebrow">BROADCAST ACCEPTED</p>
        <h2>Transaction sent</h2>
        <p>{formatTsc(plan?.amountSats)} TSC was signed locally and accepted by TensorCash Core.</p>
        <dl><div><dt>Transaction ID</dt><dd><a className="full-tx-link" href={explorerTransactionUrl(txid)} target="_blank" rel="noreferrer">{txid} <span aria-hidden="true">↗</span></a></dd></div><div><dt>Network fee</dt><dd>{formatTsc(plan?.feeSats)} TSC</dd></div></dl>
        <button className="button secondary" onClick={() => { setTxid(''); setPlan(null); setAmount(''); setRecipient(''); }}>Send another</button>
      </div>
    </section>
  );

  return (
    <section className="send-layout enter">
      <div className="content-card send-card">
        {plan && <div className="send-review-heading"><p className="eyebrow">FINAL CHECK</p><h2>Review and sign</h2></div>}
        {!plan ? <form className="send-compose-form" onSubmit={review} autoComplete="off">
          <div className="send-field"><span className="send-field-label">Recipient address</span><input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="tc1q…" autoComplete="off" data-1p-ignore="true" data-lpignore="true" spellCheck={false} disabled={Boolean(busy)} />{localRecipient && <div className="local-wallet-recipient" role="status"><span aria-hidden="true"><ManageWalletsIcon /></span><p><small>Local wallet address</small><strong>{walletLabel(localRecipient.wallet)} <code>({short(localRecipient.address, 8, 7)})</code></strong><em>This recipient belongs to a wallet stored on this device.</em></p></div>}</div>
          <div className="send-field amount-field">
            <div className="send-field-heading"><span className="send-field-label">Amount</span><small>{spendableLoading ? 'Loading spendable balance…' : `${formatTsc(spendable?.balanceSats)} TSC available`}</small></div>
            <div className="amount-input"><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" autoComplete="off" data-1p-ignore="true" data-lpignore="true" disabled={Boolean(busy)} /><button type="button" onClick={() => void useMaximumAmount()} disabled={Boolean(busy) || maxLoading || spendableLoading}>{maxLoading ? <span className="button-spinner dark" aria-hidden="true" /> : 'MAX'}</button><span>TSC</span></div>
            {spendable?.maximum && <small className="max-fee-note">MAX reserves an estimated {formatTsc(spendable.maximum.feeSats)} TSC network fee across {spendable.maximum.inputCount} UTXO{spendable.maximum.inputCount === 1 ? '' : 's'}.</small>}
            {spendable && Math.max(0, confirmedWalletBalanceSats - spendable.balanceSats - spendable.unsupportedValueSats) > 0 && <div className="pending-utxo-note"><span aria-hidden="true">◷</span><p><strong>{formatTsc(Math.max(0, confirmedWalletBalanceSats - spendable.balanceSats - spendable.unsupportedValueSats))} TSC is temporarily unavailable.</strong> A pending transaction has already committed its complete input UTXO. Any wallet change can be spent after that transaction confirms.</p></div>}
            {Boolean(spendable?.unsupportedValueSats) && <small className="unsupported-funds-note">{formatTsc(spendable?.unsupportedValueSats)} TSC is held in Taproot/post-quantum outputs that this wallet version cannot sign and is excluded from spendable funds.</small>}
          </div>
          <div className="send-field"><span className="send-field-label">Change address</span><ChangeAddressPicker value={changeAddress} options={changeAddressOptions} disabled={Boolean(busy)} onChange={(address) => { setChangeAddress(address); setPlan(null); }} /><small className="field-help">Only addresses controlled by this wallet are shown.</small></div>
          <div className="send-concepts" aria-label="Transaction terminology">
            <article><span>UTXO</span><div><strong>Coins are spent as complete outputs</strong><p>Your balance is made of separate unspent transaction outputs. The wallet selects enough UTXOs to cover the payment and network fee.</p></div></article>
            <article><span>CHANGE</span><div><strong>The remainder returns to your wallet</strong><p>If selected UTXOs exceed the amount and fee, the unused TSC is returned to the wallet-owned change address chosen above.</p></div></article>
          </div>
          <div className="fee-line"><span>Network fee</span><b>Calculated before signing</b></div>
          {error && <p className="send-error" role="alert">{error}</p>}
          <button className="button primary wide modal-submit" disabled={Boolean(busy)} aria-busy={busy === 'review'}>{busy === 'review' && <span className="button-spinner" aria-hidden="true" />}<span>{busy === 'review' ? 'Checking spendable funds…' : 'Review transaction'}</span></button>
        </form> : <form onSubmit={send} className="send-review" autoComplete="off">
          <dl className="transaction-review">
            <div><dt>Recipient</dt><dd title={plan.recipient}>{short(plan.recipient, 15, 13)}</dd></div>
            <div><dt>Amount</dt><dd>{formatTsc(plan.amountSats)} TSC</dd></div>
            <div><dt>Network fee</dt><dd>{formatTsc(plan.feeSats)} TSC <small>· {plan.feeRateSatVb} sat/vB</small></dd></div>
            <div><dt>Wallet inputs (UTXOs)</dt><dd>{plan.inputs.length} <small>· {formatTsc(reviewUtxos.reduce((sum, coin) => sum + coin.value_sats, 0))} TSC available</small></dd></div>
            <div><dt>Change returned</dt><dd>{formatTsc(plan.changeSats)} TSC</dd></div>
            <div><dt>Change address</dt><dd title={changeAddress === FRESH_CHANGE_ADDRESS ? 'Fresh internal address' : changeAddress}>{plan.changeSats ? (changeAddress === FRESH_CHANGE_ADDRESS ? 'Fresh internal address reserved at signing' : short(changeAddress, 15, 13)) : 'No change output'}</dd></div>
          </dl>
          {requiresHighFeeConfirmation(plan) && <label className="high-fee-confirm"><input type="checkbox" checked={highFeeConfirmed} onChange={(event) => setHighFeeConfirmed(event.target.checked)} /><span><strong>Confirm high network fee</strong><small>The {formatTsc(plan.feeSats)} TSC fee is more than 1% of this payment. The absolute safety ceiling still applies.</small></span></label>}
          {passkeyState && authMethod === 'passkey' ? <PasskeyAuthorization
            title="Authorize signing with Passkey"
            detail="Your device will verify you before the transaction is signed locally."
            disabled={Boolean(busy)}
            onUsePassword={() => { setAuthMethod('password'); setError(''); }}
          /> : <>
            <PasswordField label="Wallet password" value={password} onChange={setPassword} minLength={6} />
            {passkeyState && <button className="auth-method-switch" type="button" disabled={Boolean(busy)} onClick={() => { setAuthMethod('passkey'); setPassword(''); setError(''); }}>Use Passkey instead</button>}
          </>}
          <p className="send-confirm-note">Authentication and signing happen only on this device. Password fallback always remains available. The selected change address is rechecked as wallet-owned before broadcast.</p>
          {error && <p className="send-error" role="alert">{error}</p>}
          <div className="send-review-actions"><button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => { setPlan(null); setError(''); setPassword(''); setHighFeeConfirmed(false); }}>Edit</button><button className="button primary modal-submit" disabled={Boolean(busy) || (authMethod === 'password' && password.length < 6) || (requiresHighFeeConfirmation(plan) && !highFeeConfirmed)} aria-busy={busy === 'send'}>{busy === 'send' && <span className="button-spinner" aria-hidden="true" />}<span>{busy === 'send' ? 'Signing and verifying…' : authMethod === 'passkey' && passkeyState ? 'Continue with Passkey' : 'Sign and broadcast'}</span></button></div>
        </form>}
      </div>
    </section>
  );
}

function RecoveryPanel({ onBackup }: { onBackup: () => void }) {
  return (
    <div className="settings-section-stack">
      <section className="content-card settings-section recovery-section">
        <header className="settings-section-head"><span>02</span><div><p>Recovery</p><h2>Backup this wallet</h2></div></header>
        <p className="muted">There is no account reset or server copy. Keep the recovery backup in at least two independent places. Qt-compatible wallets retain their original file format.</p>
        <div className="warning-box"><strong>Never store the password beside the backup.</strong><span>Anyone with both can control the funds.</span></div>
        <button className="button primary settings-action" onClick={onBackup}>Export recovery backup</button>
      </section>
    </div>
  );
}

function WalletSecurityPanel({ passkeyState, onManage }: {
  passkeyState: WalletPasskeyState | null;
  onManage: () => void;
}) {
  return <div className="settings-section-stack enter">
    <section className="content-card settings-section wallet-security-section">
      <header className="settings-section-head"><span>01</span><div><p>Wallet access</p><h2>Passkey and password</h2></div></header>
      <div className={`passkey-status ${passkeyState ? 'enabled' : 'legacy'}`}><i aria-hidden="true">{passkeyState ? '✓' : '!'}</i><span><strong>{passkeyState ? 'Passkey enabled' : 'Password-only wallet'}</strong><small>{passkeyState ? 'Passkey appears first; the wallet password is always available as fallback.' : 'This wallet unlocks with its password. Passkey can be added after password verification.'}</small></span></div>
      <p className="muted">Review or change this wallet's local unlock methods in one focused window.</p>
      <button className="button primary settings-action" type="button" onClick={onManage}>Manage wallet access</button>
    </section>
  </div>;
}

function WalletSecurityModal({ wallets, initialWalletId, initialTab, passkeyStates, onClose, onChanged }: {
  wallets: EncryptedVault[];
  initialWalletId: string;
  initialTab: 'password' | 'passkey';
  passkeyStates: Record<string, WalletPasskeyState | null>;
  onClose: () => void;
  onChanged: (vault: EncryptedVault, passkeyState: WalletPasskeyState | null) => void;
}) {
  const [selectedWalletId, setSelectedWalletId] = useState(initialWalletId);
  const vault = wallets.find((wallet) => wallet.walletId === selectedWalletId) ?? wallets[0];
  const passkeyState = vault ? passkeyStates[vault.walletId] ?? null : null;
  const [tab, setTab] = useState<'password' | 'passkey'>(initialTab);
  const [enablePassword, setEnablePassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [keepPasskey, setKeepPasskey] = useState(Boolean(passkeyState));
  const [removeAuthMethod, setRemoveAuthMethod] = useState<'passkey' | 'password'>(() => passkeyState && !passkeyUnavailableReason() ? 'passkey' : 'password');
  const [busy, setBusy] = useState<'enable' | 'remove' | 'change' | ''>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const passkeyIssue = passkeyUnavailableReason();
  const localhostUrl = typeof location !== 'undefined' && (/^(?:127(?:\.\d{1,3}){3})$/.test(location.hostname) || location.hostname.includes(':'))
    ? (() => { const url = new URL(location.href); url.hostname = 'localhost'; return url.href; })()
    : null;

  useEffect(() => {
    setEnablePassword('');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setKeepPasskey(Boolean(passkeyState));
    setRemoveAuthMethod(passkeyState && !passkeyUnavailableReason() ? 'passkey' : 'password');
    setMessage('');
    setError('');
  }, [vault?.walletId]);

  if (!vault) return null;

  async function run(kind: 'enable' | 'remove' | 'change', action: () => Promise<void>) {
    if (busy) return;
    setBusy(kind);
    setError('');
    setMessage('');
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Wallet security update failed');
    } finally {
      setBusy('');
    }
  }

  function enable(event: FormEvent) {
    event.preventDefault();
    void run('enable', async () => {
      if (passkeyIssue) throw new Error(passkeyIssue);
      await decryptWallet(vault, enablePassword);
      const next = await createPasskeyState(vault, enablePassword);
      await savePasskeyState(next);
      setEnablePassword('');
      setKeepPasskey(true);
      onChanged(vault, next);
      setMessage('Passkey enabled. The original wallet password remains available everywhere.');
    });
  }

  function remove(event: FormEvent) {
    event.preventDefault();
    void run('remove', async () => {
      if (!passkeyState) throw new Error('This wallet does not have a Passkey to remove.');
      const verificationPassword = removeAuthMethod === 'passkey'
        ? await unlockPasswordWithPasskey(passkeyState)
        : enablePassword;
      await decryptWallet(vault, verificationPassword);
      await saveVaultAndPasskeyState(vault, null);
      setEnablePassword('');
      setKeepPasskey(false);
      onChanged(vault, null);
      setMessage('Passkey removed. This wallet now unlocks with its existing password only.');
    });
  }

  function changePassword(event: FormEvent) {
    event.preventDefault();
    void run('change', async () => {
      if (newPassword !== confirmPassword) throw new Error('New passwords do not match');
      const material = await decryptWallet(vault, currentPassword);
      const nextVault = await encryptWallet(material, newPassword, {}, vault.walletName);
      const nextPasskey = passkeyState && keepPasskey
        ? await rewrapPasskeyPassword(passkeyState, newPassword)
        : null;
      await saveVaultAndPasskeyState(nextVault, nextPasskey);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setKeepPasskey(Boolean(nextPasskey));
      onChanged(nextVault, nextPasskey);
      setMessage(nextPasskey
        ? 'Browser wallet password changed. Passkey and the new password can both unlock it.'
        : 'Browser wallet password changed. Password-only unlock is active.');
    });
  }

  return <div className="modal-backdrop wallet-security-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section className="modal wallet-security-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-security-title">
      <button className="modal-close" onClick={onClose} aria-label="Close wallet access settings" disabled={Boolean(busy)}>×</button>
      <p className="eyebrow">WALLET ACCESS</p>
      <h2 id="wallet-security-title">Manage wallet access</h2>
      <label className="security-wallet-picker">
        <span>Wallet to manage</span>
        <select value={vault.walletId} disabled={Boolean(busy)} onChange={(event) => setSelectedWalletId(event.target.value)}>
          {wallets.map((wallet) => <option key={wallet.walletId} value={wallet.walletId}>{walletLabel(wallet)} · {short(wallet.address, 13, 9)}</option>)}
        </select>
        <small>Password and Passkey changes apply only to the wallet selected here.</small>
      </label>
      <div className={`passkey-status ${passkeyState ? 'enabled' : 'legacy'}`}><i aria-hidden="true">{passkeyState ? '✓' : '!'}</i><span><strong>{passkeyState ? 'Passkey enabled' : 'Password-only wallet'}</strong><small>{passkeyState ? 'Password fallback remains available.' : 'The current password remains unchanged.'}</small></span></div>
      <div className="security-modal-tabs" role="tablist" aria-label="Wallet access settings">
        <button type="button" role="tab" aria-selected={tab === 'password'} className={tab === 'password' ? 'active' : ''} disabled={Boolean(busy)} onClick={() => { setTab('password'); setError(''); setMessage(''); }}>Change password</button>
        <button type="button" role="tab" aria-selected={tab === 'passkey'} className={tab === 'passkey' ? 'active' : ''} disabled={Boolean(busy)} onClick={() => { setTab('passkey'); setError(''); setMessage(''); }}>Passkey</button>
      </div>
      {tab === 'password' ? <form className="security-password-form security-modal-content" onSubmit={changePassword} autoComplete="off">
        <PasswordField label="Current wallet password" value={currentPassword} onChange={setCurrentPassword} minLength={6} />
        <div className="security-new-passwords"><PasswordField label="New wallet password" value={newPassword} onChange={setNewPassword} minLength={12} /><PasswordField label="Confirm new password" value={confirmPassword} onChange={setConfirmPassword} minLength={12} /></div>
        <PasswordStrength password={newPassword} />
        {passkeyState && <label className="keep-passkey-choice"><input type="checkbox" checked={keepPasskey} onChange={(event) => setKeepPasskey(event.target.checked)} /><span><strong>Keep Passkey enabled</strong><small>This requires a Passkey prompt to wrap the new password. If Passkey is unavailable, uncheck this to continue with password-only access.</small></span></label>}
        <p className="password-container-warning">This changes the browser wallet password. An imported or Qt-compatible wallet.dat keeps its own existing file passphrase.</p>
        <button className="button primary modal-submit" disabled={Boolean(busy)} aria-busy={busy === 'change'}>{busy === 'change' && <span className="button-spinner" aria-hidden="true" />}<span>{busy === 'change' ? 'Changing password…' : 'Verify and change password'}</span></button>
      </form> : <div className="security-modal-content">
        <p className="muted">Passkey data is separate from the password-encrypted vault. Removing or losing Passkey does not change the wallet password.</p>
        {!passkeyState && passkeyIssue && <div className="passkey-enrollment-note unavailable"><strong>Passkey cannot be added from this address</strong><span>{passkeyIssue}</span>{localhostUrl && <><a className="localhost-passkey-link" href={localhostUrl}>Open this build on localhost</a><small className="localhost-origin-warning">localhost has separate browser storage. Existing 127.0.0.1 wallets are not moved automatically.</small></>}</div>}
        {(passkeyState || !passkeyIssue) && <form className="security-inline-form" onSubmit={passkeyState ? remove : enable} autoComplete="off">
          {passkeyState && removeAuthMethod === 'passkey' ? <PasskeyAuthorization
            title="Confirm with Passkey"
            detail="Your system will verify the Passkey for this wallet before it is removed. The wallet password remains unchanged."
            disabled={Boolean(busy)}
            onUsePassword={() => { setRemoveAuthMethod('password'); setEnablePassword(''); setError(''); }}
          /> : <>
            <PasswordField label="Current wallet password" value={enablePassword} onChange={setEnablePassword} minLength={6} />
            {passkeyState && <button className="auth-method-switch" type="button" disabled={Boolean(busy) || Boolean(passkeyIssue)} onClick={() => { setRemoveAuthMethod('passkey'); setEnablePassword(''); setError(''); }}>Use Passkey instead</button>}
          </>}
          <button className={`button ${passkeyState ? 'secondary' : 'primary'} modal-submit`} disabled={Boolean(busy)} aria-busy={busy === 'enable' || busy === 'remove'}>{(busy === 'enable' || busy === 'remove') && <span className="button-spinner" aria-hidden="true" />}<span>{busy === 'enable' ? 'Adding Passkey…' : busy === 'remove' ? 'Removing Passkey…' : passkeyState ? (removeAuthMethod === 'passkey' ? 'Verify Passkey and remove' : 'Verify password and remove Passkey') : 'Verify password and add Passkey'}</span></button>
        </form>}
      </div>}
      {error && <p className="form-error security-modal-message" role="alert">{error}</p>}
      {message && <p className="form-message security-modal-message" role="status">{message}</p>}
    </section>
  </div>;
}

const COMMON_CURRENCIES = ['usd', 'cny', 'eur', 'jpy', 'gbp', 'hkd', 'sgd', 'aud', 'cad', 'krw'];

function CurrencyPicker({ value, rates, onChange }: {
  value: string;
  rates: Record<string, number>;
  onChange: (currency: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const currencies = useMemo(() => {
    const available = Object.keys(rates);
    return available.sort((left, right) => {
      const leftRank = COMMON_CURRENCIES.indexOf(left);
      const rightRank = COMMON_CURRENCIES.indexOf(right);
      if (leftRank >= 0 || rightRank >= 0) return (leftRank < 0 ? 999 : leftRank) - (rightRank < 0 ? 999 : rightRank);
      return left.localeCompare(right);
    });
  }, [rates]);
  const visible = currencies.filter((currency) => currency.includes(query.trim().toLowerCase()));
  useEffect(() => {
    function close(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  function select(currency: string) {
    onChange(currency);
    setOpen(false);
    setQuery('');
  }
  return <div className={`currency-picker${open ? ' is-open' : ''}`} ref={root}>
    <button type="button" className="currency-picker-trigger" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
      <span>{value.toUpperCase()}</span><small>Display currency</small><i>⌄</i>
    </button>
    {open && <div className="currency-picker-menu">
      <label><span>Search currency</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="USD, CNY, EUR…" autoComplete="off" /></label>
      <div role="listbox" aria-label="Display currency">
        {visible.map((currency) => <button type="button" key={currency} className={currency === value ? 'selected' : ''} onClick={() => select(currency)} role="option" aria-selected={currency === value}>
          <strong>{currency.toUpperCase()}</strong><small>1 USD = {rates[currency].toLocaleString(undefined, { maximumFractionDigits: 6 })} {currency.toUpperCase()}</small><span>{currency === value ? '✓' : '→'}</span>
        </button>)}
        {!visible.length && <p>No matching currency</p>}
      </div>
    </div>}
  </div>;
}

function SettingsPanel({ currency, currencies, onCurrencyChange, onSaved, onDelete }: {
  currency: string;
  currencies: CurrencySnapshot | null;
  onCurrencyChange: (currency: string) => void;
  onSaved: () => Promise<void>;
  onDelete: () => void;
}) {
  const [gateway, setGateway] = useState(getGatewayUrl());
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      setGateway(setGatewayUrl(gateway));
      setMessage('Gateway saved. Checking its chain status now.');
      await onSaved();
      setMessage('Gateway saved and verified.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Invalid gateway URL');
    } finally {
      setSaving(false);
    }
  }
  return <div className="settings-section-stack enter"><section className="content-card settings-section currency-settings">
    <header className="settings-section-head"><span>03</span><div><p>Market display</p><h2>Preferred currency</h2></div></header>
    <p className="muted">Wallet amounts remain TSC. This setting only converts the SafeTrade TSC/USDT reference price for display on this device.</p>
    <CurrencyPicker value={currency} rates={currencies?.rates ?? { usd: 1 }} onChange={onCurrencyChange} />
    <div className="currency-source"><span>{currencies ? `${Object.keys(currencies.rates).length} currencies · ${currencies.source.replaceAll('-', ' ')}` : 'USD only until currency data is available'}</span>{currencies?.stale && <b>Rates may be outdated</b>}</div>
  </section><section className="content-card settings-card settings-section">
    <header className="settings-section-head"><span>04</span><div><p>Network access</p><h2>Chain data gateway</h2></div></header>
    <p className="muted">The gateway supplies public balances, transactions and mempool data, then relays transactions signed locally. It never receives your password or private key.</p>
    <form onSubmit={save} autoComplete="off"><label>HTTPS gateway URL<input value={gateway} onChange={(event) => setGateway(event.target.value)} autoComplete="off" data-1p-ignore="true" data-lpignore="true" spellCheck={false} disabled={saving} /></label><button className="button primary modal-submit" disabled={saving} aria-busy={saving}>{saving && <span className="button-spinner" aria-hidden="true" />}<span>{saving ? 'Verifying gateway…' : 'Save and verify'}</span></button></form>
    {message && <p className="form-message">{message}</p>}
    <div className="gateway-boundary"><span>Your browser</span><i>signed transaction →</i><span>Gateway</span><i>public Core data →</i><span>Wallet UI</span></div>
    <p className="gateway-note">Do not enter a TensorCash Core RPC username, password, token or URL containing credentials.</p>
  </section><section className="content-card settings-section danger-zone">
    <header className="settings-section-head"><span>05</span><div><p>Local storage</p><h2>Remove this wallet</h2></div></header>
    <p className="muted">Erases only this browser's encrypted copy. Blockchain funds remain untouched, but recovery requires a valid backup.</p>
    <button onClick={onDelete}>Remove from this browser</button>
  </section></div>;
}

function DeleteWalletModal({ wallet, onClose, onConfirm }: {
  wallet: EncryptedVault;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const expectedName = walletLabel(wallet);
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const matches = confirmation === expectedName;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!matches || deleting) return;
    setDeleting(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to remove this wallet');
      setDeleting(false);
    }
  }

  return <div className="modal-backdrop delete-wallet-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !deleting) onClose();
  }}>
    <section className="modal delete-wallet-modal" role="dialog" aria-modal="true" aria-labelledby="delete-wallet-title">
      <button className="modal-close" onClick={onClose} aria-label="Close" disabled={deleting}>×</button>
      <header className="delete-wallet-head">
        <div className="delete-wallet-alert" aria-hidden="true">!</div>
        <div>
          <p className="eyebrow">IRREVERSIBLE ACTION</p>
          <h2 id="delete-wallet-title">Delete this wallet?</h2>
        </div>
      </header>
      <p className="delete-wallet-summary">This permanently removes the encrypted wallet and its local history cache from this browser.</p>
      <div className="delete-wallet-warning" role="note">
        <span><i aria-hidden="true">×</i>This action cannot be undone.</span>
        <span><i aria-hidden="true">✓</i>Your on-chain funds remain untouched.</span>
        <span><i aria-hidden="true">!</i>Recovery requires a valid backup and password.</span>
      </div>
      <div className="delete-wallet-target">
        <span>Wallet to remove</span>
        <strong>{expectedName}</strong>
        <code>{wallet.address}</code>
      </div>
      <form onSubmit={submit} autoComplete="off">
        <div className="delete-wallet-confirm-copy">
          <span>To confirm, type the wallet name exactly:</span>
          <strong>{expectedName}</strong>
        </div>
        <input className="delete-wallet-confirm-input" aria-label="Wallet name confirmation" autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" data-1p-ignore="true" data-lpignore="true" spellCheck={false} disabled={deleting} placeholder="Enter the wallet name" />
        {confirmation && !matches && <p className="delete-wallet-mismatch" role="status">Wallet name does not match.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <footer className="delete-wallet-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={deleting}>Cancel</button>
          <button className="button delete-wallet-submit" type="submit" disabled={!matches || deleting} aria-busy={deleting}>{deleting && <span className="button-spinner" aria-hidden="true" />}<span>{deleting ? 'Deleting wallet…' : 'Delete permanently'}</span></button>
        </footer>
      </form>
    </section>
  </div>;
}

function GeneratedFallbackModal({ notice, onDone }: {
  notice: GeneratedFallbackNotice;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  return <div className="modal-backdrop generated-password-backdrop" role="presentation">
    <section className="modal generated-password-modal" role="dialog" aria-modal="true" aria-labelledby="generated-password-title">
      <div className="generated-password-icon" aria-hidden="true">⌁</div>
      <p className="eyebrow">PASSWORD FALLBACK</p>
      <h2 id="generated-password-title">Save this password offline</h2>
      <p className="modal-lead">Passkey is the default for <strong>{notice.walletName}</strong>. This generated password is the emergency way back in if Passkey becomes unavailable.</p>
      <div className="generated-password-value"><span>Generated wallet password</span><code>{notice.password}</code></div>
      <div className="generated-password-guidance"><strong>Write it down and keep it away from this device.</strong><span>There is intentionally no Copy button because clipboard monitoring is part of the threat model. Never store this password beside the wallet backup.</span></div>
      <div className="generated-password-wallet"><span>{notice.walletName}</span><code>{short(notice.address, 16, 12)}</code></div>
      <p className="generated-password-scope">{notice.origin === 'created'
        ? 'This password unlocks the browser wallet and its generated Qt-compatible wallet.dat backup.'
        : 'This password unlocks the imported browser wallet. The source Qt/Web backup keeps its existing password.'}</p>
      <label className="generated-password-confirm"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} /><span>I saved this fallback password somewhere safe.</span></label>
      <button className="button primary wide" type="button" disabled={!saved} onClick={onDone}>Continue to wallet</button>
    </section>
  </div>;
}

function PasswordField({
  label,
  value,
  onChange,
  minLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const hasOuterWhitespace = value.length > 0 && value.trim() !== value;
  const updateCapsLock = (event: ReactKeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState('CapsLock'));
  return <label>{label}<span className="password-input"><input type={visible ? 'text' : 'password'} autoComplete="new-password" data-1p-ignore="true" data-lpignore="true" data-form-type="other" value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={updateCapsLock} onKeyUp={updateCapsLock} onBlur={() => setCapsLock(false)} minLength={minLength} required /><button className="password-toggle" type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} aria-pressed={visible}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.75"/></svg></button></span>{(capsLock || hasOuterWhitespace) && <small className="password-entry-hint" role="status">{capsLock ? 'Caps Lock is on.' : 'Leading or trailing spaces are part of this password.'}</small>}</label>;
}

function PasskeyAuthorization({ title, detail, disabled = false, onUsePassword }: {
  title: string;
  detail: string;
  disabled?: boolean;
  onUsePassword: () => void;
}) {
  return <div className="passkey-authorization">
    <span className="passkey-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="8" cy="9" r="4"/><path d="m11 12 8 8m-2-2 2-2m-5-1 2-2"/></svg></span>
    <div><strong>{title}</strong><small>{detail}</small></div>
    <button className="auth-method-switch" type="button" disabled={disabled} onClick={onUsePassword}>Use wallet password</button>
  </div>;
}

function PasswordStrength({ password }: { password: string }) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  const score = Math.max(0, Math.min(4, (password.length >= 12 ? 1 : 0) + (password.length >= 16 ? 1 : 0) + Math.min(2, classes - 1)));
  const label = ['Too short', 'Basic', 'Good', 'Strong', 'Very strong'][score];
  return <div className={`password-strength score-${score}`} aria-live="polite"><span>{[0, 1, 2, 3].map((index) => <i key={index} className={index < score ? 'active' : ''} />)}</span><small>{label} · 12 characters minimum</small></div>;
}

function Modal({ dialog, vault, passkeyState, requestedReceiveAddressCount, onClose, onCreated, onUnlocked, onImported, onBackedUp }: {
  dialog: Exclude<Dialog, null>;
  vault: EncryptedVault | null;
  passkeyState: WalletPasskeyState | null;
  requestedReceiveAddressCount: number;
  onClose: () => void;
  onCreated: (vault: EncryptedVault, material: WalletMaterial, passkey: WalletPasskeyState | null, generatedFallback?: string) => void;
  onUnlocked: (material: WalletMaterial, vault?: EncryptedVault) => void;
  onImported: (vault: EncryptedVault, material: WalletMaterial, passkey: WalletPasskeyState | null, generatedFallback?: string) => void;
  onBackedUp: () => void;
}) {
  const [password, setPassword] = useState('');
  const [authMethod, setAuthMethod] = useState<'passkey' | 'password'>(passkeyState ? 'passkey' : 'password');
  const [confirm, setConfirm] = useState('');
  const [creationMethod, setCreationMethod] = useState<'passkey' | 'password'>('passkey');
  const [webBackupPassword, setWebBackupPassword] = useState('');
  const [walletName, setWalletName] = useState('');
  const [qtPassword, setQtPassword] = useState('');
  const [source, setSource] = useState('');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [qtEncrypted, setQtEncrypted] = useState<boolean | null>(null);
  const [qtPrimaryAddress, setQtPrimaryAddress] = useState<string | null>(null);
  const [restoringWebVault, setRestoringWebVault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try {
      // Let React commit and the browser paint the progress state before any
      // password KDF or wallet parsing begins.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      await action();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The operation failed'); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (dialog === 'create') return run(async () => {
      if (creationMethod === 'passkey') {
        const unavailable = passkeyUnavailableReason();
        if (unavailable) throw new Error(unavailable);
      }
      if (creationMethod === 'password' && password !== confirm) throw new Error('Passwords do not match');
      if (!walletName.trim()) throw new Error('Enter a name for this wallet');
      const fallbackPassword = creationMethod === 'password' ? password : generateFallbackPassword();
      const material = await createQtWalletMaterial(fallbackPassword);
      const encrypted = await encryptWallet(material, fallbackPassword, {}, walletName);
      const passkey = creationMethod === 'passkey' ? await createPasskeyState(encrypted, fallbackPassword) : null;
      await saveVaultAndPasskeyState(encrypted, passkey);
      onCreated(encrypted, material, passkey, creationMethod === 'passkey' ? fallbackPassword : undefined);
    });
    if (dialog === 'unlock' || dialog === 'backup') return run(async () => {
      if (!vault) throw new Error('No local wallet found');
      const walletPassword = authMethod === 'passkey' && passkeyState
        ? await unlockPasswordWithPasskey(passkeyState)
        : password;
      let material = await decryptWallet(vault, walletPassword);
      let migratedVault: EncryptedVault | undefined;
      if ('qt' in material) {
        material = hydrateQtAddressState(material);
        if (requestedReceiveAddressCount > (material.qt.receiveAddressCount ?? 1)) {
          material = (await advanceQtReceiveAddressCount(material, requestedReceiveAddressCount)).material;
        }
        const addressesChanged = JSON.stringify(vault.addresses ?? []) !== JSON.stringify(material.qt.addresses);
        const receiveChanged = JSON.stringify(vault.receiveAddresses ?? []) !== JSON.stringify(material.qt.receiveAddresses ?? []);
        const countChanged = vault.receiveAddressCount !== material.qt.receiveAddressCount;
        if (addressesChanged || receiveChanged || countChanged) {
          migratedVault = await encryptWallet(material, walletPassword, { allowLegacyPassword: true }, vault.walletName);
          await saveVault(migratedVault);
        }
      }
      if (dialog === 'backup') {
        if (!(await downloadQtBackup(material))) downloadBackup(migratedVault ?? vault);
        onBackedUp();
        onUnlocked(material, migratedVault);
      } else onUnlocked(material, migratedVault);
    });
    return run(async () => {
      if (creationMethod === 'passkey') {
        const unavailable = passkeyUnavailableReason();
        if (unavailable) throw new Error(unavailable);
      }
      if (creationMethod === 'password' && password !== confirm) throw new Error('Passwords do not match');
      if (!walletName.trim()) throw new Error('Enter a name for this wallet');
      if (!sourceFile) throw new Error('Choose a wallet backup file');
      const fallbackPassword = creationMethod === 'password' ? password : generateFallbackPassword();
      if (sourceFile && qtEncrypted !== null) {
        const bytes = new Uint8Array(await sourceFile.arrayBuffer());
        const material = await importQtWallet(bytes, qtPassword);
        const encrypted = await encryptWallet(material, fallbackPassword, {}, walletName);
        const passkey = creationMethod === 'passkey' ? await createPasskeyState(encrypted, fallbackPassword) : null;
        await saveVaultAndPasskeyState(encrypted, passkey);
        onImported(encrypted, material, passkey, creationMethod === 'passkey' ? fallbackPassword : undefined);
        return;
      }
      const parsed = JSON.parse(source) as unknown;
      try {
        validateVault(parsed);
        let material = await decryptWallet(parsed, webBackupPassword);
        if ('qt' in material) {
          material = hydrateQtAddressState(material);
        }
        const restoredVault = await encryptWallet(material, fallbackPassword, {}, walletName);
        const passkey = creationMethod === 'passkey' ? await createPasskeyState(restoredVault, fallbackPassword) : null;
        await saveVaultAndPasskeyState(restoredVault, passkey);
        onImported(restoredVault, material, passkey, creationMethod === 'passkey' ? fallbackPassword : undefined);
      } catch (vaultError) {
        if ((parsed as { schema?: string })?.schema === 'org.tensorcash.webwallet.vault') throw vaultError;
        const material = await importOfficialWalletExport(parsed);
        const encrypted = await encryptWallet(material, fallbackPassword, {}, walletName);
        const passkey = creationMethod === 'passkey' ? await createPasskeyState(encrypted, fallbackPassword) : null;
        await saveVaultAndPasskeyState(encrypted, passkey);
        onImported(encrypted, material, passkey, creationMethod === 'passkey' ? fallbackPassword : undefined);
      }
    });
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) return setError('Wallet backup must be under 64 MB');
    setFileBusy(true);
    setError('');
    setSourceFile(null);
    setQtEncrypted(null);
    setQtPrimaryAddress(null);
    setRestoringWebVault(false);
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder().decode(bytes.slice(0, 16)) === 'SQLite format 3\u0000') {
        const inspection = await inspectQtWallet(bytes);
        setSourceFile(file);
        setQtEncrypted(inspection.encrypted);
        setQtPrimaryAddress(inspection.primaryAddress);
        setSource('');
        return;
      }
      const text = await file.text();
      setSource(text);
      setSourceFile(file);
      setQtEncrypted(null);
      try {
        setRestoringWebVault((JSON.parse(text) as { schema?: string })?.schema === 'org.tensorcash.webwallet.vault');
      } catch {
        setRestoringWebVault(false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to read wallet backup');
    } finally {
      setFileBusy(false);
    }
  }

  const titles = {
    create: ['Create a local wallet', creationMethod === 'passkey' ? 'Create with Passkey first. A strong fallback password is generated without keyboard input and shown once after setup.' : 'Create a password-only wallet. Passkey will not be requested or stored.'],
    import: ['Import wallet', creationMethod === 'passkey' ? 'Import locally, then use Passkey first with a separately generated fallback password.' : 'Import as a password-only browser wallet. Passkey will not be requested or stored.'],
    unlock: ['Unlock Wallet', passkeyState ? 'Use Passkey, or switch to the original wallet password at any time.' : 'This wallet has no Passkey. Unlock it with its original password.'],
    backup: ['Confirm recovery export', passkeyState ? 'Authorize with Passkey, or use the wallet password, before exporting recovery data.' : 'Re-enter the original wallet password before exporting recovery data.'],
  } as const;
  const passkeyIssue = (dialog === 'create' || dialog === 'import') ? passkeyUnavailableReason() : null;
  const localhostUrl = typeof location !== 'undefined' && (/^(?:127(?:\.\d{1,3}){3})$/.test(location.hostname) || location.hostname.includes(':'))
    ? (() => { const url = new URL(location.href); url.hostname = 'localhost'; return url.href; })()
    : null;
  const passkeyFirst = (dialog === 'unlock' || dialog === 'backup') && Boolean(passkeyState) && authMethod === 'passkey';
  const actionLabel = passkeyFirst
    ? (dialog === 'backup' ? 'Continue with Passkey' : 'Unlock with Passkey')
    : dialog === 'backup' ? 'Verify and download' : dialog === 'unlock' ? 'Unlock Wallet' : dialog === 'import' ? (creationMethod === 'passkey' ? 'Import with Passkey' : 'Import with password') : (creationMethod === 'passkey' ? 'Create wallet with Passkey' : 'Create wallet with password');
  const busyLabel = dialog === 'backup' ? 'Preparing backup…' : dialog === 'unlock' ? 'Unlocking wallet…' : dialog === 'import' ? 'Importing wallet…' : 'Creating wallet…';
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && !fileBusy && onClose()}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy || fileBusy}>×</button>
      <p className="eyebrow">TENSORCASH WALLET</p><h2 id="modal-title">{titles[dialog][0]}</h2><p className="modal-lead">{titles[dialog][1]}</p>
      {vault && (dialog === 'unlock' || dialog === 'backup') && <div className="password-wallet-identity"><span>Selected wallet</span><strong>{walletLabel(vault)}</strong><code>{short(vault.address, 15, 10)} · {vaultFingerprint(vault)}</code></div>}
      <form onSubmit={submit} autoComplete="off">
        {(dialog === 'create' || dialog === 'import') && <label>Wallet name<input value={walletName} onChange={(event) => setWalletName(event.target.value)} maxLength={40} placeholder="e.g. Personal wallet" autoComplete="off" data-1p-ignore="true" data-lpignore="true" required /></label>}
        {dialog === 'import' && <>
          <input ref={fileRef} type="file" accept=".dat,.bak,.wallet,.json,application/json,application/octet-stream,application/x-sqlite3" hidden onChange={(event) => void readFile(event.target.files?.[0])} />
          <button className="file-drop" type="button" onClick={() => fileRef.current?.click()} disabled={fileBusy || busy} aria-busy={fileBusy}>{fileBusy ? <><span className="button-spinner dark" aria-hidden="true" /><strong>Inspecting wallet file…</strong><small>Checking encryption and address metadata locally</small></> : <><span>↑</span><strong>{sourceFile?.name ?? 'Choose Qt wallet.dat or backup file'}</strong><small>{qtEncrypted === true ? 'Encrypted Qt wallet detected · password required below' : qtEncrypted === false ? 'Unencrypted Qt wallet detected · processed only in this browser' : 'Qt/Core wallet.dat, encrypted Web backup, or ML-DSA JSON export'}</small></>}</button>
          {qtPrimaryAddress && <div className="qt-wallet-match"><span>Detected active address</span><strong>{qtPrimaryAddress}</strong></div>}
          {qtEncrypted && <PasswordField label="Existing Qt wallet password" value={qtPassword} onChange={setQtPassword} />}
          {restoringWebVault && <PasswordField label="Existing Web backup password" value={webBackupPassword} onChange={setWebBackupPassword} minLength={6} />}
        </>}
        {(dialog === 'create' || dialog === 'import') ? <>
          {creationMethod === 'passkey' ? <>
            <div className={`passkey-enrollment-note${passkeyIssue ? ' unavailable' : ''}`}><strong>{passkeyIssue ? 'Passkey is unavailable on this address' : dialog === 'import' ? 'No new wallet password required' : 'No password typing required'}</strong><span>{passkeyIssue ?? (dialog === 'import' ? 'The imported browser wallet gets a generated fallback password. An encrypted source file still requires its existing password so it can be opened locally.' : 'Your system Passkey prompt opens next. After it succeeds, the wallet shows a generated fallback password once for offline recovery.')}</span>{localhostUrl && <><a className="localhost-passkey-link" href={localhostUrl}>Open this build on localhost</a><small className="localhost-origin-warning">localhost uses separate browser storage; wallets saved under 127.0.0.1 are not copied there.</small></>}</div>
            <button className="custom-fallback-toggle" type="button" onClick={() => { setCreationMethod('password'); setPassword(''); setConfirm(''); setError(''); }}>Use password instead</button>
          </> : <>
            <div className="password-only-enrollment-note"><strong>Password-only mode</strong><span>No Passkey prompt will appear. This wallet will unlock with the password you set below.</span></div>
            <button className="custom-fallback-toggle" type="button" onClick={() => { setCreationMethod('passkey'); setPassword(''); setConfirm(''); setError(''); }}>Use Passkey instead</button>
            <PasswordField label="Wallet password" value={password} onChange={setPassword} minLength={12} />
            <PasswordField label="Confirm wallet password" value={confirm} onChange={setConfirm} minLength={12} />
            <PasswordStrength password={password} />
            <p className="password-container-warning">This password is the only local unlock method until you explicitly add Passkey from Settings. Keep it separate from the wallet backup.</p>
          </>}
        </> : passkeyState && authMethod === 'passkey' ? <PasskeyAuthorization
          title={dialog === 'backup' ? 'Authorize recovery export with Passkey' : 'Unlock with Passkey'}
          detail="If your Passkey cannot be used, switch to the original wallet password."
          disabled={busy}
          onUsePassword={() => { setAuthMethod('password'); setError(''); }}
        /> : <>
          <PasswordField label="Wallet password" value={password} onChange={setPassword} minLength={6} />
          {passkeyState && <button className="auth-method-switch" type="button" disabled={busy} onClick={() => { setAuthMethod('passkey'); setPassword(''); setError(''); }}>Use Passkey instead</button>}
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button primary wide modal-submit" disabled={busy || fileBusy || Boolean(passkeyIssue && creationMethod === 'passkey')} aria-busy={busy}>{busy && <span className="button-spinner" aria-hidden="true" />}<span>{busy ? busyLabel : actionLabel}</span></button>
      </form>
      <p className="modal-foot">Wallet files, passwords and Passkey unlock data stay on this device. Nothing entered here is sent to the gateway.</p>
    </section>
  </div>;
}

function downloadBackup(vault: EncryptedVault) {
  const blob = new Blob([JSON.stringify(vault, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `tensorcash-wallet-${vault.address.slice(0, 12)}-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function downloadQtBackup(material: WalletMaterial): Promise<boolean> {
  if (!('qt' in material)) return false;
  const original = base64ToBytes(material.qt.originalFileBase64);
  const bytes = await prepareQtBackup(original, material.address);
  const blob = new Blob([Uint8Array.from(bytes).buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `tensorcash-qt-${material.address.slice(0, 12)}-${new Date().toISOString().slice(0, 10)}.dat`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return true;
}

export default function App() {
  const [vault, setVault] = useState<EncryptedVault | null | undefined>(undefined);
  const [wallets, setWallets] = useState<EncryptedVault[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [view, setView] = useState<View>('overview');
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [summary, setSummary] = useState<AddressSummary | null>(null);
  const [transactions, setTransactions] = useState<AddressTransaction[]>([]);
  const [fundedAddresses, setFundedAddresses] = useState<WalletAddressBalance[]>([]);
  const [networkError, setNetworkError] = useState('');
  const [toast, setToast] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const [receiveAddressCount, setReceiveAddressCount] = useState<number | null>(null);
  const [derivingAddress, setDerivingAddress] = useState(false);
  const [accountLoading, setAccountLoading] = useState(false);
  const [switchingWallet, setSwitchingWallet] = useState(false);
  const [backupStates, setBackupStates] = useState<Record<string, WalletBackupState | null>>({});
  const [passkeyStates, setPasskeyStates] = useState<Record<string, WalletPasskeyState | null>>({});
  const [passkeyStatesLoaded, setPasskeyStatesLoaded] = useState(false);
  const [passkeyRecommendationSeen, setPasskeyRecommendationSeen] = useState(() => {
    try { return localStorage.getItem(PASSKEY_RECOMMENDATION_SEEN_KEY) === '1'; } catch { return false; }
  });
  const [receiveMonitor, setReceiveMonitor] = useState<string | null>(null);
  const [sendMonitor, setSendMonitor] = useState<{ transaction: AddressTransaction; addresses: string[] } | null>(null);
  const [deleteWalletOpen, setDeleteWalletOpen] = useState(false);
  const [walletSecurityRequest, setWalletSecurityRequest] = useState<{ walletId: string; tab: 'password' | 'passkey' } | null>(null);
  const [generatedFallbackNotice, setGeneratedFallbackNotice] = useState<GeneratedFallbackNotice | null>(null);
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [currencies, setCurrencies] = useState<CurrencySnapshot | null>(null);
  const [displayCurrency, setDisplayCurrency] = useState(() => getDisplayCurrency());
  const receiveMonitorTimer = useRef<number | undefined>(undefined);
  const refreshSequence = useRef(0);
  const hasAccountData = useRef(false);
  const transactionsRef = useRef<AddressTransaction[]>([]);

  // Keep the authenticated encrypted envelope immutable. The exposed receive
  // count is convenience state and must never be merged into this object: it is
  // part of AES-GCM additional data and changing it makes the right password fail.
  const displayVault = vault;
  const activeReceiveAddressCount = vault
    ? Math.max(1, Math.min(vault.receiveAddresses?.length ?? 1, receiveAddressCount ?? vault.receiveAddressCount ?? 1))
    : 1;

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setNetworkError('');
    if (displayVault && !hasAccountData.current) setAccountLoading(true);
    try {
      if (!displayVault) {
        const payload = await getStatus();
        setStatus(payload.status);
        return;
      }
      const addresses = displayVault.addresses?.length ? displayVault.addresses : [displayVault.address];
      // The gateway serves confirmed data and its non-blocking mempool snapshot
      // in one response. A single request avoids two identical SQLite scans and
      // request races on every refresh.
      const account = await getWalletOverview(addresses, 1, true);
      if (sequence === refreshSequence.current) {
        const reconciled = reconcileLiveAccount(account.address, account.transactions, transactionsRef.current);
        setStatus(account.status);
        setSummary(reconciled.summary);
        transactionsRef.current = reconciled.transactions;
        setTransactions(reconciled.transactions);
        setFundedAddresses(account.funded_addresses ?? []);
        hasAccountData.current = true;
        void saveAccountCache(displayVault.walletId, {
          status: account.status,
          summary: reconciled.summary,
          transactions: reconciled.transactions,
          fundedAddresses: account.funded_addresses ?? [],
        }).catch(() => { /* Public cache failure never blocks live wallet data. */ });
      }
    } catch (error) {
      if (sequence === refreshSequence.current) setNetworkError(error instanceof Error ? error.message : 'Gateway unavailable');
    } finally {
      if (sequence === refreshSequence.current) setAccountLoading(false);
    }
  }, [displayVault]);

  useEffect(() => {
    loadVault().then(async (loaded) => {
      const inventory = await loadVaultInventory();
      setWallets(inventory.wallets);
      const backupEntries = await Promise.all(inventory.wallets.map(async (wallet) => {
        try {
          return [wallet.walletId, await loadBackupState(wallet.walletId)] as const;
        } catch {
          return [wallet.walletId, null] as const;
        }
      }));
      setBackupStates(Object.fromEntries(backupEntries));
      const passkeyEntries = await Promise.all(inventory.wallets.map(async (wallet) => {
        try {
          return [wallet.walletId, await loadPasskeyState(wallet.walletId)] as const;
        } catch {
          return [wallet.walletId, null] as const;
        }
      }));
      setPasskeyStates(Object.fromEntries(passkeyEntries));
      setPasskeyStatesLoaded(true);
      if (inventory.invalidRecordCount) {
        setStorageWarning(`${inventory.invalidRecordCount} damaged local wallet record${inventory.invalidRecordCount === 1 ? ' was' : 's were'} ignored. Healthy wallets remain available; restore the affected wallet from a trusted backup.`);
      }
      if (!loaded) {
        setVault(null);
        return setReceiveAddressCount(null);
      }
      try {
        const cached = await loadAccountCache(loaded.walletId);
        if (cached) {
          setStatus(cached.status);
          setSummary(cached.summary);
          transactionsRef.current = cached.transactions;
          setTransactions(cached.transactions);
          setFundedAddresses(cached.fundedAddresses ?? []);
          hasAccountData.current = true;
        }
      } catch {
        // Chain history is a disposable public cache. Ignore corrupt or
        // unavailable cache storage and continue with the live gateway.
      }
      setVault(loaded);
      let saved: number | null = null;
      try {
        saved = await loadReceiveAddressCount(loaded.walletId);
      } catch {
        // A failed convenience-state read must never prevent the encrypted
        // wallet itself from opening. Fall back to its authenticated count.
      }
      const maximum = loaded.receiveAddresses?.length ?? 1;
      setReceiveAddressCount(Math.max(1, Math.min(maximum, saved ?? loaded.receiveAddressCount ?? 1)));
    }).catch(() => {
      setVault(null);
      setBackupStates({});
      setPasskeyStates({});
      setPasskeyStatesLoaded(true);
      setReceiveAddressCount(null);
    });
  }, []);
  useEffect(() => { if (vault !== undefined) void refresh(); const timer = window.setInterval(refresh, 15_000); return () => window.clearInterval(timer); }, [refresh, vault]);
  useEffect(() => {
    let active = true;
    async function refreshMarket() {
      const [nextMarket, nextCurrencies] = await Promise.all([loadTscTicker(), loadCurrencyRates()]);
      if (!active) return;
      setMarket(nextMarket);
      setCurrencies(nextCurrencies);
      if (nextCurrencies && !nextCurrencies.rates[displayCurrency]) {
        setDisplayCurrency(saveDisplayCurrency('usd'));
      }
    }
    void refreshMarket();
    const timer = window.setInterval(refreshMarket, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [displayCurrency]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 1800); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => () => window.clearTimeout(receiveMonitorTimer.current), []);

  const localWallets = displayVault && !wallets.some((wallet) => wallet.walletId === displayVault.walletId)
    ? [displayVault, ...wallets]
    : wallets;
  const passwordOnlyWallets = passkeyStatesLoaded
    ? localWallets.filter((wallet) => !passkeyStates[wallet.walletId])
    : [];
  const passkeyRecommendationWallet = displayVault && passwordOnlyWallets.some((wallet) => wallet.walletId === displayVault.walletId)
    ? displayVault
    : passwordOnlyWallets[0] ?? null;
  const showPasskeyRecommendation = Boolean(passkeyRecommendationWallet && !passkeyRecommendationSeen);

  useEffect(() => {
    if (!showPasskeyRecommendation) return;
    try { localStorage.setItem(PASSKEY_RECOMMENDATION_SEEN_KEY, '1'); } catch { /* A one-time UI hint must never affect wallet access. */ }
  }, [showPasskeyRecommendation]);

  const closeReceiveMonitor = useCallback(() => setReceiveMonitor(null), []);
  const closeSendMonitor = useCallback(() => setSendMonitor(null), []);
  const openReceiveMonitor = useCallback((address: string) => {
    window.clearTimeout(receiveMonitorTimer.current);
    setView('overview');
    receiveMonitorTimer.current = window.setTimeout(() => setReceiveMonitor(address), 280);
  }, []);

  const title = useMemo(() => ({ overview: 'Overview', receive: 'Receive TSC', send: 'Send TSC', activity: 'Transactions', addresses: 'Wallet addresses', settings: 'Settings', wallets: 'Manage wallets' })[view], [view]);

  function completed(nextVault: EncryptedVault) {
    refreshSequence.current += 1;
    setSummary(null);
    transactionsRef.current = [];
    setTransactions([]);
    setFundedAddresses([]);
    setReceiveMonitor(null);
    setSendMonitor(null);
    hasAccountData.current = false;
    setVault(nextVault);
    const count = nextVault.receiveAddressCount ?? 1;
    setReceiveAddressCount(count);
    void saveReceiveAddressCount(nextVault.walletId, count);
    void loadVaults().then(setWallets);
    setDialog(null);
    setToast('Wallet secured on this device');
    setView('overview');
  }
  function created(nextVault: EncryptedVault, _nextMaterial: WalletMaterial, passkey: WalletPasskeyState | null, generatedFallback?: string) {
    const state: WalletBackupState = { origin: 'created', backedUp: false };
    setBackupStates((current) => ({ ...current, [nextVault.walletId]: state }));
    setPasskeyStates((current) => ({ ...current, [nextVault.walletId]: passkey }));
    void saveBackupState(nextVault.walletId, state).catch(() => setToast('Wallet created; backup reminder could not be saved'));
    completed(nextVault);
    if (generatedFallback) setGeneratedFallbackNotice({ walletName: walletLabel(nextVault), address: nextVault.address, password: generatedFallback, origin: 'created' });
  }
  function imported(nextVault: EncryptedVault, _nextMaterial: WalletMaterial, passkey: WalletPasskeyState | null, generatedFallback?: string) {
    const state: WalletBackupState = { origin: 'imported', backedUp: true };
    setBackupStates((current) => ({ ...current, [nextVault.walletId]: state }));
    setPasskeyStates((current) => ({ ...current, [nextVault.walletId]: passkey }));
    void saveBackupState(nextVault.walletId, state).catch(() => setToast('Wallet imported; local backup status could not be saved'));
    completed(nextVault);
    if (generatedFallback) setGeneratedFallbackNotice({ walletName: walletLabel(nextVault), address: nextVault.address, password: generatedFallback, origin: 'imported' });
  }
  function unlocked(nextMaterial: WalletMaterial, migratedVault?: EncryptedVault) {
    if (migratedVault) {
      setVault(migratedVault);
      setWallets((current) => current.map((item) => item.walletId === migratedVault.walletId ? migratedVault : item));
    }
    const count = 'qt' in nextMaterial ? nextMaterial.qt.receiveAddressCount ?? 1 : 1;
    setReceiveAddressCount(count);
    void saveReceiveAddressCount((migratedVault ?? vault)?.walletId ?? nextMaterial.walletId, count);
    setDialog(null);
    setToast('Wallet unlocked');
  }
  function backedUp() {
    if (!vault) return;
    const state: WalletBackupState = { origin: backupStates[vault.walletId]?.origin ?? 'imported', backedUp: true };
    setBackupStates((current) => ({ ...current, [vault.walletId]: state }));
    void saveBackupState(vault.walletId, state).catch(() => setToast('Backup downloaded; local reminder could not be updated'));
  }
  function copy(value: string) { navigator.clipboard.writeText(value).then(() => setToast('Address copied'), () => setToast('Copy failed')); }
  async function generateReceiveAddress() {
    if (!vault || derivingAddress) return;
    const addresses = vault.receiveAddresses;
    if (!addresses?.length) return setToast('This wallet does not support address derivation');
    const currentCount = Math.max(1, Math.min(addresses.length, receiveAddressCount ?? vault.receiveAddressCount ?? 1));
    if (currentCount >= addresses.length) {
      setToast('Unlock once to extend the receive-address window');
      setDialog('unlock');
      return;
    }
    setDerivingAddress(true);
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const nextCount = currentCount + 1;
      await saveReceiveAddressCount(vault.walletId, nextCount);
      setReceiveAddressCount(nextCount);
      const address = addresses[nextCount - 1];
      try {
        await navigator.clipboard.writeText(address);
        setToast(`Receive address #${nextCount - 1} generated and copied`);
      } catch {
        setToast(`Receive address #${nextCount - 1} generated`);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Unable to generate receive address');
    } finally {
      setDerivingAddress(false);
    }
  }
  async function deleteLocal() {
    if (!vault) return;
    const deletedWalletId = vault.walletId;
    const next = await removeVault(deletedWalletId);
    setVault(next);
    setWallets(await loadVaults());
    setBackupStates((current) => {
      const updated = { ...current };
      delete updated[deletedWalletId];
      return updated;
    });
    setPasskeyStates((current) => {
      const updated = { ...current };
      delete updated[deletedWalletId];
      return updated;
    });
    if (next) {
      try {
        const nextBackupState = await loadBackupState(next.walletId);
        setBackupStates((current) => ({ ...current, [next.walletId]: nextBackupState }));
      } catch { /* Optional local reminder state. */ }
    }
    setReceiveAddressCount(next ? await loadReceiveAddressCount(next.walletId) ?? next.receiveAddressCount ?? 1 : null);
    setSummary(null);
    transactionsRef.current = [];
    setTransactions([]);
    setFundedAddresses([]);
    setReceiveMonitor(null);
    setSendMonitor(null);
    setDeleteWalletOpen(false);
    hasAccountData.current = false;
    setView('overview');
  }

  async function switchWallet(walletId: string): Promise<boolean> {
    if (!vault || switchingWallet) return false;
    if (walletId === vault.walletId) return true;
    setSwitchingWallet(true);
    refreshSequence.current += 1;
    setAccountLoading(true);
    setReceiveMonitor(null);
    setSendMonitor(null);
    try {
      const next = await activateVault(walletId);
      let cached = null;
      try { cached = await loadAccountCache(next.walletId); } catch { /* Disposable public cache. */ }
      setStatus(cached?.status ?? null);
      setSummary(cached?.summary ?? null);
      transactionsRef.current = cached?.transactions ?? [];
      setTransactions(transactionsRef.current);
      setFundedAddresses(cached?.fundedAddresses ?? []);
      hasAccountData.current = Boolean(cached);
      const saved = await loadReceiveAddressCount(next.walletId);
      let nextBackupState: WalletBackupState | null = null;
      try { nextBackupState = await loadBackupState(next.walletId); } catch { /* Optional local reminder state. */ }
      let nextPasskeyState: WalletPasskeyState | null = null;
      try { nextPasskeyState = await loadPasskeyState(next.walletId); } catch { /* Password fallback remains available. */ }
      setReceiveAddressCount(saved ?? next.receiveAddressCount ?? 1);
      setBackupStates((current) => ({ ...current, [next.walletId]: nextBackupState }));
      setPasskeyStates((current) => ({ ...current, [next.walletId]: nextPasskeyState }));
      setVault(next);
      setView('overview');
      setToast('Wallet switched');
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Unable to switch wallet');
      setAccountLoading(false);
      return false;
    } finally {
      setSwitchingWallet(false);
    }
  }

  async function openBackupFor(walletId: string) {
    if (!vault) return;
    if (!(await switchWallet(walletId))) return;
    setDialog('backup');
  }

  function dismissPasskeyRecommendation() {
    try { localStorage.setItem(PASSKEY_RECOMMENDATION_SEEN_KEY, '1'); } catch { /* A one-time UI hint must never affect wallet access. */ }
    setPasskeyRecommendationSeen(true);
  }

  function openPasskeySetup(walletId: string) {
    dismissPasskeyRecommendation();
    setWalletSecurityRequest({ walletId, tab: 'passkey' });
  }

  if (vault === undefined) return <div className="boot"><Logo /><span /></div>;
  const backupCandidates = localWallets;
  const unbackedWallets = backupCandidates.filter((wallet) => {
    const state = backupStates[wallet.walletId];
    return state?.origin === 'created' && !state.backedUp;
  });
  const backupWarningWallet = displayVault && unbackedWallets.some((wallet) => wallet.walletId === displayVault.walletId)
    ? displayVault
    : unbackedWallets[0] ?? null;
  const activeBackupState = displayVault ? backupStates[displayVault.walletId] ?? null : null;
  const activePasskeyState = displayVault ? passkeyStates[displayVault.walletId] ?? null : null;
  const backupRequired = Boolean(backupWarningWallet);
  const walletAlertCount = Number(backupRequired) + Number(showPasskeyRecommendation);
  const walletAlertOffsetClass = walletAlertCount === 2 ? ' below-two-wallet-alerts' : walletAlertCount === 1 ? ' below-wallet-alert' : '';
  const staleChain = Boolean(status?.stale || status?.core_available === false);
  const chainNoticeMode = networkError ? 'error' : staleChain ? 'syncing' : status && !status.synced ? 'syncing' : '';
  const chainNotice = networkError
    ? `Chain data is temporarily unavailable · ${networkError}`
    : staleChain
      ? `TensorCash Core is responding slowly · confirmed balance and history remain available from index height ${status?.indexed_height.toLocaleString() ?? '—'}`
    : status && !status.synced
      ? `Synchronizing blockchain · ${status.indexed_height.toLocaleString()} / ${status.core_height.toLocaleString()} · ${status.lag.toLocaleString()} blocks remaining`
      : '';
  return (
    <div className="app-shell">
      <header className="topbar">
        <Logo />
        <div className="topbar-right">
          <StatusBadge status={status} error={networkError} />
          {displayVault && <WalletSwitcher wallets={wallets} active={displayVault} switching={switchingWallet} onSwitch={(walletId) => void switchWallet(walletId)} onManage={() => setView('wallets')} />}
          {displayVault && <button className="compact-address" onClick={() => copy(currentReceiveAddress(displayVault, activeReceiveAddressCount))}>{short(currentReceiveAddress(displayVault, activeReceiveAddressCount))} <span>⧉</span></button>}
          <a className="github-link" href={SOURCE_URL} target="_blank" rel="noreferrer" aria-label="Open TensorCash Wallet on GitHub" title="GitHub"><GithubIcon /></a>
          <SecurityCheckLink />
        </div>
      </header>
      {walletAlertCount > 0 && <div className="wallet-alert-stack">
        {backupWarningWallet && displayVault && <RecoveryBackupWarning vault={backupWarningWallet} additionalCount={Math.max(0, unbackedWallets.length - 1)} active={backupWarningWallet.walletId === displayVault.walletId} onBackup={() => void openBackupFor(backupWarningWallet.walletId)} />}
        {showPasskeyRecommendation && passkeyRecommendationWallet && <PasskeyRecommendation vault={passkeyRecommendationWallet} additionalCount={Math.max(0, passwordOnlyWallets.length - 1)} onSetup={() => openPasskeySetup(passkeyRecommendationWallet.walletId)} onDismiss={dismissPasskeyRecommendation} />}
      </div>}
      <div className={`chain-notice${walletAlertOffsetClass} ${chainNoticeMode ? `is-visible ${chainNoticeMode}` : ''}`} role="status" aria-live="polite" aria-hidden={!chainNoticeMode}><i /> <span>{chainNotice}</span>{networkError && <button onClick={() => void refresh()}>Retry</button>}</div>
      {storageWarning && <div className={`storage-warning${walletAlertOffsetClass}`} role="alert"><strong>Local storage recovery notice</strong><span>{storageWarning}</span><button type="button" onClick={() => setStorageWarning('')} aria-label="Dismiss storage warning">×</button></div>}
      {!displayVault ? <EmptyHome onCreate={() => setDialog('create')} onImport={() => setDialog('import')} /> : <main className="wallet-layout"><div className="wallet-content"><Overview vault={displayVault} receiveAddressCount={activeReceiveAddressCount} summary={summary} status={status} transactions={transactions} fundedAddresses={fundedAddresses} loading={accountLoading} showBackup={activeBackupState?.origin === 'created' && !activeBackupState.backedUp} market={market} currencies={currencies} displayCurrency={displayCurrency} onCopy={copy} onBackup={() => setDialog('backup')} onReceive={() => setView('receive')} onView={setView} /></div></main>}
      {displayVault && view !== 'overview' && <ToolDrawer key={view} title={title} onClose={() => setView('overview')}>
        {view === 'receive' && <ReceivePanel vault={displayVault} receiveAddressCount={activeReceiveAddressCount} onCopy={copy} onGenerate={generateReceiveAddress} onSelect={openReceiveMonitor} generating={derivingAddress} />}
        {view === 'activity' && <Activity transactions={transactions} address={currentReceiveAddress(displayVault, activeReceiveAddressCount)} />}
        {view === 'addresses' && <AddressBalancesPanel vault={displayVault} receiveAddressCount={activeReceiveAddressCount} addresses={fundedAddresses} onCopy={copy} />}
        {view === 'send' && vault && <SendPanel vault={vault} wallets={wallets} passkeyState={activePasskeyState} receiveAddressCount={activeReceiveAddressCount} fundedAddresses={fundedAddresses} onVaultUpdated={(updatedVault) => {
          setVault(updatedVault);
          setWallets((current) => current.map((item) => item.walletId === updatedVault.walletId ? updatedVault : item));
        }} onSent={async (pendingTransaction, sentWalletAddresses) => {
          const alreadyTracked = transactionsRef.current.some((transaction) => transaction.txid === pendingTransaction.txid);
          const nextTransactions = prependLocalPending(transactionsRef.current, pendingTransaction);
          const nextSummary = summary && !alreadyTracked ? addPendingToSummary(summary, pendingTransaction) : summary;
          transactionsRef.current = nextTransactions;
          setTransactions(nextTransactions);
          if (nextSummary) setSummary(nextSummary);
          if (status && nextSummary) {
            void saveAccountCache(displayVault.walletId, {
              status,
              summary: nextSummary,
              transactions: nextTransactions,
              fundedAddresses,
            }).catch(() => { /* A local cache failure must not affect the accepted transaction. */ });
          }
          setToast('Transaction accepted by TensorCash Core');
          setView('overview');
          setSendMonitor({
            transaction: pendingTransaction,
            addresses: sentWalletAddresses,
          });
          window.setTimeout(() => void refresh(), 350);
        }} />}
        {view === 'settings' && vault && <div className="settings-drawer enter"><div className="settings-intro"><span>Wallet settings</span><p>Wallet access, recovery, market display, network access and this device's encrypted wallet storage.</p></div><WalletSecurityPanel passkeyState={activePasskeyState} onManage={() => setWalletSecurityRequest({ walletId: displayVault.walletId, tab: 'password' })} /><RecoveryPanel onBackup={() => setDialog('backup')} /><SettingsPanel currency={displayCurrency} currencies={currencies} onCurrencyChange={(currency) => setDisplayCurrency(saveDisplayCurrency(currency))} onSaved={refresh} onDelete={() => setDeleteWalletOpen(true)} /></div>}
        {view === 'wallets' && <WalletsPanel wallets={wallets} activeId={displayVault.walletId} switching={switchingWallet} onSwitch={(walletId) => void switchWallet(walletId)} onCreate={() => setDialog('create')} onImport={() => setDialog('import')} />}
      </ToolDrawer>}
      {receiveMonitor && <ReceiveWatchModal address={receiveMonitor} onClose={closeReceiveMonitor} onCopy={copy} />}
      {sendMonitor && <SendWatchModal transaction={sendMonitor.transaction} addresses={sendMonitor.addresses} onClose={closeSendMonitor} />}
      {deleteWalletOpen && displayVault && <DeleteWalletModal wallet={displayVault} onClose={() => setDeleteWalletOpen(false)} onConfirm={deleteLocal} />}
      {walletSecurityRequest && displayVault && <WalletSecurityModal wallets={backupCandidates} initialWalletId={walletSecurityRequest.walletId} initialTab={walletSecurityRequest.tab} passkeyStates={passkeyStates} onClose={() => setWalletSecurityRequest(null)} onChanged={(updatedVault, updatedPasskey) => {
        setVault((current) => current?.walletId === updatedVault.walletId ? updatedVault : current);
        setWallets((current) => current.map((item) => item.walletId === updatedVault.walletId ? updatedVault : item));
        setPasskeyStates((current) => ({ ...current, [updatedVault.walletId]: updatedPasskey }));
      }} />}
      {dialog && <Modal dialog={dialog} vault={vault ?? null} passkeyState={activePasskeyState} requestedReceiveAddressCount={activeReceiveAddressCount} onClose={() => setDialog(null)} onCreated={created} onImported={imported} onUnlocked={unlocked} onBackedUp={backedUp} />}
      {generatedFallbackNotice && <GeneratedFallbackModal notice={generatedFallbackNotice} onDone={() => setGeneratedFallbackNotice(null)} />}
      {toast && <div className="toast">✓ {toast}</div>}
      <footer><span>TensorCash Wallet · Non-custodial by design</span><span>The gateway stores no wallet data · <b className="app-version">v{APP_VERSION}</b></span></footer>
    </div>
  );
}
