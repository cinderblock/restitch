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

// Crop a rect (cropX,cropY,cropW,cropH) from an NV12 source, resample it to
// (dstW x dstH) with scale-aware Lanczos-3, optionally rotating 180. When the
// crop and dst dims are equal it's an exact (unfiltered) copy/flip. Used for
// sub-streams (full-low scale, the-field crop+scale, john crop+rot180).
extern "C" void launch_crop_scale_rot180(
    const uint8_t *srcY, int srcPitchY, const uint8_t *srcUV, int srcPitchUV,
    int srcW, int srcH, int cropX, int cropY, int cropW, int cropH,
    uint8_t *dstY, int dstPitchY, uint8_t *dstUV, int dstPitchUV, int dstW,
    int dstH, int rot180, cudaStream_t stream);

// Downscale an NV12 source into PLANAR YUV420 (separate Y, U, V), for JPEG.
//
// Snapshots used to be made by spawning an ffmpeg per stream, which reconnected
// over RTSP and decoded a full frame just to throw away all but a thumbnail —
// 16 processes a minute once the raw cameras were listed. stitchd already holds
// every one of these frames in GPU memory, so a thumbnail is a downscale and a
// tiny JPEG encode. Box-filter averaged, which is the right resampler going
// this far down and cheap at thumbnail sizes.
extern "C" void launch_nv12_to_yuv420p_scaled(
    const uint8_t *srcY, int srcPitchY, const uint8_t *srcUV, int srcPitchUV,
    int srcW, int srcH,
    uint8_t *dstY, int dstStrideY, uint8_t *dstU, int dstStrideU,
    uint8_t *dstV, int dstStrideV, int dstW, int dstH, cudaStream_t stream);
