# Threat model

This document describes the v1.0.1 design after remediation of the independent 11 August 2026 review. The review and this document are not a certification.

## Security goals

- A server or explorer database compromise must not directly reveal wallet passwords or signing keys.
- A copied locked browser vault should require an offline password attack and should detect tampering.
- The browser should sign only the transaction the user approved, within explicit network and fee policy.
- Indexed output errors must not cause an asset-bearing, spent, mismatched, or immature output to enter ordinary TSC coin selection.
- Raw Core RPC, the gateway listener, RPC credentials, and the explorer database must not be reachable from the public network.
- A Qt-compatible recovery export must preserve spendability and must never silently convert an encrypted Qt wallet to an unencrypted one.

Availability, anonymity, protection of an already-compromised endpoint, and recovery without a user backup are not guaranteed.

## Protected assets

- Core descriptor and ML-DSA secret keys, complete recovery metadata, and Qt wallet bytes.
- Wallet passwords, Qt passwords, decrypted in-memory material, and browser vault plaintext.
- Intended network, recipient, amount, change, selected inputs, absolute fee, and fee rate.
- Core RPC credentials and access to mutating RPC methods.
- Integrity of the frontend release, dependency graph, TLS/DNS configuration, and GitHub tag/release.
- User privacy: the association between IP address, browser metadata, public address watch set, and transaction activity.

## Trust zones and actors

### Trusted for key confidentiality

- The user's browser engine, operating system, and the wallet JavaScript/WebAssembly actually executed.
- The HTTPS origin, DNS/registrar, TLS keys, Nginx configuration, release directory, build pipeline, source/dependency accounts, and maintainers who can publish code.
- Browser cryptographic random generation and Web Crypto implementations.

These components can steal keys at unlock time if compromised. The non-custodial gateway design does not remove this frontend supply-chain trust.

### Not trusted with signing authority

- The public gateway and its operator.
- The explorer index and Core responses received through the gateway.
- The network between browser and gateway (protected for transport by HTTPS but not assumed honest without it).
- Other web origins attempting cross-origin API use.

### Potential attackers

- An attacker who copies IndexedDB or an exported backup.
- A malicious/compromised gateway, indexer, Core node, reverse proxy, or server account.
- A remote client sending malformed/large API requests or probing internal ports.
- A dependency, package-registry, GitHub, DNS, or deployment-pipeline attacker.
- Malware, a browser extension, clipboard hijacker, or person with access to an unlocked device.

## Data flows and disclosure

The browser sends public addresses for balance/history/UTXO queries and sends signed raw transaction hex for mempool test and broadcast. Although these are not secret keys, they are sensitive financial metadata. A gateway can correlate the submitted watch set, IP address, timing, and broadcast transaction. Public address GET routes may also appear in ordinary Nginx access logs.

Passwords, descriptors, wallet files, vault ciphertext, and private/recovery keys have no gateway data flow. Any change that introduces such a request is a security-boundary change requiring explicit review.

## Threats and mitigations

| Threat | Mitigation | Remaining risk |
| --- | --- | --- |
| Offline theft of IndexedDB | Argon2id (64 MiB, three iterations by default), random salt, AES-256-GCM, authenticated metadata | Password strength and future hardware determine guessing cost |
| Vault metadata/ciphertext tampering | AES-GCM authentication and validation of wallet/network/address invariants | Rollback to an older valid vault is not prevented by a server counter |
| Gateway/database theft of keys | No accounts, wallet upload, signing key, password, or server wallet store | Addresses, IP metadata, signed transactions, and logs can affect privacy |
| Malicious UTXO substitution | Browser ownership/script/value checks plus gateway `gettxout` verification | A bug shared by client/gateway or malicious Core can still mislead availability/view |
| Native-asset destruction | Reject `gettxout` results containing native-asset metadata | Consensus/RPC field changes require release-vector updates |
| Spent or immature input | Core `gettxout`, confirmation checks, and 100-block coinbase maturity | Reorgs and races can make a valid plan fail at broadcast |
| Recipient/change/fee manipulation | Complete transaction plan validation before local signing; absolute and rate ceilings | Compromised frontend/OS can alter both UI and checks |
| Arbitrary Core RPC access | Fixed RPC method allowlist; Core loopback/auth; no Nginx RPC proxy | Compromise of gateway OS/user can call methods allowed to that RPC identity |
| Public Gunicorn/Core/database exposure | Loopback binds, systemd localhost IP policy, firewall, only Nginx public | Misconfiguration must be detected after every deployment |
| Cross-origin transaction relay | Exact origin checks for mutation endpoints, JSON content type, Nginx rate limit | CORS does not stop non-browser clients; signed transaction relay remains public-service abuse risk |
| API denial of service | Bounded address/page/body/UTXO/mempool sizes, 50-call RPC chunks, in-app per-IP token bucket, timeouts, mempool cache and Nginx limit | Distributed resource exhaustion and Core dependency failures remain possible |
| Frontend substitution/supply-chain attack | HTTPS, exact-origin `connect-src`, no third-party runtime assets, exact dependency pins, vendored-runtime checksum, reviewed immutable tagged builds | Anyone controlling origin/build/dependency can still ship key-stealing code |
| Clickjacking/data exfiltration | `frame-ancestors 'none'`, X-Frame-Options, no-referrer, restrictive permissions policy | Browser/extension compromise bypasses web-origin controls |
| Unlocked-session misuse | Fresh password verification for send, backup, and recovery access | Re-verification is not MFA; keyloggers can observe it |
| Backup loss | Prominent export workflow and independent-copy guidance | No server reset/recovery exists |
| Qt export loses encryption | Preserve original Qt encryption records/state; encrypted browser vault wraps imported material | Original unencrypted Qt exports remain plaintext; compatibility bugs can corrupt a backup |
| Live SQLite copy corruption | SQLite online `.backup` or stop writer; restore `integrity_check` | Stale snapshots require index catch-up or rebuild |

## Server compromise analysis

A gateway host compromise can:

- return false balances/history/fees and censor or delay broadcasts;
- observe queried public addresses, IP metadata, and signed transactions;
- serve a malicious frontend if the same host controls static assets;
- misuse its limited Core RPC credentials and degrade node availability.

It should not find wallet passwords or keys in the gateway/database because they are never sent. However, when the same compromised host serves the frontend, it can replace JavaScript and steal keys the next time a user unlocks. Therefore “non-custodial gateway” does not mean the production web server can be treated as low impact.

The local network boundary limits remote exploitation blast radius:

- the reverse proxy exposes only the intended HTTPS routes;
- the gateway listens only on loopback;
- Core RPC listens at `127.0.0.1:<rpc-port>` with authentication;
- explorer SQLite is a mode-`ro` local file, not a database socket;
- systemd denies non-local IP traffic for the gateway process.

This boundary must be verified from both the host and an external machine. A configuration value in source control is not evidence of the live listener state.

## Client compromise analysis

A malicious extension, browser, operating system, clipboard manager, served script, or physical attacker with an unlocked session can observe passwords and decrypted material, replace a displayed address, or authorize a different transaction. JavaScript attempts to wipe owned byte arrays, but runtimes may retain copies.

Use a dedicated, patched browser profile with minimal extensions; verify recipients out of band for important payments; lock the wallet/device; and keep only appropriate amounts in a browser wallet. Hardware-wallet isolation is outside v1.0.1.

## Assumptions requiring continuous validation

- TensorCash Core's RPC field names and native-asset representation match gateway checks.
- ML-DSA key sizes, address derivation, signature format, and transaction serialization match active consensus.
- Qt descriptor-cache and encrypted-key serialization remain compatible with the supported Core/Qt release.
- Explorer schema and satoshi values are interpreted consistently and cannot overflow client assumptions.
- Browser Argon2id/Web Crypto implementations provide the expected semantics and secure randomness.
- CSP permits only the reviewed local WebAssembly requirements and no new remote runtime dependency.

Each public release should record the Core version used for vectors and restore tests.

## Residual and accepted risks

- The chosen gateway can learn a wallet's public address watch set and correlate activity.
- A gateway can censor, omit, delay, or lie about chain data and fee estimates.
- A compromised web origin or endpoint can steal unlocked wallet material.
- Password strength controls offline vault resistance; the minimum UI length alone is not a strength guarantee.
- Browser memory cannot guarantee zeroization.
- Reorganizations and mempool policy changes can invalidate previously observed state.
- Password re-verification is not a second factor.
- There is no account reset, server recovery copy, transaction reversal, or guaranteed service availability.

## Security-boundary change checklist

Update this threat model and require focused review before any change that:

- sends new wallet/client data to the gateway;
- adds an RPC method, database write, account/session, telemetry, remote asset, or third-party script;
- changes vault/backup schemas, cryptography, derivation, signing, or transaction policy;
- changes the Nginx public route set, Gunicorn/Core bind addresses, service user, filesystem permissions, or CORS policy;
- changes supported Core/Qt versions or native-asset RPC fields.
