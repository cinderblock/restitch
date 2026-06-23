#!/bin/bash
# Deploy restitch to sentinel. Runs on the self-hosted runner registered
# to cinderblock/restitch (label 'sentinel'). Idempotent.
#
# Pipeline:
#   1. Ensure Docker + Compose (servers/lib/setup-docker.sh)
#   2. Ensure NVIDIA Container Toolkit + nvidia runtime in Docker
#      (servers/lib/setup-nvidia-container.sh)
#   3. Log in to GHCR with the workflow's GITHUB_TOKEN
#   4. docker compose pull + up -d --remove-orphans
#
# config.yaml at /opt/restitch/config.yaml is owned by jackson (separate
# ops repo); this deploy does NOT touch it. If it's missing, the restitch
# container will fail to start — the operator should run jackson's deploy
# first (or create the file by hand for a manual override).
#
# Expected env:
#   REGISTRY           ghcr.io
#   REGISTRY_USERNAME  github actor
#   REGISTRY_TOKEN     GITHUB_TOKEN
#   IMAGE_PREFIX       cinderblock/restitch

set -euo pipefail

echo "=== Deploying restitch to sentinel ==="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# --- 1. Docker ---
# shellcheck source=lib/setup-docker.sh
source "${SCRIPT_DIR}/lib/setup-docker.sh"
ensure_docker "${SCRIPT_DIR}/deploy.sh"

# --- 2. NVIDIA Container Toolkit ---
# shellcheck source=lib/setup-nvidia-container.sh
source "${SCRIPT_DIR}/lib/setup-nvidia-container.sh"
ensure_nvidia_container

# --- 3. Validate config ---
if [ ! -f /opt/restitch/config.yaml ]; then
	echo "Error: /opt/restitch/config.yaml is missing." >&2
	echo "  Config is owned by the jackson ops repo (servers/sentinel/restitch/config.yaml)." >&2
	echo "  Push jackson first, or scp a config in for a manual override." >&2
	exit 1
fi

# --- 4. GHCR login ---
if [ -z "${REGISTRY:-}" ] || [ -z "${REGISTRY_USERNAME:-}" ] || [ -z "${REGISTRY_TOKEN:-}" ] || [ -z "${IMAGE_PREFIX:-}" ]; then
	echo "Error: REGISTRY / REGISTRY_USERNAME / REGISTRY_TOKEN / IMAGE_PREFIX must all be set" >&2
	exit 1
fi
export REGISTRY IMAGE_PREFIX

echo "Logging into ${REGISTRY}..."
echo "${REGISTRY_TOKEN}" | docker login "${REGISTRY}" -u "${REGISTRY_USERNAME}" --password-stdin

# --- 5. Deploy ---
echo ""
echo "Pulling images..."
docker compose pull

echo ""
echo "Bringing up the stack..."
docker compose up -d --remove-orphans

echo ""
echo "=== Done ==="
docker compose ps
