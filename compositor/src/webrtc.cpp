#include "webrtc.h"

#include <algorithm>
#include <arpa/inet.h>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sstream>
#include <sys/socket.h>
#include <unistd.h>

#include <rtc/rtc.hpp>

namespace webrtc {
namespace {

#define WLOGF(...)                                                             \
  do {                                                                         \
    std::fprintf(stderr, "[stitchd/webrtc] " __VA_ARGS__);                      \
    std::fprintf(stderr, "\n");                                                \
  } while (0)

bool write_all(int fd, const char *p, size_t n) {
  while (n > 0) {
    ssize_t w = ::send(fd, p, n, MSG_NOSIGNAL);
    if (w > 0) { p += w; n -= (size_t)w; continue; }
    if (w < 0 && errno == EINTR) continue;
    return false;
  }
  return true;
}

// Case-insensitive "does this HTTP request line/header start with" helper.
bool istarts(const std::string &s, const char *pfx) {
  size_t n = std::strlen(pfx);
  if (s.size() < n) return false;
  for (size_t i = 0; i < n; ++i)
    if (std::tolower(s[i]) != std::tolower(pfx[i])) return false;
  return true;
}

} // namespace

// One connected viewer: a peer connection plus the track we push RTP into.
struct Server::Viewer {
  std::string stream;
  std::shared_ptr<rtc::PeerConnection> pc;
  std::shared_ptr<rtc::Track> track;
  std::shared_ptr<rtc::RtpPacketizationConfig> rtp_cfg;
  std::atomic<bool> open{false};
  std::atomic<bool> dead{false};
};

struct Server::Impl {
  Options opt;
  std::function<std::string()> status_fn;
  rtc::Configuration rtc_cfg;

  std::map<std::string, AVCodecParameters *> streams;

  int listen_fd = -1;
  std::thread accept_thread;
  std::atomic<bool> running{false};

  std::mutex viewers_mu;
  std::vector<std::shared_ptr<Viewer>> viewers;

  ~Impl() {
    for (auto &kv : streams)
      if (kv.second) avcodec_parameters_free(&kv.second);
  }
};

Server::Server() : impl_(std::make_unique<Impl>()) {}

void Server::set_status_provider(std::function<std::string()> fn) {
  impl_->status_fn = std::move(fn);
}
Server::~Server() { stop(); }

void Server::add_stream(const std::string &name, const AVCodecParameters *par) {
  if (par->codec_id != AV_CODEC_ID_H264) {
    // Not an error: `full` is HEVC on purpose. Browsers do not reliably decode
    // HEVC over WebRTC, so quietly skipping beats advertising a dead endpoint.
    WLOGF("stream '%s' is not H.264 — not offered over WebRTC", name.c_str());
    return;
  }
  AVCodecParameters *copy = avcodec_parameters_alloc();
  avcodec_parameters_copy(copy, par);
  impl_->streams[name] = copy;
}

bool Server::start(const Options &opt) {
  impl_->opt = opt;

  // ---- ICE configuration: the three contracts from the mediamtx config ----
  for (const auto &s : opt.ice_servers) impl_->rtc_cfg.iceServers.emplace_back(s);
  // Pin media to ONE port and multiplex every peer onto it.
  impl_->rtc_cfg.portRangeBegin = (uint16_t)opt.udp_mux_port;
  impl_->rtc_cfg.portRangeEnd = (uint16_t)opt.udp_mux_port;
  impl_->rtc_cfg.enableIceUdpMux = true;

  impl_->listen_fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (impl_->listen_fd < 0) { WLOGF("socket: %s", std::strerror(errno)); return false; }
  int on = 1;
  ::setsockopt(impl_->listen_fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_ANY);
  a.sin_port = htons((uint16_t)opt.http_port);
  if (::bind(impl_->listen_fd, (sockaddr *)&a, sizeof(a)) < 0 ||
      ::listen(impl_->listen_fd, 16) < 0) {
    WLOGF("bind/listen :%d: %s", opt.http_port, std::strerror(errno));
    ::close(impl_->listen_fd);
    impl_->listen_fd = -1;
    return false;
  }

  impl_->running = true;
  impl_->accept_thread = std::thread([this] {
    while (impl_->running) {
      sockaddr_in ca{};
      socklen_t cl = sizeof(ca);
      int fd = ::accept(impl_->listen_fd, (sockaddr *)&ca, &cl);
      if (fd < 0) { if (!impl_->running) break; continue; }
      int one = 1;
      ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
      // A detached thread that throws calls std::terminate and takes the whole
      // compositor down — every video output with it. Signaling must never be
      // able to do that, so nothing escapes here.
      std::thread([this, fd] {
        try {
          handle_http(fd);
        } catch (const std::exception &e) {
          WLOGF("signaling error: %s", e.what());
          ::close(fd);
        } catch (...) {
          WLOGF("signaling error: unknown exception");
          ::close(fd);
        }
      }).detach();
    }
  });

  WLOGF("WHEP on :%d, media udp-mux :%d, %zu ice server(s), %zu extra host(s), %zu h264 stream(s)",
        opt.http_port, opt.udp_mux_port, opt.ice_servers.size(),
        opt.additional_hosts.size(), impl_->streams.size());
  return true;
}

void Server::stop() {
  if (!impl_ || !impl_->running.exchange(false)) return;
  if (impl_->listen_fd >= 0) {
    ::shutdown(impl_->listen_fd, SHUT_RDWR);
    ::close(impl_->listen_fd);
    impl_->listen_fd = -1;
  }
  if (impl_->accept_thread.joinable()) impl_->accept_thread.join();
  std::lock_guard<std::mutex> lk(impl_->viewers_mu);
  for (auto &v : impl_->viewers) { v->dead = true; if (v->pc) v->pc->close(); }
  impl_->viewers.clear();
}

// Rewrite the answer SDP to advertise extra hosts. mediamtx's
// webrtcAdditionalHosts existed because WebRTC media bypasses any HTTP reverse
// proxy: an off-LAN viewer needs a candidate address it can actually reach.
static std::string add_host_candidates(const std::string &sdp,
                                       const std::vector<std::string> &hosts,
                                       int port) {
  if (hosts.empty()) return sdp;
  std::istringstream in(sdp);
  std::ostringstream out;
  std::string line;
  bool injected = false;
  uint32_t foundation = 9000;
  while (std::getline(in, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    out << line << "\r\n";
    // Append ours right after the first host candidate so ordering stays sane.
    if (!injected && line.rfind("a=candidate:", 0) == 0) {
      for (const auto &h : hosts) {
        out << "a=candidate:" << foundation++ << " 1 udp 2113929471 " << h
            << " " << port << " typ host\r\n";
      }
      injected = true;
    }
  }
  return out.str();
}

void Server::handle_http(int fd) {
  std::string buf;
  char tmp[4096];
  // Read headers.
  size_t hdr_end = std::string::npos;
  while ((hdr_end = buf.find("\r\n\r\n")) == std::string::npos) {
    ssize_t n = ::recv(fd, tmp, sizeof(tmp), 0);
    if (n <= 0) { ::close(fd); return; }
    buf.append(tmp, (size_t)n);
    if (buf.size() > 1u << 20) { ::close(fd); return; }
  }

  std::string head = buf.substr(0, hdr_end);
  std::string body = buf.substr(hdr_end + 4);

  std::istringstream hs(head);
  std::string line, method, uri, ver;
  std::getline(hs, line);
  { std::istringstream ls(line); ls >> method >> uri >> ver; }
  size_t content_length = 0;
  while (std::getline(hs, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (istarts(line, "content-length:"))
      content_length = (size_t)std::atol(line.c_str() + 15);
  }
  while (body.size() < content_length) {
    ssize_t n = ::recv(fd, tmp, sizeof(tmp), 0);
    if (n <= 0) break;
    body.append(tmp, (size_t)n);
  }

  auto respond = [&](const char *status, const std::string &extra,
                     const std::string &content, const char *ctype) {
    std::ostringstream o;
    o << "HTTP/1.1 " << status << "\r\n"
      << "Access-Control-Allow-Origin: *\r\n"
      << "Access-Control-Allow-Headers: *\r\n"
      << "Access-Control-Allow-Methods: POST, OPTIONS, DELETE\r\n";
    if (!content.empty())
      o << "Content-Type: " << ctype << "\r\nContent-Length: " << content.size()
        << "\r\n";
    else
      o << "Content-Length: 0\r\n";
    o << extra << "\r\n" << content;
    std::string s = o.str();
    write_all(fd, s.data(), s.size());
  };

  if (method == "OPTIONS") { respond("204 No Content", "", "", ""); ::close(fd); return; }

  // Status for the dashboard. Served here because this is the only HTTP
  // server stitchd already runs; standing up a second one for a few counters
  // would be silly.
  if (uri.rfind("/api/status", 0) == 0) {
    std::string body = impl_->status_fn ? impl_->status_fn() : std::string("{}");
    respond("200 OK", "", body, "application/json");
    ::close(fd);
    return;
  }

  // /whep/<stream>
  std::string name;
  {
    std::string u = uri;
    size_t q = u.find('?');
    if (q != std::string::npos) u = u.substr(0, q);
    const std::string pfx = "/whep/";
    if (u.rfind(pfx, 0) == 0) name = u.substr(pfx.size());
    while (!name.empty() && name.back() == '/') name.pop_back();
  }

  auto it = impl_->streams.find(name);
  if (method != "POST" || name.empty() || it == impl_->streams.end()) {
    respond("404 Not Found", "", "no such stream\n", "text/plain");
    ::close(fd);
    return;
  }

  // ---- Build the peer connection and answer the offer ----
  auto v = std::make_shared<Viewer>();
  v->stream = name;
  try {
    v->pc = std::make_shared<rtc::PeerConnection>(impl_->rtc_cfg);
  } catch (const std::exception &e) {
    WLOGF("PeerConnection failed (udp-mux :%d): %s", impl_->opt.udp_mux_port,
          e.what());
    respond("500 Internal Server Error", "", "peer setup failed\n", "text/plain");
    ::close(fd);
    return;
  }

  const uint32_t ssrc = 42000u + (uint32_t)(impl_->viewers.size() + 1);
  rtc::Description::Video media("video", rtc::Description::Direction::SendOnly);
  media.addH264Codec(96);
  media.addSSRC(ssrc, "stitchd-video");
  v->track = v->pc->addTrack(media);

  v->rtp_cfg = std::make_shared<rtc::RtpPacketizationConfig>(
      ssrc, "stitchd-video", 96, rtc::H264RtpPacketizer::defaultClockRate);
  auto packetizer = std::make_shared<rtc::H264RtpPacketizer>(
      rtc::NalUnit::Separator::LongStartSequence, v->rtp_cfg);
  v->track->setMediaHandler(packetizer);

  v->track->onOpen([v] { v->open = true; });
  v->track->onClosed([v] { v->dead = true; });
  v->pc->onStateChange([v](rtc::PeerConnection::State s) {
    if (s == rtc::PeerConnection::State::Failed ||
        s == rtc::PeerConnection::State::Closed ||
        s == rtc::PeerConnection::State::Disconnected)
      v->dead = true;
  });

  // Wait for gathering so the answer carries candidates (no trickle needed —
  // WHEP clients accept a complete answer, and it keeps this endpoint
  // stateless).
  std::mutex m;
  std::condition_variable cv;
  bool done = false;
  v->pc->onGatheringStateChange([&](rtc::PeerConnection::GatheringState s) {
    if (s == rtc::PeerConnection::GatheringState::Complete) {
      std::lock_guard<std::mutex> lk(m);
      done = true;
      cv.notify_all();
    }
  });

  try {
    v->pc->setRemoteDescription(rtc::Description(body, "offer"));
  } catch (const std::exception &e) {
    WLOGF("bad offer for '%s': %s", name.c_str(), e.what());
    respond("400 Bad Request", "", "bad offer\n", "text/plain");
    ::close(fd);
    return;
  }

  {
    std::unique_lock<std::mutex> lk(m);
    cv.wait_for(lk, std::chrono::seconds(5), [&] { return done; });
  }

  auto local = v->pc->localDescription();
  if (!local) {
    respond("500 Internal Server Error", "", "no answer\n", "text/plain");
    ::close(fd);
    return;
  }
  std::string answer = add_host_candidates(std::string(local.value()),
                                           impl_->opt.additional_hosts,
                                           impl_->opt.udp_mux_port);

  {
    std::lock_guard<std::mutex> lk(impl_->viewers_mu);
    impl_->viewers.push_back(v);
  }
  ++viewers_;
  WLOGF("viewer connected to '%s' (%d total)", name.c_str(), viewers_.load());

  respond("201 Created", "Location: /whep/" + name + "\r\n", answer,
          "application/sdp");
  ::close(fd);
}

std::vector<Server::ViewerInfo> Server::viewer_list() const {
  std::vector<ViewerInfo> out;
  std::lock_guard<std::mutex> lk(impl_->viewers_mu);
  for (const auto &v : impl_->viewers) {
    if (v->dead) continue;
    out.push_back({v->stream, v->open ? "playing" : "connecting"});
  }
  return out;
}

void Server::broadcast(const std::string &name, const AVPacket *pkt,
                       AVRational time_base) {
  std::vector<std::shared_ptr<Viewer>> targets;
  {
    std::lock_guard<std::mutex> lk(impl_->viewers_mu);
    if (impl_->viewers.empty()) return;
    for (auto &v : impl_->viewers)
      if (!v->dead && v->open && v->stream == name) targets.push_back(v);
    // Reap finished viewers here; nothing else walks this list.
    size_t before = impl_->viewers.size();
    impl_->viewers.erase(
        std::remove_if(impl_->viewers.begin(), impl_->viewers.end(),
                       [](const std::shared_ptr<Viewer> &v) { return v->dead.load(); }),
        impl_->viewers.end());
    if (impl_->viewers.size() != before)
      viewers_ = (int)impl_->viewers.size();
  }
  if (targets.empty()) return;

  // RTP runs at 90 kHz regardless of the encoder's time base.
  const int64_t ts90k =
      av_rescale_q(pkt->pts, time_base, AVRational{1, 90000});

  for (auto &v : targets) {
    try {
      v->rtp_cfg->timestamp = (uint32_t)ts90k;
      v->track->send(reinterpret_cast<const std::byte *>(pkt->data),
                     (size_t)pkt->size);
    } catch (const std::exception &) {
      // A send failure means this peer is gone; never let it affect the
      // encoder or any other viewer.
      v->dead = true;
    }
  }
}

} // namespace webrtc
