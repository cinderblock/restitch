#!/bin/bash
# Container entrypoint: ensure whisper models are present, then exec the
# main bun process. The models live on a named volume so we don't bake
# the 1.5 GB distil-large-v3 file into every image push/pull.
set -euo pipefail

MODELS_DIR="${WHISPER_MODELS_DIR:-/var/lib/whisper-models}"
WHISPER_MODEL_URL="${WHISPER_MODEL_URL:-https://huggingface.co/distil-whisper/distil-large-v3-ggml/resolve/main/ggml-distil-large-v3.bin}"
VAD_MODEL_URL="${VAD_MODEL_URL:-https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin}"
WHISPER_MIN_BYTES=500000000
VAD_MIN_BYTES=500000

mkdir -p "${MODELS_DIR}"

download_if_missing() {
	local url="$1" path="$2" min_bytes="$3" name="$4"
	if [[ -f "${path}" ]] && [[ "$(stat -c%s "${path}")" -ge "${min_bytes}" ]]; then
		echo "[entrypoint] ${name}: present ($(stat -c%s "${path}") bytes)"
		return 0
	fi
	echo "[entrypoint] ${name}: downloading from ${url}"
	curl -fL --retry 3 --retry-delay 5 -o "${path}.tmp" "${url}"
	local actual
	actual="$(stat -c%s "${path}.tmp")"
	if [[ "${actual}" -lt "${min_bytes}" ]]; then
		echo "[entrypoint] ERROR: ${name} downloaded ${actual} bytes, expected >= ${min_bytes}" >&2
		rm -f "${path}.tmp"
		exit 1
	fi
	mv "${path}.tmp" "${path}"
	echo "[entrypoint] ${name}: saved (${actual} bytes)"
}

download_if_missing \
	"${WHISPER_MODEL_URL}" \
	"${MODELS_DIR}/ggml-distil-large-v3.bin" \
	"${WHISPER_MIN_BYTES}" \
	"distil-large-v3"

download_if_missing \
	"${VAD_MODEL_URL}" \
	"${MODELS_DIR}/ggml-silero-v5.1.2.bin" \
	"${VAD_MIN_BYTES}" \
	"silero-v5.1.2"

echo "[entrypoint] models ready in ${MODELS_DIR}; handing off to bun"
exec "$@"
