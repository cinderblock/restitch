#include "rtsp.h"

#include <algorithm>
#include <arpa/inet.h>
#include <cerrno>
#include <cstdio>
#include <condition_variable>
#include <cstring>
#include <deque>
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

// How long a single send may stall before the client is declared gone. Long
// enough to ride out a multi-megabyte keyframe on a slow link, short enough
// that a dead client is reaped rather than starving its own session forever.
constexpr int kSendTimeoutSec = 10;

// Per-client queue bound. Whichever trips first wins: frames bound the
// LATENCY (at 30 fps this is ~3 s), bytes bound the MEMORY so a fat stream
// like `full` (7560x2688 hevc) cannot hoard hundreds of MB per viewer.
//
// Sized generously on purpose. An earlier attempt bounded a client to ~1 s and
// dropped frames the moment it exceeded that; real clients do not read that
// smoothly (ffmpeg decoding 3600x1280 reads in bursts) and healthy viewers
// were mangled. A few seconds of slack absorbs an ordinary hiccup and still
// bounds drift to something far short of the ~20 s that started all this.
constexpr size_t kMaxQueueFrames = 90;
constexpr size_t kMaxQueueBytes = 24u << 20; // 24 MiB

// Keep the kernel's own buffer modest so it cannot become a second, INVISIBLE
// queue underneath ours — anything sitting there is beyond our reach and is
// pure latency. Total client latency is roughly this plus the queue above.
// Far above the LAN bandwidth-delay product, so throughput is unaffected.
constexpr int kSendBufBytes = 512 << 10; // 512 KiB

bool write_all(int fd, const uint8_t *p, size_t n) {
  while (n > 0) {
    ssize_t w = ::send(fd, p, n, MSG_NOSIGNAL);
    if (w > 0) { p += w; n -= (size_t)w; continue; }
    if (w < 0 && errno == EINTR) continue;
    // EAGAIN/EWOULDBLOCK here means SO_SNDTIMEO expired: the peer has stopped
    // draining. Treat it as a dead client rather than retrying forever.
    return false;
  }
  return true;
}

// Even ports for RTP; RTCP conventionally takes the odd one above.
int next_udp_port() {
  static std::atomic<int> next{20000};
  int p = next.fetch_add(2);
  if (p > 20998) { next = 20000; p = 20000; }
  return p;
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
  // Time base the encoder produces packets in. The rtp muxer REWRITES
  // st->time_base to 1/90000 inside avformat_write_header, so packets must be
  // rescaled from this into the stream's base at send time — feeding raw
  // encoder timestamps makes every frame land ~1 tick apart instead of 3000,
  // which is exactly the "one frame then dead" symptom in VLC.
  AVRational src_tb{1, 90000};
  std::string peer;
  bool interleaved = true;
  int server_rtp_port = 0;
  AVFormatContext *rtp = nullptr;
  AVStream *st = nullptr;
  std::mutex mu;          // serializes writes to fd + muxer
  std::atomic<bool> dead{false};
  size_t pending = 0;     // bytes handed to the muxer for the current packet

  // --- per-client send queue -------------------------------------------
  // The encoder thread enqueues here and returns; a writer thread owns the
  // muxer and the socket. This is the whole point: frames sitting in THIS
  // queue are still ours to discard, so a client that falls behind can be
  // dropped forward to live. Bytes already handed to the kernel cannot be
  // recalled, which is why bounding the socket buffer alone could never fix
  // the drift and instead wedged clients (plans/stream-latency-2026-08.md).
  std::mutex qmu;
  std::condition_variable qcv;
  std::deque<AVPacket *> queue; // owned clones, in send order
  size_t queue_bytes = 0;
  // Set when the queue was flushed: the client's GOP now has a hole, so send
  // nothing until the next keyframe rather than a stream it cannot decode.
  bool need_key = false;
  std::atomic<uint64_t> dropped{0};
  std::thread writer;
  std::atomic<bool> writer_run{false};

  ~Session() {
    for (auto *p : queue) { AVPacket *q = p; av_packet_free(&q); }
    queue.clear();
    if (rtp) {
      if (rtp->pb) {
        if (interleaved) {
          av_freep(&rtp->pb->buffer);
          avio_context_free(&rtp->pb);
        } else {
          avio_closep(&rtp->pb); // libavformat owns the UDP socket
        }
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

  // Take a snapshot and release the lock: joining a writer while holding
  // sessions_mu_ would deadlock against anything that needs it, and a writer
  // parked in send() can take until SO_SNDTIMEO to notice.
  std::vector<std::shared_ptr<Session>> snapshot;
  {
    std::lock_guard<std::mutex> lk(sessions_mu_);
    snapshot.swap(sessions_);
  }
  for (auto &s : snapshot) {
    s->dead = true;
    // shutdown(), not close(): it unblocks a writer parked in send() straight
    // away, and the connection thread still owns this fd and will close it.
    // Closing here raced that thread into a double close.
    if (s->fd >= 0) ::shutdown(s->fd, SHUT_RDWR);
    stop_writer(*s);
  }
  snapshot.clear();

  std::lock_guard<std::mutex> lk(sessions_mu_);
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
    // Bound how long a send may block. Without this a client that stops
    // reading (VLC killed, laptop slept, Wi-Fi dropped) leaves send() blocked
    // forever holding the session mutex: every later broadcast skips that
    // session, the socket sits at Send-Q 0 receiving nothing, and the session
    // is never marked dead — it looks connected and playing while delivering
    // no video. Observed in production 2026-08-05.
    timeval tv{};
    tv.tv_sec = kSendTimeoutSec;
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    // See kSendBufBytes: keep the kernel from hoarding a second queue we
    // cannot see into or discard from.
    int sndbuf = kSendBufBytes;
    ::setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
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
    // Shut the socket down so the connection thread's blocking recv() returns
    // and cleans up; otherwise it parks forever on a socket nobody reads.
    s->dead = true;
    ::shutdown(s->fd, SHUT_RDWR);
    RLOGF("client on '%s' stopped reading — dropped", s->stream.c_str());
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
        // Drop the SDP control suffix if present, then take EVERYTHING after
        // the host as the name — stream names can contain slashes
        // (raw/bay-1), so using only the last segment would look up "bay-1".
        std::string tail = last_seg(u);
        if (tail.rfind("streamid=", 0) == 0 || tail.rfind("trackID=", 0) == 0 ||
            tail.rfind("track", 0) == 0) {
          size_t sl = u.find_last_of('/');
          if (sl != std::string::npos) u = u.substr(0, sl);
        }
        // Strip scheme://host[:port] if the client sent an absolute URI.
        size_t sch = u.find("://");
        if (sch != std::string::npos) {
          size_t host_end = u.find('/', sch + 3);
          u = host_end == std::string::npos ? std::string() : u.substr(host_end);
        }
        while (!u.empty() && u.front() == '/') u.erase(0, 1);
        name = u;
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
        // VLC and most players ask for plain UDP FIRST and only fall back to
        // interleaved TCP if the server refuses. mediamtx was configured
        // tcp-only, so clients never got the choice and always ended up on
        // TCP; answering 461 here instead made VLC fail outright. Serve both.
        const bool want_tcp =
            transport.find("TCP") != std::string::npos ||
            transport.find("interleaved") != std::string::npos;

        sess = std::make_shared<Session>();
        sess->fd = fd;
        sess->stream = name;
        sess->interleaved = want_tcp;
        {
          sockaddr_in pa{};
          socklen_t pl = sizeof(pa);
          char ipbuf[INET_ADDRSTRLEN] = "?";
          if (::getpeername(fd, (sockaddr *)&pa, &pl) == 0)
            ::inet_ntop(AF_INET, &pa.sin_addr, ipbuf, sizeof(ipbuf));
          sess->peer = std::string(ipbuf) + ":" + std::to_string(ntohs(pa.sin_port));
        }

        int ch = 0, client_rtp = 0;
        if (want_tcp) {
          size_t ip = transport.find("interleaved=");
          if (ip != std::string::npos) ch = std::atoi(transport.c_str() + ip + 12);
          sess->rtp_channel = ch;
        } else {
          size_t cp = transport.find("client_port=");
          client_rtp = cp == std::string::npos
                           ? 0
                           : std::atoi(transport.c_str() + cp + 12);
          if (client_rtp <= 0) {
            reply("461 Unsupported Transport", cseq);
            sess.reset();
            continue;
          }
        }

        std::string url;
        if (!want_tcp) {
          // Media goes to the peer of THIS control connection.
          sockaddr_in pa{};
          socklen_t pl = sizeof(pa);
          char ipbuf[INET_ADDRSTRLEN] = "127.0.0.1";
          if (::getpeername(fd, (sockaddr *)&pa, &pl) == 0)
            ::inet_ntop(AF_INET, &pa.sin_addr, ipbuf, sizeof(ipbuf));
          sess->server_rtp_port = next_udp_port();
          url = "rtp://" + std::string(ipbuf) + ":" +
                std::to_string(client_rtp) +
                "?localrtpport=" + std::to_string(sess->server_rtp_port) +
                "&pkt_size=1200";
        }

        if (avformat_alloc_output_context2(&sess->rtp, nullptr, "rtp",
                                           want_tcp ? nullptr : url.c_str()) < 0) {
          reply("500 Internal Server Error", cseq); sess.reset(); continue;
        }
        sess->st = avformat_new_stream(sess->rtp, nullptr);
        avcodec_parameters_copy(sess->st->codecpar, it->second.par);
        sess->st->time_base = it->second.time_base;
        sess->src_tb = it->second.time_base;

        if (want_tcp) {
          const int kBuf = 1500; // one MTU per RTP packet
          uint8_t *abuf = (uint8_t *)av_malloc(kBuf);
          sess->rtp->pb = avio_alloc_context(abuf, kBuf, 1, sess.get(), nullptr,
                                             session_write, nullptr);
          sess->rtp->pb->max_packet_size = kBuf;
        } else if (avio_open(&sess->rtp->pb, url.c_str(), AVIO_FLAG_WRITE) < 0) {
          RLOGF("udp open failed for %s", url.c_str());
          reply("461 Unsupported Transport", cseq); sess.reset(); continue;
        }

        if (avformat_write_header(sess->rtp, nullptr) < 0) {
          reply("500 Internal Server Error", cseq); sess.reset(); continue;
        }

        if (want_tcp) {
          reply("200 OK", cseq,
                "Transport: RTP/AVP/TCP;unicast;interleaved=" +
                    std::to_string(ch) + "-" + std::to_string(ch + 1) +
                    "\r\nSession: " + session_id + "\r\n");
        } else {
          reply("200 OK", cseq,
                "Transport: RTP/AVP;unicast;client_port=" +
                    std::to_string(client_rtp) + "-" +
                    std::to_string(client_rtp + 1) + ";server_port=" +
                    std::to_string(sess->server_rtp_port) + "-" +
                    std::to_string(sess->server_rtp_port + 1) +
                    "\r\nSession: " + session_id + "\r\n");
        }
        continue;
      }

      if (method == "PLAY") {
        if (!sess) { reply("455 Method Not Valid In This State", cseq); continue; }
        reply("200 OK", cseq, "Session: " + session_id + "\r\n");
        // Start the writer BEFORE the session is visible to broadcast(), so
        // no packet can be enqueued with nobody to drain it.
        sess->writer_run = true;
        sess->writer = std::thread([this, s = sess.get()] { session_writer(s); });
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
  // Join the writer BEFORE closing the fd: it is mid-send on this descriptor,
  // and closing underneath it would at best fail the write and at worst write
  // into whatever the number gets recycled for.
  if (sess) stop_writer(*sess);
  ::close(fd);
  --clients_;
}

std::vector<Server::SessionInfo> Server::sessions() const {
  std::vector<SessionInfo> out;
  std::lock_guard<std::mutex> lk(sessions_mu_);
  for (const auto &s : sessions_) {
    if (s->dead) continue;
    size_t q = 0;
    {
      std::lock_guard<std::mutex> qlk(s->qmu);
      q = s->queue.size();
    }
    out.push_back({s->peer, s->stream, s->interleaved ? "tcp" : "udp",
                   s->dropped.load(), q});
  }
  return out;
}

// Drain one client's queue onto its socket. Runs on its OWN thread, so a
// blocking send here costs only this client. The encoder thread never gets
// here — that was the defect behind every earlier attempt, where broadcast()
// wrote inline and one slow viewer stalled the whole output.
void Server::stop_writer(Session &s) {
  if (!s.writer.joinable()) return;
  {
    std::lock_guard<std::mutex> lk(s.qmu);
    s.writer_run = false;
  }
  s.qcv.notify_all();
  s.writer.join();
}

void Server::session_writer(Session *s) {
  for (;;) {
    AVPacket *p = nullptr;
    {
      std::unique_lock<std::mutex> lk(s->qmu);
      s->qcv.wait(lk, [s] {
        return !s->queue.empty() || s->dead.load() || !s->writer_run.load();
      });
      if (s->queue.empty()) {
        if (s->dead.load() || !s->writer_run.load()) break;
        continue;
      }
      p = s->queue.front();
      s->queue.pop_front();
      s->queue_bytes -= (size_t)p->size;
    }

    {
      std::lock_guard<std::mutex> lk(s->mu);
      if (!s->dead.load()) {
        p->stream_index = 0;
        // st->time_base is whatever write_header settled on (1/90000 for RTP).
        av_packet_rescale_ts(p, s->src_tb, s->st->time_base);
        // Blocking, bounded by SO_SNDTIMEO. A client that stops reading
        // entirely trips that and is marked dead by session_write — which is
        // how a frozen viewer gets reaped now that it cannot simply rot in an
        // ever-growing buffer.
        if (av_write_frame(s->rtp, p) < 0) s->dead = true;
      }
    }
    av_packet_free(&p);
  }

  std::lock_guard<std::mutex> lk(s->qmu);
  for (auto *q : s->queue) { AVPacket *r = q; av_packet_free(&r); }
  s->queue.clear();
  s->queue_bytes = 0;
}

void Server::broadcast(const std::string &name, const AVPacket *pkt) {
  std::vector<std::shared_ptr<Session>> targets;
  {
    std::lock_guard<std::mutex> lk(sessions_mu_);
    if (sessions_.empty()) return;
    for (auto &s : sessions_)
      if (!s->dead && s->stream == name) targets.push_back(s);
  }
  // A packet with no PTS rescales to garbage and lands as one wild RTP
  // timestamp among otherwise perfect 3000-tick steps — enough of a
  // discontinuity for a player to give up right after joining. Fall back to
  // DTS, and drop the packet if neither is set rather than emit a lie.
  const int64_t pts = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : pkt->dts;
  if (pts == AV_NOPTS_VALUE) return;
  const bool key = (pkt->flags & AV_PKT_FLAG_KEY) != 0;

  for (auto &s : targets) {
    std::unique_lock<std::mutex> lk(s->qmu);
    if (s->dead) continue;

    // After a flush, wait for a keyframe. Sending the tail of a GOP whose
    // start we discarded just hands the client garbage to decode.
    if (s->need_key && !key) { ++s->dropped; continue; }

    if (s->queue.size() >= kMaxQueueFrames ||
        s->queue_bytes >= kMaxQueueBytes) {
      // This client is not keeping up. Throw away what it has not received
      // yet and restart it at the next keyframe: it loses a couple of seconds
      // of video and comes back LIVE, instead of falling permanently behind.
      size_t n = s->queue.size();
      for (auto *q : s->queue) { AVPacket *r = q; av_packet_free(&r); }
      s->queue.clear();
      s->queue_bytes = 0;
      s->dropped += n;
      s->need_key = true;
      RLOGF("client on '%s' behind — flushed %zu queued frames, resuming at "
            "next keyframe (%llu dropped)",
            s->stream.c_str(), n, (unsigned long long)s->dropped.load());
      if (!key) continue;
    }

    AVPacket *c = av_packet_clone(pkt);
    if (!c) continue;
    c->pts = c->dts = pts;
    s->queue.push_back(c);
    s->queue_bytes += (size_t)c->size;
    s->need_key = false;
    lk.unlock();
    s->qcv.notify_one();
  }
}

} // namespace rtsp
