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

## Progress log

- [x] Confirmed ingest, compositing and RTSP output are all ~1-2 s.
- [x] Confirmed HLS ~7-8 s, inherent to 2 s segments, not a regression.
- [x] Located the mechanism in `rtsp.cpp` and proved it with a slow reader.
- [x] Implemented the per-client lateness bound (three attempts, see above).
- [x] Re-ran the slow-reader experiment: Send-Q plateaus, resyncs log, encoder
      untouched, healthy clients unaffected.
- [ ] **Confirm with the user's real VLC session.** A server-side bound cannot
      retract backlog VLC has already buffered internally, so if VLC still
      drifts, check `ss -tn 'sport = :8554'` for its peer while it is late:
      large Send-Q → still ours; ~0 → the backlog is inside VLC and the answer
      is a lighter stream or VLC's own caching settings.

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
