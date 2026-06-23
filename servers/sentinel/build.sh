#!/bin/bash
# Build a deployment bundle for sentinel. Run in GitHub-hosted CI.
#
# Resolves the restitch image version from versions.json (taking 'latest'
# from the workflow's just-built image), then stages deploy.sh +
# docker-compose.yml + shared lib helpers into the output dir for upload
# as a workflow artifact.
#
# Usage: ./build.sh <output-dir>
#
# Required env:
#   REGISTRY       e.g. ghcr.io
#   IMAGE_PREFIX   e.g. cinderblock/restitch
#   RESTITCH_VERSION   optional override; falls back to versions.json (which
#                      should be set to the SHA tag the workflow just pushed)

set -euo pipefail

if [ $# -eq 0 ]; then
	echo "Error: output directory required" >&2
	echo "Usage: $0 <output-dir>" >&2
	exit 1
fi

OUTPUT_DIR="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

mkdir -p "${OUTPUT_DIR}"

# --- Resolve restitch image version ---
RESTITCH_VERSION="${RESTITCH_VERSION:-$(jq -r '.restitch // "latest"' "${SCRIPT_DIR}/versions.json")}"
if [ "${RESTITCH_VERSION}" = "latest" ] || [ -z "${RESTITCH_VERSION}" ]; then
	echo "Error: restitch version unresolved (got '${RESTITCH_VERSION}'). The workflow should pass RESTITCH_VERSION set to the just-built SHA tag." >&2
	exit 1
fi
echo "restitch image version: ${RESTITCH_VERSION}"

# --- Stage deploy assets ---
cp "${SCRIPT_DIR}/deploy.sh" "${OUTPUT_DIR}/deploy.sh"

# Substitute the resolved version into docker-compose.yml so the deploy
# doesn't need to re-resolve at runtime (matches jackson's build pattern).
sed "s/\${RESTITCH_VERSION:-latest}/${RESTITCH_VERSION}/g" \
	"${SCRIPT_DIR}/docker-compose.yml" > "${OUTPUT_DIR}/docker-compose.yml"

# Shared deploy helpers (sourced by deploy.sh)
mkdir -p "${OUTPUT_DIR}/lib"
cp "${REPO_ROOT}/servers/lib/setup-docker.sh"          "${OUTPUT_DIR}/lib/setup-docker.sh"
cp "${REPO_ROOT}/servers/lib/setup-nvidia-container.sh" "${OUTPUT_DIR}/lib/setup-nvidia-container.sh"

echo "Bundle ready: ${OUTPUT_DIR}"
ls -la "${OUTPUT_DIR}"
