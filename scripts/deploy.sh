#!/usr/bin/env bash
set -euo pipefail

# Restitch - Deployment Script
# Run this on the target Linux machine with an NVIDIA GPU.
# Usage: sudo bash deploy.sh [<git-clone-url>]

INSTALL_DIR="/opt/restitch"
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:?Run with sudo, or set SERVICE_USER}}"
REPO_URL="${1:-}"

echo "=== Restitch - Deployment ==="

# --- Check root ---
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (sudo)."
  exit 1
fi

# --- Check NVIDIA GPU ---
echo ""
echo "--- Checking NVIDIA GPU ---"
if ! command -v nvidia-smi &>/dev/null; then
  echo "ERROR: nvidia-smi not found. Install NVIDIA drivers first:"
  echo "  apt install nvidia-driver-535  (or newer)"
  exit 1
fi
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
echo "GPU detected."

# --- Check FFmpeg with NVENC ---
echo ""
echo "--- Checking FFmpeg NVENC support ---"
if ! command -v ffmpeg &>/dev/null; then
  echo "FFmpeg not found. Installing NVENC-capable static build..."
  bash "$(dirname "$0")/install-ffmpeg-nvenc.sh"
fi

if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc; then
  echo "FFmpeg has h264_nvenc support."
else
  echo "WARNING: FFmpeg found but missing h264_nvenc. Installing static build..."
  bash "$(dirname "$0")/install-ffmpeg-nvenc.sh"
fi

# --- Install Bun ---
echo ""
echo "--- Checking Bun ---"
if ! sudo -u "$SERVICE_USER" bash -c 'command -v bun' &>/dev/null; then
  echo "Installing Bun for $SERVICE_USER..."
  sudo -u "$SERVICE_USER" bash -c 'curl -fsSL https://bun.sh/install | bash'
fi
BUN_PATH=$(sudo -u "$SERVICE_USER" bash -c 'echo $HOME/.bun/bin/bun')
echo "Bun: $BUN_PATH"

# --- Install mediamtx ---
echo ""
echo "--- Checking mediamtx ---"
if ! command -v mediamtx &>/dev/null; then
  echo "Installing mediamtx..."
  MEDIAMTX_VERSION="1.16.3"
  ARCH=$(dpkg --print-architecture 2>/dev/null || echo "amd64")
  curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin mediamtx
  chmod +x /usr/local/bin/mediamtx
  echo "mediamtx installed to /usr/local/bin/mediamtx"
fi

# --- Clone/update project ---
echo ""
echo "--- Setting up project ---"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR"
  sudo -u "$SERVICE_USER" git pull
else
  if [[ -z "$REPO_URL" ]]; then
    echo "ERROR: No existing installation and no repo URL provided."
    echo "Usage: sudo bash deploy.sh <git-clone-url>"
    exit 1
  fi
  echo "Cloning from $REPO_URL..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
fi

# --- Install dependencies ---
echo ""
echo "--- Installing dependencies ---"
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" "$BUN_PATH" install

# --- Ensure video/render group membership ---
usermod -aG video,render "$SERVICE_USER" 2>/dev/null || true

# --- Install systemd service ---
echo ""
echo "--- Installing systemd service ---"
sed "s/__USER__/$SERVICE_USER/g" "$INSTALL_DIR/scripts/restitch.service" > /etc/systemd/system/restitch.service
systemctl daemon-reload
systemctl enable restitch.service
echo "Service installed and enabled."

# --- Config reminder ---
echo ""
echo "=== Deployment complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy config:  cp $INSTALL_DIR/config.example.yaml $INSTALL_DIR/config.yaml"
echo "  2. Edit config:  nano $INSTALL_DIR/config.yaml"
echo "  3. Start:        sudo systemctl start restitch"
echo "  4. View logs:    journalctl -u restitch -f"
echo ""
echo "Test streams:"
echo "  ffprobe rtsp://localhost:8554/full"
echo "  vlc rtsp://$(hostname):8554/full"
