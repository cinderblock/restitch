#include "cuda_composite.h"

// Vertical stack + rotate 90 CW, NV12, gather form.
// Stacked S is (inW) x (n*inH): input i at rows [i*inH, (i+1)*inH).
// Output O after 90 CW is (n*inH) x (inW). Inverse map (gather):
//   O(co,ro) <- S(cs=ro, rs=Hs-1-co),  Hs = n*inH.
// Then S(cs,rs): input idx = rs/inH, local (col=cs, row=rs%inH).
__global__ void vstack_rot90cw_kernel(CompositeInputs in, uint8_t *outY,
                                      int outPitchY, uint8_t *outUV,
                                      int outPitchUV, int outW, int outH) {
  const int co = blockIdx.x * blockDim.x + threadIdx.x; // output col
  const int ro = blockIdx.y * blockDim.y + threadIdx.y; // output row
  if (co >= outW || ro >= outH)
    return;

  const int Hs = in.n * in.inH;
  const int cs = ro;
  const int rs = Hs - 1 - co;
  const int idx = rs / in.inH;
  const int lrow = rs - idx * in.inH;
  const int lcol = cs;

  // luma
  uint8_t Yv = 16; // tv black
  if (idx >= 0 && idx < in.n && in.y[idx])
    Yv = in.y[idx][lrow * in.pitchY[idx] + lcol];
  outY[ro * outPitchY + co] = Yv;

  // chroma: one write per even/even output luma pixel (4:2:0)
  if (((co | ro) & 1) == 0) {
    const int cco = co >> 1;
    const int cro = ro >> 1;
    uint8_t U = 128, V = 128;
    if (idx >= 0 && idx < in.n && in.uv[idx]) {
      const uint8_t *p =
          in.uv[idx] + (lrow >> 1) * in.pitchUV[idx] + (lcol >> 1) * 2;
      U = p[0];
      V = p[1];
    }
    uint8_t *q = outUV + cro * outPitchUV + cco * 2;
    q[0] = U;
    q[1] = V;
  }
}

extern "C" void launch_vstack_rotate90cw(const CompositeInputs *in,
                                         uint8_t *outY, int outPitchY,
                                         uint8_t *outUV, int outPitchUV,
                                         int outW, int outH,
                                         cudaStream_t stream) {
  const dim3 block(16, 16);
  const dim3 grid((outW + block.x - 1) / block.x,
                  (outH + block.y - 1) / block.y);
  vstack_rot90cw_kernel<<<grid, block, 0, stream>>>(
      *in, outY, outPitchY, outUV, outPitchUV, outW, outH);
}

// ---- crop + scale-aware Lanczos-3 + optional rotate180 --------------------
__device__ inline float lanczos3(float x) {
  if (x <= -3.f || x >= 3.f)
    return 0.f;
  if (x > -1e-6f && x < 1e-6f)
    return 1.f;
  const float px = 3.14159265358979f * x;
  return 3.f * __sinf(px) * __sinf(px * (1.f / 3.f)) / (px * px);
}

// Sample one channel of a plane at (fx,fy) with separable Lanczos-3, filter
// scale fs* (=min(1,dst/src) per axis so downscale widens the footprint).
// `bytesPerPix` and `chan` index interleaved planes (Y: 1/0, U: 2/0, V: 2/1).
__device__ float sampleL3(const uint8_t *p, int pitch, int W, int H, float fx,
                          float fy, float fsx, float fsy, int bytesPerPix,
                          int chan) {
  const float rx = 3.f / fsx, ry = 3.f / fsy;
  const int sx0 = (int)ceilf(fx - rx), sx1 = (int)floorf(fx + rx);
  const int sy0 = (int)ceilf(fy - ry), sy1 = (int)floorf(fy + ry);
  float accum = 0.f, wsum = 0.f;
  for (int sy = sy0; sy <= sy1; ++sy) {
    const int cy = min(max(sy, 0), H - 1);
    const float wy = lanczos3((sy - fy) * fsy);
    for (int sx = sx0; sx <= sx1; ++sx) {
      const int cx = min(max(sx, 0), W - 1);
      const float w = wy * lanczos3((sx - fx) * fsx);
      accum += w * p[cy * pitch + cx * bytesPerPix + chan];
      wsum += w;
    }
  }
  return wsum > 0.f ? accum / wsum : 0.f;
}

__global__ void crop_scale_rot180_kernel(
    const uint8_t *srcY, int srcPitchY, const uint8_t *srcUV, int srcPitchUV,
    int srcW, int srcH, int cropX, int cropY, int cropW, int cropH,
    uint8_t *dstY, int dstPitchY, uint8_t *dstUV, int dstPitchUV, int dstW,
    int dstH, int rot180) {
  const int xo = blockIdx.x * blockDim.x + threadIdx.x;
  const int yo = blockIdx.y * blockDim.y + threadIdx.y;
  if (xo >= dstW || yo >= dstH)
    return;
  const int xe = rot180 ? (dstW - 1 - xo) : xo;
  const int ye = rot180 ? (dstH - 1 - yo) : yo;

  // center-aligned map from dst pixel to source (luma) coord
  const float fx = cropX + (xe + 0.5f) * cropW / (float)dstW - 0.5f;
  const float fy = cropY + (ye + 0.5f) * cropH / (float)dstH - 0.5f;
  const float fsx = fminf(1.f, dstW / (float)cropW);
  const float fsy = fminf(1.f, dstH / (float)cropH);

  float Y = sampleL3(srcY, srcPitchY, srcW, srcH, fx, fy, fsx, fsy, 1, 0);
  dstY[yo * dstPitchY + xo] = (uint8_t)min(max((int)(Y + 0.5f), 0), 255);

  if (((xo | yo) & 1) == 0) {
    // chroma is half-res, co-sited; source chroma coord = luma/2
    const float cfx = fx * 0.5f, cfy = fy * 0.5f;
    const int cW = srcW >> 1, cH = srcH >> 1;
    float U = sampleL3(srcUV, srcPitchUV, cW, cH, cfx, cfy, fsx, fsy, 2, 0);
    float V = sampleL3(srcUV, srcPitchUV, cW, cH, cfx, cfy, fsx, fsy, 2, 1);
    uint8_t *q = dstUV + (yo >> 1) * dstPitchUV + (xo >> 1) * 2;
    q[0] = (uint8_t)min(max((int)(U + 0.5f), 0), 255);
    q[1] = (uint8_t)min(max((int)(V + 0.5f), 0), 255);
  }
}

extern "C" void launch_crop_scale_rot180(
    const uint8_t *srcY, int srcPitchY, const uint8_t *srcUV, int srcPitchUV,
    int srcW, int srcH, int cropX, int cropY, int cropW, int cropH,
    uint8_t *dstY, int dstPitchY, uint8_t *dstUV, int dstPitchUV, int dstW,
    int dstH, int rot180, cudaStream_t stream) {
  const dim3 block(16, 16);
  const dim3 grid((dstW + block.x - 1) / block.x,
                  (dstH + block.y - 1) / block.y);
  crop_scale_rot180_kernel<<<grid, block, 0, stream>>>(
      srcY, srcPitchY, srcUV, srcPitchUV, srcW, srcH, cropX, cropY, cropW,
      cropH, dstY, dstPitchY, dstUV, dstPitchUV, dstW, dstH, rot180);
}
