#!/usr/bin/env bash
set -euo pipefail

# Build whisper.cpp with CUDA on sentinel and stage the models the
# transcription service needs.
#
# Idempotent — safe to re-run. On a clean machine it will:
#   - apt install nvidia-cuda-toolkit (if nvcc missing)
#   - git clone + cmake + build whisper.cpp into /opt/whisper.cpp
#   - symlink the whisper-cli / whisper-server binaries to /usr/local/bin
#   - download the distil-large-v3 ggml model (~750 MB) and silero VAD
#     (~15 MB) into /opt/restitch/models/
#
# Run as root (sudo). Usage:
#   sudo bash scripts/install-whisper.sh

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run as root (sudo)" >&2
  exit 1
fi

INSTALL_DIR="${INSTALL_DIR:-/opt/whisper.cpp}"
MODELS_DIR="${MODELS_DIR:-/opt/restitch/models}"
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:-cameron}}"

echo "=== whisper.cpp install ==="
echo "  install_dir: $INSTALL_DIR"
echo "  models_dir:  $MODELS_DIR"
echo "  service_user: $SERVICE_USER"

# --- 1. CUDA toolkit (provides nvcc) ---
if ! command -v nvcc &>/dev/null; then
  echo ""
  echo "--- Installing nvidia-cuda-toolkit ---"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    nvidia-cuda-toolkit cmake build-essential git
else
  echo "nvcc found: $(nvcc --version | tail -1)"
fi

# --- 2. Clone / update whisper.cpp ---
echo ""
echo "--- Source ---"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating $INSTALL_DIR..."
  git -C "$INSTALL_DIR" fetch --tags
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "Cloning whisper.cpp into $INSTALL_DIR..."
  git clone https://github.com/ggerganov/whisper.cpp.git "$INSTALL_DIR"
fi

# --- 3. Build with cuBLAS ---
echo ""
echo "--- Build (cuBLAS) ---"
cd "$INSTALL_DIR"
cmake -B build -DGGML_CUDA=1 -DWHISPER_BUILD_SERVER=ON
cmake --build build -j --config Release

# --- 4. Symlinks ---
echo ""
echo "--- Installing binaries ---"
for bin in whisper-cli whisper-server; do
  if [[ -x "$INSTALL_DIR/build/bin/$bin" ]]; then
    ln -sf "$INSTALL_DIR/build/bin/$bin" "/usr/local/bin/$bin"
    echo "  /usr/local/bin/$bin -> $INSTALL_DIR/build/bin/$bin"
  else
    echo "  WARN: $bin not built — expected at $INSTALL_DIR/build/bin/$bin" >&2
  fi
done

# --- 5. Models ---
echo ""
echo "--- Models ---"
mkdir -p "$MODELS_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$MODELS_DIR"

download_if_missing() {
  local url="$1" path="$2" min_bytes="$3"
  if [[ -f "$path" ]] && [[ "$(stat -c%s "$path")" -ge "$min_bytes" ]]; then
    echo "  exists: $path ($(stat -c%s "$path") bytes)"
    return 0
  fi
  echo "  downloading $url"
  curl -fL --progress-bar -o "$path.tmp" "$url"
  local actual
  actual="$(stat -c%s "$path.tmp")"
  if [[ "$actual" -lt "$min_bytes" ]]; then
    echo "  ERROR: downloaded $actual bytes, expected >= $min_bytes" >&2
    rm -f "$path.tmp"
    return 1
  fi
  mv "$path.tmp" "$path"
  chown "$SERVICE_USER:$SERVICE_USER" "$path"
  echo "  saved $path ($actual bytes)"
}

# distil-large-v3 ggml — community ggml conversion of distil-whisper/distil-large-v3
download_if_missing \
  "https://huggingface.co/distil-whisper/distil-large-v3-ggml/resolve/main/ggml-distil-large-v3.bin" \
  "$MODELS_DIR/ggml-distil-large-v3.bin" \
  500000000

# silero-v5 VAD ggml model (~885 KB; from ggml-org/whisper-vad HF repo)
download_if_missing \
  "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" \
  "$MODELS_DIR/ggml-silero-v5.1.2.bin" \
  500000

echo ""
echo "=== Done ==="
echo ""
echo "Smoke test:"
echo "  whisper-server \\"
echo "    --model $MODELS_DIR/ggml-distil-large-v3.bin \\"
echo "    --vad --vad-model $MODELS_DIR/ggml-silero-v5.1.2.bin \\"
echo "    --host 127.0.0.1 --port 9876"
