# Sentinel — restitch deploy

Restitch runs on **sentinel** (RTX 4090, Ubuntu 24.04), the same box that hosts
Caddy via the [jackson ops repo](https://github.com/cinderblock/ops). Both
apps share the host driver / Docker / hardware but each has its own GitHub
Actions self-hosted runner and deploys independently.

## Ownership split

| Concern | Owner | Lives in |
|---|---|---|
| Code, container image | **restitch** | this repo, `containers/restitch/Dockerfile` |
| Camera URLs, composite layout, sub-stream crops, transcription tuning | **jackson** | `jackson/servers/sentinel/restitch/config.yaml` (delivered to `/opt/restitch/config.yaml`) |
| NVIDIA driver, host OS | manual | one-time, see below |
| Docker, NVIDIA Container Toolkit, runner registration | automated (jackson + this repo) | bootstrap on first deploy |

Code push to this repo → restitch CI rebuilds the image and `docker compose
pull && up -d` on sentinel. Config push to jackson → jackson writes the new
`/opt/restitch/config.yaml` and `docker restart restitch`.

## Box prerequisites

Host bootstrap (Docker, NVIDIA driver, nvidia-container-toolkit, `/opt/
restitch/config.yaml`) is owned by **jackson**. Push jackson first; once
its `deploy-server-bundle (sentinel)` job succeeds, sentinel is ready for
restitch. On a fresh box jackson's deploy installs the NVIDIA driver and
reboots — re-trigger that workflow once the box is back up.

Restitch's deploy assumes the GPU is wired up and just builds + brings up
the container.

## Self-hosted runner

The restitch deploy job runs on a self-hosted runner with label `sentinel`
registered to `cinderblock/restitch`. Jackson's ops workflow provisions it via
the `install-restitch-runner` job (`ensure-restitch-runner.sh` in
`jackson/servers/sentinel/`). The runner systemd unit is
`actions.runner.cinderblock-restitch.sentinel-restitch.service` and the binary
lives in `/home/cameron/actions-runner-restitch`.

## Deployment flow

Automated on push to `master` affecting `containers/restitch/**`,
`servers/sentinel/**`, `src/**`, or the deploy workflow itself.

One job, on the self-hosted `sentinel-restitch` runner:

1. `actions/checkout` pulls the repo onto sentinel.
2. `bash servers/sentinel/deploy.sh`:
   - validates Docker + nvidia runtime + config.yaml are present (jackson
     should have set these up),
   - `docker build -t restitch:latest -f containers/restitch/Dockerfile .`
     — uses sentinel's 24 cores + local layer cache,
   - `docker compose up -d --remove-orphans` — `pull_policy: never` keeps
     compose from looking for a registry image.

No GHCR push/pull. No bundle artifact. Image lives only in sentinel's
local docker layer cache.

## Stream URLs

After deploy, the box exposes (via `network_mode: host`):

- RTSP `rtsp://sentinel:8554/<path>`
- WebRTC `http://sentinel:8889/<path>/` (browser-playable, low latency)
- HLS `http://sentinel:8890/<path>/`
- mediamtx API `http://sentinel:9997/v3/paths/list`
- Dashboard `http://sentinel:9000/`

Paths come from `config.yaml`: `raw/<camera-slug>`, `full`, `full-low`,
`the-field`, `john`, `entry`, plus any `extra_composites`.
