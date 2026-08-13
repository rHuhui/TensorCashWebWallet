from __future__ import annotations

from urllib import error

from server.rpc import RPCClient, RPCError


def client() -> RPCClient:
    return RPCClient("http://127.0.0.1:1", "rpc-user", "secret-password", 1)


def test_rpc_password_is_redacted_from_repr():
    representation = repr(client())
    assert "secret-password" not in representation
    assert "password=" not in representation


def test_non_object_rpc_error_is_rejected(monkeypatch):
    rpc = client()
    monkeypatch.setattr(
        RPCClient,
        "_request",
        lambda _self, _payload, **_kwargs: {"result": None, "error": "bad"},
    )
    try:
        rpc.call("getblockchaininfo")
    except RPCError as error:
        assert error.code == "invalid_response"
    else:
        raise AssertionError("malformed RPC error was accepted")


def test_read_call_can_override_timeout_without_changing_client_default(monkeypatch):
    rpc = client()
    observed = {}

    def request(_self, _payload, **kwargs):
        observed.update(kwargs)
        return {"result": {"blocks": 1}, "error": None}

    monkeypatch.setattr(RPCClient, "_request", request)
    assert rpc.call("getblockchaininfo", timeout=0.5) == {"blocks": 1}
    assert observed == {"timeout": 0.5, "operation": "getblockchaininfo"}
    assert rpc.timeout == 1


def test_transport_diagnostics_do_not_log_credentials_or_rpc_payload(monkeypatch, caplog):
    rpc = client()

    def unavailable(_request, timeout):
        assert timeout == 0.5
        raise error.URLError("offline")

    monkeypatch.setattr("server.rpc.request.urlopen", unavailable)
    try:
        rpc.call("sendrawtransaction", ["deadbeef"], timeout=0.5)
    except RPCError as exc:
        assert exc.code == "unavailable"
    else:
        raise AssertionError("transport failure was not surfaced")

    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "operation=sendrawtransaction" in messages
    assert "secret-password" not in messages
    assert "deadbeef" not in messages
