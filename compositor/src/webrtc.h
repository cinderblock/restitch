// WebRTC (WHEP) output for stitchd, via libdatachannel.
//
// Replaces mediamtx's WebRTC server — Stage 4 of
// plans/stitchd-absorb-mediamtx.md. This is the piece that carries the public
// field stream (stream.tomsawyerlabs.com → Cloudflare → office → steamboat →
// here), so three contracts from the mediamtx config must survive exactly:
//
//   1. Media rides ONE UDP port, 8189. The office WAN forward points at
//      exactly that port, so every peer must share it — hence libjuice's
//      enableIceUdpMux (verified available before this was written; a stack
//      needing a port per peer could not replace mediamtx here at all).
//   2. An extra host is advertised as an ICE candidate (split-horizon DNS:
//      the name resolves to this box on the LAN and to the WAN edge outside).
//      mediamtx called this webrtcAdditionalHosts.
//   3. STUN, so the server learns its own WAN address and offers a numeric-IP
//      srflx candidate. Safari/iOS ignore non-mDNS FQDN candidates, so without
//      this iPhones never connect even though desktop browsers do.
//
// Protocol: WHEP. The viewer POSTs an SDP offer, we answer. Only H.264 outputs
// are served — browsers do not reliably do HEVC over WebRTC, and the public
// stream (all-field) is already h264_nvenc for the same reason.

#pragma once

#include <atomic>
#include <functional>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
}

namespace webrtc {

struct Options {
  int http_port = 8889;       // WHEP signaling
  int udp_mux_port = 8189;    // media; must match the WAN forward
  std::vector<std::string> ice_servers;      // e.g. stun:stun.l.google.com:19302
  std::vector<std::string> additional_hosts; // advertised as extra candidates
};

class Server {
public:
  Server();
  ~Server();

  // Register a servable stream. Only H.264 is accepted; anything else is
  // ignored with a log line rather than silently producing a dead endpoint.
  void add_stream(const std::string &name, const AVCodecParameters *par);

  // Serves GET /api/status. Set before start(). Lets the dashboard read
  // stream state from stitchd instead of from mediamtx's control API.
  void set_status_provider(std::function<std::string()> fn);

  bool start(const Options &opt);
  void stop();

  // Feed one encoded H.264 packet (Annex B). Cheap when nobody is watching.
  void broadcast(const std::string &name, const AVPacket *pkt,
                 AVRational time_base);

  int viewer_count() const { return viewers_.load(); }

  struct ViewerInfo {
    std::string stream;
    std::string state;
  };
  std::vector<ViewerInfo> viewer_list() const;

private:
  void handle_http(int fd);

  struct Viewer;
  struct Impl;
  std::unique_ptr<Impl> impl_;
  std::atomic<int> viewers_{0};
};

} // namespace webrtc
