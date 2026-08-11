# Architecture

TensorCash Web Wallet v1.0.1 separates custody from chain access. The browser owns wallet state and signing; the public service supplies chain observations and relays a transaction that is already signed.

## Deployment topology

```text
User browser
  | HTTPS
  v
Reverse proxy (public TLS, CSP, body/rate limits, static web/dist)
  | HTTP over loopback only
  v
Python gateway (loopback only, no accounts or wallet database)
  |                                  |
  | read-only filesystem access      | authenticated JSON-RPC, loopback only
  v                                  v
explorer.sqlite3                 TensorCash Core
(local SQLite file)              (127.0.0.1:<rpc-port>)
  ^
  | local writer
TensorCash explorer indexer
```

There is no network SQL database in this design. SQLite is an ordinary file on the server. The explorer indexer writes it; the gateway opens a separate read-only connection with URI `mode=ro` and `PRAGMA query_only=ON`. The file is never served by Nginx and the gateway service account does not require write permission.

Both the gateway process and Core RPC must listen on loopback. An application environment value is not sufficient evidence because a process manager can override it on the command line. The HTTPS reverse proxy is the only public entry point.

## Components

### Browser application

The React/Vite client is responsible for:

- creating or parsing supported Core/Qt SQLite descriptor wallets;
- decrypting encrypted Qt descriptors after local password entry;
- encrypting wallet material in the Web vault with Argon2id + AES-256-GCM;
- maintaining issued receive addresses and a bounded public watch set;
- validating gateway responses and transaction policy;
- deriving keys and signing in browser memory;
- exporting recovery data after password re-verification.

IndexedDB stores encrypted vault envelopes and public metadata needed to list a locked wallet. It is not a durable recovery service. Clearing browser storage removes the local copy.

### Gateway

`server/app.py` is a narrow adapter between public HTTP JSON and local chain services. It:

- validates addresses and bounded request shapes;
- applies an in-process per-IP limit to expensive wallet reads, UTXO
  verification, policy testing and broadcast attempts;
- aggregates confirmed history from the local explorer index;
- reads recent mempool transactions from Core through a short-lived in-memory cache;
- rechecks candidate UTXOs through Core `gettxout` before returning them;
- obtains a fee estimate;
- calls `testmempoolaccept` before broadcast;
- sends only a client-signed transaction through `sendrawtransaction`.

The process does not have user accounts, sessions, a wallet table, an upload endpoint, or a write connection to the explorer database. Public addresses and signed transaction hex are necessarily processed transiently. They must not be added to application logs or persistent analytics.

### Core RPC adapter

`server/rpc.py` is the only Core RPC client. It allows only:

- `getblockchaininfo`
- `getrawmempool`
- `getrawtransaction`
- `gettxout`
- `estimatesmartfee`
- `testmempoolaccept`
- `sendrawtransaction`
- `validateaddress`

An arbitrary RPC method received from a browser cannot pass through this adapter. Network isolation and RPC authentication remain required even with the allowlist.

### Explorer index

The explorer database is a performance index, not a custody system. Core remains authoritative for current chain height, mempool policy, and UTXO spendability. A database snapshot can improve recovery time, but the index should be rebuildable from the node.

## Browser/gateway protocol

The current public routes are:

| Route | Purpose | Sensitive data allowed |
| --- | --- | --- |
| `GET /api/v1/status` | Core/index synchronization | None |
| `GET /api/v1/address/<address>/summary` | One public address summary | Public address |
| `GET /api/v1/address/<address>/transactions` | Confirmed history | Public address |
| `POST /api/v1/wallet/overview` | Aggregate a bounded address watch set | Public addresses only |
| `GET /api/v1/address/<address>/utxos` | Verified spendable outputs | Public address |
| `POST /api/v1/wallet/utxos` | Verified UTXOs for a watch set | Public addresses only |
| `GET /api/v1/fees` | Core fee estimate | None |
| `POST /api/v1/transactions/test` | Core mempool policy check | Signed transaction hex |
| `POST /api/v1/transactions/broadcast` | Test then relay | Signed transaction hex |

No endpoint accepts a password, private key, descriptor, unsigned signing plan, wallet file, or encrypted vault. Request bodies are limited, wallet queries are capped at 200 addresses, UTXO candidate queries at 500, mempool cache fills at 500 transactions, and Core JSON-RPC batches at 50 calls.

## Transaction flow

```text
1. Browser sends public watch addresses.
2. Gateway queries the local SQLite index for candidate history/outputs.
3. Gateway asks local Core to verify each candidate output and rejects spent,
   mismatched, immature coinbase, or native-asset-bearing outputs.
4. Browser independently verifies ownership, script, value, network, recipient,
   change, absolute fee, and fee rate.
5. Browser signs locally.
6. Gateway asks Core to test the signed transaction.
7. If accepted, gateway broadcasts it and returns the txid.
```

Changing the gateway changes the source of chain observations and relay, not custody. A malicious gateway can omit, reorder, delay, or fabricate data and can censor a transaction. It should not be able to redirect funds if the browser's independent transaction validation is correct. Users still disclose their queried public address set and network metadata to the chosen gateway.

## Qt wallet compatibility and state

- Supported Qt/Core files are parsed with `sql.js` in browser memory and are not uploaded.
- Web-created wallets use encrypted Core descriptor records and the same password initially protects the Web vault and created Qt wallet.
- For an imported encrypted Qt wallet, the existing Qt password unlocks the imported descriptors. The user then chooses a Web Wallet password for the browser vault; these may differ.
- The encrypted browser material retains the Qt SQLite bytes plus supported descriptor secrets needed for local signing.
- Issuing receive/change addresses advances the relevant descriptor state stored in the encrypted vault. Export can also add standard Qt address-book/receive-request records so issued Web addresses appear after Qt restore.
- An imported file is returned unchanged only when no counter, compatibility repair, or missing receive metadata update is needed. Consumers must not use file-byte equality as a backup integrity rule.
- The exported Qt file retains its Qt encryption state. An unencrypted imported Qt wallet produces an unencrypted Qt-compatible export.

Compatibility is a release property, not an assumption. Release testing must restore a disposable exported wallet in the supported TensorCash Core/Qt version, compare derived receive/change addresses, and exercise a spend on the intended network or an isolated test environment.

## Origins and transport

Production browser traffic should use same-origin `/api/...` through the HTTPS reverse proxy. The browser never connects directly to the gateway's loopback port or to Core RPC. Mutation endpoints accept only configured exact origins. Production `connect-src` contains only same-origin plus exact gateway origins compiled through `VITE_ALLOWED_GATEWAY_ORIGINS`; wildcard HTTPS and loopback development sources are not shipped. The reverse proxy supplies TLS, CSP, clickjacking protection, body limits, and an additional rate limit.

The gateway's CORS policy is not an authentication mechanism for public chain reads. It reduces unauthorized browser-origin use of mutation endpoints; network binding, request validation, Core policy, and client-side signing provide the substantive security boundaries.

## Availability and backups

The server stores no wallet recovery copy. User recovery depends on an exported wallet backup and its password.

Operational data has different recovery properties:

- static assets and gateway code are restored from an immutable Git tag/release;
- the server-only environment file is restored from a restricted secrets vault;
- the explorer SQLite index is snapshotted with SQLite's online backup mechanism or while its writer is stopped, and can be rebuilt from Core;
- Core's own data/backup procedure is operated independently of the wallet gateway.

A release rollback must keep server code, frontend protocol, explorer schema, and Core behavior compatible. Document migrations before deployment and retain the immediately previous release.

## Deliberate omissions in v1.0.1

The gateway does not implement accounts, cloud backup, password reset, Google Authenticator, or server-side 2FA. A server-verifiable TOTP factor would create an account-to-secret database and a recovery policy that conflict with the stateless design. Sensitive local actions require fresh wallet-password verification. This is not a second factor; a future WebAuthn/passkey design would require a separate threat model and recovery review.

ML-DSA wallet exports are receive/watch-only: v1.0.1 neither creates ML-DSA
wallets nor signs an ML-DSA spend. Recovery uses an encrypted file plus password;
there is no seed phrase or server recovery copy.

Taproot receive derivation supports only Core key-path `tr(KEY)` descriptors.
`rawtr()` and `tr(KEY,TREE)` tapscript-tree descriptors are not imported as
derivable receive chains in v1.0.1; silently omitting the required script-tree
Merkle root would create a different output key.
