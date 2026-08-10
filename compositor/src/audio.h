// Audio capture + N-channel merge for stitchd.
//
// stitchd already demuxes every camera for video; their audio packets arrive on
// the same AVFormatContext and were previously thrown away. This taps them,
// resamples each camera to 16 kHz mono s16, and emits ONE interleaved
// N-channel s16le stream — byte-for-byte what the transcription consumer in
// src/transcribe.ts already parses (N*2 bytes per timestep, channel order =
// declaration order).
//
// Why this replaces the ffmpeg `amerge` pump
// ------------------------------------------
// The old pump was a separate ffmpeg with N RTSP inputs merged by amerge.
// amerge advances in lockstep: it emits a frame only once EVERY input has data,
// so one lagging input back-pressures all of them. That process could not drain
// its RTSP readers promptly, and mediamtx discarded frames for every input at
// once ("reader is too slow") — even while the pump averaged 100% of real time,
// because average throughput is not the same as prompt draining.
//
// This mixer is CLOCK-DRIVEN instead: a writer thread emits exactly 16000
// samples/second against a steady clock, taking whatever each channel has and
// substituting silence for a starved one. It therefore CANNOT fall behind real
// time or apply back-pressure to any input — the failure mode that caused the
// discards is structurally impossible here, rather than tuned away.
//
// See plans/stitchd-absorb-mediamtx.md (Stage 1).

#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswresample/swresample.h>
}

namespace audio {

constexpr int kSampleRate = 16000;
constexpr int kBytesPerSample = 2; // s16
// Emission granularity. 10 ms keeps the merged stream close to live while
// staying coarse enough that the writer thread wakes only 100x/second.
constexpr int kBlockSamples = kSampleRate / 100; // 160

// One camera's audio: decodes to 16 kHz mono s16 and buffers it for the mixer.
// Thread-safety: push() runs on that camera's decode thread, take() on the
// mixer's clock thread.
class Tap {
public:
  explicit Tap(std::string name) : name_(std::move(name)) {}
  ~Tap();

  // Bind to an audio stream already discovered on an open input. Returns false
  // if the stream has no usable decoder — the camera then contributes silence
  // rather than failing the whole pipeline.
  bool open(AVStream *st);

  // Re-bind to the audio stream of a REOPENED input. open() allocates
  // unconditionally, so calling it twice would leak the previous decoder,
  // resampler and frame — an input that reconnects a few times a day would
  // leak steadily. Releases first, then opens.
  bool rebind(AVStream *st);

  bool bound() const { return dec_ != nullptr; }
  int stream_index() const { return stream_index_; }

  // Feed one audio packet (called from the owning decode thread).
  void push_packet(AVPacket *pkt);

  // Pull up to `want` samples into `dst`. Returns how many were available;
  // the caller zero-fills the remainder. Never blocks.
  int take(int16_t *dst, int want);

  const std::string &name() const { return name_; }
  long long underruns() const { return underruns_.load(); }
  void note_underrun(int n) { underruns_ += n; }

private:
  void drain_frames();

  std::string name_;
  AVCodecContext *dec_ = nullptr;
  SwrContext *swr_ = nullptr;
  int stream_index_ = -1;
  AVFrame *frame_ = nullptr;

  std::mutex mu_;
  std::vector<int16_t> buf_; // FIFO of resampled mono samples
  std::atomic<long long> underruns_{0};
};

// Merges N taps into one interleaved s16le stream on a steady clock.
class Mixer {
public:
  // `fd` receives the interleaved stream. Channel order is the order taps were
  // added, which must match the camera order the consumer expects.
  Mixer(int fd, std::vector<Tap *> taps);
  ~Mixer();

  void start();
  void stop();

  long long blocks_written() const { return blocks_.load(); }

private:
  void loop();

  int fd_;
  std::vector<Tap *> taps_;
  std::thread thread_;
  std::atomic<bool> running_{false};
  std::atomic<long long> blocks_{0};
  bool write_failed_ = false; // mixer thread only
  std::atomic<long long> dropped_blocks_{0};
};

} // namespace audio
