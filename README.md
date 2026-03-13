# restitch

Stitch multiple RTSP camera streams into a single composite view and serve it (plus cropped sub-regions) via RTSP/HLS/WebRTC.

Built for Unifi cameras mounted across a shop ceiling, but works with any RTSP source.

## Architecture

```
RTSP Cameras  -->  FFmpeg (decode, rotate, stack, crop, encode)  -->  mediamtx (RTSP/HLS/WebRTC)  -->  Home Assistant / browsers
```

## Prerequisites

- [Bun](https://bun.sh) runtime
- [FFmpeg](https://ffmpeg.org) with ffprobe (for stream probing and processing)
  - For NVENC: FFmpeg must be built with `--enable-nvenc` (see `scripts/install-ffmpeg-nvenc.sh`)
- [mediamtx](https://github.com/bluenviron/mediamtx) (for restreaming to clients)
- NVIDIA GPU with NVENC support (recommended) or Intel QSV for hardware encoding

## Setup

```bash
bun install
cp config.example.yaml config.yaml
# Edit config.yaml with your camera URLs and settings
```

## Configuration

Edit `config.yaml` to define your cameras, composite layout, sub-streams, and encoder settings. See `config.example.yaml` for a documented template.

## Usage

```bash
# Dry run — show the FFmpeg command without executing
bun run dry-run

# Start with camera probing (production)
bun run start

# Start without probing (dev/testing, uses 2560x1440 defaults)
bun run dev
```

### CLI Options

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Config file path (default: `config.yaml`) |
| `--dry-run` | Print the FFmpeg command and exit |
| `--skip-probe` | Skip camera probing, use 2560x1440@30fps defaults |
| `--mediamtx-bin <path>` | Path to mediamtx binary (default: `mediamtx`) |
| `--no-mediamtx` | Don't launch mediamtx (if you're running it separately) |

## Output Streams

With the default config, streams are available at:

- `rtsp://host:8554/full` — full composite
- `rtsp://host:8554/<sub-stream-name>` — cropped sub-regions
- `http://host:8888/<stream-name>` — HLS (browser-friendly)
- `http://host:8889/<stream-name>` — WebRTC (low latency)

## Deployment

Designed for a Linux machine with an NVIDIA GPU (4090 recommended) for NVENC hardware encoding. Develop locally on Windows, deploy on Linux.

### Quick Deploy

```bash
# On the target Linux machine:
sudo bash scripts/deploy.sh <git-clone-url>

# Edit config:
nano /opt/restitch/config.yaml

# Start:
sudo systemctl start restitch

# View logs:
journalctl -u restitch -f
```

### Hardware Encoding

The encoder auto-detects available hardware. Set `hwaccel: auto` in config (default) or force a specific backend:

| GPU | Encoder | hwaccel | Notes |
|-----|---------|---------|-------|
| NVIDIA | `h264_nvenc` | `nvenc` | Best performance, recommended |
| Intel | `h264_qsv` | `qsv` | Works but CPU-limited for multi-stream |
| None | `libx264` | `none` | Software-only, very slow at these resolutions |

## License

MIT
