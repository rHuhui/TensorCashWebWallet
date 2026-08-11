from __future__ import annotations

from server.rpc import RPCClient, RPCError


def client() -> RPCClient:
    return RPCClient("http://127.0.0.1:1", "rpc-user", "secret-password", 1)


def test_rpc_password_is_redacted_from_repr():
    representation = repr(client())
    assert "secret-password" not in representation
    assert "password=" not in representation


def test_non_object_rpc_error_is_rejected(monkeypatch):
    rpc = client()
    monkeypatch.setattr(RPCClient, "_request", lambda _self, _payload: {"result": None, "error": "bad"})
    try:
        rpc.call("getblockchaininfo")
    except RPCError as error:
        assert error.code == "invalid_response"
    else:
        raise AssertionError("malformed RPC error was accepted")
