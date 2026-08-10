#include "audio.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <unistd.h>

extern "C" {
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
}

namespace audio {
namespace {

#define ALOGF(...)                                                             \
  do {                                                                         \
    std::fprintf(stderr, "[stitchd/audio] " __VA_ARGS__);                       \
    std::fprintf(stderr, "\n");                                                \
  } while (0)

// Cap on how much un-consumed audio a tap will hold. The mixer drains on a
// clock, so a backlog means that camera briefly ran ahead; keeping ~2 s bounds
// memory and, more importantly, bounds how stale a sample can be. Older audio
// is dropped rather than delaying everything behind it — for transcription,
// fresh-but-gappy beats complete-but-late.
constexpr size_t kMaxBufferedSamples = kSampleRate * 2;

} // namespace

// ---------------------------------------------------------------- Tap -----

bool Tap::rebind(AVStream *st) {
  // Same frees as the destructor. Buffered samples are deliberately kept: the
  // mixer is still pulling from this tap, and dropping them would punch an
  // extra hole in the audio on every reconnect.
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (swr_) swr_free(&swr_);
    if (dec_) avcodec_free_context(&dec_);
    if (frame_) av_frame_free(&frame_);
    stream_index_ = -1;
  }
  return open(st);
}

Tap::~Tap() {
  if (swr_) swr_free(&swr_);
  if (dec_) avcodec_free_context(&dec_);
  if (frame_) av_frame_free(&frame_);
}

bool Tap::open(AVStream *st) {
  const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
  if (!codec) {
    ALOGF("%s: no decoder for audio codec %d — channel will be silent",
          name_.c_str(), (int)st->codecpar->codec_id);
    return false;
  }
  dec_ = avcodec_alloc_context3(codec);
  if (!dec_) return false;
  if (avcodec_parameters_to_context(dec_, st->codecpar) < 0) {
    avcodec_free_context(&dec_);
    return false;
  }
  dec_->pkt_timebase = st->time_base;
  if (avcodec_open2(dec_, codec, nullptr) < 0) {
    avcodec_free_context(&dec_);
    return false;
  }

  // Resample whatever the camera sends (AAC 16k mono, Opus 48k stereo, ...)
  // to the one format the consumer understands.
  AVChannelLayout out_ch;
  av_channel_layout_default(&out_ch, 1);
  int err = swr_alloc_set_opts2(&swr_, &out_ch, AV_SAMPLE_FMT_S16, kSampleRate,
                                &dec_->ch_layout, dec_->sample_fmt,
                                dec_->sample_rate, 0, nullptr);
  if (err < 0 || swr_init(swr_) < 0) {
    ALOGF("%s: swresample init failed — channel will be silent", name_.c_str());
    if (swr_) swr_free(&swr_);
    avcodec_free_context(&dec_);
    return false;
  }

  frame_ = av_frame_alloc();
  stream_index_ = st->index;
  buf_.reserve(kSampleRate); // 1 s, avoids early reallocation churn
  ALOGF("%s: audio %s %d Hz %d ch -> 16k mono", name_.c_str(), codec->name,
        dec_->sample_rate, dec_->ch_layout.nb_channels);
  return true;
}

void Tap::push_packet(AVPacket *pkt) {
  if (!dec_) return;
  if (avcodec_send_packet(dec_, pkt) < 0) return;
  drain_frames();
}

void Tap::drain_frames() {
  while (avcodec_receive_frame(dec_, frame_) >= 0) {
    // Upper bound on output samples for this input frame.
    int max_out = (int)av_rescale_rnd(
        swr_get_delay(swr_, dec_->sample_rate) + frame_->nb_samples,
        kSampleRate, dec_->sample_rate, AV_ROUND_UP);
    if (max_out > 0) {
      std::vector<int16_t> tmp(max_out);
      uint8_t *out[1] = {reinterpret_cast<uint8_t *>(tmp.data())};
      int got = swr_convert(swr_, out, max_out,
                            const_cast<const uint8_t **>(frame_->data),
                            frame_->nb_samples);
      if (got > 0) {
        std::lock_guard<std::mutex> lk(mu_);
        buf_.insert(buf_.end(), tmp.begin(), tmp.begin() + got);
        if (buf_.size() > kMaxBufferedSamples) {
          // Drop the oldest — see kMaxBufferedSamples.
          size_t excess = buf_.size() - kMaxBufferedSamples;
          buf_.erase(buf_.begin(), buf_.begin() + excess);
        }
      }
    }
    av_frame_unref(frame_);
  }
}

int Tap::take(int16_t *dst, int want) {
  std::lock_guard<std::mutex> lk(mu_);
  int n = (int)std::min<size_t>(buf_.size(), (size_t)want);
  if (n > 0) {
    std::memcpy(dst, buf_.data(), (size_t)n * sizeof(int16_t));
    buf_.erase(buf_.begin(), buf_.begin() + n);
  }
  return n;
}

// -------------------------------------------------------------- Mixer -----

Mixer::Mixer(int fd, std::vector<Tap *> taps) : fd_(fd), taps_(std::move(taps)) {}

Mixer::~Mixer() { stop(); }

void Mixer::start() {
  if (running_.exchange(true)) return;
  thread_ = std::thread([this] { loop(); });
}

void Mixer::stop() {
  if (!running_.exchange(false)) return;
  if (thread_.joinable()) thread_.join();
}

void Mixer::loop() {
  const int nch = (int)taps_.size();
  if (nch <= 0) return;

  std::vector<int16_t> mono(kBlockSamples);
  std::vector<int16_t> block((size_t)kBlockSamples * nch);

  using clock = std::chrono::steady_clock;
  auto next = clock::now();
  const auto period = std::chrono::microseconds(kBlockSamples * 1000000 / kSampleRate);

  long long last_report = 0;

  while (running_) {
    // Emit on the clock regardless of what arrived. This is the whole point:
    // a starved channel yields silence instead of stalling every other channel
    // (and, upstream, instead of back-pressuring the network reader).
    std::fill(block.begin(), block.end(), 0);
    for (int c = 0; c < nch; ++c) {
      std::fill(mono.begin(), mono.end(), 0);
      int got = taps_[c]->take(mono.data(), kBlockSamples);
      if (got < kBlockSamples) taps_[c]->note_underrun(kBlockSamples - got);
      for (int i = 0; i < kBlockSamples; ++i)
        block[(size_t)i * nch + c] = mono[i];
    }

    const char *p = reinterpret_cast<const char *>(block.data());
    size_t remaining = block.size() * sizeof(int16_t);
    while (remaining > 0 && running_) {
      ssize_t w = ::write(fd_, p, remaining);
      if (w > 0) { p += w; remaining -= (size_t)w; continue; }
      if (w < 0 && errno == EINTR) continue;
      // The consumer is gone or wedged. Drop this block rather than blocking
      // the clock — staying on schedule matters more than any single block.
      // Report it: silently dropping every block looks identical to "audio
      // works but is quiet", which wastes a debugging session.
      if (!write_failed_) {
        write_failed_ = true;
        ALOGF("write to fd %d failed (%s) — PCM output is being DROPPED", fd_,
              w < 0 ? std::strerror(errno) : "zero-length write");
      }
      ++dropped_blocks_;
      break;
    }

    long long n = ++blocks_;
    // ~every 5 minutes of audio, mirroring the old pump's cadence so the two
    // are comparable in the same log.
    if (n - last_report >= 100LL * 300) {
      last_report = n;
      std::string s;
      for (auto *t : taps_) {
        s += " " + t->name() + "=" +
             std::to_string(t->underruns() * 1000 / kSampleRate) + "ms";
      }
      ALOGF("mixer: %lld blocks (%.1f min) underruns:%s", n,
            (double)n * kBlockSamples / kSampleRate / 60.0, s.c_str());
    }

    next += period;
    auto now = clock::now();
    if (next > now) {
      std::this_thread::sleep_for(next - now);
    } else if (now - next > std::chrono::seconds(1)) {
      // Fell far behind (host stall). Resync rather than sprinting to catch
      // up, which would emit a burst of stale audio.
      next = now;
    }
  }
}

} // namespace audio
