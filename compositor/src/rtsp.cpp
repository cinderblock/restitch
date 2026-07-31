#include "rtsp.h"

#include <algorithm>
#include <arpa/inet.h>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sstream>
#include <sys/socket.h>
#include <unistd.h>

extern "C" {
#include <libavutil/intreadwrite.h>
#include <libavutil/opt.h>
}

namespace rtsp {
namespace {

#define RLOGF(...)                                                             \
  do {                                                                         \
    std::fprintf(stderr, "[stitchd/rtsp] " __VA_ARGS__);                        \
    std::fprintf(stderr, "\n");                                                \
  } while (0)

// Max bytes we will buffer for one client before declaring it too slow and
// dropping it. A 7560x2688 HEVC keyframe is multiple MB, so this must clear
// several of them — the same reasoning behind mediamtx's writeQueueSize 65536.
// Undersizing this shreds keyframes; oversizing only costs idle memory.
constexpr size_t kMaxClientBacklog = 32u * 1024 * 1024;

bool write_all(int fd, const uint8_t *p, size_t n) {
  while (n > 0) {
    ssize_t w = ::send(fd, p, n, MSG_NOSIGNAL);
    if (w > 0) { p += w; n -= (size_t)w; continue; }
    if (w < 0 && errno == EINTR) continue;
    return false;
  }
  return true;
}

std::string trim(const std::string &s) {
  size_t a = s.find_first_not_of(" \t\r\n");
  if (a == std::string::npos) return "";
  size_t b = s.find_last_not_of(" \t\r\n");
  return s.substr(a, b - a + 1);
}

} // namespace

// One PLAYing client: its own RTP muxer, writing $-interleaved onto the socket.
struct Server::Session {
  int fd = -1;
  std::string stream;
  int rtp_channel = 0;
  AVFormatContext *rtp = nullptr;
  AVStream *st = nullptr;
  std::mutex mu;          // serializes writes to fd + muxer
  std::atomic<bool> dead{false};
  size_t pending = 0;     // bytes handed to the muxer for the current packet

  ~Session() {
    if (rtp) {
      if (rtp->pb) {
        av_freep(&rtp->pb->buffer);
        avio_context_free(&rtp->pb);
      }
      avformat_free_context(rtp);
    }
  }
};

Server::~Server() { stop(); }

void Server::add_stream(const std::string &name, const AVCodecParameters *par,
                        AVRational tb) {
  StreamInfo si;
  si.name = name;
  si.par = avcodec_parameters_alloc();
  avcodec_parameters_copy(si.par, par);
  si.time_base = tb;
  streams_[name] = si;
}

bool Server::start(int port) {
  port_ = port;
  listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
  if (listen_fd_ < 0) { RLOGF("socket: %s", std::strerror(errno)); return false; }
  int on = 1;
  ::setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_ANY);
  a.sin_port = htons((uint16_t)port);
  if (::bind(listen_fd_, (sockaddr *)&a, sizeof(a)) < 0) {
    RLOGF("bind :%d: %s", port, std::strerror(errno));
    ::close(listen_fd_);
    listen_fd_ = -1;
    return false;
  }
  if (::listen(listen_fd_, 16) < 0) {
    RLOGF("listen: %s", std::strerror(errno));
    ::close(listen_fd_);
    listen_fd_ = -1;
    return false;
  }
  running_ = true;
  accept_thread_ = std::thread([this] { accept_loop(); });
  RLOGF("listening on :%d (%zu streams, TCP interleaved)", port, streams_.size());
  return true;
}

void Server::stop() {
  if (!running_.exchange(false)) return;
  if (listen_fd_ >= 0) { ::shutdown(listen_fd_, SHUT_RDWR); ::close(listen_fd_); listen_fd_ = -1; }
  if (accept_thread_.joinable()) accept_thread_.join();
  std::lock_guard<std::mutex> lk(sessions_mu_);
  for (auto &s : sessions_) { s->dead = true; if (s->fd >= 0) ::close(s->fd); }
  sessions_.clear();
  for (auto &kv : streams_) if (kv.second.par) avcodec_parameters_free(&kv.second.par);
}

void Server::accept_loop() {
  while (running_) {
    sockaddr_in ca{};
    socklen_t cl = sizeof(ca);
    int fd = ::accept(listen_fd_, (sockaddr *)&ca, &cl);
    if (fd < 0) {
      if (!running_) break;
      if (errno == EINTR) continue;
      continue;
    }
    int on = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof(on));
    std::thread([this, fd] { serve_conn(fd); }).detach();
  }
}

// AVIO write callback: hand each RTP packet to the client as an interleaved
// frame ($ <channel> <len16> <payload>) on the RTSP socket.
static int session_write(void *opaque, const uint8_t *buf, int size) {
  auto *s = static_cast<Server::Session *>(opaque);
  if (s->dead) return size; // swallow; the connection thread will clean up
  uint8_t hdr[4] = {0x24, (uint8_t)s->rtp_channel, (uint8_t)(size >> 8),
                    (uint8_t)(size & 0xff)};
  if (!write_all(s->fd, hdr, 4) || !write_all(s->fd, buf, (size_t)size)) {
    s->dead = true;
  }
  return size;
}

void Server::serve_conn(int fd) {
  ++clients_;
  std::string session_id = std::to_string((long)fd * 2654435761u % 100000000u);
  std::shared_ptr<Session> sess;
  std::string buf;
  char tmp[4096];

  auto reply = [&](const std::string &status, int cseq,
                   const std::string &extra = "",
                   const std::string &body = "") {
    std::ostringstream o;
    o << "RTSP/1.0 " << status << "\r\nCSeq: " << cseq << "\r\n"
      << "Server: stitchd\r\n";
    if (!body.empty())
      o << "Content-Type: application/sdp\r\nContent-Length: " << body.size()
        << "\r\n";
    o << extra << "\r\n" << body;
    std::string s = o.str();
    return write_all(fd, (const uint8_t *)s.data(), s.size());
  };

  while (running_ && (!sess || !sess->dead)) {
    ssize_t n = ::recv(fd, tmp, sizeof(tmp), 0);
    if (n <= 0) break;
    buf.append(tmp, (size_t)n);

    // Requests end at a blank line. (We never expect a body from clients.)
    size_t end;
    while ((end = buf.find("\r\n\r\n")) != std::string::npos) {
      std::string req = buf.substr(0, end);
      buf.erase(0, end + 4);

      std::istringstream rs(req);
      std::string line, method, uri, ver;
      std::getline(rs, line);
      { std::istringstream ls(trim(line)); ls >> method >> uri >> ver; }
      int cseq = 0;
      std::string transport;
      while (std::getline(rs, line)) {
        std::string l = trim(line);
        if (l.rfind("CSeq:", 0) == 0) cseq = std::atoi(l.c_str() + 5);
        else if (l.rfind("Transport:", 0) == 0) transport = trim(l.substr(10));
      }

      // Stream name = last path segment — EXCEPT that SETUP/PLAY URIs carry
      // the per-track control suffix from the SDP (`a=control:streamid=0`),
      // so ffmpeg/VLC request rtsp://host/entry/streamid=0. Strip that or the
      // lookup sees "streamid=0" as the stream name and 404s.
      std::string name;
      {
        size_t q = uri.find('?');
        std::string u = q == std::string::npos ? uri : uri.substr(0, q);
        while (!u.empty() && u.back() == '/') u.pop_back();
        auto last_seg = [](const std::string &x) {
          size_t sl = x.find_last_of('/');
          return sl == std::string::npos ? x : x.substr(sl + 1);
        };
        name = last_seg(u);
        if (name.rfind("streamid=", 0) == 0 || name.rfind("trackID=", 0) == 0 ||
            name.rfind("track", 0) == 0) {
          size_t sl = u.find_last_of('/');
          if (sl != std::string::npos) name = last_seg(u.substr(0, sl));
        }
      }

      if (method == "OPTIONS") {
        reply("200 OK", cseq,
              "Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n");
        continue;
      }

      auto it = streams_.find(name);
      if (it == streams_.end()) { reply("404 Not Found", cseq); continue; }

      if (method == "DESCRIBE") {
        // Build SDP from a throwaway rtp context for this stream's codec.
        AVFormatContext *tmpc = nullptr;
        if (avformat_alloc_output_context2(&tmpc, nullptr, "rtp", nullptr) < 0 ||
            !tmpc) { reply("500 Internal Server Error", cseq); continue; }
        AVStream *ts = avformat_new_stream(tmpc, nullptr);
        avcodec_parameters_copy(ts->codecpar, it->second.par);
        ts->time_base = it->second.time_base;
        char sdp[4096] = {0};
        av_sdp_create(&tmpc, 1, sdp, sizeof(sdp));
        avformat_free_context(tmpc);
        reply("200 OK", cseq,
              "Content-Base: " + uri + "/\r\n", std::string(sdp));
        continue;
      }

      if (method == "SETUP") {
        if (transport.find("TCP") == std::string::npos &&
            transport.find("interleaved") == std::string::npos) {
          // UDP would need a second socket and NAT handling for no benefit
          // here; every client we serve supports interleaved TCP.
          reply("461 Unsupported Transport", cseq);
          continue;
        }
        int ch = 0;
        size_t ip = transport.find("interleaved=");
        if (ip != std::string::npos) ch = std::atoi(transport.c_str() + ip + 12);

        sess = std::make_shared<Session>();
        sess->fd = fd;
        sess->stream = name;
        sess->rtp_channel = ch;

        if (avformat_alloc_output_context2(&sess->rtp, nullptr, "rtp", nullptr) < 0) {
          reply("500 Internal Server Error", cseq); sess.reset(); continue;
        }
        sess->st = avformat_new_stream(sess->rtp, nullptr);
        avcodec_parameters_copy(sess->st->codecpar, it->second.par);
        sess->st->time_base = it->second.time_base;

        const int kBuf = 1500; // one MTU per RTP packet
        uint8_t *abuf = (uint8_t *)av_malloc(kBuf);
        sess->rtp->pb = avio_alloc_context(abuf, kBuf, 1, sess.get(), nullptr,
                                           session_write, nullptr);
        sess->rtp->pb->max_packet_size = kBuf;
        if (avformat_write_header(sess->rtp, nullptr) < 0) {
          reply("500 Internal Server Error", cseq); sess.reset(); continue;
        }

        reply("200 OK", cseq,
              "Transport: RTP/AVP/TCP;unicast;interleaved=" +
                  std::to_string(ch) + "-" + std::to_string(ch + 1) +
                  "\r\nSession: " + session_id + "\r\n");
        continue;
      }

      if (method == "PLAY") {
        if (!sess) { reply("455 Method Not Valid In This State", cseq); continue; }
        reply("200 OK", cseq, "Session: " + session_id + "\r\n");
        {
          std::lock_guard<std::mutex> lk(sessions_mu_);
          sessions_.push_back(sess);
        }
        RLOGF("client playing '%s' (interleaved ch %d)", name.c_str(),
              sess->rtp_channel);
        continue;
      }

      if (method == "TEARDOWN") {
        reply("200 OK", cseq, "Session: " + session_id + "\r\n");
        if (sess) sess->dead = true;
        break;
      }

      reply("501 Not Implemented", cseq);
    }
  }

  if (sess) sess->dead = true;
  {
    std::lock_guard<std::mutex> lk(sessions_mu_);
    sessions_.erase(std::remove_if(sessions_.begin(), sessions_.end(),
                                   [](const std::shared_ptr<Session> &s) {
                                     return s->dead.load();
                                   }),
                    sessions_.end());
  }
  ::close(fd);
  --clients_;
}

void Server::broadcast(const std::string &name, const AVPacket *pkt) {
  std::vector<std::shared_ptr<Session>> targets;
  {
    std::lock_guard<std::mutex> lk(sessions_mu_);
    if (sessions_.empty()) return;
    for (auto &s : sessions_)
      if (!s->dead && s->stream == name) targets.push_back(s);
  }
  for (auto &s : targets) {
    std::unique_lock<std::mutex> lk(s->mu, std::try_to_lock);
    // If this client's writer is still busy, skip it rather than queue behind
    // it. A stuck reader must only ever starve itself.
    if (!lk.owns_lock()) continue;
    if (s->dead) continue;
    AVPacket *c = av_packet_clone(pkt);
    if (!c) continue;
    c->stream_index = 0;
    if (av_write_frame(s->rtp, c) < 0) s->dead = true;
    av_packet_free(&c);
  }
}

} // namespace rtsp
