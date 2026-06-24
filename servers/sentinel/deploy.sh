#!/bin/bash
# Deploy restitch to sentinel. Single self-hosted-runner workflow step
# checks out the repo and runs this script.
#
# Assumptions (provided by jackson's ops deploy):
#   - Docker is installed
#   - NVIDIA driver is loaded (nvidia-smi works)
#   - nvidia-container-toolkit is installed and `nvidia` runtime is
#     registered with Docker
#   - /opt/restitch/config.yaml exists (delivered by jackson)
#
# What this does:
#   1. Build restitch image locally from the checkout (no registry).
#   2. docker compose up -d --remove-orphans (compose pulls config.yaml
#      from /opt and mounts the local restitch:latest image).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "=== Validating host ==="
command -v docker  >/dev/null || { echo "Error: docker not installed. Push jackson first to bootstrap sentinel." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Error: docker socket not accessible to $(id -un)." >&2; exit 1; }
docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia \
    || { echo "Error: nvidia Docker runtime not registered. Push jackson first." >&2; exit 1; }
[ -f /opt/restitch/config.yaml ] \
    || { echo "Error: /opt/restitch/config.yaml is missing. Push jackson first." >&2; exit 1; }

echo "=== Building restitch image ==="
cd "${REPO_ROOT}"
docker build -t restitch:latest -f containers/restitch/Dockerfile .

echo "=== Bringing up the stack ==="
cd "${SCRIPT_DIR}"
docker compose up -d --remove-orphans

echo ""
echo "=== Done ==="
docker compose ps
