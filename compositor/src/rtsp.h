// Minimal multi-client RTSP server for stitchd.
//
// stitchd already produces encoded packets for every output. This serves them
// directly to RTSP clients (VLC, Home Assistant, ffmpeg) so those clients no
// longer have to go through mediamtx — Stage 3 of
// plans/stitchd-absorb-mediamtx.md.
//
// Design notes
// ------------
// * RTP packetization is done by **libavformat's `rtp` muxer**, not by hand.
//   H.264/HEVC fragmentation (FU-A, aggregation, parameter sets in-band) is
//   exactly the kind of code that looks right and subtly corrupts one client in
//   ten, and we already link the library that does it correctly.
// * Each PLAYing client gets its OWN rtp muxer, so packetizer state (sequence
//   numbers, timestamps, fragmentation) can never be shared or raced between
//   clients.
// * TCP interleaved transport only ($-framed on the RTSP socket). Every client
//   we care about supports it, mediamtx was already configured
//   `rtspTransports: [tcp]`, and it traverses NAT without a second socket.
// * A slow client LOSES FRAMES, never latency, and never blocks the encoder.
//   This is the same lesson as the audio pump: back-pressure from one consumer
//   must not propagate into the pipeline. Note this requires a capped
//   SO_SNDBUF to work at all — with an autotuned buffer the kernel silently
//   absorbs megabytes and the client goes stale instead of dropping. See
//   kSendBufBytes in rtsp.cpp and plans/stream-latency-2026-08.md.

#pragma once

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
}

namespace rtsp {

// A servable stream: name plus the codec parameters clients need for SDP.
struct StreamInfo {
  std::string name;
  AVCodecParameters *par = nullptr; // owned
  AVRational time_base{1, 90000};
};

class Server {
public:
  Server() = default;
  ~Server();

  // Register a stream before start(). Copies `par`.
  void add_stream(const std::string &name, const AVCodecParameters *par,
                  AVRational time_base);

  // Begin listening. Returns false if the port can't be bound — the caller
  // should treat that as non-fatal and keep publishing to mediamtx.
  bool start(int port);
  void stop();

  // Feed one encoded packet for `name`. Safe to call from any encoder thread;
  // returns immediately. Packets for streams nobody is watching cost a map
  // lookup and nothing else.
  void broadcast(const std::string &name, const AVPacket *pkt);

  int client_count() const { return clients_.load(); }

  // Snapshot of who is currently playing, for the dashboard.
  struct SessionInfo {
    std::string peer;
    std::string stream;
    std::string transport; // "tcp" | "udp"
    // Packets dropped for this client because it wasn't draining. Non-zero
    // means the viewer is losing frames to keep its latency bounded — the
    // thing to look at when someone says a stream is stuttering.
    uint64_t dropped = 0;
    bool behind = false; // currently waiting for a keyframe to resync
  };
  std::vector<SessionInfo> sessions() const;

  // Public because the AVIO write callback (a free function, as libavformat
  // requires) needs the complete type.
  struct Session;

private:

  void accept_loop();
  void serve_conn(int fd);

  int listen_fd_ = -1;
  int port_ = 0;
  std::thread accept_thread_;
  std::atomic<bool> running_{false};
  std::atomic<int> clients_{0};

  std::map<std::string, StreamInfo> streams_; // built before start(), then read-only

  mutable std::mutex sessions_mu_;
  std::vector<std::shared_ptr<Session>> sessions_;
};

} // namespace rtsp
