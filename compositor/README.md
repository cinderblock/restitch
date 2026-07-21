# stitchd — custom GPU compositor

A purpose-built, GPU-resident compositor that replaces the ffmpeg filtergraph
for restitch's main composite + extra composites. It decodes each camera once
(NVDEC), keeps frames in GPU memory, composites every output from the same
frames with a deterministic **newest-available-frame-per-output-tick** pairing
(no ffmpeg framesync), and encodes each output (NVENC) to mediamtx.

Why it exists, the full architecture, phases, and decisions:
**`../plans/custom-compositor.md`**.

It links our own `libav*` (RTSP I/O + NVDEC/NVENC) but does all compositing in
our own CUDA. It is NOT the ffmpeg CLI and has no ffmpeg filtergraph.

## Status
Phase 1a — toolchain/link check only (`src/main.cpp`). No real compositing yet.

## Build / dev loop (on sentinel)
Compiling needs the libav* dev libs + CUDA toolkit, which live in the
`stitchd-dev` image (= the ffmpeg-builder + cmake). The GPU is only needed to
*run*, not to compile.

```sh
# from a machine with the source, sync it to sentinel:
scp -r compositor sentinel:/tmp/stitchd-src

# compile (no GPU needed):
ssh sentinel 'docker run --rm -v /tmp/stitchd-src:/src -w /src/build \
  -e PKG_CONFIG_PATH=/opt/ffmpeg/lib/pkgconfig stitchd-dev:latest \
  sh -c "cmake .. && make -j"'

# run (needs the GPU):
ssh sentinel 'docker run --rm --gpus all -v /tmp/stitchd-src:/src \
  stitchd-dev:latest /src/build/stitchd'
```

For the production image, a `compositor-builder` Dockerfile stage compiles this
against the same `/opt/ffmpeg` and copies the `stitchd` binary into the runtime
image; the bun supervisor launches it in place of the main ffmpeg when
`compositor: native` is set in config.
