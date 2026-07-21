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
