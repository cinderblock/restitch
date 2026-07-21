// stitchd — custom GPU compositor for restitch.
//
// Phase 1a: prove the toolchain — link libav* + CUDA, and confirm the codecs
// we depend on (NVDEC h264 decode, NVENC h264/hevc encode) are present in this
// libavcodec build and that a CUDA device is visible. This does no real work
// yet; it's the foundation the decode->composite->encode loop is built on.
//
// See plans/custom-compositor.md for the full design.

#include <cstdio>
#include <cstdlib>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <libavutil/version.h>
}

#include <cuda_runtime.h>

namespace {

// Report whether an encoder/decoder we rely on exists in this libav build.
bool report_codec(const char *name, bool encoder) {
  const AVCodec *c =
      encoder ? avcodec_find_encoder_by_name(name)
              : avcodec_find_decoder_by_name(name);
  std::printf("  %-14s %s: %s\n", name, encoder ? "encoder" : "decoder",
              c ? "present" : "MISSING");
  return c != nullptr;
}

// Confirm libavutil can create a CUDA hwdevice (the shared context the whole
// pipeline will decode/composite/encode on).
bool report_cuda_hwdevice() {
  AVBufferRef *dev = nullptr;
  int err = av_hwdevice_ctx_create(&dev, AV_HWDEVICE_TYPE_CUDA,
                                   /*device=*/nullptr, /*opts=*/nullptr, 0);
  if (err < 0) {
    char buf[256];
    av_strerror(err, buf, sizeof(buf));
    std::printf("  av_hwdevice_ctx_create(CUDA): FAILED (%s)\n", buf);
    return false;
  }
  std::printf("  av_hwdevice_ctx_create(CUDA): ok\n");
  av_buffer_unref(&dev);
  return true;
}

} // namespace

int main() {
  std::printf("stitchd phase-1a link/capability check\n");

  std::printf("libav versions:\n");
  std::printf("  libavformat %u.%u.%u\n", LIBAVFORMAT_VERSION_MAJOR,
              LIBAVFORMAT_VERSION_MINOR, LIBAVFORMAT_VERSION_MICRO);
  std::printf("  libavcodec  %u.%u.%u\n", LIBAVCODEC_VERSION_MAJOR,
              LIBAVCODEC_VERSION_MINOR, LIBAVCODEC_VERSION_MICRO);
  std::printf("  libavutil   %u.%u.%u\n", LIBAVUTIL_VERSION_MAJOR,
              LIBAVUTIL_VERSION_MINOR, LIBAVUTIL_VERSION_MICRO);

  int cuda_devices = 0;
  cudaError_t cerr = cudaGetDeviceCount(&cuda_devices);
  std::printf("CUDA: %d device(s)%s\n", cuda_devices,
              cerr == cudaSuccess ? "" : " (cudaGetDeviceCount error)");
  if (cerr == cudaSuccess && cuda_devices > 0) {
    cudaDeviceProp prop{};
    if (cudaGetDeviceProperties(&prop, 0) == cudaSuccess) {
      std::printf("  device 0: %s (sm_%d%d)\n", prop.name, prop.major,
                  prop.minor);
    }
  }

  std::printf("required codecs:\n");
  bool ok = true;
  ok &= report_codec("h264", /*encoder=*/false); // NVDEC path via hwaccel
  ok &= report_codec("h264_nvenc", /*encoder=*/true);
  ok &= report_codec("hevc_nvenc", /*encoder=*/true);

  std::printf("hw device:\n");
  bool hw_ok = report_cuda_hwdevice();

  bool all_ok = ok && hw_ok && cerr == cudaSuccess && cuda_devices > 0;
  std::printf("\n%s\n", all_ok ? "PHASE-1A OK" : "PHASE-1A FAILED");
  return all_ok ? 0 : 1;
}
