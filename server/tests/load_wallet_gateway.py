"""Local-only 1,000-wallet homepage load test.

This test starts a synthetic read-only explorer database, a mock TensorCash
Core JSON-RPC server and the real Gunicorn gateway. It never contacts or writes
to production. Run from the repository root:

    python server/tests/load_wallet_gateway.py --clients 1000
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def address(index: int) -> str:
    alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    value = index + 1
    payload = []
    for _ in range(38):
        payload.append(alphabet[value % len(alphabet)])
        value = value // len(alphabet) + 17
    return "tc1q" + "".join(payload)


def create_database(path: Path, clients: int, addresses_per_wallet: int) -> list[list[str]]:
    wallets = [
        [address(wallet * addresses_per_wallet + offset) for offset in range(addresses_per_wallet)]
        for wallet in range(clients)
    ]
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE blocks(height INTEGER PRIMARY KEY);
            CREATE TABLE addresses(
              address TEXT PRIMARY KEY, balance_sats INTEGER NOT NULL,
              received_sats INTEGER NOT NULL, sent_sats INTEGER NOT NULL,
              tx_count INTEGER NOT NULL, first_seen_height INTEGER,
              last_seen_height INTEGER
            );
            CREATE TABLE transactions(
              txid TEXT PRIMARY KEY, block_height INTEGER NOT NULL,
              block_hash TEXT NOT NULL, position INTEGER NOT NULL,
              fee_sats INTEGER, is_coinbase INTEGER NOT NULL
            );
            CREATE TABLE address_transactions(
              address TEXT NOT NULL, txid TEXT NOT NULL, block_height INTEGER NOT NULL,
              timestamp INTEGER NOT NULL, received_sats INTEGER NOT NULL,
              sent_sats INTEGER NOT NULL, delta_sats INTEGER NOT NULL,
              PRIMARY KEY(address, txid)
            );
            CREATE TABLE tx_outputs(
              txid TEXT NOT NULL, vout_index INTEGER NOT NULL, address TEXT,
              value_sats INTEGER NOT NULL, script_hex TEXT NOT NULL,
              spent_by_txid TEXT, PRIMARY KEY(txid, vout_index)
            );
            CREATE INDEX idx_address_transactions_address_height
              ON address_transactions(address, block_height DESC, txid);
            """
        )
        connection.execute("INSERT INTO blocks(height) VALUES(22000)")
        address_rows = []
        transaction_rows = []
        history_rows = []
        for wallet_index, wallet in enumerate(wallets):
            for derived_index, wallet_address in enumerate(wallet):
                txid = f"{wallet_index * addresses_per_wallet + derived_index + 1:064x}"
                amount = 100_000_000 + derived_index
                address_rows.append((wallet_address, amount, amount, 0, 1, 21999, 22000))
                transaction_rows.append((txid, 22000, "ab" * 32, derived_index, 1000, 0))
                history_rows.append(
                    (wallet_address, txid, 22000, 1_800_000_000, amount, 0, amount)
                )
        connection.executemany("INSERT INTO addresses VALUES(?, ?, ?, ?, ?, ?, ?)", address_rows)
        connection.executemany("INSERT INTO transactions VALUES(?, ?, ?, ?, ?, ?)", transaction_rows)
        connection.executemany(
            "INSERT INTO address_transactions VALUES(?, ?, ?, ?, ?, ?, ?)", history_rows
        )
    return wallets


class MockCoreHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    @staticmethod
    def response(call: dict[str, object]) -> dict[str, object]:
        method = call.get("method")
        if method == "getblockchaininfo":
            result: object = {"chain": "main", "blocks": 22000, "headers": 22000}
        elif method == "getrawmempool":
            result = {}
        elif method == "validateaddress":
            result = {"isvalid": True}
        else:
            result = None
        return {"jsonrpc": "2.0", "id": call.get("id"), "result": result, "error": None}

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        length = int(self.headers.get("Content-Length", "0"))
        request_body = json.loads(self.rfile.read(length))
        if isinstance(request_body, list):
            payload: object = [self.response(call) for call in request_body]
        else:
            payload = self.response(request_body)
        encoded = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


async def request_overview(
    port: int, wallet: list[str], client_index: int, include_pending: bool
) -> tuple[int, float]:
    payload = json.dumps(
        {"addresses": wallet, "page": 1, "page_size": 25, "include_pending": include_pending}
    ).encode()
    headers = (
        f"POST /api/v1/wallet/overview HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(payload)}\r\n"
        f"X-Real-IP: 198.18.{(client_index // 250) % 250}.{client_index % 250 + 1}\r\n"
        "Connection: close\r\n\r\n"
    ).encode() + payload
    started = time.perf_counter()
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(headers)
    await writer.drain()
    status_line = await reader.readline()
    status = int(status_line.split()[1])
    content_length = 0
    while True:
        line = await reader.readline()
        if line in {b"\r\n", b""}:
            break
        if line.lower().startswith(b"content-length:"):
            content_length = int(line.split(b":", 1)[1])
    if content_length:
        await reader.readexactly(content_length)
    writer.close()
    await writer.wait_closed()
    return status, time.perf_counter() - started


async def run_clients(port: int, wallets: list[list[str]], concurrency: int) -> list[float]:
    semaphore = asyncio.Semaphore(concurrency)

    async def visit(index: int, wallet: list[str]) -> list[float]:
        async with semaphore:
            first_status, first_latency = await request_overview(port, wallet, index, False)
            second_status, second_latency = await request_overview(port, wallet, index, True)
            if first_status != 200 or second_status != 200:
                raise RuntimeError(f"client {index}: HTTP {first_status}/{second_status}")
            return [first_latency, second_latency]

    results = await asyncio.gather(*(visit(index, wallet) for index, wallet in enumerate(wallets)))
    return [latency for pair in results for latency in pair]


def percentile(values: list[float], percent: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * percent))]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clients", type=int, default=1000)
    parser.add_argument("--addresses-per-wallet", type=int, default=4)
    parser.add_argument("--concurrency", type=int, default=200)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="tscwallet-load-") as directory:
        temporary = Path(directory)
        database = temporary / "explorer.sqlite3"
        wallets = create_database(database, args.clients, args.addresses_per_wallet)
        rpc_port = free_port()
        gateway_port = free_port()
        mock_core = ThreadingHTTPServer(("127.0.0.1", rpc_port), MockCoreHandler)
        threading.Thread(target=mock_core.serve_forever, daemon=True).start()
        environment = os.environ.copy()
        environment.update(
            {
                "PYTHONPATH": str(repository),
                "TSCWALLET_INDEX_DB": str(database),
                "TSCWALLET_RPC_URL": f"http://127.0.0.1:{rpc_port}",
                "TSCWALLET_ALLOWED_ORIGINS": "http://127.0.0.1",
                "TSCWALLET_MEMPOOL_BACKGROUND_REFRESH": "1",
                "TSCWALLET_MEMPOOL_REFRESH_SECONDS": "10",
                "TSCWALLET_OVERVIEW_READ_RATE": "50",
                "TSCWALLET_OVERVIEW_READ_BURST": "200",
            }
        )
        gateway = subprocess.Popen(
            [
                sys.executable, "-m", "gunicorn", "--workers", "1", "--threads", "32",
                "--timeout", "45", "--bind", f"127.0.0.1:{gateway_port}",
                "server.app:create_app()",
            ],
            cwd=repository,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            for _ in range(100):
                if gateway.poll() is not None:
                    raise RuntimeError(gateway.stderr.read().decode())
                try:
                    with socket.create_connection(("127.0.0.1", gateway_port), timeout=0.1):
                        break
                except OSError:
                    time.sleep(0.05)
            started = time.perf_counter()
            latencies = asyncio.run(run_clients(gateway_port, wallets, args.concurrency))
            elapsed = time.perf_counter() - started
            print(
                json.dumps(
                    {
                        "virtual_clients": args.clients,
                        "requests": len(latencies),
                        "concurrency": args.concurrency,
                        "elapsed_seconds": round(elapsed, 3),
                        "requests_per_second": round(len(latencies) / elapsed, 2),
                        "latency_ms": {
                            "mean": round(statistics.mean(latencies) * 1000, 2),
                            "p50": round(percentile(latencies, 0.50) * 1000, 2),
                            "p95": round(percentile(latencies, 0.95) * 1000, 2),
                            "p99": round(percentile(latencies, 0.99) * 1000, 2),
                            "max": round(max(latencies) * 1000, 2),
                        },
                    },
                    indent=2,
                )
            )
        finally:
            gateway.terminate()
            try:
                gateway.wait(5)
            except subprocess.TimeoutExpired:
                gateway.kill()
            mock_core.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
