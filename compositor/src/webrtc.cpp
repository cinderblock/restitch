#include "webrtc.h"

#include "player.h"

#include <algorithm>
#include <arpa/inet.h>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <optional>
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
  // Annex-B SPS/PPS per stream, ready to prepend to each keyframe. See
  // annexb_parameter_sets().
  std::map<std::string, std::vector<std::byte>> psets;
  // fmtp line per stream, describing the profile we actually encode.
  std::map<std::string, std::string> profiles;

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

// SPS/PPS as Annex-B, ready to prepend to a keyframe.
//
// The encoder runs with AV_CODEC_FLAG_GLOBAL_HEADER, which keeps the parameter
// sets in extradata and OUT of the bitstream. RTSP does not care — libavformat
// puts them in the SDP — but a browser needs them IN BAND. Without them a
// WebRTC viewer receives megabytes of slices it cannot decode and floods PLIs:
// measured 9180 packets / 8.5 MB received, framesDecoded 0, pliCount 278.
//
// Handles both extradata shapes: Annex-B (start codes, what nvenc emits) and an
// AVCDecoderConfigurationRecord (leading 0x01), so this cannot silently break
// if the encoder or a muxer hands us the other one.
static std::vector<std::byte> annexb_parameter_sets(const AVCodecParameters *par) {
  std::vector<std::byte> out;
  const uint8_t *e = par->extradata;
  const int n = par->extradata_size;
  if (!e || n < 4) return out;

  auto append_start_code = [&out] {
    for (uint8_t b : {0, 0, 0, 1}) out.push_back(std::byte{b});
  };
  auto append = [&out](const uint8_t *p, size_t len) {
    for (size_t i = 0; i < len; ++i) out.push_back(std::byte{p[i]});
  };

  if (e[0] == 1) { // AVCDecoderConfigurationRecord
    if (n < 7) return out;
    int pos = 5;
    for (int round = 0; round < 2 && pos < n; ++round) {
      // SPS count is 5 bits; PPS count is a full byte.
      int count = round == 0 ? (e[pos++] & 0x1F) : e[pos++];
      for (int i = 0; i < count && pos + 2 <= n; ++i) {
        const int len = (e[pos] << 8) | e[pos + 1];
        pos += 2;
        if (len < 0 || pos + len > n) return out;
        append_start_code();
        append(e + pos, (size_t)len);
        pos += len;
      }
    }
    return out;
  }

  // Already Annex-B: the whole blob is start-code-delimited parameter sets.
  append(e, (size_t)n);
  return out;
}

// The fmtp profile-level-id a viewer must be offered, read from the SPS we
// actually send.
//
// libdatachannel's default is 42e01f — constrained baseline. Our encoder emits
// Main (profile=Main, level 3.0), so Chrome negotiated baseline, received a
// Main SPS and refused to decode a single frame: packets arrived, framesDecoded
// stayed 0, and it flooded PLIs asking for a keyframe it would never accept.
// The three bytes after the SPS NAL header are exactly profile_idc,
// constraint_set_flags and level_idc — which is what profile-level-id encodes.
static std::string h264_profile_level_id(const std::vector<std::byte> &psets) {
  auto at = [&psets](size_t i) { return std::to_integer<uint8_t>(psets[i]); };
  for (size_t i = 0; i + 6 < psets.size(); ++i) {
    if (at(i) != 0 || at(i + 1) != 0 || at(i + 2) != 1) continue;
    const size_t nal = i + 3;
    if ((at(nal) & 0x1F) != 7) continue; // want the SPS
    char buf[16];
    std::snprintf(buf, sizeof buf, "%02x%02x%02x", at(nal + 1), at(nal + 2),
                  at(nal + 3));
    return buf;
  }
  return "";
}

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
  auto psets = annexb_parameter_sets(copy);
  if (psets.empty())
    WLOGF("stream '%s' has no usable SPS/PPS in extradata — browsers will not "
          "decode it",
          name.c_str());
  const std::string plid = h264_profile_level_id(psets);
  if (!plid.empty()) {
    impl_->profiles[name] = "profile-level-id=" + plid +
                            ";packetization-mode=1;level-asymmetry-allowed=1";
    WLOGF("stream '%s': offering H.264 profile-level-id=%s", name.c_str(),
          plid.c_str());
  }
  impl_->psets[name] = std::move(psets);
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
  if (name.empty() || it == impl_->streams.end()) {
    respond("404 Not Found", "", "no such stream\n", "text/plain");
    ::close(fd);
    return;
  }

  // Same URL serves the player page (GET) and the WHEP exchange (POST), which
  // is the contract mediamtx had and the public Caddy mount still assumes.
  // Without this a browser pointed at the stream URL gets a 404 even though
  // the stream is fine.
  if (method == "GET") {
    respond("200 OK", "", kPlayerHtml, "text/html; charset=utf-8");
    ::close(fd);
    return;
  }
  if (method != "POST") {
    respond("405 Method Not Allowed", "Allow: GET, POST, OPTIONS\r\n",
            "use GET for the player or POST for WHEP\n", "text/plain");
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

  // Answer on the OFFER'S OWN m-line. libdatachannel matches media by mid, so a
  // track added under any other mid does not reconcile with the offer — it
  // becomes a SECOND m-line, and a browser rejects the whole answer with "The
  // order of m-lines in answer doesn't match order in offer". Hardcoding "video"
  // here meant no browser could ever play a WHEP stream: Chrome offers mid "0",
  // and the answer came back with m-lines [video/0, video/video].
  //
  // This survived because the endpoint was only ever checked for "201 with
  // candidates" — the same mistake as validating RTSP with ffmpeg, which
  // tolerated timestamps VLC would not.
  std::optional<rtc::Description> parsed;
  try {
    parsed.emplace(body, "offer");
  } catch (const std::exception &e) {
    WLOGF("unparseable offer for '%s': %s", name.c_str(), e.what());
    respond("400 Bad Request", "", "bad offer\n", "text/plain");
    ::close(fd);
    return;
  }
  rtc::Description &offer_desc = *parsed;
  std::string video_mid = "0";
  for (int i = 0; i < offer_desc.mediaCount(); ++i) {
    const auto entry = offer_desc.media(i);
    if (!std::holds_alternative<rtc::Description::Media *>(entry)) continue;
    auto *md = std::get<rtc::Description::Media *>(entry);
    if (md->type() == "video") { video_mid = md->mid(); break; }
  }

  // Take the payload type FROM THE OFFER. An answer may not redefine what a
  // payload type means, and 96 — which this used to hardcode — is normally VP8
  // in a Chrome offer. The browser then mapped our H.264 packets to its VP8
  // depacketizer and assembled nothing: 6529 packets received, framesReceived 0,
  // no codec stats at all, and a PLI flood.
  //
  // Prefer an H.264 entry whose profile matches what we actually encode, then
  // any H.264 with packetization-mode=1.
  int pt = -1;
  std::string pt_fmtp;
  {
    const std::string want = impl_->profiles.count(name)
                                 ? impl_->profiles[name].substr(
                                       std::strlen("profile-level-id="), 6)
                                 : std::string();
    int best_score = -1;
    for (int i = 0; i < offer_desc.mediaCount(); ++i) {
      const auto entry = offer_desc.media(i);
      if (!std::holds_alternative<rtc::Description::Media *>(entry)) continue;
      auto *md = std::get<rtc::Description::Media *>(entry);
      if (md->type() != "video") continue;
      for (int p : md->payloadTypes()) {
        const rtc::Description::Media::RtpMap *map = nullptr;
        try {
          map = md->rtpMap(p);
        } catch (const std::exception &) {
          continue;
        }
        if (!map) continue;
        std::string fmt = map->format;
        std::transform(fmt.begin(), fmt.end(), fmt.begin(), ::toupper);
        if (fmt != "H264") continue;
        std::string f;
        for (const auto &x : map->fmtps) f += x + ";";
        int score = 0;
        if (f.find("packetization-mode=1") != std::string::npos) score += 2;
        if (!want.empty() && f.find(want) != std::string::npos) score += 8;
        else if (f.find("profile-level-id=4d") != std::string::npos) score += 4;
        if (score > best_score) { best_score = score; pt = p; pt_fmtp = f; }
      }
      break;
    }
  }
  if (pt < 0) {
    WLOGF("offer for '%s' has no H.264 payload type — refusing", name.c_str());
    respond("406 Not Acceptable", "", "no h264 in offer\n", "text/plain");
    ::close(fd);
    return;
  }
  if (!pt_fmtp.empty() && pt_fmtp.back() == ';') pt_fmtp.pop_back();

  const uint32_t ssrc = 42000u + (uint32_t)(impl_->viewers.size() + 1);
  rtc::Description::Video media(video_mid,
                                rtc::Description::Direction::SendOnly);
  // Echo the offer's own fmtp for this payload type, so its meaning is
  // unchanged between offer and answer.
  if (!pt_fmtp.empty()) media.addH264Codec(pt, pt_fmtp);
  else media.addH264Codec(pt);
  media.addSSRC(ssrc, "stitchd-video");
  v->track = v->pc->addTrack(media);

  v->rtp_cfg = std::make_shared<rtc::RtpPacketizationConfig>(
      ssrc, "stitchd-video", (uint8_t)pt,
      rtc::H264RtpPacketizer::defaultClockRate);
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
    v->pc->setRemoteDescription(offer_desc);
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
  //
  // Same hazard rtsp.cpp already guards: a packet with no PTS rescales to
  // garbage, and one wild timestamp among otherwise even steps stops a receiver
  // assembling frames at all. Fall back to DTS; drop rather than emit a lie.
  const int64_t src_pts = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : pkt->dts;
  if (src_pts == AV_NOPTS_VALUE) return;
  const int64_t ts90k = av_rescale_q(src_pts, time_base, AVRational{1, 90000});


  // Put SPS/PPS in front of every keyframe. They live in extradata, not in the
  // bitstream, and a browser cannot decode a single frame without them — nor
  // can a viewer that joins mid-stream ever recover, since the parameter sets
  // would otherwise have gone out before it connected.
  const std::byte *data = reinterpret_cast<const std::byte *>(pkt->data);
  size_t len = (size_t)pkt->size;
  std::vector<std::byte> with_psets;
  if (pkt->flags & AV_PKT_FLAG_KEY) {
    std::vector<std::byte> *ps = nullptr;
    {
      std::lock_guard<std::mutex> lk(impl_->viewers_mu);
      auto it = impl_->psets.find(name);
      if (it != impl_->psets.end() && !it->second.empty()) ps = &it->second;
      if (ps) {
        with_psets.reserve(ps->size() + len);
        with_psets.insert(with_psets.end(), ps->begin(), ps->end());
      }
    }
    if (ps) {
      with_psets.insert(with_psets.end(), data, data + len);
      data = with_psets.data();
      len = with_psets.size();
    }
  }

  for (auto &v : targets) {
    try {
      v->rtp_cfg->timestamp = (uint32_t)ts90k;
      v->track->send(data, len);
    } catch (const std::exception &) {
      // A send failure means this peer is gone; never let it affect the
      // encoder or any other viewer.
      v->dead = true;
    }
  }
}

} // namespace webrtc
