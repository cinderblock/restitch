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
| ffmpeg (main) | composite + sub-stream crops |
| ffmpeg (extra) | one per `extra_composites` entry |
| whisper-server | CUDA speech-to-text |
| ffmpeg (audio fusion) | N-channel amerge → max-abs mono for transcription |
| dashboard | live status + per-stream actions |

## Deployment

Runs as a container on **sentinel** (RTX 4090), sharing the host's GPU through
the NVIDIA Container Toolkit. Everything about *how* and *which build* is owned
by the [ops repo](https://github.com/cinderblock/ops); this repo only produces
the image.

**Pushing to `master` does not deploy.** `.github/workflows/build.yml` builds
`containers/restitch/Dockerfile` on a GitHub-hosted runner and publishes
`ghcr.io/cinderblock/restitch:<sha>` — and stops. Which build sentinel runs is
pinned in ops at `servers/sentinel/stacks/restitch/pin.json`; only an ops push
changes it, and rollback is reverting that pin. The build is slow (whisper.cpp
with cuBLAS and ffmpeg both compile from source against CUDA), so the workflow
reclaims runner disk first and uses a registry build cache.

**Config is owned by ops too.** `config.yaml` (cameras, composite layout,
crops, transcription tuning) lives at `servers/sentinel/stacks/restitch/` in
ops and is bind-mounted read-only at `/etc/restitch/config.yaml`. Editing it
there and pushing ops recreates the container with the new config.

It used to work the other way: a self-hosted runner on sentinel built the
image locally on every push and brought it up itself. That runner is gone.

### Stream URLs

After deploy, the box exposes (via `network_mode: host`):

- RTSP `rtsp://sentinel:8554/<path>`
- WebRTC `http://sentinel:8889/<path>/` (browser-playable, low latency)
- HLS `http://sentinel:8890/<path>/`
- mediamtx API `http://sentinel:9997/v3/paths/list`
- Dashboard `http://sentinel:9000/`

Paths come from `config.yaml`: `raw/<camera-slug>`, `full`, `full-low`,
`the-field`, `john`, `entry`, plus any `extra_composites`.

## When a camera is down

No camera is a startup dependency. Each input connects on its own thread
inside stitchd and retries (1 s doubling to 30 s) for as long as the process
runs, whether it was down at startup or dropped later:

- A main-composite camera that is down is a black slot in the composite; the
  layout does not change, and the slot fills in when the camera connects.
- A restream-only camera's `raw/<slug>` appears on the RTSP server when it
  first connects. No restart.
- A camera an `extra_composites` entry takes by name, down *at startup*, has no
  known geometry to lay out: that output is left out, the camera is re-probed
  every 30 s, and stitchd restarts once to add the output when it answers. (If
  not one main-composite camera answers at startup, the same goes for the main
  composite and everything cut from it.)

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
