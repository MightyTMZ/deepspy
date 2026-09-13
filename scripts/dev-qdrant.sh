#!/usr/bin/env bash
# Run Qdrant locally for development and for tests A3 and A4.
#
# Prefers Docker (docker-compose.yml). Falls back to the official native binary
# when Docker is unavailable, which is the case on some macOS dev machines.
#
#   bash scripts/dev-qdrant.sh          # start
#   bash scripts/dev-qdrant.sh stop     # stop the native binary
#
# Data lives in ./data/qdrant. Override the port with QDRANT_PORT.

set -euo pipefail

QDRANT_VERSION="${QDRANT_VERSION:-v1.19.1}"
QDRANT_PORT="${QDRANT_PORT:-6333}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${HOME}/.cache/periscope/qdrant"
STORAGE_DIR="${REPO_ROOT}/data/qdrant"
PID_FILE="${CACHE_DIR}/qdrant.pid"
LOG_FILE="${CACHE_DIR}/qdrant.log"

if [[ "${1:-start}" == "stop" ]]; then
  if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    kill "$(cat "${PID_FILE}")" && rm -f "${PID_FILE}"
    echo "qdrant stopped"
  else
    echo "no native qdrant running (try: docker compose down)"
  fi
  exit 0
fi

if curl -fsS "http://127.0.0.1:${QDRANT_PORT}/readyz" >/dev/null 2>&1; then
  echo "qdrant already ready on :${QDRANT_PORT}"
  exit 0
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "starting qdrant via docker compose"
  (cd "${REPO_ROOT}" && docker compose up -d qdrant)
else
  echo "docker unavailable; using the native qdrant binary"

  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) ASSET="qdrant-aarch64-apple-darwin.tar.gz" ;;
    Darwin-x86_64) ASSET="qdrant-x86_64-apple-darwin.tar.gz" ;;
    Linux-x86_64) ASSET="qdrant-x86_64-unknown-linux-gnu.tar.gz" ;;
    Linux-aarch64) ASSET="qdrant-aarch64-unknown-linux-musl.tar.gz" ;;
    *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac

  mkdir -p "${CACHE_DIR}" "${STORAGE_DIR}"
  if [[ ! -x "${CACHE_DIR}/qdrant" ]]; then
    echo "downloading qdrant ${QDRANT_VERSION} (${ASSET})"
    curl -fsSL -o "${CACHE_DIR}/qdrant.tar.gz" \
      "https://github.com/qdrant/qdrant/releases/download/${QDRANT_VERSION}/${ASSET}"
    tar xzf "${CACHE_DIR}/qdrant.tar.gz" -C "${CACHE_DIR}"
  fi

  # Run from the storage dir: qdrant drops a .qdrant-initialized marker in its
  # working directory, and that must not land in the repo root.
  (
    cd "${STORAGE_DIR}"
    QDRANT__STORAGE__STORAGE_PATH="${STORAGE_DIR}/storage" \
    QDRANT__STORAGE__SNAPSHOTS_PATH="${STORAGE_DIR}/snapshots" \
    QDRANT__SERVICE__HTTP_PORT="${QDRANT_PORT}" \
    QDRANT__TELEMETRY_DISABLED=true \
      nohup "${CACHE_DIR}/qdrant" >"${LOG_FILE}" 2>&1 &
    echo $! >"${PID_FILE}"
  )
fi

echo -n "waiting for qdrant on :${QDRANT_PORT}"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${QDRANT_PORT}/readyz" >/dev/null 2>&1; then
    echo " ready"
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo " timed out" >&2
[[ -f "${LOG_FILE}" ]] && tail -20 "${LOG_FILE}" >&2
exit 1
