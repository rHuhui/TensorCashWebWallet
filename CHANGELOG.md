# Changelog

## 1.0.8 - 2026-08-21

- Add optional, per-wallet Passkey authorization for unlock, backup, signing,
  and wallet-access management while keeping password fallback available in
  every sensitive flow.
- Preserve the existing encrypted-vault schema and password decryption path so
  every pre-1.0.8 wallet continues to unlock with its original password without
  migration.
- Let newly created and imported wallets choose Passkey-first setup without
  keyboard password entry or explicitly choose password-only setup without a
  forced Passkey prompt.
- Add a focused wallet-access modal with an explicit wallet selector, password
  changes, legacy-wallet Passkey enrollment after original-password
  verification, and Passkey-authenticated removal with password fallback.
- Add persistent floating backup warnings for every unbacked local wallet and a
  one-time Passkey recommendation for password-only wallets, with correct
  stacked positioning when both notices are present.
- Add an animated independent-security-check prompt explaining DNS and local
  network hijacking risks before users enter a wallet password.

No wallet or backup migration, gateway API change, Core upgrade, or operator
action is required. Existing wallet passwords remain valid. Passkey support is
optional and requires a compatible browser on the same trusted HTTPS origin;
the wallet password remains the recovery and compatibility fallback.

## 1.0.7 - 2026-08-18

- Add a live TSC/USDT reference price from SafeTrade with an independent,
  server-cached fallback and a visible stale-price warning.
- Cache the last valid market quote for ten minutes so a temporary upstream
  failure does not immediately remove wallet valuation data.
- Add daily-cached USD exchange rates and a searchable local display-currency
  preference without changing the wallet's native TSC accounting.
- Make estimated wallet value the primary overview metric while retaining the
  exact TSC balance and unit price immediately alongside it.
- Add stable loading feedback and refine value, balance, and quote alignment
  across desktop and mobile layouts.

No wallet migration, password change, backup-format change, gateway API change,
or Core upgrade is required for this release.

## 1.0.5 - 2026-08-16

- Preserve the authenticated encrypted-wallet envelope when receive-address UI
  state advances, preventing valid existing passwords from being rejected.
- Retain the original Argon2id/AES-256-GCM format and six-character legacy
  unlock compatibility; existing wallets and backups require no migration.
- Enrich confirmed and pending wallet history with source, recipient, input,
  and output addresses while filtering wallet-owned change from counterparties.
- Accumulate multiple live incoming payments and show From/To details in both
  receive and send monitors.
- Collapse duplicate overview reads into one request and deduplicate concurrent
  identical gateway calls.
- Improve pending activity feedback, wallet switching, contextual icons, and
  password-entry diagnostics without retaining decrypted wallet material.

## 1.0.4 - 2026-08-13

- Add standard TensorCash P2WSH recipient support while preserving P2WPKH-only
  wallet inputs and change outputs.
- Validate witness-v0 recipient programs and reject unsupported address types,
  mixed-case addresses, and invalid network prefixes before signing.
- Calculate destination dust thresholds and transaction fees from the exact
  recipient script size, including P2WSH outputs.
- Add a regression vector for P2WSH output construction, local P2WPKH input
  signing, and reviewed fee-rate enforcement.

## 1.0.3 - 2026-08-13

- Keep indexed wallet balances and confirmed transaction history available when
  TensorCash Core RPC is briefly slow or unavailable.
- Add bounded public-read RPC timeouts, last-known-good chain and mempool
  snapshots, retry backoff, and single-refresh concurrency control.
- Expose explicit stale/Core availability metadata so the wallet can warn users
  without replacing valid indexed data with a generic 503 response.
- Preserve strict fail-closed behavior for UTXO verification, transaction policy
  testing, and transaction broadcast.
- Add safe RPC operation/duration diagnostics without logging wallet addresses,
  request bodies, credentials, or signed transactions.

## 1.0.2 - 2026-08-12

- Changed hosted-build verification so the visitor's browser downloads the
  GitHub Pages build and live wallet files independently, computes both
  SHA-256 values locally, and compares every file byte for byte.
- Added a wallet-header security shortcut to the public build verifier.
- Removed any wallet-server verification/download verdict from the trust path;
  the wallet API remains unrelated to frontend verification.

All notable changes to TensorCash Web Wallet are documented here. Releases use
[Semantic Versioning](https://semver.org/) and Git tags use the `v` prefix.

## [1.0.1] - 2026-08-12

Security and correctness patch following the independent 11 August 2026 review.

### Fixed

- Apply the BIP341 TapTweak to Core `tr()` descriptor receive addresses, with
  the published BIP86 vector as a regression test.
- Exclude valid unsupported Taproot/ML-DSA outputs from P2WPKH coin selection
  without disabling spendable P2WPKH funds, and show the excluded amount.
- Disable Send up front for receive/watch-only ML-DSA wallets and clarify the
  current capability scope.
- Reserve a fresh internal descriptor address for change and persist the
  advanced counter before broadcast.
- Convert percentage-based high fees from a hard failure into an explicit user
  confirmation while retaining the absolute fee ceiling.
- Require 12-character passwords for new encryption, add strength guidance and
  retain read/migration compatibility for six-character v1.0.0 vaults.
- Ignore and visibly report isolated malformed IndexedDB wallet records rather
  than hiding every healthy wallet.
- Remove unnecessary five-minute React retention of decrypted wallet material.
- Correct malformed Core RPC/preflight response handling, pagination limits,
  SQLite connection lifetime and RPC credential representation.

### Security

- Restrict production `connect-src` to same-origin plus exact build-time gateway
  origins; development loopback permissions no longer ship in production.
- Add gateway per-IP token-bucket limiting, 50-call Core RPC chunks, a 500-UTXO
  candidate ceiling and a 500-transaction mempool decode ceiling.
- Pin BIP32/SQLite dependencies exactly and verify the vendored ML-DSA runtime
  against SHA-256 `7b13b733ba96c1a36d79e4f31175b53d6a962bf8119452ab5ef48dae2db11b83`.
- Split test dependencies from runtime requirements and publish sanitized
  loopback-only Nginx/systemd deployment references.

### Compatibility

- Existing v1.0.0 encrypted Web Wallet backups, including six-character legacy
  passwords, remain decryptable. New or newly imported wallets require 12+
  characters.
- Key-path `tr(KEY)` receive descriptors use BIP341. `rawtr()` and tapscript-tree
  `tr(KEY,TREE)` descriptors are rejected rather than derived incompletely.
- Target TensorCash Core version: v1.1.0. ML-DSA remains import-only and
  receive/watch-only in this release.

## [1.0.0] - 2026-08-11

First public release candidate.

### Added

- Non-custodial browser wallet creation, multi-wallet management, password-encrypted local storage, backup, import, and Qt/Core-compatible address derivation.
- Confirmed and unconfirmed balances, transaction history, funded-address inspection, local transaction signing, Core policy testing, and broadcast monitoring.
- Same-origin stateless gateway for indexed chain reads and signed-transaction relay.
- Responsive wallet UI, animated receive/send confirmation monitors, and visible application version metadata.
- Production Nginx/systemd references, security policy, architecture, threat model, and GitHub release checklist.

### Security

- Gateway and TensorCash Core RPC are restricted to loopback; Nginx is the only public wallet service.
- Wallet passwords, private keys, descriptors, wallet files, and decrypted vault data never cross the gateway boundary.
- The explorer SQLite index is opened read-only and is not exposed as a network database.

### Release note

This release has not yet completed an independent security audit. Use small
amounts until the published build, transaction vectors, and Qt/Core restore
compatibility have been independently reviewed.
