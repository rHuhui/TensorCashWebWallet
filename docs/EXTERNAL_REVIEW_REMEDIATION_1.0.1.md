# External review remediation — v1.0.1

This document maps every item from the independent 11 August 2026 review of
v1.0.0 to its v1.0.1 disposition. It is an engineering record, not a security
certification.

## High and medium findings

| Finding | v1.0.1 disposition |
| --- | --- |
| H1 — untweaked `tr()` output key | Fixed with BIP341 `TapTweak(P)` and a direct BIP86 published-vector regression test. `rawtr()` and script-tree `tr(KEY,TREE)` descriptors are rejected rather than derived without their Merkle root. |
| M1 — one unsupported UTXO aborts all sends | Fixed by validating and partitioning outputs. Valid non-P2WPKH outputs are reported and excluded; malformed outputs still fail closed. |
| M2 — ML-DSA send failure is late | Send is disabled before password entry for wallets without a P2WPKH path. UI/docs state ML-DSA is import-only receive/watch-only. |
| M3 — anonymous Core amplification | Added application-level per-IP token bucket, 50-call Core batch chunks, 500 UTXO-candidate ceiling and 500 mempool-decode ceiling. Nginx limiting remains defense in depth. |
| M4 — reused receive address for change | Fresh internal descriptor change is the default. The internal counter and encrypted vault are persisted before broadcast. Explicit reuse remains an advanced user choice. |
| M5 — decrypted material in React state | Removed. Plaintext material now exists only in operation-local variables during authenticated import/unlock/backup/sign actions. |
| M6 — weak password floor | New encryption requires 12+ characters and displays strength/container guidance. Decryption and authenticated migration retain v1.0.0 six-character compatibility. |
| M7 — one corrupt record hides all wallets | Enumeration isolates invalid `wallet:` records, loads healthy wallets and presents a persistent recovery warning. |
| M8 — wildcard CSP egress | Production CSP is generated from same-origin plus exact compiled gateway origins. Wildcard HTTPS and development loopback sources were removed from production. |
| M9 — ordinary high-fee hard failures | The absolute 1,000,000-sat ceiling remains mandatory. The relative threshold now requires a visible confirmation rather than refusing the spend. |

## Low and informational findings

| # | v1.0.1 disposition |
| --- | --- |
| 1 | Malformed `testmempoolaccept` and non-object JSON-RPC errors now return controlled 503 errors; regression tests cover both. |
| 2 | Sanitized Nginx, systemd and environment examples are committed under `deploy/examples/`; real host configuration and secrets remain excluded. |
| 3 | The redundant second transaction plan was removed. A single fresh plan is compared with the reviewed inputs/fee before signing. |
| 4 | A transient address-to-key resolver derives all requested input keys in one descriptor pass and wipes its cache. |
| 5 | The signer copies resolver-returned key arrays and wipes only its copies; ownership is documented in `SpendKey`. |
| 6 | `@scure/bip32`, `sql.js` and `@types/sql.js` are exactly pinned; lockfile integrity metadata remains authoritative. |
| 7 | `sync-oqs.mjs` verifies the pinned ML-DSA runtime SHA-256 before copying it. The checksum is published in the changelog/release. |
| 8 | `pytest` moved to `server/requirements-dev.txt`; production requirements contain only Flask and Gunicorn. |
| 9 | Every per-request SQLite connection uses `contextlib.closing`. |
| 10 | The Core RPC password field is excluded from dataclass `repr`. |
| 11 | Page numbers have a configurable hard maximum (default 10,000). |
| 12 | The inverted `commonValid` name was corrected to `commonInvalid`. |
| 13 | Base64 conversion is chunked to avoid quadratic concatenation. Qt bytes deliberately remain inside the authenticated encrypted envelope; storing raw wallet bytes separately would weaken confidentiality/atomic recovery and is not adopted. |
| 14 | Creation, recovery and documentation explicitly state there is no 12-word seed phrase. |

## Provenance and release hygiene

- README identifies rHuhui as maintainer/release authority and explains
  authorised AI-assisted commit identities.
- Root/workspace/lockfile versions, annotated `v1.0.1` tag, GitHub Release and
  deployed build are required to point to the same commit.
- v1.0.1 release assets include SHA-256 checksums and compatibility/known-risk
  notes.
- TensorCash Core v1.1.0 is the pinned compatibility target. The BIP86 vector is
  automated; an end-to-end disposable Core restore/spend remains explicitly
  recorded as an operator/release check rather than being overstated.
- The earlier squashed history is immutable. v1.0.1 adds review traceability in
  normal Git history and this mapping.
