# Changelog

All notable changes to TensorCash Web Wallet are documented here. Releases use
[Semantic Versioning](https://semver.org/) and Git tags use the `v` prefix.

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
