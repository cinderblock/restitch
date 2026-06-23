#!/bin/bash
# Shared deploy helper: install + configure NVIDIA Container Toolkit so
# Docker can pass --gpus all to containers (and they can use NVENC/NVDEC
# via the host's NVIDIA driver).
#
# Requires:
#   - The NVIDIA *driver* is already installed on the host (nvidia-smi works).
#     Driver install is a one-time manual op (heavy, reboot required) — see
#     README. This helper only handles the toolkit + Docker runtime registration.
#   - Docker is already installed (call ensure_docker first).
#
# Idempotent — re-running is a no-op when toolkit is current and registered.
#
# Source + call: source lib/setup-nvidia-container.sh && ensure_nvidia_container

ensure_nvidia_container() {
	# Driver check (we don't install drivers from CI — too invasive)
	if ! command -v nvidia-smi &>/dev/null; then
		echo "Error: nvidia-smi not found." >&2
		echo "Install the NVIDIA driver on the host first (one-time, requires reboot):" >&2
		echo "  sudo ubuntu-drivers install --gpgpu" >&2
		echo "  sudo reboot" >&2
		return 1
	fi

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
