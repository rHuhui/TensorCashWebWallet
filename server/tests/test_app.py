from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from server.app import create_app
from server.config import Settings


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

    def call(self, method, params=None):
        self.calls.append((method, params or []))
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
    )
    app = create_app(settings, rpc)
    app.config.update(TESTING=True)
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
