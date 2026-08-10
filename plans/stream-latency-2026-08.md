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

## Progress log

- [x] Confirmed ingest, compositing and RTSP output are all ~1-2 s.
- [x] Confirmed HLS ~7-8 s, inherent to 2 s segments, not a regression.
- [x] Located the mechanism in `rtsp.cpp` and proved it with a slow reader.
- [ ] Implement the per-client lateness bound.
- [ ] Re-run the slow-reader experiment; Send-Q must plateau and resyncs log.
- [ ] Confirm with the user's real VLC session.

## Things not to do

- Don't probe :8090 for restitch routes — that is a different app.
- Don't conclude anything about latency from `alive:` frame counts alone; the
  compositor can be perfectly on-time while a client falls arbitrarily behind.
- Don't touch Caddy / the 8890 route without per-change authorization.
