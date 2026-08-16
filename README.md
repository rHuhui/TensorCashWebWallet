# TensorCash Web Wallet

TensorCash Web Wallet v1.0.6 is a non-custodial, browser-first wallet for TensorCash. It creates password-encrypted, descriptor-based TensorCash Core/Qt `wallet.dat` wallets and can import supported Qt backups without uploading the file. End users do not need to run a full node; keys and transaction signing stay in their browser.

Source repository: [github.com/rHuhui/TensorCashWebWallet](https://github.com/rHuhui/TensorCashWebWallet)

> **Security notice:** v1.0.1 remediates the findings in the independent 11 August 2026 review, including the BIP341 Taproot derivation defect. The review is not a certification. Use small amounts until restore and spend vectors have also been independently exercised against the deployed TensorCash Core build. A compromised web origin, browser, extension, or operating system can steal unlocked wallet material.

The public repository is maintained and released by **rHuhui**. Some public Git
metadata records authorised AI-assisted development tool identities; those
authors worked on behalf of the maintainer and do not represent a second owner
or release authority.

## What it does

- Creates encrypted Core/Qt-compatible SQLite descriptor wallets in the browser.
- Imports supported `.dat`, `.bak`, `.wallet`, and encrypted Web Wallet backups locally.
- Encrypts the browser vault with Argon2id and AES-256-GCM in IndexedDB.
- Reads balances, history, fees, and spendable outputs through a stateless gateway.
- Builds, checks, and signs transactions in the browser; only signed transaction hex is relayed.
- Re-verifies indexed UTXOs through TensorCash Core and excludes native-asset outputs from ordinary TSC coin selection.
- Supports imported ML-DSA wallets for receive/watch-only use. v1.0.1 does not
  create or sign ML-DSA spends, and the Send action is disabled up front for
  wallets without a supported P2WPKH spend path.

There is **no 12-word seed phrase**. Recovery requires the exported `.dat` or
Web Wallet backup and its password. The server cannot reset the password or
recover a lost wallet.

The gateway has no user accounts and is not a database for wallet data. It transiently receives public addresses for balance/history requests and signed transaction hex for test/broadcast requests. It never needs a wallet password, private key, descriptor, recovery backup, or decrypted vault.

## Repository layout

- `web/` — React/Vite client, Qt wallet parser/exporter, encrypted local vault, and transaction signing.
- `server/` — Flask/Gunicorn read-and-broadcast gateway.
- `docs/ARCHITECTURE.md` — components, data flows, API boundary, and deployment topology.
- `docs/THREAT_MODEL.md` — trust assumptions, mitigations, and residual risks.
- `docs/EXTERNAL_REVIEW_REMEDIATION_1.0.1.md` — finding-by-finding remediation record for the 2026-08-11 external review.
- `SECURITY.md` — vulnerability reporting and production security requirements.
- `CONTRIBUTING.md` — contribution and pre-submission checks.
- `CHANGELOG.md` — user-visible changes for each SemVer release.

## Security boundary

- Wallet creation, import, password processing, decryption, and signing happen in the browser.
- The frontend must be delivered from a trusted, immutable HTTPS origin without third-party scripts, fonts, analytics, or tag managers.
- A hardened HTTPS reverse proxy is the only public wallet service.
- The Python gateway must bind only to loopback; it must never listen on a public interface.
- TensorCash Core RPC must bind only to loopback. It is not proxied by Nginx. The gateway also enforces a small RPC method allowlist.
- Chain history is a local SQLite file opened with `mode=ro` and `PRAGMA query_only=ON`. There is no network database listener to expose.
- RPC credentials and production environment files are server secrets. They must not be embedded in the Vite bundle or committed.

See [Architecture](docs/ARCHITECTURE.md) and [Threat model](docs/THREAT_MODEL.md) for the complete boundary.

## Requirements

- Node.js 22 or newer and npm with lockfile support.
- Python 3.10 or newer (3.11+ recommended for production).
- A synchronized TensorCash Core node with authenticated JSON-RPC on loopback.
- The TensorCash explorer indexer and its local SQLite database for gateway queries.
- For a public deployment: a hardened HTTPS reverse proxy, isolated service account, DNS name, and valid TLS certificate.

## Local development

Do not open `web/index.html` with a `file://` URL. Vite source modules require a local HTTP server.

Install and test the frontend:

```bash
npm ci
npm test
npm run typecheck
npm run dev
```

Open `http://127.0.0.1:5173/`.

To supply the example settings to both Vite and the Python process, export them in the current shell. Review the values first; the example RPC credentials are placeholders.

```bash
cp .env.example .env
set -a
. ./.env
set +a
```

The project deliberately does not auto-load the root `.env`. Populated `.env` files are ignored by Git.

Run the gateway in a separate terminal after TensorCash Core and the explorer index are available:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r server/requirements-dev.txt
python -m pytest server/tests
python -m server.app
```

The development server defaults to `127.0.0.1:9920`. Confirm the configured explorer SQLite path exists and the current user can read it.

Inspect a production-style frontend build locally:

```bash
npm run build
npm run preview
```

Open `http://127.0.0.1:4173/wallet/`. The production build uses `/wallet/` as
its public base path and serves only `web/dist/`, never the Vite development
server.

## Configuration

The gateway reads process environment variables; no secrets are compiled into it.

| Variable | Purpose | Safe production form |
| --- | --- | --- |
| `TSCWALLET_HOST` | Flask development bind address | `127.0.0.1` |
| `TSCWALLET_PORT` | Loopback gateway port | Operator-selected local port |
| `TSCWALLET_INDEX_DB` | Explorer SQLite path | Local absolute path |
| `TSCWALLET_RPC_URL` | TensorCash Core JSON-RPC | `http://127.0.0.1:<rpc-port>` |
| `TSCWALLET_RPC_USER` | Dedicated RPC username | Secret, server-side only |
| `TSCWALLET_RPC_PASSWORD` | Dedicated RPC password | Long random secret, server-side only |
| `TSCWALLET_ALLOWED_ORIGINS` | Exact browser origins allowed to mutate state | `https://app.example` |
| `TSCWALLET_RPC_TIMEOUT` | Core request timeout in seconds | `8` by default |
| `TSCWALLET_PUBLIC_RPC_TIMEOUT` | Short timeout for non-authoritative read enrichment | `2` seconds |
| `TSCWALLET_CHAIN_STATUS_CACHE_SECONDS` | Fresh lifetime for a successful chain snapshot | `5` seconds |
| `TSCWALLET_RPC_FAILURE_BACKOFF_SECONDS` | Delay before retrying a failed public snapshot | `5` seconds |
| `TSCWALLET_RPC_BATCH_SIZE` | Maximum Core calls in one JSON-RPC batch | `50` |
| `TSCWALLET_UTXO_CANDIDATE_LIMIT` | Maximum indexed UTXO candidates per wallet query | `500` |
| `TSCWALLET_MEMPOOL_LIMIT` | Maximum mempool transactions decoded per cache fill (`0` means the complete mempool and is recommended for wallet correctness) | `0` |
| `TSCWALLET_PUBLIC_READ_RATE` | Per-IP refill rate for expensive wallet/Core operations | `2` requests/second |
| `TSCWALLET_PUBLIC_READ_BURST` | Per-IP burst for expensive wallet/Core operations | `12` |
| `TSCWALLET_MAX_PAGE` | Maximum accepted API page number | `10000` |
| `VITE_WALLET_GATEWAY_URL` | Browser-facing gateway baked into the build | `https://app.example/wallet` |
| `VITE_ALLOWED_GATEWAY_ORIGINS` | Additional exact cross-origin gateways compiled into CSP and client policy | Empty for same-origin production |
| `VITE_SOURCE_URL` | Public source link baked into the build | Public repository URL |
| `VITE_EXPLORER_URL` | Public transaction explorer baked into the build | Trusted HTTPS explorer |

Never put `TSCWALLET_RPC_USER` or `TSCWALLET_RPC_PASSWORD` in a variable whose name begins with `VITE_`: Vite exposes those values to every browser.

## Public deployment

Sanitized Nginx, systemd and environment references are included under
`deploy/examples/`. They contain placeholders, not production credentials, and
must be reviewed for the target host. The required boundary is strict:

```text
Internet -> HTTPS reverse proxy -> loopback-only gateway
                                  |-> local explorer index (read-only)
                                  `-> authenticated loopback-only Core RPC
```

- Build and test from a clean tagged checkout; serve only `web/dist/` from an
  immutable release directory.
- Run the gateway as an unprivileged account, bind it to loopback and keep its
  environment file outside the repository and web root with mode `0600`.
- Keep Core RPC authenticated and loopback-only. Never proxy raw RPC to the
  browser or place RPC credentials in a `VITE_*` variable.
- Give the gateway read-only access to the explorer SQLite file. Do not expose a
  SQL listener or serve the database file through the web server.
- Enforce TLS, CSP (including `frame-ancestors`), request-body limits, rate
  limits, dotfile denial and exact allowed origins at the reverse proxy.
- Verify the live sockets from both the host and another machine after every
  deployment. The gateway, Core RPC and database must not accept direct public
  connections.
- Keep the previous immutable release for rollback and re-run health, CORS,
  CSP, transaction-test and broadcast checks after each switch.

## Wallet and server backups

Wallet recovery is a client responsibility; the server cannot recover a wallet.

- Export a recovery backup immediately and keep at least two independent offline copies. Keep its password separate.
- Newly created Qt wallets are encrypted and use the Web Wallet password for the Qt file created at creation time.
- Imported Qt backups preserve their original Qt encryption state and Qt password. The new Web Wallet password protects the browser vault and may be different.
- As receive/change addresses are issued, the exported Qt backup may update descriptor counters and standard Qt receive-request/address-book metadata. This keeps issued Web addresses visible and spendable after restore; do not assume every later export is byte-for-byte identical to the imported file.
- An originally unencrypted Qt wallet remains unencrypted as a Qt-compatible export, even though the browser copy is inside the encrypted Web vault. Treat that `.dat` file as plaintext key material.
- Test restoration with a disposable wallet before relying on a backup procedure. Never send a real backup to a maintainer or attach it to an issue.

The gateway contains no user-wallet database to back up. For server availability:

- Back up the server-only environment file into a secrets vault, not into source control.
- Create explorer database snapshots with SQLite's online `.backup` API or while the indexer is stopped. Do not copy the live database with a plain file copy while it is being written.
- Run `PRAGMA integrity_check` on a restored snapshot and record the explorer schema/Core versions. The chain index is rebuildable from Core, but restore testing reduces downtime.
- Preserve the active reverse-proxy/service configuration and TLS renewal setup separately from user wallet backups.

## Versioning and GitHub releases

This project uses [Semantic Versioning](https://semver.org/):

- `MAJOR` changes when a release intentionally breaks backup, protocol, API, or deployment compatibility.
- `MINOR` adds backward-compatible functionality.
- `PATCH` contains backward-compatible fixes and security hardening.
- Git tags and GitHub releases use a `v` prefix, for example `v1.0.0`; package files use `1.0.0`.

The current patch release is **v1.0.6**. Keep root `package.json`, `web/package.json`, `package-lock.json`, the release tag, and release notes aligned. Document any required Core version, gateway API change, backup migration, or operator action.

### Hosted build verification

The repository publishes a [GitHub Pages verifier](https://rhuhui.github.io/TensorCashWebWallet/)
from `.github/workflows/pages.yml`.
GitHub Actions performs a clean wallet build and publishes both the generated
HTML, JavaScript, CSS and cryptography runtime files and their inventory on
GitHub Pages. The visitor's browser independently downloads every GitHub Pages
build file and its matching file from `https://app.tscweb.xyz/wallet/`, computes
both SHA-256 values locally, and compares the bytes. No wallet-server download
or verification API returns the reference hash or verdict. Production CORS is
restricted to the GitHub Pages origin and static wallet paths; wallet API
mutation policy is not relaxed.

A successful comparison proves that the frontend bytes served during that
check match the build produced from the linked public commit. It does not
replace source review or attest DNS, TLS, browser extensions, the user's device,
or the stateless backend.

## Core compatibility

v1.0.1 targets **TensorCash Core v1.1.0** wallet descriptors and mainnet RPC
behavior. The BIP341 fix is covered by the published BIP86 vector, and the
project tests Qt wallet parsing/export structure and P2WPKH transaction signing.
A disposable end-to-end restore and spend through the exact production Core
binary remains a release/operator check; do not treat source comparison alone as
a guarantee for a future Core release.

Recommended release flow:

1. Branch from an up-to-date protected default branch and choose the SemVer version.
2. Update package versions, lockfile, and `CHANGELOG.md`; write compatibility/migration notes.
3. Run the complete release checklist below in a clean checkout.
4. Merge through review, create an annotated or signed `vX.Y.Z` tag on the reviewed commit, and push the tag.
5. Create a GitHub Release from that tag with the changelog, compatibility notes, known risks, and SHA-256 checksums for downloadable artifacts.
6. Deploy the exact tagged commit and record the deployed tag. Never rebuild mutable assets under an existing tag.

### Release checklist

- [ ] Package versions and `package-lock.json` agree with the `vX.Y.Z` tag.
- [ ] `npm ci`, `npm test`, `npm run typecheck`, and `npm run build` pass from a clean checkout.
- [ ] `python -m pytest` passes in a fresh virtual environment.
- [ ] Address derivation, Qt restore/export, signing, mempool-test, and broadcast vectors pass against the supported TensorCash Core release.
- [ ] Dependencies and the Git diff are reviewed; generated frontend assets contain no source-map or secret material.
- [ ] Secret scanning finds no RPC credentials, populated `.env`, wallet files, recovery data, private keys, or production logs.
- [ ] The repository license, contribution policy, and security contact are current.
- [ ] Nginx exposes only HTTPS; CSP, framing protection, body limits, and rate limits are active.
- [ ] Gateway and Core RPC listen only on loopback; direct external gateway and database-port probes fail.
- [ ] The explorer database opens read-only for the gateway service account and no network database is configured.
- [ ] A disposable wallet backup restores in the supported Qt/Core version and can derive the expected addresses.
- [ ] Rollback assets, database compatibility notes, checksums, release notes, and operator instructions are ready.
- [ ] The GitHub Release points to the reviewed tag and the deployed commit matches that tag.

## Contributing

Do not commit wallet files, populated environment files, RPC credentials, private keys, recovery data, transaction signatures from real wallets, build output, or production logs. Security-sensitive changes should include tests and explain how they preserve the browser/gateway/Core boundary. Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue.

## License

[MIT](LICENSE) © 2026 rHuhui.
