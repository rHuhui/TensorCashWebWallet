from __future__ import annotations

import os
from dataclasses import dataclass


def _origins(value: str) -> tuple[str, ...]:
    return tuple(item.strip().rstrip("/") for item in value.split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    index_db: str
    rpc_url: str
    rpc_user: str
    rpc_password: str
    allowed_origins: tuple[str, ...]
    request_timeout: float = 8.0
    max_transaction_bytes: int = 500_000

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            host=os.getenv("TSCWALLET_HOST", "127.0.0.1"),
            port=int(os.getenv("TSCWALLET_PORT", "9920")),
            index_db=os.getenv(
                "TSCWALLET_INDEX_DB",
                os.getenv("TSC_EXPLORER_DB", "./data/explorer.sqlite3"),
            ),
            rpc_url=os.getenv(
                "TSCWALLET_RPC_URL", os.getenv("TSC_RPC_URL", "http://127.0.0.1:8332")
            ),
            rpc_user=os.getenv("TSCWALLET_RPC_USER", os.getenv("TSC_RPC_USER", "")),
            rpc_password=os.getenv(
                "TSCWALLET_RPC_PASSWORD", os.getenv("TSC_RPC_PASSWORD", "")
            ),
            allowed_origins=_origins(
                os.getenv("TSCWALLET_ALLOWED_ORIGINS", "http://127.0.0.1:5173")
            ),
            request_timeout=float(os.getenv("TSCWALLET_RPC_TIMEOUT", "8")),
        )
