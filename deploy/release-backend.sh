#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /absolute/path/to/server-release.tar.gz" >&2
  exit 64
fi

archive=$1
case "$archive" in
  /*) ;;
  *) echo "release archive must use an absolute path" >&2; exit 64 ;;
esac
[ -f "$archive" ] || { echo "release archive not found" >&2; exit 66; }

release_id=$(date -u +%Y%m%dT%H%M%SZ)
release_root=/opt/tscwallet/releases/backend-$release_id
candidate=/opt/tscwallet/server.next-$release_id
previous=/opt/tscwallet/server.previous-$release_id

install -d -m 0755 "$release_root"
tar -xzf "$archive" -C "$release_root"
[ -f "$release_root/server/app.py" ] || { echo "server/app.py missing" >&2; exit 65; }

find "$release_root/server" -type d -exec chmod 0755 {} \;
find "$release_root/server" -type f -exec chmod 0644 {} \;
chown -R root:root "$release_root"

/opt/tscwallet/.venv/bin/python -m py_compile \
  "$release_root/server/app.py" \
  "$release_root/server/config.py" \
  "$release_root/server/rpc.py"

ln -s "$release_root/server" "$candidate"
mv /opt/tscwallet/server "$previous"
mv "$candidate" /opt/tscwallet/server

rollback() {
  systemctl stop tscwallet-gateway.service || true
  failed=/opt/tscwallet/server.failed-$release_id
  mv /opt/tscwallet/server "$failed" || true
  mv "$previous" /opt/tscwallet/server
  systemctl start tscwallet-gateway.service
}

systemctl restart tscwallet-gateway.service
healthy=0
attempt=0
while [ "$attempt" -lt 40 ]; do
  if curl -fsS --max-time 2 http://127.0.0.1:9920/healthz >/dev/null; then
    healthy=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.25
done

if [ "$healthy" -ne 1 ]; then
  echo "health check failed; rolling back" >&2
  rollback
  exit 1
fi

echo "released backend-$release_id; previous=$previous"
