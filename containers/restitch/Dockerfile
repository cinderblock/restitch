# syntax=docker/dockerfile:1.7
#
# Single-container restitch image. One bun process supervises:
#   - mediamtx (RTSP + WebRTC + HLS + control API)
#   - main ffmpeg compositor (vstack + sub-stream crops)
#   - one ffmpeg per extra_composite
#   - whisper-server (CUDA)
#   - audio fusion ffmpeg (N-channel amerge for transcription)
#   - dashboard HTTP server
#
# Built with --gpus all on the target host. NVIDIA_DRIVER_CAPABILITIES
# includes 'video' so NVENC/NVDEC encoder libraries are mounted in.

# --- builder: whisper.cpp with cuBLAS ---
FROM nvidia/cuda:12.9.2-devel-ubuntu24.04 AS whisper-builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        build-essential cmake git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ARG WHISPER_REF=v1.7.2
RUN git clone --depth 1 --branch "${WHISPER_REF}" \
        https://github.com/ggerganov/whisper.cpp.git /opt/whisper.cpp && \
    cd /opt/whisper.cpp && \
    cmake -B build -DGGML_CUDA=ON -DWHISPER_BUILD_SERVER=ON && \
    cmake --build build -j --config Release


# --- runtime ---
FROM nvidia/cuda:12.9.2-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        ca-certificates curl xz-utils tar jq unzip && \
    rm -rf /var/lib/apt/lists/*

# FFmpeg with NVENC/NVDEC support. BtbN's static GPL build bundles all the
# codecs we need (matches the existing native install script).
ARG FFMPEG_BUILD=ffmpeg-n7.1-latest-linux64-gpl-7.1
RUN curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FFMPEG_BUILD}.tar.xz" \
    | tar -xJ -C /tmp && \
    install -m 0755 "/tmp/${FFMPEG_BUILD}/bin/ffmpeg"  /usr/local/bin/ffmpeg && \
    install -m 0755 "/tmp/${FFMPEG_BUILD}/bin/ffprobe" /usr/local/bin/ffprobe && \
    rm -rf "/tmp/${FFMPEG_BUILD}"

# mediamtx (RTSP/WebRTC/HLS + control API). Version pinned via ARG so the
# build script can override from versions.json.
ARG MEDIAMTX_VERSION=1.16.3
RUN curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /usr/local/bin mediamtx && \
    chmod +x /usr/local/bin/mediamtx

# Bun (TypeScript runtime). Bun's installer scopes to BUN_INSTALL.
ARG BUN_VERSION=1.3.0
RUN curl -fsSL https://bun.sh/install | \
    BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" && \
    bun --version

# whisper-server + whisper-cli from the builder stage
COPY --from=whisper-builder /opt/whisper.cpp/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=whisper-builder /opt/whisper.cpp/build/bin/whisper-cli    /usr/local/bin/whisper-cli

# Restitch source
WORKDIR /opt/restitch
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src

# Models live on a named volume mounted by docker-compose. The entrypoint
# downloads them on first run if the volume is empty (saves ~1.5 GB on
# every image push/pull and avoids baking large files into the image).
ENV WHISPER_MODELS_DIR=/var/lib/whisper-models
VOLUME /var/lib/whisper-models

# Config is mounted by the host (jackson owns it; see servers/sentinel
# in the jackson repo). Read-only inside the container.
VOLUME /etc/restitch

# NVIDIA Container Toolkit reads these to mount the right driver libs:
#   compute = CUDA (whisper)
#   video   = NVENC/NVDEC (ffmpeg encoder + cuvid decoder)
ENV NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,video

COPY containers/restitch/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "run", "src/index.ts", "--config", "/etc/restitch/config.yaml"]
