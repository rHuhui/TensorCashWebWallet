# Security policy

TensorCash Web Wallet handles signing keys in a hostile environment: a general-purpose browser. Treat changes to wallet parsing, key derivation, vault encryption, transaction construction, frontend delivery, gateway authorization, or deployment configuration as security-sensitive.

## Supported versions

| Version | Security fixes |
| --- | --- |
| 1.0.x | Supported |
| Pre-1.0 development builds | Not supported |

Security fixes are applied to the latest supported patch release. If a vulnerability requires a compatibility break, the release notes will identify the affected backup/API versions and migration path.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Once the repository is public, use GitHub's **Security → Report a vulnerability** private reporting form. If private reporting is temporarily unavailable, contact a maintainer through a private channel listed on the repository profile and ask for a secure reporting route before sending technical details.

Include only non-secret information needed to reproduce the issue:

- affected version, commit, browser, operating system, and TensorCash Core version;
- affected component and expected versus observed behavior;
- minimal reproduction steps or a proof of concept using generated disposable keys;
- impact and any suggested mitigation.

Never send a real `wallet.dat`, Web Wallet JSON backup, password, descriptor secret, private/recovery key, RPC credential, session data, or signed transaction from a funded wallet. Encrypt sensitive proof-of-concept material only after agreeing on a recipient and channel.

Maintainers should acknowledge a private report, validate it, coordinate a fix and disclosure date, and credit the reporter if requested. Timelines depend on severity and consensus/Core compatibility; do not disclose before users have a reasonable opportunity to upgrade.

## In scope

- Theft or disclosure of key material, passwords, or decrypted wallet data.
- Vault authentication/KDF weaknesses or backup validation bypasses.
- Incorrect address/key derivation, transaction serialization, signing, recipient/change validation, or fee limits.
- Qt/Core wallet import/export corruption or an unsafe encryption-state change.
- Gateway endpoints that expose Core RPC, accept unauthorized mutations, bypass origin checks, or persist wallet secrets.
- UTXO substitution, asset-bearing output selection, mempool validation bypass, and unsafe broadcast behavior.
- Production configuration that exposes Gunicorn, Core RPC, the explorer SQLite file, credentials, or mutable frontend assets.
- CSP, dependency, or build-chain weaknesses that permit unauthorized frontend code execution.

Third-party browsers, extensions, operating systems, DNS/registrars, certificate authorities, hosting providers, and TensorCash Core consensus bugs are normally out of scope for this repository, but reports showing that the wallet unnecessarily amplifies one of those risks are welcome.

## Non-negotiable application rules

1. The gateway must never accept or log a wallet password, private key, descriptor secret, recovery backup, mnemonic, or decrypted vault.
2. The frontend must not load third-party scripts, fonts, analytics, tag managers, or remote WebAssembly. Release assets must be pinned and served from the wallet origin.
3. A transaction is signed only after the client has independently checked each input, recipient, change output, fee, and network.
4. Native-asset outputs are not ordinary TSC UTXOs. The gateway must verify indexed candidates through Core `gettxout` and exclude outputs carrying asset metadata.
5. Raw Core JSON-RPC must never be browser-accessible. The gateway RPC client must retain an explicit method allowlist.
6. Production releases require HTTPS, strict CSP/framing headers, pinned dependencies, protocol-vector tests against the supported TensorCash Core release, and a reviewed immutable build.

## Production security requirements

### Network and database boundary

- Nginx is the only public wallet process and accepts HTTPS on port 443. Port 80 may only redirect to HTTPS or serve a temporary ACME challenge.
- The gateway process binds explicitly to loopback. Application environment values do not necessarily override a process manager's command-line bind, so both the configured command and live listening socket must be checked.
- TensorCash Core RPC binds to `127.0.0.1`/`::1`, uses authentication, and is not present in any Nginx `proxy_pass`. Use a dedicated RPC identity and rotate it after suspected disclosure.
- The gateway reads a local explorer SQLite file. It opens the file with `file:<path>?mode=ro`, enables `PRAGMA query_only=ON`, and needs filesystem read permission only. Do not replace it with or expose a network database service.
- Host/cloud firewalls must deny direct access to the gateway, Core RPC, and any database port. Firewall rules are defense in depth; loopback binding remains mandatory.

### Secrets and processes

- Store production gateway variables in an operator-managed server-only file with mode `0600`. Never commit it, serve it from the web root, or copy it into `web/dist/`.
- Only public build-time settings may use the `VITE_` prefix. Every `VITE_*` value is visible in the browser bundle.
- Run the gateway as a dedicated unprivileged account with process-manager sandboxing and network restrictions.
- Do not log request bodies, authorization headers, environment variables, raw transactions, or address lists. Nginx access logs can still associate client IPs with address-bearing GET paths; restrict access and retention accordingly.
- Keep the repository checkout, virtual environment, static assets, Nginx configuration, and service unit non-writable by the service account.

### Frontend delivery

- Serve only the reviewed `web/dist/` output from an immutable versioned release directory.
- Enforce the reference CSP as an HTTP response header. `frame-ancestors` in an HTML meta element is not sufficient.
- Keep source maps disabled in production, reject dotfiles, set a request body limit, and rate-limit the API at Nginx.
- Treat control of DNS, TLS private keys, Nginx, the static release directory, the GitHub release/tag, and dependency publishing accounts as equivalent to control of users' unlocked wallets.

## Passwords, storage, and backups

The browser vault derives an AES-256-GCM key with Argon2id. Each encryption uses a random salt and IV; authenticated public metadata is bound as AES-GCM additional data. IndexedDB stores ciphertext, KDF/cipher parameters, and authenticated public metadata. A strong, unique password is still essential because an attacker who copies the vault can attempt guesses offline.

Qt wallet files are parsed in the browser. Imported descriptor keys and the original wallet bytes reside inside the encrypted local vault. Export preserves the Qt wallet's original encryption state; an originally unencrypted Qt file therefore remains plaintext key material. Export may update descriptor counters and standard receive metadata as addresses are issued.

Browser memory cannot guarantee complete secret zeroization because JavaScript runtimes and garbage collectors may copy data. Password re-verification reduces accidental unlocked-session use but is not a second factor and does not protect a compromised browser or operating system.

## Operator verification

After installation and every service/configuration change, verify:

Use the host's service-manager, socket, reverse-proxy and file-permission tools to
inspect the effective configuration—not just the source templates. Expected
results: the gateway and Core RPC appear only on loopback; the reverse proxy
exposes only intended HTTPS routes; no SQL server port is listening; the
environment file is not group/world-readable; and a direct gateway probe from
another host fails. Redact credentials before sharing command output.

See `docs/THREAT_MODEL.md` for defended and residual threats.
