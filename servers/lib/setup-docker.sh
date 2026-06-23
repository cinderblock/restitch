#!/bin/bash
# Shared deploy helper: ensure Docker Engine + compose plugin (and the small
# tools deploys rely on) are installed and usable by the current user.
#
# Bootstraps a from-scratch box from the deploy itself (IaC) — never by hand on
# the box. Idempotent and safe to source + call repeatedly.
#
# Non-root runners (e.g. a `cameron` self-hosted runner): a fresh `docker.io`
# install creates the `docker` group, but the already-running runner session
# won't have that group, so the socket isn't usable without sudo yet. This
# helper adds the user to the group and re-execs the *calling* script once under
# `sg docker` so the new group is active in the same run — no runner restart.
# Root runners short-circuit (the socket is already accessible).
#
# This file is SOURCED, not executed (it must be able to re-exec its caller):
#   source "${SCRIPT_DIR}/lib/setup-docker.sh"
#   ensure_docker "${SCRIPT_DIR}/deploy.sh"   # pass the caller's own path
#
# build.sh copies it into the bundle: cp servers/lib/setup-docker.sh <out>/lib/

# ensure_docker <reexec-script-path>
#   reexec-script-path: absolute path of the calling deploy script, used for the
#   docker-group re-exec. Required only on non-root runners that aren't yet in
#   the docker group; root/already-in-group callers may omit it.
ensure_docker() {
	local reexec_script="$1"

	local needed=()
	command -v docker &>/dev/null || needed+=(docker.io)
	docker compose version &>/dev/null 2>&1 || needed+=(docker-compose-v2)
	command -v curl &>/dev/null || needed+=(curl)
	command -v jq &>/dev/null || needed+=(jq)

	if [ ${#needed[@]} -gt 0 ]; then
		echo "Installing prerequisites: ${needed[*]}"
		sudo apt-get update -qq
		sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${needed[@]}"
	fi

	if ! systemctl is-active --quiet docker; then
		sudo systemctl enable --now docker
	fi

	# Already usable (root, or the session is already in the docker group)? Done.
	docker info &>/dev/null && return 0

	# usermod -aG is idempotent — safe even if already a member.
	echo "Ensuring $(id -un) is in the docker group..."
	sudo usermod -aG docker "$(id -un)"

	if [ -z "${OPS_DOCKER_GROUP_REEXEC:-}" ]; then
		if [ -z "$reexec_script" ]; then
			echo "Error: ensure_docker needs the caller's script path to re-exec under the docker group" >&2
			return 1
		fi
		echo "Re-executing under the docker group..."
		exec sg docker -c "OPS_DOCKER_GROUP_REEXEC=1 bash '$reexec_script'"
	fi

	# Post-re-exec: the group should be active now.
	docker info &>/dev/null && return 0
	echo "Error: docker socket not accessible as $(id -un) even after joining the docker group" >&2
	return 1
}
