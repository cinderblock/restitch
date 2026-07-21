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
  const bool is_null = std::strcmp(url, "null") == 0;
  const char *fmt_name = is_rtsp ? "rtsp" : (is_null ? "null" : nullptr);
  int err;
  if ((err = avformat_alloc_output_context2(&out.fmt, nullptr, fmt_name, url)) <
      0)
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

// A derived output: crop a rect from the composite, scale to (w,h), optional
// rotate180, encode. Crop rect is in COMPOSITE (post-rotate) coordinates.
struct OutSpec {
  const char *name;
  const char *codec;
  int cropX, cropY, cropW, cropH;
  int w, h;
  int rot180;
  const char *maxrate; // null = uncapped
};

int run_composite(const std::vector<std::string> &in_urls, const char *dest,
                  int fps, long long max_frames, bool unpaced,
                  const char *fc_url) {
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

  // Field Centered — an AUX input (not part of the 5-bay composite stack); used
  // only as all-field's bottom half.
  Decoder *fcdec = nullptr;
  AVFrame *fccur = nullptr;
  if (fc_url) {
    fcdec = new Decoder();
    if (fcdec->open(fc_url, dev.ref) < 0) { LOGF("fc open failed"); return 1; }
    fcdec->start();
    fccur = av_frame_alloc();
  }

  std::vector<AVFrame *> cur(N);
  for (int i = 0; i < N; ++i) cur[i] = av_frame_alloc();
  for (;;) {
    bool all = true;
    for (int i = 0; i < N; ++i)
      if (!decs[i]->latest(cur[i])) all = false;
    if (fcdec && !fcdec->latest(fccur)) all = false;
    if (all || g_stop) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (g_stop) return 1;

  const int inW = cur[0]->width, inH = cur[0]->height;
  const int compW = N * inH, compH = inW; // vstack + rotate 90
  LOGF("inputs %dx%d x%d -> composite %dx%d", inW, inH, N, compW, compH);

  // Persistent NV12 composite work buffer (gather writes it; every sub-stream
  // crop/scale reads it). Raw pitched device memory — no AVFrame overhead.
  uint8_t *wbY = nullptr, *wbUV = nullptr;
  size_t pY = 0, pUV = 0;
  cudaMallocPitch((void **)&wbY, &pY, compW, compH);
  cudaMallocPitch((void **)&wbUV, &pUV, compW, compH / 2);

  // Outputs matching the production config (hardcoded until config parsing).
  const int fw = compW, fh = compH; // 7560x2688
  std::vector<OutSpec> specs = {
      {"full", "hevc_nvenc", 0, 0, fw, fh, fw, fh, 0, nullptr},
      {"full-low", "h264_nvenc", 0, 0, fw, fh, 3600, 1280, 0, "8000000"},
      {"the-field", "h264_nvenc", (int)(0.40 * fw), 0, (int)(0.60 * fw),
       fh / 2, 4096, 1216, 0, "12000000"},
      {"john", "h264_nvenc", (int)(0.60 * fw), fh / 2, (int)(0.40 * fw),
       fh / 2, (int)(0.40 * fw), fh / 2, 1, nullptr},
  };
  const bool to_null = std::strcmp(dest, "null") == 0;
  AVRational tb{1, fps}, fr{fps, 1};

  struct Out {
    OutSpec spec;
    AVBufferRef *frames;
    Output io;
  };
  std::vector<Out> outs;
  for (auto &s : specs) {
    AVBufferRef *frames = av_hwframe_ctx_alloc(dev.ref);
    AVHWFramesContext *fc = (AVHWFramesContext *)frames->data;
    fc->format = AV_PIX_FMT_CUDA;
    fc->sw_format = AV_PIX_FMT_NV12;
    fc->width = s.w;
    fc->height = s.h;
    fc->initial_pool_size = 8;
    if ((err = av_hwframe_ctx_init(frames)) < 0) {
      LOGF("hwframe_ctx_init(%s): %s", s.name, av_err(err).c_str());
      return 1;
    }
    Out o{s, frames, {}};
    std::string url = to_null ? "null"
                              : std::string(dest) + "/" + s.name + ".mp4";
    if (open_output(url.c_str(), s.codec, s.w, s.h, frames, tb, fr, s.maxrate,
                    o.io) < 0)
      return 1;
    outs.push_back(o);
  }

  // all-field: the-field (in-GPU, rot180, left-10% trimmed) over Field Centered.
  // THE PAYOFF — it samples the-field's PRE-ENCODE output frame directly, so
  // there is no re-decode, no re-encode (no generation loss), and no second
  // framesync (the stale-frame bug that started this project is impossible).
  const int TF_IDX = 2;                            // the-field in `outs`
  const int afTopW = 3686, afTopH = 1216;          // the-field trimmed+flipped
  const int afBotH = ((1512 * afTopW / 2688) + 1) & ~1; // FC scaled, even
  const int afW = afTopW, afH = afTopH + afBotH;   // 3686 x 3290
  Out afOut{};
  const bool has_af = fcdec != nullptr;
  if (has_af) {
    AVBufferRef *frames = av_hwframe_ctx_alloc(dev.ref);
    AVHWFramesContext *fc = (AVHWFramesContext *)frames->data;
    fc->format = AV_PIX_FMT_CUDA;
    fc->sw_format = AV_PIX_FMT_NV12;
    fc->width = afW;
    fc->height = afH;
    fc->initial_pool_size = 8;
    if ((err = av_hwframe_ctx_init(frames)) < 0) {
      LOGF("hwframe_ctx_init(all-field): %s", av_err(err).c_str());
      return 1;
    }
    afOut.spec = {"all-field", "h264_nvenc", 0, 0, afW, afH,
                  afW,         afH,          0, "12000000"};
    afOut.frames = frames;
    std::string url = to_null ? "null" : std::string(dest) + "/all-field.mp4";
    if (open_output(url.c_str(), "h264_nvenc", afW, afH, frames, tb, fr,
                    "12000000", afOut.io) < 0)
      return 1;
  }

  const auto t0 = std::chrono::steady_clock::now();
  long long frames_out = 0;
  while (!g_stop && (max_frames <= 0 || frames_out < max_frames)) {
    if (!unpaced) {
      auto target = t0 + std::chrono::microseconds(frames_out * 1000000 / fps);
      std::this_thread::sleep_until(target);
    }

    // 1) build the composite once into the work buffer
    CompositeInputs ci{};
    ci.n = N;
    ci.inW = inW;
    ci.inH = inH;
    for (int i = 0; i < N; ++i) {
      decs[i]->latest(cur[i]);
      ci.y[i] = cur[i]->data[0];
      ci.uv[i] = cur[i]->data[1];
      ci.pitchY[i] = cur[i]->linesize[0];
      ci.pitchUV[i] = cur[i]->linesize[1];
    }
    launch_vstack_rotate90cw(&ci, wbY, (int)pY, wbUV, (int)pUV, compW, compH,
                             stream);

    // 2) derive every output from the work buffer
    std::vector<AVFrame *> ofs(outs.size(), nullptr);
    for (size_t k = 0; k < outs.size(); ++k) {
      AVFrame *of = av_frame_alloc();
      if (av_hwframe_get_buffer(outs[k].frames, of, 0) < 0) {
        av_frame_free(&of);
        continue;
      }
      const OutSpec &s = outs[k].spec;
      launch_crop_scale_rot180(wbY, (int)pY, wbUV, (int)pUV, compW, compH,
                               s.cropX, s.cropY, s.cropW, s.cropH, of->data[0],
                               of->linesize[0], of->data[1], of->linesize[1],
                               s.w, s.h, s.rot180, stream);
      of->pts = frames_out;
      ofs[k] = of;
    }

    // 2b) all-field: sample the-field's in-GPU frame (top, rot180+trim) + Field
    // Centered (bottom). Same stream as the base kernels, so the-field's kernel
    // has already run when this reads it (serialized) — no extra sync needed.
    AVFrame *af = nullptr;
    if (has_af && ofs[TF_IDX]) {
      af = av_frame_alloc();
      if (av_hwframe_get_buffer(afOut.frames, af, 0) == 0) {
        AVFrame *tf = ofs[TF_IDX]; // the-field 4096x1216, pre-encode, in GPU
        // top: crop the-field's left `afTopW` and rot180 (== rot180 then trim
        // left 10%); no scale.
        launch_crop_scale_rot180(
            tf->data[0], tf->linesize[0], tf->data[1], tf->linesize[1],
            tf->width, tf->height, 0, 0, afTopW, afTopH, af->data[0],
            af->linesize[0], af->data[1], af->linesize[1], afTopW, afTopH,
            /*rot180=*/1, stream);
        // bottom: Field Centered scaled to (afTopW x afBotH), written at row
        // afTopH of the all-field frame.
        fcdec->latest(fccur);
        uint8_t *botY = af->data[0] + (size_t)afTopH * af->linesize[0];
        uint8_t *botUV = af->data[1] + (size_t)(afTopH / 2) * af->linesize[1];
        launch_crop_scale_rot180(
            fccur->data[0], fccur->linesize[0], fccur->data[1],
            fccur->linesize[1], fccur->width, fccur->height, 0, 0, fccur->width,
            fccur->height, botY, af->linesize[0], botUV, af->linesize[1],
            afTopW, afBotH, /*rot180=*/0, stream);
        af->pts = frames_out;
      } else {
        av_frame_free(&af);
        af = nullptr;
      }
    }

    cudaStreamSynchronize(stream);

    // 3) encode
    for (size_t k = 0; k < outs.size(); ++k) {
      if (!ofs[k]) continue;
      if (avcodec_send_frame(outs[k].io.enc, ofs[k]) < 0)
        LOGF("send_frame(%s)", outs[k].spec.name);
      av_frame_free(&ofs[k]);
      drain(outs[k].io);
    }
    if (af) {
      if (avcodec_send_frame(afOut.io.enc, af) < 0)
        LOGF("send_frame(all-field)");
      av_frame_free(&af);
      drain(afOut.io);
    }
    if (++frames_out % 300 == 0)
      LOGF("composite alive: %lld frames", frames_out);
  }

  for (auto &o : outs) {
    avcodec_send_frame(o.io.enc, nullptr);
    drain(o.io);
    close_output(o.io);
    av_buffer_unref(&o.frames);
  }
  if (has_af) {
    avcodec_send_frame(afOut.io.enc, nullptr);
    drain(afOut.io);
    close_output(afOut.io);
    av_buffer_unref(&afOut.frames);
    fcdec->stop();
    delete fcdec;
    av_frame_free(&fccur);
  }
  for (int i = 0; i < N; ++i) decs[i]->stop();
  auto secs =
      std::chrono::duration<double>(std::chrono::steady_clock::now() - t0)
          .count();
  LOGF("done: %lld composite frames in %.1fs (%.1f fps), %zu outputs",
       frames_out, secs, frames_out / secs, outs.size());
  for (int i = 0; i < N; ++i) { av_frame_free(&cur[i]); delete decs[i]; }
  cudaFree(wbY);
  cudaFree(wbUV);
  cudaStreamDestroy(stream);
  return 0;
}

} // namespace

int main(int argc, char **argv) {
  std::vector<std::string> in_urls;
  const char *out_url = nullptr, *codec = nullptr, *maxrate = nullptr;
  const char *fc_url = nullptr;
  long long max_frames = 0;
  int fps = 30;
  bool composite = false, unpaced = false;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--in" && i + 1 < argc) in_urls.push_back(argv[++i]);
    else if (a == "--out" && i + 1 < argc) out_url = argv[++i];
    else if (a == "--codec" && i + 1 < argc) codec = argv[++i];
    else if (a == "--frames" && i + 1 < argc) max_frames = std::atoll(argv[++i]);
    else if (a == "--fps" && i + 1 < argc) fps = std::atoi(argv[++i]);
    else if (a == "--maxrate" && i + 1 < argc) maxrate = argv[++i];
    else if (a == "--composite-full") composite = true;
    else if (a == "--unpaced") unpaced = true;
    else if (a == "--field-centered" && i + 1 < argc) fc_url = argv[++i];
  }
  std::signal(SIGINT, [](int) { g_stop = 1; });
  std::signal(SIGTERM, [](int) { g_stop = 1; });

  if (composite) {
    if (in_urls.empty() || !out_url) {
      LOGF("need --in ... --out <dir|null>");
      return 2;
    }
    (void)codec;
    (void)maxrate; // per-output specs are hardcoded (phase 3)
    return run_composite(in_urls, out_url, fps, max_frames, unpaced, fc_url);
  }
  return selftest();
}
