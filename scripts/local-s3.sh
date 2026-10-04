#!/usr/bin/env bash
set -euo pipefail

port_offset=${S3_TEST_PORT_OFFSET:-0}
if [[ ! "$port_offset" =~ ^[0-9]{1,5}$ ]] || ((10#$port_offset > 20000)); then
  echo "S3_TEST_PORT_OFFSET must be an integer between 0 and 20000" >&2
  exit 1
fi
port_offset=$((10#$port_offset))

data_dir=$(mktemp -d "${TMPDIR:-/tmp}/astro-yandex-s3.XXXXXX")
mkdir -p .devenv
log_file="$PWD/.devenv/s3.log"
s3_pid=""

cleanup() {
  if [[ -n "$s3_pid" ]]; then
    kill -TERM "$s3_pid" 2>/dev/null || true
    wait "$s3_pid" 2>/dev/null || true
  fi
  rm -rf "$data_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "SeaweedFS data: $data_dir; log: $log_file"
AWS_ACCESS_KEY_ID=issue11-local \
  AWS_SECRET_ACCESS_KEY=issue11-local-secret \
  S3_BUCKET=issue11-ready \
  "$1" mini -dir="$data_dir" -ip=127.0.0.1 -ip.bind=127.0.0.1 \
  -master.port="$((19333 + port_offset))" \
  -volume.port="$((19340 + port_offset))" \
  -filer.port="$((18888 + port_offset))" \
  -s3.port="$((18333 + port_offset))" \
  -admin.port="$((23646 + port_offset))" \
  -webdav=false -admin.ui=false -s3.port.iceberg=0 -s3.port.lance=0 \
  -master.telemetry=false -volume.max=5 \
  -s3.autoCreateBucket=false \
  >"$log_file" 2>&1 &
s3_pid=$!
wait "$s3_pid"
