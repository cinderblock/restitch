#include "rtsp.h"

#include <algorithm>
#include <arpa/inet.h>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sstream>
#include <sys/ioctl.h> // TIOCOUTQ: unsent bytes, i.e. this client's backlog
#include <sys/socket.h>
#include <sys/uio.h> // iovec, for writing the $-header and payload as one frame
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

// Cap the kernel send buffer per client. THIS IS A LATENCY BOUND, not a memory
// tuning knob, and it is the whole reason a slow reader can't silently rot.
//
// Left to autotune, SO_SNDBUF grows into the tens of megabytes. A client that
// reads even slightly slower than realtime then never makes send() block, so
// it is never reaped by SO_SNDTIMEO and the broadcast writer is never "busy" —
// every packet is accepted into the buffer and the client's *latency* grows
// without bound instead. Measured 2026-08-09 with a reader at 90% of realtime:
// Send-Q climbed 15 KB → 3.28 MB in 100 s, monotonic, never dropped. A 1% read
// deficit accumulates ~36 s of lag per hour. That is the "streams are 20s late"
// bug, and it presents as a perfectly clean stream that is simply stale.
//
// Capping the buffer gives session_write a concrete "is this client keeping
// up?" test: if the next packet doesn't fit, the client is behind and loses
// frames. Note the cap alone is NOT the fix — with a blocking send() a full
// buffer stalls the encoder thread instead (measured: full-low lost 2744 of
// 7070 frames to one slow reader while its siblings lost none). The buffer
// bound and the explicit fit-check in session_write only work together.
//
// Sized in bytes, so it bounds a fat stream to less time than a thin one,
// which is the behaviour we want. Linux doubles the request, so the effective
// bound is ~2 MiB — about 2 s on full-low, well under a second on `full`. Far
// above the LAN bandwidth-delay product (~4 KB at 100 Mbps / 0.3 ms), so a
// healthy client is unaffected.
constexpr int kSendBufBytes = 1 << 20; // 1 MiB (kernel doubles it)

// How long a client may deliver NOTHING before it is dropped so it can
// reconnect. This restores the reaping that SO_SNDTIMEO used to provide: that
// only ever fired because writes blocked, and writes no longer block, so
// without this a stuck client is never noticed at all.
//
// It also breaks a genuine deadlock. Once a client stops draining, outq pins at
// the drop threshold and stays there — so every keyframe clears the resync
// flag, then re-trips the threshold on that keyframe's own first packet and
// loses the rest of it. The client never receives one complete frame and never
// recovers, while the server cheerfully logs a "resync" each time. Observed
// overnight 2026-08-09: 6002 drop / 5683 "resync" events on a frozen VLC that
// only came back when the user reconnected it by hand.
//
// Dropping is the recovery. A player pointed at a looping single-item playlist
// reconnects on EOF and lands back at the live edge, which is exactly the
// manual fix, automated.
constexpr int kMaxStallSec = 10;

int64_t now_us() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

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
  // Set when a packet had to be skipped because this client's writer was still
  // blocked (i.e. it is not draining fast enough). Once any packet is skipped
  // the client's bitstream has a hole, so nothing more is sent to it until the
  // next keyframe lets it start clean. Atomic because it is set from
  // broadcast() without holding `mu` — that is the whole point: the writer
  // thread owns the lock precisely when we need to record the skip.
  std::atomic<bool> resync{false};
  std::atomic<uint64_t> skipped{0}; // packets dropped for this client, lifetime
  uint64_t resyncs = 0;             // times it recovered at a keyframe (under mu)
  int sndbuf = 0;                   // kernel's real SO_SNDBUF (it doubles ours)
  // Last time a packet actually reached the socket. Not "last time we tried" —
  // a wedged client is one we keep trying and failing to write, so only real
  // progress may reset the stall clock.
  std::atomic<int64_t> last_progress_us{0};

  ~Session() {
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
    // Bound how long a send may block. Without this a client that stops
    // reading (VLC killed, laptop slept, Wi-Fi dropped) leaves send() blocked
    // forever holding the session mutex: every later broadcast skips that
    // session, the socket sits at Send-Q 0 receiving nothing, and the session
    // is never marked dead — it looks connected and playing while delivering
    // no video. Observed in production 2026-08-05.
    timeval tv{};
    tv.tv_sec = kSendTimeoutSec;
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    // Bound queued-but-unsent video (see kSendBufBytes). Must be set before
    // the connection is used; on Linux the kernel doubles the requested value
    // for bookkeeping, which is fine — we only need it to stay O(1 MB) rather
    // than autotuning into seconds of backlog.
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

  // Already dropping for this client: swallow everything until broadcast()
  // clears the flag at the next keyframe. Critically, this also swallows the
  // REST of the frame we bailed out of below — an interleaved frame is
  // length-prefixed, so emitting half of one desynchronises the client's RTSP
  // framing permanently, which is unrecoverable in a way a missing frame is not.
  if (s->resync.load()) { ++s->skipped; return size; }

  uint8_t hdr[4] = {0x24, (uint8_t)s->rtp_channel, (uint8_t)(size >> 8),
                    (uint8_t)(size & 0xff)};

  // Never block the producer. broadcast() runs on the encoder thread and writes
  // inline, so a blocking send() here is back-pressure straight into the
  // pipeline: measured 2026-08-09, one slow reader cost full-low 2744 of 7070
  // frames while its sibling outputs dropped none. The client that can't keep
  // up must lose frames by itself.
  //
  // Two things have to be true at once, and getting only one of them is what
  // made the first two attempts at this fail:
  //
  //  1. We must not TEAR a frame. The $-framing is length-prefixed, so a short
  //     write desynchronises the client permanently — unrecoverable, unlike a
  //     missing frame. That rules out simply writing non-blocking and moving on.
  //  2. We must not BLOCK finishing a torn frame either. MSG_DONTWAIT almost
  //     never reports EAGAIN — a nearly-full buffer accepts a few bytes and
  //     returns a short count instead — so "finish the remainder, it's only
  //     ~1.5 KB" quietly became a blocking wait on a client draining at 40% of
  //     realtime. At ~22 RTP packets per frame that blew the frame budget and
  //     cost full-low 1585 of 3937 frames, siblings at zero.
  //
  // So refuse the write BEFORE starting it unless there is comfortable room.
  // Compare against half the buffer: TIOCOUTQ counts payload bytes while the
  // kernel budgets by skb truesize (several KB for a ~1.5 KB packet), so a
  // margin this large is what makes "it fits" actually mean it. Halving the
  // effective bound also halves the worst-case latency, which is the point.
  if (s->sndbuf > 0) {
    int outq = 0;
    if (::ioctl(s->fd, TIOCOUTQ, &outq) == 0 &&
        outq + 4 + size > s->sndbuf / 2) {
      if (!s->resync.exchange(true))
        RLOGF("client on '%s' not draining (%d KB queued) — dropping to next "
              "keyframe",
              s->stream.c_str(), outq / 1024);
      ++s->skipped;
      return size;
    }
  }

  iovec iov[2] = {{hdr, 4}, {const_cast<uint8_t *>(buf), (size_t)size}};
  msghdr mh{};
  mh.msg_iov = iov;
  mh.msg_iovlen = 2;
  ssize_t w = ::sendmsg(s->fd, &mh, MSG_NOSIGNAL | MSG_DONTWAIT);

  if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
    // Buffer full and nothing written, so the framing is still intact and this
    // packet can simply vanish. EINTR lands here too: nothing was sent, and
    // resyncing at the next keyframe is a cheaper answer to a rare signal than
    // dropping the client.
    if (!s->resync.exchange(true)) {
      int outq = 0;
      ::ioctl(s->fd, TIOCOUTQ, &outq);
      RLOGF("client on '%s' not draining (%d KB queued) — dropping to next "
            "keyframe",
            s->stream.c_str(), outq / 1024);
    }
    ++s->skipped;
    return size;
  }

  // A partial write commits us: an interleaved frame is length-prefixed, so
  // stopping halfway desynchronises the client's framing permanently. Finish
  // it with the blocking path — at most one RTP packet (~1.5 KB) remains, so
  // this cannot stall the encoder in any meaningful way.
  bool ok = w >= 0;
  if (ok) {
    size_t sent = (size_t)w, total = 4 + (size_t)size;
    if (sent < total) {
      uint8_t rest[4];
      if (sent < 4) { // header itself was torn
        std::memcpy(rest, hdr + sent, 4 - sent);
        ok = write_all(s->fd, rest, 4 - sent) &&
             write_all(s->fd, buf, (size_t)size);
      } else {
        ok = write_all(s->fd, buf + (sent - 4), total - sent);
      }
    }
  }

  if (ok) s->last_progress_us.store(now_us());

  if (!ok) {
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
        // Start the stall clock now, not on the first successful write — a
        // client that never manages a single packet still has to be reaped.
        sess->last_progress_us.store(now_us());
        // The kernel's real buffer, not what we asked for — Linux doubles the
        // SO_SNDBUF request. session_write budgets against this.
        {
          int v = 0;
          socklen_t vl = sizeof(v);
          if (::getsockopt(fd, SOL_SOCKET, SO_SNDBUF, &v, &vl) == 0 && v > 0)
            sess->sndbuf = v;
        }
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

std::vector<Server::SessionInfo> Server::sessions() const {
  std::vector<SessionInfo> out;
  std::lock_guard<std::mutex> lk(sessions_mu_);
  for (const auto &s : sessions_) {
    if (s->dead) continue;
    out.push_back({s->peer, s->stream, s->interleaved ? "tcp" : "udp",
                   s->skipped.load(), s->resync.load()});
  }
  return out;
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
    if (!lk.owns_lock()) {
      // Record the skip. With a bounded send buffer this is how a slow reader
      // is throttled: it loses frames instead of accumulating latency. The
      // hole means everything up to the next keyframe would decode as garbage,
      // so flag a resync. Log only the transition — a client that is
      // persistently slow must not spam a line per frame.
      if (!s->resync.exchange(true))
        RLOGF("client on '%s' not draining — dropping to next keyframe",
              s->stream.c_str());
      ++s->skipped;
      continue;
    }
    if (s->dead) continue;

    // A client we have written nothing to for kMaxStallSec is not slow, it is
    // stuck — either it stopped reading, or its backlog is pinned at the drop
    // threshold so even keyframes can't get through. Either way it will never
    // recover on this connection. Drop it; a looping player reconnects and
    // lands back at live.
    const int64_t last = s->last_progress_us.load();
    if (last && now_us() - last > (int64_t)kMaxStallSec * 1000000) {
      RLOGF("client on '%s' delivered nothing for %ds — dropping so it can "
            "reconnect (%llu packets dropped)",
            s->stream.c_str(), kMaxStallSec,
            (unsigned long long)s->skipped.load());
      s->dead = true;
      ::shutdown(s->fd, SHUT_RDWR);
      continue;
    }

    // Resume only on a keyframe, so the client resumes on a decodable stream
    // rather than mid-GOP. Clearing the flag only lets the keyframe *try* —
    // session_write re-sets it if the keyframe doesn't fit either, so success
    // is confirmed after the write, not assumed before it. Claiming a resync
    // that never happened is how a wedged client looked healthy in the log.
    bool trying_resync = false;
    if (s->resync.load()) {
      if (!(pkt->flags & AV_PKT_FLAG_KEY)) { ++s->skipped; continue; }
      s->resync.store(false);
      trying_resync = true;
    }
    // A packet with no PTS rescales to garbage and lands as one wild RTP
    // timestamp among otherwise perfect 3000-tick steps — enough of a
    // discontinuity for a player to give up right after joining. Fall back to
    // DTS, and drop the packet if neither is set rather than emit a lie.
    int64_t pts = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : pkt->dts;
    if (pts == AV_NOPTS_VALUE) continue;

    AVPacket *c = av_packet_clone(pkt);
    if (!c) continue;
    c->stream_index = 0;
    c->pts = c->dts = pts;
    // st->time_base is whatever write_header settled on (1/90000 for RTP).
    av_packet_rescale_ts(c, s->src_tb, s->st->time_base);
    if (av_write_frame(s->rtp, c) < 0) s->dead = true;
    av_packet_free(&c);

    // Only now is a recovery real: if session_write re-raised the flag, the
    // keyframe didn't fit either and the client is still behind.
    if (trying_resync && !s->resync.load()) {
      ++s->resyncs;
      RLOGF("client on '%s' resynced at keyframe (%llu packets dropped, "
            "resync #%llu)",
            s->stream.c_str(), (unsigned long long)s->skipped.load(),
            (unsigned long long)s->resyncs);
    }
  }
}

} // namespace rtsp
