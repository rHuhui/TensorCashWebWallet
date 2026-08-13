from __future__ import annotations

from pathlib import Path


def test_backend_release_script_has_health_checked_rollback():
    script = (
        Path(__file__).resolve().parents[2] / "deploy" / "release-backend.sh"
    ).read_text()

    assert "set -eu" in script
    assert "python -m py_compile" in script
    assert "mv /opt/tscwallet/server" in script
    assert "systemctl restart tscwallet-gateway.service" in script
    assert "http://127.0.0.1:9920/healthz" in script
    assert "rolling back" in script
    assert "mv \"$previous\" /opt/tscwallet/server" in script
