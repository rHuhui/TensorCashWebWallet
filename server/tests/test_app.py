from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from server.app import create_app
from server.config import Settings
from server.rpc import RPCError

ADDRESS = "tc1qg83etpvnwl8jqrexs3zsnpvpcvepwg2xduejel"
ADDRESS_2 = "tc1q9wpysjvsjcz0t945h6cr9n6sfkh9c5w7c9008d"
TXID = "11" * 32
TXID_2 = "44" * 32
BLOCK_HASH = "22" * 32
SCRIPT = "5220" + "33" * 32


class FakeRPC:
    def __init__(self):
        self.calls: list[tuple[str, list]] = []
        self.asset = False
        self.mempool: dict[str, dict] = {}
        self.raw_transactions: dict[str, dict] = {}
        self.batch_sizes: list[int] = []
        self.fail_methods: set[str] = set()

    def call(self, method, params=None):
        self.calls.append((method, params or []))
        if method in self.fail_methods:
            raise RPCError("unavailable", "simulated Core outage")
        if method == "validateaddress":
            return {"isvalid": True}
        if method == "getblockchaininfo":
            return {"chain": "main", "blocks": 100, "headers": 100}
        if method == "getrawmempool":
            return self.mempool
        if method == "estimatesmartfee":
            return {"feerate": 0.00001, "blocks": 6}
        if method == "testmempoolaccept":
            return [{"txid": TXID, "allowed": True}]
        if method == "sendrawtransaction":
            return TXID
        raise AssertionError(method)

    def batch(self, calls):
        calls = list(calls)
        if "batch" in self.fail_methods:
            raise RPCError("unavailable", "simulated Core outage")
        self.batch_sizes.append(len(calls))
        self.calls.extend(calls)
        if calls and all(method == "getrawtransaction" for method, _params in calls):
            return [self.raw_transactions[params[0]] for _method, params in calls]
        result = {
            "value": 1.25,
            "scriptPubKey": {"hex": SCRIPT, "address": ADDRESS},
        }
        if self.asset:
            result["asset_id"] = "aa" * 32
            result["asset_units"] = 10
        return [result for _ in calls]


@pytest.fixture()
def wallet_app(tmp_path: Path):
    database = tmp_path / "explorer.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE blocks(height INTEGER PRIMARY KEY);
            CREATE TABLE addresses(
              address TEXT PRIMARY KEY, balance_sats INTEGER, received_sats INTEGER,
              sent_sats INTEGER, tx_count INTEGER, first_seen_height INTEGER,
              last_seen_height INTEGER
            );
            CREATE TABLE transactions(
              txid TEXT PRIMARY KEY, block_height INTEGER, block_hash TEXT,
              position INTEGER, fee_sats INTEGER, is_coinbase INTEGER
            );
            CREATE TABLE address_transactions(
              address TEXT, txid TEXT, block_height INTEGER, timestamp INTEGER,
              received_sats INTEGER, sent_sats INTEGER, delta_sats INTEGER
            );
            CREATE TABLE tx_outputs(
              txid TEXT, vout_index INTEGER, address TEXT, value_sats INTEGER,
              script_hex TEXT, spent_by_txid TEXT
            );
            """
        )
        connection.execute("INSERT INTO blocks(height) VALUES(100)")
        connection.execute(
            "INSERT INTO addresses VALUES(?, ?, ?, ?, ?, ?, ?)",
            (ADDRESS, 125_000_000, 125_000_000, 0, 1, 100, 100),
        )
        connection.execute(
            "INSERT INTO addresses VALUES(?, ?, ?, ?, ?, ?, ?)",
            (ADDRESS_2, 75_000_000, 100_000_000, 25_000_000, 1, 99, 100),
        )
        connection.execute(
            "INSERT INTO transactions VALUES(?, 100, ?, 1, 1000, 0)",
            (TXID, BLOCK_HASH),
        )
        connection.execute(
            "INSERT INTO address_transactions VALUES(?, ?, 100, 1700000000, ?, 0, ?)",
            (ADDRESS, TXID, 125_000_000, 125_000_000),
        )
        connection.execute(
            "INSERT INTO transactions VALUES(?, 99, ?, 2, 900, 0)",
            (TXID_2, BLOCK_HASH),
        )
        connection.execute(
            "INSERT INTO address_transactions VALUES(?, ?, 99, 1699999000, ?, ?, ?)",
            (ADDRESS_2, TXID_2, 100_000_000, 25_000_000, 75_000_000),
        )
        connection.execute(
            "INSERT INTO tx_outputs VALUES(?, 0, ?, ?, ?, NULL)",
            (TXID, ADDRESS, 125_000_000, SCRIPT),
        )
    rpc = FakeRPC()
    settings = Settings(
        host="127.0.0.1",
        port=9920,
        index_db=str(database),
        rpc_url="http://127.0.0.1:8332",
        rpc_user="",
        rpc_password="",
        allowed_origins=("https://wallet.example",),
        overview_read_rate=2,
        overview_read_burst=12,
    )
    app = create_app(settings, rpc)
    app.config.update(TESTING=True)
    app.config["TEST_DATABASE"] = str(database)
    return app, rpc


def test_status_and_summary_are_non_custodial(wallet_app):
    app, _ = wallet_app
    client = app.test_client()
    status = client.get("/api/v1/status").get_json()
    assert status["custody"] == "none"
    assert status["status"]["synced"] is True

    response = client.get(f"/api/v1/address/{ADDRESS}/summary")
    assert response.status_code == 200
    assert response.get_json()["address"]["balance_sats"] == 125_000_000


def test_wallet_overview_aggregates_all_derived_addresses_without_custody(wallet_app):
    app, _ = wallet_app
    response = app.test_client().post(
        "/api/v1/wallet/overview",
        json={"addresses": [ADDRESS, ADDRESS_2], "page": 1, "page_size": 25},
        headers={"Origin": "https://self-hosted-wallet.example"},
    )
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "*"
    payload = response.get_json()
    assert payload["custody"] == "none"
    assert payload["address_count"] == 2
    assert payload["address"]["balance_sats"] == 200_000_000
    assert payload["address"]["received_sats"] == 225_000_000
    assert payload["address"]["sent_sats"] == 25_000_000
    assert payload["address"]["unconfirmed_balance_sats"] == 0
    assert payload["address"]["tx_count"] == 2
    assert [row["txid"] for row in payload["transactions"]] == [TXID, TXID_2]
    assert [(row["address"], row["balance_sats"]) for row in payload["funded_addresses"]] == [
        (ADDRESS, 125_000_000),
        (ADDRESS_2, 75_000_000),
    ]


def test_wallet_overview_includes_unconfirmed_balance_and_pending_history(wallet_app):
    app, rpc = wallet_app
    pending_txid = "55" * 32
    rpc.mempool[pending_txid] = {"time": 1_800_000_000, "fees": {"base": 0.00001}}
    rpc.raw_transactions[pending_txid] = {
        "vin": [{"txid": "66" * 32, "vout": 0}],
        "vout": [{
            "n": 0,
            "value": 0.5,
            "scriptPubKey": {"address": ADDRESS, "hex": SCRIPT},
        }],
    }
    payload = app.test_client().post(
        "/api/v1/wallet/overview",
        json={"addresses": [ADDRESS], "page": 1, "page_size": 25},
    ).get_json()

    assert payload["address"]["balance_sats"] == 125_000_000
    assert payload["address"]["unconfirmed_balance_sats"] == 50_000_000
    assert payload["address"]["pending_received_sats"] == 50_000_000
    assert payload["address"]["pending_sent_sats"] == 0
    assert payload["address"]["tx_count"] == 2
    assert payload["transactions"][0]["txid"] == pending_txid
    assert payload["transactions"][0]["status"] == "pending"
    assert payload["transactions"][0]["confirmations"] == 0


def test_pending_lookup_uses_address_index_not_full_mempool_scan(wallet_app):
    app, rpc = wallet_app
    unrelated = "77" * 32
    related = "88" * 32
    rpc.mempool = {
        unrelated: {"time": 1_800_000_000, "fees": {"base": 0.00001}},
        related: {"time": 1_800_000_001, "fees": {"base": 0.00001}},
    }
    rpc.raw_transactions = {
        unrelated: {
            "vin": [],
            "vout": [{"n": 0, "value": 9, "scriptPubKey": {"address": ADDRESS_2}}],
        },
        related: {
            "vin": [],
            "vout": [{"n": 0, "value": 0.25, "scriptPubKey": {"address": ADDRESS}}],
        },
    }
    payload = app.test_client().post(
        "/api/v1/wallet/overview", json={"addresses": [ADDRESS]}
    ).get_json()

    assert payload["address"]["unconfirmed_balance_sats"] == 25_000_000
    assert [row["txid"] for row in payload["transactions"] if row["status"] == "pending"] == [related]


def test_pending_lookup_does_not_drop_an_older_transaction_from_a_large_mempool(wallet_app):
    app, rpc = wallet_app
    related = "fe" * 32
    unrelated = [f"{10_000 + index:064x}" for index in range(600)]
    rpc.mempool = {
        related: {"time": 1_700_000_000, "fees": {"base": 0.00001}},
        **{
            txid: {"time": 1_800_000_000 + index, "fees": {"base": 0.00001}}
            for index, txid in enumerate(unrelated)
        },
    }
    rpc.raw_transactions = {
        related: {
            "vin": [],
            "vout": [{"n": 0, "value": 0.3, "scriptPubKey": {"address": ADDRESS}}],
        },
        **{
            txid: {
                "vin": [],
                "vout": [{"n": 0, "value": 0.001, "scriptPubKey": {"address": ADDRESS_2}}],
            }
            for txid in unrelated
        },
    }

    payload = app.test_client().post(
        "/api/v1/wallet/overview", json={"addresses": [ADDRESS]}
    ).get_json()

    assert payload["address"]["pending_received_sats"] == 30_000_000
    assert [row["txid"] for row in payload["transactions"] if row["status"] == "pending"] == [related]
    assert max(rpc.batch_sizes) <= 50


def test_pending_send_resolves_confirmed_prevout_in_one_snapshot(wallet_app):
    app, rpc = wallet_app
    spending_txid = "aa" * 32
    rpc.mempool[spending_txid] = {"time": 1_800_000_002, "fees": {"base": 0.00001}}
    rpc.raw_transactions[spending_txid] = {
        "vin": [{"txid": TXID, "vout": 0}],
        "vout": [{"n": 0, "value": 1.0, "scriptPubKey": {"address": ADDRESS_2}}],
    }

    payload = app.test_client().post(
        "/api/v1/wallet/overview", json={"addresses": [ADDRESS]}
    ).get_json()

    assert payload["address"]["pending_received_sats"] == 0
    assert payload["address"]["pending_sent_sats"] == 125_000_000
    assert payload["address"]["unconfirmed_balance_sats"] == -125_000_000
    assert payload["transactions"][0]["txid"] == spending_txid


def test_unchanged_mempool_reuses_decoded_transactions(wallet_app):
    app, rpc = wallet_app
    pending_txid = "99" * 32
    rpc.mempool[pending_txid] = {"time": 1_800_000_000, "fees": {"base": 0.00001}}
    rpc.raw_transactions[pending_txid] = {"vin": [], "vout": []}
    settings = Settings(
        host="127.0.0.1", port=9920,
        index_db=app.config["TEST_DATABASE"], rpc_url="http://127.0.0.1:8332",
        rpc_user="", rpc_password="", allowed_origins=("https://wallet.example",),
        mempool_background_refresh=False,
    )
    isolated = create_app(settings, rpc)
    isolated.config.update(TESTING=True)
    client = isolated.test_client()
    assert client.post("/api/v1/wallet/overview", json={"addresses": [ADDRESS]}).status_code == 200
    decoded_calls = sum(method == "getrawtransaction" for method, _params in rpc.calls)
    assert client.post(
        "/api/v1/transactions/broadcast",
        json={"signed_tx": "00"},
        headers={"Origin": "https://wallet.example"},
    ).status_code == 200
    # A broadcast invalidates membership, but unchanged transactions retain
    # their decoded public data and are not fetched from Core again.
    assert client.post("/api/v1/wallet/overview", json={"addresses": [ADDRESS]}).status_code == 200
    assert sum(method == "getrawtransaction" for method, _params in rpc.calls) == decoded_calls


def test_wallet_overview_can_return_confirmed_data_without_waiting_for_mempool(wallet_app):
    app, rpc = wallet_app
    payload = app.test_client().post(
        "/api/v1/wallet/overview",
        json={"addresses": [ADDRESS], "include_pending": False},
    ).get_json()

    assert payload["pending_included"] is False
    assert payload["address"]["balance_sats"] == 125_000_000
    assert payload["address"]["unconfirmed_balance_sats"] == 0
    assert not any(method == "getrawmempool" for method, _params in rpc.calls)


def test_confirmed_wallet_data_degrades_instead_of_503_when_core_is_unavailable(wallet_app):
    app, rpc = wallet_app
    rpc.fail_methods.add("getblockchaininfo")

    response = app.test_client().post(
        "/api/v1/wallet/overview",
        json={"addresses": [ADDRESS], "include_pending": False},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["address"]["balance_sats"] == 125_000_000
    assert payload["status"] == {
        "network": "unknown",
        "core_height": 100,
        "header_height": 100,
        "indexed_height": 100,
        "lag": 0,
        "synced": False,
        "observed_at": payload["status"]["observed_at"],
        "core_available": False,
        "stale": True,
        "status_source": "index",
    }


def test_mempool_outage_preserves_confirmed_wallet_and_reports_stale_state(wallet_app):
    app, rpc = wallet_app
    rpc.fail_methods.add("getrawmempool")

    response = app.test_client().post(
        "/api/v1/wallet/overview",
        json={"addresses": [ADDRESS], "include_pending": True},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["address"]["balance_sats"] == 125_000_000
    assert payload["transactions"][0]["status"] == "confirmed"
    assert payload["pending_status"] == {
        "available": False,
        "stale": True,
        "observed_at": None,
    }


def test_background_mempool_refresh_never_blocks_wallet_request(wallet_app):
    fixture_app, rpc = wallet_app
    entered = threading.Event()
    release = threading.Event()
    original_call = rpc.call

    def blocking(method, params=None):
        if method == "getrawmempool":
            entered.set()
            assert release.wait(2)
        return original_call(method, params)

    rpc.call = blocking
    settings = Settings(
        host="127.0.0.1", port=9920,
        index_db=fixture_app.config["TEST_DATABASE"], rpc_url="http://127.0.0.1:8332",
        rpc_user="", rpc_password="", allowed_origins=("https://wallet.example",),
        mempool_background_refresh=True,
    )
    app = create_app(settings, rpc)
    app.config.update(TESTING=True)
    assert entered.wait(1)

    started = time.monotonic()
    response = app.test_client().post(
        "/api/v1/wallet/overview", json={"addresses": [ADDRESS]}
    )
    elapsed = time.monotonic() - started
    release.set()

    assert response.status_code == 200
    assert elapsed < 0.5
    assert response.get_json()["pending_status"] == {
        "available": False,
        "stale": True,
        "observed_at": None,
    }


def test_transaction_relay_still_fails_closed_when_core_is_unavailable(wallet_app):
    app, rpc = wallet_app
    rpc.fail_methods.add("testmempoolaccept")

    response = app.test_client().post(
        "/api/v1/transactions/broadcast",
        json={"signed_tx": "00"},
        headers={"Origin": "https://wallet.example"},
    )

    assert response.status_code == 503
    assert response.get_json()["error"]["code"] == "core_unavailable"
    assert not any(method == "sendrawtransaction" for method, _params in rpc.calls)


def test_concurrent_status_read_uses_index_while_core_refresh_is_in_flight(wallet_app):
    app, rpc = wallet_app
    entered = threading.Event()
    release = threading.Event()
    original_call = rpc.call

    def blocking(method, params=None):
        if method == "getblockchaininfo":
            entered.set()
            assert release.wait(2)
        return original_call(method, params)

    rpc.call = blocking
    result: dict[str, object] = {}

    def refresh_status():
        with app.test_client() as client:
            response = client.get("/api/v1/status")
            result.update(status_code=response.status_code, payload=response.get_json())

    thread = threading.Thread(target=refresh_status)
    thread.start()
    assert entered.wait(1)

    with app.test_client() as client:
        concurrent = client.post(
            "/api/v1/wallet/overview",
            json={"addresses": [ADDRESS], "include_pending": False},
        )

    assert concurrent.status_code == 200
    assert concurrent.get_json()["status"]["status_source"] == "index"
    assert concurrent.get_json()["status"]["stale"] is True
    release.set()
    thread.join(2)
    assert not thread.is_alive()
    assert result["status_code"] == 200


def test_wallet_overview_rejects_invalid_or_excessive_watch_sets(wallet_app):
    app, _ = wallet_app
    client = app.test_client()
    assert client.post("/api/v1/wallet/overview", json={"addresses": []}).status_code == 400
    assert client.post(
        "/api/v1/wallet/overview",
        json={"addresses": [ADDRESS] * 201},
    ).status_code == 400
    assert client.post(
        "/api/v1/wallet/overview",
        json={"addresses": ["not-an-address"]},
    ).status_code == 400


def test_utxo_is_revalidated_by_core(wallet_app):
    app, rpc = wallet_app
    client = app.test_client()
    response = client.get(f"/api/v1/address/{ADDRESS}/utxos")
    payload = response.get_json()
    assert payload["utxos"] == [
        {
            "address": ADDRESS,
            "txid": TXID,
            "vout": 0,
            "value_sats": 125_000_000,
            "script_pubkey": SCRIPT,
            "height": 100,
            "confirmations": 1,
            "coinbase": False,
        }
    ]
    assert ("gettxout", [TXID, 0, True]) in rpc.calls


def test_wallet_utxos_batches_owned_addresses_as_public_read(wallet_app):
    app, rpc = wallet_app
    response = app.test_client().post(
        "/api/v1/wallet/utxos",
        json={"addresses": [ADDRESS, ADDRESS_2]},
        headers={"Origin": "https://self-hosted-wallet.example"},
    )
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "*"
    payload = response.get_json()
    assert payload["custody"] == "none"
    assert payload["address_count"] == 2
    assert payload["utxos"][0]["address"] == ADDRESS
    assert ("gettxout", [TXID, 0, True]) in rpc.calls


def test_native_asset_output_is_never_a_tsc_utxo(wallet_app):
    app, rpc = wallet_app
    rpc.asset = True
    response = app.test_client().get(f"/api/v1/address/{ADDRESS}/utxos")
    assert response.get_json()["utxos"] == []


def test_mutation_requires_allowed_origin_and_json(wallet_app):
    app, rpc = wallet_app
    client = app.test_client()
    denied = client.post(
        "/api/v1/transactions/broadcast",
        json={"signed_tx": "00"},
        headers={"Origin": "https://evil.example"},
    )
    assert denied.status_code == 403
    assert not any(method == "sendrawtransaction" for method, _ in rpc.calls)

    allowed = client.post(
        "/api/v1/transactions/broadcast",
        data=json.dumps({"signed_tx": "00"}),
        content_type="application/json",
        headers={"Origin": "https://wallet.example"},
    )
    assert allowed.status_code == 200
    assert allowed.get_json()["txid"] == TXID


def test_successful_broadcast_invalidates_wallet_mempool_cache(wallet_app):
    app, rpc = wallet_app
    client = app.test_client()
    overview = {"addresses": [ADDRESS], "page": 1, "page_size": 25}
    assert client.post("/api/v1/wallet/overview", json=overview).status_code == 200
    assert sum(method == "getrawmempool" for method, _params in rpc.calls) == 1

    response = client.post(
        "/api/v1/transactions/broadcast",
        data=json.dumps({"signed_tx": "00"}),
        content_type="application/json",
        headers={"Origin": "https://wallet.example"},
    )
    assert response.status_code == 200
    assert client.post("/api/v1/wallet/overview", json=overview).status_code == 200
    assert sum(method == "getrawmempool" for method, _params in rpc.calls) == 2


def test_failed_post_broadcast_refresh_keeps_last_mempool_snapshot(wallet_app):
    app, rpc = wallet_app
    pending_txid = "55" * 32
    rpc.mempool[pending_txid] = {"time": 1_800_000_000, "fees": {"base": 0.00001}}
    rpc.raw_transactions[pending_txid] = {
        "vin": [],
        "vout": [{
            "n": 0,
            "value": 0.5,
            "scriptPubKey": {"address": ADDRESS, "hex": SCRIPT},
        }],
    }
    client = app.test_client()
    overview = {"addresses": [ADDRESS], "page": 1, "page_size": 25}
    first = client.post("/api/v1/wallet/overview", json=overview).get_json()
    assert first["transactions"][0]["txid"] == pending_txid

    assert client.post(
        "/api/v1/transactions/broadcast",
        json={"signed_tx": "00"},
        headers={"Origin": "https://wallet.example"},
    ).status_code == 200
    rpc.fail_methods.add("getrawmempool")
    stale = client.post("/api/v1/wallet/overview", json=overview).get_json()

    assert stale["transactions"][0]["txid"] == pending_txid
    assert stale["pending_status"]["stale"] is True
    assert stale["pending_status"]["observed_at"] is not None


def test_transaction_hex_is_bounded_and_validated(wallet_app):
    app, _ = wallet_app
    client = app.test_client()
    response = client.post(
        "/api/v1/transactions/test",
        json={"signed_tx": "not-hex"},
        headers={"Origin": "https://wallet.example"},
    )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_transaction"


def test_malformed_core_preflight_is_a_controlled_503(wallet_app):
    app, rpc = wallet_app
    original_call = rpc.call

    def malformed(method, params=None):
        if method == "testmempoolaccept":
            return ["not-a-dict"]
        return original_call(method, params)

    rpc.call = malformed
    response = app.test_client().post(
        "/api/v1/transactions/broadcast",
        json={"signed_tx": "00"},
        headers={"Origin": "https://wallet.example"},
    )
    assert response.status_code == 503
    assert response.get_json()["error"]["code"] == "invalid_core_response"


def test_expensive_public_reads_are_rate_limited_in_application(wallet_app):
    app, _rpc = wallet_app
    client = app.test_client()
    responses = [
        client.post(
            "/api/v1/wallet/overview",
            json={"addresses": [ADDRESS], "include_pending": False},
            headers={"X-Real-IP": "203.0.113.40"},
        )
        for _ in range(13)
    ]
    assert all(response.status_code == 200 for response in responses[:12])
    assert responses[-1].status_code == 429
    assert responses[-1].headers["Retry-After"] == "1"


def test_overview_limiter_is_separate_from_transaction_work(wallet_app):
    app, _rpc = wallet_app
    client = app.test_client()
    for _ in range(12):
        assert client.post(
            "/api/v1/wallet/overview",
            json={"addresses": [ADDRESS], "include_pending": False},
            headers={"X-Real-IP": "203.0.113.44"},
        ).status_code == 200
    # Exhausting the anonymous overview bucket must not consume the stricter
    # transaction preflight/broadcast budget.
    assert client.post(
        "/api/v1/transactions/test",
        json={"signed_tx": "00"},
        headers={"Origin": "https://wallet.example", "X-Real-IP": "203.0.113.44"},
    ).status_code == 200


def test_single_address_utxo_reads_are_also_rate_limited(wallet_app):
    app, _rpc = wallet_app
    client = app.test_client()
    responses = [
        client.get(
            f"/api/v1/address/{ADDRESS}/utxos",
            headers={"X-Real-IP": "203.0.113.43"},
        )
        for _ in range(13)
    ]
    assert all(response.status_code == 200 for response in responses[:12])
    assert responses[-1].status_code == 429


def test_core_utxo_verification_is_chunked(wallet_app):
    app, rpc = wallet_app
    # Exercise the same bounded Core batch helper through a 120-tx mempool.
    rpc.mempool = {
        f"{index:064x}": {"time": 1_800_000_000 + index, "fees": {"base": 0.00001}}
        for index in range(120)
    }
    rpc.raw_transactions = {
        txid: {"vin": [], "vout": []} for txid in rpc.mempool
    }
    response = app.test_client().post(
        "/api/v1/wallet/overview",
        json={"addresses": [ADDRESS]},
        headers={"X-Real-IP": "203.0.113.41"},
    )
    assert response.status_code == 200
    assert rpc.batch_sizes[-3:] == [50, 50, 20]


def test_utxo_candidate_work_has_a_hard_limit(wallet_app):
    app, rpc = wallet_app
    rows = []
    links = []
    outputs = []
    for index in range(501):
        txid = f"{10_000 + index:064x}"
        rows.append((txid, BLOCK_HASH))
        links.append((ADDRESS, txid))
        outputs.append((txid, ADDRESS, SCRIPT))
    with sqlite3.connect(app.config["TEST_DATABASE"]) as connection:
        connection.executemany(
            "INSERT INTO transactions VALUES(?, 100, ?, 1, 1000, 0)", rows
        )
        connection.executemany(
            "INSERT INTO address_transactions VALUES(?, ?, 100, 1700000000, 125000000, 0, 125000000)",
            links,
        )
        connection.executemany(
            "INSERT INTO tx_outputs VALUES(?, 0, ?, 125000000, ?, NULL)", outputs
        )
    previous_batches = len(rpc.batch_sizes)
    response = app.test_client().post(
        "/api/v1/wallet/utxos",
        json={"addresses": [ADDRESS]},
        headers={"X-Real-IP": "203.0.113.42"},
    )
    assert response.status_code == 422
    assert response.get_json()["error"]["code"] == "wallet_utxo_limit"
    assert len(rpc.batch_sizes) == previous_batches


def test_pagination_has_a_hard_upper_bound(wallet_app):
    app, _rpc = wallet_app
    response = app.test_client().get(
        f"/api/v1/address/{ADDRESS}/transactions?page=10001"
    )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_pagination"
