# Streams "~20s late" — 2026-08-09

## Goal

User reports "streams are getting ~20s late again". Find where the delay
accumulates and remove it. "Again" refers to the ffmpeg-era latency creep
documented in `plans/composite-substream-startup-stall.md` (~15s after a warm
restart, drifting to 40-60s) — but that pipeline no longer exists, so this is a
new instance of an old *symptom*, not the old cause.

## Environment

- sentinel, up 4 days. `restitch` container (network_mode: host), up 2 days.
- Inside the container: `bun run src/index.ts` (supervisor + dashboard),
  `stitchd`, `whisper-server`.
- stitchd args: `--out null --hls-dir /tmp/hls --rtsp-port 8554
  --webrtc-port 8889 --webrtc-udp 8189 --webrtc-host stream.tomsawyerlabs.com`
- Dashboard listens on **:9000** (not 8090 — that port is an unrelated
  `state-control` bun dev server on this box, and it answers `/hls/*` with its
  own SPA fallback HTML, which will mislead you if you probe it).
- stitchd HTTP is **:8889** and serves only `/api/status` and `/whep/<stream>`.
  `/api/paths`, `/api/rtsp`, `/api/hls` are dashboard routes on :9000.

## Measurements (2026-08-09 ~20:00 PDT)

Method: cameras burn an OSD timestamp into the top-left of each frame. Grab one
frame with `ffmpeg -frames:v 1`, note wallclock at completion, compare to OSD.
Includes up to a GOP of connect delay, so these are upper bounds.

| Path | OSD time | Captured at | Latency |
| --- | --- | --- | --- |
| NVR direct `rtsp://10.255.0.2:7447/<bay-1>` | 19:59:21 | 19:59:23 | **~1-2 s** |
| stitchd `raw/bay-1` (verbatim republish) | 19:59:25 | 19:59:26 | **~1 s** |
| stitchd `full-low` composite over RTSP | 19:59:56-57 | 19:59:58 | **~1-2 s** |
| HLS via dashboard `/hls/full-low/index.m3u8` | 20:01:28-29 | 20:01:36 | **~7-8 s** |

**Conclusion: the server-side pipeline is healthy.** Ingest, compositing and
RTSP output are all ~1-2 s. HLS is ~7-8 s, which is inherent to its 2 s
segments × ~3-segment start offset, not a regression.

Supporting evidence that the compositor is not backlogged:

- `/api/status`: 6,010,196 frames, `dropped` 0 on full-low, the-field, john,
  entry, all-field; 18 lifetime on `full`.
- All five bay OSDs inside one composite frame agree within 1 s — no bay skew.
- Audio pump: `uptime 3335.0min lag 0.00s recent 100.0% inflight 0`.

## Findings / gotchas

- **The 20 s is not reproducible from inside sentinel.** Whatever is late is
  late in the *viewing* path (client, network, or a proxy), not in stitchd.
- **`full` has a client that can't keep up.** The log repeats
  `client playing 'full'` → `client on 'full' stopped reading — dropped` on a
  ~30 s cycle. `full` is hevc 7560x2688. A viewer on a constrained link would
  present exactly as "getting further behind", which is the reported symptom.
  Not yet identified whose connection this is.
- **The public stream page is currently broken, independently of this.** Caddy
  routes `stream.tomsawyerlabs.com/all-field` to `localhost:8890`, and nothing
  is listening on 8890. This is the parked, unpushed fix from `3f2fefc` /
  `plans/stitchd-absorb-mediamtx.md`. If the user watches there, they are not
  seeing a late stream, they are seeing no stream.
- `raw/field-centered` shows a mixer underrun of 139,355,910 ms — larger than
  the process uptime, so it is a counter/accounting bug, not real missing audio.
  Unrelated to latency; worth a separate look.

## User's answers (2026-08-09)

- Viewer: **VLC over RTSP direct**, on the **LAN**.
- Shape: session had been running a long time; noticed today it was 10-20 s late.

That combination rules out HLS segmenting and the proxy path, and points at a
long-lived RTSP session accumulating backlog — which is exactly what the code
does.

## ROOT CAUSE — confirmed by experiment

`compositor/src/rtsp.cpp` has **no lateness bound per client**. `broadcast()`
(:430) writes each packet straight into the client's socket via `session_write`
(:174) → `write_all` (:33), a *blocking* `send()` whose only escape is
`SO_SNDTIMEO = kSendTimeoutSec = 10` (:31, set at :165).

That timeout only catches a client that stops reading **entirely**. A client
reading slightly *slower* than realtime never blocks for 10 s in one call — it
drains continuously, just not fast enough — so it is never reaped. Its unsent
data accumulates in the kernel send buffer, and since TCP is lossless and
in-order, every accumulated byte is latency the viewer must sit through. There
is no drop-oldest and no resync-to-keyframe.

**Experiment.** Injected a deliberately slow reader on sentinel:
`ffmpeg -readrate 0.9 -rtsp_transport tcp -i rtsp://localhost:8554/full-low -f null -`
(reads at 90 % of realtime), then sampled `ss -tn 'sport = :8554'`:

| elapsed | Send-Q | ≈ latency (full-low ≈ 1.0 MB/s) |
| --- | --- | --- |
| 0 s | 15 KB | ~0 s |
| 20 s | 290 KB | ~0.3 s |
| 40 s | 554 KB | ~0.6 s |
| 80 s | 1.33 MB | ~1.3 s |
| 100 s | **3.28 MB** | **~3.3 s** |

Monotonic, unbounded, and the client was **never dropped**. Extrapolated, even
a **1 % read deficit accumulates ~36 s of latency per hour** — which is the
reported symptom exactly, and explains why it appears only after a session has
been up a long while.

This is the same failure *family* as the ffmpeg-era creep (unbounded backlog
rather than dropping), reached by a completely different route. It also means
the compositor's stated design requirement — "DROP when outputs aren't
draining, every drop logged, never silent" — is **not** met on the RTSP client
output path.

## Proposed fix

Bound each RTSP session's lateness server-side:

1. Sample unsent bytes with `ioctl(fd, TIOCOUTQ, &n)` before writing.
2. Above a threshold (a configured number of seconds' worth, ~2-3 s), stop
   sending that session's packets and set a "needs resync" flag.
3. While flagged, discard packets until the next keyframe, then resume — so the
   client sees a brief freeze and returns to live rather than a clean stream
   that is permanently 20 s stale.
4. Log every resync with the stream name and how far behind it was. Never
   silent.
5. Consider capping `SO_SNDBUF` so the kernel cannot hoard seconds of video
   before step 1 even notices.

**Caveat worth testing:** this fixes backlog held in *our* socket buffer. If
VLC has additionally buffered inside its own pipeline (it queues unboundedly
when its decoder can't keep up), the server-side bound cannot retract that.
Distinguish by checking Send-Q for the VLC peer while it is visibly late:
large Send-Q → ours to fix; ~0 → the backlog is inside VLC and the answer is a
lighter stream or VLC caching settings.

## The fix, and the two wrong versions before it

Shipped as `7c8fe76` → `1bd79dc` → `c5713eb` → `b2658ae`. The last one is the
keeper; the first three are recorded because each failed in a way that was
invisible without measuring the *encoder*, not just the client.

1. **Cap `SO_SNDBUF` alone** (`7c8fe76`). Bounded the client's backlog, but
   `broadcast()` writes inline on the encoder thread, so a full buffer blocked
   the *producer*. `broadcast()`'s `try_lock` skip can never fire for media —
   the producer IS the writer, so nothing ever contends. Cost full-low **2744
   of 7070 frames** while every sibling output dropped none: one slow viewer
   degraded the stream for all of them.
2. **`sendmsg(MSG_DONTWAIT)`, treat EAGAIN as "behind"** (`c5713eb`). EAGAIN
   almost never fires — a nearly-full buffer accepts a few bytes and returns a
   *short count*. So the "finish the torn remainder, it's only ~1.5 KB" path
   ran constantly, and finishing it meant blocking on a slow client. Cost
   full-low **1585 of 3937 frames with zero EAGAIN logged**.
3. **Check room before writing** (`b2658ae`, current). Refuse the packet up
   front unless `outq + 4 + size <= sndbuf/2`. The half-buffer margin is
   load-bearing: `TIOCOUTQ` counts payload bytes while the kernel budgets by
   skb truesize (several KB for a ~1.5 KB packet), so a bare `outq + size`
   comparison was tried and still stalled.

Two invariants have to hold simultaneously, and each wrong version satisfied
only one: **never tear a frame** (the `$`-framing is length-prefixed, so a
short write desynchronises the client permanently — far worse than a lost
frame) and **never block the producer**.

## Verified live (2026-08-09 22:19, deploy `b2658ae`)

With a deliberately pathological reader (`-readrate 0.4`, i.e. 40 % of
realtime) on `full-low`:

| | result |
| --- | --- |
| Encoder drops, all 6 outputs | **0**, frame counts identical (2538 each) |
| The slow client itself | **3988 packets dropped**, resyncing at keyframes |
| Send-Q ceiling | **1,048,223 B** — exactly half the 2 MB buffer |
| A healthy client on the same stream | OSD 22:19:30-31, captured 22:19:32 → **~1-2 s, unchanged** |

The cost is now borne entirely by the client that can't keep up, and every
drop is logged (`not draining … — dropping to next keyframe` /
`resynced at keyframe (N packets dropped, resync #M)`) and counted per session
in `/api/status`.

## REVERTED 2026-08-10 — the fix was worse than the bug

All of it is backed out (`6517c4c`, compositor identical to `08ee127`). Live
and verified healthy after the revert: 6 outputs, 0 encoder drops, ~2 s
latency, healthy client shows **0 decode errors and zero drop/reap events**.

**What happened.** Overnight the user's VLC froze and only came back when they
reconnected it by hand. The logs showed 6002 "not draining" / 5683 "resynced"
events cycling forever.

**Why it was unfixable as designed.** Once a client falls behind, its backlog
sits *pinned at the drop threshold*. The keyframe that would resync it has to
fit in the same buffer — and it doesn't, because the buffer is full of the
backlog. So the client never receives one complete frame and never recovers.
Every mechanism added on top made it worse:

- Clearing `resync` per keyframe re-stamped the "behind since" clock every GOP,
  so the stall reaper never fired.
- Fixing that made the reaper fire correctly — and then it disconnected a
  *healthy* client every 10 s.

**The threshold was the root flaw.** Half of a 2 MB socket buffer is ~1 s of
slack on full-low. A normal client does not read that smoothly: plain ffmpeg
decoding 3600x1280 reads in bursts. Measured on the deployed build, a
full-speed **local** reader went `behind=true` within 5 s, took 11 h264 decode
errors, and was reaped at 10 s. `john` and `all-field` behaved the same.

**The load-bearing lesson:** with TCP you cannot un-send what is already in the
kernel socket buffer. Every "drop to catch up" scheme that queues in the kernel
is really a "drop and stay behind anyway" scheme. Latency can only be bounded
where frames are still discardable — in userspace, before the socket.

### What a correct fix would look like

A per-session **userspace queue** with a small socket buffer beneath it, which
is how mediamtx and go2rtc do this and why their reader queues are configurable:

- Each session gets a bounded queue of whole encoded frames and its own writer
  thread draining it into the socket.
- `broadcast()` enqueues and returns — it never touches the socket, so the
  encoder can never block (and `broadcast()`'s existing `try_lock` skip finally
  means something, since a real second thread now holds the lock).
- When the queue is full, discard from it — **stale frames are still in our
  hands**, so a client genuinely returns to live instead of pinning at a
  threshold it can never get under.
- Size the queue in seconds of that stream's measured bitrate (~5 s), not in
  bytes, and reap only after a long continuous stall (~60 s), so a client that
  hiccups and recovers is never punished.

### Things not to do (learned the hard way)

- Do not bound latency with `SO_SNDBUF` alone — it makes the blocking `send()`
  stall the *encoder*, since `broadcast()` writes inline on the producer thread.
- Do not rely on `broadcast()`'s `try_lock` skip as a drop mechanism as the code
  stands: the producer IS the writer, so nothing ever contends and it never
  fires.
- Do not predict a blocking send from `TIOCOUTQ` vs `SO_SNDBUF` — the kernel
  budgets by skb truesize, not payload bytes.
- Do not treat `MSG_DONTWAIT` + EAGAIN as the "client is behind" signal — a
  nearly-full buffer returns a *short count* instead, and finishing the torn
  remainder blocks.
- Do not measure staleness by "when did a byte last move" — a wedged client's
  small packets keep squeezing under the threshold and reset the clock.
- **Verify against the encoder's drop counters, not the client.** Every wrong
  version above looked fine from the client side. `full-low dropped=N` while
  siblings sit at 0 is the tell, and a *healthy* client must be part of every
  test — three of these bugs only appear when a normal reader is present.

## Progress log

- [x] Confirmed ingest, compositing and RTSP output are all ~1-2 s.
- [x] Confirmed HLS ~7-8 s, inherent to 2 s segments, not a regression.
- [x] Located the mechanism in `rtsp.cpp` and proved it with a slow reader.
- [x] Implemented the per-client lateness bound (three attempts, see above).
- [x] Re-ran the slow-reader experiment: Send-Q plateaus, resyncs log, encoder
      untouched — but this test used only a *slow* client, which is exactly why
      it passed while the build was broken for healthy ones.
- [x] **REVERTED** (`6517c4c`) after it froze the user's VLC overnight. Verified
      healthy: 0 encoder drops, ~2 s latency, 0 decode errors for a normal
      client.
- [ ] Decide whether to build the userspace-queue version above, or accept the
      original slow drift. **Open question for the user.**
- [ ] The original symptom is still unfixed: a long-lived RTSP session drifts
      late over many hours. It is real but mild — a restart of the viewer
      clears it.

## Still open, found along the way (not latency)

- `stream.tomsawyerlabs.com/all-field` proxies to `localhost:8890`, where
  nothing listens — the parked, unpushed fix from `3f2fefc`. Public stream page
  is broken, independently of this work.
- `raw/field-centered` reports a mixer underrun of 139,355,910 ms, longer than
  the process uptime. Counter bug, not real missing audio.
- `bun run check` has two pre-existing typecheck errors (`src/config.ts:332`,
  `src/dashboard.ts:1059`) unrelated to the compositor.
- `Session::pending` in `rtsp.cpp` is declared and never used.

## Things not to do

- Don't probe :8090 for restitch routes — that is a different app.
- Don't conclude anything about latency from `alive:` frame counts alone; the
  compositor can be perfectly on-time while a client falls arbitrarily behind.
- Don't touch Caddy / the 8890 route without per-change authorization.
