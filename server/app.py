from __future__ import annotations

import ipaddress
import math
import re
import sqlite3
import threading
import time
from contextlib import closing
from decimal import ROUND_DOWN, Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from flask import Flask, abort, jsonify, request

from .config import Settings
from .rpc import RPCClient, RPCError

ADDRESS_RE = re.compile(r"^tc1[02-9ac-hj-np-z]{20,100}$", re.IGNORECASE)
TX_HEX_RE = re.compile(r"^[0-9a-fA-F]+$")
SATOSHIS = Decimal(100_000_000)
MAX_WALLET_ADDRESSES = 200
MEMPOOL_CACHE_SECONDS = 30


class _TokenBucket:
    """Small in-process limiter for expensive anonymous read endpoints."""

    def __init__(self, rate: float, burst: int):
        self.rate = rate
        self.burst = float(burst)
        self._lock = threading.Lock()
        self._buckets: dict[tuple[str, str], tuple[float, float]] = {}
        self._checks = 0

    def allow(self, client: str, endpoint: str) -> bool:
        now = time.monotonic()
        key = (client, endpoint)
        with self._lock:
            tokens, updated = self._buckets.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + max(0.0, now - updated) * self.rate)
            allowed = tokens >= 1.0
            self._buckets[key] = (tokens - 1.0 if allowed else tokens, now)
            self._checks += 1
            if self._checks % 256 == 0:
                cutoff = now - max(300.0, self.burst / self.rate * 4)
                self._buckets = {
                    bucket_key: value for bucket_key, value in self._buckets.items()
                    if value[1] >= cutoff
                }
            return allowed


class _WalletQueryLimit(RuntimeError):
    pass


def _sats(value: Any) -> int:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError("invalid amount returned by Core") from exc
    if not amount.is_finite() or amount < 0:
        raise ValueError("invalid amount returned by Core")
    return int((amount * SATOSHIS).to_integral_exact(rounding=ROUND_DOWN))


def create_app(settings: Settings | None = None, rpc: RPCClient | None = None) -> Flask:
    cfg = settings or Settings.from_env()
    core = rpc or RPCClient(cfg.rpc_url, cfg.rpc_user, cfg.rpc_password, cfg.request_timeout)
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = cfg.max_transaction_bytes * 2
    app.json.sort_keys = False
    chain_status_cache: dict[str, Any] = {
        "at": 0.0,
        "retry_at": 0.0,
        "refreshing": False,
        "status": None,
    }
    chain_status_cache_lock = threading.Lock()
    mempool_cache: dict[str, Any] = {
        "at": 0.0,
        "retry_at": 0.0,
        "refreshing": False,
        "transactions": [],
        "observed_at": None,
        "generation": 0,
    }
    mempool_cache_lock = threading.Lock()
    expensive_request_limiter = _TokenBucket(cfg.public_read_rate, cfg.public_read_burst)

    def public_core_call(method: str, params: list[Any] | None = None) -> Any:
        if isinstance(core, RPCClient):
            return core.call(method, params, timeout=cfg.public_rpc_timeout)
        return core.call(method, params)

    def core_batch_chunked(calls: Any, *, public_read: bool = False) -> list[Any]:
        pending = list(calls)
        results: list[Any] = []
        for offset in range(0, len(pending), cfg.rpc_batch_size):
            chunk = pending[offset:offset + cfg.rpc_batch_size]
            if public_read and isinstance(core, RPCClient):
                results.extend(core.batch(chunk, timeout=cfg.public_rpc_timeout))
            else:
                results.extend(core.batch(chunk))
        return results

    def invalidate_mempool_cache() -> None:
        with mempool_cache_lock:
            mempool_cache.update({
                "at": 0.0,
                "retry_at": 0.0,
                "generation": int(mempool_cache["generation"]) + 1,
            })

    def client_address() -> str:
        direct = request.remote_addr or "unknown"
        try:
            direct_ip = ipaddress.ip_address(direct)
        except ValueError:
            return "unknown"
        # The production gateway is loopback-only behind Nginx. Trust one
        # sanitized X-Real-IP hop only in that topology; public direct callers
        # cannot spoof the limiter identity.
        if direct_ip.is_loopback:
            forwarded = request.headers.get("X-Real-IP", "").strip()
            try:
                return str(ipaddress.ip_address(forwarded)) if forwarded else str(direct_ip)
            except ValueError:
                return str(direct_ip)
        return str(direct_ip)

    def database() -> sqlite3.Connection:
        path = Path(cfg.index_db)
        connection = sqlite3.connect(
            f"file:{path}?mode=ro", uri=True, timeout=5, check_same_thread=False
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        return connection

    def checked_address(raw: str) -> str:
        value = raw.strip().lower()
        if not ADDRESS_RE.fullmatch(value):
            abort(404)
        try:
            validation = public_core_call("validateaddress", [value])
        except RPCError:
            # Read endpoints remain usable while Core is briefly unavailable; the
            # strict Bech32 alphabet/length check still prevents SQL abuse.
            return value
        if not isinstance(validation, dict) or not validation.get("isvalid"):
            abort(404)
        return value

    def checked_wallet_addresses(raw: Any) -> list[str]:
        if not isinstance(raw, list) or not raw or len(raw) > MAX_WALLET_ADDRESSES:
            abort(400)
        addresses: list[str] = []
        seen: set[str] = set()
        for candidate in raw:
            if not isinstance(candidate, str):
                abort(400)
            address = candidate.strip().lower()
            if not ADDRESS_RE.fullmatch(address):
                abort(400)
            if address not in seen:
                addresses.append(address)
                seen.add(address)
        if not addresses:
            abort(400)
        return addresses

    def chain_status(connection: sqlite3.Connection) -> dict[str, Any]:
        indexed = int(
            connection.execute("SELECT COALESCE(MAX(height), -1) FROM blocks").fetchone()[0]
        )

        def degraded(cached: dict[str, Any] | None) -> dict[str, Any]:
            if cached:
                status = dict(cached)
                tip = int(status["core_height"])
                status.update({
                    "indexed_height": indexed,
                    "lag": max(0, tip - indexed),
                    "synced": False,
                    "core_available": False,
                    "stale": True,
                    "status_source": "cache",
                })
                return status
            return {
                "network": "unknown",
                "core_height": indexed,
                "header_height": indexed,
                "indexed_height": indexed,
                "lag": 0,
                "synced": False,
                "observed_at": int(time.time()),
                "core_available": False,
                "stale": True,
                "status_source": "index",
            }

        now = time.monotonic()
        with chain_status_cache_lock:
            cached = chain_status_cache["status"]
            if cached is not None and now - float(chain_status_cache["at"]) < cfg.chain_status_cache_seconds:
                status = dict(cached)
                tip = int(status["core_height"])
                headers = int(status["header_height"])
                status.update({
                    "indexed_height": indexed,
                    "lag": max(0, tip - indexed),
                    "synced": tip >= 0 and indexed >= tip and headers - tip <= 1,
                })
                return status
            if chain_status_cache["refreshing"] or now < float(chain_status_cache["retry_at"]):
                return degraded(cached)
            chain_status_cache["refreshing"] = True

        try:
            info = public_core_call("getblockchaininfo")
            if not isinstance(info, dict):
                raise RPCError("invalid_response", "TensorCash Core returned invalid chain status")
            tip = int(info.get("blocks", -1))
            headers = int(info.get("headers", tip))
            status = {
                "network": info.get("chain", "unknown"),
                "core_height": tip,
                "header_height": headers,
                "indexed_height": indexed,
                "lag": max(0, tip - indexed),
                "synced": tip >= 0 and indexed >= tip and headers - tip <= 1,
                "observed_at": int(time.time()),
                "core_available": True,
                "stale": False,
                "status_source": "core",
            }
        except (RPCError, TypeError, ValueError) as exc:
            with chain_status_cache_lock:
                chain_status_cache.update({
                    "refreshing": False,
                    "retry_at": time.monotonic() + cfg.rpc_failure_backoff_seconds,
                })
                cached = chain_status_cache["status"]
            app.logger.warning(
                "Public Core snapshot stale component=chain_status cause=%s",
                getattr(exc, "code", type(exc).__name__),
            )
            return degraded(cached)

        with chain_status_cache_lock:
            chain_status_cache.update({
                "at": time.monotonic(),
                "retry_at": 0.0,
                "refreshing": False,
                "status": status,
            })
        return dict(status)

    def json_error(status: int, code: str, message: str):
        return jsonify({"error": {"code": code, "message": message}}), status

    def mempool_transactions(
        connection: sqlite3.Connection,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Return decoded mempool value flows without persisting wallet queries.

        The expensive Core decode is shared for thirty seconds. Wallet addresses
        are applied only after this cache is built, so the service never stores
        an address-to-wallet association.
        """
        now = time.monotonic()

        def snapshot(available: bool, stale: bool) -> tuple[list[dict[str, Any]], dict[str, Any]]:
            return list(mempool_cache["transactions"]), {
                "available": available,
                "stale": stale,
                "observed_at": mempool_cache["observed_at"],
            }

        with mempool_cache_lock:
            if now - float(mempool_cache["at"]) < MEMPOOL_CACHE_SECONDS:
                return snapshot(True, False)
            if mempool_cache["refreshing"] or now < float(mempool_cache["retry_at"]):
                return snapshot(False, True)
            mempool_cache["refreshing"] = True
            generation = int(mempool_cache["generation"])
        try:
            entries = public_core_call("getrawmempool", [True])
            if not isinstance(entries, dict):
                raise RPCError("invalid_response", "TensorCash Core returned invalid mempool")
            ordered = sorted(
                entries.items(),
                key=lambda item: int((item[1] or {}).get("time", 0)),
                reverse=True,
            )[:cfg.mempool_transaction_limit]
            txids = [txid for txid, _entry in ordered]
            decoded = core_batch_chunked(
                (("getrawtransaction", [txid, True]) for txid in txids),
                public_read=True,
            )
        except (RPCError, TypeError, ValueError) as exc:
            with mempool_cache_lock:
                mempool_cache.update({
                    "refreshing": False,
                    "retry_at": time.monotonic() + cfg.rpc_failure_backoff_seconds,
                })
                result = snapshot(False, True)
            app.logger.warning(
                "Public Core snapshot stale component=mempool cause=%s",
                getattr(exc, "code", type(exc).__name__),
            )
            return result

        raw_by_txid = {
            txid: transaction
            for txid, transaction in zip(txids, decoded)
            if isinstance(transaction, dict)
        }
        confirmed_prevouts: dict[tuple[str, int], tuple[str | None, int]] = {}
        previous_pairs = {
            (str(vin.get("txid", "")), int(vin.get("vout", -1)))
            for transaction in raw_by_txid.values()
            for vin in transaction.get("vin", [])
            if vin.get("txid") and isinstance(vin.get("vout"), int)
            and str(vin.get("txid")) not in raw_by_txid
        }
        for txid, vout in previous_pairs:
            row = connection.execute(
                "SELECT address, value_sats FROM tx_outputs WHERE txid = ? AND vout_index = ?",
                (txid, vout),
            ).fetchone()
            if row is not None:
                confirmed_prevouts[(txid, vout)] = (row["address"], int(row["value_sats"]))

        def output_at(txid: str, vout: int) -> tuple[str | None, int] | None:
            parent = raw_by_txid.get(txid)
            if parent is not None:
                for output in parent.get("vout", []):
                    if int(output.get("n", -1)) != vout:
                        continue
                    script = output.get("scriptPubKey") or {}
                    return script.get("address"), _sats(output.get("value", 0))
            return confirmed_prevouts.get((txid, vout))

        normalized: list[dict[str, Any]] = []
        entry_by_txid = dict(ordered)
        for txid in txids:
            transaction = raw_by_txid.get(txid)
            if transaction is None:
                continue
            inputs = []
            for vin in transaction.get("vin", []):
                if not vin.get("txid") or not isinstance(vin.get("vout"), int):
                    continue
                previous = output_at(str(vin["txid"]), int(vin["vout"]))
                if previous is not None:
                    inputs.append({"address": previous[0], "value_sats": previous[1]})
            outputs = []
            for output in transaction.get("vout", []):
                script = output.get("scriptPubKey") or {}
                outputs.append({
                    "address": script.get("address"),
                    "value_sats": _sats(output.get("value", 0)),
                })
            entry = entry_by_txid.get(txid) or {}
            normalized.append({
                "txid": txid,
                "timestamp": int(entry.get("time", time.time())),
                "fee_sats": _sats((entry.get("fees") or {}).get("base", 0)),
                "inputs": inputs,
                "outputs": outputs,
            })
        observed_at = int(time.time())
        with mempool_cache_lock:
            if generation != int(mempool_cache["generation"]):
                mempool_cache["refreshing"] = False
                result = snapshot(False, True)
                retry_needed = True
            else:
                mempool_cache.update({
                    "at": time.monotonic(),
                    "retry_at": 0.0,
                    "refreshing": False,
                    "transactions": normalized,
                    "observed_at": observed_at,
                })
                result = snapshot(True, False)
                retry_needed = False
        if retry_needed:
            # A successful broadcast invalidated this refresh while it was in
            # flight. Rebuild immediately so the newly relayed transaction is
            # not hidden behind the old snapshot until the next UI poll.
            return mempool_transactions(connection)
        return result

    def wallet_pending(
        connection: sqlite3.Connection,
        addresses: list[str],
    ) -> tuple[list[dict[str, Any]], int, int, dict[str, Any]]:
        owned = set(addresses)
        transactions: list[dict[str, Any]] = []
        total_received = 0
        total_sent = 0
        mempool, pending_status = mempool_transactions(connection)
        for transaction in mempool:
            received = sum(
                int(output["value_sats"])
                for output in transaction["outputs"]
                if output.get("address") in owned
            )
            sent = sum(
                int(item["value_sats"])
                for item in transaction["inputs"]
                if item.get("address") in owned
            )
            if not received and not sent:
                continue
            total_received += received
            total_sent += sent
            transactions.append({
                "txid": transaction["txid"],
                "status": "pending",
                "confirmations": 0,
                "block_height": None,
                "block_hash": None,
                "position": None,
                "timestamp": transaction["timestamp"],
                "received_sats": received,
                "sent_sats": sent,
                "delta_sats": received - sent,
                "fee_sats": transaction["fee_sats"],
                "is_coinbase": 0,
            })
        transactions.sort(key=lambda item: (item["timestamp"], item["txid"]), reverse=True)
        return transactions, total_received, total_sent, pending_status

    @app.after_request
    def response_headers(response):
        origin = request.headers.get("Origin", "").rstrip("/")
        public_read = request.method == "GET" or request.endpoint in {"wallet_overview", "wallet_utxos"}
        if public_read:
            response.headers["Access-Control-Allow-Origin"] = "*"
        elif origin and origin in cfg.allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        return response

    @app.before_request
    def reject_cross_origin_mutation():
        if request.method == "OPTIONS":
            origin = request.headers.get("Origin", "").rstrip("/")
            requested_path = request.path.rstrip("/")
            public_read_preflight = requested_path in {"/api/v1/wallet/overview", "/api/v1/wallet/utxos"}
            if not public_read_preflight and origin not in cfg.allowed_origins:
                abort(403)
            response = app.make_default_options_response()
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
            if public_read_preflight:
                response.headers["Access-Control-Allow-Origin"] = "*"
            return response
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("Origin", "").rstrip("/")
            public_read_post = request.endpoint in {"wallet_overview", "wallet_utxos"}
            if not public_read_post and origin not in cfg.allowed_origins:
                abort(403)
            if request.mimetype != "application/json":
                return json_error(415, "json_required", "Content-Type must be application/json")
        expensive_endpoints = {
            "wallet_overview",
            "wallet_utxos",
            "address_utxos",
            "test_transaction",
            "broadcast_transaction",
        }
        if request.endpoint in expensive_endpoints and not expensive_request_limiter.allow(
            client_address(), str(request.endpoint)
        ):
            response = json_error(429, "rate_limited", "Too many expensive wallet requests; retry shortly")
            response[0].headers["Retry-After"] = "1"
            return response
        return None

    @app.errorhandler(RPCError)
    def rpc_error(exc: RPCError):
        app.logger.warning("Core RPC failed: code=%s", exc.code)
        return json_error(503, "core_unavailable", "TensorCash Core is temporarily unavailable")

    @app.errorhandler(sqlite3.Error)
    def database_error(exc: sqlite3.Error):
        app.logger.warning("Explorer database query failed: %s", type(exc).__name__)
        return json_error(503, "index_unavailable", "The chain index is temporarily unavailable")

    @app.errorhandler(_WalletQueryLimit)
    def wallet_query_limit(_exc: _WalletQueryLimit):
        return json_error(
            422,
            "wallet_utxo_limit",
            "This wallet has too many UTXO candidates for the public gateway safety limit",
        )

    @app.get("/healthz")
    @app.get("/api/v1/status")
    def status():
        with closing(database()) as connection:
            return jsonify({"status": chain_status(connection), "custody": "none"})

    @app.get("/api/v1/address/<address>/summary")
    def address_summary(address: str):
        address = checked_address(address)
        with closing(database()) as connection:
            row = connection.execute(
                "SELECT * FROM addresses WHERE address = ?", (address,)
            ).fetchone()
            if row is None:
                payload = {
                    "address": address,
                    "balance_sats": 0,
                    "received_sats": 0,
                    "sent_sats": 0,
                    "tx_count": 0,
                    "first_seen_height": None,
                    "last_seen_height": None,
                }
            else:
                payload = dict(row)
            return jsonify({"status": chain_status(connection), "address": payload})

    @app.get("/api/v1/address/<address>/transactions")
    def address_transactions(address: str):
        address = checked_address(address)
        try:
            page = int(request.args.get("page", "1"))
            page_size = min(100, max(1, int(request.args.get("page_size", "25"))))
        except ValueError:
            return json_error(400, "invalid_pagination", "Pagination values must be integers")
        if page < 1 or page > cfg.max_page:
            return json_error(400, "invalid_pagination", f"page must be between 1 and {cfg.max_page}")
        offset = (page - 1) * page_size
        with closing(database()) as connection:
            total = connection.execute(
                "SELECT COUNT(*) FROM address_transactions WHERE address = ?", (address,)
            ).fetchone()[0]
            rows = connection.execute(
                """
                SELECT atx.txid, atx.block_height, atx.timestamp,
                       atx.received_sats, atx.sent_sats, atx.delta_sats,
                       tx.block_hash, tx.position, tx.fee_sats, tx.is_coinbase
                FROM address_transactions AS atx
                JOIN transactions AS tx ON tx.txid = atx.txid
                WHERE atx.address = ?
                ORDER BY atx.block_height DESC, tx.position DESC, atx.txid
                LIMIT ? OFFSET ?
                """,
                (address, page_size, offset),
            ).fetchall()
            return jsonify(
                {
                    "status": chain_status(connection),
                    "transactions": [dict(row) for row in rows],
                    "pagination": {
                        "page": page,
                        "page_size": page_size,
                        "total": int(total),
                        "pages": math.ceil(total / page_size) if total else 0,
                    },
                }
            )

    @app.post("/api/v1/wallet/overview")
    def wallet_overview():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return json_error(400, "invalid_wallet_query", "A JSON wallet query is required")
        addresses = checked_wallet_addresses(body.get("addresses"))
        include_pending = body.get("include_pending", True)
        if not isinstance(include_pending, bool):
            return json_error(400, "invalid_pending_option", "include_pending must be a boolean")
        try:
            page = int(body.get("page", 1))
            page_size = min(100, max(1, int(body.get("page_size", 25))))
        except (TypeError, ValueError):
            return json_error(400, "invalid_pagination", "Pagination values must be integers")
        if page < 1 or page > cfg.max_page:
            return json_error(400, "invalid_pagination", f"page must be between 1 and {cfg.max_page}")
        placeholders = ",".join("?" for _ in addresses)
        offset = (page - 1) * page_size
        with closing(database()) as connection:
            if include_pending:
                pending, pending_received, pending_sent, pending_status = wallet_pending(
                    connection, addresses
                )
            else:
                pending, pending_received, pending_sent = [], 0, 0
                pending_status = {
                    "available": None,
                    "stale": False,
                    "observed_at": None,
                }
            summary = connection.execute(
                f"""
                SELECT COALESCE(SUM(balance_sats), 0) AS balance_sats,
                       COALESCE(SUM(received_sats), 0) AS received_sats,
                       COALESCE(SUM(sent_sats), 0) AS sent_sats,
                       MIN(first_seen_height) AS first_seen_height,
                       MAX(last_seen_height) AS last_seen_height
                FROM addresses
                WHERE address IN ({placeholders})
                """,
                addresses,
            ).fetchone()
            funded_rows = connection.execute(
                f"""
                SELECT address, balance_sats, received_sats, sent_sats,
                       tx_count, first_seen_height, last_seen_height
                FROM addresses
                WHERE address IN ({placeholders}) AND balance_sats > 0
                ORDER BY balance_sats DESC, address
                """,
                addresses,
            ).fetchall()
            total = int(connection.execute(
                f"SELECT COUNT(DISTINCT txid) FROM address_transactions WHERE address IN ({placeholders})",
                addresses,
            ).fetchone()[0])
            combined_total = total + len(pending)
            pending_page = pending[offset:offset + page_size]
            confirmed_offset = max(0, offset - len(pending))
            confirmed_limit = max(0, page_size - len(pending_page))
            rows = connection.execute(
                f"""
                SELECT atx.txid, MAX(atx.block_height) AS block_height,
                       MAX(atx.timestamp) AS timestamp,
                       SUM(atx.received_sats) AS received_sats,
                       SUM(atx.sent_sats) AS sent_sats,
                       SUM(atx.delta_sats) AS delta_sats,
                       MAX(tx.block_hash) AS block_hash,
                       MAX(tx.position) AS position,
                       MAX(tx.fee_sats) AS fee_sats,
                       MAX(tx.is_coinbase) AS is_coinbase
                FROM address_transactions AS atx
                JOIN transactions AS tx ON tx.txid = atx.txid
                WHERE atx.address IN ({placeholders})
                GROUP BY atx.txid
                ORDER BY block_height DESC, position DESC, atx.txid
                LIMIT ? OFFSET ?
                """,
                (*addresses, confirmed_limit, confirmed_offset),
            ).fetchall()
            payload = dict(summary)
            payload.update({
                "address": addresses[0],
                "tx_count": combined_total,
                "unconfirmed_balance_sats": pending_received - pending_sent,
                "pending_received_sats": pending_received,
                "pending_sent_sats": pending_sent,
            })
            confirmed = [{**dict(row), "status": "confirmed"} for row in rows]
            return jsonify({
                "status": chain_status(connection),
                "address": payload,
                "transactions": pending_page + confirmed,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": combined_total,
                    "pages": math.ceil(combined_total / page_size) if combined_total else 0,
                },
                "address_count": len(addresses),
                "funded_addresses": [dict(row) for row in funded_rows],
                "pending_included": include_pending,
                "pending_status": pending_status,
                "custody": "none",
            })

    @app.get("/api/v1/address/<address>/utxos")
    def address_utxos(address: str):
        address = checked_address(address)
        with closing(database()) as connection:
            utxos = verified_wallet_utxos(connection, [address])
            return jsonify({"status": chain_status(connection), "utxos": utxos})

    def verified_wallet_utxos(connection: sqlite3.Connection, addresses: list[str]) -> list[dict[str, Any]]:
        placeholders = ",".join("?" for _ in addresses)
        candidates = connection.execute(
            f"""
            WITH wallet_transactions AS (
                SELECT DISTINCT txid
                FROM address_transactions
                WHERE address IN ({placeholders})
            )
            SELECT out.address, out.txid, out.vout_index, out.value_sats, out.script_hex,
                   tx.block_height, tx.is_coinbase
            FROM wallet_transactions AS wallet_tx
            JOIN tx_outputs AS out ON out.txid = wallet_tx.txid
            JOIN transactions AS tx ON tx.txid = out.txid
            WHERE out.address IN ({placeholders}) AND out.spent_by_txid IS NULL
            ORDER BY tx.block_height, out.txid, out.vout_index
            LIMIT ?
            """,
            (*addresses, *addresses, cfg.utxo_candidate_limit + 1),
        ).fetchall()
        if len(candidates) > cfg.utxo_candidate_limit:
            raise _WalletQueryLimit()
        tip = int(connection.execute("SELECT COALESCE(MAX(height), -1) FROM blocks").fetchone()[0])
        results = core_batch_chunked(
            ("gettxout", [row["txid"], row["vout_index"], True]) for row in candidates
        )
        utxos = []
        for row, result in zip(candidates, results):
            if not isinstance(result, dict):
                continue
            # TensorCash native assets carry vExt metadata. Never feed one to
            # the ordinary TSC coin selector.
            if result.get("asset_id") is not None or result.get("asset_units") is not None:
                continue
            script = result.get("scriptPubKey") or {}
            address = str(row["address"])
            rpc_address = script.get("address")
            rpc_addresses = script.get("addresses") or []
            if rpc_address != address and address not in rpc_addresses:
                continue
            script_hex = str(script.get("hex", "")).lower()
            if not script_hex or script_hex != str(row["script_hex"]).lower():
                continue
            try:
                value_sats = _sats(result.get("value"))
            except ValueError:
                continue
            if value_sats != int(row["value_sats"]):
                continue
            confirmations = max(0, tip - int(row["block_height"]) + 1)
            if confirmations < 1:
                continue
            if bool(row["is_coinbase"]) and confirmations < 100:
                continue
            utxos.append(
                {
                    "address": address,
                    "txid": row["txid"],
                    "vout": int(row["vout_index"]),
                    "value_sats": value_sats,
                    "script_pubkey": script_hex,
                    "height": int(row["block_height"]),
                    "confirmations": confirmations,
                    "coinbase": bool(row["is_coinbase"]),
                }
            )
        return utxos

    @app.post("/api/v1/wallet/utxos")
    def wallet_utxos():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return json_error(400, "invalid_wallet_query", "A JSON wallet query is required")
        addresses = checked_wallet_addresses(body.get("addresses"))
        with closing(database()) as connection:
            return jsonify({
                "status": chain_status(connection),
                "utxos": verified_wallet_utxos(connection, addresses),
                "address_count": len(addresses),
                "custody": "none",
            })

    @app.get("/api/v1/fees")
    def fees():
        estimate = core.call("estimatesmartfee", [6])
        fee_rate = None
        if isinstance(estimate, dict) and estimate.get("feerate") is not None:
            try:
                fee_rate = format(Decimal(str(estimate["feerate"])), "f")
            except (InvalidOperation, ValueError):
                fee_rate = None
        return jsonify({"target_blocks": 6, "fee_rate_tsc_per_kvb": fee_rate})

    def signed_transaction() -> str | tuple[Any, int]:
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or not isinstance(body.get("signed_tx"), str):
            return json_error(400, "signed_tx_required", "A signed transaction is required")
        transaction = body["signed_tx"].strip()
        if (
            not transaction
            or len(transaction) % 2
            or len(transaction) // 2 > cfg.max_transaction_bytes
            or not TX_HEX_RE.fullmatch(transaction)
        ):
            return json_error(400, "invalid_transaction", "Signed transaction hex is invalid")
        return transaction.lower()

    @app.post("/api/v1/transactions/test")
    def test_transaction():
        transaction = signed_transaction()
        if not isinstance(transaction, str):
            return transaction
        result = core.call("testmempoolaccept", [[transaction]])
        if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
            return json_error(503, "invalid_core_response", "Core returned an invalid result")
        return jsonify({"result": result[0]})

    @app.post("/api/v1/transactions/broadcast")
    def broadcast_transaction():
        transaction = signed_transaction()
        if not isinstance(transaction, str):
            return transaction
        test = core.call("testmempoolaccept", [[transaction]])
        if not isinstance(test, list) or len(test) != 1 or not isinstance(test[0], dict):
            return json_error(503, "invalid_core_response", "Core returned an invalid result")
        if not test[0].get("allowed"):
            reason = test[0].get("reject-reason", "Transaction was rejected")
            return json_error(422, "mempool_rejected", str(reason)[:240])
        txid = core.call("sendrawtransaction", [transaction])
        if not isinstance(txid, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", txid):
            return json_error(503, "invalid_core_response", "Core returned an invalid txid")
        # A successful broadcast changes the mempool immediately. Do not let a
        # pre-broadcast read cache hide the wallet's new transaction for up to
        # MEMPOOL_CACHE_SECONDS.
        invalidate_mempool_cache()
        return jsonify({"txid": txid.lower()})

    return app


if __name__ == "__main__":
    configuration = Settings.from_env()
    create_app(configuration).run(
        host=configuration.host, port=configuration.port, debug=False, threaded=True
    )
