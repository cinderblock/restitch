# syntax=docker/dockerfile:1.7
#
# Single-container restitch image. One bun process supervises:
#   - mediamtx (RTSP + WebRTC + HLS + control API)
#   - main ffmpeg compositor (vstack + sub-stream crops)
#   - one ffmpeg per extra_composite (camera or stream: inputs)
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

ARG WHISPER_REF=v1.8.7
# nvidia/cuda:*-devel ships libcuda.so as a stub at .../stubs/ but cmake's
# find_library only looks in the standard lib dir, so ggml's CUDA driver
# symbols (cuMemCreate, cuGetErrorString, ...) come back undefined.
# Symlinking the stub into the standard location lets the link succeed.
# At runtime the real libcuda.so comes from the host driver via the
# nvidia-container-toolkit and shadows the stub.
RUN ln -sf /usr/local/cuda/lib64/stubs/libcuda.so /usr/local/cuda/lib64/libcuda.so && \
    ln -sf /usr/local/cuda/lib64/stubs/libcuda.so /usr/local/cuda/lib64/libcuda.so.1
# Repo moved from ggerganov to ggml-org. Note the binary names changed
# from `server`/`main` to `whisper-server`/`whisper-cli` in 1.8.x.
RUN git clone --depth 1 --branch "${WHISPER_REF}" \
        https://github.com/ggml-org/whisper.cpp.git /opt/whisper.cpp && \
    cd /opt/whisper.cpp && \
    cmake -B build \
        -DBUILD_SHARED_LIBS=OFF \
        -DGGML_CUDA=ON \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_EXAMPLES=ON \
        -DWHISPER_BUILD_SERVER=ON && \
    cmake --build build -j --config Release --target whisper-server whisper-cli


# --- builder: FFmpeg with CUDA filters + NPP (GPU transpose/scale) ---
# The stock BtbN GPL build has scale_cuda/overlay_cuda but no GPU rotation:
# transpose_npp needs NPP, which is nonfree and so absent from redistributable
# builds. We compile our own — NVDEC/NVENC via ffnvcodec, CUDA filter kernels
# via nvcc, NPP for transpose/scale — so the whole pixel path stays on the GPU
# (user policy: GPU or error, never CPU fallback). nonfree is fine here: this
# image is built and consumed locally on sentinel only (pull_policy: never),
# never pushed to a registry.
FROM nvidia/cuda:12.9.2-devel-ubuntu24.04 AS ffmpeg-builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        build-essential git ca-certificates pkg-config yasm nasm && \
    rm -rf /var/lib/apt/lists/*

# ffnvcodec: dlopen-based NVENC/NVDEC headers (no libcuda link needed at
# build time). n13.x needs driver >= 570; sentinel runs 595.
ARG FFNVCODEC_REF=n13.0.19.0
RUN git clone --depth 1 --branch "${FFNVCODEC_REF}" \
        https://github.com/FFmpeg/nv-codec-headers.git /opt/nv-codec-headers && \
    make -C /opt/nv-codec-headers install

# Pinned source build (the BtbN download tracked 'latest', so the binary could
# silently drift between image rebuilds — this pins it for good).
ARG FFMPEG_REF=n7.1.5
RUN git clone --depth 1 --branch "${FFMPEG_REF}" \
        https://github.com/FFmpeg/FFmpeg.git /opt/ffmpeg-src
# vf_overlay_cuda emits frames cloned from the 32-aligned hw frame pool with
# the POOL's padded dimensions (e.g. 1216x704 instead of 1200x676). Downstream
# consumers treat frame dims as truth: NVENC encodes the unwritten padding
# (green bars) and scale_npp/scale_cuda smear it into the edge columns. The
# patch clamps the forwarded frame back to the negotiated link size.
COPY containers/restitch/patches/vf_overlay_cuda_frame_dims.patch /tmp/
RUN cd /opt/ffmpeg-src && git apply /tmp/vf_overlay_cuda_frame_dims.patch && \
    grep -q "clamp back" libavfilter/vf_overlay_cuda.c
# --nvccflags: ffmpeg's default nvcc gencode targets archs CUDA 12 dropped;
# sm_89 = Ada (RTX 4090).
RUN cd /opt/ffmpeg-src && \
    ./configure \
        --prefix=/opt/ffmpeg \
        --disable-doc \
        --disable-ffplay \
        --enable-nonfree \
        --enable-cuda-nvcc \
        --enable-libnpp \
        --nvccflags="-gencode arch=compute_89,code=sm_89 -O2" \
        --extra-cflags=-I/usr/local/cuda/include \
        --extra-ldflags=-L/usr/local/cuda/lib64 && \
    make -j"$(nproc)" && \
    make install


# --- builder: stitchd, the custom CUDA compositor (compositor/) ---
# Compiles against the libav* we just built (/opt/ffmpeg) + CUDA/NPP. Only used
# when config `compositor: native`. Reuses the ffmpeg-builder stage so it has
# the static libav*, headers, pkgconfig, nvcc and NPP already in place.
FROM ffmpeg-builder AS compositor-builder
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends cmake && \
    rm -rf /var/lib/apt/lists/*
COPY compositor /opt/compositor
RUN cmake -S /opt/compositor -B /opt/compositor/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_PREFIX_PATH=/opt/ffmpeg && \
    PKG_CONFIG_PATH=/opt/ffmpeg/lib/pkgconfig \
        cmake --build /opt/compositor/build -j"$(nproc)"


# --- runtime ---
FROM nvidia/cuda:12.9.2-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        ca-certificates curl xz-utils tar jq unzip \
        libgomp1 \
        iproute2 procps && \
    rm -rf /var/lib/apt/lists/*

# FFmpeg from our own CUDA+NPP build (see ffmpeg-builder above). The binary
# static-links its libav* and dynamically links libnpp*/cudart, which the
# nvidia/cuda runtime image ships.
COPY --from=ffmpeg-builder /opt/ffmpeg/bin/ffmpeg  /usr/local/bin/ffmpeg
COPY --from=ffmpeg-builder /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe

# stitchd, the custom CUDA compositor (used when config `compositor: native`).
# Static-links libav*, dynamically links libnpp*/cudart from the cuda runtime.
COPY --from=compositor-builder /opt/compositor/build/stitchd /usr/local/bin/stitchd

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
