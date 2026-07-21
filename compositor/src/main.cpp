// stitchd — custom GPU compositor for restitch.
//
// Phase 2: the compositing core. N RTSP cameras decode in parallel on their
// own threads (each publishing its LATEST CUDA frame into a slot); a tick
// scheduler samples the newest frame from every input and runs ONE CUDA gather
// kernel (vstack + rotate 90 CW) into an NV12 output frame, which NVENC encodes
// — all GPU-resident, no PCIe download, deterministic pairing (no ffmpeg
// framesync). Reproduces `full`. Modes:
//   (no args)                     -> phase-1a capability check
//   --in A --out F [--codec ...]  -> phase-1 zero-copy passthrough
//   --composite-full --in A --in B ... --out F  -> phase-2 composite
//
// See plans/custom-compositor.md.

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_cuda.h>
#include <libavutil/opt.h>
#include <libavutil/version.h>
}

#include <cuda_runtime.h>

#include "cuda_composite.h"

static volatile std::sig_atomic_t g_stop = 0;

namespace {

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

enum AVPixelFormat get_hw_format(AVCodecContext *, const enum AVPixelFormat *fmts) {
  for (const enum AVPixelFormat *p = fmts; *p != AV_PIX_FMT_NONE; ++p)
    if (*p == AV_PIX_FMT_CUDA)
      return *p;
  return AV_PIX_FMT_NONE;
}

// ---- shared CUDA device (primary context, shared by decode/encode/kernels) --
struct Device {
  AVBufferRef *ref = nullptr;
  int create() {
    // Primary context so libav frames and our cuda-runtime kernels share ONE
    // context — no manual push/pop, safe across threads.
    int err = av_hwdevice_ctx_create(&ref, AV_HWDEVICE_TYPE_CUDA, "0", nullptr,
                                     AV_CUDA_USE_PRIMARY_CONTEXT);
    return err;
  }
};

// ---- one threaded decoder; publishes its latest CUDA frame ----------------
class Decoder {
public:
  int open(const char *url, AVBufferRef *device) {
    url_ = url;
    AVDictionary *opt = nullptr;
    av_dict_set(&opt, "rtsp_transport", "tcp", 0);
    av_dict_set(&opt, "fflags", "nobuffer", 0);
    int err = avformat_open_input(&fmt_, url, nullptr, &opt);
    av_dict_free(&opt);
    if (err < 0) { LOGF("open %s: %s", url, av_err(err).c_str()); return err; }
    if ((err = avformat_find_stream_info(fmt_, nullptr)) < 0) return err;
    stream_ = av_find_best_stream(fmt_, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    if (stream_ < 0) return stream_;
    AVStream *st = fmt_->streams[stream_];
    const AVCodec *dec = avcodec_find_decoder(st->codecpar->codec_id);
    dec_ = avcodec_alloc_context3(dec);
    avcodec_parameters_to_context(dec_, st->codecpar);
    dec_->hw_device_ctx = av_buffer_ref(device);
    dec_->get_format = get_hw_format;
    dec_->pkt_timebase = st->time_base;
    if ((err = avcodec_open2(dec_, dec, nullptr)) < 0) return err;
    return 0;
  }

  void start() { thread_ = std::thread([this] { loop(); }); }

  // Ref the latest frame into `dst` (caller owns the ref). Returns false if no
  // frame has arrived yet.
  bool latest(AVFrame *dst) {
    std::lock_guard<std::mutex> lk(mu_);
    if (!latest_)
      return false;
    av_frame_unref(dst);
    return av_frame_ref(dst, latest_) == 0;
  }

  void stop() {
    running_ = false;
    if (thread_.joinable())
      thread_.join();
  }
  ~Decoder() {
    stop();
    if (latest_) av_frame_free(&latest_);
    if (dec_) avcodec_free_context(&dec_);
    if (fmt_) avformat_close_input(&fmt_);
  }

private:
  void loop() {
    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc();
    while (running_ && !g_stop) {
      int err = av_read_frame(fmt_, pkt);
      if (err < 0)
        break;
      if (pkt->stream_index != stream_) { av_packet_unref(pkt); continue; }
      err = avcodec_send_packet(dec_, pkt);
      av_packet_unref(pkt);
      if (err < 0) continue;
      while ((err = avcodec_receive_frame(dec_, frame)) >= 0) {
        if (frame->format == AV_PIX_FMT_CUDA)
          publish(frame);
        av_frame_unref(frame);
      }
    }
    av_frame_free(&frame);
    av_packet_free(&pkt);
  }
  void publish(AVFrame *f) {
    AVFrame *copy = av_frame_alloc();
    if (av_frame_ref(copy, f) < 0) { av_frame_free(&copy); return; }
    std::lock_guard<std::mutex> lk(mu_);
    if (latest_) av_frame_free(&latest_);
    latest_ = copy;
    ++count_;
  }

public:
  std::string url_;
  std::atomic<long long> count_{0};

private:
  AVFormatContext *fmt_ = nullptr;
  AVCodecContext *dec_ = nullptr;
  int stream_ = -1;
  std::thread thread_;
  std::atomic<bool> running_{true};
  std::mutex mu_;
  AVFrame *latest_ = nullptr;
};

// ---- one output encoder + muxer -------------------------------------------
struct Output {
  AVFormatContext *fmt = nullptr;
  AVCodecContext *enc = nullptr;
  AVStream *stream = nullptr;
  bool header = false;
};

int open_output(const char *url, const char *codec_name, int w, int h,
                AVBufferRef *frames_ctx, AVRational tb, AVRational fr,
                const char *maxrate, Output &out) {
  const AVCodec *enc = avcodec_find_encoder_by_name(codec_name);
  if (!enc) { LOGF("no encoder %s", codec_name); return -1; }
  out.enc = avcodec_alloc_context3(enc);
  out.enc->width = w;
  out.enc->height = h;
  out.enc->pix_fmt = AV_PIX_FMT_CUDA;
  out.enc->sw_pix_fmt = AV_PIX_FMT_NV12;
  out.enc->time_base = tb;
  out.enc->framerate = fr;
  out.enc->color_range = AVCOL_RANGE_MPEG;
  out.enc->gop_size = 60;
  out.enc->max_b_frames = 0;
  out.enc->hw_frames_ctx = av_buffer_ref(frames_ctx);
  av_opt_set(out.enc->priv_data, "rc", "vbr", 0);
  av_opt_set_int(out.enc->priv_data, "cq", 18, 0);
  av_opt_set(out.enc->priv_data, "preset", "p4", 0);
  av_opt_set(out.enc->priv_data, "tune", "hq", 0);
  out.enc->bit_rate = 0;
  if (maxrate) {
    out.enc->rc_max_rate = std::atoll(maxrate);
    out.enc->rc_buffer_size = out.enc->rc_max_rate;
  }

  const bool is_rtsp = std::strncmp(url, "rtsp://", 7) == 0;
  int err;
  if ((err = avformat_alloc_output_context2(
           &out.fmt, nullptr, is_rtsp ? "rtsp" : nullptr, url)) < 0)
    return err;
  if (out.fmt->oformat->flags & AVFMT_GLOBALHEADER)
    out.enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  if ((err = avcodec_open2(out.enc, enc, nullptr)) < 0) {
    LOGF("open encoder %s: %s", codec_name, av_err(err).c_str());
    return err;
  }
  out.stream = avformat_new_stream(out.fmt, nullptr);
  avcodec_parameters_from_context(out.stream->codecpar, out.enc);
  out.stream->time_base = out.enc->time_base;
  if (is_rtsp)
    av_opt_set(out.fmt->priv_data, "rtsp_transport", "tcp", 0);
  if (!(out.fmt->oformat->flags & AVFMT_NOFILE)) {
    if ((err = avio_open(&out.fmt->pb, url, AVIO_FLAG_WRITE)) < 0)
      return err;
  }
  if ((err = avformat_write_header(out.fmt, nullptr)) < 0) {
    LOGF("write_header(%s): %s", url, av_err(err).c_str());
    return err;
  }
  out.header = true;
  LOGF("output %s: %s %dx%d", url, codec_name, w, h);
  return 0;
}

int drain(Output &out) {
  for (;;) {
    AVPacket *pkt = av_packet_alloc();
    int err = avcodec_receive_packet(out.enc, pkt);
    if (err == AVERROR(EAGAIN) || err == AVERROR_EOF) {
      av_packet_free(&pkt);
      return 0;
    }
    if (err < 0) { av_packet_free(&pkt); return err; }
    av_packet_rescale_ts(pkt, out.enc->time_base, out.stream->time_base);
    pkt->stream_index = out.stream->index;
    err = av_interleaved_write_frame(out.fmt, pkt);
    av_packet_free(&pkt);
    if (err < 0) return err;
  }
}

void close_output(Output &out) {
  if (out.fmt && out.header) {
    av_write_trailer(out.fmt);
    if (!(out.fmt->oformat->flags & AVFMT_NOFILE))
      avio_closep(&out.fmt->pb);
  }
  if (out.enc) avcodec_free_context(&out.enc);
  if (out.fmt) avformat_free_context(out.fmt);
}

// =========================================================================
int selftest() {
  std::printf("stitchd phase-1a link/capability check\n");
  int n = 0;
  bool ok = cudaGetDeviceCount(&n) == cudaSuccess && n > 0;
  ok &= avcodec_find_decoder_by_name("h264") != nullptr;
  ok &= avcodec_find_encoder_by_name("h264_nvenc") != nullptr;
  ok &= avcodec_find_encoder_by_name("hevc_nvenc") != nullptr;
  AVBufferRef *dev = nullptr;
  ok &= av_hwdevice_ctx_create(&dev, AV_HWDEVICE_TYPE_CUDA, nullptr, nullptr,
                               0) >= 0;
  av_buffer_unref(&dev);
  std::printf("CUDA devices=%d  %s\n", n, ok ? "PHASE-1A OK" : "FAILED");
  return ok ? 0 : 1;
}

int run_composite_full(const std::vector<std::string> &in_urls,
                       const char *out_url, const char *codec, int fps,
                       long long max_frames, const char *maxrate) {
  av_log_set_level(AV_LOG_ERROR);
  Device dev;
  int err = dev.create();
  if (err < 0) { LOGF("cuda device: %s", av_err(err).c_str()); return 1; }
  cudaSetDevice(0);
  cudaStream_t stream;
  cudaStreamCreate(&stream);

  const int N = (int)in_urls.size();
  std::vector<Decoder *> decs(N);
  for (int i = 0; i < N; ++i) {
    decs[i] = new Decoder();
    if (decs[i]->open(in_urls[i].c_str(), dev.ref) < 0) {
      LOGF("decoder %d open failed (%s)", i, in_urls[i].c_str());
      return 1;
    }
    decs[i]->start();
  }
  LOGF("%d decoders started; waiting for first frames (cold start)...", N);

  // Cold start: wait until every input has delivered a frame.
  std::vector<AVFrame *> cur(N);
  for (int i = 0; i < N; ++i) cur[i] = av_frame_alloc();
  for (;;) {
    bool all = true;
    for (int i = 0; i < N; ++i)
      if (!decs[i]->latest(cur[i])) all = false;
    if (all || g_stop) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (g_stop) return 1;

  const int inW = cur[0]->width, inH = cur[0]->height;
  const int outW = N * inH, outH = inW; // vstack + rotate 90
  LOGF("inputs %dx%d x%d -> composite %dx%d", inW, inH, N, outW, outH);

  // Output NV12 CUDA frame pool (shared by compositor allocs + the encoder).
  AVBufferRef *frames = av_hwframe_ctx_alloc(dev.ref);
  AVHWFramesContext *fc = (AVHWFramesContext *)frames->data;
  fc->format = AV_PIX_FMT_CUDA;
  fc->sw_format = AV_PIX_FMT_NV12;
  fc->width = outW;
  fc->height = outH;
  fc->initial_pool_size = 12;
  if ((err = av_hwframe_ctx_init(frames)) < 0) {
    LOGF("hwframe_ctx_init: %s", av_err(err).c_str());
    return 1;
  }

  Output out;
  AVRational tb{1, fps}, fr{fps, 1};
  if (open_output(out_url, codec, outW, outH, frames, tb, fr, maxrate, out) < 0)
    return 1;

  const auto t0 = std::chrono::steady_clock::now();
  long long frames_out = 0;
  while (!g_stop && (max_frames <= 0 || frames_out < max_frames)) {
    // real-time tick: sample newest frames every 1/fps
    auto target = t0 + std::chrono::microseconds(frames_out * 1000000 / fps);
    std::this_thread::sleep_until(target);

    CompositeInputs ci{};
    ci.n = N;
    ci.inW = inW;
    ci.inH = inH;
    for (int i = 0; i < N; ++i) {
      decs[i]->latest(cur[i]); // refresh to newest (keeps last if none new)
      ci.y[i] = cur[i]->data[0];
      ci.uv[i] = cur[i]->data[1];
      ci.pitchY[i] = cur[i]->linesize[0];
      ci.pitchUV[i] = cur[i]->linesize[1];
    }

    AVFrame *of = av_frame_alloc();
    if ((err = av_hwframe_get_buffer(frames, of, 0)) < 0) {
      LOGF("get_buffer: %s", av_err(err).c_str());
      av_frame_free(&of);
      break;
    }
    launch_vstack_rotate90cw(&ci, of->data[0], of->linesize[0], of->data[1],
                             of->linesize[1], outW, outH, stream);
    cudaStreamSynchronize(stream);

    of->pts = frames_out;
    if ((err = avcodec_send_frame(out.enc, of)) < 0)
      LOGF("send_frame: %s", av_err(err).c_str());
    av_frame_free(&of);
    if (drain(out) < 0) break;
    if (++frames_out % 300 == 0)
      LOGF("composite alive: %lld frames", frames_out);
  }

  avcodec_send_frame(out.enc, nullptr);
  drain(out);
  close_output(out);
  for (int i = 0; i < N; ++i) { decs[i]->stop(); }
  auto secs = std::chrono::duration<double>(
                  std::chrono::steady_clock::now() - t0)
                  .count();
  LOGF("done: %lld composite frames in %.1fs (%.1f fps); decoder counts:",
       frames_out, secs, frames_out / secs);
  for (int i = 0; i < N; ++i)
    LOGF("  input %d: %lld decoded", i, (long long)decs[i]->count_);
  for (int i = 0; i < N; ++i) { av_frame_free(&cur[i]); delete decs[i]; }
  cudaStreamDestroy(stream);
  return 0;
}

} // namespace

int main(int argc, char **argv) {
  std::vector<std::string> in_urls;
  const char *out_url = nullptr, *codec = nullptr, *maxrate = nullptr;
  long long max_frames = 0;
  int fps = 30;
  bool composite = false;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--in" && i + 1 < argc) in_urls.push_back(argv[++i]);
    else if (a == "--out" && i + 1 < argc) out_url = argv[++i];
    else if (a == "--codec" && i + 1 < argc) codec = argv[++i];
    else if (a == "--frames" && i + 1 < argc) max_frames = std::atoll(argv[++i]);
    else if (a == "--fps" && i + 1 < argc) fps = std::atoi(argv[++i]);
    else if (a == "--maxrate" && i + 1 < argc) maxrate = argv[++i];
    else if (a == "--composite-full") composite = true;
  }
  std::signal(SIGINT, [](int) { g_stop = 1; });
  std::signal(SIGTERM, [](int) { g_stop = 1; });

  if (composite) {
    if (in_urls.empty() || !out_url) { LOGF("need --in ... --out"); return 2; }
    return run_composite_full(in_urls, out_url, codec ? codec : "hevc_nvenc",
                              fps, max_frames, maxrate);
  }
  return selftest();
}
