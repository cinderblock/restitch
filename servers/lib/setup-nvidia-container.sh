#!/bin/bash
# Shared deploy helpers for NVIDIA on the host:
#
#   ensure_nvidia_driver     — install + load the NVIDIA driver. If a new
#                              driver is installed, schedules a reboot and
#                              exits 1 so the deploy gets re-run after the
#                              box comes back. Skips when nvidia-smi already
#                              works.
#
#   ensure_nvidia_container  — install nvidia-container-toolkit and register
#                              the `nvidia` runtime with Docker. Assumes the
#                              driver works (ensure_nvidia_driver ran first).
#                              Requires Docker (call ensure_docker first).
#
# Both functions are idempotent. Source the file and call them in order:
#
#   source lib/setup-nvidia-container.sh
#   ensure_nvidia_driver      # may reboot + exit; caller never returns
#   ensure_nvidia_container

# Driver install + reboot dance. On a wiped box this is the only operation
# that needs the host to restart; we schedule a delayed reboot so the deploy
# step has time to print its log line before the runner dies. The workflow
# fails, the operator re-triggers it (or a scheduled retry does), and on
# the second pass nvidia-smi works and this function short-circuits.
ensure_nvidia_driver() {
	if command -v nvidia-smi &>/dev/null && nvidia-smi >/dev/null 2>&1; then
		echo "NVIDIA driver: present ($(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1))"
		return 0
	fi

	echo "NVIDIA driver not loaded. Installing..."
	sudo apt-get update -qq
	# ubuntu-drivers-common ships `ubuntu-drivers` which detects the right
	# driver for the GPU. For newer cards `ubuntu-drivers install --gpgpu` is
	# a no-op (the device gets manual_install:True) so we parse the
	# recommended driver and apt-install it directly.
	sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ubuntu-drivers-common
	local recommended
	recommended=$(ubuntu-drivers devices 2>/dev/null \
		| awk '/^driver.*nvidia-driver-.*recommended/ {print $3; exit}')
	if [ -z "$recommended" ]; then
		# Fallback: any nvidia-driver-* entry
		recommended=$(ubuntu-drivers devices 2>/dev/null \
			| awk '/^driver.*nvidia-driver-/ {print $3; exit}')
	fi
	if [ -z "$recommended" ]; then
		echo "Error: no NVIDIA driver candidate found by ubuntu-drivers." >&2
		echo "ubuntu-drivers devices output:" >&2
		ubuntu-drivers devices 2>&1 | sed 's/^/  /' >&2
		return 1
	fi
	echo "Installing ${recommended}..."
	sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${recommended}"

	# Some boxes pick up the driver without a reboot (modprobe nvidia works),
	# but the safe and consistent answer is to reboot. Schedule a delayed
	# reboot so this script can return / the runner step can print its log,
	# then exit non-zero to fail the deploy. Operator re-runs the workflow
	# after the box comes back online.
	echo ""
	echo "============================================================"
	echo "NVIDIA driver was just installed. Rebooting the box in 30s."
	echo "Re-run this workflow after sentinel comes back online."
	echo "============================================================"
	# --no-block returns immediately; --no-wall suppresses the wall broadcast.
	sudo systemd-run --on-active=30 --timer-property=AccuracySec=1s \
		systemctl reboot --no-wall
	return 1
}

ensure_nvidia_container() {
	# Toolkit install
	if ! command -v nvidia-ctk &>/dev/null; then
		echo "Installing nvidia-container-toolkit from NVIDIA's apt repo..."
		# Repo + signing key (idempotent — overwrites on rerun)
		curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
			| sudo gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
		curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
			| sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
			| sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
		sudo apt-get update -qq
		sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nvidia-container-toolkit
	fi

	# Register the nvidia runtime with the Docker daemon (idempotent — nvidia-ctk
	# merges into /etc/docker/daemon.json).
	echo "Registering nvidia runtime with Docker..."
	sudo nvidia-ctk runtime configure --runtime=docker
	sudo systemctl restart docker

	# Smoke test
	if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
		echo "nvidia runtime registered."
	else
		echo "Error: nvidia runtime not visible to Docker after configuration" >&2
		return 1
	fi
}
