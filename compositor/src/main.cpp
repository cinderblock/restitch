// stitchd — custom GPU compositor for restitch.
//
// Phase 1: prove the GPU-resident transcode loop in our OWN libav* code —
// RTSP in -> NVDEC decode (frames stay in CUDA memory) -> NVENC encode ->
// RTSP out, with decoder and encoder sharing ONE CUDA device context and NO
// PCIe download (zero-copy). No compositing yet; this is the plumbing every
// later phase builds on. Run with no args for the phase-1a capability check.
//
// See plans/custom-compositor.md.

#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
#include <libavutil/version.h>
}

#include <cuda_runtime.h>

// Set by SIGINT/SIGTERM; the run loop breaks and flushes cleanly (the
// supervisor stops us with SIGTERM, and a file muxer needs its trailer).
static volatile std::sig_atomic_t g_stop = 0;

namespace {

// ---- logging -------------------------------------------------------------
std::string av_err(int e) {
  char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(e, buf, sizeof(buf));
  return buf;
}
#define LOGF(...)                                                              \
  do {                                                                        \
    std::fprintf(stderr, "[stitchd] " __VA_ARGS__);                           \
    std::fprintf(stderr, "\n");                                               \
  } while (0)
#define FAIL(...)                                                             \
  do {                                                                        \
    LOGF(__VA_ARGS__);                                                        \
    return 1;                                                                 \
  } while (0)

// ---- NVDEC get_format: force CUDA frames out of the decoder ---------------
enum AVPixelFormat get_hw_format(AVCodecContext *, const enum AVPixelFormat *fmts) {
  for (const enum AVPixelFormat *p = fmts; *p != AV_PIX_FMT_NONE; ++p)
    if (*p == AV_PIX_FMT_CUDA)
      return *p;
  LOGF("decoder did not offer AV_PIX_FMT_CUDA");
  return AV_PIX_FMT_NONE;
}

// =========================================================================
// Phase 1a: capability / link self-check (no I/O).
// =========================================================================
int selftest() {
  std::printf("stitchd phase-1a link/capability check\n");
  std::printf("libav: avformat %u.%u.%u  avcodec %u.%u.%u  avutil %u.%u.%u\n",
              LIBAVFORMAT_VERSION_MAJOR, LIBAVFORMAT_VERSION_MINOR,
              LIBAVFORMAT_VERSION_MICRO, LIBAVCODEC_VERSION_MAJOR,
              LIBAVCODEC_VERSION_MINOR, LIBAVCODEC_VERSION_MICRO,
              LIBAVUTIL_VERSION_MAJOR, LIBAVUTIL_VERSION_MINOR,
              LIBAVUTIL_VERSION_MICRO);
  int n = 0;
  cudaError_t ce = cudaGetDeviceCount(&n);
  std::printf("CUDA: %d device(s)%s\n", n, ce == cudaSuccess ? "" : " (error)");
  bool ok = ce == cudaSuccess && n > 0;
  ok &= avcodec_find_decoder_by_name("h264") != nullptr;
  ok &= avcodec_find_encoder_by_name("h264_nvenc") != nullptr;
  ok &= avcodec_find_encoder_by_name("hevc_nvenc") != nullptr;
  AVBufferRef *dev = nullptr;
  ok &= av_hwdevice_ctx_create(&dev, AV_HWDEVICE_TYPE_CUDA, nullptr, nullptr,
                               0) >= 0;
  av_buffer_unref(&dev);
  std::printf("%s\n", ok ? "PHASE-1A OK" : "PHASE-1A FAILED");
  return ok ? 0 : 1;
}

// =========================================================================
// Phase 1: zero-copy RTSP transcode passthrough.
// =========================================================================
struct Input {
  AVFormatContext *fmt = nullptr;
  AVCodecContext *dec = nullptr;
  int stream = -1;
};

int open_input(const char *url, AVBufferRef *hw_device, Input &in) {
  AVDictionary *opt = nullptr;
  av_dict_set(&opt, "rtsp_transport", "tcp", 0);
  av_dict_set(&opt, "fflags", "nobuffer", 0);
  av_dict_set(&opt, "flags", "low_delay", 0);
  int err = avformat_open_input(&in.fmt, url, nullptr, &opt);
  av_dict_free(&opt);
  if (err < 0) FAIL("open_input(%s): %s", url, av_err(err).c_str());
  if ((err = avformat_find_stream_info(in.fmt, nullptr)) < 0)
    FAIL("find_stream_info: %s", av_err(err).c_str());

  in.stream = av_find_best_stream(in.fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
  if (in.stream < 0) FAIL("no video stream in %s", url);
  AVStream *st = in.fmt->streams[in.stream];

  const AVCodec *dec = avcodec_find_decoder(st->codecpar->codec_id);
  if (!dec) FAIL("no decoder for codec %d", st->codecpar->codec_id);
  in.dec = avcodec_alloc_context3(dec);
  if (!in.dec) FAIL("alloc dec ctx");
  avcodec_parameters_to_context(in.dec, st->codecpar);
  in.dec->hw_device_ctx = av_buffer_ref(hw_device);
  in.dec->get_format = get_hw_format;
  in.dec->pkt_timebase = st->time_base;
  if ((err = avcodec_open2(in.dec, dec, nullptr)) < 0)
    FAIL("open decoder: %s", av_err(err).c_str());
  LOGF("input %s: %s %dx%d", url, dec->name, in.dec->width, in.dec->height);
  return 0;
}

struct Output {
  AVFormatContext *fmt = nullptr;
  AVCodecContext *enc = nullptr;
  AVStream *stream = nullptr;
  bool header_written = false;
};

// Lazily built once the first decoded frame is known (needs its hw_frames_ctx
// + dims). Zero-copy: the encoder consumes the decoder's CUDA frames directly.
int open_output(const char *url, const char *codec_name, AVFrame *frame,
                AVRational in_tb, AVRational framerate, Output &out) {
  const AVCodec *enc = avcodec_find_encoder_by_name(codec_name);
  if (!enc) FAIL("no encoder %s", codec_name);
  out.enc = avcodec_alloc_context3(enc);
  if (!out.enc) FAIL("alloc enc ctx");

  out.enc->width = frame->width;
  out.enc->height = frame->height;
  out.enc->pix_fmt = AV_PIX_FMT_CUDA;
  out.enc->sw_pix_fmt = AV_PIX_FMT_NV12;
  out.enc->time_base = in_tb;
  out.enc->framerate = framerate;
  out.enc->color_range = AVCOL_RANGE_MPEG; // tv
  out.enc->gop_size = 60;                  // 2s @30 — de-spiked keyframes
  out.enc->max_b_frames = 0;
  out.enc->hw_frames_ctx = av_buffer_ref(frame->hw_frames_ctx);
  av_opt_set(out.enc->priv_data, "rc", "vbr", 0);
  av_opt_set_int(out.enc->priv_data, "cq", 18, 0);
  out.enc->bit_rate = 0;
  av_opt_set(out.enc->priv_data, "preset", "p4", 0);
  av_opt_set(out.enc->priv_data, "tune", "ll", 0);

  // Allocate the output context BEFORE opening the encoder: if the muxer wants
  // global headers (rtsp/mp4 do — rtsp needs SPS/PPS in extradata for the SDP
  // ANNOUNCE), the encoder must be opened with AV_CODEC_FLAG_GLOBAL_HEADER,
  // otherwise NVENC emits SPS/PPS inline, leaves extradata empty, and the
  // muxer/server rejects it. Muxer is rtsp:// → rtsp, else inferred from the
  // filename (mp4/mkv/...), so we can validate to a file without a live path.
  const bool is_rtsp = std::strncmp(url, "rtsp://", 7) == 0;
  int err;
  if ((err = avformat_alloc_output_context2(
           &out.fmt, nullptr, is_rtsp ? "rtsp" : nullptr, url)) < 0)
    FAIL("alloc output ctx: %s", av_err(err).c_str());
  if (out.fmt->oformat->flags & AVFMT_GLOBALHEADER)
    out.enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

  if ((err = avcodec_open2(out.enc, enc, nullptr)) < 0)
    FAIL("open encoder %s: %s", codec_name, av_err(err).c_str());

  out.stream = avformat_new_stream(out.fmt, nullptr);
  if (!out.stream) FAIL("new stream");
  avcodec_parameters_from_context(out.stream->codecpar, out.enc);
  out.stream->time_base = out.enc->time_base;
  if (is_rtsp)
    av_opt_set(out.fmt->priv_data, "rtsp_transport", "tcp", 0);

  // File muxers need an AVIO handle opened; rtsp (AVFMT_NOFILE) does not.
  if (!(out.fmt->oformat->flags & AVFMT_NOFILE)) {
    if ((err = avio_open(&out.fmt->pb, url, AVIO_FLAG_WRITE)) < 0)
      FAIL("avio_open(%s): %s", url, av_err(err).c_str());
  }

  AVDictionary *mopt = nullptr;
  if ((err = avformat_write_header(out.fmt, &mopt)) < 0)
    FAIL("write_header(%s): %s", url, av_err(err).c_str());
  av_dict_free(&mopt);
  out.header_written = true;
  LOGF("output %s: %s %dx%d", url, codec_name, out.enc->width, out.enc->height);
  return 0;
}

int drain_encoder(Output &out) {
  for (;;) {
    AVPacket *pkt = av_packet_alloc();
    int err = avcodec_receive_packet(out.enc, pkt);
    if (err == AVERROR(EAGAIN) || err == AVERROR_EOF) {
      av_packet_free(&pkt);
      return err == AVERROR_EOF ? AVERROR_EOF : 0;
    }
    if (err < 0) {
      av_packet_free(&pkt);
      LOGF("receive_packet: %s", av_err(err).c_str());
      return err;
    }
    av_packet_rescale_ts(pkt, out.enc->time_base, out.stream->time_base);
    pkt->stream_index = out.stream->index;
    err = av_interleaved_write_frame(out.fmt, pkt);
    av_packet_free(&pkt);
    if (err < 0) {
      LOGF("write_frame: %s", av_err(err).c_str());
      return err;
    }
  }
}

int run_passthrough(const char *in_url, const char *out_url,
                    const char *codec_name, long long max_frames) {
  av_log_set_level(AV_LOG_WARNING);
  AVBufferRef *hw_device = nullptr;
  int err = av_hwdevice_ctx_create(&hw_device, AV_HWDEVICE_TYPE_CUDA, nullptr,
                                   nullptr, 0);
  if (err < 0) FAIL("create cuda device: %s", av_err(err).c_str());

  Input in;
  if (open_input(in_url, hw_device, in) != 0) return 1;
  AVStream *ist = in.fmt->streams[in.stream];
  AVRational framerate = ist->avg_frame_rate.num ? ist->avg_frame_rate
                                                 : AVRational{30, 1};

  Output out;
  AVFrame *frame = av_frame_alloc();
  AVPacket *pkt = av_packet_alloc();
  long long frames = 0;

  while (!g_stop && (err = av_read_frame(in.fmt, pkt)) >= 0) {
    if (pkt->stream_index != in.stream) {
      av_packet_unref(pkt);
      continue;
    }
    err = avcodec_send_packet(in.dec, pkt);
    av_packet_unref(pkt);
    if (err < 0) {
      LOGF("send_packet: %s", av_err(err).c_str());
      continue;
    }
    while ((err = avcodec_receive_frame(in.dec, frame)) >= 0) {
      if (frame->format != AV_PIX_FMT_CUDA) {
        LOGF("frame not CUDA (fmt=%d) — hwaccel not engaged", frame->format);
        av_frame_unref(frame);
        continue;
      }
      if (!out.header_written) {
        if (open_output(out_url, codec_name, frame, ist->time_base, framerate,
                        out) != 0)
          return 1;
      }
      frame->pict_type = AV_PICTURE_TYPE_NONE;
      err = avcodec_send_frame(out.enc, frame);
      av_frame_unref(frame);
      if (err < 0) {
        LOGF("send_frame: %s", av_err(err).c_str());
        continue;
      }
      if (drain_encoder(out) < 0)
        goto done;
      if (++frames % 300 == 0)
        LOGF("passthrough alive: %lld frames", frames);
      if (max_frames > 0 && frames >= max_frames)
        goto done;
    }
  }
done:
  // flush
  avcodec_send_frame(out.enc, nullptr);
  drain_encoder(out);
  if (out.fmt && out.header_written) {
    av_write_trailer(out.fmt);
    if (!(out.fmt->oformat->flags & AVFMT_NOFILE))
      avio_closep(&out.fmt->pb);
  }
  LOGF("exiting after %lld frames", frames);
  return 0;
}

} // namespace

int main(int argc, char **argv) {
  const char *in_url = nullptr, *out_url = nullptr;
  const char *codec = "h264_nvenc";
  long long max_frames = 0;
  for (int i = 1; i < argc; ++i) {
    if (!std::strcmp(argv[i], "--in") && i + 1 < argc)
      in_url = argv[++i];
    else if (!std::strcmp(argv[i], "--out") && i + 1 < argc)
      out_url = argv[++i];
    else if (!std::strcmp(argv[i], "--codec") && i + 1 < argc)
      codec = argv[++i];
    else if (!std::strcmp(argv[i], "--frames") && i + 1 < argc)
      max_frames = std::atoll(argv[++i]);
  }
  if (!in_url || !out_url)
    return selftest();
  std::signal(SIGINT, [](int) { g_stop = 1; });
  std::signal(SIGTERM, [](int) { g_stop = 1; });
  return run_passthrough(in_url, out_url, codec, max_frames);
}
