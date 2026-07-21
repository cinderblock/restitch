// CUDA compositing kernels for stitchd. NV12 (Y plane + interleaved UV,
// 4:2:0). All kernels are "gather" — every output pixel is written exactly
// once, so there are no unwritten regions (the green-edge class of bugs that
// plagued the NPP filtergraph cannot occur here).
#pragma once
#include <cstdint>
#include <cuda_runtime.h>

// Up to 8 stacked inputs of identical dimensions.
struct CompositeInputs {
  const uint8_t *y[8];
  const uint8_t *uv[8];
  int pitchY[8];  // bytes per Y row
  int pitchUV[8]; // bytes per UV row
  int n;          // number of inputs
  int inW;
  int inH;
};

// Vertical stack of `in.n` inputs (each inW x inH), then rotate 90 clockwise.
// Output dims: outW = n*inH, outH = inW. A null input plane fills tv-black
// (Y=16, U=V=128). Matches the ffmpeg `vstack -> transpose_npp=dir=clock`.
extern "C" void launch_vstack_rotate90cw(const CompositeInputs *in,
                                         uint8_t *outY, int outPitchY,
                                         uint8_t *outUV, int outPitchUV,
                                         int outW, int outH,
                                         cudaStream_t stream);
