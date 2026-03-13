#!/usr/bin/env bash
set -euo pipefail

# Install a static FFmpeg build with NVENC support.
# Uses the BtbN auto-builds which include NVENC, VAAPI, and QSV.

echo "--- Installing FFmpeg with NVENC support ---"

ARCH=$(uname -m)
case "$ARCH" in
  x86_64) FFMPEG_ARCH="linux64" ;;
  aarch64) FFMPEG_ARCH="linuxarm64" ;;
  *)
    echo "ERROR: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

DOWNLOAD_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-${FFMPEG_ARCH}-gpl-7.1.tar.xz"
TEMP_DIR=$(mktemp -d)

echo "Downloading FFmpeg from BtbN builds..."
curl -fsSL "$DOWNLOAD_URL" | tar -xJ -C "$TEMP_DIR" --strip-components=2 "*/bin/ffmpeg" "*/bin/ffprobe"

# Back up existing ffmpeg if present
if command -v ffmpeg &>/dev/null; then
  EXISTING=$(command -v ffmpeg)
  if [[ "$EXISTING" != /usr/local/bin/ffmpeg ]]; then
    echo "Note: existing ffmpeg at $EXISTING will be shadowed by /usr/local/bin/ffmpeg"
  fi
fi

cp "$TEMP_DIR/ffmpeg" /usr/local/bin/ffmpeg
cp "$TEMP_DIR/ffprobe" /usr/local/bin/ffprobe
chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
rm -rf "$TEMP_DIR"

echo "FFmpeg installed to /usr/local/bin/ffmpeg"
ffmpeg -version | head -1

# Verify NVENC support
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc; then
  echo "h264_nvenc encoder: available"
else
  echo "WARNING: h264_nvenc not found. NVIDIA drivers may not be installed."
fi
