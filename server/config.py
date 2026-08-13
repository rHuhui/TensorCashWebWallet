from __future__ import annotations

import os
from dataclasses import dataclass


def _origins(value: str) -> tuple[str, ...]:
    return tuple(item.strip().rstrip("/") for item in value.split(",") if item.strip())


def _enabled(value: str) -> bool:
    return value.strip().lower() not in {"0", "false", "no", "off"}


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
    public_rpc_timeout: float = 2.0
    chain_status_cache_seconds: float = 5.0
    rpc_failure_backoff_seconds: float = 5.0
    max_transaction_bytes: int = 500_000
    rpc_batch_size: int = 50
    utxo_candidate_limit: int = 500
    mempool_transaction_limit: int = 500
    public_read_rate: float = 2.0
    public_read_burst: int = 12
    overview_read_rate: float = 50.0
    overview_read_burst: int = 200
    wallet_query_cache_seconds: float = 2.0
    wallet_query_cache_entries: int = 4_096
    mempool_background_refresh: bool = False
    mempool_refresh_seconds: float = 10.0
    max_page: int = 10_000

    @classmethod
    def from_env(cls) -> Settings:
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
            public_rpc_timeout=max(
                0.25,
                min(
                    float(os.getenv("TSCWALLET_PUBLIC_RPC_TIMEOUT", "2")),
                    float(os.getenv("TSCWALLET_RPC_TIMEOUT", "8")),
                ),
            ),
            chain_status_cache_seconds=max(
                0.25, float(os.getenv("TSCWALLET_CHAIN_STATUS_CACHE_SECONDS", "5"))
            ),
            rpc_failure_backoff_seconds=max(
                0.25, float(os.getenv("TSCWALLET_RPC_FAILURE_BACKOFF_SECONDS", "5"))
            ),
            rpc_batch_size=max(1, min(100, int(os.getenv("TSCWALLET_RPC_BATCH_SIZE", "50")))),
            utxo_candidate_limit=max(50, min(1_000, int(os.getenv("TSCWALLET_UTXO_CANDIDATE_LIMIT", "500")))),
            mempool_transaction_limit=max(50, min(1_000, int(os.getenv("TSCWALLET_MEMPOOL_LIMIT", "500")))),
            public_read_rate=max(0.1, float(os.getenv("TSCWALLET_PUBLIC_READ_RATE", "2"))),
            public_read_burst=max(2, int(os.getenv("TSCWALLET_PUBLIC_READ_BURST", "12"))),
            overview_read_rate=max(
                1.0, float(os.getenv("TSCWALLET_OVERVIEW_READ_RATE", "50"))
            ),
            overview_read_burst=max(
                10, int(os.getenv("TSCWALLET_OVERVIEW_READ_BURST", "200"))
            ),
            wallet_query_cache_seconds=max(
                0.0, float(os.getenv("TSCWALLET_QUERY_CACHE_SECONDS", "2"))
            ),
            wallet_query_cache_entries=max(
                16, min(16_384, int(os.getenv("TSCWALLET_QUERY_CACHE_ENTRIES", "4096")))
            ),
            mempool_background_refresh=_enabled(
                os.getenv("TSCWALLET_MEMPOOL_BACKGROUND_REFRESH", "1")
            ),
            mempool_refresh_seconds=max(
                1.0, float(os.getenv("TSCWALLET_MEMPOOL_REFRESH_SECONDS", "10"))
            ),
            max_page=max(1, min(100_000, int(os.getenv("TSCWALLET_MAX_PAGE", "10000")))),
        )
