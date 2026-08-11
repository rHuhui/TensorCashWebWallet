# Contributing

TensorCash Web Wallet is security-sensitive software. Keep pull requests small,
explain the trust-boundary impact, and include tests for behavior changes.

## Before opening a pull request

```bash
npm ci
npm test
npm run typecheck
npm run build
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r server/requirements-dev.txt
python -m pytest server/tests
```

Never commit real wallet files, recovery backups, private keys, passwords, RPC
credentials, populated environment files, signed transactions from funded
wallets, production logs, database files, or deployment-specific configuration.
Use generated disposable test vectors only.

Report suspected vulnerabilities through GitHub private vulnerability reporting
as described in [SECURITY.md](SECURITY.md), not in a public issue.
