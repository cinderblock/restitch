# Sentinel — restitch deploy

Restitch runs on **sentinel** (RTX 4090, Ubuntu 24.04), the same box that hosts
Caddy via the [jackson ops repo](https://github.com/cinderblock/jackson). Both
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

These two are one-time, manual, because they require a reboot and are too
heavy for a CI step:

1. **NVIDIA driver**
	```bash
	sudo ubuntu-drivers install --gpgpu
	sudo reboot
	# Verify after reboot
	nvidia-smi
	```
2. **`cameron` user with passwordless sudo** (already true if jackson's runner
   is installed). Required so `deploy.sh` can apt-install docker and the
   NVIDIA container toolkit without prompts.

Everything else — Docker, `nvidia-container-toolkit`, the `nvidia` Docker
runtime, the restitch container itself — is installed by `deploy.sh` on the
first run.

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

1. GitHub-hosted job builds the `restitch` container image and pushes it to
   `ghcr.io/cinderblock/restitch/restitch:<sha>` and `:latest`.
2. `ensure-runners` checks the `sentinel` runner is online; if not, prints
   re-registration commands and waits.
3. `build-server-bundle` runs `build.sh`, resolving the just-built image SHA
   into `docker-compose.yml`, bundling `deploy.sh` + lib helpers.
4. `deploy-server-bundle` runs on the self-hosted runner, downloads the
   bundle, runs `deploy.sh`, which bootstraps Docker + nvidia-container-
   toolkit on a clean box and brings the stack up.

## Stream URLs

After deploy, the box exposes (via `network_mode: host`):

- RTSP `rtsp://sentinel:8554/<path>`
- WebRTC `http://sentinel:8889/<path>/` (browser-playable, low latency)
- HLS `http://sentinel:8890/<path>/`
- mediamtx API `http://sentinel:9997/v3/paths/list`
- Dashboard `http://sentinel:9000/`

Paths come from `config.yaml`: `raw/<camera-slug>`, `full`, `full-low`,
`the-field`, `john`, `entry`, plus any `extra_composites`.
