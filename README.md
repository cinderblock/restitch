# restitch

Stitch multiple RTSP camera streams into a single composite view and serve it (plus cropped sub-regions and per-camera restream paths) via RTSP/HLS/WebRTC. Includes an on-host GPU-accelerated transcription pipeline (whisper.cpp) and an operator dashboard.

Built for Unifi cameras mounted across a shop ceiling, but works with any RTSP source.

## Architecture

```
                          .--> FFmpeg compositor --.    composite + crops
                         /     (decode/stack/crop/  \
RTSP Cameras --> mediamtx       encode, publishes    +--> clients
                         \      back to mediamtx)   /    (HA, browsers, NVR replacements, ...)
                          '----- raw per-camera --'
```

mediamtx is the single upstream client of each camera: it holds one persistent
TCP RTSP connection per camera and fans out to every consumer (the compositor,
HA, browsers, etc.). That keeps the load on the upstream NVR fixed regardless of
how many viewers are connected.

A single bun process supervises the whole stack:

| Subprocess | Purpose |
|---|---|
| mediamtx | RTSP/WebRTC/HLS server + control API |
| ffmpeg (main) | composite + sub-stream crops + stream-referencing extra composites |
| ffmpeg (extra) | one per camera-only `extra_composites` entry |
| whisper-server | CUDA speech-to-text |
| ffmpeg (audio fusion) | N-channel amerge → max-abs mono for transcription |
| dashboard | live status + per-stream actions |

## Deployment

This project deploys via the **IaC + self-hosted-runner** pattern shared with the [jackson ops repo](https://github.com/cinderblock/ops). On push to `master`:

1. A GitHub-hosted job builds the `restitch` container image and pushes it to GHCR.
2. A self-hosted runner on the target box (`sentinel`) pulls the new image and runs `docker compose up -d`.
3. `deploy.sh` bootstraps Docker + the NVIDIA Container Toolkit on a clean box — only the NVIDIA driver itself is a one-time manual install.

See [`servers/sentinel/README.md`](servers/sentinel/README.md) for the full deploy flow, runner registration, and box prerequisites.

**Config (`/opt/restitch/config.yaml`) is owned by jackson**, not this repo. Push the YAML in `jackson/servers/sentinel/restitch/`; jackson's deploy writes it to the host and restarts the restitch container.

## Local development

```bash
bun install
cp config.example.yaml config.yaml
# Edit config.yaml with your camera URLs and settings

bun run dry-run        # show ffmpeg command + exit (skips probing)
bun run start          # full run (probes cameras at startup)
bun run dev            # full run with skip-probe (assumes 2560x1440 @ 30fps)
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

- `rtsp://host:8554/raw/<camera-slug>` — per-camera restream
- `rtsp://host:8554/full` — full composite
- `rtsp://host:8554/<sub-stream-name>` — cropped sub-regions
- `http://host:8890/<stream-name>/` — HLS (browser-friendly)
- `http://host:8889/<stream-name>/` — WebRTC (low latency, H.264 only; media
  is UDP on port 8189 — for off-LAN viewers, forward that port and list a
  publicly reachable name in `webrtc.additional_hosts`)
- `http://host:9000/` — dashboard
- `http://host:9997/v3/paths/list` — mediamtx control API

## Hardware Encoding

The encoder auto-detects available hardware. Set `hwaccel: auto` in config (default) or force a specific backend:

| GPU | Encoder | hwaccel | Notes |
|-----|---------|---------|-------|
| NVIDIA | `h264_nvenc` / `hevc_nvenc` | `nvenc` | Best performance, recommended |
| Intel | `h264_qsv` | `qsv` | Works but CPU-limited for multi-stream |
| None | `libx264` | `none` | Software-only, very slow at these resolutions |

## License

MIT
