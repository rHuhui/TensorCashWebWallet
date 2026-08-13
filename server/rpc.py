from __future__ import annotations

import base64
import json
import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any
from urllib import error, request

logger = logging.getLogger(__name__)

class RPCError(RuntimeError):
    def __init__(self, code: int | str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class RPCClient:
    url: str
    user: str
    password: str = field(repr=False)
    timeout: float

    _ALLOWED = frozenset(
        {
            "getblockchaininfo",
            "getrawmempool",
            "getrawtransaction",
            "gettxout",
            "estimatesmartfee",
            "testmempoolaccept",
            "sendrawtransaction",
            "validateaddress",
        }
    )

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.user or self.password:
            raw = f"{self.user}:{self.password}".encode()
            headers["Authorization"] = "Basic " + base64.b64encode(raw).decode("ascii")
        return headers

    def _request(
        self,
        payload: object,
        *,
        timeout: float | None = None,
        operation: str = "rpc",
    ) -> Any:
        rpc_request = request.Request(
            self.url,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers=self._headers(),
            method="POST",
        )
        started = time.monotonic()
        try:
            with request.urlopen(
                rpc_request,
                timeout=self.timeout if timeout is None else timeout,
            ) as response:
                body = response.read(4 * 1024 * 1024 + 1)
        except (error.URLError, TimeoutError, OSError) as exc:
            logger.warning(
                "Core RPC transport failed operation=%s duration_ms=%d cause=%s",
                operation,
                round((time.monotonic() - started) * 1000),
                type(exc).__name__,
            )
            raise RPCError("unavailable", "TensorCash Core is unavailable") from exc
        if len(body) > 4 * 1024 * 1024:
            raise RPCError("response_too_large", "TensorCash Core response is too large")
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RPCError("invalid_response", "TensorCash Core returned invalid JSON") from exc

    def call(
        self,
        method: str,
        params: list[Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> Any:
        if method not in self._ALLOWED:
            raise RPCError("method_denied", "RPC method is not allowed")
        response = self._request(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []},
            timeout=timeout,
            operation=method,
        )
        if not isinstance(response, dict):
            raise RPCError("invalid_response", "TensorCash Core returned an invalid response")
        error = response.get("error")
        if error:
            if not isinstance(error, dict):
                raise RPCError("invalid_response", "TensorCash Core returned an invalid RPC error")
            raise RPCError(error.get("code", "rpc_error"), error.get("message", "RPC error"))
        return response.get("result")

    def batch(
        self,
        calls: Iterable[tuple[str, list[Any]]],
        *,
        timeout: float | None = None,
    ) -> list[Any]:
        payload = []
        for request_id, (method, params) in enumerate(calls, 1):
            if method not in self._ALLOWED:
                raise RPCError("method_denied", "RPC method is not allowed")
            payload.append(
                {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
            )
        if not payload:
            return []
        response = self._request(
            payload,
            timeout=timeout,
            operation=f"batch[{len(payload)}]",
        )
        if not isinstance(response, list):
            raise RPCError("invalid_response", "TensorCash Core returned an invalid batch")
        indexed = {item.get("id"): item for item in response if isinstance(item, dict)}
        results: list[Any] = []
        for request_id in range(1, len(payload) + 1):
            item = indexed.get(request_id)
            if item is None:
                raise RPCError("invalid_response", "TensorCash Core omitted a batch result")
            error = item.get("error")
            if error:
                if not isinstance(error, dict):
                    raise RPCError("invalid_response", "TensorCash Core returned an invalid RPC error")
                raise RPCError(
                    error.get("code", "rpc_error"), error.get("message", "RPC error")
                )
            results.append(item.get("result"))
        return results
